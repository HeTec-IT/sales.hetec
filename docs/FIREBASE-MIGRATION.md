# Firebase → HeTec-Datenbank: Migrationsprozess

> **Freigabe erforderlich.** Echte Daten erst exportieren/importieren, wenn das neue Hosting bereitsteht und die
> Übernahme ausdrücklich freigegeben ist. Firebase erst nach geprüfter Übernahme und gesonderter Freigabe abschalten.
> Bis dahin läuft die bisherige App unverändert weiter (Firebase-Adapter).

## Überblick

```
Firestore (o2-pencil-selling, verkaufsmappe-7d917)
   │ 1. Export im Browser mit Admin-Anmeldung: tools/firestore-export/index.html  → firestore-export-JJJJ-MM-TT.json
   ▼
Server (neues Hosting)
   │ 2. Testlauf:   php app/bin/import-firestore.php export.json --dry-run   → Bericht, nichts gespeichert
   │ 3. Übernahme:  php app/bin/import-firestore.php export.json             → Lauf-ID
   │ 4. Kontrolle:  Bericht + Stichproben (unten)
   │ (Rücknahme:    php app/bin/import-firestore.php --rollback=<Lauf-ID>)
   ▼
5. Mitarbeiter melden sich mit Microsoft an → Verknüpfung über eindeutige E-Mail
```

## Was wird wie übernommen

| Firestore | Ziel | Regeln |
|---|---|---|
| `users/{uid}` | `users`, `user_shops` | `legacy_firebase_uid = uid`; Rolle `admin` → Administrator (Bootstrap-E-Mail → Hauptadministrator), `verkaeufer` → Mitarbeiter; Status `approved`+`active` → freigegeben, `pending` → wartend, sonst gesperrt; Springer-/Shopwechsel-Felder → `all_shops`; Shop-Listen/-Maps → `user_shops` (nur bekannte Shops); ohne gültige E-Mail → übersprungen |
| `analytics/{id}` | `analytics_events` | ID bleibt (keine Dubletten); Benutzer über `userUid`, sonst eindeutigen Namen; nicht zuordenbar → bleibt ohne Benutzer erhalten (Historie) |
| `saved_offers/{id}` | `saved_offers` | verschlüsselt; älter als 30 Tage oder ohne gültigen Shop → nicht übernommen (Löschfrist) |
| `skip_limits/limit_*`, `skip_*_YYYY-MM` | `skip_limits`, `skip_counters` | Agentenname → eindeutiger Benutzer, sonst Bericht |
| `tool_usage/*` | `tool_usage` | wie oben |
| `news/{marke}` | `news` | max. 5 Einträge |
| `pdf_index/*` | `pdf_index`, `pdf_index_keys` | verschlüsselt, Suchschlüssel als HMAC |
| `aktionsmappe/global` (zweites Projekt) | `app_settings.aktionsmappe` | |
| `portierung_files` | – | nicht übernommen (24-h-Dateien) |
| Firebase-Passwörter | – | nicht übernommen (Microsoft-Anmeldung) |

## Zuordnung zu Microsoft-Konten (kontrolliert, eindeutig)

- Beim Import wird **keine** Microsoft-Identität gesetzt.
- Bei der ersten Microsoft-Anmeldung (Tenant geprüft, Domain geprüft) wird ein migrierter Benutzer verknüpft, wenn
  **genau ein** migrierter, noch unverknüpfter Datensatz dieselbe E-Mail hat. Danach zählt nur noch Tenant-ID + Object-ID.
- Mehrdeutig/keine Übereinstimmung → normales neues Konto „wartet auf Freigabe“; Admin bereinigt (Protokoll `entra_linked`).
- Strenger (optional): Die IT liefert Object-IDs; vor dem Import in die Exportdatei bzw. danach in `users.entra_object_id` eintragen.

## Kontrolle nach der Übernahme

```sql
SELECT status, role_id, COUNT(*) FROM users GROUP BY status, role_id;
SELECT COUNT(*), MIN(ts), MAX(ts) FROM analytics_events;
SELECT shop_id, result, COUNT(*) FROM analytics_events GROUP BY shop_id, result;   -- mit altem Admin-Dashboard vergleichen
SELECT COUNT(*) FROM analytics_events WHERE user_id IS NULL;                        -- nicht zuordenbare Zeilen
SELECT report FROM import_batches ORDER BY started_at DESC LIMIT 1;
```

Referenzintegrität erzwingt die DB (Fremdschlüssel). Ein zweiter Import derselben Datei ändert nichts (Bericht: `existing`).

## Test mit synthetischen Daten

`tests/migration/firestore-import.test.mjs` erzeugt einen künstlichen Export (keine echten Personen) und prüft
Testlauf, Übernahme, Rollen/Status/Shops, Dubletten, Verschlüsselung, Microsoft-Verknüpfung und Rücknahme.

## Abschalten von Firebase (erst nach Freigabe)

1. Neue App einige Tage parallel betreiben, Statistik vergleichen.
2. Letzten Delta-Export importieren (wiederholbar, nur Neues wird übernommen).
3. Live-Links der Shops auf `https://ps.hetec.de` umstellen.
4. Firestore-Regeln auf „nur lesen“, nach Frist Projekte löschen.
5. Code bereinigen: `frontend/services/adapter-firebase.js`, `download-page-firebase.js`, `tools/firestore-export/`,
   `legacy/firebase/` löschen; Eintrag `firebase` in `ps-backend.js` und die Skript-Tags in `index.html` entfernen.
