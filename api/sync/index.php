<?php
// Kiosk data sync: registrations, scores and prize codes saved on the kiosk are sent here when it is online.
//
//   POST ?a=push   header X-KK-Key   {"players":[...],"scores":[...],"prizes":[...]}
//        -> {"ok":true,"saved":{"players":[ids],"scores":[ids],"prizes":[ids]}}
//        Each item carries a client "id". Sending the same item again is harmless (stored once per kiosk).
//   GET  ?a=export&what=players|scores|prizes   (reviewer login from /debug/)  -> CSV download
//   GET  ?a=summary                             (reviewer login)               -> counts per kiosk and day
//   GET  ?a=config     header X-KK-Key          -> {"ok":true,"settings":{everyNth,...}}  prize rule for this kiosk
//   GET  ?a=getconfig  / POST ?a=setconfig {kiosk:'*'|name, settings:{...}}   (reviewer login)
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

    $q = $db->prepare('INSERT IGNORE INTO sync_players (kiosk, client_id, name, dob, mobile, email, play_code, verified, uid, consent, consent_at, consent_ver, client_time, received_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())');
    foreach (array_slice((array)($in['players'] ?? []), 0, 300) as $p) {
        $id = s($p['id'] ?? '', 80); if ($id === '') continue;
        $q->execute([$kiosk, $id, s($p['name'] ?? '', 120), s($p['dob'] ?? '', 12), s($p['mobile'] ?? '', 20), s($p['email'] ?? '', 160),
                     s($p['code'] ?? '', 16), empty($p['verified']) ? 0 : 1, s($p['uid'] ?? '', 60),
                     empty($p['consent']) ? 0 : 1, $ts($p['consentAt'] ?? null), s($p['consentVersion'] ?? '', 32), $ts($p['createdAt'] ?? null)]);
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
// Kiosk: prize rule saved by the team ('*' = every kiosk, overridden by a row for this kiosk's name)
// ------------------------------------------------------------------------------------------------
$ALLOWED = ['rewardMode' => 'str', 'everyNth' => 'int', 'pacing' => 'bool', 'openHour' => 'int', 'closeHour' => 'int', 'capMin' => 'int', 'teeMin' => 'int'];
function cleanSettings(array $in, array $allowed): array {
    $o = [];
    // stock per day: {"YYYY-MM-DD": {"cap": n, "tee": n}} for the activation days
    if (isset($in['stockDays']) && is_array($in['stockDays'])) {
        $sd = [];
        foreach ($in['stockDays'] as $day => $v) {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$day) || !is_array($v)) continue;
            $sd[(string)$day] = ['cap' => max(0, min(9999, (int)($v['cap'] ?? 0))), 'tee' => max(0, min(9999, (int)($v['tee'] ?? 0)))];
            if (count($sd) >= 31) break;
        }
        $o['stockDays'] = $sd;
    }
    foreach ($allowed as $k => $t) {
        if (!array_key_exists($k, $in)) continue;
        $v = $in[$k];
        if ($t === 'int') { $v = (int)$v; if ($k === 'everyNth') $v = max(1, min(50, $v)); if ($k === 'openHour') $v = max(0, min(23, $v)); if ($k === 'closeHour') $v = max(1, min(24, $v)); if ($k === 'capMin' || $k === 'teeMin') $v = max(1, min(200, $v)); }
        elseif ($t === 'bool') $v = !empty($v) && $v !== 'false';
        else $v = in_array($v, ['nth', 'score'], true) ? $v : 'nth';
        $o[$k] = $v;
    }
    return $o;
}
if ($a === 'config') {
    $key = (string)($_SERVER['HTTP_X_KK_KEY'] ?? ''); $kiosk = null;
    foreach (($cfg['kiosk_keys'] ?? []) as $name => $k) if ($key !== '' && hash_equals((string)$k, $key)) $kiosk = (string)$name;
    if ($kiosk === null) fail(401, 'bad_key');
    $merged = [];
    foreach (['*', $kiosk] as $who) {
        $q = $db->prepare('SELECT settings FROM sync_config WHERE kiosk = ?'); $q->execute([$who]);
        if ($row = $q->fetch()) $merged = array_merge($merged, cleanSettings((array)json_decode((string)$row['settings'], true), $ALLOWED));
    }
    out(200, ['ok' => true, 'kiosk' => $kiosk, 'settings' => $merged]);
}

// ------------------------------------------------------------------------------------------------
// Team: export (same sign-in as the review page /debug/)
// ------------------------------------------------------------------------------------------------
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
session_name('kkdebug'); session_start();
if (empty($_SESSION['reviewer'])) fail(401, 'login_required');
session_write_close();

