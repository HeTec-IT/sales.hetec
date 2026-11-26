# Datenbank (MariaDB ≥ 10.5 / MySQL ≥ 8.0)

Nur über die serverseitige API erreichbar (nie direkt aus dem Browser). Zugriff ausschließlich über vorbereitete
PDO-Anweisungen (`backend/src/Db.php`, `ATTR_EMULATE_PREPARES = false`), Zeitzone UTC, `STRICT_ALL_TABLES`.

## Tabellen

| Tabelle | Inhalt | Schlüssel / Besonderheiten |
|---|---|---|
| `brands`, `shops` | Marken, Shops (IDs wie im Frontend, z. B. `schwaebisch-hall`) | Shops deaktivierbar statt löschen |
| `roles`, `permissions`, `role_permissions` | Rollenmodell | Rang (`rank_level`) für Vergaberegeln |
| `users` | Mitarbeiter | `public_id` (ULID, nach außen), `(entra_tenant_id, entra_object_id)` eindeutig, `legacy_firebase_uid` eindeutig, Status, Springer, Stamm-Shop, weiches Löschen |
| `user_shops` | weitere Standorte | FK auf `users`/`shops` |
| `sessions` | Server-Sitzungen | nur SHA-256 der Sitzungs-ID, Ablauf |
| `analytics_events` | Statistik je Beratung | **ID vom Gerät** → idempotent; Spalten für Auswertung + `payload` (JSON, unverändert) |
| `saved_offers` | Angebote (30 Tage) | Name/Label/Angebot **verschlüsselt** (libsodium secretbox, Schlüssel je Datensatz abgeleitet) |
| `skip_limits`, `skip_counters` | Skip-Limit und Monatszähler | je Benutzer |
| `tool_usage` | Werkzeug-Nutzung je Monat | je Benutzer |
| `news` | News-Ticker je Marke | max. 5 Einträge |
| `pdf_index`, `pdf_index_keys` | Archiv-Suchindex | Eintrag verschlüsselt; Suchschlüssel als HMAC (kein Klartext-Name in der DB) |
| `downloads` | Kunden-Downloads (24 h) | Datei verschlüsselt außerhalb des Webroots, SHA-256-Prüfung |
| `app_settings` | z. B. Aktionsmappe | JSON |
| `audit_log` | Anmeldungen, Rechteänderungen, Löschungen | keine Kundendaten; IP nur als HMAC |
| `rate_limits` | Anfragebegrenzung | |
| `import_batches`, `import_log` | Firestore-Übernahme | Rücknahme je Lauf |
| `schema_migrations` | angewandte Migrationen | Prüfsumme je Datei |

## Migrationen

- Dateien `backend/migrations/NNNN_name.sql`, laufen genau einmal in Reihenfolge (`php app/bin/migrate.php`).
- Eine bereits angewandte Datei darf nicht geändert werden (Prüfsumme → Abbruch). Änderungen = neue Datei.
- Ohne SSH: `database/schema-<version>.sql` im Release per phpMyAdmin importieren (enthält dieselben Migrationen
  inkl. Eintrag in `schema_migrations`), oder einmalig `allow_web_migrations = true` + `POST /api/v1/admin/migrate`
  als Hauptadmin, danach wieder `false`.
- Hinweis: DDL ist in MariaDB nicht transaktional. Vor Migrationen immer sichern (siehe unten).

## Löschkonzept (DSGVO)

| Daten | Frist | Umsetzung |
|---|---|---|
| Gespeicherte Angebote | 30 Tage | `expires_at`, Löschung beim Lesen + Cronjob |
| Kunden-Downloads | 24 h | Datei + Zeile gelöscht |
| Sitzungen | Ablauf (max. 12 h) | Cronjob |
| Audit-Protokoll | 400 Tage | Cronjob |
| Statistik | unbefristet (fachliche Historie); Mitarbeiterbezug (Name/Benutzer), keine Kundendaten außer optionalem Skip-Grund (Freitext, max. 200 Zeichen) | Löschung ganz (Hauptadmin) oder je Benutzer per SQL |
| Benutzer | auf Anfrage | Status `blocked` + `deleted_at`; Statistikzeilen behalten `user_id = NULL` |

Cronjob (Hetzner konsoleH → Cronjobs, stündlich): `php /pfad/zu/app/bin/cleanup.php`.

## Sicherung und Wiederherstellung

- **Datenbank:** Hetzner-Backups aktivieren (täglich). Zusätzlich vor jedem Release:
  `mysqldump --single-transaction --routines --default-character-set=utf8mb4 -u USER -p DB | gzip > ps-$(date +%F).sql.gz`
  (ohne SSH: phpMyAdmin → Exportieren → „Benutzerdefiniert“ → gzip).
  Verschlüsselt ablegen: `openssl enc -aes-256-cbc -pbkdf2 -salt -in ps.sql.gz -out ps.sql.gz.enc` (Passwort im Tresor).
- **Schlüssel:** `data_key` und `index_key` aus `config.php` getrennt und sicher aufbewahren (Passwort-Tresor).
  Ohne `data_key` sind gespeicherte Angebote, Suchindex und Downloads **nicht** wiederherstellbar (gewollt).
- **Wiederherstellung:** leere DB anlegen → Dump importieren → `config.php` mit denselben Schlüsseln → `php app/bin/migrate.php`
  (ergänzt nur fehlende Migrationen) → Rauchtest (`/api/v1/health`, Anmeldung, Statistik).
- `storage/` muss nicht gesichert werden (nur 24-h-Downloads).
