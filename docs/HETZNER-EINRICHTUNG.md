# Pencil Selling auf Hetzner – Einrichtung (ohne Firebase / Google)

Ersetzt: Firebase Auth → **Microsoft Entra** (Login, Gruppen) · Firestore → **MySQL/MariaDB bei Hetzner** über die eigene
PHP-Schnittstelle `api/db.php` · Hosting → **Hetzner Webhosting** (`ps.hetec.de`), Upload per **SFTP/FileZilla**.
Es geht keine Anfrage mehr an Google. Ein Azure-Abonnement ist **nicht** nötig – nur Entra (steckt im Microsoft-365-Mandanten).
Power Automate und SharePoint bleiben unverändert.

Rechte (serverseitig in `api/lib/Rules.php`): Jede Anfrage braucht ein gültiges Entra-Login, nur E-Mail-Adressen der HeTec-Domain
(`allowed_domain`) kommen hinein. Rollen und Standorte kommen **nur aus den Entra-Gruppen** im Token. Wer in keiner Gruppe ist, kommt nicht hinein.

| Entra-Gruppe | Wirkung |
|---|---|
| `PS-Admin` | Administrator (alles, inkl. Löschen, News, Aktionsmappe) |
| `PS-Regional` | alle Standorte, sieht alle Statistiken, pflegt News und Skip-Limits |
| `PS-Springer` | darf alle Standorte nutzen (wie „Shop wechseln“) |
| `PS-Shop-<Name>` | Verkäufer dieses Standorts (mehrere Gruppen = mehrere Standorte) |

## 1. Hetzner: Subdomain, HTTPS, PHP
konsoleH → Domain `hetec.de` → **Subdomain `ps` anlegen** (Hauptordner merken, z. B. `public_html/ps`). Liegt die Domain nicht bei Hetzner,
beim Domain-Anbieter einen DNS-Eintrag `ps` auf den Hetzner-Server setzen.
**SSL-Zertifikat** für `ps.hetec.de` aktivieren (kostenlos). Danach: **Einstellungen → Konfiguration → PHP-Konfiguration** → PHP **8.1 oder neuer**,
in den PHP-Einstellungen `memory_limit` auf mindestens `256M`.

## 2. Hetzner: Datenbank
konsoleH → **Einstellungen → Datenbanken → MariaDB/MySQL → Hinzufügen** → Datenbankname, Benutzername und **Hauptpasswort** festlegen → speichern.
Als Host gilt **nicht** `localhost`, sondern die in konsoleH oberhalb der Zugangsdaten angezeigte **Verbindungskennung** (z. B. `xyz.your-database.de`), Port `3306`.
Die Tabelle `ps_docs` legt die App beim ersten Aufruf selbst an.

## 3. Entra: App-Registrierung (Login)
entra.microsoft.com → **App-Registrierungen → Neue Registrierung**
- Name `Pencil Selling` · Konten: **nur dieses Organisationsverzeichnis (Einzelmandant)**
- Umleitungs-URI: Plattform **Single-Page-Anwendung (SPA)** → `https://ps.hetec.de/` (**mit** `/` am Ende)

Auf der Übersicht kopieren: **Anwendungs-ID (Client)** und **Verzeichnis-ID (Mandant)** – beides keine Geheimnisse.
Dann **Tokenkonfiguration → Gruppenanspruch hinzufügen → Sicherheitsgruppen** (Haken bei *ID*) → Speichern.

## 4. Entra: Gruppen
**Gruppen → Neue Gruppe** · Typ *Sicherheit* · Namen wie in der Tabelle oben (12 Shop-Gruppen:
Aalen, Crailsheim, Schwaebisch-Hall, Freilassing, Neuoetting, Rosenheim, Sindelfingen, Stuttgart-Vaihingen, Traunreut, Traunstein, Waldkraiburg, Wasserburg).
Mitglieder eintragen. Von jeder Gruppe die **Objekt-ID** kopieren.

## 5. Einstellungen eintragen
1. **`ps-config.js`**: `tenantId` und `clientId` eintragen (oder im GitHub-Repo unter *Settings → Variables* `PS_TENANT_ID`/`PS_CLIENT_ID` setzen – dann steht es schon im Paket).
2. **`api/config.php`**: `api/config.beispiel.php` kopieren, in `config.php` umbenennen und ausfüllen: Tenant-/Client-ID, die Gruppen-IDs (`shops`: Gruppen-ID ⇒ Standort-Kennung
   wie in der App, z. B. `'…' => 'schwaebisch-hall'`), die Datenbank-Zugangsdaten und optional Notfall-Admins (`admin_emails`).
   Diese Datei enthält das Datenbank-Passwort: **nicht in GitHub**, nur per SFTP auf den Server (ist durch `.gitignore` und `.htaccess` geschützt).

