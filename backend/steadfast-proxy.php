<?php
/**
 * ResellerHub BD — Steadfast / Street First Courier Proxy (Backend)
 * ────────────────────────────────────────────────────────────────
 * ব্যবহার: এই ফাইলটা যেকোনো PHP hosting-এ আপলোড করুন (যেমন yoursite.com/steadfast-proxy.php)
 * তারপর Admin Panel → Settings → Steadfast Courier → "Backend Proxy URL" ফিল্ডে
 * ওই URL বসিয়ে সেভ করুন (যেমন: https://yoursite.com/steadfast-proxy.php)
 *
 * সুবিধা: API Key/Secret ব্রাউজারে দেখা যাবে না (server-side লুকানো), CORS সমস্যা নেই।
 *
 * ── Actions ────────────────────────────────────────────────────────────────
 *  fraud      (legacy, admin key)  — customer fraud check
 *  create     (legacy, admin key)  — admin / supplier booking
 *  sf_save    — একজন reseller-এর নিজের Street First key/secret সার্ভারে সংরক্ষণ
 *  sf_delete  — reseller-এর সংরক্ষিত credentials মুছে ফেলা
 *  sf_status  — connected কি না + masked key (কখনো secret ফেরত দেয় না)
 *  sf_test    — reseller-এর key দিয়ে connection test
 *  sf_create  — reseller-এর নিজের account দিয়ে parcel booking
 *
 * ⚠️ Reseller credentials একটি আলাদা ফাইলে (`.steadfast_accounts.json`) রাখা হয়,
 *    যেটা 0600 permission-এ সেভ করা হয় এবং কখনো browser-এ পাঠানো হয় না।
 */

// ⚙️ আপনার Steadfast credentials (server-side — ব্রাউজারে যাবে না)
//    Production-এ environment variable ব্যবহার করাই উত্তম; না থাকলে নিচের মান ব্যবহৃত হবে।
$API_KEY = getenv('STEADFAST_API_KEY') ?: '2mpuec4q7rtapcrhhuxyqrsbvfqlzi8u';
$SECRET  = getenv('STEADFAST_SECRET_KEY') ?: 'kdshxbfiy4g30lezipdrp399';

// ঐচ্ছিক: চাইলে একটি shared token সেট করুন; সেট থাকলে সব request-এ `token` পাঠাতে হবে।
$PROXY_TOKEN = getenv('STEADFAST_PROXY_TOKEN') ?: '';

/* Per-reseller credential store. Web-root থেকে সরিয়ে রাখতে পারলে আরও ভালো,
   যেমন: __DIR__ . '/../private/steadfast_accounts.json' */
$ACCOUNT_FILE = __DIR__ . '/.steadfast_accounts.json';

$FRAUD_URL  = 'https://check.steadfast.com.bd/api/v1/fraud';
$CREATE_URL = 'https://portal.steadfast.com.bd/api/v1/create_order';

// CORS — যেকোনো সাইট থেকে কল করা যাবে
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function out($j) { echo json_encode($j); exit; }

$in = json_decode(file_get_contents('php://input'), true);
if (!is_array($in)) out(['status' => 400, 'message' => 'invalid JSON body']);

if ($PROXY_TOKEN !== '' && (!isset($in['token']) || !hash_equals($PROXY_TOKEN, (string)$in['token']))) {
    out(['status' => 401, 'message' => 'invalid proxy token']);
}

$action = isset($in['action']) ? $in['action'] : '';

/* ────────────────────────────────────────────────────────────────
   Per-reseller account helpers — secrets never leave the server.
   ──────────────────────────────────────────────────────────────── */
function sf_key($rid) { return preg_replace('/[^0-9A-Za-z_\-]/', '', (string)$rid); }
function sf_load() {
    global $ACCOUNT_FILE;
    if (!file_exists($ACCOUNT_FILE)) return [];
    $raw = @file_get_contents($ACCOUNT_FILE);
    $j = json_decode($raw ?: '[]', true);
    return is_array($j) ? $j : [];
}
function sf_store($all) {
    global $ACCOUNT_FILE;
    @file_put_contents($ACCOUNT_FILE, json_encode($all), LOCK_EX);
    @chmod($ACCOUNT_FILE, 0600);
    return true;
}
function sf_get($rid) { $k = sf_key($rid); $a = sf_load(); return isset($a[$k]) ? $a[$k] : null; }
function sf_mask($s) {
    $s = (string)$s;
    if (strlen($s) <= 6) return $s ? '••••' : '';
    return substr($s, 0, 3) . '••••••••' . substr($s, -3);
}
/* One HTTP call to Steadfast with an explicit key pair. */
function sf_post($url, $key, $secret, $body) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Api-Key: ' . $key, 'Secret-Key: ' . $secret],
        CURLOPT_POSTFIELDS     => json_encode($body),
    ]);
    $res  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$res, $err, $code];
}

