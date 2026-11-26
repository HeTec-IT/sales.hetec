<?php
declare(strict_types=1);

/**
 * Autoloader ohne Composer-Laufzeitpflicht. Die drei Bibliotheken liegen versioniert unter third_party/
 * (Quelle: GitHub-Tags, Lizenzen beiliegend, siehe docs/SECURITY.md → Abhängigkeiten).
 * Composer (composer.json) erzeugt auf Wunsch dasselbe Ergebnis in vendor/.
 */
(static function (): void {
    $base = __DIR__;
    $map = [
        'HeTec\\PS\\' => $base . '/src/',
        'phpseclib3\\' => $base . '/third_party/phpseclib/phpseclib/',
        'ParagonIE\\ConstantTime\\' => $base . '/third_party/constant_time_encoding/src/',
    ];
    spl_autoload_register(static function (string $class) use ($map, $base): void {
        if ($class === 'Jumbojett\\OpenIDConnectClient' || $class === 'Jumbojett\\OpenIDConnectClientException') {
            require_once $base . '/third_party/openid-connect-php/src/OpenIDConnectClient.php';
            return;
        }
        foreach ($map as $prefix => $dir) {
            if (str_starts_with($class, $prefix)) {
                $file = $dir . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
                if (is_file($file)) {
                    require_once $file;
                }
                return;
            }
        }
    });
    require_once $base . '/third_party/phpseclib/phpseclib/bootstrap.php';
})();
