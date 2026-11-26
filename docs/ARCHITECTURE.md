# Architektur – Pencil Selling (HeTec Independent Architecture)

## Entscheidung

**Variante A – klassisches Webhosting** (PHP 8.2+, MariaDB, REST, SFTP) wurde umgesetzt, wie von der IT bevorzugt.
Gründe: läuft auf Hetzner-Webhosting ohne Root, Docker, Node-Prozesse, WebSockets oder SSH; keine Composer-Pflicht
auf dem Server; Backups über die Hosting-Werkzeuge. Variante B (Node/PostgreSQL) wurde nicht gebaut; die API ist
dokumentiert und backend-neutral (`frontend/services/ps-backend.js`), ein Austausch des Backends betrifft nur einen Adapter.

```
 Tablet / PC (PWA)                                      ps.hetec.de (Hetzner)
 ┌───────────────────────────────────────┐             ┌──────────────────────────────────────┐
 │ index.html  (Beratung, PDF, UI)        │   HTTPS     │ public/  (Document Root)              │
 │ frontend/smart-scan/  (OCR lokal)      │  ────────►  │   index.html, frontend/, vendor/, ocr/│
 │ frontend/services/                     │  /api/v1/*  │   api/index.php  ──┐                  │
 │   ps-backend.js  → adapter-hetec.js    │ ◄────────   │ app/  (außerhalb)  ◄┘ PHP-API          │
 │   sync-queue.js (IndexedDB)            │             │ config/ (außerhalb) storage/ (außerh.) │
 │ sw.js (versionierter Cache, offline)   │             │ MariaDB                                │
 └───────────────┬───────────────────────┘             └───────────────┬──────────────────────┘
                 │ Anmeldung (Weiterleitung)                           │ OIDC (Code + PKCE, Secret)
                 ▼                                                     ▼
          Microsoft Entra ID (login.microsoftonline.com) ◄──────── Token-Prüfung (JWKS)
                 Power Automate / SharePoint (Archiv, Folgetermin) – unverändert, Microsoft
```

## Schichten

| Schicht | Ort | Aufgabe |
|---|---|---|
| App-Hülle | `index.html` | Beratung, Angebote, PDF, Kundenansicht (unverändert übernommen, Firebase entfernt) |
| Smart Scan | `frontend/smart-scan/` | `parser` → `preprocess` → `neural`/`engine` → `transfer`; Oberfläche `ui-dialog`, `ui-crop`; `config.js` |
| Design | `frontend/styles/`, `vendor/tailwind/` | Tailwind (statisch erzeugt), Smart-Scan-Variablen |
| Schnittstelle | `frontend/services/ps-backend.js` | einzige Stelle, über die die App Daten liest/schreibt |
| Adapter | `adapter-hetec.js` / `adapter-firebase.js` | Zielsystem bzw. Übergang (Firebase-Adapter ist entfernbar) |
| Offline | `sync-queue.js`, `sw.js`, `pwa-update.js` | Warteschlange je Benutzer, versionierter Cache, Updates ohne Unterbrechung |
| Netzwerk | `ps-net.js` + CSP | Allowlist (eigene Domain + Power Automate) |
| API | `backend/src/` | `App` (Routing, Auth, CSRF, Rate Limit) → Controller → Repositories → `Db` (PDO) |
| Identität | `backend/src/Auth/` | Entra-OIDC (`jumbojett/openid-connect-php`), strenge Claim-Prüfung, Sitzungen in der DB |
| Daten | `backend/migrations/` | relationales Schema, versionierte Migrationen |
| Verwaltung | `admin/` | Benutzer, Rollen, Shops, News, Statistik, Protokoll |
| Werkzeuge | `scripts/`, `tests/` | Node.js (nur Entwicklung): Build, Vendor, Release, SFTP, Tests – kein Python |

## Datenflüsse (Zielsystem)

- **Beratung** → bei Abschluss/Angebot/Überspringen eine Statistikzeile mit Geräte-ID → IndexedDB → `POST /api/v1/analytics/batch`
  (idempotent: gleiche ID = gleiche Zeile, nie doppelt gezählt).
- **Angebot speichern** → `PUT /api/v1/offers/{id}` → verschlüsselt (libsodium) in `saved_offers`, 30 Tage.
- **Archivieren** → wie bisher direkt an Power Automate; Suchindex-Eintrag → `PUT /api/v1/pdf-index/{id}`.
- **Smart Scan** → Foto bleibt im Arbeitsspeicher des Geräts; OCR im Web Worker (PaddleOCR) bzw. Tesseract; kein Upload.
- **Anmeldung** → Microsoft → Callback → Sitzung (HttpOnly-Cookie) → `GET /api/v1/session` liefert Profil, Rechte, Shops.

## Wie man …

- **das Design ändert:** Tailwind-Klassen/Inline-Styles in `index.html` bzw. für Smart Scan **nur** in
  `frontend/smart-scan/ui-dialog.js`, `ui-crop.js`, `frontend/styles/smart-scan.css`. Danach `npm run css`.
- **eine Funktion mit Daten baut:** Methode in beiden Adaptern (`adapter-hetec.js`, solange nötig `adapter-firebase.js`)
  + Endpunkt in `backend/src/App.php` (mit `auth`, `csrf`, `perm`) + Test in `tests/backend/`.
- **die OCR versteht:** siehe `frontend/smart-scan/engine.js` (Ablauf, Zeitbudget, Abbruch) und `parser.js` (Belegauswertung).
  Neuronale OCR: `ocr/smart-scan-worker.mjs`, gebaut mit `cd ocr && npm ci && npm run build`.

## Bewusste Grenzen

- `index.html` bleibt groß (Beratungslogik). Weitere Zerlegung (Seite 1, Seite 2, PDF) ist der nächste Schritt; das
  Muster ist mit Smart Scan vorgegeben. Solange Inline-Skripte existieren, braucht die CSP `'unsafe-inline'` für Skripte.
- Telekom-/Fachhandel-Edition ist nicht Teil dieses Repositorys (eigene Live-Repos); das Schema kennt Marken (`brands`).
