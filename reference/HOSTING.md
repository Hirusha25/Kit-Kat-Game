# Hosting the backend (sync, dashboard, WhatsApp codes, round review)

The game itself is static and runs on GitHub Pages. Everything under `api/` is PHP and needs a normal
PHP host with MySQL. The dashboard and review pages must be served from the **same domain** as the API
(they sign in with a cookie), so the simplest setup is to serve the whole repository from the PHP host
and point `break.martech.live` at it instead of GitHub Pages. GitHub stays the source of the code.

## Needs
- PHP 8.1 or newer with PDO MySQL, HTTPS on the domain.
- A MySQL or MariaDB database.
- A folder **outside** the web root for config, e.g. `/home/<account>/config/` when the site is in
  `/home/<account>/public_html/`.

## Steps
1. Upload the repository to the web root (or set up a deploy that pulls `main` on each push).
2. Create the database and run, in this order: `api/debug/schema.sql`, `api/sync/schema.sql`.
   On an existing database run the `ALTER TABLE` lines noted at the bottom of `api/sync/schema.sql`.
3. Create `config/sync.php` and `config/debug.php` (outside the web root) from the templates below.
4. Open `https://break.martech.live/admin/` and sign in. Kiosks: open the game once with the kiosk key
   in the URL (`game.html?debugkey=<key>`); from then on the kiosk syncs and pulls the prize rule.

## config/sync.php
```php
<?php
return [
  'db_dsn'  => 'mysql:host=localhost;dbname=kitkat;charset=utf8mb4',
  'db_user' => 'kitkat',
  'db_pass' => '<database password>',
  // one key per kiosk; the name is what the dashboard shows
  'kiosk_keys' => ['kiosk-1' => '<long random string>', 'kiosk-2' => '<long random string>'],
];
```

## config/debug.php
```php
<?php
return [
  'db_dsn'  => 'mysql:host=localhost;dbname=kitkat;charset=utf8mb4',
  'db_user' => 'kitkat',
  'db_pass' => '<database password>',
  'kiosk_keys' => ['kiosk-1' => '<same keys as sync.php>'],
  'mode' => 'off',            // round recording for tracking review: off | sampled | all
  'retention_days' => 14,
  // dashboard / review sign-ins: email => password hash (make one with: php -r 'echo password_hash("...", PASSWORD_DEFAULT);')
  'reviewers' => ['you@example.com' => '$2y$10$...'],
];
```

## Links once hosted
- Dashboard: `https://break.martech.live/admin/`
- Round review (tracking recordings): `https://break.martech.live/debug/`
- CSV exports: from the dashboard, or `api/sync/?a=export&what=players|scores|prizes` while signed in.

## What the dashboard does
- Overview of the last 3 days per kiosk: registrations, rounds, average and best score, caps and
  T-shirts won, prizes collected.
- Prize rule: every Nth round / by score, N, even release through the day, opening hours, score
  thresholds. Stock per day: caps and T-shirts for today and the next days. Saved for all kiosks or one.
  Kiosks pull it within a minute.
- Winners and claims: every prize code with name, phone, score, round and kiosk; a Collected tick for
  the counter; search by code or phone; CSV.
- Players: first-party data with the consent flag and wording version; search; CSV.
- Scores: the day's leaderboard.
- Performance: funnel (registered → played → won), rounds/registrations/prizes per hour, three days side by side.
- Team: add staff and admin sign-ins from the dashboard (stored in the database); the config account stays as the master key.
- Exports: players and consent, every round, prize codes and collection, and winners joined with their registration details.