/* ── Save / delete / status for a reseller's own account ────────── */
if ($action === 'sf_save') {
    $rid = sf_key(isset($in['resellerId']) ? $in['resellerId'] : '');
    $k   = trim(isset($in['apiKey']) ? $in['apiKey'] : '');
    $s   = trim(isset($in['secret']) ? $in['secret'] : '');
    if ($rid === '') out(['status' => 400, 'message' => 'resellerId required']);
    if ($k === '' || $s === '') out(['status' => 400, 'message' => 'API Key and Secret Key are required']);

    $all = sf_load();
    $prev = isset($all[$rid]) ? $all[$rid] : [];
    $all[$rid] = [
        'api_key'  => $k,
        'secret'   => $s,
        'savedAt'  => date('c'),
        'testedAt' => isset($prev['testedAt']) ? $prev['testedAt'] : '',
    ];
    sf_store($all);
    /* masked key only — the secret is never echoed back */
    out(['status' => 200, 'connected' => true, 'masked' => sf_mask($k), 'savedAt' => $all[$rid]['savedAt']]);
}

if ($action === 'sf_delete') {
    $rid = sf_key(isset($in['resellerId']) ? $in['resellerId'] : '');
    if ($rid === '') out(['status' => 400, 'message' => 'resellerId required']);
    $all = sf_load();
    unset($all[$rid]);
    sf_store($all);
    out(['status' => 200, 'connected' => false]);
}

if ($action === 'sf_status') {
    $rid = sf_key(isset($in['resellerId']) ? $in['resellerId'] : '');
    $a = sf_get($rid);
    if (!$a || empty($a['api_key']) || empty($a['secret'])) {
        out(['status' => 200, 'connected' => false, 'masked' => '']);
    }
    out(['status' => 200, 'connected' => true, 'masked' => sf_mask($a['api_key']), 'savedAt' => isset($a['savedAt']) ? $a['savedAt'] : '', 'testedAt' => isset($a['testedAt']) ? $a['testedAt'] : '']);
}

/* ── Test a reseller's connection with THEIR keys ───────────────── */
if ($action === 'sf_test') {
    $rid = sf_key(isset($in['resellerId']) ? $in['resellerId'] : '');
    $a = sf_get($rid);
    if (!$a) out(['status' => 404, 'message' => 'No Street First account saved for this reseller']);
    /* credentials may also be supplied inline right after saving */
    $k = !empty($a['api_key']) ? $a['api_key'] : (isset($in['apiKey']) ? trim($in['apiKey']) : '');
    $s = !empty($a['secret'])  ? $a['secret']  : (isset($in['secret']) ? trim($in['secret']) : '');
    if ($k === '' || $s === '') out(['status' => 400, 'message' => 'API Key and Secret Key are required']);

    list($res, $err, $code) = sf_post($FRAUD_URL, $k, $s, [
        'api_key'               => $k,
        'secret_key'            => $s,
        'customer_phone_number' => '01700000000',
    ]);
    if ($res === false) out(['status' => 502, 'message' => 'curl error: ' . $err]);

    $all = sf_load();
    if (isset($all[$rid])) { $all[$rid]['testedAt'] = date('c'); sf_store($all); }

    http_response_code($code ?: 200);
    echo $res;
    exit;
}

/* ── Create a parcel using a reseller's OWN account ─────────────── */
if ($action === 'sf_create') {
    $rid = sf_key(isset($in['resellerId']) ? $in['resellerId'] : '');
    $order = isset($in['order']) ? $in['order'] : null;
    if (!is_array($order)) out(['status' => 400, 'message' => 'order payload required']);
    $a = sf_get($rid);
    if (!$a) out(['status' => 404, 'message' => 'No Street First account saved for this reseller']);
    $k = !empty($a['api_key']) ? $a['api_key'] : (isset($in['apiKey']) ? trim($in['apiKey']) : '');
    $s = !empty($a['secret'])  ? $a['secret']  : (isset($in['secret']) ? trim($in['secret']) : '');
    if ($k === '' || $s === '') out(['status' => 400, 'message' => 'API Key and Secret Key are required']);

    list($res, $err, $code) = sf_post($CREATE_URL, $k, $s, $order);
    if ($res === false) out(['status' => 502, 'message' => 'curl error: ' . $err]);
    http_response_code($code ?: 200);
    echo $res;
    exit;
}

