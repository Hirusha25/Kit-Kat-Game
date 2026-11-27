<?php
// OTP verification for the registration screen: WhatsApp first, text message (SMS) as the fallback.
//
//   POST api/?a=send    {"mobile":"+9477XXXXXXX"}                             -> {"ok":true,"expires":300,"channel":"whatsapp|sms","ticket":"..."}
//   POST api/?a=status  {"mobile":"...","ticket":"..."}                       -> {"ok":true,"channel":"whatsapp|sms","wa":"accepted|sent|delivered|read|failed|unknown"}
//   POST api/?a=verify  {"mobile":"...","ticket":"...","code":"123456"}       -> {"ok":true,"id":"...","proof":"..."}
//   GET/POST api/?a=wa-hook&k=<secret>   WhatsApp delivery receipts from Meta (not for browsers)
//   Errors: {"ok":false,"error":"bad_number|rate|cap|send_failed|invalid|expired|too_many|not_configured|bad_request|server"}
//
// How the fallback works. The code goes out as a WhatsApp authentication template. Meta then reports
// back (wa-hook) whether it was delivered. The registration screen asks ?a=status every few seconds;
// the SAME code is sent again by SMS (text.lk) when WhatsApp reports a failure (for example the number
// has no WhatsApp) or has not confirmed delivery within `sms_fallback_after` seconds. A number that
// needed SMS is sent SMS straight away the next time. SMS is off until a sender ID is set in the config.
//
// The "ticket" is a random value given only to the browser that asked for the code. status and verify
// need it, so nobody else can look up a number's delivery state, use up its tries, or trigger its SMS.
// The "proof" returned by verify is signed by the server (mobile, code row, time); a server that records
// scores or prizes can check it with the same key to be sure the number was really verified.
//
// Only a keyed hash of the code is kept for checking; an encrypted copy lives for the code's 5 minutes
// so the same code can be re-sent by SMS. All secrets (database login, WhatsApp token, SMS token, keys)
// are in a config file OUTSIDE the web root, on the server only. Table definition: api/schema.sql.

declare(strict_types=1);
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function out(int $status, array $body): never { header('Content-Type: application/json; charset=utf-8'); http_response_code($status); echo json_encode($body); exit; }
function fail(int $status, string $error): never { out($status, ['ok' => false, 'error' => $error]); }
// Anything unexpected (a database hiccup, for example) still answers in JSON, and is logged.
set_exception_handler(function (Throwable $e): void { error_log('otp: ' . get_class($e) . ': ' . $e->getMessage() . ' @' . $e->getLine()); fail(500, 'server'); });

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
    // Receipts can arrive out of order. Order of trust: accepted < sent < delivered < read. "failed" replaces
    // anything short of delivered; after "failed", only a real delivered/read may replace it (a late "sent" may not).
    $rank = ['unknown' => 0, 'accepted' => 0, 'sent' => 1, 'failed' => 1, 'delivered' => 2, 'read' => 3];
    $body = json_decode(file_get_contents('php://input') ?: '', true);
    foreach (($body['entry'] ?? []) as $entry) foreach (($entry['changes'] ?? []) as $change) foreach (($change['value']['statuses'] ?? []) as $s) {
        $id = (string)($s['id'] ?? ''); $new = (string)($s['status'] ?? '');
        if ($id === '' || !isset($rank[$new]) || $new === 'unknown' || $new === 'accepted') continue;
        $q = db($cfg)->prepare('SELECT id, wa_status FROM otp_codes WHERE wa_message_id = ? LIMIT 1'); $q->execute([substr($id, 0, 128)]);
        if (!($row = $q->fetch())) continue;
        $cur = (string)($row['wa_status'] ?? '');
        $curRank = $rank[$cur] ?? -1;
        $apply = $new === 'failed' ? ($curRank < 2 && $cur !== 'failed') : ($cur === 'failed' ? $rank[$new] >= 2 : $rank[$new] > $curRank);
        if (!$apply) continue;
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
$ticketHash = fn(string $ticket): string => hash_hmac('sha256', 'ticket:' . $ticket, $cfg['hash_key']);
$count = function (string $where, array $args) use ($db): int {
    $q = $db->prepare("SELECT COUNT(*) FROM otp_codes WHERE $where"); $q->execute($args); return (int)$q->fetchColumn();
};
$ttl = (int)($cfg['ttl_seconds'] ?? 300);
$smsOn = ($cfg['sms_token'] ?? '') !== '' && ($cfg['sms_sender_id'] ?? '') !== '';
$encKey = hash('sha256', $cfg['hash_key'] . '|code-copy', true);
// The server sits behind Cloudflare with mod_remoteip, so REMOTE_ADDR is the visitor's own address and
// cannot be faked with a header.
$ip = substr((string)($_SERVER['REMOTE_ADDR'] ?? ''), 0, 45);

function seal(string $code, string $key): string {
    $iv = random_bytes(12); $ct = openssl_encrypt($code, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    return base64_encode($iv . $tag . $ct);
}
function unseal(?string $sealed, string $key): ?string {
    $raw = base64_decode((string)$sealed, true); if ($raw === false || strlen($raw) < 29) return null;
    $code = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16));
    return $code === false ? null : $code;
}

