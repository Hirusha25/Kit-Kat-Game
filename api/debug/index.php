<?php
// Flight recorder for mug tracking: receives recorded rounds from the kiosk and serves them to the
// review page (debug/index.html). See the LLD: "Mug Tracking Debug and Remediation".
//
// Kiosk (needs the X-KK-Key header, except config):
//   GET  ?a=config                      -> {"ok":true,"mode":"off|public|test"}
//   POST ?a=begin   JSON meta           -> {"ok":true,"sizes":{file:bytes}}        (also resumes)
//   POST ?a=chunk&id=&name=&offset=     raw bytes -> {"ok":true,"size":bytes}
//   POST ?a=finish&id=  JSON final meta -> {"ok":true}
// Review page (needs a login):
//   POST ?a=login {"email","password"} | GET ?a=logout | GET ?a=list | GET ?a=session&id=
//   GET  ?a=file&id=&name=   (supports Range, for the video)
//   POST ?a=note&id= {"keep":bool,"notes":""} | POST ?a=labels&id= {"labels":{...}}
//
// Recordings are stored OUTSIDE the web root and are only reachable through this script.
// Secrets (database login, kiosk keys, reviewer password hashes) live in a server-only config file.

declare(strict_types=1);
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex');

const FILES = ['telemetry.json.gz' => 4 << 20, 'frames.bin.gz' => 24 << 20, 'camera.webm' => 24 << 20];
const SESSION_CAP = 40 << 20;

function out(int $status, array $body): never { http_response_code($status); header('Content-Type: application/json; charset=utf-8'); echo json_encode($body); exit; }
function fail(int $status, string $error): never { out($status, ['ok' => false, 'error' => $error]); }

$home = dirname(rtrim($_SERVER['DOCUMENT_ROOT'] ?? __DIR__ . '/../..', '/'));
$configFile = $home . '/config/debug.php';
if (!is_file($configFile)) fail(503, 'not_configured');
$cfg = require $configFile;
$store = rtrim($cfg['store'] ?? ($home . '/debug-sessions'), '/');
$a = $_GET['a'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && parse_url($origin, PHP_URL_HOST) !== ($_SERVER['HTTP_HOST'] ?? '')) fail(403, 'bad_origin');

if ($a === 'config') out(200, ['ok' => true, 'mode' => $cfg['mode'] ?? 'off']);

function db(array $cfg): PDO {
    static $db = null;
    if ($db) return $db;
    try {
        return $db = new PDO($cfg['db_dsn'], $cfg['db_user'], $cfg['db_pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
    } catch (Throwable $e) { error_log('debug db: ' . $e->getMessage()); fail(503, 'not_configured'); }
}
function sessionId(): string {
    $id = strtolower((string)($_GET['id'] ?? ''));
    if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $id)) fail(422, 'bad_id');
    return $id;
}
function sessionRow(array $cfg, string $id): array {
    $q = db($cfg)->prepare('SELECT * FROM debug_sessions WHERE id = ?'); $q->execute([$id]);
    $row = $q->fetch(); if (!$row) fail(404, 'no_session');
    return $row;
}
function jsonBody(int $max = 262144): array {
    $raw = file_get_contents('php://input', false, null, 0, $max + 1);
    if ($raw === false || strlen($raw) > $max) fail(413, 'too_large');
    $j = json_decode($raw, true);
    if (!is_array($j)) fail(400, 'bad_request');
    return $j;
}
function dirSize(string $dir): int { $n = 0; foreach (glob($dir . '/*') ?: [] as $f) if (is_file($f)) $n += filesize($f); return $n; }

