# Anmeldung und Berechtigungen

## Ablauf (Microsoft Entra ID, OpenID Connect)

1. App ruft `GET /api/v1/session` → nicht angemeldet → Seite „Mit Microsoft anmelden“.
2. `GET /api/v1/auth/login` erzeugt `state`, `nonce`, PKCE-`code_verifier` (in der Server-Sitzung) und leitet zu
   `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize` weiter (Scopes nur `openid profile email`, **keine Graph-Rechte**).
3. Microsoft prüft Identität, Passwort, MFA, Conditional Access, Sperren.
4. `GET /api/v1/auth/callback`: zuerst `state`-Prüfung, dann Code-Tausch (Client-Secret nur serverseitig, PKCE S256),
   Signaturprüfung des ID-Tokens gegen die Microsoft-Schlüssel (JWKS) mit der Bibliothek `jumbojett/openid-connect-php`.
5. Zusätzlich geprüft (`EntraLogin::validateClaims`, `EntraOidcClient`):
   - Algorithmus **nur RS256**, keine eingebetteten Schlüssel (`jwk`, `jku`, `x5u`)
   - `iss` exakt `https://login.microsoftonline.com/<tenant>/v2.0`, `aud` exakt die Client-ID
   - `tid` = konfigurierte Tenant-ID (private Microsoft-Konten haben einen anderen Tenant → abgelehnt)
   - `nonce` vorhanden und gleich, `exp`, `iat`, `nbf` gültig (120 s Toleranz)
   - **Gastkonten abgelehnt** (`idp` ≠ Issuer bzw. optionaler Claim `acct = 1`)
   - E-Mail/UPN endet auf `@hetec-gmbh.de` (zusätzlich, nicht stattdessen)
6. Dauerhafte Identität: **Tenant-ID + Object-ID** (`users.entra_tenant_id`, `users.entra_object_id`).
7. Neues Konto → `status = pending`, kein Zugriff, bis ein Administrator freigibt. Ausnahme: E-Mails aus
   `bootstrap_super_admins` (nur für die Ersteinrichtung, danach leeren).
8. Neue Sitzungs-ID nach erfolgreicher Anmeldung (Schutz gegen Session Fixation).

Getestet gegen einen Mock-Microsoft-Dienst (`tests/mock-entra/server.mjs`): gültiger Login, falscher Tenant, privates
Konto, Gast, fremde Domain, falsche Audience, falscher Issuer, abgelaufen, falsche Signatur, falscher/fehlender nonce,
HS256, `alg: none`, state-Manipulation (`tests/backend/auth.test.mjs`).

## Sitzungen

- Cookie `__Host-ps_sid`: zufällige 256 Bit, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`; in der DB nur SHA-256 der ID.
- Leerlauf 8 h, absolut 12 h (konfigurierbar) – passend zu einem Shop-Tag auf geteilten Tablets.
- Sperre, Rollen- oder Shop-Änderung durch einen Admin beendet **sofort alle Sitzungen** des Benutzers.
- Schreibende Anfragen brauchen den CSRF-Header `X-PS-CSRF` (an die Sitzung gebunden) und eine erlaubte `Origin`.
- Abmelden löscht die Server-Sitzung, das Offline-Profil auf dem Gerät und leitet zur Microsoft-Abmeldung.

## Offline (zeitlich begrenzt)

- Nach jeder erfolgreichen Prüfung speichert das Gerät das bestätigte Profil (IndexedDB) mit Zeitstempel.
- Ohne Verbindung darf die App höchstens `offline_grace_hours` (Standard 12 h) mit diesem Profil weiterarbeiten
  (Beratung, Smart Scan, PDF). Danach: Online-Anmeldung nötig.
- Offline entstandene Daten gehen in die Warteschlange **des angemeldeten Benutzers**; der Server prüft beim Senden
  Sitzung, Rechte und Shop erneut. Offline ersetzt nie die zentrale Prüfung.
- Benutzerwechsel: Einträge eines anderen Benutzers werden nie unter der neuen Anmeldung gesendet; nach 14 Tagen gelöscht.
  Eine laufende Beratung des Vorgängers wird beim Wechsel verworfen.

## Rollen und Rechte (serverseitig)

| Rolle | Rang | Rechte (Auszug) |
|---|---|---|
| Hauptadministrator | 100 | alles, inkl. Statistik löschen, Web-Migration |
| Administrator | 80 | Benutzer/Rollen (unterhalb des eigenen Rangs), Shops, News, Skip-Limits, alle Statistiken, Archiv alle Shops |
| Filialbetreuer | 60 | Statistik und Benutzerliste der zugeordneten Shops (nur lesen), Beratung |
| Shop-Leiter | 40 | Statistik der zugeordneten Shops, Beratung |
| Mitarbeiter | 20 | Beratung, eigene Statistik, Archivsuche in eigenen Shops |
| Auszubildende/r | 10 | Beratung, eigene Statistik |

Springer = Kennzeichen `all_shops` (alle Shops). Mehrere Standorte = Stamm-Shop + `user_shops`.
Jeder Endpunkt prüft Anmeldung, Recht und Shop; fremde Shops liefern 403 bzw. „nicht vorhanden“ (404, ohne Existenz zu verraten).
Admins können keine Rolle ≥ dem eigenen Rang vergeben und sich nicht selbst ändern.
