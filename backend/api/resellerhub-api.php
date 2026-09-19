<?php
/**
 * ResellerHub BD — Website Integration API
 * ═══════════════════════════════════════════════════════════════════════════
 * Lets a reseller connect their OWN site (WordPress / Shopify / hand-coded) to
 * ResellerHub BD:
 *
 *   GET  ?action=products&key=RESELLER_API_KEY
 *        → the product feed for THAT reseller (supplier + admin products)
 *
 *   POST ?action=order&key=RESELLER_API_KEY   (JSON body)
 *        → an order placed on their site, into their reseller panel
 *
 *   GET  ?action=ping&key=...                 → key check
 *
 * The key is per reseller. It is the ONLY thing that scopes the feed, so one
 * reseller can never pull another reseller's data.
 *
 * ── HOW THE DATA GETS HERE ────────────────────────────────────────────────
 * The panel itself is a browser app (localStorage), so a server cannot read it
 * directly. This endpoint therefore keeps its own small store next to itself:
 *
 *   .rh_keys.json      reseller id → api key        (written by the panel)
 *   .rh_products.json  the product catalogue        (written by the panel)
 *   .rh_orders.json    orders received from sites  (written by THIS file)
 *
 * The panel pushes keys + products up with:
 *   POST ?action=sync   { "key": "...", "products": [ ... ] }
 * (see the reseller panel → Website Integration page, which builds the payload
 * from the same `apiProductFeed()` the panel displays).
 *
 * ⚠️ Keep the .rh_*.json files OUTSIDE the web root if your host allows it,
 *    and give them 0600 permissions — they contain API keys.
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

$DIR       = __DIR__;
$KEYS_FILE = $DIR . '/.rh_keys.json';
$PROD_FILE = $DIR . '/.rh_products.json';
$ORD_FILE  = $DIR . '/.rh_orders.json';

function rh_read($file, $fallback) {
    if (!is_file($file)) return $fallback;
    $raw = @file_get_contents($file);
    if ($raw === false || $raw === '') return $fallback;
    $j = json_decode($raw, true);
    return is_array($j) ? $j : $fallback;
}
function rh_write($file, $data) {
    $ok = @file_put_contents($file, json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), LOCK_EX);
    @chmod($file, 0600);
    return $ok !== false;
}
function rh_out($arr, $code = 200) { http_response_code($code); echo json_encode($arr, JSON_UNESCAPED_UNICODE); exit; }
function rh_body() {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw ?: '', true);
    return is_array($j) ? $j : [];
}

$action = isset($_GET['action']) ? preg_replace('/[^a-z_]/', '', strtolower($_GET['action'])) : '';
$key    = isset($_GET['key']) ? trim($_GET['key']) : '';

/* ── sync: the panel pushes its keys + catalogue up ─────────────────────── */
if ($action === 'sync') {
    $body = rh_body();
    $rid  = isset($body['resellerId']) ? (string)$body['resellerId'] : '';
    $k    = isset($body['key']) ? trim((string)$body['key']) : '';
    if ($rid === '' || $k === '') rh_out(['ok' => false, 'error' => 'resellerId and key are required'], 400);

    $keys = rh_read($KEYS_FILE, []);
    $keys[$rid] = $k;
    if (!rh_write($KEYS_FILE, $keys)) rh_out(['ok' => false, 'error' => 'cannot write key store'], 500);

    if (isset($body['products']) && is_array($body['products'])) {
        $all = rh_read($PROD_FILE, []);
        $all[$rid] = $body['products'];
        if (!rh_write($PROD_FILE, $all)) rh_out(['ok' => false, 'error' => 'cannot write product store'], 500);
    }
    rh_out(['ok' => true, 'resellerId' => $rid, 'products' => isset($body['products']) ? count($body['products']) : null]);
}

/* ── every other action needs a valid key ───────────────────────────────── */
$keys  = rh_read($KEYS_FILE, []);
$owner = null;
foreach ($keys as $rid => $stored) { if (hash_equals((string)$stored, $key)) { $owner = (string)$rid; break; } }

if ($action === 'ping') {
    rh_out(['ok' => $owner !== null, 'resellerId' => $owner]);
}
if ($owner === null) rh_out(['ok' => false, 'error' => 'invalid or missing API key'], 401);

/* ── the product feed ────────────────────────────────────────────────────
   Out-of-stock, deactivated and deleted products are simply absent, because
   the panel builds this list from its own visibility query before syncing. */
