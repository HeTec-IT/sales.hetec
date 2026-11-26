-- Protokoll der Datenübernahme aus Firestore: jede importierte Zeile wird einem Import-Lauf zugeordnet,
-- damit ein Lauf vollständig zurückgenommen werden kann (bin/import-firestore.php --rollback=<lauf>).
CREATE TABLE IF NOT EXISTS import_batches (
  id            CHAR(26)     NOT NULL,
  source        VARCHAR(64)  NOT NULL,
  started_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at   DATETIME(3)  NULL,
  dry_run       TINYINT(1)   NOT NULL DEFAULT 0,
  report        JSON         NULL,
  rolled_back_at DATETIME(3) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS import_log (
  batch_id      CHAR(26)     NOT NULL,
  table_name    VARCHAR(64)  NOT NULL,
  row_key       VARCHAR(190) NOT NULL,
  PRIMARY KEY (batch_id, table_name, row_key),
  CONSTRAINT fk_il_batch FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
