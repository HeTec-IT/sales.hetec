# Archivierung – Analyse und Reparatur (57.0.0-beta.2)

Stand: 27.11.2026 · nur Beta (`HeTec-IT/sales.hetec`, GitHub Pages `https://hetec-it.github.io/sales.hetec/`).
Live-Apps (`PS-Dashboard`, `PS-Dashboard-Telekom`) und Power-Automate-Flows wurden **nicht** verändert.

## 1. Datenfluss (vor der Reparatur)

```
Fertigstellen → ReferralModal „Ins Archiv & neuer Kunde“ (onFinish)
  → sendToArchive()                      Kundenname/Rufnummer abfragen, Archiv-PDF erzeugen (html2pdf)
  → buildArchivDateiname()               PENCIL_[Kennung]_[Shop]_[Typ]_[Datum].pdf   (Datum UTC)
  → buildArchivBetreff()                 PENCIL|typ|datum|Vorname
  → dispatchArchiveMail()
      → sendArchivCopyToNewFlow()        fetch(ARCHIVE_FLOW_URL, mode:'no-cors', 8 s)  → Antwort UNLESBAR
          Flow 1 (HTTP) → E-Mail an pencil-selling@hetec-gmbh.de → Flow 2 (Mail-Trigger) → SharePoint
      → psIdxRecordArchive()             Firestore pdf_index/{Dateiname}.set(…, uid = AKTUELLER Login)
  → Erfolgsbildschirm „Archivierung erfolgreich“ → Neustart
Fehler/offline → parkArchiveEntry() (IndexedDB) → autoFlush nur beim Wechsel offline→online
Meine Statistik → Archiv: pdf_index where uid==ich [, shopId in erlaubte Shops] limit(300) + Prüfung „exists“ (Flow V3)
```

## 2. Festgestellte Fehler (alle mit synthetischen Daten reproduziert)

| # | Fehler | Folge |
|---|---|---|
| F1 | **Dateiname nicht eindeutig** (Kennung + Shop + Typ + Tag). Suchindex-ID = Dateiname, `set()` überschreibt komplett. | Zweite Archivierung mit gleichem Namen (z. B. jedes Angebot „keinName“ eines Shops am selben Tag, gleicher Kundenname, zweiter Abschluss derselben Nummer) **überschreibt Index-Eintrag und SharePoint-Datei** des ersten Mitarbeiters. Der Eintrag trägt danach uid/Name des zweiten → **A findet seine Archivierung nicht mehr, B sieht sie in seinem Archiv.** |
| F2 | **Geparkte Vorgänge geräteweit statt je Benutzer**; Nachsenden schrieb den Index mit der uid des **gerade angemeldeten** Benutzers, Shop aus dessen Sitzung. | Geteiltes Tablet: A parkt (Netzfehler), B meldet sich an → Vorgang wird unter B nachgesendet → steht in Bs Archiv, nicht in As. B sah außerdem As geparkte Vorgänge (inkl. Kundenname). |
| F3 | **Geparkte Vorgänge nach 24 h kommentarlos gelöscht** (bereits beim bloßen Auflisten). Automatisches Nachsenden nur beim Wechsel offline→online, nicht beim App-Start. | Vorgang, der nach Neustart/Neuladen nie mehr „online wird“, verschwand nach 24 h **samt PDF**. |
| F4 | **Schein-Erfolg**: `mode:'no-cors'` → jede Antwort des Flows (auch 4xx/5xx/Drosselung) gilt als Erfolg; Erfolgsbildschirm vor jeder Bestätigung; Archiv-Ansicht zeigte bei fehlender Prüfung „Archivierung erfolgreich“. Nach einer Park-Aktion zeigte „Ins Archiv“ ebenfalls „erfolgreich“. | Mitarbeiter wähnen sich sicher, obwohl nichts abgelegt wurde. |
| F5 | **`limit(300)` ohne Zeitfilter/Sortierung** in „Meine Archivierungen“. Firestore liefert die ersten 300 Dokumente nach Dokument-ID (= Dateiname, alphabetisch) über alle Zeiten. | Ab 300 Archivierungen eines Mitarbeiters **fehlen neue Einträge** (z. B. Kunden mit späterem Anfangsbuchstaben). |
| F6 | Archiv-Ansicht nur über die **aktuell freigegebenen Shops**. | Springer/Shopwechsel/entzogene Freigabe: frühere eigene Archivierungen unsichtbar. |
| F7 | **Filialauswahl (`ps_shop`) geräteweit**: Springer/Admin übernahm beim Anmelden die Filiale des **vorherigen** Mitarbeiters am Tablet. | Archivierung unbemerkt im falschen Shop (Dateiname, SharePoint-Ordner, Index). |
| F8 | Zeitlimit 8 s für 1–2 MB Base64. | Bei schwachem Netz Abbruch mitten im Upload → als Fehler gewertet, obwohl Daten evtl. ankamen. |
| F9 | Datum per `toISOString()` (UTC). | 00:00–01/02:00 Uhr Vortag im Dateinamen/Ordner (selten, Monats-/Jahreswechsel). |
| F10 | Geparkte Vorgänge ließen sich ohne Rückfrage löschen. | Versehentlicher Datenverlust. |

