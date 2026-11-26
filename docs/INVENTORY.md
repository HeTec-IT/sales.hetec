# Bestandsaufnahme und Funktionsinventur

Ausgangsstand: Branch `main`, Commit `207ce1d` „v56.0-beta.4: Smart Scan 2 – Vollansicht im Querformat + SIM-Knopf“
(gesichert als Branch `backup/56.0-beta.4-pre-independent`). Geprüft wurde die tatsächliche Implementierung, nicht die READMEs.

## 1. Aufbau vorher

| Teil | Umfang | Bemerkung |
|---|---|---|
| `index.html` | 4,7 MB, 55 847 Zeilen | gesamte App: 18 Inline-Skripte, vorkompiliertes React (`React.createElement`), CSS, Base64-Bilder, eingebettete Daten (Ziffern-Netz, PDF-Vorlage, zbar-WASM) |
| `sw.js` | network-first | Cache-Version manuell, iPad ohne Service Worker |
| `ocr/` | Smart Scan 2 (PaddleOCR) | Worker-Bundle 129 MB (vier WASM-Varianten), per Patch-Skript in `index.html` eingefügt |
| `htr-function/` | Google Cloud Function | Vertex AI/Gemini (EU) für Handschrift; Angebotsfotos per Patch deaktiviert |
| `scripts/*-preise.mjs`, `.github/workflows/*` | Preis-Bots | Netflix, Disney+, Kabel, Telekom-TV, Vodafone-TV, Pixel; o2-TV-Bot inaktiv (Workflow im Wurzelverzeichnis) |
| `scripts/patch-*.cjs`, 3 Workflows | String-Replacement-Patches auf `index.html` | genau der fragile Arbeitsablauf, der abgelöst werden sollte |
| `tests/` | 55 Node-Tests (OCR) + 3 Python-Skripte | Python: Playwright-Python, Pillow, NumPy |

## 2. Externe Abhängigkeiten (vorher)

| Ziel | Wofür | Daten, die das Gerät verlassen | Zielsystem |
|---|---|---|---|
| `www.gstatic.com` (Firebase SDK 10.12.5) | Laufzeitbibliothek | IP, Referrer | **entfernt** (nur Migrationsadapter) |
| Firebase Auth (`o2-pencil-selling`) | Anmeldung E-Mail/Passwort, Registrierung, Passwort-Reset | E-Mail, Passwort-Hash bei Google | **ersetzt** durch Microsoft Entra ID |
| Firestore `users` | Profil, Rolle, Status, Shops | Mitarbeiterdaten | MariaDB `users`, `user_shops` |
| Firestore `analytics` | Statistik je Beratung | Mitarbeitername, Shop, Ergebnis, Feldnutzung, Skip-Grund (Freitext) | MariaDB `analytics_events` |
| Firestore `saved_offers` | Angebote 30 Tage | **Kundendaten** (Name, Rufnummer, Angebot) | MariaDB `saved_offers` (libsodium-verschlüsselt) |
| Firestore `skip_limits`, `tool_usage`, `news` | Skip-Limit, Werkzeug-Nutzung, News-Ticker | Mitarbeitername | MariaDB |
| Firestore `pdf_index` | Archiv-Suchindex | **Kundenname, Rufnummer** | MariaDB `pdf_index` (verschlüsselt, Suche per HMAC) |
| Firestore `portierung_files` | Kunden-Download per QR (24 h) | **ausgefülltes Formular (PDF)** | eigene API `downloads` (verschlüsselt, außerhalb Webroot) |
| Firestore Projekt `verkaufsmappe-7d917` | Aktionsmappe-Bundles | – | MariaDB `app_settings` |
| Cloud Function `handwritingToText` (Vertex AI) | Handschrift → Text | **Handschrift-Bild** | entfällt (lokale Handschrifthilfe bleibt) |
| `api.mymemory.translated.net` | Übersetzung von Freitext | **Freitext inkl. Kundenangaben** an Dritte | **gesperrt** im HeTec-Betrieb |
| `api.qrserver.com` | QR-Bilder | **Download-Links zu Kundenformularen**, Bewertungslinks | **lokal** (`vendor/qrcode.js`) |
| `cdn.tailwindcss.com` | Tailwind zur Laufzeit (JIT) | IP | statisches CSS `vendor/tailwind/` |
| `cdn.jsdelivr.net` | React, ReactDOM, html2pdf, Tesseract (+ WASM, Sprachdaten) | IP | `vendor/` |
| `cdnjs.cloudflare.com` | pdf-lib, pdf.js (+ Worker) | IP | `vendor/` |
| `paddle-model-ecology.bj.bcebos.com` | PaddleOCR-Modelle | nur beim **Build** | Modelle im Repo, Prüfsumme in `ocr/models.lock.json` |
| `static2.o9.de` | Pixel-Produktbilder | IP, Referrer | Bot lädt Bilder nach `bilder/pixel/` |
| `*.api.powerplatform.com`, `*.logic.azure.com` | Power Automate: PDF-Archiv, Archivsuche, Folgetermin | PDF, Kundendaten (Microsoft, genehmigt) | **bleibt** (Microsoft = genehmigter Betreiber) |
| `hetecgmbh.sharepoint.com`, Google-Maps-/Instagram-Links | nur Links/QR-Inhalte | keine automatische Verbindung | bleibt |

