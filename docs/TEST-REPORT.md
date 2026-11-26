# Testbericht – 57.0.0-beta.1

Lauf: 2026-11-26, `node scripts/run-tests.mjs` (Gesamtlauf 174/174; danach 2 Backend-Tests ergänzt – Rate Limit, SQL-Injection – und `tests/backend/api.test.mjs` erneut ausgeführt: 23/23) (Ergebnisdatei `tests/.out/test-summary.json`, nicht versioniert).
Umgebung: Linux-Build-Server, Node 22, PHP 8.2, MariaDB 10.11, Playwright Chromium headless.
Alle Testdaten synthetisch (keine echten Kunden-/Mitarbeiterdaten).

## Ergebnis

| Suite | bestanden | fehlgeschlagen | übersprungen | Dauer |
|---|---:|---:|---:|---:|
| OCR-Logik (Parser, Engine, Mehrseiten, Smart Scan) | 65 | 0 | 0 | 75 s |
| Preisdaten + Preis-Schutz | 7 | 0 | 0 | 0 s |
| Backend-API, Auth (Entra-Mock), Rechte, Statistik | 43 | 0 | 0 | 4 s |
| Firestore-Migration (synthetisch) | 5 | 0 | 0 | 1 s |
| Release-Artefakt | 7 | 0 | 0 | 4 s |
| Browser: Smart-Scan-Dialog (11 Abläufe) | 11 | 0 | 0 | 66 s |
| Browser: echte lokale OCR – Tesseract | 15 | 0 | 0 | 67 s |
| Browser: echte lokale OCR – PaddleOCR/ONNX | 15 | 0 | 0 | 109 s |
| Browser: Verwaltung (admin/) | 2 | 0 | 0 | 6 s |
| Browser: Release Ende-zu-Ende (Login, Offline, Sync, Update, CSP) | 6 | 0 | 0 | 23 s |
| **Gesamt** | **176** | **0** | **0** | |

Nicht ausgeführte Suiten: **WebKit/Safari** (alle Browser-Suiten) – Browser-Download im Build-Netz gesperrt.
In `.github/workflows/ci.yml` konfiguriert (`PS_BROWSERS=chromium,webkit`); Ergebnis steht erst nach dem ersten CI-Lauf fest.
Keine Tests deaktiviert. Die 3 Python-Tests wurden durch gleichwertige JS-Tests ersetzt (Cloud-OCR-Fälle durch lokale).

## Abdeckung (Auszug)

- **Auth:** gültiger Login, falscher Tenant, persönliches Konto (MSA-Tenant), Gastkonto (idp/acct), fremde Domain,
  falscher Issuer, falsche Audience, abgelaufenes Token, falsche Signatur, `alg:none`/HS256, falscher/fehlender Nonce,
  falscher State (vor Code-Tausch), neue Benutzer „wartend“, gesperrte Konten, Bootstrap-Hauptadmin, Widerruf durch Sperre,
  Abmeldung, Test-Login nur für synthetische Konten und im Release nicht vorhanden. Verknüpfung migrierter Benutzer: Migrationstest.
- **Rechte:** fremder Shop (lesen/schreiben), Rangregeln bei Rollenvergabe, keine Selbstbearbeitung, Springer/Mehrfach-Shops,
  CSRF fehlt, fremder Origin, Rate Limit (429), SQL-Injection- und Path-Traversal-Muster in Parametern.
- **Statistik:** Batch mit Dubletten (doppelter Sync → keine Doppelzählung), Eigentümerkonflikt, Zusammenfassung je Shop/Benutzer/Tag/Monat, Paging.
- **Offline (Browser):** Beratung offline → Warteschlange → online → genau einmal gespeichert; Offline-Frist; Benutzerwechsel
  leert aktive Beratung und Warteschlange bleibt benutzergetrennt.
- **PWA:** neue Version wartet bei laufender Beratung, Banner, Aktivierung, keine Mischung alter/neuer Dateien (Cache je Version), `/api` nie im Cache.
- **CSP/Netzwerk:** Release-App lädt ohne externe Verbindung und ohne CSP-Verstoß (gezählt per Playwright).
- **Smart Scan:** mehrere Tarife, Geräte, Gruppierung, Aktionskarte-Button, Internet@Home, Mehrseiten-Angebote,
  Summenprüfung, Zeilenversatz (Regression), unscharf/gedreht/abgeschnitten/Rauschen/Kontrast.
- **Release:** keine Geheimnisse, keine Firebase-Abhängigkeit, kein `backend/dev`, Prüfsummen, `app/` außerhalb `public/`,
  geschützte Pfade liefern 403/404.
- **Preise:** Validierung, Sprungschutz mit Bestätigung im zweiten Lauf, Statusdatei.

## Gemessene OCR-Laufzeiten (Build-Server, headless Chromium – **nicht** Tablet)

| Engine | Fall | Laufzeit |
|---|---|---|
| Tesseract.js (WASM) | sauberes Foto | ≈ 2,8 s |
| Tesseract.js | starkes Rauschen | ≈ 18,5 s |
| PaddleOCR/ONNX (WASM) | Kaltstart Worker | ≈ 1,6 s |
| PaddleOCR/ONNX | Erkennung (warm) | ≈ 1,6–1,9 s |
| PaddleOCR/ONNX | frische Seite inkl. Kaltstart, je Foto | ≈ 7,5 s |

Auf Galaxy Tab S9 FE / iPads ist mit 2–4× längeren Zeiten zu rechnen → **auf echten Geräten messen** (Budget: 12 s gesamt, danach Tesseract-Ergebnis).

## Nicht getestet (Infrastruktur fehlt)

| Bereich | Grund | Wie prüfen |
|---|---|---|
| Echte Microsoft-Anmeldung | keine App-Registrierung (Freigabe nötig) | MICROSOFT-ENTRA-SETUP.md, Abschnitt „Abnahme“ |
| Hetzner-Hosting | kein Konto/Zugang (Freigabe nötig) | HETZNER-DEPLOYMENT.md, „Rauchtest“ |
| Safari/WebKit, iPadOS | Browser nicht installierbar | CI-Lauf + echte iPads |
| Galaxy Tab S9 FE, Android-Kamera | kein Gerät | Kamera, Smart Scan, Offline, Update auf Gerät |
| Power-Automate-Flows (Archiv, Folgetermin) | produktive Flows nicht angefasst | nach Flow-Anpassung mit Testshop |
| Preis-Bots gegen Live-Websites | Netzwerk gesperrt | GitHub-Actions-Lauf (manuell auslösen) |
| Firestore-Export mit echten Daten | nicht freigegeben | FIREBASE-MIGRATION.md |
| PDF-Erzeugung (html2pdf) im Release | nur Laden der Bibliothek geprüft, nicht Inhalt | manuell: Beratung → PDF |

**Gerätekompatibilität wird ausdrücklich nicht behauptet**: Alle Browser-Ergebnisse sind Simulation (Chromium headless, Desktop-Viewport/Tablet-Viewport), keine echten Geräte.
