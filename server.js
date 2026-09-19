/* ==========================================================================
   ResellerHub BD — Node server
   --------------------------------------------------------------------------
   This file does THREE jobs and nothing else:

   1. Serves the static site.

   2. POST /api/steadfast — a drop-in replacement for backend/steadfast-proxy.php.
      The Steadfast API sends no CORS headers, so the browser cannot call it
      directly. This route makes the call server-side instead.

   3. /api/store — A SHARED DATA STORE.   ← added 2026-09-16
      -------------------------------------------------------------------
      WHY. The site keeps everything in localStorage. localStorage is per
      BROWSER, so a customer who registers on their phone writes to THEIR phone,
      and the admin on a laptop can never see it. Two devices could never share
      one dataset — which made the app impossible to test properly and impossible
      to run as a real multi-user site.

      This route gives every visitor ONE shared dataset held on the server:
        GET  /api/store             -> { ok, data: { key: value, ... } }
        GET  /api/store?key=rh_x    -> { ok, key, value }
        POST /api/store  { key, value }        -> save one key
        POST /api/store  { bulk: {k: v, ...} } -> save many at once
        POST /api/store?reset=1                -> wipe the store

      Values are stored as JSON files under .rhdata/. That directory lives beside
      this file, so it survives restarts and is not wiped between deploys unless
      the whole folder is replaced.

      Deliberately simple: last write wins, whole-key granularity. That matches
      how app.js already treats localStorage, so the existing data layer does not
      have to change shape.
   ========================================================================== */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 8099;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, '.rhdata');

/* ==========================================================================
   2026-09-19 — SECURITY + STORAGE BACKEND  (server.js only; no page is touched)

   SECURITY. The store used to be completely open: anyone who knew the URL could
   POST /api/store?reset=1 and wipe every key. Writes are still open by necessity
   (app.js runs in the browser and has no secret to present), so the destructive
   route is closed instead, and cross-site writes are rejected:

     RH_ALLOW_RESET=1        allow the reset route at all (default: OFF)
     RH_ADMIN_TOKEN=<secret> required secret for reset (header x-rh-token or ?token=)
     RH_STRICT_ORIGIN=0      turn off the same-origin check (default: ON)

   STORAGE. Default is unchanged: one JSON file per key under .rhdata/.
   Set MYSQL_HOST / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE to move the same
   data into MySQL. The wire contract (GET /api/store, POST /api/store {key,value})
   is identical either way, so app.js and every page stay exactly as they are.
   If mysql2 is not installed, or the connection fails, it silently falls back to
   JSON — the site never goes down because of the database.
   ========================================================================== */
const ADMIN_TOKEN = process.env.RH_ADMIN_TOKEN || '';
const ALLOW_RESET = process.env.RH_ALLOW_RESET === '1';
const STRICT_ORIGIN = process.env.RH_STRICT_ORIGIN !== '0';

const MYSQL_CFG = {
    host: process.env.MYSQL_HOST || '',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || '',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || ''
};
const WANT_MYSQL = !!(MYSQL_CFG.host && MYSQL_CFG.user && MYSQL_CFG.database);
let DB = null;            /* mysql2/promise pool when MySQL is active */
let DB_REV = 0;           /* bumped on every write, used for the cheap ETag */

const CREATE_URL = 'https://portal.steadfast.com.bd/api/v1/create_order';
const FRAUD_URL = 'https://check.steadfast.com.bd/api/v1/fraud_check';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf', '.mp4': 'video/mp4'
};

/* ------------------------------------------------------------------ helpers */

function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

