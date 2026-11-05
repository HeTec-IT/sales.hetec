/* Pencil Selling – Einstellungen für Login (Microsoft Entra) und Datenschnittstelle.
   Diese Werte sind KEINE Geheimnisse (stehen in jeder Anmelde-URL). Passwörter,
   Schlüssel und Verbindungszeichenfolgen gehören NIE hierher, sondern nur in
   dem Server in api/config.php (nur per SFTP hochladen). */
window.PS_CONFIG = {
  tenantId: 'TENANT-ID-EINTRAGEN',   // Entra: Übersicht > Verzeichnis-ID (Mandant)
  clientId: 'CLIENT-ID-EINTRAGEN',   // Entra: App-Registrierung > Anwendungs-ID (Client)
  apiBase: '/api'                    // PHP-Schnittstelle liegt unter /api (api/db.php)
};
