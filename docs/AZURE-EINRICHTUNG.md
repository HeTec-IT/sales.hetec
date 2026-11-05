# Pencil Selling auf Azure – Einrichtung (ohne Firebase / Google)

Ersetzt: Firebase Auth → **Microsoft Entra** (Login, Gruppen) · Firestore → **Azure Table Storage** über eigene
**Azure Functions** (`/api/db`) · Hosting → **Azure Static Web Apps**. Es geht keine Anfrage mehr an Google.

Rechte (serverseitig in `api/src/lib/rules.js`): Jede Anfrage braucht ein gültiges Entra-Login. Rollen und Standorte
kommen **nur aus den Entra-Gruppen** im Token. Wer in keiner Gruppe ist, kommt nicht hinein.

| Entra-Gruppe | Wirkung |
|---|---|
| `PS-Admin` | Administrator (alles, inkl. Löschen, News, Aktionsmappe) |
| `PS-Regional` | alle Standorte, sieht alle Statistiken, pflegt News und Skip-Limits |
| `PS-Springer` | darf alle Standorte nutzen (wie „Shop wechseln“) |
| `PS-Shop-<Name>` | Verkäufer dieses Standorts (mehrere Gruppen = mehrere Standorte) |

## 1. Speicherkonto (Daten)
Azure-Portal → **Speicherkonten → Erstellen** → Redundanz *LRS*, Leistung *Standard*, Region *West Europe/Germany West Central*.
Danach: Speicherkonto → **Sicherheit + Netzwerk → Zugriffsschlüssel → Verbindungszeichenfolge** kopieren (nur für Schritt 5, nirgends sonst einfügen).
Die Tabelle `psdocs` legt die App beim ersten Aufruf selbst an.

## 2. Static Web App (Hosting + Funktionen)
Portal → **Static Web Apps → Erstellen** · Plan **Free** (reicht) · Region West Europe · Bereitstellungsquelle **Andere**.
Nach dem Erstellen: **Übersicht → Bereitstellungstoken verwalten → kopieren**.
GitHub → Repo `sales.hetec` → *Settings → Secrets and variables → Actions → New repository secret*:
Name `AZURE_STATIC_WEB_APPS_API_TOKEN`, Wert = Token. (Der Workflow `.github/workflows/azure-static-web-apps.yml` ist schon im Repo.)
Die Adresse der App steht in der Übersicht (`https://….azurestaticapps.net`).

## 3. Entra: App-Registrierung (Login)
entra.microsoft.com → **App-Registrierungen → Neue Registrierung**
- Name `Pencil Selling` · Konten: **nur dieses Organisationsverzeichnis (Einzelmandant)**
- Umleitungs-URI: Plattform **Single-Page-Anwendung (SPA)** → `https://<deine-app>.azurestaticapps.net/` (**mit** `/` am Ende; später auch die eigene Domain als zweite URI)

Auf der Übersicht kopieren: **Anwendungs-ID (Client)** und **Verzeichnis-ID (Mandant)**.
Dann **Tokenkonfiguration → Gruppenanspruch hinzufügen → Sicherheitsgruppen** (Haken bei *ID*) → Speichern.

## 4. Entra: Gruppen
**Gruppen → Neue Gruppe** · Typ *Sicherheit* · Namen wie in der Tabelle oben (12 Shop-Gruppen:
Aalen, Crailsheim, Schwaebisch-Hall, Freilassing, Neuoetting, Rosenheim, Sindelfingen, Stuttgart-Vaihingen, Traunreut, Traunstein, Waldkraiburg, Wasserburg).
Mitglieder eintragen. Von jeder Gruppe die **Objekt-ID** kopieren und in `docs/PS_GROUPS.beispiel.json` eintragen (Vorlage; die Shop-IDs rechts nicht ändern).

## 5. Einstellungen der Static Web App
Static Web App → **Einstellungen → Umgebungsvariablen** (Umgebung *Production*) → hinzufügen:

| Name | Wert |
|---|---|
| `PS_TENANT_ID` | Verzeichnis-ID (Mandant) |
| `PS_CLIENT_ID` | Anwendungs-ID (Client) |
| `PS_GROUPS` | kompletter Inhalt der ausgefüllten JSON-Vorlage (eine Zeile) |
| `PS_STORAGE_CONNECTION` | Verbindungszeichenfolge aus Schritt 1 |
| `PS_ADMIN_EMAILS` | `d.dasilva@hetec-gmbh.de` (Notzugang als Admin, falls Gruppen noch fehlen) |

Geheimnisse (Verbindungszeichenfolge, Token) **nie** in den Chat oder ins Repo – nur hier bzw. als GitHub-Secret.

## 6. Eintragen und veröffentlichen
In `ps-config.js` `tenantId` und `clientId` eintragen (keine Geheimnisse) → committen/pushen. Der Workflow testet die Funktionen und veröffentlicht.
Prüfen: `https://<deine-app>.azurestaticapps.net/api/health` muss `"ok": true` zeigen (zeigt nur ja/nein, keine Werte).
Dann die App öffnen → **Mit Microsoft anmelden**.

## Gut zu wissen
- **Wieder anmelden:** Entra-Sitzungen der Web-App laufen nach spätestens ca. 24 h ab. Mitarbeiter tippen morgens einmal „Mit Microsoft anmelden“ (meist ohne Passwort). Mitten in einer Beratung wird nichts unterbrochen – es erscheint nur ein Hinweis.
- **Gruppenwechsel** wirken spätestens nach ca. 1 h (Lebensdauer des Tokens) bzw. beim nächsten Anmelden.
- **Mehr als 200 Gruppen** pro Benutzer: Entra liefert dann keine Gruppenliste → Zugang wird mit klarer Meldung verweigert.
- **Alte Statistik:** Beim ersten Login wird ein altes Profil mit gleicher E-Mail übernommen (Name, alte Statistikzeilen). Die Daten selbst müssen einmalig aus Firebase importiert werden (eigener Schritt).
- **Power-Automate-Flows (PDF-Archiv):** Die App schickt ihnen jetzt das **Entra**-ID-Token statt des Firebase-Tokens. Die Prüfung im Flow muss darauf umgestellt werden.
- **Aktionsmappe:** Die App liest `aktionsmappe/global` jetzt aus der eigenen Datenbank. Der Inhalt muss dort einmalig angelegt werden (Admin) bzw. die Aktionsmappen-Verwaltung muss auf die eigene Schnittstelle umgestellt werden.
- **MSAL:** Es liegt Version 3.30 lokal in `vendor/` (kein Fremd-CDN). Version 5 braucht eine zusätzliche Redirect-Bridge-Seite und ist bewusst noch nicht eingebaut.

## Lokal prüfen
`cd api && npm ci && npm test` – startet einen Speicher-Emulator (Azurite) und prüft Login-Token, Rechte, Datenzugriff und die Client-Schicht.
