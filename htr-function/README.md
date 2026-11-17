# Handschrift zu Text – Einrichtung (einmalig)

Die App schickt die Handschrift eines Notiz-Feldes als Bild an diese Funktion. Sie prüft den Login, fragt Gemini
auf Vertex AI (EU-Endpunkt) und gibt den Text zurück. Es wird nichts gespeichert, kein Inhalt geloggt.

1. Firebase-Projekt `o2-pencil-selling` auf **Blaze** (Pay-as-you-go) stellen. Kosten: ca. 0,1–0,3 Cent je Erkennung.
2. Google Cloud Shell öffnen (console.cloud.google.com, Symbol `>_` oben rechts) und ausführen:
   `git clone https://github.com/HeTec-IT/Sales.HeTec && cd Sales.HeTec/htr-function && bash deploy.sh`
3. In der App: Notiz-Fenster → Stift → **Als Text**.

Einstellungen (Umgebungsvariablen, bei `deploy.sh`): `HTR_MODEL` (Standard `gemini-3.5-flash`), `HTR_LOCATION`
(Standard `eu`). Meldet die Funktion Fehler 502, prüfen, ob Modell und Region in Vertex AI verfügbar sind
(Cloud Console → Vertex AI → Model Garden), und `deploy.sh` mit anderem `HTR_MODEL` / `HTR_LOCATION` erneut starten.

Telekom-Edition: dieselbe Funktion akzeptiert auch Logins aus `pencil-selling-telekom`.
Schutz vor Missbrauch: nur angemeldete Benutzer, 40 Anfragen/Minute je Benutzer, höchstens 5 Instanzen.
Empfehlung: in der Google Cloud Console ein Budget-Limit mit E-Mail-Warnung setzen.