/**
 * One WhatsApp authentication template.
 * Returns ['id' => message id] when Meta took it, ['refused' => true] when Meta clearly said no,
 * or ['refused' => false] when we cannot tell (timeout, 5xx): the message may still arrive.
 */
function sendWhatsApp(array $cfg, string $mobile, string $code): array {
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
    if ($status === 200 && $id) return ['id' => substr($id, 0, 128)];
    error_log('otp whatsapp send failed: http ' . $status . ' ' . json_encode($res['error'] ?? null));
    return ['refused' => $status >= 400 && $status < 500];
}

/** One text message through text.lk. Returns [sent?, what text.lk answered, definitely not sent?]. */
function sendSms(array $cfg, string $mobile, string $code): array {
    $text = str_replace('{code}', $code, $cfg['sms_text'] ?? '{code} is your verification code for Dunk the Break by KitKat. It expires in 5 minutes. Do not share this code.');
    $ch = curl_init($cfg['sms_api_url'] ?? 'https://app.text.lk/api/v3/sms/send');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 12,
        CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . $cfg['sms_token'], 'Content-Type: application/json', 'Accept: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['recipient' => $mobile, 'sender_id' => $cfg['sms_sender_id'], 'type' => 'plain', 'message' => $text]),
    ]);
    $raw = curl_exec($ch); $err = curl_error($ch); curl_close($ch);
    if ($raw === false) return [false, 'curl: ' . $err, false];
    $data = json_decode((string)$raw, true);
    $ok = is_array($data) && ($data['status'] ?? '') === 'success';
    return [$ok, mb_strcut((string)$raw, 0, 250, 'UTF-8'), !$ok && is_array($data)];
}

/**
 * Sends the row's code by SMS, once. The UPDATE is the lock: two requests at the same moment cannot both
 * send. A claim left at "sending" for over 30 s (the request died mid-way) may be taken again.
 * Returns 'sent', 'failed' (text.lk said no), 'unsure' (no clear answer) or 'busy' (another request has it).
 */
