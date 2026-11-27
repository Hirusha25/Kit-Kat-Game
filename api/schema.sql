-- OTP codes for api/index.php. InnoDB is set explicitly (the staging server defaults to MyISAM).
CREATE TABLE IF NOT EXISTS otp_codes (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mobile        CHAR(11)     NOT NULL,            -- 947XXXXXXXX
  code_hash     CHAR(64)     NOT NULL,            -- HMAC-SHA256 of the code, used for checking
  created_at    DATETIME     NOT NULL,
  expires_at    DATETIME     NOT NULL,
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  verified_at   DATETIME     NULL,
  ip            VARCHAR(45)  NOT NULL DEFAULT '',
  ticket_hash   CHAR(64)     NULL,            -- hash of the random ticket given to the browser that asked; status and verify need it
  wa_message_id VARCHAR(128) NULL,
  wa_status     VARCHAR(16)  NULL,            -- accepted, unknown, sent, delivered, read, failed (from Meta's receipts)
  wa_error      INT          NULL,            -- Meta's error code when failed
  code_enc      VARCHAR(96)  NULL,            -- encrypted copy of the code, kept only so the SAME code can go by SMS; cleared on verify
  sms_state     VARCHAR(12)  NULL,            -- NULL (not needed), sending, sent, failed
  sms_at        DATETIME     NULL,
  sms_reply     VARCHAR(255) NULL,            -- what text.lk answered
  KEY idx_mobile_created (mobile, created_at),
  KEY idx_wa_message (wa_message_id),
  KEY idx_ip_created (ip, created_at),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
