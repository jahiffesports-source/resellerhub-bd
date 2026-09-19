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

out(['status' => 400, 'message' => 'unknown action — use "fraud", "create", "sf_save", "sf_delete", "sf_status", "sf_test" or "sf_create"']);
