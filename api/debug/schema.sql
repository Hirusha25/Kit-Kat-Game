-- Index of recorded rounds for api/debug/index.php. The files themselves live outside the web root.
CREATE TABLE IF NOT EXISTS debug_sessions (
  id              CHAR(36)     NOT NULL PRIMARY KEY,   -- random UUID made on the kiosk; not linked to a player
  kiosk           VARCHAR(40)  NOT NULL,
  path            VARCHAR(80)  NOT NULL,               -- YYYY-MM-DD/<id> under the store directory
  created_at      DATETIME     NOT NULL,
  started_at      VARCHAR(32)  NOT NULL DEFAULT '',    -- kiosk clock, ISO
  build_rev       VARCHAR(12)  NOT NULL DEFAULT '',
  mode            VARCHAR(8)   NOT NULL DEFAULT '',    -- public | test
  status          VARCHAR(12)  NOT NULL DEFAULT 'uploading',
  ended_reason    VARCHAR(24)  NOT NULL DEFAULT '',
  frames          INT          NULL,
  found_share     DECIMAL(5,4) NULL,                   -- share of play frames with the mug tracked
  lost_events     INT          NULL,
  longest_lost_ms INT          NULL,
  avg_fps         DECIMAL(5,1) NULL,
  duration_ms     INT          NULL,
  score           INT          NULL,
  camera          VARCHAR(120) NOT NULL DEFAULT '',
  bytes           BIGINT       NOT NULL DEFAULT 0,
  has_video       TINYINT      NOT NULL DEFAULT 0,
  has_frames      TINYINT      NOT NULL DEFAULT 0,
  flags           VARCHAR(120) NOT NULL DEFAULT '',
  keep            TINYINT      NOT NULL DEFAULT 0,     -- 1 = exempt from retention, used as a test fixture
  notes           TEXT         NULL,
  KEY idx_created (created_at),
  KEY idx_kiosk_created (kiosk, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
