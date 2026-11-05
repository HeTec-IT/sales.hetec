<?php
declare(strict_types=1);

// Einrichtungs-Check: GET /api/health.php  (zeigt nur ja/nein und Anzahlen, keine Geheimnisse)
require __DIR__ . '/lib/App.php';

ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

try {
    $app = new PS\App();
    echo json_encode($app->health());
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['ok' => false, 'config' => false, 'message' => $e instanceof PS\ApiError ? $e->getMessage() : 'Nicht eingerichtet.']);
}