function smsFallback(PDO $db, array $cfg, array $row, string $mobile, string $encKey): string {
    $claim = $db->prepare("UPDATE otp_codes SET sms_state = 'sending', sms_at = NOW()
                           WHERE id = ? AND (sms_state IS NULL OR (sms_state = 'sending' AND sms_at < NOW() - INTERVAL 30 SECOND))");
    $claim->execute([$row['id']]);
    if ($claim->rowCount() !== 1) return 'busy';
    $code = unseal($row['code_enc'] ?? null, $encKey);
    [$ok, $reply, $refused] = $code === null ? [false, 'no stored code', true] : sendSms($cfg, $mobile, $code);
    if (!$ok) error_log('otp sms failed: ' . $reply);
    $db->prepare('UPDATE otp_codes SET sms_state = ?, sms_reply = ? WHERE id = ?')->execute([$ok ? 'sent' : 'failed', $reply, $row['id']]);
    return $ok ? 'sent' : ($refused ? 'failed' : 'unsure');
}

/** The open (unverified, unexpired) code row that this browser's ticket belongs to, or stop with "expired". */
function openRow(PDO $db, string $mobile, string $ticketHash): array {
    $q = $db->prepare('SELECT id, code_hash, code_enc, attempts, wa_status, sms_state, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age
                       FROM otp_codes WHERE mobile = ? AND ticket_hash = ? AND verified_at IS NULL AND expires_at > NOW() LIMIT 1');
    $q->execute([$mobile, $ticketHash]);
    return $q->fetch() ?: fail(410, 'expired');
}

switch ($action) {

case 'send':
    // One request at a time per number, and a short site-wide lock around the counting, so several
    // requests fired together cannot all slip under the limits.
    $lock = $db->prepare('SELECT GET_LOCK(?, 8)'); $lock->execute(['kkotp:' . $mobile]);
    if ((int)$lock->fetchColumn() !== 1) fail(429, 'rate');
    $lockAll = $db->prepare('SELECT GET_LOCK(?, 8)'); $lockAll->execute(['kkotp:count']);
    if ((int)$lockAll->fetchColumn() !== 1) fail(429, 'rate');

    // Housekeeping: stored code copies go as soon as a code has expired; old rows go after 30 days.
    $db->exec("UPDATE otp_codes SET code_enc = NULL WHERE code_enc IS NOT NULL AND expires_at < NOW() LIMIT 200");
    $db->exec("DELETE FROM otp_codes WHERE created_at < NOW() - INTERVAL 30 DAY LIMIT 200");

    // Limits: one code per 30 s and 3 per 15 min for a number, a daily total per number, an hourly total
    // per network address (a kiosk shares one address, so this is generous; `ip_allowlist` lifts it), and
    // a daily total for the whole site so a runaway script cannot run up a bill.
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 30 SECOND', [$mobile]) > 0) fail(429, 'rate');
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 15 MINUTE', [$mobile]) >= 3) fail(429, 'rate');
    if ($count('mobile = ? AND created_at > NOW() - INTERVAL 1 DAY', [$mobile]) >= (int)($cfg['max_per_number_per_day'] ?? 6)) fail(429, 'rate');
    if ($ip !== '' && !in_array($ip, (array)($cfg['ip_allowlist'] ?? []), true)
        && $count('ip = ? AND created_at > NOW() - INTERVAL 1 HOUR', [$ip]) >= (int)($cfg['max_per_ip_per_hour'] ?? 60)) fail(429, 'rate');
    if ($count('created_at > NOW() - INTERVAL 1 DAY', []) >= (int)($cfg['max_per_day'] ?? 1000)) fail(429, 'cap');

    // A number whose last code only got through by SMS goes straight to SMS this time.
    $q = $db->prepare("SELECT sms_state, wa_status FROM otp_codes WHERE mobile = ? AND created_at > NOW() - INTERVAL 1 DAY ORDER BY id DESC LIMIT 1");
    $q->execute([$mobile]); $last = $q->fetch();
    $smsFirst = $smsOn && $last && $last['sms_state'] === 'sent' && !in_array($last['wa_status'], ['delivered', 'read'], true);

    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    $ticket = bin2hex(random_bytes(16));
    $sealed = seal($code, $encKey);
    $db->prepare('INSERT INTO otp_codes (mobile, code_hash, code_enc, ticket_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, NOW(), NOW() + INTERVAL ? SECOND, ?)')
       ->execute([$mobile, $hash($code), $sealed, $ticketHash($ticket), $ttl, $ip]);
    $id = (int)$db->lastInsertId();
    $row = ['id' => $id, 'code_enc' => $sealed];
    $db->prepare('SELECT RELEASE_LOCK(?)')->execute(['kkotp:count']); // the row now counts; the slow sending needs only the number's lock

    $reply = function (string $channel) use ($db, $mobile, $id, $ttl, $ticket): never {
        // Only the newest code for a number is valid. Earlier open ones end once the new one is on its way
        // (not before: if this send had failed, the player's earlier code must keep working).
        $db->prepare('UPDATE otp_codes SET expires_at = NOW(), code_enc = NULL WHERE mobile = ? AND id <> ? AND verified_at IS NULL AND expires_at > NOW()')->execute([$mobile, $id]);
        out(200, ['ok' => true, 'expires' => $ttl, 'channel' => $channel, 'ticket' => $ticket]);
    };
    $sms = null; $wa = null;
    if ($smsFirst) { $sms = smsFallback($db, $cfg, $row, $mobile, $encKey); if ($sms === 'sent') $reply('sms'); }
    // WhatsApp: the normal first step, and also the second try when an SMS-first send did not go out.
    $wa = sendWhatsApp($cfg, $mobile, $code);
    if (isset($wa['id'])) {
        $db->prepare("UPDATE otp_codes SET wa_message_id = ?, wa_status = 'accepted' WHERE id = ?")->execute([$wa['id'], $id]);
        $reply('whatsapp');
    }
    $db->prepare('UPDATE otp_codes SET wa_status = ? WHERE id = ?')->execute([$wa['refused'] ? 'failed' : 'unknown', $id]);
    if ($smsOn && $sms === null) { $sms = smsFallback($db, $cfg, $row, $mobile, $encKey); if ($sms === 'sent') $reply('sms'); }
    // Nothing clearly went out. If both services clearly refused, remove the row so the attempt does not count
    // against the player. If either gave no clear answer the message may still arrive, so the row (and its
    // code) stays and the page keeps waiting on it.
    if ($wa['refused'] && ($sms === null || $sms === 'failed')) { $db->prepare('DELETE FROM otp_codes WHERE id = ?')->execute([$id]); fail(500, 'send_failed'); }
    $reply($sms === 'unsure' ? 'sms' : 'whatsapp');

case 'status':
    $row = openRow($db, $mobile, $ticketHash((string)($in['ticket'] ?? '')));
    $delivered = in_array($row['wa_status'], ['delivered', 'read'], true);
    $sms = $row['sms_state'];
    $due = $row['wa_status'] === 'failed' || (!$delivered && (int)$row['age'] >= (int)($cfg['sms_fallback_after'] ?? 10));
    if ($smsOn && $due && ($sms === null || $sms === 'sending')) { $r = smsFallback($db, $cfg, $row, $mobile, $encKey); if ($r !== 'busy') $sms = $r === 'sent' ? 'sent' : 'failed'; }
    if ($row['wa_status'] === 'failed' && ($sms === 'failed' || !$smsOn)) fail(500, 'send_failed');
    out(200, ['ok' => true, 'channel' => $sms === 'sent' ? 'sms' : 'whatsapp', 'wa' => $row['wa_status']]);

case 'verify':
    $code = preg_replace('/\D/', '', (string)($in['code'] ?? ''));
    if (strlen($code) !== 6) fail(422, 'invalid');
    $row = openRow($db, $mobile, $ticketHash((string)($in['ticket'] ?? '')));
    // Count the try first, in one statement, so tries sent at the same moment cannot exceed five.
    $try = $db->prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ? AND attempts < 5 AND verified_at IS NULL');
    $try->execute([$row['id']]);
    if ($try->rowCount() !== 1) fail(429, 'too_many');
    if (!hash_equals($row['code_hash'], $hash($code))) fail(401, 'invalid');
    $done = $db->prepare('UPDATE otp_codes SET verified_at = NOW(), code_enc = NULL WHERE id = ? AND verified_at IS NULL');
    $done->execute([$row['id']]);
    // Any other open code for this number ends here, so an older one cannot be used or re-sent afterwards.
    $db->prepare('UPDATE otp_codes SET expires_at = NOW(), code_enc = NULL WHERE mobile = ? AND verified_at IS NULL AND expires_at > NOW()')->execute([$mobile]);
    $at = time(); $body = $mobile . '.' . $row['id'] . '.' . $at;
    out(200, ['ok' => true, 'id' => (string)$row['id'], 'proof' => $body . '.' . hash_hmac('sha256', 'proof:' . $body, $cfg['hash_key'])]);

default:
    fail(400, 'bad_request');
}
