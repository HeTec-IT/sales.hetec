<?php
declare(strict_types=1);

// Löscht ALLE Tabellen der Entwicklungs-/Testdatenbank (nur env=development, DB-Name *_dev oder *_test).
if (PHP_SAPI !== 'cli') {
    exit(1);
}
$factory = require __DIR__ . '/../bootstrap.php';
$app = $factory();
$dbName = (string) $app->db->scalar('SELECT DATABASE()');
if (!$app->config->isDevelopment() || !preg_match('/_(dev|test)$/', $dbName)) {
    fwrite(STDERR, "Verweigert: nur Entwicklungs-/Testdatenbanken (*_dev, *_test)\n");
    exit(1);
}
$pdo = $app->db->pdo();
$pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
foreach ($pdo->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN) as $t) {
    $pdo->exec('DROP TABLE IF EXISTS `' . str_replace('`', '', (string) $t) . '`');
}
$pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
echo "Datenbank $dbName geleert\n";
