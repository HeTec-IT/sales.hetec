<?php
declare(strict_types=1);

// Einzige Daten-Schnittstelle der App: POST /api/db.php (JSON). Login-Token im Header x-ps-token.
require __DIR__ . '/lib/App.php';

use PS\App;
use PS\ApiError;

ini_set('display_errors', '0');
ini_set('serialize_precision', '-1');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function ps_out(int $status, string $json): void
{
    http_response_code($status);
    echo $json;
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    ps_out(405, '{"ok":false,"code":"invalid-argument","message":"Nur POST."}');
}

try {
    $app = new App();
} catch (ApiError $e) {
    ps_out($e->status, json_encode(['ok' => false, 'code' => $e->errCode, 'message' => $e->getMessage()]));
} catch (Throwable $e) {
    error_log('PS: Start fehlgeschlagen: ' . $e->getMessage());
    ps_out(500, '{"ok":false,"code":"internal","message":"Interner Fehler."}');
}

$token = trim((string)($_SERVER['HTTP_X_PS_TOKEN'] ?? ''));
$raw = (string)file_get_contents('php://input');
[$status, $json] = $app->handle($token, $raw);
ps_out($status, $json);
