# Deployment auf Hetzner Webhosting (SFTP / FileZilla)

## Anforderungen an das Hosting (vor Bestellung/Freigabe prüfen)

| Punkt | Bedarf | Hinweis |
|---|---|---|
| PHP | **8.2 oder neuer** (8.3 empfohlen) | in konsoleH je Domain wählbar |
| PHP-Erweiterungen | `pdo_mysql`, `sodium`, `curl`, `mbstring`, `openssl`, `json` | Standard bei Hetzner; mit `php -m` bzw. phpinfo prüfen |
| Datenbank | MariaDB ≥ 10.5 | 1 Datenbank, eigener Benutzer |
| Apache | `.htaccess` mit `mod_rewrite`, `mod_headers` | Standard |
| Speicher | ca. 70 MB je Release (2–3 Releases parallel für Rollback) + DB | OCR-Modelle/WASM ≈ 40 MB |
| Upload-Limit PHP | ≥ 16 MB (`post_max_size`, `upload_max_filesize`) | Angebote bis 850 KB, Downloads bis 10 MB |
| HTTPS | Let's-Encrypt-Zertifikat für `ps.hetec.de` | in konsoleH aktivieren |
| Document-Root | frei wählbares Verzeichnis je (Sub-)Domain | für Releases + atomares Umschalten |
| Cronjob | stündlich PHP-Skript | Löschfristen |
| SSH | optional | ohne SSH: Migration per phpMyAdmin |

MIME-Typen (`.wasm`, `.mjs`, `.webmanifest`) setzt die mitgelieferte `.htaccess`.

## Verzeichnisstruktur auf dem Server (empfohlen: versionierte Releases)

```
/ps/                               (z. B. im Home des Hosting-Kontos)
├── shared/
│   ├── config/config.php          ← EINMAL anlegen (aus config.example.php), nie im Webroot
│   └── storage/                   ← Laufzeitdaten (Downloads 24 h)
└── releases/
    ├── 57.0.0-beta.1-75189cd0/    ← komplettes Release-Verzeichnis
    │   ├── public/                ← Document-Root der Domain zeigt HIERHIN
    │   ├── app/  database/  config/  storage/  app-path.php  RELEASE.json  SHA256SUMS
    └── 57.0.0-beta.2-…/
```

`app/config/config.php` im Release sucht die echte Konfiguration automatisch in `/ps/shared/config/config.php`.
In `config.php` `'storage_dir' => '/ps/shared/storage'` setzen.

**Atomarer Wechsel:** Ein Release wird vollständig in ein **neues** Verzeichnis hochgeladen, während die alte Version
weiterläuft. Umgeschaltet wird erst danach, in einem Schritt: konsoleH → Domain `ps.hetec.de` → Document-Root auf
`/ps/releases/<neu>/public`. **Rollback** = Document-Root zurück auf das vorherige Verzeichnis (Sekunden).
So kann ein abgebrochener oder halber SFTP-Upload nie live gehen. Der Service Worker der Clients lädt die neue
Version im Hintergrund vollständig und aktiviert sie erst ohne laufende Beratung.

Falls der Document-Root nicht frei wählbar ist (Fallback, nicht atomar): Inhalt von `public/` in den festen Webroot,
`app/`, `config/`, `storage/`, `app-path.php` **eine Ebene darüber**. Reihenfolge beim Hochladen: zuerst `app/`, dann
`public/vendor`, `public/frontend`, `public/ocr`, ganz zuletzt `public/index.html`, `public/sw.js`, `public/sw-manifest.js`.
Ist auch das nicht möglich, `app/`, `config/`, `storage/` mit den beiliegenden `.htaccess` (`Require all denied`) sperren und testen,
dass `https://ps.hetec.de/app/bootstrap.php` 403 liefert.

## Erstinstallation

1. `npm run release` → `release/pencil-selling-<version>/` (oder `.tar.gz`).
2. Datenbank in konsoleH anlegen (Name, Benutzer, starkes Passwort).
3. `config/config.example.php` kopieren → `/ps/shared/config/config.php` ausfüllen:
   DB-Zugang, Entra-Werte (MICROSOFT-ENTRA-SETUP.md), `data_key` und `index_key` erzeugen:
   `php -r "echo base64_encode(random_bytes(32)), PHP_EOL;"` (zweimal, verschiedene Werte), `env => 'production'`,
   `bootstrap_super_admins => ['…@hetec-gmbh.de']`, `storage_dir`. Dateirechte `600`.
   **Schlüssel zusätzlich im Passwort-Tresor ablegen.**
