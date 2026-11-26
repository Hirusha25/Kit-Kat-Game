-- OTP codes for api/index.php. InnoDB is set explicitly (the staging server defaults to MyISAM).
CREATE TABLE IF NOT EXISTS otp_codes (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mobile        CHAR(11)     NOT NULL,            -- 947XXXXXXXX
  code_hash     CHAR(64)     NOT NULL,            -- HMAC-SHA256, the code itself is never stored
  created_at    DATETIME     NOT NULL,
  expires_at    DATETIME     NOT NULL,
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  verified_at   DATETIME     NULL,
  ip            VARCHAR(45)  NOT NULL DEFAULT '',
  wa_message_id VARCHAR(128) NULL,
  KEY idx_mobile_created (mobile, created_at),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
