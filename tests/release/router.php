<?php
declare(strict_types=1);
// Testserver für das RELEASE-Artefakt (php -S … -t release/…/public tests/release/router.php).
// Bildet die .htaccess nach: /api/* → api/index.php, CSP- und Sicherheitsheader aus public/.htaccess.
$pub = (string) $_SERVER['DOCUMENT_ROOT'];
$uri = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (str_starts_with($uri, '/api/')) {
    require $pub . '/api/index.php';
    return true;
}
$ht = (string) @file_get_contents($pub . '/.htaccess');
if (preg_match_all('/Header always set ([A-Za-z-]+) "((?:[^"\\\\]|\\\\.)*)"/', $ht, $m, PREG_SET_ORDER)) {
    foreach ($m as $h) {
        if ($h[1] === 'Strict-Transport-Security') continue;
        header($h[1] . ': ' . $h[2]);
    }
}
$file = realpath($pub . $uri);
if ($file !== false && is_dir($file) && is_file($file . '/index.html')) $file = $file . '/index.html';
elseif ($uri === '/' || $file === false || is_dir($file)) $file = realpath($pub . '/index.html');
if ($file === false || !str_starts_with($file, realpath($pub)) || !is_file($file) || preg_match('/(^|\/)\.|\.php$/', $uri)) { http_response_code(404); return true; }
$types = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript', 'mjs' => 'text/javascript', 'css' => 'text/css', 'json' => 'application/json',
  'webmanifest' => 'application/manifest+json', 'wasm' => 'application/wasm', 'png' => 'image/png', 'tar' => 'application/x-tar', 'gz' => 'application/gzip'];
header('Content-Type: ' . ($types[strtolower(pathinfo($file, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
if (in_array(basename($file), ['index.html', 'sw.js', 'sw-manifest.js', 'version.json', 'app-config.js', 'manifest.webmanifest'], true)) header('Cache-Control: no-cache');
readfile($file);
return true;
