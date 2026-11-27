<?php
// OTP verification for the registration screen: WhatsApp first, text message (SMS) as the fallback.
//
//   POST api/?a=send    {"mobile":"+9477XXXXXXX"}                -> {"ok":true,"expires":300,"channel":"whatsapp|sms"}
//   POST api/?a=status  {"mobile":"+9477XXXXXXX"}                -> {"ok":true,"channel":"whatsapp|sms","wa":"accepted|sent|delivered|read|failed"}
//   POST api/?a=verify  {"mobile":"+9477XXXXXXX","code":"123456"} -> {"ok":true,"id":"..."}
//   GET/POST api/?a=wa-hook&k=<secret>   WhatsApp delivery receipts from Meta (not for browsers)
//   Errors: {"ok":false,"error":"bad_number|rate|cap|send_failed|invalid|expired|too_many|not_configured|bad_request"}
//
// How the fallback works. The code goes out as a WhatsApp authentication template. Meta then reports
// back (wa-hook) whether it was delivered. The registration screen asks ?a=status every few seconds;
// the SAME code is sent again by SMS (text.lk) when WhatsApp reports a failure (for example the number
// has no WhatsApp) or has not confirmed delivery within `sms_fallback_after` seconds. A number that
// needed SMS is sent SMS straight away the next time. SMS is off until a sender ID is set in the config.
//
// Only a keyed hash of the code is kept for checking; an encrypted copy lives for the code's 5 minutes
// so the same code can be re-sent by SMS. All secrets (database login, WhatsApp token, SMS token, keys)
// are in a config file OUTSIDE the web root, on the server only. Table definition: api/schema.sql.

declare(strict_types=1);
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function out(int $status, array $body): never { header('Content-Type: application/json; charset=utf-8'); http_response_code($status); echo json_encode($body); exit; }
function fail(int $status, string $error): never { out($status, ['ok' => false, 'error' => $error]); }

$configFile = dirname(rtrim($_SERVER['DOCUMENT_ROOT'] ?? __DIR__ . '/..', '/')) . '/config/otp.php';
if (!is_file($configFile)) fail(503, 'not_configured');
$cfg = require $configFile;
$action = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? '';

