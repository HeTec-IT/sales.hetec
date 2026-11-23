# Tests – o2-Vorschlag einlesen (OCR)

Die App hat keinen Build. Die Tests laden den OCR-/Dialog-Teil direkt aus `index.html`.

## 1. Unit-Tests (nur Node ≥ 20, keine Abhängigkeiten, ca. 1 Minute)

    node --test tests/ocr/*.test.mjs

* `parser.test.mjs` – Beleg-Auswertung (Handy + 2 gleiche Tarife, Summen 2.468,98 € / 69,98 €), Schreibweisen, Summenprüfung,
  Meldungen („kein Text“, „Text ohne Zuordnung“, „teilweise“, „Kontrolle nötig“, technische Fehler), Zusammenführen mehrerer Durchgänge.
* `engine.test.mjs` – Ablauf der Erkennung mit Attrappen für Tesseract: Wiederverwendung des Arbeiters, hängender Arbeiter (Timeout,
  wirklich beendet, Neuaufbau), Abbruch durch den Benutzer, neue Aufnahme überholt alte, Ergebnis bleibt nach Timeout erhalten,
  Foto nicht lesbar, Texterkennung nicht startbar, Rauschen, Speicher-Freigabe.
* `offer.test.mjs` – (v55.225) Angebot B (Internet + Handy + Tarif mit Plus-Rabatt, 2.438,98 € / 69,98 €, „Ersparnis“ ist keine Position,
  Rabatt nicht doppelt), Angebotskennzeichen (Beratungs-ID / Erstellzeit), Preise nur ergänzen, Dienst-Anfrage mit Attrappe für `fetch`:
  Zeitlimit, Abbruch durch den Benutzer, verspätete Antwort, Dienstfehler, fehlende Anmeldung.

## 2. Browser-Test mit echter Texterkennung (optional, braucht ein eigenes Testfoto)

Das Testfoto (Monitorfoto eines Vorschlags mit Handy + 2 gleichen Tarifen, 2.468,98 € / 69,98 €) gehört **nicht** ins Repo.

    npm i --no-save tesseract.js@5.1.1 @tesseract.js-data/deu react@18.3.1 react-dom@18.3.1
    pip install playwright pillow numpy
    BELEG_FOTO=/pfad/zum/foto.jpg python3 tests/e2e/ui_scenarios.py      # optional CHROME=/pfad/zu/chrome

Erzeugt aus dem Foto Problemfotos (Verlauf, Spiegelung, Unschärfe, JPEG-Kompression, schief, halb, Rauschen, leer, kaputte Datei)
und spielt sie durch den echten Dialog `PsO2Import`: Ergebnis, Meldungen, Dauer, Abbrechen, mehrere Fotos nacheinander.

## 3. Browser-Test mit Attrappe für den Cloud-Dienst (ohne Foto, ohne Kundendaten)

    npm i --no-save tesseract.js@5.1.1 @tesseract.js-data/deu react@18.3.1 react-dom@18.3.1
    python3 tests/e2e/ui_cloud.py

Spielt Angebot A/B, Teilerfolg, zwei Fotos desselben Angebots, anderes Angebot (Rückfrage: ersetzen / zusammenführen / verwerfen),
abweichende Gesamtkosten, Dienst-Timeout, Abbrechen (Anfrage wird abgebrochen), verspätete Antwort und zwei schnelle Fotos durch den
echten Dialog. Die Dienstantworten sind erfundene Beispieldaten.
