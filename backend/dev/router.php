<?php
declare(strict_types=1);

/**
 * Router für den eingebauten PHP-Webserver (nur lokale Entwicklung):
 *   php -S 127.0.0.1:8080 -t <frontend-root> backend/dev/router.php
 * /api/* → HeTec-API, alles andere → statische Datei aus dem Frontend-Verzeichnis.
 * Setzt dieselben Sicherheits-/Cache-Header wie die .htaccess auf dem Hosting.
 */
$uri = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (str_starts_with($uri, '/api/')) {
    putenv('PS_APP_ROOT=' . dirname(__DIR__));
    require dirname(__DIR__) . '/public/api/index.php';
    return true;
}
$root = (string) ($_SERVER['DOCUMENT_ROOT'] ?? getcwd());
// Lokale Entwicklung im Zielmodus: Laufzeitkonfiguration auf das HeTec-Backend umstellen (Repository-Datei bleibt 'firebase').
if ($uri === '/frontend/config/app-config.js' && getenv('PS_FRONTEND_BACKEND') === 'hetec') {
    header('Content-Type: text/javascript; charset=utf-8');
    header('Cache-Control: no-cache');
    echo "window.PS_CONFIG = Object.freeze({ backend: 'hetec', apiBase: 'api/v1', allowExternalTranslation: false, allowExternalQr: false, iosServiceWorker: true });\n";
    return true;
}
$file = realpath($root . $uri);
if ($file !== false && is_dir($file) && is_file($file . '/index.html')) {
    $file = $file . '/index.html';
} elseif ($uri === '/' || $file === false || is_dir($file)) {
    $file = realpath($root . '/index.html');
}
if ($file === false || !str_starts_with($file, realpath($root) . DIRECTORY_SEPARATOR) || !is_file($file)) {
    http_response_code(404);
    return true;
}
$types = [
    'html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'mjs' => 'text/javascript; charset=utf-8',
    'css' => 'text/css; charset=utf-8', 'json' => 'application/json; charset=utf-8', 'webmanifest' => 'application/manifest+json',
    'wasm' => 'application/wasm', 'png' => 'image/png', 'svg' => 'image/svg+xml', 'tar' => 'application/x-tar',
    'woff2' => 'font/woff2', 'onnx' => 'application/octet-stream', 'traineddata' => 'application/octet-stream', 'gz' => 'application/gzip',
];
$ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
header('Content-Type: ' . ($types[$ext] ?? 'application/octet-stream'));
header('X-Content-Type-Options: nosniff');
if (in_array(basename($file), ['index.html', 'sw.js', 'version.json'], true)) {
    header('Cache-Control: no-cache');
}
$csp = getenv('PS_DEV_CSP');
if ($ext === 'html' && $csp) {
    header('Content-Security-Policy: ' . $csp);
}
readfile($file);
return true;
