# Sicherheit und Datenschutz

## Grundsätze

- Keine Google-/Firebase-Dienste, keine CDNs, keine Telemetrie, kein Tracking, keine Cloud-OCR im Zielsystem.
- Erlaubte Netzwerkziele: eigene Domain, Microsoft Entra ID (Anmeldung, nur Weiterleitung), Microsoft Power Automate
  (`*.api.powerplatform.com`, `*.logic.azure.com`; Archiv/Folgetermin wie bisher). Durchgesetzt durch
  **Content-Security-Policy** (`deployment/htaccess/public.htaccess`) und zusätzlich `frontend/services/ps-net.js`.
  Automatisch geprüft: Browser-Test zählt jede externe Verbindung und jeden CSP-Verstoß (`tests/e2e/app-release.test.mjs`).
- Kundenfotos (Smart Scan) verlassen das Gerät nicht.

## Maßnahmen

| Bereich | Umsetzung |
|---|---|
| HTTPS | Umleitung + HSTS (.htaccess); Konfiguration verweigert Nicht-HTTPS außerhalb der Entwicklung |
| Anmeldung | Entra ID, OIDC Code + PKCE, strenge Claim-Prüfung (siehe AUTHENTICATION.md), keine Passwörter in der App |
| Sitzungen | DB-Sitzungen, `__Host-`Cookie, HttpOnly, Secure, SameSite=Lax, Rotation nach Login, serverseitiger Widerruf |
| CSRF | Header-Token je Sitzung + Origin-Prüfung für alle schreibenden Anfragen |
| XSS | React escapt; Gate-/Admin-Oberflächen escapen explizit; CSP ohne fremde Quellen; API mit `default-src 'none'` |
| SQL-Injection | nur vorbereitete Anweisungen (PDO, keine Emulation); dynamische Teile nur aus festen Listen |
| Autorisierung | jede Route deklariert `auth`/`perm`; Shop-Prüfung in jedem Controller; Tests für fremde Shops |
| Rate Limiting | je Benutzer/IP (DB-basiert, ohne Zusatzdienste); Login, Downloads gesondert |
| Uploads | nur PDF/JPEG/PNG (Magic Bytes), max. 10 MB, zufällige Dateinamen außerhalb Webroot, verschlüsselt |
| Path Traversal | IDs per Regex, keine Benutzerpfade; Router-Tests |
| PDFs | Archiv-PDFs bleiben in SharePoint (Microsoft-Rechte); Downloads nur per 128-Bit-Token, 24 h |
| Geheimnisse | `config.php` außerhalb Webroot und `.gitignore`; Release-Build bricht bei Schlüsseln/Konfiguration ab |
| Kryptografie | ausschließlich libsodium (secretbox, generichash) und phpseclib/OpenSSL über die OIDC-Bibliothek; keine Eigenbauten |
| Protokollierung | Audit-Log (Login, Ablehnung mit Grund, Rechteänderungen, Löschungen); IP nur als HMAC; keine Kundendaten |
| Test-Anmeldung | nur `development` + localhost + Loopback-IP + Verzeichnis `backend/dev/`, das im Release fehlt (Test) |
| Service Worker | `/api/` nie gecacht; nur eigene Version im Cache; Anmeldedaten nie im SW-Cache |
| Abhängigkeiten | Backend: 3 Bibliotheken als feste GitHub-Tags (`backend/third_party`, Lizenzen beiliegend). Frontend: `vendor/manifest.json` mit Version und SHA-256 jeder Datei; CI prüft Übereinstimmung mit `package-lock.json` |

## Abhängigkeiten und Lizenzen

| Bibliothek | Version | Lizenz | Zweck |
|---|---|---|---|
| jumbojett/openid-connect-php | 1.0.2 | Apache-2.0 | OIDC-Client |
| phpseclib | 3.0.59 | MIT | RSA-Signaturprüfung (JWKS) |
| paragonie/constant_time_encoding | 3.1.5 | MIT | von phpseclib benötigt |
| React / ReactDOM | 18.3.1 | MIT | UI |
| pdf-lib | 1.17.1 | MIT | PDF |
| pdf.js (pdfjs-dist) | 2.16.105 | Apache-2.0 | PDF-Vorschau |
| html2pdf.js | 0.10.1 | MIT | PDF-Erstellung |
| tesseract.js / -core | 5.1.1 | Apache-2.0 | OCR |
| Tesseract-Sprachdaten deu/eng (4.0.0_best_int) | 1.0.0 | Apache-2.0 | OCR |
| Tailwind CSS | 3.4.19 | MIT | CSS (Build-Zeit) |
| PaddleOCR.js / PP-OCRv6 tiny | 0.4.2 | Apache-2.0 | neuronale OCR |
| onnxruntime-web | 1.24.3 | MIT | WASM-Laufzeit |
| OpenCV.js (@techstark/opencv-js, über PaddleOCR.js) | – | Apache-2.0 | Bildverarbeitung im OCR-Worker |
| qrcode-generator | 1.4.4 | MIT | QR lokal |
| jsQR | 1.4.0 | Apache-2.0 | QR lesen |
| zbar-wasm (eingebettet) | – | LGPL-2.1 | Barcode (bestehend, unverändert) |

Aktualisieren: Version in `package.json` → `npm install` → `npm run vendor` → Tests → Release. Backend: neuen Tag aus
GitHub nach `backend/third_party/` übernehmen, Version in `composer.json` anpassen, Tests.

## Restrisiken / offen

1. **Inline-Skripte in `index.html`** erzwingen `script-src 'unsafe-inline'`. Ziel: weitere Module auslagern, dann
   Nonces/Hashes. Bis dahin mindern React-Escaping und die strikte Herkunftsliste der CSP das Risiko.
2. **Power-Automate-Flow-URLs** (mit SAS-Signatur) stehen weiterhin im Frontend (wie bisher). Wer die App laden
   kann, kennt die URLs. Empfehlung: Flows mittelfristig ebenfalls über den Backend-Proxy (Secret-Header) aufrufen.
3. **Archivsuche** benötigt eine Anpassung des Flows „PDF Archiv API V3“: statt Firebase-ID-Token den Header
   `X-HeTec-Flow-Secret` prüfen und die vom Backend mitgelieferte Identität (`identity.shops`) verwenden.
4. Echte Microsoft-Anmeldung, echtes Hosting und echte Geräte sind **nicht** getestet (keine Infrastruktur).
5. Verknüpfung migrierter Benutzer erfolgt über die eindeutige E-Mail innerhalb des eigenen Tenants. Alternativ kann
   die IT vorab Object-IDs liefern; dann vor dem Import in `users.entra_object_id` eintragen.

## DSGVO-Datenminimierung

Keine neuen personenbezogenen Felder gegenüber Firestore. Kundendaten liegen nur dort, wo sie fachlich nötig sind
(gespeicherte Angebote 30 Tage, Suchindex, 24-h-Downloads) – jeweils verschlüsselt. Statistik enthält keine Kundendaten.
Microsoft erhält nur, was für die Anmeldung nötig ist (keine Graph-Zugriffe).
