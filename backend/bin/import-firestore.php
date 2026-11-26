<?php
declare(strict_types=1);

/**
 * Firestore-Export in die SQL-Datenbank übernehmen.
 *   php bin/import-firestore.php export.json --dry-run          Testlauf (nichts wird gespeichert), Bericht
 *   php bin/import-firestore.php export.json                    Übernahme (wiederholbar, keine Dubletten)
 *   php bin/import-firestore.php --rollback=<Lauf-ID>           Übernahme eines Laufs zurücknehmen
 *   php bin/import-firestore.php --list                         Läufe anzeigen
 * Den Export erzeugt tools/firestore-export/ (im Browser, mit Admin-Anmeldung im bisherigen System).
 * ACHTUNG: Echte Daten erst nach Freigabe der neuen Infrastruktur übernehmen (docs/FIREBASE-MIGRATION.md).
 */
if (PHP_SAPI !== 'cli') {
    exit(1);
}
$factory = require __DIR__ . '/../bootstrap.php';
$app = $factory();
// eigene Auswertung (getopt bricht beim ersten Nicht-Optionsargument ab)
$opts = [];
$file = null;
foreach (array_slice($argv, 1) as $a) {
    if (preg_match('/^--([a-z-]+)(?:=(.*))?$/', $a, $m)) {
        $opts[$m[1]] = $m[2] ?? true;
    } elseif ($a !== '') {
        $file = $a;
    }
}
$importer = new \HeTec\PS\Migration\FirestoreImporter($app->db, $app->crypto, array_values(array_filter(array_merge(
    $app->config->bootstrapSuperAdmins(),
    isset($opts['super-admin']) ? (array) $opts['super-admin'] : []
))));
if (isset($opts['list'])) {
    foreach ($app->db->all('SELECT id, source, started_at, finished_at, dry_run, rolled_back_at FROM import_batches ORDER BY started_at') as $b) {
        echo implode("\t", array_map('strval', $b)), PHP_EOL;
    }
    exit(0);
}
if (isset($opts['rollback'])) {
    try {
        $res = $importer->rollback((string) $opts['rollback']);
    } catch (\RuntimeException $e) {
        fwrite(STDERR, $e->getMessage() . PHP_EOL);
        exit(1);
    }
    $app->audit->log(null, 'firestore_import_rollback', 'import', (string) $opts['rollback'], null, $res);
    echo json_encode(['rolledBack' => $opts['rollback'], 'deleted' => $res], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), PHP_EOL;
    exit(0);
}
if (!$file || !is_file($file)) {
    fwrite(STDERR, "Export-Datei angeben (siehe Kopf dieser Datei)\n");
    exit(2);
}
$export = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($export) || !isset($export['collections'])) {
    fwrite(STDERR, "Keine gültige Exportdatei (collections fehlt)\n");
    exit(2);
}
$res = $importer->run($export, isset($opts['dry-run']));
if (!isset($opts['dry-run'])) {
    $app->audit->log(null, 'firestore_import', 'import', $res['batch'], null, ['report' => $res['report']]);
}
echo json_encode($res, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), PHP_EOL;