function db(array $cfg): PDO {
    static $db = null;
    if ($db) return $db;
    try {
        return $db = new PDO($cfg['db_dsn'], $cfg['db_user'], $cfg['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    } catch (Throwable $e) { error_log('otp db: ' . $e->getMessage()); fail(503, 'not_configured'); }
}

// ---------- WhatsApp delivery receipts (called by Meta, not by the page) ----------
if ($action === 'wa-hook') {
    $key = (string)($cfg['wa_hook_key'] ?? '');
    if ($key === '' || !hash_equals($key, (string)($_GET['k'] ?? ''))) fail(403, 'bad_request');
    if ($method === 'GET') { // Meta's one-time address check
        if (($_GET['hub_mode'] ?? '') === 'subscribe' && hash_equals((string)($cfg['wa_hook_verify'] ?? ''), (string)($_GET['hub_verify_token'] ?? ''))) {
            header('Content-Type: text/plain'); echo (string)($_GET['hub_challenge'] ?? ''); exit;
        }
        fail(403, 'bad_request');
    }
    $rank = ['accepted' => 0, 'sent' => 1, 'delivered' => 2, 'read' => 3];
    $body = json_decode(file_get_contents('php://input') ?: '', true);
    foreach (($body['entry'] ?? []) as $entry) foreach (($entry['changes'] ?? []) as $change) foreach (($change['value']['statuses'] ?? []) as $s) {
        $id = (string)($s['id'] ?? ''); $new = (string)($s['status'] ?? '');
        if ($id === '' || ($new !== 'failed' && !isset($rank[$new]))) continue;
        $q = db($cfg)->prepare('SELECT id, wa_status FROM otp_codes WHERE wa_message_id = ? LIMIT 1'); $q->execute([substr($id, 0, 128)]);
        if (!($row = $q->fetch())) continue;
        $cur = $rank[$row['wa_status'] ?? ''] ?? -1;
        // Receipts can arrive out of order: never step back from delivered, and a late "failed" cannot undo one.
        if ($new === 'failed' ? $cur >= 2 : $rank[$new] <= $cur) continue;
        db($cfg)->prepare('UPDATE otp_codes SET wa_status = ?, wa_error = ? WHERE id = ?')
               ->execute([$new, $new === 'failed' ? (int)($s['errors'][0]['code'] ?? 0) : null, $row['id']]);
    }
    out(200, ['ok' => true]); // always 200, or Meta keeps re-sending
}

if ($method !== 'POST') fail(405, 'bad_request');

// Same-origin only: a browser on another site cannot drive this endpoint.
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== ($_SERVER['HTTP_HOST'] ?? '')) fail(403, 'bad_request');

$in = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($in)) fail(400, 'bad_request');

// Sri Lankan mobiles only (+94 7X XXX XXXX): keeps every message at the domestic rate.
$digits = preg_replace('/\D/', '', (string)($in['mobile'] ?? ''));
if (!preg_match('/^(?:94|0)?(7\d{8})$/', $digits, $m)) fail(422, 'bad_number');
$mobile = '94' . $m[1];

$db = db($cfg);
$hash = fn(string $code): string => hash_hmac('sha256', $mobile . ':' . $code, $cfg['hash_key']);
$count = function (string $where, array $args) use ($db): int {
    $q = $db->prepare("SELECT COUNT(*) FROM otp_codes WHERE $where"); $q->execute($args); return (int)$q->fetchColumn();
};
$ttl = (int)($cfg['ttl_seconds'] ?? 300);
$smsOn = ($cfg['sms_token'] ?? '') !== '' && ($cfg['sms_sender_id'] ?? '') !== '';
$encKey = hash('sha256', $cfg['hash_key'] . '|code-copy', true);

function seal(string $code, string $key): string {
    $iv = random_bytes(12); $ct = openssl_encrypt($code, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    return base64_encode($iv . $tag . $ct);
}
function unseal(?string $sealed, string $key): ?string {
    $raw = base64_decode((string)$sealed, true); if ($raw === false || strlen($raw) < 29) return null;
    $code = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
    return $code === false ? null : $code;
}

/** One WhatsApp authentication template. Returns the message id, or null when Meta refused it. */
function sendWhatsApp(array $cfg, string $mobile, string $code): ?string {
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
    $id = $res['messages'][0]['id'] ?? null;
    if ($status !== 200 || !$id) { error_log('otp whatsapp send failed: http ' . $status . ' ' . json_encode($res['error'] ?? null)); return null; }
    return substr($id, 0, 128);
}

/** One text message through text.lk. Returns [sent?, what text.lk answered]. */
function sendSms(array $cfg, string $mobile, string $code): array {
    $text = str_replace('{code}', $code, $cfg['sms_text'] ?? '{code} is your verification code for Dunk the Break by KitKat. It expires in 5 minutes. Do not share this code.');
    $ch = curl_init($cfg['sms_api_url'] ?? 'https://app.text.lk/api/v3/sms/send');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 12,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $cfg['sms_token'], 'Content-Type: application/json', 'Accept: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['recipient' => $mobile, 'sender_id' => $cfg['sms_sender_id'], 'type' => 'plain', 'message' => $text]),
    ]);
    $raw = curl_exec($ch); $err = curl_error($ch); curl_close($ch);
    if ($raw === false) return [false, 'curl: ' . $err];
    $data = json_decode((string)$raw, true);
    return [is_array($data) && ($data['status'] ?? '') === 'success', substr((string)$raw, 0, 250)];
}

/** Sends the row's code by SMS, once. The UPDATE is the lock: two requests at the same moment cannot both send. */
function smsFallback(PDO $db, array $cfg, array $row, string $mobile, string $encKey): string {
    $claim = $db->prepare("UPDATE otp_codes SET sms_state = 'sending', sms_at = NOW() WHERE id = ? AND sms_state IS NULL");
    $claim->execute([$row['id']]);
    if ($claim->rowCount() !== 1) return 'busy';
    $code = unseal($row['code_enc'] ?? null, $encKey);
    [$ok, $reply] = $code === null ? [false, 'no stored code'] : sendSms($cfg, $mobile, $code);
    if (!$ok) error_log('otp sms failed: ' . $reply);
    $db->prepare('UPDATE otp_codes SET sms_state = ?, sms_reply = ? WHERE id = ?')->execute([$ok ? 'sent' : 'failed', $reply, $row['id']]);
    return $ok ? 'sent' : 'failed';
}

