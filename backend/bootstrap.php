<?php
declare(strict_types=1);

/**
 * Gemeinsamer Einstieg für Web (public/api/index.php) und Kommandozeile (bin/*.php).
 * $appRoot = Verzeichnis dieses Backends (enthält src/, vendor/, migrations/, config/).
 */

if (PHP_VERSION_ID < 80200) {
    http_response_code(500);
    exit('PHP 8.2 oder neuer erforderlich');
}

$appRoot = getenv('PS_APP_ROOT') ?: __DIR__;
require $appRoot . '/autoload.php';

ini_set('display_errors', '0');
ini_set('log_errors', '1');
date_default_timezone_set('UTC');
mb_internal_encoding('UTF-8');

return static function () use ($appRoot): \HeTec\PS\App {
    $config = \HeTec\PS\Config::load($appRoot);
    return new \HeTec\PS\App($config, $appRoot);
};
