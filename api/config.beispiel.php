<?php
// Vorlage: Kopie als "config.php" im selben Ordner (api/) anlegen und ausfuellen.
// Die Datei config.php enthaelt das Datenbank-Passwort - NICHT in GitHub einchecken
// (steht in .gitignore) und nur per SFTP hochladen.
return [
    // Microsoft Entra (Azure): Verzeichnis-ID (Tenant) und Anwendungs-ID (Client) der App-Registrierung.
    // Beide Werte sind keine Geheimnisse; dieselben stehen auch in ps-config.js.
    'tenant_id' => 'TENANT-ID-EINTRAGEN',
    'client_id' => 'CLIENT-ID-EINTRAGEN',

    // Nur E-Mail-Adressen dieser Domain duerfen rein.
    'allowed_domain' => 'hetec-gmbh.de',

    // Optional: Notfall-Admins per E-Mail (zusaetzlich zur Gruppe PS-Admin).
    'admin_emails' => [],

    // Objekt-IDs der Entra-Gruppen (Azure-Portal > Gruppen > Objekt-ID).
    'groups' => [
        'admin'    => [],   // PS-Admin
        'regional' => [],   // PS-Regional
        'springer' => [],   // PS-Springer
        // Gruppen-ID => Standort-Kennung (Kennungen wie in der App):
        'shops' => [
            // 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' => 'aalen',
            // 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' => 'schwaebisch-hall',
        ],
    ],

    // MySQL/MariaDB bei Hetzner (konsoleH > Datenbanken).
    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'DATENBANKNAME',
        'user' => 'DATENBANKBENUTZER',
        'pass' => 'PASSWORT',
    ],
];
