# Entwicklung (lokal, ohne Azure, Firebase oder Google)

## Voraussetzungen

| Werkzeug | Version | Wofür |
|---|---|---|
| Node.js | ≥ 20 (getestet 22) | Build, Tests, Dev-Server-Start (nur Entwicklungswerkzeug) |
| PHP | ≥ 8.2 mit `pdo_mysql`, `sodium`, `curl`, `mbstring`, `openssl` | Backend |
| MariaDB | ≥ 10.5 (oder MySQL ≥ 8.0) | Datenbank |
| Git | – | Quellcode |

Kein Python, kein Docker nötig.

## Windows-Einrichtung (einmalig)

1. **Node.js** LTS installieren: <https://nodejs.org> (Installer, Standardoptionen).
2. **PHP**: „VS17 x64 Thread Safe“-ZIP von <https://windows.php.net/download/> nach `C:\php` entpacken,
   `php.ini-development` → `php.ini` kopieren und darin aktivieren (Semikolon entfernen):
   `extension=pdo_mysql`, `extension=sodium`, `extension=curl`, `extension=mbstring`, `extension=openssl`.
   `C:\php` zur PATH-Variablen hinzufügen. Prüfen: `php -m` zeigt die Erweiterungen.
3. **MariaDB** (MSI von <https://mariadb.org/download/>) installieren, Root-Passwort vergeben. In der „MySQL Client“-Konsole:
   ```sql
   CREATE DATABASE pencil_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE DATABASE pencil_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'pencil_dev'@'localhost' IDENTIFIED BY 'pencil_dev';
   CREATE USER 'pencil_dev'@'127.0.0.1' IDENTIFIED BY 'pencil_dev';
   GRANT ALL ON pencil_dev.* TO 'pencil_dev'@'localhost'; GRANT ALL ON pencil_dev.* TO 'pencil_dev'@'127.0.0.1';
   GRANT ALL ON pencil_test.* TO 'pencil_dev'@'localhost'; GRANT ALL ON pencil_test.* TO 'pencil_dev'@'127.0.0.1';
   ```
4. Repository klonen, im Ordner: `npm install` und (für Browser-Tests) `npx playwright install chromium webkit`.

## Starten

```
npm run dev                # http://127.0.0.1:8080 – HeTec-Modus, Test-Anmeldung mit synthetischen Benutzern
npm run dev -- --reset     # Datenbank leeren und neu befüllen
npm run dev -- --mock-entra  # echter OIDC-Ablauf gegen den Mock-Microsoft-Dienst (statt Test-Anmeldung)
```

Synthetische Benutzer (alle `test.*@hetec-gmbh.de`): Hauptadmin, Admin, Filialbetreuer (Aalen/Crailsheim/SHA),
Shop-Leiterin (Crailsheim), Mitarbeiter (Aalen, Crailsheim), Springer, Azubi (SHA), wartendes und gesperrtes Konto.
Verwaltung: <http://127.0.0.1:8080/admin/>.

Die Test-Anmeldung existiert nur, wenn `env = development`, `app_url` auf localhost zeigt, die Anfrage von 127.0.0.1
kommt **und** `backend/dev/` vorhanden ist. Im Release fehlt `backend/dev/` vollständig (Test `tests/release`).

## Tests

```
npm test                   # alle Suiten, Zusammenfassung in tests/.out/test-summary.json
npm test -- --quick        # ohne Browser-Läufe mit echter OCR
npm run test:ocr           # nur OCR-Logik (ohne PHP/DB/Browser)
npm run test:backend       # API + Auth + Rechte (PHP + MariaDB)
```

Datenbank für Tests: `pencil_test` (wird je Lauf geleert). Abweichend: `PS_TEST_DB_DSN`, `PS_TEST_DB_USER`, `PS_TEST_DB_PASSWORD`.

## Typische Aufgaben

| Aufgabe | Vorgehen |
|---|---|
| Design ändern | Klassen/Styles ändern, `npm run css` (Tailwind neu erzeugen) |
| Bibliothek aktualisieren | Version in `package.json`, `npm install`, `npm run vendor`, testen |
| OCR-Worker neu bauen | `cd ocr && npm ci && npm run build` (Modelle bleiben, Prüfsumme `models.lock.json`) |
| DB-Änderung | neue Datei `backend/migrations/NNNN_name.sql` (nie bestehende ändern), `php backend/bin/migrate.php` |
| Neuer API-Endpunkt | `backend/src/App.php` Route mit `auth`/`csrf`/`perm`, Controller, Test in `tests/backend/` |
| Release | `npm run release` → `release/pencil-selling-<version>/` |

## Keine echten Daten

Tests, Seeds und Fixtures enthalten ausschließlich synthetische Daten. Keine Kundendaten in Tests, Issues, Logs oder KI-Prompts.
Testfotos echter Vorschläge gehören nicht ins Repository (`BELEG_FOTO=…` nur lokal).
