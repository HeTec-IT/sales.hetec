/*
 * Pencil Selling – Laufzeitkonfiguration.
 *
 * Diese Datei wird beim Release-Build (scripts/build-release.mjs) für das Zielsystem überschrieben:
 *   backend: 'hetec'     → eigenes HeTec-Backend (PHP/MariaDB, Microsoft-Anmeldung). Kein Google, kein Firebase.
 *   backend: 'firebase'  → bisheriger Betrieb auf GitHub Pages (nur Migrationsadapter, wird nach der Migration entfernt).
 *
 * Im Repository steht 'firebase', damit die laufende Beta auf GitHub Pages unverändert weiterarbeitet.
 */
window.PS_CONFIG = Object.freeze({
  backend: 'firebase',
  apiBase: 'api/v1',
  // Externe Dienste, die vertrauliche Daten erhalten könnten, sind im HeTec-Betrieb gesperrt.
  // (Übersetzung von Freitext über mymemory.translated.net, QR-Bilder über api.qrserver.com)
  allowExternalTranslation: true,
  allowExternalQr: true,
  // Service Worker auch auf iPad/iPhone (Offline-Betrieb). Bisher bewusst aus (start_url-Problem mit ?agent=…);
  // im HeTec-Betrieb kommt die Identität aus der Sitzung, nicht aus der URL.
  iosServiceWorker: false
});
