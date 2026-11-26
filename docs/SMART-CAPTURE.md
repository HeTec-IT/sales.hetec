# Smart Capture – QR-Import (Branch `feature/hetec-smart-capture`)

Neuer Importweg im Smart-Scan-Dialog („o2-Vorschlag einlesen“). Der o2-Vorschlag wird am Shop-PC per Screenshot in
**HeTec Smart Capture** (eigene Browser-App, Repository `HeTec-IT/HeTec-IT-Smart-Capture-`) erkannt; das Tablet scannt nur
noch den QR-Code. Keine OCR auf dem Tablet.

Importmöglichkeiten im Dialog:
1. **Smart Capture – QR-Code scannen** (neu)
2. **Angebot fotografieren** (bisherige Foto-OCR, unverändert)
3. **Datei importieren** (bisheriger Upload, unverändert)

## Ablauf nach dem Scan

QR erkennen (BarcodeDetector, sonst jsQR – selbst gehostet) → Protokollkennung `HSC1` → Schemaversion → Ablauf (2 Minuten,
5 Minuten Uhrzeit-Toleranz) → Prüfsumme → Nutzlast dekodieren → vollständige Validierung (Allowlist, Typen, Grenzen,
personenbezogene Daten) → Anzeige im bestehenden Prüfdialog → **Mitarbeiter bestätigt** („Angebot übernehmen“) → bestehende
Übernahme `applyO2Proposal` (Angebotskarten, Preisleiste, Preisberechnung). Keine Änderung an Preisberechnung, PDF, Signatur,
Archivierung, Autosave, Pausieren, Benutzerverwaltung, Aktionskarten-Knopf, mehreren Tarifen/Smartphones, Internet@Home.

- Vorhandene Angaben im Dialog → Rückfrage **Angebot ergänzen / Angebot ersetzen / Import abbrechen**.
- Doppelte Übernahme derselben Angebots-ID + Version wird verhindert (`localStorage` `ps_hsc_imported`: nur zufällige ID + Zeit, 24 h).
- Mehrfach-QR: Scanner bleibt offen und sammelt alle Teile; nie Teilimport.
- Kamera wird nach dem Scan, bei Abbruch/Escape, beim Wechsel in den Hintergrund und beim Verlassen sofort gestoppt.
- Zusatzprodukte und Preisänderungen („Ab dem 25. Monat …“) erscheinen als Hinweis auf der Angebotskarte.

## Dateien

| Datei | Änderung |
|---|---|
| `frontend/smart-scan/hsc-protocol.js` | neu – gemeinsames Protokoll (byte-identisch mit Smart Capture) |
| `frontend/smart-scan/hsc-import.js` | neu – Scanner, Umwandlung ins interne Datenmodell, Ergänzen, Duplikatschutz |
| `frontend/smart-scan/ui-dialog.js` | Importknopf, Rückfrage Ergänzen/Ersetzen/Abbrechen, Duplikatschutz bei „Angebot übernehmen“ |
| `index.html` | zwei `<script>`-Zeilen |
| `tests/smart-capture/*` | Protokoll-/Importtests + gemeinsame Testvektoren |
| `tests/e2e/smart-capture-qr.test.mjs` | Browser-Test mit Kamera-Attrappe (QR-Video) |

Protokoll: `HeTec-IT-Smart-Capture-/docs/PROTOCOL.md`.

## Rücknahme

Branch nicht mergen bzw. Merge-Commit per `git revert -m 1 <merge>` zurücknehmen. Die beiden `<script>`-Zeilen in `index.html`
entfernen genügt ebenfalls, um den Importweg abzuschalten (ui-dialog.js prüft nichts anderes).
