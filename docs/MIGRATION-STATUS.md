# MIGRATION-STATUS – HeTec Independent Architecture

> Übergabedokument. Ein anderer Entwickler/Agent muss hiermit nahtlos weiterarbeiten können.
> Branch: `feature/hetec-independent-architecture` · Sicherung des Ausgangsstands: Branch `backup/56.0-beta.4-pre-independent`
> Ausgangsversion: **56.0-beta.4** (nicht 56.0-beta.2 wie im Auftrag angenommen) · Zielversion: **57.0.0-beta.1**

## Stand (wird laufend aktualisiert)

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Bestandsaufnahme, Architekturentscheidung | ✅ docs/INVENTORY.md, docs/ARCHITECTURE.md |
| 2 | Python entfernt, Tests nach Node/Playwright JS | ✅ |
| 3 | Smart Scan modularisiert | ✅ frontend/smart-scan/ |
| 4 | Service-Layer PSBackend | ✅ frontend/services/ |
| 5 | Backend (PHP) + MariaDB | ✅ backend/ |
| 6 | Microsoft Entra ID (OIDC, PKCE) | ✅ technisch vorbereitet, gegen Mock-Provider getestet |
| 7 | Benutzer-/Rechteverwaltung | ✅ API + admin/ |
| 8 | Statistik | ✅ idempotent, serverseitige Zusammenfassung |
| 9 | Firebase-freier Modus | ✅ `backend: 'hetec'` |
| 10 | Google/CDNs entfernt | ✅ vendor/ |
| 11 | Offline + Sync | ✅ IndexedDB-Warteschlange, Offline-Frist |
| 12 | PWA/Cache | ✅ versionierter SW, Update ohne Unterbrechung, Rollback über Release-Verzeichnis |
| 13 | Firestore-Migration | ✅ Export-Werkzeug + Import (Testlauf, Bericht, Rücknahme), nur synthetisch getestet |
| 14 | Hetzner/SFTP | ✅ Release-Build, deploy-sftp.mjs, docs/HETZNER-DEPLOYMENT.md (nicht auf echtem Hosting getestet) |
| 15 | Regression/Sicherheit | ✅ 182 Tests bestanden, 0 fehlgeschlagen; unabhängige Prüfung, Befunde behoben (docs/SECURITY.md); WebKit nur in CI |
| 16 | Doku + PR | ✅ Doku vollständig; Review + Pull Request (nicht gemergt) |

## Wichtige Befunde während der Umsetzung

1. **Neuronale OCR lief nie.** PaddleOCR im Worker brach bei jeder Erkennung mit `document is not defined` ab;
   der Dialog fiel still auf Tesseract zurück (Anzeige „Lokale KI“ trotzdem). Behoben (OffscreenCanvas), getestet.
2. **Einmal-/Monatssumme konnte vertauscht werden** (Zeilenversatz bei unscharfen Fotos). Behoben
   (Plausibilitätsschutz in `psO2Combine`/Engine), Regressionstest vorhanden.
3. **Freitext-Übersetzung schickte Kundentexte an mymemory.translated.net** (Drittanbieter). Im HeTec-Modus gesperrt.
4. **QR-Codes wurden bei api.qrserver.com erzeugt** (inkl. Download-Links zu Kundendokumenten). Jetzt lokal.
5. **iPad ohne Service Worker** (bewusst, wegen `?agent=`-Links). Im HeTec-Modus kommt die Identität aus der Sitzung →
   Service Worker auf iPad aktivierbar (`iosServiceWorker`), muss auf echten iPads getestet werden.

## Wie weiterarbeiten

- Lokal starten: `npm install && npm run dev` (Voraussetzungen: docs/DEVELOPMENT.md)
- Alle Tests: `npm test` (Ergebnisse: docs/TEST-REPORT.md)
- Release bauen: `npm run release` → `release/` (docs/HETZNER-DEPLOYMENT.md)
- Offene Punkte: Abschnitt „Offen“ unten.

## Offen / nicht ohne Infrastruktur prüfbar

- Echte Microsoft-Anmeldung (Tenant, App-Registrierung) – nur gegen Mock-Provider getestet.
- Echtes Hetzner-Hosting (PHP-Version, Erweiterungen, .htaccess, Upload-Limits, atomare Releases).
- Echte Geräte (Galaxy Tab S9 FE, iPads, Safari/WebKit) – nur Chromium headless getestet; WebKit-Download im Build-Netz gesperrt.
- Power-Automate-Archivflow muss für den Backend-Proxy angepasst werden (Secret-Header statt Firebase-Token).
- Echte Firestore-Daten wurden NICHT exportiert/migriert (nur synthetische Daten).

## Nächste Schritte (Freigaben nötig)

1. IT: App-Registrierung nach docs/MICROSOFT-ENTRA-SETUP.md (Tenant-ID, Client-ID, Secret → nur in `config.php` auf dem Server).
2. Hetzner: Hosting/DB bereitstellen, Release nach docs/HETZNER-DEPLOYMENT.md, Rauchtest.
3. CI-Lauf mit WebKit prüfen; echte Geräte (Galaxy Tab S9 FE, iPads) testen inkl. OCR-Laufzeiten.
4. Power-Automate: Archivsuche-Flow auf Secret-Header umstellen; Flow-URLs in `config.php` eintragen und neu signieren.
5. Nach Freigabe: Firestore-Export → Import (Testlauf zuerst) → Parallelbetrieb → Firebase abschalten (docs/FIREBASE-MIGRATION.md).