// ── Fraud check (legacy — admin account) ──
if ($action === 'fraud') {
    $phone = isset($in['phone']) ? preg_replace('/\D/', '', $in['phone']) : '';
    if (strlen($phone) < 11) out(['status' => 400, 'message' => 'valid phone required (01XXXXXXXXX)']);

    $ch = curl_init($FRAUD_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 25,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Api-Key: ' . $API_KEY, 'Secret-Key: ' . $SECRET],
        CURLOPT_POSTFIELDS     => json_encode([
            'api_key'               => $API_KEY,
            'secret_key'            => $SECRET,
            'customer_phone_number' => $phone,
        ]),
    ]);
    $res = curl_exec($ch);
    if ($res === false) out(['status' => 502, 'message' => 'curl error: ' . curl_error($ch)]);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    http_response_code($code ?: 200);
    echo $res;
    exit;
}

// ── Create parcel (single booking — legacy admin account) ──
if ($action === 'create') {
    $order = isset($in['order']) ? $in['order'] : null;
    if (!is_array($order)) out(['status' => 400, 'message' => 'order payload required']);

    $ch = curl_init($CREATE_URL);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Api-Key: ' . $API_KEY, 'Secret-Key: ' . $SECRET],
        CURLOPT_POSTFIELDS     => json_encode($order),
    ]);
    $res = curl_exec($ch);
    if ($res === false) out(['status' => 502, 'message' => 'curl error: ' . curl_error($ch)]);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    http_response_code($code ?: 200);
    echo $res;
    exit;
}

/* ────────────────────────────────────────────────────────────────
   2026-09-19 — FRAUD CHECK FOR THE OTHER COURIERS (this request)

   Steadfast has an OFFICIAL fraud endpoint and the `fraud` action above is
   untouched. Paperfly / RedX / Pathao / Carrybee have NO public fraud API:
   each one is a merchant-portal LOGIN followed by a query, so every courier
   needs its OWN merchant credentials stored on the server.

   Endpoint shapes follow the MIT-licensed `fraud-checker-bd-courier`
   package (Steadfast, Pathao, Paperfly, Carrybee, RedX):
     · Paperfly  POST /authentication/login_using_password.php -> token
                 POST /smart-check/list.php                    -> records
     · RedX      POST /v4/auth/login  (88-prefixed phone)      -> token
                 GET  /v4/customer-success-return-rate?phoneNumber=88…
     · Pathao    POST /api/v1/login -> bearer, POST /api/v1/user/success
     · Carrybee  NextAuth merchant portal (csrf -> login -> session token)

   Because those hosts and paths belong to the couriers and can change without
   notice, every base URL is OVERRIDABLE:
       PAPERFLY_BASE, REDX_BASE, PATHAO_BASE, CARRYBEE_BASE
   and every credential comes from the environment:
       PAPERFLY_USER/PAPERFLY_PASSWORD, REDX_PHONE/REDX_PASSWORD,
       PATHAO_USER/PATHAO_PASSWORD, CARRYBEE_PHONE/CARRYBEE_PASSWORD

   A courier with no credentials answers {"notConfigured":true} — it never
   invents a result. The UI treats a zero total as "no data", never as SAFE.

   ⚠️ UNVERIFIED: no merchant credentials were available while writing this, so
   none of these four calls has been run against the live services. The login
   and query flow is implemented from the documented shapes above; the exact
   response field names are read defensively (several aliases each) and the
   normalised {success,cancel,total,success_ratio} shape is what the UI reads.
   Configure ONE courier and probe it before relying on it.
   ──────────────────────────────────────────────────────────────── */
function fx_env($n) { $v = getenv($n); return $v === false ? '' : trim($v); }
function fx_phone($raw) {
    $d = preg_replace('/\D/', '', (string)$raw);
    if (strlen($d) === 13 && substr($d, 0, 3) === '880') $d = '0' . substr($d, 3);
    return $d;
}
function fx_not_configured($name, $vars) {
    out(['notConfigured' => true, 'courier' => $name,
         'message' => $name . ' merchant credentials are not set on the server (' . implode(' / ', $vars) . ').']);
}
function fx_call($url, $method, $body, $headers) {
    $ch = curl_init($url);
    $opt = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 25,
        CURLOPT_HTTPHEADER     => $headers,
    ];
    if ($method === 'POST') { $opt[CURLOPT_POST] = true; $opt[CURLOPT_POSTFIELDS] = $body; }
    curl_setopt_array($ch, $opt);
    $res  = curl_exec($ch);
    $err  = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$res, $code, $err];
}
function fx_norm($success, $cancel, $total) {
    $success = (int)$success; $cancel = (int)$cancel;
    $total = max((int)$total, $success + $cancel);
    return ['success' => $success, 'cancel' => $cancel, 'total' => $total,
            'success_ratio' => $total ? round($success * 100 / $total, 2) : 0];
}
function fx_pick($arr, $keys, $default = 0) {
    if (!is_array($arr)) return $default;
    foreach ($keys as $k) { if (isset($arr[$k]) && is_numeric($arr[$k])) return $arr[$k]; }
    return $default;
}
/* The UI sends `action: fraud_<courier>`; `fraud` (legacy Steadfast) still works. */
$fraud_courier = '';
if (strpos($action, 'fraud_') === 0) $fraud_courier = substr($action, 6);

