<?php
/**
 * Konfiguration der LOKALEN Entwicklungsumgebung. Keine echten Zugangsdaten.
 * Schlüssel werden beim ersten Start von scripts/dev.mjs erzeugt und in backend/dev/.dev-keys.json abgelegt
 * (nicht im Repository).
 */
$keysFile = __DIR__ . '/.dev-keys.json';
if (!is_file($keysFile)) {
    file_put_contents($keysFile, json_encode([
        'data_key' => base64_encode(random_bytes(32)),
        'index_key' => base64_encode(random_bytes(32)),
    ]));
}
$keys = json_decode((string) file_get_contents($keysFile), true);
$port = getenv('PS_DEV_PORT') ?: '8080';
$app = 'http://127.0.0.1:' . $port;
return [
    'env' => 'development',
    'app_url' => $app,
    'allowed_origins' => [$app, 'http://localhost:' . $port],
    'db' => [
        'dsn' => getenv('PS_DB_DSN') ?: 'mysql:host=127.0.0.1;port=3306;dbname=pencil_dev;charset=utf8mb4',
        'user' => getenv('PS_DB_USER') ?: 'pencil_dev',
        'password' => getenv('PS_DB_PASSWORD') ?: 'pencil_dev',
    ],
    'entra' => [
        // Synthetischer Tenant für Dev/Mock – KEIN echter Microsoft-Tenant
        'tenant_id' => '11111111-2222-4333-8444-555555555555',
        'client_id' => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'client_secret' => 'dev-mock-secret',
        'redirect_uri' => $app . '/api/v1/auth/callback',
        'post_logout_redirect_uri' => $app . '/',
        'allowed_domains' => ['hetec-gmbh.de'],
        'reject_guests' => true,
        // Mock-Identitätsanbieter (tests/mock-entra/server.mjs); leer = Dev-Login-Seite verwenden
        'authority_override' => getenv('PS_MOCK_AUTHORITY') ?: '',
    ],
    'data_key' => $keys['data_key'],
    'index_key' => $keys['index_key'],
    'session' => ['cookie_name' => 'ps_sid_dev', 'idle_minutes' => 480, 'absolute_hours' => 12, 'offline_grace_hours' => 12],
    'bootstrap_super_admins' => [],
    'storage_dir' => getenv('PS_STORAGE_DIR') ?: __DIR__ . '/.storage',
    'archive_flow' => ['url' => getenv('PS_ARCHIVE_FLOW_URL') ?: '', 'shared_secret' => getenv('PS_ARCHIVE_FLOW_SECRET') ?: ''],
    'allow_web_migrations' => false,
];