## 6. Hochladen (FileZilla / SFTP)
Das Paket kommt aus GitHub: *Actions → „Hetzner-Paket“ → neuester Lauf → Artefakt `ps-hetzner-upload`* (ZIP) – oder lokal `node tools/build-hetzner.mjs`.
FileZilla: Protokoll **SFTP**, Server `wwwXYZ.your-server.de` (steht in konsoleH unter *Zugangsdetails → Logindaten*), Port `22`, Benutzer = konsoleH-Login
(Laut Hetzner-Anleitung meldet man sich per Schlüsseldatei an; den öffentlichen Schlüssel hinterlegt man in konsoleH unter *Logindaten → Öffentliche SFTP-Schlüssel*).
Den **gesamten Paketinhalt** in den Hauptordner der Subdomain ziehen. **Versteckte Dateien anzeigen** (FileZilla: *Server → Versteckte Dateien anzeigen*), sonst fehlt `.htaccess`.

## 7. Prüfen
`https://ps.hetec.de/api/health.php` muss `"ok": true` zeigen (nur ja/nein und Anzahlen, keine Werte). Steht dort etwas auf `false`:
`database` = Zugangsdaten/Host in `config.php`, `microsoft_keys` = Server kommt nicht zu login.microsoftonline.com, `tenant`/`client` = Eintrag fehlt, `pdo_mysql`/`openssl` = PHP-Erweiterung fehlt.
Dann die App öffnen → **Mit Microsoft anmelden**.

## Updates
Neues Paket bauen und die geänderten Dateien hochladen (`api/config.php` ist nicht im Paket und bleibt unberührt). Bei jeder Änderung an App-Dateien wird die Cache-Version in `sw.js`
erhöht (macht Claude beim Release), damit die Geräte die neue Fassung holen.

## Gut zu wissen
- **Wieder anmelden:** Entra-Sitzungen der Web-App laufen nach spätestens ca. 24 h ab. Mitarbeiter tippen morgens einmal „Mit Microsoft anmelden“ (meist ohne Passwort). Mitten in einer Beratung wird nichts unterbrochen – es erscheint nur ein Hinweis.
- **Gruppenwechsel** wirken spätestens nach ca. 1 h (Lebensdauer des Tokens) bzw. beim nächsten Anmelden.
- **Mehr als 200 Gruppen** pro Benutzer: Entra liefert dann keine Gruppenliste → Zugang wird mit klarer Meldung verweigert.
- **Alte Statistik:** Beim ersten Login wird ein altes Profil mit gleicher E-Mail übernommen (Name, alte Statistikzeilen). Die Daten selbst müssen einmalig aus Firebase importiert werden (eigener Schritt, noch offen).
- **Power-Automate-Flows (PDF-Archiv):** Die App schickt ihnen jetzt das **Entra**-ID-Token statt des Firebase-Tokens (Aussteller `https://login.microsoftonline.com/<Mandant>/v2.0`, Zielgruppe = Client-ID). Die Token-Prüfung im Flow muss darauf umgestellt werden.
- **Aktionsmappe:** Die App liest `aktionsmappe/global` jetzt aus der eigenen Datenbank. Der Inhalt muss dort einmalig angelegt werden (Admin) bzw. die Aktionsmappen-Verwaltung muss auf die eigene Schnittstelle umgestellt werden.
- **Preis-JSONs der Bots** (Netflix, Disney, Kabel, TV, Pixel …) werden weiter auf GitHub aktualisiert. Damit sie auf Hetzner ankommen, braucht es noch einen Weg dorthin (offen).
- **Datensicherung:** Alle Daten liegen in der Tabelle `ps_docs`. Hetzner-Datenbank-Backups bzw. ein Export über phpMyAdmin in konsoleH sichern sie.
- **MSAL:** Version 3.30 liegt lokal in `vendor/` (kein Fremd-CDN). Version 5 braucht eine zusätzliche Redirect-Bridge-Seite und ist bewusst noch nicht eingebaut.

## Lokal prüfen
Voraussetzung: PHP 8 mit `pdo_mysql`, MariaDB/MySQL (`mariadbd` im Pfad – oder `PS_TEST_DB_HOST/PORT/USER/PASS` setzen), Node 20+.
`node --test --test-concurrency=1 tests/api.test.js tests/client.test.js` – startet eine Test-Datenbank und einen PHP-Server mit der echten Schnittstelle und prüft Login-Token,
Rechte, Abfragen/Seiten, Datentreue und die Client-Schicht. `PS_TEST_ROOT=dist-hetzner` prüft stattdessen das fertige Upload-Paket.
