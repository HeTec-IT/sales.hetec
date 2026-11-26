# Firebase-Altlasten (nur bis zur Migration)

Dieses Verzeichnis enthält Teile, die ausschließlich zum bisherigen Google/Firebase-Betrieb gehören.
Sie sind **nicht** Teil des HeTec-Zielsystems und werden **nicht** in das Release-Artefakt übernommen.

| Inhalt | Zweck | Ersetzt durch | Entfernen |
|---|---|---|---|
| `htr-function/` | Google Cloud Function (Vertex AI/Gemini) für Handschrift und früher Angebotsfotos | Lokale OCR (frontend/smart-scan), lokale Handschrifthilfe; Cloud-Handschrifterkennung entfällt im HeTec-Betrieb | nach Abschaltung von Firebase löschen |

Die Firebase-Anbindung der App selbst liegt als Migrationsadapter in `frontend/services/adapter-firebase.js`.