switch ($action) {

case 'send':
    // Limits: one code per 30 s and 3 per 15 min for a number, a daily total per number, and a daily
    // total for the whole site so a runaway script cannot run up a bill.
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 30 SECOND', [$mobile]) > 0) fail(429, 'rate');
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 15 MINUTE', [$mobile]) >= 3) fail(429, 'rate');
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 1 DAY', [$mobile]) >= (int)($cfg['max_per_number_per_day'] ?? 6)) fail(429, 'rate');
    if ($count('created_at > NOW() - INTERVAL 1 DAY', []) >= (int)($cfg['max_per_day'] ?? 1000)) fail(429, 'cap');

    // A number whose last code only got through by SMS goes straight to SMS this time.
    $q = $db->prepare("SELECT sms_state, wa_status FROM otp_codes WHERE mobile = ? AND created_at > NOW() - INTERVAL 1 DAY ORDER BY id DESC LIMIT 1");
    $q->execute([$mobile]); $last = $q->fetch();
    $smsFirst = $smsOn && $last && $last['sms_state'] === 'sent' && !in_array($last['wa_status'], ['delivered', 'read'], true);

    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['REMOTE_ADDR'] ?? '');
    $db->prepare('INSERT INTO otp_codes (mobile, code_hash, code_enc, created_at, expires_at, ip) VALUES (?, ?, ?, NOW(), NOW() + INTERVAL ? SECOND, ?)')
       ->execute([$mobile, $hash($code), seal($code, $encKey), $ttl, substr($ip, 0, 45)]);
    $id = (int)$db->lastInsertId();
    $row = ['id' => $id, 'code_enc' => seal($code, $encKey)];

    $waId = $smsFirst ? null : sendWhatsApp($cfg, $mobile, $code);
    if ($waId) {
        $db->prepare("UPDATE otp_codes SET wa_message_id = ?, wa_status = 'accepted' WHERE id = ?")->execute([$waId, $id]);
        out(200, ['ok' => true, 'expires' => $ttl, 'channel' => 'whatsapp']);
    }
    if (!$smsFirst) $db->prepare("UPDATE otp_codes SET wa_status = 'failed' WHERE id = ?")->execute([$id]);
    if ($smsOn && smsFallback($db, $cfg, $row, $mobile, $encKey) === 'sent') out(200, ['ok' => true, 'expires' => $ttl, 'channel' => 'sms']);
    // Nothing went out: remove the row so the failed attempt does not count against the player's limits.
    $db->prepare('DELETE FROM otp_codes WHERE id = ?')->execute([$id]);
    fail(500, 'send_failed'); // not 502: Cloudflare replaces a 502 body with its own error page

case 'status':
    $q = $db->prepare('SELECT id, code_enc, wa_status, sms_state, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age, expires_at < NOW() AS expired
                       FROM otp_codes WHERE mobile = ? AND verified_at IS NULL ORDER BY id DESC LIMIT 1');
    $q->execute([$mobile]); $row = $q->fetch();
    if (!$row || $row['expired']) fail(410, 'expired');
    $delivered = in_array($row['wa_status'], ['delivered', 'read'], true);
    $sms = $row['sms_state'];
    $due = $row['wa_status'] === 'failed' || (!$delivered && (int)$row['age'] >= (int)($cfg['sms_fallback_after'] ?? 10));
    if ($smsOn && $sms === null && $due) $sms = smsFallback($db, $cfg, $row, $mobile, $encKey);
    if ($row['wa_status'] === 'failed' && ($sms === 'failed' || !$smsOn)) fail(500, 'send_failed');
    out(200, ['ok' => true, 'channel' => $sms === 'sent' ? 'sms' : 'whatsapp', 'wa' => $row['wa_status']]);

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
    $db->prepare('UPDATE otp_codes SET verified_at = NOW(), code_enc = NULL WHERE id = ?')->execute([$row['id']]);
    out(200, ['ok' => true, 'id' => (string)$row['id']]);

default:
    fail(400, 'bad_request');
}