if ($a === 'getconfig') {
    $rows = [];
    foreach ($db->query('SELECT kiosk, settings, updated_at FROM sync_config ORDER BY kiosk') as $r) $rows[$r['kiosk']] = ['settings' => json_decode((string)$r['settings'], true), 'updated_at' => $r['updated_at']];
    out(200, ['ok' => true, 'config' => $rows, 'kiosks' => array_keys((array)($cfg['kiosk_keys'] ?? []))]);
}
// ---- admin dashboard (admin/index.html) ----
if ($a === 'stats') {
    $days = max(1, min(14, (int)($_GET['days'] ?? 3)));
    $from = gmdate('Y-m-d', time() - ($days - 1) * 86400);
    $rows = ['players' => [], 'rounds' => [], 'prizes' => [], 'consent' => 0, 'kiosks' => []];
    foreach ($db->query("SELECT kiosk, DATE(COALESCE(client_time, received_at)) day, COUNT(*) n, SUM(consent) c FROM sync_players WHERE COALESCE(client_time, received_at) >= '$from' GROUP BY kiosk, day") as $r) $rows['players'][] = $r;
    foreach ($db->query("SELECT kiosk, DATE(COALESCE(client_time, received_at)) day, COUNT(*) n, AVG(score) avg_score, MAX(score) best FROM sync_scores WHERE COALESCE(client_time, received_at) >= '$from' GROUP BY kiosk, day") as $r) $rows['rounds'][] = $r;
    foreach ($db->query("SELECT kiosk, DATE(COALESCE(client_time, received_at)) day, kind, COUNT(*) n, SUM(redeemed_at IS NOT NULL) redeemed FROM sync_prizes WHERE COALESCE(client_time, received_at) >= '$from' GROUP BY kiosk, day, kind") as $r) $rows['prizes'][] = $r;
    $rows['consent'] = (int)$db->query('SELECT COALESCE(SUM(consent),0) FROM sync_players')->fetchColumn();
    $rows['total_players'] = (int)$db->query('SELECT COUNT(*) FROM sync_players')->fetchColumn();
    $rows['kiosks'] = array_keys((array)($cfg['kiosk_keys'] ?? []));
    out(200, ['ok' => true, 'from' => $from, 'days' => $days] + $rows);
}
if ($a === 'players') {
    $q = s($_GET['q'] ?? '', 80); $lim = max(1, min(500, (int)($_GET['limit'] ?? 200)));
    $sql = 'SELECT id, kiosk, name, dob, mobile, email, play_code, verified, consent, consent_at, consent_ver, client_time, received_at FROM sync_players';
    $args = [];
    if ($q !== '') { $sql .= ' WHERE name LIKE ? OR mobile LIKE ? OR email LIKE ? OR play_code LIKE ?'; $args = array_fill(0, 4, '%' . $q . '%'); }
    $st = $db->prepare($sql . " ORDER BY id DESC LIMIT $lim"); $st->execute($args);
    out(200, ['ok' => true, 'rows' => $st->fetchAll()]);
}
if ($a === 'prizes') {
    $day = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($_GET['day'] ?? '')) ? $_GET['day'] : null; $q = s($_GET['q'] ?? '', 40);
    $sql = 'SELECT id, kiosk, kind, prize_code, name, mobile, score, turn, mode, redeemed_at, redeemed_by, client_time, received_at FROM sync_prizes WHERE 1=1'; $args = [];
    if ($day) { $sql .= ' AND DATE(COALESCE(client_time, received_at)) = ?'; $args[] = $day; }
    if ($q !== '') { $sql .= ' AND (prize_code LIKE ? OR mobile LIKE ? OR name LIKE ?)'; array_push($args, '%' . $q . '%', '%' . $q . '%', '%' . $q . '%'); }
    $st = $db->prepare($sql . ' ORDER BY id DESC LIMIT 500'); $st->execute($args);
    out(200, ['ok' => true, 'rows' => $st->fetchAll()]);
}
if ($a === 'redeem') {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'bad_request');
    $in = json_decode((string)file_get_contents('php://input'), true) ?: [];
    $id = (int)($in['id'] ?? 0); if ($id <= 0) fail(422, 'bad_request');
    session_start(); $who = (string)($_SESSION['reviewer'] ?? ''); session_write_close();
    if (!empty($in['on'])) $db->prepare('UPDATE sync_prizes SET redeemed_at = NOW(), redeemed_by = ? WHERE id = ?')->execute([s($who, 120), $id]);
    else $db->prepare("UPDATE sync_prizes SET redeemed_at = NULL, redeemed_by = '' WHERE id = ?")->execute([$id]);
    out(200, ['ok' => true, 'id' => $id, 'redeemed' => !empty($in['on'])]);
}
if ($a === 'scores') {
    $day = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)($_GET['day'] ?? '')) ? $_GET['day'] : gmdate('Y-m-d');
    $st = $db->prepare('SELECT kiosk, name, play_code, score, caught, streak, client_time FROM sync_scores WHERE DATE(COALESCE(client_time, received_at)) = ? ORDER BY score DESC, id ASC LIMIT 50'); $st->execute([$day]);
    out(200, ['ok' => true, 'day' => $day, 'rows' => $st->fetchAll()]);
}
if ($a === 'setconfig') {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'bad_request');
    $in = json_decode((string)file_get_contents('php://input'), true) ?: [];
    $who = s($in['kiosk'] ?? '*', 40); if ($who === '') $who = '*';
    $set = cleanSettings((array)($in['settings'] ?? []), $ALLOWED);
    if (!$set) fail(422, 'bad_request');
    $q = $db->prepare('INSERT INTO sync_config (kiosk, settings, updated_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE settings = VALUES(settings), updated_at = NOW()');
    $q->execute([$who, json_encode($set)]);
    out(200, ['ok' => true, 'kiosk' => $who, 'settings' => $set]);
}
if ($a === 'summary') {
    $rows = [];
    foreach (['players', 'scores', 'prizes'] as $t)
        foreach ($db->query("SELECT kiosk, DATE(received_at) day, COUNT(*) n FROM sync_$t GROUP BY kiosk, DATE(received_at) ORDER BY day DESC LIMIT 60") as $r) $rows[] = ['what' => $t] + $r;
    out(200, ['ok' => true, 'rows' => $rows]);
}
if ($a === 'export') {
    $what = $_GET['what'] ?? '';
    $cols = ['players' => 'kiosk, name, dob, mobile, email, play_code, verified, consent, consent_at, consent_ver, client_time, received_at',
             'scores'  => 'kiosk, name, play_code, score, caught, streak, client_time, received_at',
             'prizes'  => 'kiosk, kind, prize_code, name, mobile, score, turn, mode, redeemed_at, redeemed_by, client_time, received_at'][$what] ?? null;
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