**Hauptursache der gemeldeten Fälle:** F1 (Überschreiben gleichnamiger Archivierungen) und F2 (Nachsenden unter fremder Anmeldung) erklären exakt „A hat archiviert, findet es nicht – B findet es in seinem Archiv“. F3/F5 erklären „vollständig verschwunden“.
Nicht bestätigt werden konnte, wie Flow 2 bei bereits vorhandenem Dateinamen reagiert (überschreiben/neue Version oder Fehler) – beides führt zu F1.

Geprüft und **in Ordnung**: Identität beim Archivieren kommt aus dem Firebase-Login (`__PS_USER_UID`), Domainprüfung @hetec-gmbh.de, Groß-/Kleinschreibung der E-Mail (wird normalisiert), pausierte Beratungen/Autosave und Statistik-Puffer sind je uid getrennt, geladene Angebote übernehmen den aktuellen Mitarbeiternamen, ein Benutzerwechsel lädt die Seite neu.

## 3. Reparatur

- **Archiv-Ausgang** `frontend/services/archive-queue.js` (ohne Firebase-Abhängigkeit, Versand/Prüfung/Index als Funktionen übergeben → Azure-/Entra-tauglich):
  - Eintrag **vor** dem Versand in IndexedDB: `archiveId`, eindeutiger Dateiname, `uid`, `email`, `employeeName`, `shopId`, `createdByUserId`, `createdAt/archivedAt/updatedAt`, `archiveStatus`, `documentVersion`, `schemaVersion`, PDF.
  - Status: *läuft* → *wird überprüft* (übergeben) → *erfolgreich* (in SharePoint gefunden); *ausstehend* (automatische Wiederholung mit Backoff); *fehlgeschlagen* (sichtbar, „Erneut senden“/„Verwerfen“ mit Rückfrage).
  - „Erfolgreich“ **nur** nach Fund über den vorhandenen Flow „PDF Archiv API V3“, Aktion `exists`. Nicht gefunden nach 20 Min. → automatisch erneut senden (gleicher Dateiname, keine Dubletten), max. 3 Versände, danach *fehlgeschlagen*. Nie automatisch gelöscht.
  - Eigentümer unveränderlich; fremde Einträge (anderer Benutzer am Gerät) werden mit **ihren Originalangaben** gesendet, Index-Eintrag schreibt nur der Eigentümer selbst, Meldungen nur an den Eigentümer.
  - Doppelklick/gleichzeitige Aufrufe → genau ein Eintrag/Versand. Mehrere Tabs → Web Locks.
  - Datenschutz: PDF wird nach Bestätigung gelöscht, Kundenname/Rufnummer entfernt sobald der Suchindex sie hat, Metadaten 31 Tage. Ohne Prüfmöglichkeit PDF höchstens 7 Tage.
  - Technisches Protokoll (localStorage, 30 Tage, 400 Einträge): archiveId (= Korrelations-ID), uid, Shop, Zeit, Schritt, Status, Fehlercode, Versuch – **keine** Kundendaten, keine Tokens, keine PDF-Inhalte.
