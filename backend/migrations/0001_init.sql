-- HeTec Backend Core – Grundschema (MariaDB ≥ 10.5 / MySQL ≥ 8.0)
-- Alle Tabellen InnoDB, utf8mb4. Zeitstempel in UTC (DATETIME(3)).
-- Diese Datei wird von bin/migrate.php genau einmal ausgeführt (Tabelle schema_migrations).

CREATE TABLE IF NOT EXISTS brands (
  id            VARCHAR(32)  NOT NULL,
  label         VARCHAR(80)  NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shops (
  id            VARCHAR(64)  NOT NULL,            -- Slug wie bisher im Frontend (z. B. 'aalen', 'schwaebisch-hall')
  brand_id      VARCHAR(32)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  ort           VARCHAR(80)  NOT NULL DEFAULT '',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_shops_brand (brand_id),
  CONSTRAINT fk_shops_brand FOREIGN KEY (brand_id) REFERENCES brands(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id            VARCHAR(32)  NOT NULL,            -- super_admin, admin, filialbetreuer, shop_leiter, mitarbeiter, azubi
  label         VARCHAR(80)  NOT NULL,
  rank_level    SMALLINT     NOT NULL,            -- höher = mehr Rechte; Admins dürfen nur Rollen mit kleinerem Rang vergeben
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id            VARCHAR(64)  NOT NULL,
  description   VARCHAR(200) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       VARCHAR(32)  NOT NULL,
  permission_id VARCHAR(64)  NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_perm FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id           CHAR(26)     NOT NULL,       -- nach außen sichtbare, nicht erratbare ID (ULID-ähnlich)
  entra_tenant_id     CHAR(36)     NULL,           -- Microsoft Tenant-ID (tid)
  entra_object_id     CHAR(36)     NULL,           -- Microsoft Object-ID (oid) – zusammen mit tid die dauerhafte Identität
  email               VARCHAR(190) NOT NULL,
  display_name        VARCHAR(120) NOT NULL DEFAULT '',
  anrede              VARCHAR(16)  NOT NULL DEFAULT '',
  vorname             VARCHAR(80)  NOT NULL DEFAULT '',
  nachname            VARCHAR(80)  NOT NULL DEFAULT '',
  role_id             VARCHAR(32)  NOT NULL DEFAULT 'mitarbeiter',
  status              ENUM('pending','approved','blocked','rejected') NOT NULL DEFAULT 'pending',
  all_shops           TINYINT(1)   NOT NULL DEFAULT 0,   -- Springer / überall einsetzbar
  home_shop_id        VARCHAR(64)  NULL,
  is_test_user        TINYINT(1)   NOT NULL DEFAULT 0,
  legacy_firebase_uid VARCHAR(128) NULL,           -- nur für die Migration aus Firestore
  approved_by         BIGINT UNSIGNED NULL,
  approved_at         DATETIME(3)  NULL,
  last_login_at       DATETIME(3)  NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at          DATETIME(3)  NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_public (public_id),
  UNIQUE KEY uq_users_entra (entra_tenant_id, entra_object_id),
  UNIQUE KEY uq_users_legacy (legacy_firebase_uid),
  KEY idx_users_email (email),
  KEY idx_users_status (status),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id),
  CONSTRAINT fk_users_home FOREIGN KEY (home_shop_id) REFERENCES shops(id) ON DELETE SET NULL,
  CONSTRAINT fk_users_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_shops (
  user_id       BIGINT UNSIGNED NOT NULL,
  shop_id       VARCHAR(64)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, shop_id),
  KEY idx_us_shop (shop_id),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_us_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id_hash       CHAR(64)     NOT NULL,            -- SHA-256 der Session-ID (die ID selbst wird nie gespeichert)
  user_id       BIGINT UNSIGNED NULL,
  data          MEDIUMBLOB   NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at    DATETIME(3)  NOT NULL,
  user_agent    VARCHAR(200) NOT NULL DEFAULT '',
  PRIMARY KEY (id_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_exp (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Beratungs-/Statistikereignisse (bisher Firestore 'analytics'). id kommt vom Gerät → idempotent.
CREATE TABLE IF NOT EXISTS analytics_events (
  id              VARCHAR(80)  NOT NULL,
  user_id         BIGINT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',     -- Anzeigename zum Zeitpunkt der Beratung (wie bisher 'user')
  shop_id         VARCHAR(64)  NULL,
  shop_name       VARCHAR(120) NOT NULL DEFAULT '',
  brand_id        VARCHAR(32)  NOT NULL DEFAULT 'o2',
  ts              DATETIME(3)  NOT NULL,                -- Zeitpunkt der Beratung (vom Gerät)
  result          VARCHAR(32)  NOT NULL DEFAULT 'offen',
  beratungs_id    VARCHAR(64)  NOT NULL DEFAULT '',
  exempt          TINYINT(1)   NOT NULL DEFAULT 0,
  duration_min    INT          NULL,
  payload         JSON         NOT NULL,                -- vollständige Zeile (canvasStats, dslProvider, ...)
  received_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ae_ts (ts),
  KEY idx_ae_user_ts (user_id, ts),
  KEY idx_ae_shop_ts (shop_id, ts),
  KEY idx_ae_result (result),
  CONSTRAINT fk_ae_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ae_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Zentral gespeicherte Angebote (30 Tage). payload ist mit libsodium verschlüsselt (Kundendaten).
CREATE TABLE IF NOT EXISTS saved_offers (
  id              VARCHAR(80)  NOT NULL,
  shop_id         VARCHAR(64)  NOT NULL,
  user_id         BIGINT UNSIGNED NULL,
  agent_name      VARCHAR(120) NOT NULL DEFAULT '',
  label_enc       VARBINARY(1024) NOT NULL,             -- verschlüsselt (enthält Kundennamen)
  kunde_enc       VARBINARY(1024) NOT NULL,
  datum           VARCHAR(32)  NOT NULL DEFAULT '',
  ts_client       BIGINT       NOT NULL,                -- ms seit 1970 (wie bisher 'ts')
  payload_enc     LONGBLOB     NOT NULL,
  size_bytes      INT UNSIGNED NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_so_shop (shop_id, ts_client),
  KEY idx_so_exp (expires_at),
  CONSTRAINT fk_so_shop FOREIGN KEY (shop_id) REFERENCES shops(id),
  CONSTRAINT fk_so_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Skip-Limits (bisher 'skip_limits/limit_<agent>') und monatliche Zähler ('skip_<agent>_<YYYY-MM>')
CREATE TABLE IF NOT EXISTS skip_limits (
  user_id         BIGINT UNSIGNED NOT NULL,
  max_limit       INT          NOT NULL DEFAULT 15,
  exempt          TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_sl_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS skip_counters (
  user_id         BIGINT UNSIGNED NOT NULL,
  month           CHAR(7)      NOT NULL,                -- YYYY-MM
  count           INT          NOT NULL DEFAULT 0,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, month),
  CONSTRAINT fk_sc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Werkzeug-Nutzung (bisher 'tool_usage/<tool>_<agent>_<YYYY-MM>')
CREATE TABLE IF NOT EXISTS tool_usage (
  user_id         BIGINT UNSIGNED NOT NULL,
  tool            VARCHAR(64)  NOT NULL,
  month           CHAR(7)      NOT NULL,
  count           INT          NOT NULL DEFAULT 0,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, tool, month),
  KEY idx_tu_month (month),
  CONSTRAINT fk_tu_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- News-Ticker je Marke (bisher 'news/<brand>')
CREATE TABLE IF NOT EXISTS news (
  brand_id        VARCHAR(32)  NOT NULL,
  items           JSON         NOT NULL,
  updated_by      BIGINT UNSIGNED NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (brand_id),
  CONSTRAINT fk_news_brand FOREIGN KEY (brand_id) REFERENCES brands(id),
  CONSTRAINT fk_news_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PDF-Suchindex (bisher 'pdf_index'). Die PDFs selbst liegen weiter in SharePoint.
CREATE TABLE IF NOT EXISTS pdf_index (
  id              VARCHAR(190) NOT NULL,                -- normalisierter Dateiname (psIdxId)
  file_name       VARCHAR(255) NOT NULL,
  shop_id         VARCHAR(64)  NULL,
  user_id         BIGINT UNSIGNED NULL,
  typ             VARCHAR(32)  NOT NULL DEFAULT '',
  src             VARCHAR(16)  NOT NULL DEFAULT 'app',
  ts_client       BIGINT       NOT NULL DEFAULT 0,
  entry_enc       BLOB         NOT NULL,                -- verschlüsselter Eintrag (Kundenname, Nummer, …)
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_pi_shop (shop_id),
  KEY idx_pi_user_ts (user_id, ts_client),
  CONSTRAINT fk_pi_shop FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL,
  CONSTRAINT fk_pi_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Suchschlüssel (bisher Feld 'keys' + array-contains). Gespeichert als HMAC → Klartext-Namen nicht in der DB lesbar.
CREATE TABLE IF NOT EXISTS pdf_index_keys (
  index_id        VARCHAR(190) NOT NULL,
  key_hmac        CHAR(64)     NOT NULL,
  PRIMARY KEY (index_id, key_hmac),
  KEY idx_pik_key (key_hmac),
  CONSTRAINT fk_pik_index FOREIGN KEY (index_id) REFERENCES pdf_index(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Kurzlebige Kunden-Downloads (bisher 'portierung_files', 24 h). Datei liegt außerhalb des Webroots.
CREATE TABLE IF NOT EXISTS downloads (
  id              CHAR(32)     NOT NULL,                -- 128 Bit Zufall, hex
  user_id         BIGINT UNSIGNED NULL,
  shop_id         VARCHAR(64)  NULL,
  mime            VARCHAR(64)  NOT NULL,
  size_bytes      INT UNSIGNED NOT NULL,
  sha256          CHAR(64)     NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_dl_exp (expires_at),
  CONSTRAINT fk_dl_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Anwendungseinstellungen (z. B. Aktionsmappe-Bundles, bisher eigenes Firebase-Projekt 'verkaufsmappe')
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key     VARCHAR(80)  NOT NULL,
  value_json      JSON         NOT NULL,
  updated_by      BIGINT UNSIGNED NULL,
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key),
  CONSTRAINT fk_set_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit-Protokoll (Anmeldungen, Rechteänderungen, Löschungen, Admin-Aktionen). Keine Kundendaten.
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ts              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_user_id   BIGINT UNSIGNED NULL,
  action          VARCHAR(64)  NOT NULL,
  entity          VARCHAR(64)  NOT NULL DEFAULT '',
  entity_id       VARCHAR(190) NOT NULL DEFAULT '',
  shop_id         VARCHAR(64)  NULL,
  ip_hash         CHAR(64)     NOT NULL DEFAULT '',
  details         JSON         NULL,
  PRIMARY KEY (id),
  KEY idx_audit_ts (ts),
  KEY idx_audit_actor (actor_user_id, ts),
  KEY idx_audit_action (action, ts),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate Limiting (gleitendes Fenster pro Schlüssel)
CREATE TABLE IF NOT EXISTS rate_limits (
  rl_key          CHAR(64)     NOT NULL,
  window_start    INT UNSIGNED NOT NULL,
  hits            INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (rl_key, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
