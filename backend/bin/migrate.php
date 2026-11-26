<?php
declare(strict_types=1);

// Datenbankmigrationen ausführen:  php bin/migrate.php
if (PHP_SAPI !== 'cli') {
    exit(1);
}
$factory = require __DIR__ . '/../bootstrap.php';
$app = $factory();
$applied = (new \HeTec\PS\Migrator($app->db, $app->appRoot . '/migrations'))->run();
echo $applied ? 'Angewandt: ' . implode(', ', $applied) . PHP_EOL : 'Datenbank ist aktuell.' . PHP_EOL;
