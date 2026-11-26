# Microsoft Entra ID – Einrichtung für Pencil Selling (Anleitung für die IT)

Ergebnis: eine **Single-Tenant-App-Registrierung** für `https://ps.hetec.de`, die nur Anmeldung erlaubt
(keine Microsoft-Graph-Berechtigungen, keine Daten in Azure). Kosten: keine (Entra ID Free genügt; MFA/Conditional
Access nach vorhandener Lizenz).

## 1. App registrieren

1. <https://entra.microsoft.com> → **Identität → Anwendungen → App-Registrierungen → Neue Registrierung**
2. Name: `Pencil Selling`
3. Unterstützte Kontotypen: **Nur Konten in diesem Organisationsverzeichnis (nur HeTec GmbH – einzelner Mandant)**
4. Umleitungs-URI: Plattform **Web**, `https://ps.hetec.de/api/v1/auth/callback`
5. Registrieren. Notieren: **Anwendungs-(Client-)ID** und **Verzeichnis-(Mandanten-)ID**.

## 2. Authentifizierung

- **Abmelde-URL für Front-Channel:** `https://ps.hetec.de/`
- **Implizite Gewährung:** ID-Token und Zugriffstoken **nicht** aktivieren (Auth-Code-Flow mit PKCE wird verwendet).
- **Öffentliche Clientflows zulassen:** Nein.

## 3. Geheimer Clientschlüssel

**Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel**, Ablauf z. B. 12 oder 24 Monate.
Den **Wert** (nicht die ID) sofort sicher an den Betreiber übergeben; er gehört **nur** in `config/config.php`
auf dem Server (außerhalb des Webroots), niemals ins Repository, in E-Mails im Klartext oder in Tickets.
Ablaufdatum im Kalender vormerken (vorher neuen Schlüssel anlegen und in `config.php` tauschen).
Alternativ Zertifikat statt Secret (empfohlen bei längerer Laufzeit; nach Rücksprache umstellbar).

## 4. Token-Konfiguration (optional, empfohlen)

**Tokenkonfiguration → Optionalen Anspruch hinzufügen → ID:** `email`, `acct`.
`acct` ermöglicht die zusätzliche Erkennung von Gastkonten (die App lehnt Gäste ohnehin über den Issuer-Abgleich ab).

## 5. API-Berechtigungen

Standardmäßig steht `User.Read` (Microsoft Graph) drin. **Entfernen** – die App fordert nur `openid profile email` an.
Keine Administratorzustimmung für Graph nötig.

## 6. Zugriff steuern (empfohlen)

**Unternehmensanwendungen → Pencil Selling → Eigenschaften → Zuweisung erforderlich: Ja**, dann unter
**Benutzer und Gruppen** z. B. die Gruppe „Shops“ zuweisen. So kommen nur vorgesehene Mitarbeiter überhaupt zur Anmeldung.
Die fachliche Freigabe (Rolle, Shops) erfolgt zusätzlich in der App-Verwaltung `https://ps.hetec.de/admin/`.
Conditional Access (z. B. MFA außerhalb der Shop-Netze) kann auf diese App angewendet werden.

## 7. Werte für `config/config.php`

```php
'entra' => [
    'tenant_id'      => '<Verzeichnis-(Mandanten-)ID>',
    'client_id'      => '<Anwendungs-(Client-)ID>',
    'client_secret'  => '<Wert des geheimen Clientschlüssels>',
    'redirect_uri'   => 'https://ps.hetec.de/api/v1/auth/callback',
    'post_logout_redirect_uri' => 'https://ps.hetec.de/',
    'allowed_domains' => ['hetec-gmbh.de'],
    'reject_guests'  => true,
    'authority_override' => '',
],
'bootstrap_super_admins' => ['v.nachname@hetec-gmbh.de'],   // Hauptadmin(s) der Ersteinrichtung
```

## 8. Prüfen

1. `https://ps.hetec.de/` → „Mit Microsoft anmelden“ → Anmeldung → App startet (Bootstrap-Admin).
2. Zweites Konto anmelden → „Warte auf Freigabe“ → in `/admin/` freigeben → App startet.
3. Gastkonto / privates Microsoft-Konto → abgelehnt.
4. `/admin/` → Protokoll: Einträge `login`, `user_registered`, `user_updated`.

Weitere Azure-Dienste sind nicht nötig. Mögliche spätere Erweiterungen (nur nach Freigabe): App-Rollen/Gruppenansprüche
als zusätzliche Vorbelegung der Rollen, Microsoft Graph für SharePoint-Archiv direkt (statt Power-Automate-Proxy).
