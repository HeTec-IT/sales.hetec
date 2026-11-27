# Changelog

## Smart Capture QR-Import (Branch feature/hetec-smart-capture, nicht produktiv freigegeben)

- **Neu:** Smart-Scan-Dialog – Importweg „Smart Capture – QR-Code scannen“: Angebot vom PC (HeTec Smart Capture) per QR-Code
  übernehmen, ohne OCR auf dem Tablet. Prüfung von Protokoll, Version, Ablauf (2 Min.), Prüfsumme, Allowlist und
  personenbezogenen Daten; Bestätigung durch den Mitarbeiter; Ergänzen/Ersetzen/Abbrechen; Schutz gegen doppelte Übernahme;
  Mehrfach-QR. Foto-Import und Datei-Import unverändert. Details: docs/SMART-CAPTURE.md.

## 57.0.0-beta.1 – HeTec Independent Architecture (Entwicklungsstand, nicht produktiv freigegeben)

Ausgangsstand: 56.0-beta.4. Produktive Freigabe erst nach Abnahme auf echter Infrastruktur und echten Geräten.

### Neue Funktionen
- **Eigenes Backend (HeTec Backend Core):** PHP-8.2-REST-API mit MariaDB, ohne Firebase/Google; läuft auf klassischem Webhosting.
- **Microsoft-Anmeldung (Entra ID, @hetec-gmbh.de):** OIDC mit PKCE, Single-Tenant, Freigabe neuer Konten durch Admins.
- **Verwaltung `/admin/`:** Benutzer freigeben/sperren, Rollen (Hauptadmin, Admin, Filialbetreuer, Shop-Leiter,
  Mitarbeiter, Azubi), Stamm-/Zusatz-Shops, Springer, Sitzungen beenden, News, Statistik-Übersicht, Protokoll.
- **Offline-Warteschlange (IndexedDB)** je Benutzer, zeitlich begrenzter Offline-Betrieb (12 h), Benutzerwechsel sicher.
- **Update-System:** versionierter Service Worker, neue Version lädt im Hintergrund und wird erst ohne laufende Beratung aktiviert.
- **Release-Build + SFTP-Deployment** für Hetzner (versionierte Verzeichnisse, atomares Umschalten, Rollback).
- **Firestore-Migration:** Export-Werkzeug, Import mit Testlauf, Bericht, Wiederholbarkeit und Rücknahme.
- **Preis-Schutz** für alle Preis-Bots (Sprungprüfung mit Bestätigung, Statusprotokoll).

### Architekturänderungen
- Smart Scan aus `index.html` in `frontend/smart-scan/` (Parser, Vorverarbeitung, Engine, neuronale OCR, Übernahme,
  Kamera, Oberfläche) und `frontend/styles/smart-scan.css`.
- Alle Datenzugriffe über `PSBackend` (`frontend/services/`); Firebase nur noch als entfernbarer Migrationsadapter.
- Alle Bibliotheken selbst gehostet (`vendor/`, Herkunft und SHA-256 in `vendor/manifest.json`); Tailwind statisch.

### Entfernte Abhängigkeiten (im Zielsystem)
- Firebase Auth/Firestore/SDK, Google Cloud Function (Vertex AI/Gemini), gstatic, cdn.tailwindcss.com, jsDelivr, cdnjs,
  api.qrserver.com (QR), api.mymemory.translated.net (Übersetzung), Python (Tests), Patch-Workflows.

### Sicherheitsverbesserungen
- Kundendaten (gespeicherte Angebote, Suchindex, Downloads) verschlüsselt (libsodium); Suchschlüssel als HMAC.
- Content-Security-Policy mit Netzwerk-Allowlist; Netzwerk-Allowlist zusätzlich im Frontend; automatisierter Test.
- Serverseitige Rechte je Shop, CSRF-Schutz, Rate Limiting, Audit-Protokoll, DB-Sitzungen mit sofortigem Widerruf.
- Download-Links zu Kundenformularen gehen nicht mehr an einen externen QR-Dienst.

- Unabhängige Sicherheitsprüfung durchgeführt, alle hoch/mittel-Befunde behoben (docs/SECURITY.md):
  Power-Automate-Flows über das Backend (signierte URLs/Schlüssel nicht mehr im Browser), Admin-Freigabe nach
  Verknüpfung migrierter Konten, Statistik-Name/Ausnahme serverseitig, Archivsuche nur mit Recht, sichere Import-Rücknahme.

### Behobene Fehler
- **Neuronale OCR (PaddleOCR) lief nie** (`document is not defined` im Worker) – Smart Scan nutzte unbemerkt nur
  Tesseract. Behoben; OCR-Paket von 129 MB auf 41 MB verkleinert.
- **Einmal- und Monatssumme konnten vertauscht werden** (Zeilenversatz bei unscharfen/teilweisen Fotos). Plausibilitätsschutz.
- o2-TV-Preis-Bot war inaktiv (Workflow im falschen Verzeichnis).
- Offline-Warteschlange: nach Wiederverbindung sofortiges Senden statt Wartezeit.

### Bekannte Einschränkungen
- Nicht getestet: echte Microsoft-Anmeldung, echtes Hetzner-Hosting, echte Tablets/iPads, Safari/WebKit (lokal nicht
  installierbar; CI führt WebKit aus).
- Archivsuche braucht eine Anpassung des Power-Automate-Flows (Secret-Header statt Firebase-Token).
- Freitext-Übersetzung und Cloud-Handschrifterkennung sind im HeTec-Betrieb aus Datenschutzgründen nicht verfügbar.
- `index.html` enthält weiterhin die Beratungslogik inline (`script-src 'unsafe-inline'` nötig).