/* 2026-09-17 — SPEED (server only; no website file is touched).
   GET /api/store returns EVERY key, and the uploaded product images live in there
   as base64 — on a store with 77 images that is a ~6MB body. app.js fetches the
   whole thing on every page load to warm its image cache, so before this the 6MB
   crossed the wire on every single navigation.
   Two additive changes:
     1. an ETag — a repeat load answers 304 with NO body, so 6MB becomes ~0 bytes
     2. gzip — when the body really is sent, it goes out ~28% smaller
   `Cache-Control: no-cache` means "you may keep it, but you MUST revalidate", so
   the data can never go stale: the server compares the ETag against the current
   files every time and sends a fresh body the moment anything changed. Two
   devices still see each other's writes immediately. */
function sendJsonCacheable(req, res, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const etag = '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 20) + '"';
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'ETag': etag,
        'Vary': 'Accept-Encoding',
        'Cache-Control': 'no-cache'
    };
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();
    }
    const z = compressBody(body, req.headers['accept-encoding']);
    if (z.enc) headers['Content-Encoding'] = z.enc;
    headers['Content-Length'] = z.body.length;
    res.writeHead(200, headers);
    res.end(z.body);
}

/* 2026-09-17 — BROTLI, and it is the single biggest win in this file.
   Base64 image data is full of long-range repeats that gzip's 32KB window cannot
   reach. Measured on the real 6.18MB store payload:
       gzip   lvl6 -> 4.47 MB in 200ms
       brotli q5   ->  567 KB in  61ms      <- 8x smaller AND 3x faster
   So we negotiate: br if the client accepts it, then gzip, then raw. Never send a
   compressed body that came out larger than the original. */
function compressBody(buf, acceptEncoding) {
    const ae = String(acceptEncoding || '');
    if (buf.length > 1024) {
        if (/\bbr\b/.test(ae)) {
            try {
                const br = zlib.brotliCompressSync(buf, { params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
                    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
                if (br && br.length < buf.length) return { body: br, enc: 'br' };
            } catch (e) { }
        }
        if (/\bgzip\b/.test(ae)) {
            try {
                const gz = zlib.gzipSync(buf, { level: 6 });
                if (gz && gz.length < buf.length) return { body: gz, enc: 'gzip' };
            } catch (e) { }
        }
    }
    return { body: buf, enc: '' };
}

function readBody(req, cb) {    let raw = '';
    let tooBig = false;
    req.on('data', (c) => {
        raw += c;
        /* base64 images travel through here — generous, but finite */
        if (raw.length > 24 * 1024 * 1024) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => {
        if (tooBig) return cb(new Error('payload too large'));
        try { cb(null, raw ? JSON.parse(raw) : {}); }
        catch (e) { cb(e); }
    });
    req.on('error', cb);
}

/* A key becomes a filename. Anything that could escape the data dir is rejected. */
function keyToFile(key) {
    const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
    if (!safe || safe === '.' || safe === '..') return null;
    return path.join(DATA_DIR, safe + '.json');
}

function ensureDir() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { }
}

/* 2026-09-17 — a CHEAP change signature for the whole store.
   The full payload is ~6MB (the spilled image bytes) and building it means reading
   and serialising every file. Hashing that 6MB to get an ETag cost more than the
   download it was meant to save. This instead hashes the directory listing —
   name + size + mtime per file — plus a counter bumped on every write, so it is
   exact but costs a few stat calls. A 304 can then be answered without reading a
   single byte of file content. */
let STORE_REV = 0;
async function storeSignature() {
    if (DB) return dbSignature();
    return jsonSignature();
}

function jsonSignature() {
    const parts = [String(STORE_REV)];
    try {
        const names = fs.readdirSync(DATA_DIR).sort();
        for (const n of names) {
            if (!n.endsWith('.json')) continue;
            try {
                const st = fs.statSync(path.join(DATA_DIR, n));
                parts.push(n + ':' + st.size + ':' + Math.round(st.mtimeMs));
            } catch (e) { }
        }
    } catch (e) { }
    return '"' + crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20) + '"';
}

async function dbSignature() {
    try {
        const [rows] = await DB.query(
            'SELECT COUNT(*) AS c, MAX(updated_at) AS m FROM rh_store');
        const r = rows && rows[0] ? rows[0] : {};
        const s = String(r.c || 0) + ':' + String(r.m || '') + ':' + String(DB_REV);
        return '"' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 20) + '"';
    } catch (e) {
        return '"rev' + DB_REV + '"';
    }
}

