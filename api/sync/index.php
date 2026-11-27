<?php
// Kiosk data sync: registrations, scores and prize codes saved on the kiosk are sent here when it is online.
//
//   POST ?a=push   header X-KK-Key   {"players":[...],"scores":[...],"prizes":[...]}
//        -> {"ok":true,"saved":{"players":[ids],"scores":[ids],"prizes":[ids]}}
//        Each item carries a client "id". Sending the same item again is harmless (stored once per kiosk).
//   GET  ?a=export&what=players|scores|prizes   (reviewer login from /debug/)  -> CSV download
//   GET  ?a=summary                             (reviewer login)               -> counts per kiosk and day
//
// Secrets (database login, kiosk keys) live in a server-only config file outside the web root.
// Table definitions: api/sync/schema.sql.

declare(strict_types=1);
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

function out(int $status, array $body): never { http_response_code($status); header('Content-Type: application/json; charset=utf-8'); echo json_encode($body); exit; }
function fail(int $status, string $error): never { out($status, ['ok' => false, 'error' => $error]); }
function s($v, int $max): string { return mb_substr(trim((string)($v ?? '')), 0, $max); }

$home = dirname(rtrim($_SERVER['DOCUMENT_ROOT'] ?? __DIR__ . '/../..', '/'));
$configFile = $home . '/config/sync.php';
if (!is_file($configFile)) fail(503, 'not_configured');
$cfg = require $configFile;
$a = $_GET['a'] ?? '';

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== ($_SERVER['HTTP_HOST'] ?? '')) fail(403, 'bad_origin');

try {
    $db = new PDO($cfg['db_dsn'], $cfg['db_user'], $cfg['db_pass'], [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
} catch (Throwable $e) { error_log('sync db: ' . $e->getMessage()); fail(503, 'not_configured'); }

// ------------------------------------------------------------------------------------------------
// Kiosk: push
// ------------------------------------------------------------------------------------------------
if ($a === 'push') {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'bad_request');
    $key = (string)($_SERVER['HTTP_X_KK_KEY'] ?? ''); $kiosk = null;
    foreach (($cfg['kiosk_keys'] ?? []) as $name => $k) if ($key !== '' && hash_equals((string)$k, $key)) $kiosk = (string)$name;
    if ($kiosk === null) fail(401, 'bad_key');
    $raw = file_get_contents('php://input', false, null, 0, 524289);
    if ($raw === false || strlen($raw) > 524288) fail(413, 'too_large');
    $in = json_decode($raw, true); if (!is_array($in)) fail(400, 'bad_request');
    $saved = ['players' => [], 'scores' => [], 'prizes' => []];
    $ts = fn($v): ?string => is_numeric($v) ? gmdate('Y-m-d H:i:s', (int)((float)$v / 1000)) : (strtotime((string)$v) ? gmdate('Y-m-d H:i:s', strtotime((string)$v)) : null);

    $q = $db->prepare('INSERT IGNORE INTO sync_players (kiosk, client_id, name, dob, mobile, email, play_code, verified, uid, client_time, received_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())');
    foreach (array_slice((array)($in['players'] ?? []), 0, 300) as $p) {
        $id = s($p['id'] ?? '', 80); if ($id === '') continue;
        $q->execute([$kiosk, $id, s($p['name'] ?? '', 120), s($p['dob'] ?? '', 12), s($p['mobile'] ?? '', 20), s($p['email'] ?? '', 160),
                     s($p['code'] ?? '', 16), empty($p['verified']) ? 0 : 1, s($p['uid'] ?? '', 60), $ts($p['createdAt'] ?? null)]);
        $saved['players'][] = $id;
    }
    $q = $db->prepare('INSERT IGNORE INTO sync_scores (kiosk, client_id, name, play_code, score, caught, streak, client_time, received_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())');
    foreach (array_slice((array)($in['scores'] ?? []), 0, 600) as $r) {
        $id = s($r['id'] ?? '', 80); if ($id === '') continue;
        $q->execute([$kiosk, $id, s($r['name'] ?? '', 120), s($r['code'] ?? '', 16), (int)($r['score'] ?? 0), (int)($r['caught'] ?? 0), (int)($r['streak'] ?? 0), $ts($r['ts'] ?? null)]);
        $saved['scores'][] = $id;
    }
    $q = $db->prepare('INSERT IGNORE INTO sync_prizes (kiosk, client_id, kind, prize_code, name, mobile, score, turn, mode, client_time, received_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())');
    foreach (array_slice((array)($in['prizes'] ?? []), 0, 300) as $r) {
        $id = s($r['id'] ?? '', 80); if ($id === '') continue;
        $q->execute([$kiosk, $id, s($r['kind'] ?? '', 8), s($r['code'] ?? '', 16), s($r['name'] ?? '', 120), s($r['mobile'] ?? '', 20), (int)($r['score'] ?? 0), (int)($r['turn'] ?? 0), s($r['mode'] ?? '', 8), $ts($r['ts'] ?? null)]);
        $saved['prizes'][] = $id;
    }
    out(200, ['ok' => true, 'saved' => $saved]);
}

// ------------------------------------------------------------------------------------------------
// Team: export (same sign-in as the review page /debug/)
// ------------------------------------------------------------------------------------------------
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
session_name('kkdebug'); session_start();
if (empty($_SESSION['reviewer'])) fail(401, 'login_required');
session_write_close();

if ($a === 'summary') {
    $rows = [];
    foreach (['players', 'scores', 'prizes'] as $t)
        foreach ($db->query("SELECT kiosk, DATE(received_at) day, COUNT(*) n FROM sync_$t GROUP BY kiosk, DATE(received_at) ORDER BY day DESC LIMIT 60") as $r) $rows[] = ['what' => $t] + $r;
    out(200, ['ok' => true, 'rows' => $rows]);
}
if ($a === 'export') {
    $what = $_GET['what'] ?? '';
    $cols = ['players' => 'kiosk, name, dob, mobile, email, play_code, verified, uid, client_time, received_at',
             'scores'  => 'kiosk, name, play_code, score, caught, streak, client_time, received_at',
             'prizes'  => 'kiosk, kind, prize_code, name, mobile, score, turn, mode, client_time, received_at'][$what] ?? null;
    if (!$cols) fail(422, 'bad_request');
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename="kitkat-' . $what . '-' . gmdate('Ymd-Hi') . '.csv"');
    $fh = fopen('php://output', 'w'); fwrite($fh, "\xEF\xBB\xBF"); fputcsv($fh, array_map('trim', explode(',', $cols)));
    foreach ($db->query("SELECT $cols FROM sync_$what ORDER BY id") as $r) {
        // a leading = + - @ would run as a formula when the file is opened in Excel
        fputcsv($fh, array_map(fn($v) => is_string($v) && preg_match('/^[=+\-@]/', $v) ? "'" . $v : $v, array_values($r)));
    }
    exit;
}
fail(400, 'bad_request');