- **Eindeutiger Dateiname**: `PENCIL_Mueller--1415k7q_Aalen_Angebot_2026-11-27.pdf` (Uhrzeit + 3 Zufallszeichen hinter der Kennung). Positionen für den Flow unverändert (Shop = [2], Typ = [3], Datum = [4]), Präfix `PENCIL_` und Betreff unverändert. Je Beratung fest (Wiederholung = gleicher Name), neue Beratung = neues Kennzeichen. App-Parser/Suche ignorieren das Kennzeichen.
- Ehrliche Rückmeldung: *Archivierung wird überprüft* (bis 20 s, „Nicht warten“ möglich) → *Archivierung erfolgreich* bzw. *An das Archiv übergeben – Bestätigung folgt* / *Archivierung ausstehend* / *Geparkt – noch nicht archiviert*.
- Hintergrundlauf beim Start (auch nach Absturz/Neustart/Update), jede Minute, bei Netzrückkehr und beim Zurückkehren in die App.
- Geparkte Vorgänge: nur eigene sichtbar, nie still gelöscht („überfällig“ ab 24 h), Löschen nur mit Rückfrage, Shop/Eigentümer vom Zeitpunkt des Parkens, versandbereite Altbestände werden beim Start mit Original-Eigentümer übernommen.
- „Meine Archivierungen“: Zeitfilter statt 300er-Grenze, zuerst unabhängig vom Shop (eigene uid), Rückfall je Shop, abwärtskompatible Normalisierung alter Einträge, neue Statusanzeigen inkl. Aktionen.
- Filialauswahl je Benutzer (`ps_shop_uid`).
- **Archiv-Diagnose (Admin, nur lesend)** in Meine Statistik → Archiv: Geräte-Zustand aller Benutzer (Ausgang, geparkt, wartende Index-Einträge, Fehler, Protokoll), Suchindex-Analyse (ohne/unbekannte Mitarbeiter-ID, ohne/unbekannter Shop, fehlerhafte Zeitstempel, alte kollisionsgefährdete Namen, „keinName“), SharePoint-Abgleich (Index ohne PDF, PDF ohne Index), JSON-Export. Keine automatische Neuzuordnung, nichts wird gelöscht.

## 4. Power Automate

Keine Änderung zwingend nötig. Payload und Betreff unverändert, nur der Dateiname enthält zusätzlich `--Kennzeichen` in Teil [1].

Empfohlen (nicht umgesetzt, Flows unverändert):

| Flow | Schritt | Problem | Änderung | Request | Response | Auswirkung |
|---|---|---|---|---|---|---|
| Archiv-Flow (HTTP, `…6e4980d3…`) | Trigger/Antwort | Antwort per `no-cors` unlesbar | Aktion „Antwort“ mit Header `Access-Control-Allow-Origin: *`, Body `{ok:true, archiveFileName}` | unverändert | `200 {ok:true}` | App könnte Übergabefehler sofort erkennen; Bestätigung bleibt über `exists` |
| Ablage-Flow (Mail-Trigger) | „Datei erstellen“ | Verhalten bei vorhandenem Namen unbekannt | Bei vorhandener Datei nicht überschreiben, sondern Suffix anhängen + Fehlerprotokoll | – | – | Schutz für Alt-Clients ohne Kennzeichen |
| Ablage-Flow | Dateiname zerlegen | falls der Flow Teil [1] (Kennung) weiterverarbeitet (z. B. Index-Liste „Angebotsindex“) | `--…` am Ende von Teil [1] abschneiden | – | – | nur Darstellung |

