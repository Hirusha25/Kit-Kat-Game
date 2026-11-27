-- Kiosk data sync (api/sync/index.php). One row per item per kiosk; a repeated push is ignored.
CREATE TABLE IF NOT EXISTS sync_players (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kiosk       VARCHAR(40)  NOT NULL,
  client_id   VARCHAR(80)  NOT NULL,
  name        VARCHAR(120) NOT NULL DEFAULT '',
  dob         VARCHAR(12)  NOT NULL DEFAULT '',
  mobile      VARCHAR(20)  NOT NULL DEFAULT '',
  email       VARCHAR(160) NOT NULL DEFAULT '',
  play_code   VARCHAR(16)  NOT NULL DEFAULT '',
  verified    TINYINT      NOT NULL DEFAULT 0,
  uid         VARCHAR(60)  NOT NULL DEFAULT '',
  client_time DATETIME     NULL,            -- kiosk clock, UTC
  received_at DATETIME     NOT NULL,
  UNIQUE KEY uq_item (kiosk, client_id), KEY idx_mobile (mobile)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_scores (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kiosk       VARCHAR(40)  NOT NULL,
  client_id   VARCHAR(80)  NOT NULL,
  name        VARCHAR(120) NOT NULL DEFAULT '',
  play_code   VARCHAR(16)  NOT NULL DEFAULT '',
  score       INT          NOT NULL DEFAULT 0,
  caught      INT          NOT NULL DEFAULT 0,
  streak      INT          NOT NULL DEFAULT 0,
  client_time DATETIME     NULL,
  received_at DATETIME     NOT NULL,
  UNIQUE KEY uq_item (kiosk, client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_prizes (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kiosk       VARCHAR(40)  NOT NULL,
  client_id   VARCHAR(80)  NOT NULL,
  kind        VARCHAR(8)   NOT NULL DEFAULT '',   -- cap | tee
  prize_code  VARCHAR(16)  NOT NULL DEFAULT '',
  name        VARCHAR(120) NOT NULL DEFAULT '',
  mobile      VARCHAR(20)  NOT NULL DEFAULT '',
  score       INT          NOT NULL DEFAULT 0,
  turn        INT          NOT NULL DEFAULT 0,    -- round number of the day on that kiosk (every Nth wins)
  mode        VARCHAR(8)   NOT NULL DEFAULT '',   -- nth | score: the rule in force when it was awarded
  client_time DATETIME     NULL,
  received_at DATETIME     NOT NULL,
  UNIQUE KEY uq_item (kiosk, client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Existing databases: ALTER TABLE sync_prizes ADD COLUMN turn INT NOT NULL DEFAULT 0, ADD COLUMN mode VARCHAR(8) NOT NULL DEFAULT '';

-- Prize rule set by the team on the review page and pulled by each kiosk every minute.
-- kiosk '*' applies to every kiosk; a row with a kiosk's name overrides it for that kiosk only.
CREATE TABLE IF NOT EXISTS sync_config (
  kiosk       VARCHAR(40) NOT NULL PRIMARY KEY,
  settings    TEXT        NOT NULL,          -- JSON: rewardMode, everyNth, pacing, openHour, closeHour, capMin, teeMin
  updated_at  DATETIME    NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