if ($action === 'products') {
    $all = rh_read($PROD_FILE, []);
    $items = isset($all[$owner]) && is_array($all[$owner]) ? $all[$owner] : [];
    rh_out([
        'ok'       => true,
        'reseller' => $owner,
        'count'    => count($items),
        'updated'  => date('c'),
        'products' => $items
    ]);
}

/* ── an order from the reseller's own site ─────────────────────────────── */
if ($action === 'order') {
    $body  = rh_body();
    $items = isset($body['items']) && is_array($body['items']) ? $body['items'] : [];
    if (!count($items)) rh_out(['ok' => false, 'error' => 'items[] is required'], 400);

    $catalogue = rh_read($PROD_FILE, []);
    $mine      = isset($catalogue[$owner]) && is_array($catalogue[$owner]) ? $catalogue[$owner] : [];
    $byId = [];
    foreach ($mine as $p) { if (isset($p['id'])) $byId[(string)$p['id']] = $p; }

    $lines = []; $total = 0;
    foreach ($items as $it) {
        $pid = isset($it['productId']) ? (string)$it['productId'] : '';
        if ($pid === '' || !isset($byId[$pid])) {
            rh_out(['ok' => false, 'error' => 'product not available: ' . $pid], 409);
        }
        $qty  = max(1, (int)($it['qty'] ?? 1));
        $p    = $byId[$pid];
        $line = [
            'productId'  => $pid,
            'name'       => $p['name'] ?? '',
            'qty'        => $qty,
            'price'      => $p['price'] ?? 0,
            'image'      => $p['image'] ?? '',
            'supplierId' => $p['supplierId'] ?? null
        ];
        $total += ((float)($p['price'] ?? 0)) * $qty;
        $lines[] = $line;
    }

    $orders = rh_read($ORD_FILE, []);
    $order = [
        'id'              => 'WEB-' . date('ymd') . '-' . strtoupper(substr(bin2hex(random_bytes(3)), 0, 5)),
        'resellerId'      => $owner,
        'externalOrderId' => isset($body['externalOrderId']) ? (string)$body['externalOrderId'] : '',
        'customer'        => isset($body['customer']) ? (string)$body['customer'] : 'Website customer',
        'phone'           => isset($body['phone']) ? (string)$body['phone'] : '',
        'address'         => isset($body['address']) ? (string)$body['address'] : '',
        'shippingMethod'  => (isset($body['shippingMethod']) && $body['shippingMethod'] === 'outside') ? 'outside' : 'inside',
        'items'           => $lines,
        'amount'          => $total,
        'status'          => 'new',
        'source'          => 'website_integration',
        'channel'         => isset($body['channel']) ? (string)$body['channel'] : 'website',
        'receivedAt'      => date('c')
    ];
    $orders[] = $order;
    if (!rh_write($ORD_FILE, $orders)) rh_out(['ok' => false, 'error' => 'cannot store the order'], 500);

    rh_out(['ok' => true, 'orderId' => $order['id'], 'resellerId' => $owner], 201);
}

/* ── orders waiting to be pulled INTO the reseller panel ──────────────────
   Orders placed on the reseller's own site are stored here by the `order`
   action above. The panel calls this to pull them in; once it has ingested an
   order it calls `ack` so the same order is never imported twice. */
if ($action === 'orders') {
    $orders = rh_read($ORD_FILE, []);
    $mine = [];
    foreach ($orders as $o) {
        if (isset($o['resellerId']) && (string)$o['resellerId'] === $owner) $mine[] = $o;
    }
    rh_out(['ok' => true, 'count' => count($mine), 'orders' => $mine]);
}

/* ── the panel confirms it has ingested these order ids ─────────────────── */
if ($action === 'ack') {
    $body = rh_body();
    $ids  = isset($body['ids']) && is_array($body['ids']) ? $body['ids'] : [];
    $orders = rh_read($ORD_FILE, []);
    $kept = [];
    foreach ($orders as $o) {
        $isMine = isset($o['resellerId']) && (string)$o['resellerId'] === $owner;
        if ($isMine && in_array((string)($o['id'] ?? ''), array_map('strval', $ids), true)) continue;  /* ingested */
        $kept[] = $o;
    }
    if (!rh_write($ORD_FILE, $kept)) rh_out(['ok' => false, 'error' => 'cannot update the order store'], 500);
    rh_out(['ok' => true, 'removed' => count($orders) - count($kept)]);
}

rh_out(['ok' => false, 'error' => 'unknown action: ' . $action], 404);
