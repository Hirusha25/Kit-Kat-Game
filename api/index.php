<?php
// OTP verification over WhatsApp for the registration screen.
//
//   POST api/?a=send    {"mobile":"+9477XXXXXXX"}                -> {"ok":true,"expires":300}
//   POST api/?a=verify  {"mobile":"+9477XXXXXXX","code":"123456"} -> {"ok":true,"id":"..."}
//   Errors: {"ok":false,"error":"bad_number|rate|cap|send_failed|invalid|expired|too_many|not_configured|bad_request"}
//
// The code is sent as a WhatsApp authentication template through the Cloud API. Only a keyed hash of
// the code is stored. All secrets (database login, WhatsApp token, hash key) live in a config file
// OUTSIDE the web root, on the server only; nothing secret is in this repository.
// Table definition: see api/schema.sql.

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function out(int $status, array $body): never { http_response_code($status); echo json_encode($body); exit; }
function fail(int $status, string $error): never { out($status, ['ok' => false, 'error' => $error]); }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'bad_request');

// Same-origin only: a browser on another site cannot drive this endpoint.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== ($_SERVER['HTTP_HOST'] ?? '')) fail(403, 'bad_request');

$configFile = dirname(rtrim($_SERVER['DOCUMENT_ROOT'] ?? __DIR__ . '/..', '/')) . '/config/otp.php';
if (!is_file($configFile)) fail(503, 'not_configured');
$cfg = require $configFile;

$in = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($in)) fail(400, 'bad_request');

// Sri Lankan mobiles only (+94 7X XXX XXXX): keeps every message at the domestic rate.
$digits = preg_replace('/\D/', '', (string)($in['mobile'] ?? ''));
if (!preg_match('/^(?:94|0)?(7\d{8})$/', $digits, $m)) fail(422, 'bad_number');
$mobile = '94' . $m[1];

try {
    $db = new PDO($cfg['db_dsn'], $cfg['db_user'], $cfg['db_pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (Throwable $e) { error_log('otp db: ' . $e->getMessage()); fail(503, 'not_configured'); }

$hash = fn(string $code): string => hash_hmac('sha256', $mobile . ':' . $code, $cfg['hash_key']);
$count = function (string $where, array $args) use ($db): int {
    $q = $db->prepare("SELECT COUNT(*) FROM otp_codes WHERE $where"); $q->execute($args); return (int)$q->fetchColumn();
};
$ttl = (int)($cfg['ttl_seconds'] ?? 300);

switch ($_GET['a'] ?? '') {

case 'send':
    // Limits: one code per 30 s and 3 per 15 min for a number, a daily total per number, and a daily
    // total for the whole site so a runaway script cannot run up a bill.
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 30 SECOND', [$mobile]) > 0) fail(429, 'rate');
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 15 MINUTE', [$mobile]) >= 3) fail(429, 'rate');
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 1 DAY', [$mobile]) >= (int)($cfg['max_per_number_per_day'] ?? 6)) fail(429, 'rate');
    if ($count('created_at > NOW() - INTERVAL 1 DAY', []) >= (int)($cfg['max_per_day'] ?? 1000)) fail(429, 'cap');

    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['REMOTE_ADDR'] ?? '');
    $db->prepare('INSERT INTO otp_codes (mobile, code_hash, created_at, expires_at, ip) VALUES (?, ?, NOW(), NOW() + INTERVAL ? SECOND, ?)')
       ->execute([$mobile, $hash($code), $ttl, substr($ip, 0, 45)]);
    $id = (int)$db->lastInsertId();

    $payload = json_encode([
        'messaging_product' => 'whatsapp', 'to' => $mobile, 'type' => 'template',
        'template' => [
            'name' => $cfg['wa_template'], 'language' => ['code' => $cfg['wa_template_lang'] ?? 'en'],
            'components' => [
                ['type' => 'body', 'parameters' => [['type' => 'text', 'text' => $code]]],
                ['type' => 'button', 'sub_type' => 'url', 'index' => '0', 'parameters' => [['type' => 'text', 'text' => $code]]],
            ],
        ],
    ]);
    $ch = curl_init('https://graph.facebook.com/' . ($cfg['wa_api_version'] ?? 'v22.0') . '/' . $cfg['wa_phone_number_id'] . '/messages');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_POSTFIELDS => $payload, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 12,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $cfg['wa_token']],
    ]);
    $raw = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    $res = json_decode((string)$raw, true);
    $waId = $res['messages'][0]['id'] ?? null;
    if ($status !== 200 || !$waId) {
        // Not sent: remove the row so the failed attempt does not count against the player's limits.
        $db->prepare('DELETE FROM otp_codes WHERE id = ?')->execute([$id]);
        error_log('otp send failed: http ' . $status . ' ' . json_encode($res['error'] ?? null));
        fail(500, 'send_failed'); // not 502: Cloudflare replaces a 502 body with its own error page
    }
    $db->prepare('UPDATE otp_codes SET wa_message_id = ? WHERE id = ?')->execute([substr($waId, 0, 128), $id]);
    out(200, ['ok' => true, 'expires' => $ttl]);

case 'verify':
    $code = preg_replace('/\D/', '', (string)($in['code'] ?? ''));
    if (strlen($code) !== 6) fail(422, 'invalid');
    $q = $db->prepare('SELECT id, code_hash, attempts, expires_at < NOW() AS expired FROM otp_codes
                       WHERE mobile = ? AND verified_at IS NULL ORDER BY id DESC LIMIT 1');
    $q->execute([$mobile]); $row = $q->fetch();
    if (!$row || $row['expired']) fail(410, 'expired');
    if ((int)$row['attempts'] >= 5) fail(429, 'too_many');
    $db->prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?')->execute([$row['id']]);
    if (!hash_equals($row['code_hash'], $hash($code))) fail(401, 'invalid');
    $db->prepare('UPDATE otp_codes SET verified_at = NOW() WHERE id = ?')->execute([$row['id']]);
    out(200, ['ok' => true, 'id' => (string)$row['id']]);

default:
    fail(400, 'bad_request');
}