/* Send a store payload, but check the cheap signature BEFORE building anything. */
async function sendStoreJson(req, res, build) {
    const etag = await storeSignature();
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'ETag': etag,
        'Vary': 'Accept-Encoding',
        'Cache-Control': 'no-cache'
    };
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        return res.end();                 /* nothing read, nothing serialised */
    }
    const body = Buffer.from(JSON.stringify(await build()), 'utf8');
    const z = compressBody(body, req.headers['accept-encoding']);
    if (z.enc) headers['Content-Encoding'] = z.enc;
    headers['Content-Length'] = z.body.length;
    res.writeHead(200, headers);
    res.end(z.body);
}

/* ------------------------------------------------------------ /api/store impl */

/* 2026-09-17 — SPEED. The page boot used a SYNCHRONOUS XHR to this route, and this
   route returned EVERY key including the spilled image bytes. With ~50 product
   images that is several MB of base64 parsed before the page could paint, which is
   what made My Shop slow to load.
   `?noimg=1` returns everything EXCEPT the image keys, so the boot payload is a few
   KB. The images are fetched separately, asynchronously, by the page. */
async function storeGetAll(opts) {
    return DB ? dbGetAll(opts) : jsonGetAll(opts);
}

/* One key, without loading the whole store (the image bytes stay on disk). */
async function storeGetOne(key) {
    if (DB) {
        try {
            const [rows] = await DB.query('SELECT v FROM rh_store WHERE k = ?', [key]);
            if (rows && rows.length) return JSON.parse(rows[0].v);
            return null;
        } catch (e) { return null; }
    }
    const file = keyToFile(key);
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

async function storePut(key, value) {
    return DB ? dbPut(key, value) : jsonPut(key, value);
}

async function storeReset() {
    return DB ? dbReset() : jsonReset();
}

/* ------------------------------------------------------------- JSON backend */
function jsonGetAll(opts) {
    const skipImages = !!(opts && opts.noimg);
    ensureDir();
    const out = {};
    let names = [];
    try { names = fs.readdirSync(DATA_DIR); } catch (e) { return out; }
    for (const n of names) {
        if (!n.endsWith('.json')) continue;
        if (skipImages && n.indexOf('rh_img_') === 0) continue;
        try {
            out[n.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, n), 'utf8'));
        } catch (e) { /* a half-written file is skipped, never fatal */ }
    }
    return out;
}

function jsonPut(key, value) {
    const file = keyToFile(key);
    if (!file) return false;
    ensureDir();
    const tmp = file + '.tmp';
    /* write-then-rename, so a crash mid-write can never leave a truncated file */
    try {
        fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
        fs.renameSync(tmp, file);
        STORE_REV++;
        return true;
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { }
        return false;
    }
}

function jsonReset() {
    ensureDir();
    let names = [];
    try { names = fs.readdirSync(DATA_DIR); } catch (e) { return 0; }
    let n = 0;
    for (const f of names) {
        if (!f.endsWith('.json')) continue;
        try { fs.unlinkSync(path.join(DATA_DIR, f)); n++; } catch (e) { }
    }
    STORE_REV++;
    return n;
}

/* ------------------------------------------------------------ MySQL backend */
async function dbGetAll(opts) {
    const skipImages = !!(opts && opts.noimg);
    const out = {};
    try {
        const sql = skipImages
            ? 'SELECT k, v FROM rh_store WHERE k NOT LIKE ?'
            : 'SELECT k, v FROM rh_store';
        const args = skipImages ? ['rh\\_img\\_%'] : [];
        const [rows] = await DB.query(sql, args);
        for (const r of rows) {
            try { out[r.k] = JSON.parse(r.v); } catch (e) { }
        }
    } catch (e) { }
    return out;
}

