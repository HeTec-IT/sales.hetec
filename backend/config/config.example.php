<?php
/**
 * HeTec Backend Core – Konfigurationsvorlage.
 *
 * Kopieren nach  config/config.php  (AUSSERHALB des Webroots!) und Platzhalter ersetzen.
 * Diese Datei enthält KEINE echten Zugangsdaten und darf ins Repository.
 * config.php ist in .gitignore eingetragen und darf NIE ins Repository.
 *
 * Alternativ können alle Werte über Umgebungsvariablen gesetzt werden (siehe Config::fromEnv),
 * z. B. für die lokale Entwicklung.
 */
return [
    // 'production' | 'staging' | 'development'
    // Test-Anmeldung (Dev-Login) funktioniert ausschließlich mit 'development' UND nur, wenn
    // das Verzeichnis backend/dev/ vorhanden ist – im Release-Artefakt fehlt es vollständig.
    'env' => 'production',

    // Öffentliche Basis-URL der Anwendung (ohne abschließenden Schrägstrich)
    'app_url' => 'https://ps.hetec.de',

    // Erlaubte Origins für Browser-Anfragen an die API (gleiche Domain reicht im Normalfall)
    'allowed_origins' => ['https://ps.hetec.de'],

    'db' => [
        'dsn'      => 'mysql:host=localhost;port=3306;dbname=PLATZHALTER_DB;charset=utf8mb4',
        'user'     => 'PLATZHALTER_DB_USER',
        'password' => 'PLATZHALTER_DB_PASSWORT',
    ],

    // Microsoft Entra ID (Single-Tenant). Werte aus der App-Registrierung (siehe docs/MICROSOFT-ENTRA-SETUP.md).
    'entra' => [
        'tenant_id'      => '00000000-0000-0000-0000-000000000000',   // Verzeichnis-(Tenant-)ID
        'client_id'      => '00000000-0000-0000-0000-000000000000',   // Anwendungs-(Client-)ID
        'client_secret'  => 'PLATZHALTER_CLIENT_SECRET',             // Geheimer Clientschlüssel (nur serverseitig!)
        'redirect_uri'   => 'https://ps.hetec.de/api/v1/auth/callback',
        'post_logout_redirect_uri' => 'https://ps.hetec.de/',
        // Erlaubte E-Mail-/UPN-Domain (zusätzlich zur Tenant-Prüfung, nicht stattdessen)
        'allowed_domains' => ['hetec-gmbh.de'],
        // Gastkonten (B2B) ablehnen
        'reject_guests'  => true,
        // Nur für Tests: abweichende Authority (Mock-Provider). In Produktion leer lassen.
        'authority_override' => '',
    ],

    // Schlüssel für die Verschlüsselung von Kundendaten in der DB (libsodium secretbox, 32 Byte, base64).
    // Erzeugen:  php -r "echo base64_encode(random_bytes(32)), PHP_EOL;"
    // Verlust = gespeicherte Angebote nicht mehr lesbar → sicher aufbewahren (Passwort-Tresor).
    'data_key' => 'PLATZHALTER_BASE64_32_BYTE',

    // Schlüssel für Suchindex-HMAC und IP-Hashing (32 Byte, base64), getrennt vom data_key.
    'index_key' => 'PLATZHALTER_BASE64_32_BYTE',

    'session' => [
        'cookie_name'        => '__Host-ps_sid',
        'idle_minutes'       => 480,   // 8 h ohne Aktivität → abgemeldet (geteilte Shop-Tablets)
        'absolute_hours'     => 12,    // spätestens nach 12 h neu anmelden
        'offline_grace_hours'=> 12,    // so lange darf die App ohne Serverkontakt mit dem letzten Profil weiterarbeiten
    ],

    // Bootstrap: diese E-Mail-Adressen werden bei der ERSTEN Anmeldung automatisch Hauptadministrator.
    // Danach hier wieder leeren (siehe docs/AUTHENTICATION.md).
    'bootstrap_super_admins' => [],

    'storage_dir' => __DIR__ . '/../storage',

    // Optional: Weiterleitung der Archivsuche an den Power-Automate-Flow (serverseitig, mit Geheimnis).
    'archive_flow' => [
        'url'           => '',   // HTTP-Trigger-URL des Flows (enthält eine Signatur → geheim halten)
        'shared_secret' => '',   // wird als Header X-HeTec-Flow-Secret mitgeschickt; der Flow prüft ihn
    ],

    // Datenbank-Migrationen über die Web-Oberfläche erlauben (nur wenn kein SSH vorhanden ist).
    // Nach der Migration wieder auf false setzen.
    'allow_web_migrations' => false,
];
