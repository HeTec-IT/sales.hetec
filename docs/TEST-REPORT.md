# Testbericht – Archivierung (57.0.0-beta.2)

Lauf: 2026-11-27, Linux, Node 22, Playwright Chromium headless, Firebase-Testersatz, **Power-Automate-Attrappen**
(kein echter Flow, kein SharePoint, kein echtes Firebase, synthetische Mitarbeiter/Kunden). Details: `docs/ARCHIVIERUNG.md`.

| Suite | bestanden | fehlgeschlagen |
|---|---:|---:|
| Archivierung: Archiv-Ausgang (Logik) `tests/archive/` | 19 | 0 |
| Browser: Archivierung (Zuordnung, Benutzerwechsel, Fehler, Wiederherstellung) `tests/e2e/archive-flow.test.mjs` | 19 Teiltests | 0 |
| Browser: Archivierung über die Oberfläche (Fertigstellen → Ins Archiv, echte PDF) `tests/e2e/archive-ui.test.mjs` | 3 | 0 |
| Regression: OCR-Logik 66 · Smart Capture 7 · Preise 8 · Release 7 · Smart-Scan-Dialog 12 · Smart-Capture-QR 4 · Firebase-Betrieb 1 | 105 | 0 |

Vor der Reparatur am unveränderten Stand reproduziert: Überschreiben gleichnamiger Archivierungen (uid wechselt von A zu B,
A sieht 0 Einträge), fremde geparkte Vorgänge sichtbar, Löschen geparkter Vorgänge nach 24 h, fehlende neue Einträge ab 300.

| Pflicht-Szenario | Ergebnis |
|---|---|
| 1 Normale Archivierung · 2 sofortiger Abruf · 3 Abruf nach erneutem Login | ausgeführt ✅ (auch über die Oberfläche) |
| 4 Zwei Mitarbeiter, gleiches Tablet · 5 zwei Standorte · 6 Springer · 7 Administrator | ausgeführt ✅ |
| 8 Benutzerwechsel bei ausstehender Archivierung · 9 Doppelklick · 10 parallele Archivierungen | ausgeführt ✅ |
| 11 Netzunterbrechung · 12 fehlerhafte Serverantwort · 13 verzögerte Power-Automate-Ablage | ausgeführt ✅ (Attrappen) |
| 14 fehlerhafte PDF · 15 Browser-Neustart · 17 alte Archivierungen · 20 Wiederherstellung | ausgeführt ✅ |
| 16 Monats-/Jahreswechsel | ausgeführt ✅ (Logik, lokales Datum; nicht mit verstellter Geräteuhr im Browser) |
| 18 PWA-Update/Service-Worker | teilweise ✅: Neuladen/Neustart mit ausstehendem Eintrag; echtes SW-Update auf GitHub Pages nicht |
| 19 Unberechtigter Zugriff auf fremde Archive | teilweise ✅: App zeigt nie fremde Einträge; **Firestore-Regeln und Flow-Prüfung nicht testbar** (liegen nur in Firebase/Power Automate) |
| Echte Flows/SharePoint, echte Galaxy Tab S9 FE/iPads, Safari/WebKit | **nicht ausgeführt** (kein Zugriff; keine Produktivanfragen) |

# Testbericht – 57.0.0-beta.1

Lauf: 2026-11-26, `node scripts/run-tests.mjs` (Gesamtlauf nach Behebung der Review-Befunde) (Ergebnisdatei `tests/.out/test-summary.json`, nicht versioniert).
Umgebung: Linux-Build-Server, Node 22, PHP 8.2, MariaDB 10.11, Playwright Chromium headless.
**Zusätzlich GitHub Actions (CI) mit Chromium UND WebKit (Safari-Engine, Desktop):** 185 bestanden, 0 fehlgeschlagen (Commit c151bcb).
Alle Testdaten synthetisch (keine echten Kunden-/Mitarbeiterdaten).

## Ergebnis