4. Release per FileZilla nach `/ps/releases/<build>/` hochladen (siehe unten) – oder automatisiert:
   `PS_SFTP_HOST=… PS_SFTP_USER=… node scripts/deploy-sftp.mjs` (prüft vorher alle Prüfsummen).
5. Datenbank anlegen: mit SSH `php /ps/releases/<build>/app/bin/migrate.php`; ohne SSH phpMyAdmin → Import
   `database/schema-<version>.sql`.
6. Document-Root von `ps.hetec.de` auf `/ps/releases/<build>/public`, HTTPS erzwingen.
7. Cronjob stündlich: `php /ps/releases/<build>/app/bin/cleanup.php` (nach jedem Release Pfad anpassen) –
   oder ein festes Skript `/ps/shared/cleanup.php`, das `require` auf das aktuelle Release macht.
8. Rauchtest:
   - `https://ps.hetec.de/api/v1/health` → `{"ok":true,"version":"…"}`
   - `https://ps.hetec.de/app/bootstrap.php`, `/config/config.php`, `/.htaccess` → nicht erreichbar
   - Anmeldung mit Bootstrap-Admin, `/admin/` erreichbar, danach `bootstrap_super_admins` leeren
   - Browser-Konsole: keine CSP-Fehler, keine fremden Hosts (Netzwerk-Tab)

## FileZilla (manuell)

- Verbindung: Protokoll **SFTP**, Host/Benutzer aus konsoleH, Anmeldung per Schlüsseldatei (empfohlen).
- Übertragungsart **Binär** (Einstellungen → Übertragungen → Dateitypen → Standard: Binär), sonst werden WASM/TAR beschädigt.
- Rechtes Fenster: `/ps/releases/` → neuen Ordner `<build>` (Name aus `RELEASE.json`, Feld `build`).
- Linkes Fenster: Inhalt von `release/pencil-selling-<version>/` markieren → hochladen.
- Warteschlange muss **ohne Fehler** leer sein („Fehlgeschlagene Übertragungen“ = 0). Sonst Upload wiederholen;
  live ist noch nichts.
- Optional prüfen: Dateigröße von `public/ocr/generated/wasm/ort-wasm-simd-threaded.jsep.wasm` stimmt mit lokal überein.

## Update / Rollback

1. Neues Release bauen und hochladen (neues Verzeichnis). 2. Sicherung der DB (DATABASE.md).
3. Migrationen ausführen (nur neue werden angewendet; neue Migrationen sind abwärtskompatibel zu schreiben,
   damit Rollback ohne DB-Rückspielen möglich bleibt). 4. Document-Root umstellen. 5. Rauchtest.
**Rollback:** Document-Root auf vorheriges Release. DB nur zurückspielen, wenn eine Migration nicht abwärtskompatibel war.
Alte Releases nach einigen Tagen löschen (2 behalten).

## Power Automate

- PDF-Archiv- und Folgetermin-Flows bleiben unverändert (gleicher Trigger, gleicher Payload), werden im HeTec-Betrieb aber
  vom Backend aufgerufen: `config.php` → `power_automate.flows` (`archive`, `followup`, `followup_aalen`) und
  `power_automate.shared_key` mit den bisherigen Werten aus `index.html` (`ARCHIVE_FLOW_URL`, `FOLLOWUP_FLOW_URL`,
  `FOLLOWUP_FLOW_URL_AALEN`, `PA_SHARED_KEY`) füllen. Danach (Freigabe) die Flow-URLs in Power Automate neu
  generieren und nur in `config.php` eintragen. Nicht konfiguriert → Meldung „nicht konfiguriert“ (kein Rückfall).
- **Archivsuche** (Flow „PDF Archiv API V3“): im HeTec-Betrieb ruft das Backend den Flow auf (`archive_flow.url`,
  `archive_flow.shared_secret` in `config.php`). Der Flow muss angepasst werden: Bedingung „Header
  `X-HeTec-Flow-Secret` = gespeichertes Geheimnis“ statt Prüfung des Firebase-Tokens; Benutzer/Shops aus
  `identity` im Body übernehmen. Bis dahin meldet die Suche „nicht verbunden“ (kein stiller Rückfall).

## Automatisierte Deployments (später)

`scripts/deploy-sftp.mjs` nutzt OpenSSH-`sftp` (Windows 10/11 vorhanden), lädt in ein neues Release-Verzeichnis und
bricht bei Fehlern ab, ohne die laufende Version zu berühren. Für GitHub Actions: SSH-Schlüssel als Secret, Job nur
manuell auslösbar (`workflow_dispatch`) und nur nach Freigabe. Das Umschalten des Document-Root bleibt bewusst ein
manueller Schritt in konsoleH.