Firestore (Projekt `o2-pencil-selling`): zusammengesetzter Index `pdf_index (uid ↑, ts ↑)` und `pdf_index (shopId ↑, uid ↑, ts ↑)` anlegen. Ohne Index arbeitet die App mit Rückfall (alle Einträge des Mitarbeiters, max. 5000) weiter.

## 5. Bestehende Archivierungen

Alle bisherigen Dateien und Index-Einträge bleiben unverändert und sichtbar (alte Namen werden weiter erkannt). Bereits **überschriebene** Archivierungen lassen sich aus der App heraus nicht zurückholen: Die Index-Einträge zeigen den letzten Archivierer; die frühere PDF existiert nur noch, falls SharePoint-Versionierung aktiv ist (SharePoint → Datei → Versionsverlauf). Kandidaten liefert die Archiv-Diagnose („Alte Dateinamen“, „keinName“). Vor dem Update geparkte, bereits gelöschte (> 24 h) Vorgänge sind nicht wiederherstellbar.

## 6. Tests

Siehe `tests/archive/archive-queue.test.mjs`, `tests/e2e/archive-flow.test.mjs`, `tests/e2e/archive-ui.test.mjs` und `docs/TEST-REPORT.md` (Abschnitt Archivierung).

## 7. Live-Rollout (27.11.2026)

| Repo / Datei | Vorher | Nachher | Hinweise |
|---|---|---|---|
| `PS-Dashboard/index.html` (o2, alle Shops außer Hall) | 55.168 | 55.169 | Archiv-Ausgang, eindeutige Namen, Bestätigung über `exists`, Diagnose |
| `PS-Dashboard/index-neu.html` (o2, Hall-Test) | 56.0-beta.5 | 56.0-beta.6 | wie oben |
| `PS-Dashboard-Telekom/index.html` (Fachhandel) | 57.8 | 57.9 | wie oben, angepasst an das Telekom-Namensschema |

Backup-Branch in beiden Live-Repos: `backup/vor-archiv-fix-20261127`. `archive-queue.js` liegt jeweils im Repo-Wurzelordner.

**Telekom-Besonderheiten**
- Namensschema `PENCIL_[Shop]_[Typ]_[Datum]_[Kennung].pdf` → das Kennzeichen hängt an der Kennung (letzter Teil):
  `PENCIL_Fh-Ellwangen_Angebot_2026-11-27_Schmidt--2317pfm.pdf`. Shop/Typ/Datum für den Flow unverändert.
- Vorher zusätzlich: Toast „✅ Archiviert.“ auch bei fehlgeschlagenem Versand, kein Parken bei Fehlern (Vorgang nach dem
  Neustart verloren), kein Zeitlimit, Mitarbeitername aus dem beim Seitenstart gemerkten Namen (geteiltes Tablet:
  Name des Vormitarbeiters im Betreff). Behoben.
- Der Telekom-Prüfflow „PDF Archiv API V3 Telekom“ kennt die Aktion `exists` noch nicht (`PS_ARCH_EXISTS_AKTIV = false`).
  Archivierungen erscheinen deshalb als **„An das Archiv übergeben“** (ehrlich, aber ohne SharePoint-Bestätigung) und
  werden nicht automatisch erneut gesendet. Sobald der Telekom-Flow die Aktion `exists` wie der o2-Flow beherrscht,
  `PS_ARCH_EXISTS_AKTIV = true` setzen – dann gilt dieselbe Bestätigung wie bei o2 (mit diesem Schalter getestet).
- Filialauswahl je Benutzer: meldet sich ein anderer Mitarbeiter an, gilt seine Profil-Filiale (einmaliger Neustart).