if ($fraud_courier !== '') {
    $phone = fx_phone(isset($in['phone']) ? $in['phone'] : '');
    if (strlen($phone) < 11) out(['status' => 400, 'message' => 'valid phone required (01XXXXXXXXX)']);

    /* ── RedX ───────────────────────────────────────────────────────── */
    if ($fraud_courier === 'redx') {
        $u = fx_env('REDX_PHONE'); $p = fx_env('REDX_PASSWORD');
        if ($u === '' || $p === '') fx_not_configured('RedX', ['REDX_PHONE', 'REDX_PASSWORD']);
        $base = fx_env('REDX_BASE') ?: 'https://api.redx.com.bd';
        $msisdn = '88' . ltrim($phone, '0');
        list($res, $code, $err) = fx_call($base . '/v4/auth/login', 'POST',
            json_encode(['phone' => $msisdn, 'password' => $p]),
            ['Content-Type: application/json']);
        if ($res === false) out(['status' => 502, 'message' => 'RedX login curl error: ' . $err]);
        $j = json_decode($res, true);
        $tok = '';
        if (is_array($j)) {
            if (isset($j['data']) && is_array($j['data'])) $tok = fx_pick($j['data'], ['accessToken', 'token'], '');
            if ($tok === '') $tok = fx_pick($j, ['accessToken', 'token'], '');
        }
        if ($tok === '') out(['status' => 502, 'courier' => 'redx', 'message' => 'RedX login failed (HTTP ' . $code . ')', 'raw' => substr((string)$res, 0, 300)]);
        list($res2, $code2, $err2) = fx_call($base . '/v4/customer-success-return-rate?phoneNumber=' . $msisdn, 'GET', null,
            ['Authorization: Bearer ' . $tok, 'Content-Type: application/json']);
        if ($res2 === false) out(['status' => 502, 'message' => 'RedX query curl error: ' . $err2]);
        $d = json_decode($res2, true);
        $r = (is_array($d) && isset($d['data']) && is_array($d['data'])) ? $d['data'] : $d;
        out(array_merge(['status' => 200, 'courier' => 'redx'],
            fx_norm(fx_pick($r, ['success', 'totalSuccess', 'delivered']),
                    fx_pick($r, ['cancel', 'totalReturn', 'returned']),
                    fx_pick($r, ['total', 'totalParcel', 'totalOrder']))));
    }

    /* ── Paperfly ───────────────────────────────────────────────────── */
    if ($fraud_courier === 'paperfly') {
        $u = fx_env('PAPERFLY_USER'); $p = fx_env('PAPERFLY_PASSWORD');
        if ($u === '' || $p === '') fx_not_configured('Paperfly', ['PAPERFLY_USER', 'PAPERFLY_PASSWORD']);
        $base = fx_env('PAPERFLY_BASE') ?: 'https://api.paperfly.com.bd';
        list($res, $code, $err) = fx_call($base . '/authentication/login_using_password.php', 'POST',
            json_encode(['username' => $u, 'password' => $p]), ['Content-Type: application/json']);
        if ($res === false) out(['status' => 502, 'message' => 'Paperfly login curl error: ' . $err]);
        $j = json_decode($res, true);
        $tok = '';
        if (is_array($j)) {
            if (isset($j['data']) && is_array($j['data'])) $tok = fx_pick($j['data'], ['token', 'accessToken'], '');
            if ($tok === '') $tok = fx_pick($j, ['token', 'accessToken'], '');
        }
        if ($tok === '') out(['status' => 502, 'courier' => 'paperfly', 'message' => 'Paperfly login failed (HTTP ' . $code . ')', 'raw' => substr((string)$res, 0, 300)]);
        list($res2, $code2, $err2) = fx_call($base . '/smart-check/list.php', 'POST',
            json_encode(['search' => $phone, 'phone' => $phone]),
            ['Authorization: Bearer ' . $tok, 'Content-Type: application/json']);
        if ($res2 === false) out(['status' => 502, 'message' => 'Paperfly query curl error: ' . $err2]);
        $d = json_decode($res2, true);
        /* Paperfly returns a record LIST; a record is a success when its status
           reads as delivered and a cancel when it reads as return/cancel/fail. */
        $rows = [];
        if (is_array($d)) {
            if (isset($d['data']) && is_array($d['data']) && isset($d['data']['records'])) $rows = $d['data']['records'];
            elseif (isset($d['records'])) $rows = $d['records'];
            elseif (isset($d['data']) && is_array($d['data'])) $rows = $d['data'];
        }
        $s = 0; $c = 0;
        foreach ((array)$rows as $row) {
            $st = strtolower((string)(is_array($row) ? (isset($row['status']) ? $row['status'] : '') : ''));
            if ($st === '') continue;
            if (strpos($st, 'deliver') !== false || strpos($st, 'success') !== false) $s++;
            elseif (strpos($st, 'return') !== false || strpos($st, 'cancel') !== false || strpos($st, 'fail') !== false) $c++;
        }
        $tot = (is_array($d) && isset($d['totalRecords'])) ? (int)$d['totalRecords'] : count((array)$rows);
        out(array_merge(['status' => 200, 'courier' => 'paperfly'], fx_norm($s, $c, $tot)));
    }

    /* ── Pathao ─────────────────────────────────────────────────────── */
    if ($fraud_courier === 'pathao') {
        $u = fx_env('PATHAO_USER'); $p = fx_env('PATHAO_PASSWORD');
        if ($u === '' || $p === '') fx_not_configured('Pathao', ['PATHAO_USER', 'PATHAO_PASSWORD']);
        $base = fx_env('PATHAO_BASE') ?: 'https://api-hermes.pathao.com';
        list($res, $code, $err) = fx_call($base . '/aladdin/api/v1/issue-token', 'POST',
            json_encode(['client_id' => fx_env('PATHAO_CLIENT_ID'), 'client_secret' => fx_env('PATHAO_CLIENT_SECRET'),
                         'username' => $u, 'password' => $p, 'grant_type' => 'password']),
            ['Content-Type: application/json']);
        if ($res === false) out(['status' => 502, 'message' => 'Pathao login curl error: ' . $err]);
        $j = json_decode($res, true);
        $tok = is_array($j) ? fx_pick($j, ['access_token'], '') : '';
        if ($tok === '') out(['status' => 502, 'courier' => 'pathao', 'message' => 'Pathao login failed (HTTP ' . $code . ')', 'raw' => substr((string)$res, 0, 300)]);
        list($res2, $code2, $err2) = fx_call($base . '/aladdin/api/v1/user/success', 'POST',
            json_encode(['phone' => $phone]),
            ['Authorization: Bearer ' . $tok, 'Content-Type: application/json']);
        if ($res2 === false) out(['status' => 502, 'message' => 'Pathao query curl error: ' . $err2]);
        $d = json_decode($res2, true);
        $r = (is_array($d) && isset($d['data']) && is_array($d['data'])) ? $d['data'] : $d;
        $s = fx_pick($r, ['success', 'delivered', 'total_success']);
        $t = fx_pick($r, ['total', 'total_delivery']);
        out(array_merge(['status' => 200, 'courier' => 'pathao'], fx_norm($s, max(0, (int)$t - (int)$s), $t)));
    }

    /* ── Carrybee ───────────────────────────────────────────────────── */
    if ($fraud_courier === 'carrybee') {
        $u = fx_env('CARRYBEE_PHONE'); $p = fx_env('CARRYBEE_PASSWORD');
        if ($u === '' || $p === '') fx_not_configured('Carrybee', ['CARRYBEE_PHONE', 'CARRYBEE_PASSWORD']);
        out(['notConfigured' => true, 'courier' => 'carrybee',
             'message' => 'Carrybee uses a NextAuth merchant portal (csrf → login → session token). Implement and probe it after the other couriers work — the flow needs a cookie jar this proxy does not keep yet.']);
    }

    out(['status' => 400, 'message' => 'unknown fraud courier: ' . $fraud_courier]);
}

out(['status' => 400, 'message' => 'unknown action — use "fraud", "create", "sf_save", "sf_delete", "sf_status", "sf_test", "sf_create" or "fraud_<steadfast|paperfly|redx|pathao|carrybee>"']);
