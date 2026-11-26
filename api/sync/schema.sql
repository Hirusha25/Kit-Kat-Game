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
  client_time DATETIME     NULL,
  received_at DATETIME     NOT NULL,
  UNIQUE KEY uq_item (kiosk, client_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
