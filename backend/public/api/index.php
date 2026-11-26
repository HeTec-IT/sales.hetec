<?php
declare(strict_types=1);

/**
 * Öffentlicher Einstieg der HeTec-API: https://ps.hetec.de/api/...
 * Liegt im Webroot. Der eigentliche Code (app/) und die Konfiguration (config/) liegen AUSSERHALB.
 * Pfad zum Backend: Umgebungsvariable PS_APP_ROOT oder Datei ../../app-path.php (vom Release-Build erzeugt).
 */

$appRoot = getenv('PS_APP_ROOT');
if (!$appRoot) {
    $pathFile = __DIR__ . '/../../app-path.php';
    $appRoot = is_file($pathFile) ? (require $pathFile) : dirname(__DIR__, 2);
}
putenv('PS_APP_ROOT=' . $appRoot);

$factory = require $appRoot . '/bootstrap.php';
try {
    $app = $factory();
} catch (\Throwable $e) {
    error_log('[HeTec API] Start fehlgeschlagen: ' . $e->getMessage());
    http_response_code(503);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo '{"ok":false,"error":"service_unavailable"}';
    exit;
}
$app->handle(\HeTec\PS\Http\Request::fromGlobals('/api'))->send();