## 3. Python

`tests/e2e/make_variants.py`, `ui_cloud.py`, `ui_scenarios.py` (Playwright-Python, Pillow, NumPy, `python -m http.server`).
Keine Python-Abhängigkeit in npm-Paketen (geprüft: keine `node-gyp`-Pakete in `package-lock.json`). Ersetzt durch
`tests/e2e/lib.mjs` (Canvas-API) und Playwright-JavaScript-Tests.

## 4. Lokale Datenhaltung (Gerät)

| Speicher | Inhalt | Benutzerbezug |
|---|---|---|
| `localStorage ps_*` | Shop, Einstellungen, Agentenname, Merker | `ps_shop`, `ps_allowed_shops` aus dem Profil |
| `localStorage pencil_analytics_o2_pending_v2_<uid>` | Statistik-Warteschlange (Firebase-Modus) | je UID |
| `localStorage ps_session_o2_v1`, Pause-Snapshot | laufende Beratung (5 Min. Pause) | `ownerUid` |
| IndexedDB (Angebote 48 h, Parkplatz) | lokale Angebote/geparkte Archivierungen | – |
| **neu:** IndexedDB `pencil-selling-hetec` | Statistik-Warteschlange je Benutzer, letztes bestätigtes Profil (Offline-Frist) | je Benutzer |

## 5. Funktionsinventur und Gegenüberstellung

Legende Test: **A** automatisiert (Datei), **E** Ende-zu-Ende gegen Release, **M** manuell auf Geräten nötig.

| Funktion | Vorher | Nachher | Test |
|---|---|---|---|
| Pencil-Selling-Beratung (Seite 1/2, Stift, Chips) | index.html | unverändert | E (`app-release`: App startet, keine Fehler), M |
| o2-Angebote, Tarif-/Geräteauswahl, Preisberechnung, Rabatte | index.html | unverändert | M |
| Smart Scan (Foto → Angebot) | inline + Patch | `frontend/smart-scan/*` | A (`tests/ocr/*`, 65), A Browser (`smart-scan-dialog` 11, `ocr-real` 2×15) |
| Mehrere Tarife / Geräte / gleiche Tarife „2×“ | ✓ | ✓ | A |
| Aktionskarten-Knopf (SIM) | ✓ | ✓ unverändert in `ui-dialog.js` | A (`card.test`), M |
| Internet@Home über mehrere Seiten | ✓ | ✓ | A (`multipage.test`) |
| Einmal/Monatlich nicht vertauschen | teilweise | **verbessert** (Zeilenversatz-Schutz) | A |
| Manuelle Korrektur, Kompakt-/Vollansicht | ✓ | ✓ | A (Dialog) |
| Neuronale OCR (PaddleOCR) | **defekt** (lief nie) | **funktioniert** | A Browser (`ocr-real` neural) |
| Kundenansicht, Sprachen | ✓ | ✓; Freitext-Übersetzung extern nur Firebase-Modus | M |
| PDF-Erstellung, Unterschriften | html2pdf/pdf-lib per CDN | selbst gehostet | E (CSP/Skripte), M |
| PDF-Archivierung (Power Automate) | ✓ | ✓ unverändert | M (Flow) |
| Archivsuche (SharePoint-Flow) | Firebase-Token an Flow | Backend-Proxy mit Secret (Flow anzupassen) | A (Proxy-Konfig 503), M |
| Suchindex | Firestore | API + MariaDB | A |
| Gespeicherte Angebote (30 Tage) | Firestore | API, verschlüsselt | A |
| Autosave / Pause / Wiederherstellung | localStorage | unverändert | M |
| Kunden-Download per QR | Firestore + qrserver | API + lokaler QR | A |
| News-Ticker | Firestore | API | A, E |
| Skip-Limit, Ausnahmen | Firestore (nach Name) | API (nach Benutzer) | A |
| Werkzeug-Nutzung | Firestore | API | A |
| Statistik (Mitarbeiter, Admin-Dashboard in der App) | Firestore | API (gleiche Felder, gleiche Berechnung im Dashboard) | A, E |
| Benutzerverwaltung / Freigabe | separates Admin-Repo (Firebase) | **`admin/`** + API | A (`admin.test`) |
| Rollen, Shops, Springer | Firestore-Felder | Tabellen, serverseitig | A |
| Folgetermin (Power Automate) | ✓ | ✓ unverändert | M |
| Preis-Bots | GitHub Actions | GitHub Actions + Preis-Schutz | A (`tests/prices`) |
| PWA-Installation, Update-Knopf | ✓ | ✓ + versioniertes Update | E |
| Offline-Betrieb | Firestore-Cache, 48 h | IndexedDB, Offline-Frist 12 h | E |

**Nicht entfernt, aber im HeTec-Betrieb nicht verfügbar** (bewusst, Datenschutz): Freitext-Übersetzung über
mymemory, Cloud-Handschrifterkennung. Grund und Alternative: docs/SECURITY.md.

**Altlasten entfernt:** Patch-Skripte/Workflows (`patch-*.cjs`, `compact-offer-beta2.yml`, `o2-multipage-patch.yml`,
`smart-scan-local.yml`), `ocr/bridge.js`, `ocr/local-hook.js`, Cloud-OCR-Code, Python-Tests.
**Nach `legacy/firebase/` verschoben:** `htr-function/`.