async function dbPut(key, value) {
    if (!key || typeof key !== 'string') return false;
    try {
        await DB.query(
            'INSERT INTO rh_store (k, v) VALUES (?, ?) ' +
            'ON DUPLICATE KEY UPDATE v = VALUES(v)',
            [key, JSON.stringify(value === undefined ? null : value)]);
        DB_REV++;
        return true;
    } catch (e) {
        return false;
    }
}

async function dbReset() {
    try {
        const [res] = await DB.query('DELETE FROM rh_store');
        DB_REV++;
        return res && res.affectedRows ? res.affectedRows : 0;
    } catch (e) {
        return 0;
    }
}

/* Bring MySQL up if it is configured. Any failure leaves DB null, which means the
   JSON backend keeps serving — a database problem can never take the site down. */
async function initMysql() {
    if (!WANT_MYSQL) return;
    let mysql2;
    try { mysql2 = require('mysql2/promise'); }
    catch (e) {
        console.log('[store] mysql2 not installed - using JSON store');
        return;
    }
    try {
        DB = await mysql2.createPool({
            host: MYSQL_CFG.host,
            port: MYSQL_CFG.port,
            user: MYSQL_CFG.user,
            password: MYSQL_CFG.password,
            database: MYSQL_CFG.database,
            waitForConnections: true,
            connectionLimit: 10,
            charset: 'utf8mb4'
        });
        await DB.query('CREATE TABLE IF NOT EXISTS rh_store (' +
            'k VARCHAR(190) NOT NULL PRIMARY KEY, ' +
            'v LONGTEXT, ' +
            'updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' +
            ') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
        const [rows] = await DB.query('SELECT COUNT(*) AS c FROM rh_store');
        console.log('[store] MySQL active: ' + MYSQL_CFG.database + '@' + MYSQL_CFG.host +
            '  (' + (rows && rows[0] ? rows[0].c : 0) + ' keys)');
    } catch (e) {
        console.log('[store] MySQL failed (' + e.message + ') - using JSON store');
        DB = null;
    }
}

/* The secret may arrive as a header or as ?token=, so both curl and a browser work. */
function clientToken(req, query) {
    return String(req.headers['x-rh-token'] || '') || String(query.get('token') || '');
}

/* Reject a write that was triggered from somebody else's page. A request with no
   Origin/Referer at all (curl, server-side, some browsers on GET) is allowed. */
function sameOrigin(req) {
    const o = req.headers['origin'] || req.headers['referer'] || '';
    if (!o) return true;
    try { return new URL(o).host === req.headers['host']; } catch (e) { return false; }
}

async function handleStore(req, res, query) {
    if (req.method === 'GET') {
        if (query.get('key')) {
            const key = query.get('key');
            if (!keyToFile(key)) return sendJson(res, 400, { ok: false, message: 'bad key' });
            return sendJsonCacheable(req, res, { ok: true, key: key, value: await storeGetOne(key) });
        }
        /* ?noimg=1 — everything except the spilled image bytes (see storeGetAll).
           sendStoreJson answers a matching If-None-Match from the cheap directory
           signature, so a repeat page load never reads or serialises the ~6MB. */
        /* 2026-09-19 — BUG FIX. storeGetAll() became async when the optional MySQL
           backend was added, and this call site was never updated: `data` held a
           PENDING PROMISE, and JSON.stringify(Promise) is `{}`. The whole store
           therefore came back EMPTY — every page booted with no shared data at all
           (single-key reads were fine, which is why it went unnoticed).
           `build` must await it, and sendStoreJson already awaits `build`. */
        return sendStoreJson(req, res, async () => ({ ok: true, data: await storeGetAll({ noimg: query.get('noimg') === '1' }) }));
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'GET or POST only' });

    /* a form on someone else's site must not be able to write into our store */
    if (STRICT_ORIGIN && !sameOrigin(req)) {
        return sendJson(res, 403, { ok: false, message: 'cross-origin write rejected' });
    }

    /* 2026-09-19 — this used to wipe the entire store with no secret at all.
       It is now OFF unless the operator turns it on AND supplies the token. */
    if (query.get('reset')) {
        if (!ALLOW_RESET) {
            return sendJson(res, 403, { ok: false, message: 'reset is disabled (set RH_ALLOW_RESET=1 to enable)' });
        }
        if (!ADMIN_TOKEN || clientToken(req, query) !== ADMIN_TOKEN) {
            return sendJson(res, 401, { ok: false, message: 'admin token required' });
        }
        return sendJson(res, 200, { ok: true, removed: await storeReset() });
    }

    readBody(req, async (err, inb) => {
        if (err) return sendJson(res, 400, { ok: false, message: 'invalid JSON body' });

        /* bulk form: { bulk: { rh_a: ..., rh_b: ... } } */
        if (inb && inb.bulk && typeof inb.bulk === 'object') {
            let saved = 0;
            for (const k in inb.bulk) {
                if (!Object.prototype.hasOwnProperty.call(inb.bulk, k)) continue;
                if (await storePut(k, inb.bulk[k])) saved++;
            }
            return sendJson(res, 200, { ok: true, saved });
        }

        /* single form: { key, value } */
        if (inb && typeof inb.key === 'string' && inb.key) {
            const ok = await storePut(inb.key, inb.value);
            return sendJson(res, ok ? 200 : 500, { ok, key: inb.key });
        }

        sendJson(res, 400, { ok: false, message: 'send {key,value} or {bulk:{...}}' });
    });
}

