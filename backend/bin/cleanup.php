<?php
declare(strict_types=1);

// Löschkonzept ausführen (Cronjob, z. B. stündlich):  php bin/cleanup.php
if (PHP_SAPI !== 'cli') {
    exit(1);
}
$factory = require __DIR__ . '/../bootstrap.php';
$app = $factory();
$res = (new \HeTec\PS\Maintenance($app))->run();
$app->audit->log(null, 'cleanup_run', 'system', '', null, $res);
echo json_encode($res), PHP_EOL;