| Suite | bestanden | fehlgeschlagen | übersprungen | Dauer |
|---|---:|---:|---:|---:|
| OCR-Logik (Parser, Engine, Mehrseiten, Smart Scan) | 66 | 0 | 0 | 75 s |
| Preisdaten + Preis-Schutz | 7 | 0 | 0 | 0 s |
| Backend-API, Auth (Entra-Mock), Rechte, Statistik, Flow-Weiterleitung | 48 | 0 | 0 | 3 s |
| Firestore-Migration (synthetisch) | 6 | 0 | 0 | 1 s |
| Release-Artefakt | 7 | 0 | 0 | 4 s |
| Browser: Smart-Scan-Dialog (12 Abläufe) | 12 | 0 | 0 | 67 s |
| Browser: echte lokale OCR – Tesseract | 15 | 0 | 0 | 67 s |
| Browser: echte lokale OCR – PaddleOCR/ONNX | 15 | 0 | 0 | 109 s |
| Browser: Firebase-Betrieb (GitHub-Pages-Beta, Firebase-Testersatz) | 1 | 0 | 0 | 4 s |
| Browser: Verwaltung (admin/) | 2 | 0 | 0 | 6 s |
| Browser: Release Ende-zu-Ende (Login, Offline, Sync, Update, CSP) | 6 | 0 | 0 | 23 s |
| **Gesamt** | **185** | **0** | **0** | |

WebKit lokal nicht installierbar, aber in der CI ausgeführt (Dialog, OCR beider Engines, Firebase-Betrieb): bestanden.
Befund aus der CI (behoben): Neuronale OCR las bei leicht unscharfem Foto auf anderer Hardware eine Ziffer der Summe falsch
(2.468,96 statt 2.468,98) → neue Regel: Summe, die in genau einer Ziffer von den Einzelpreisen abweicht, bleibt leer.
Keine Tests deaktiviert. Die 3 Python-Tests wurden durch gleichwertige JS-Tests ersetzt (Cloud-OCR-Fälle durch lokale).

## Abdeckung (Auszug)

- **Auth:** gültiger Login, falscher Tenant, persönliches Konto (MSA-Tenant), Gastkonto (idp/acct), fremde Domain,
  falscher Issuer, falsche Audience, abgelaufenes Token, falsche Signatur, `alg:none`/HS256, falscher/fehlender Nonce,
  falscher State (vor Code-Tausch), neue Benutzer „wartend“, gesperrte Konten, Bootstrap-Hauptadmin, Widerruf durch Sperre,
  Abmeldung (auch wartender Konten), Bootstrap nur ohne vorhandenen Hauptadmin, Name nur einmalig, Test-Login nur für
  synthetische Konten und im Release nicht vorhanden. Verknüpfung migrierter Benutzer nur mit Admin-Freigabe: Migrationstest.
- **Rechte:** fremder Shop (lesen/schreiben), Rangregeln bei Rollenvergabe, Sitzungsende und Skip-Limits, keine Selbstbearbeitung,
  Archivsuche nur mit Recht (auch mit shopId), Springer/Mehrfach-Shops,
  CSRF fehlt, fremder Origin, Rate Limit (429), SQL-Injection- und Path-Traversal-Muster in Parametern.
- **Statistik:** Batch mit Dubletten (doppelter Sync → keine Doppelzählung), Eigentümerkonflikt, Name/Ausnahme serverseitig,
  Zeitfenster, Zusammenfassung je Shop/Benutzer-ID/Tag/Monat, Paging.
- **Power Automate:** Weiterleitung nur angemeldet + CSRF, Schlüssel vom Server, Payload unverändert, nicht konfiguriert → 503;
  im Release-Browser `ps-flow:`-Platzhalter statt signierter URL.
- **Migration:** Testlauf, Übernahme, Rollen nur aus Altwerten, Konflikt bei vorhandener E-Mail, Rücknahme behält genutzte Konten.
- **Offline (Browser):** Beratung offline → Warteschlange → online → genau einmal gespeichert; Offline-Frist; Abmelden sendet
  offene Zeilen zuerst; Benutzerwechsel: Warteschlange bleibt benutzergetrennt.
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
| iPadOS-Safari (echtes Gerät) | WebKit nur als Desktop-Engine in der CI getestet | echte iPads |
| Galaxy Tab S9 FE, Android-Kamera | kein Gerät | Kamera, Smart Scan, Offline, Update auf Gerät |
| Power-Automate-Flows (Archiv, Folgetermin) | produktive Flows nicht angefasst | nach Flow-Anpassung mit Testshop |
| Preis-Bots gegen Live-Websites | Netzwerk gesperrt | GitHub-Actions-Lauf (manuell auslösen) |
| Firestore-Export mit echten Daten | nicht freigegeben | FIREBASE-MIGRATION.md |
| PDF-Erzeugung (html2pdf) im Release | nur Laden der Bibliothek geprüft, nicht Inhalt | manuell: Beratung → PDF |

**Gerätekompatibilität wird ausdrücklich nicht behauptet**: Alle Browser-Ergebnisse sind Simulation (Chromium headless, Desktop-Viewport/Tablet-Viewport), keine echten Geräte.