/* ------------------------------------------------------------ /api/steadfast */

function forward(url, key, secret, body, cb) {
    let u;
    try { u = new URL(url); } catch (e) { return cb(new Error('bad upstream url')); }
    const data = JSON.stringify(body);
    const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'Api-Key': key,
            'Secret-Key': secret
        },
        timeout: 30000
    }, (r) => {
        let out = '';
        r.on('data', (c) => { out += c; });
        r.on('end', () => cb(null, r.statusCode || 200, out));
    });
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
    req.on('error', (e) => cb(e));
    req.write(data);
    req.end();
}

function handleSteadfast(req, res) {
    readBody(req, (err, inb) => {
        if (err) return sendJson(res, 400, { status: 400, message: 'invalid JSON body' });

        const action = inb && inb.action ? String(inb.action) : '';
        const key = String((inb && (inb.apiKey || inb.sf_api_key)) || process.env.STEADFAST_API_KEY || '');
        const secret = String((inb && (inb.secretKey || inb.sf_secret_key)) || process.env.STEADFAST_SECRET_KEY || '');

        if (!key || !secret) {
            return sendJson(res, 400, { status: 400, message: 'Steadfast API key and secret are required — save them on the Settings screen first.' });
        }

        if (action === 'fraud') {
            const phone = String((inb.phone || '')).replace(/\D/g, '');
            if (phone.length < 11) return sendJson(res, 400, { status: 400, message: 'valid phone required (01XXXXXXXXX)' });
            return forward(FRAUD_URL, key, secret, {
                api_key: key, secret_key: secret, customer_phone_number: phone
            }, (e, code, out) => {
                if (e) return sendJson(res, 502, { status: 502, message: 'upstream error: ' + e.message });
                res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(out || '{}');
            });
        }

        if (action === 'create') {
            const order = inb.order;
            if (!order || typeof order !== 'object') return sendJson(res, 400, { status: 400, message: 'order payload required' });
            return forward(CREATE_URL, key, secret, order, (e, code, out) => {
                if (e) return sendJson(res, 502, { status: 502, message: 'upstream error: ' + e.message });
                res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(out || '{}');
            });
        }

        sendJson(res, 400, { status: 400, message: 'unknown action: ' + action });
    });
}

