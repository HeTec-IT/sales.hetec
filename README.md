# Pencil Selling (HeTec GmbH)

Digitale Verkaufsberatung für o2- und Telekom-Shops als Progressive Web App.
Branch `feature/hetec-independent-architecture`: eigenständige HeTec-Architektur – eigenes PHP-Backend mit MariaDB,
Microsoft-Anmeldung (@hetec-gmbh.de), lokale OCR, kein Firebase, keine Google-Dienste, kein Python.

| Thema | Dokument |
|---|---|
| Aufbau | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Lokal entwickeln (Windows) | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| Bestandsaufnahme, Funktionsinventur | [docs/INVENTORY.md](docs/INVENTORY.md) |
| Sicherheit, Datenschutz, Lizenzen | [docs/SECURITY.md](docs/SECURITY.md) |
| Datenbank, Backup, Löschkonzept | [docs/DATABASE.md](docs/DATABASE.md) |
| Anmeldung und Rechte | [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) |
| Microsoft Entra einrichten (IT) | [docs/MICROSOFT-ENTRA-SETUP.md](docs/MICROSOFT-ENTRA-SETUP.md) |
| Hetzner/SFTP-Deployment, Rollback | [docs/HETZNER-DEPLOYMENT.md](docs/HETZNER-DEPLOYMENT.md) |
| Firebase-Datenmigration | [docs/FIREBASE-MIGRATION.md](docs/FIREBASE-MIGRATION.md) |
| Smart Capture QR-Import | [docs/SMART-CAPTURE.md](docs/SMART-CAPTURE.md) |
| Testergebnisse | [docs/TEST-REPORT.md](docs/TEST-REPORT.md) |
| Stand / Übergabe | [docs/MIGRATION-STATUS.md](docs/MIGRATION-STATUS.md) |
| Änderungen | [CHANGELOG.md](CHANGELOG.md) |

## Schnellstart

```
npm install
npm run dev        # http://127.0.0.1:8080 (PHP + MariaDB nötig, siehe DEVELOPMENT.md)
npm test           # alle Tests
npm run release    # Release-Artefakt für Hetzner
```

Die Datei `frontend/config/app-config.js` steht im Repository auf `backend: 'firebase'`, damit die laufende Beta auf
GitHub Pages unverändert funktioniert. Das Release für `ps.hetec.de` setzt `backend: 'hetec'`.