// ------------------------------------------------------------------------------------------------
// Kiosk side
// ------------------------------------------------------------------------------------------------
if (in_array($a, ['begin', 'chunk', 'finish'], true)) {
    if ($method !== 'POST') fail(405, 'bad_request');
    if (($cfg['mode'] ?? 'off') === 'off') fail(403, 'recording_off');
    $key = (string)($_SERVER['HTTP_X_KK_KEY'] ?? '');
    $kiosk = null;
    foreach (($cfg['kiosk_keys'] ?? []) as $name => $k) if ($key !== '' && hash_equals((string)$k, $key)) $kiosk = (string)$name;
    if ($kiosk === null) fail(401, 'bad_key');
    $pdo = db($cfg);

    if ($a === 'begin') {
        $meta = jsonBody();
        $_GET['id'] = $meta['id'] ?? ''; $id = sessionId();
        $q = $pdo->prepare('SELECT path FROM debug_sessions WHERE id = ?'); $q->execute([$id]); $path = $q->fetchColumn();
        if (!$path) {
            $q = $pdo->prepare('SELECT COUNT(*) FROM debug_sessions WHERE kiosk = ? AND created_at > NOW() - INTERVAL 1 HOUR'); $q->execute([$kiosk]);
            if ((int)$q->fetchColumn() >= (int)($cfg['max_sessions_per_hour'] ?? 240)) fail(429, 'rate');
            $path = date('Y-m-d') . '/' . $id;
            if (!is_dir("$store/$path") && !mkdir("$store/$path", 0700, true)) fail(500, 'store_failed');
            $rev = trim((string)@file_get_contents($home . '/.deployed_rev'));
            $meta['kiosk'] = $kiosk; $meta['serverRev'] = substr($rev, 0, 12);
            file_put_contents("$store/$path/meta.json", json_encode($meta));
            $pdo->prepare('INSERT INTO debug_sessions (id, kiosk, path, created_at, started_at, build_rev, mode, status) VALUES (?, ?, ?, NOW(), ?, ?, ?, ?)')
                ->execute([$id, $kiosk, $path, substr((string)($meta['startedAt'] ?? ''), 0, 32), substr($rev, 0, 12), substr((string)($meta['mode'] ?? ''), 0, 8), 'uploading']);
        }
        $sizes = [];
        foreach (FILES as $name => $_) $sizes[$name] = is_file("$store/$path/$name") ? filesize("$store/$path/$name") : 0;
        out(200, ['ok' => true, 'sizes' => $sizes]);
    }

    $id = sessionId(); $row = sessionRow($cfg, $id);
    if ($row['kiosk'] !== $kiosk) fail(403, 'bad_key');
    $dir = "$store/{$row['path']}";

    if ($a === 'chunk') {
        $name = (string)($_GET['name'] ?? '');
        if (!isset(FILES[$name])) fail(422, 'bad_name');
        $file = "$dir/$name"; $have = is_file($file) ? filesize($file) : 0;
        $offset = (int)($_GET['offset'] ?? -1);
        if ($offset !== $have) out(200, ['ok' => true, 'size' => $have, 'resync' => true]);   // client continues from `size`
        $data = file_get_contents('php://input', false, null, 0, (2 << 20) + 1);
        if ($data === false || strlen($data) > (2 << 20)) fail(413, 'too_large');
        if ($have + strlen($data) > FILES[$name] || dirSize($dir) + strlen($data) > SESSION_CAP) fail(413, 'session_too_large');
        if (file_put_contents($file, $data, FILE_APPEND | LOCK_EX) === false) fail(500, 'store_failed');
        out(200, ['ok' => true, 'size' => $have + strlen($data)]);
    }

    // finish: store the final meta and work out the headline numbers from the telemetry
    $meta = jsonBody();
    $meta['id'] = $id; $meta['kiosk'] = $kiosk; $meta['serverRev'] = $row['build_rev'];
    file_put_contents("$dir/meta.json", json_encode($meta));
    $m = ['frames' => 0, 'found_share' => null, 'lost_events' => 0, 'longest_lost_ms' => 0, 'avg_fps' => null, 'duration_ms' => 0];
    $tel = is_file("$dir/telemetry.json.gz") ? json_decode((string)@gzdecode((string)file_get_contents("$dir/telemetry.json.gz")), true) : null;
    if (is_array($tel) && !empty($tel['rows'])) {
        $c = array_flip($tel['cols']); $rows = $tel['rows']; $n = count($rows);
        $found = 0; $fps = 0; $lostAt = null; $prev = null;
        // only frames between round start and round end count towards the tracking numbers
        $t0 = null; $t1 = null;
        foreach (($tel['events'] ?? []) as $ev) { if ($ev['type'] === 'play') $t0 = $ev['t']; if ($ev['type'] === 'end') $t1 = $ev['t']; }
        $played = 0;
        foreach ($rows as $r) {
            $t = $r[$c['t']];
            if ($t0 !== null && ($t < $t0 || ($t1 !== null && $t > $t1))) continue;
            $played++; $f = (int)$r[$c['tracking']]; $found += $f; $fps += (float)$r[$c['fps']];
            if ($prev === 1 && $f === 0) { $m['lost_events']++; $lostAt = $t; }
            if ($f === 1 && $lostAt !== null) { $m['longest_lost_ms'] = max($m['longest_lost_ms'], (int)($t - $lostAt)); $lostAt = null; }
            $prev = $f;
        }
        $m['frames'] = $n;
        if ($played) { $m['found_share'] = round($found / $played, 4); $m['avg_fps'] = round($fps / $played, 1); }
        $m['duration_ms'] = (int)($rows[$n - 1][$c['t']] - $rows[0][$c['t']]);
    }
    $cam = $meta['camera']['settings'] ?? [];
    $pdo->prepare('UPDATE debug_sessions SET status = ?, ended_reason = ?, frames = ?, found_share = ?, lost_events = ?, longest_lost_ms = ?, avg_fps = ?, duration_ms = ?,
                   score = ?, camera = ?, bytes = ?, has_video = ?, has_frames = ?, flags = ? WHERE id = ?')
        ->execute(['complete', substr((string)($meta['endedReason'] ?? ''), 0, 24), $m['frames'], $m['found_share'], $m['lost_events'], $m['longest_lost_ms'], $m['avg_fps'], $m['duration_ms'],
                   isset($meta['result']['score']) ? (int)$meta['result']['score'] : null,
                   substr(($cam['width'] ?? '?') . 'x' . ($cam['height'] ?? '?') . ' ' . ($meta['camera']['label'] ?? ''), 0, 120),
                   dirSize($dir), (int)is_file("$dir/camera.webm"), (int)is_file("$dir/frames.bin.gz"), substr(implode(',', (array)($meta['flags'] ?? [])), 0, 120), $id]);
    out(200, ['ok' => true, 'metrics' => $m]);
}

// ------------------------------------------------------------------------------------------------
// Review page
// ------------------------------------------------------------------------------------------------
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
session_name('kkdebug'); session_start();

if ($a === 'login') {
    if ($method !== 'POST') fail(405, 'bad_request');
    $in = jsonBody(4096); $email = strtolower(trim((string)($in['email'] ?? '')));
    $hash = $cfg['reviewers'][$email] ?? null;
    usleep(300000);   // slows guessing
    if (!$hash || !password_verify((string)($in['password'] ?? ''), $hash)) fail(401, 'bad_login');
    session_regenerate_id(true); $_SESSION['reviewer'] = $email;
    out(200, ['ok' => true, 'email' => $email]);
}
if ($a === 'logout') { $_SESSION = []; session_destroy(); out(200, ['ok' => true]); }
if (empty($_SESSION['reviewer'])) fail(401, 'login_required');
session_write_close();   // do not hold the session lock while a video streams

if ($a === 'list') {
    $rows = db($cfg)->query("SELECT id, kiosk, created_at, started_at, build_rev, mode, status, ended_reason, frames, found_share, lost_events, longest_lost_ms,
                             avg_fps, duration_ms, score, camera, bytes, has_video, has_frames, flags, keep, notes
                             FROM debug_sessions ORDER BY created_at DESC LIMIT 500")->fetchAll();
    out(200, ['ok' => true, 'sessions' => $rows, 'mode' => $cfg['mode'] ?? 'off', 'retention_days' => (int)($cfg['retention_days'] ?? 14)]);
}

$id = sessionId(); $row = sessionRow($cfg, $id); $dir = "$store/{$row['path']}";

if ($a === 'session') {
    out(200, ['ok' => true, 'row' => $row,
        'meta' => json_decode((string)@file_get_contents("$dir/meta.json"), true),
        'labels' => json_decode((string)@file_get_contents("$dir/labels.json"), true) ?: new stdClass()]);
}
if ($a === 'note' && $method === 'POST') {
    $in = jsonBody(8192);
    db($cfg)->prepare('UPDATE debug_sessions SET keep = ?, notes = ? WHERE id = ?')->execute([empty($in['keep']) ? 0 : 1, substr((string)($in['notes'] ?? ''), 0, 2000), $id]);
    out(200, ['ok' => true]);
}
if ($a === 'labels' && $method === 'POST') {
    $in = jsonBody(262144);
    if (!is_array($in['labels'] ?? null)) fail(400, 'bad_request');
    file_put_contents("$dir/labels.json", json_encode($in['labels']));
    out(200, ['ok' => true]);
}
if ($a === 'file') {
    $name = (string)($_GET['name'] ?? '');
    if (!isset(FILES[$name]) && !in_array($name, ['meta.json', 'labels.json'], true)) fail(422, 'bad_name');
    $file = "$dir/$name"; if (!is_file($file)) fail(404, 'no_file');
    $size = filesize($file); $start = 0; $end = $size - 1;
    header('Content-Type: ' . (str_ends_with($name, '.webm') ? 'video/webm' : (str_ends_with($name, '.json') ? 'application/json' : 'application/octet-stream')));
    header('Accept-Ranges: bytes');
    if (!empty($_GET['download'])) header('Content-Disposition: attachment; filename="' . substr($id, 0, 8) . '-' . $name . '"');
    if (preg_match('/^bytes=(\d*)-(\d*)$/', $_SERVER['HTTP_RANGE'] ?? '', $mm) && ($mm[1] !== '' || $mm[2] !== '')) {
        if ($mm[1] === '') { $start = max(0, $size - (int)$mm[2]); } else { $start = (int)$mm[1]; if ($mm[2] !== '') $end = min($end, (int)$mm[2]); }
        if ($start > $end) { http_response_code(416); header("Content-Range: bytes */$size"); exit; }
        http_response_code(206); header("Content-Range: bytes $start-$end/$size");
    }
    header('Content-Length: ' . ($end - $start + 1));
    $fh = fopen($file, 'rb'); fseek($fh, $start); $left = $end - $start + 1;
    while ($left > 0 && !feof($fh)) { $buf = fread($fh, min(1 << 16, $left)); if ($buf === false) break; echo $buf; $left -= strlen($buf); flush(); }
    exit;
}
fail(400, 'bad_request');