/* -------------------------------------------------------------- static files */

/* 2026-09-17 — SPEED (server only; no website file is touched).
   The prototype ships a ~580KB app.js and the old handler streamed every asset
   raw with `Cache-Control: no-cache`, so each of the ~135 pages re-downloaded the
   whole file from scratch. Three additive changes:
     1. gzip text assets  — app.js ~580KB -> ~120KB on the wire
     2. a strong ETag + 304 — a repeat visit costs a few hundred bytes, not 580KB
     3. an in-process cache of the compressed bytes — we gzip once, not per hit
   Binary assets (png/jpg/woff/mp4) and anything over 4MB are streamed exactly as
   before, so images and video are unaffected. */
const COMPRESSIBLE = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;
const staticCache = new Map();          /* abs path -> { mtimeMs, size, raw, gz, etag } */

function staticEntry(target, st) {
    const hit = staticCache.get(target);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
    const raw = fs.readFileSync(target);
    const etag = '"' + st.size.toString(16) + '-' + Math.round(st.mtimeMs).toString(16) + '"';
    let gz = null, br = null;
    if (raw.length > 1024) {
        try { gz = zlib.gzipSync(raw, { level: 6 }); } catch (e) { gz = null; }
        /* static assets are compressed ONCE and cached, so pay for the best size */
        try {
            br = zlib.brotliCompressSync(raw, { params: {
                [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
                [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        } catch (e) { br = null; }
    }
    const ent = { mtimeMs: st.mtimeMs, size: st.size, raw, gz, br, etag };
    staticCache.set(target, ent);
    return ent;
}

function serveStatic(req, res) {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';

    const target = path.normalize(path.join(ROOT, rel));
    if (!target.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

    fs.stat(target, (err, st) => {
        if (err || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 not found');
        }
        const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';

        /* unchanged path: images, fonts, video, and anything huge */
        const streamRaw = () => {
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
            fs.createReadStream(target).pipe(res);
        };
        if (!COMPRESSIBLE.test(type) || st.size > 4 * 1024 * 1024) return streamRaw();

        let ent;
        try { ent = staticEntry(target, st); } catch (e) { return streamRaw(); }

        const headers = { 'Content-Type': type, 'ETag': ent.etag, 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-cache' };
        /* revalidate every time, but a 304 makes that nearly free — so "edit a
           file, refresh, see it" still works while repeat loads stay cheap. */
        if (req.headers['if-none-match'] === ent.etag) {
            res.writeHead(304, headers);
            return res.end();
        }
        const ae = String(req.headers['accept-encoding'] || '');
        const pick = (ent.br && /\bbr\b/.test(ae)) ? { b: ent.br, e: 'br' }
            : (ent.gz && /\bgzip\b/.test(ae)) ? { b: ent.gz, e: 'gzip' }
                : { b: ent.raw, e: '' };
        if (pick.e) headers['Content-Encoding'] = pick.e;
        headers['Content-Length'] = pick.b.length;
        res.writeHead(200, headers);
        res.end(pick.b);
    });
}

/* --------------------------------------------------------------------- router */

http.createServer((req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    const query = new URLSearchParams(url.split('?')[1] || '');

    if (pathname === '/api/store') {
        return handleStore(req, res, query).catch(function (e) {
            sendJson(res, 500, { ok: false, message: String(e && e.message || e) });
        });
    }
    if (pathname === '/api/steadfast') {
        if (req.method !== 'POST') return sendJson(res, 405, { status: 405, message: 'POST only' });
        return handleSteadfast(req, res);
    }
    serveStatic(req, res);
}).listen(PORT, '0.0.0.0', () => {
    ensureDir();
    initMysql().then(function () {
        console.log('ResellerHub BD serving on http://0.0.0.0:' + PORT +
            '  (shared store: ' + (DB ? 'MySQL ' + MYSQL_CFG.database : DATA_DIR) + ')');
    });
});
