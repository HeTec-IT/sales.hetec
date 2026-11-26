<?php
declare(strict_types=1);

/**
 * Synthetische Testdaten für die lokale Entwicklung (KEINE echten Personen/Kunden).
 *   php backend/dev/seed.php
 * Legt Testbenutzer aller Rollen, Shop-Zuordnungen, Statistikzeilen und News an. Idempotent.
 */
if (PHP_SAPI !== 'cli') {
    exit(1);
}
$factory = require __DIR__ . '/../bootstrap.php';
$app = $factory();
if (!$app->config->isDevelopment()) {
    fwrite(STDERR, "Seed nur mit env=development erlaubt\n");
    exit(1);
}
$db = $app->db;
$tenant = strtolower((string) $app->config->entra()['tenant_id']);

$users = [
    // email, name, role, status, home, extra, allShops
    ['test.haupt.admin@hetec-gmbh.de', 'Haupt Admin', 'super_admin', 'approved', null, [], 1],
    ['test.anna.admin@hetec-gmbh.de', 'Anna Admin', 'admin', 'approved', null, [], 1],
    ['test.fritz.betreuer@hetec-gmbh.de', 'Fritz Betreuer', 'filialbetreuer', 'approved', 'aalen', ['crailsheim', 'schwaebisch-hall'], 0],
    ['test.lena.leiterin@hetec-gmbh.de', 'Lena Leiterin', 'shop_leiter', 'approved', 'crailsheim', [], 0],
    ['test.max.verkauf@hetec-gmbh.de', 'Max Verkauf', 'mitarbeiter', 'approved', 'aalen', [], 0],
    ['test.mia.verkauf@hetec-gmbh.de', 'Mia Verkauf', 'mitarbeiter', 'approved', 'crailsheim', [], 0],
    ['test.sven.springer@hetec-gmbh.de', 'Sven Springer', 'mitarbeiter', 'approved', 'aalen', [], 1],
    ['test.tom.azubi@hetec-gmbh.de', 'Tom Azubi', 'azubi', 'approved', 'schwaebisch-hall', [], 0],
    ['test.neu.wartend@hetec-gmbh.de', 'Neu Wartend', 'mitarbeiter', 'pending', 'aalen', [], 0],
    ['test.gesperrt.konto@hetec-gmbh.de', 'Gesperrt Konto', 'mitarbeiter', 'blocked', 'aalen', [], 0],
];

foreach ($users as [$email, $name, $role, $status, $home, $extra, $all]) {
    $h = hash('sha256', 'dev-oid:' . $email);
    $oid = substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-4' . substr($h, 13, 3) . '-8' . substr($h, 17, 3) . '-' . substr($h, 20, 12);
    $existing = $app->users->findByEntra($tenant, $oid);
    [$vn, $nn] = explode(' ', $name, 2);
    if (!$existing) {
        $id = $app->users->createPending($tenant, $oid, ['email' => $email, 'display_name' => $name, 'vorname' => $vn, 'nachname' => $nn], $role, $status);
    } else {
        $id = (int) $existing['id'];
    }
    $db->exec('UPDATE users SET role_id = :r, status = :s, home_shop_id = :h, all_shops = :a, is_test_user = 1 WHERE id = :id',
        ['r' => $role, 's' => $status, 'h' => $home, 'a' => $all, 'id' => $id]);
    $app->users->setExtraShops($id, $extra);
}

// Synthetische Statistik: 60 Tage, zufällig, reproduzierbar (fester Seed)
mt_srand(42);
$ids = $db->all("SELECT id, display_name, home_shop_id FROM users WHERE email LIKE 'test.%' AND status = 'approved' AND home_shop_id IS NOT NULL");
$results = ['Angebot', 'Angebot', 'Anfrage', 'Abschluss', 'offen', 'Abgebrochen'];
$n = 0;
foreach ($ids as $u) {
    for ($d = 0; $d < 60; $d += mt_rand(1, 3)) {
        $id = 'seed_' . $u['id'] . '_' . $d;
        $ts = gmdate('Y-m-d H:i:s', time() - $d * 86400 - mt_rand(0, 36000));
        $res = $results[mt_rand(0, count($results) - 1)];
        $payload = json_encode(['id' => $id, 'ts' => str_replace(' ', 'T', $ts) . 'Z', 'user' => $u['display_name'], 'shopId' => $u['home_shop_id'],
            'result' => $res, 'beratungsId' => 'B' . mt_rand(1000, 9999), 'exempt' => false, 'canvasStats' => ['sit_Kundenname' => ['used' => true, 'strokes' => 0]]]);
        $db->exec('INSERT IGNORE INTO analytics_events (id, user_id, user_name, shop_id, shop_name, ts, result, beratungs_id, payload)
                   SELECT :id, :u, :un, s.id, s.name, :ts, :r, :b, :p FROM shops s WHERE s.id = :s',
            ['id' => $id, 'u' => $u['id'], 'un' => $u['display_name'], 's' => $u['home_shop_id'], 'ts' => $ts, 'r' => $res, 'b' => 'B' . $d, 'p' => $payload]);
        $n++;
    }
}
$db->exec("INSERT INTO news (brand_id, items) VALUES ('o2', :i) ON DUPLICATE KEY UPDATE items = VALUES(items)",
    ['i' => json_encode([['text' => 'Testmeldung: lokale Entwicklungsumgebung (synthetische Daten)', 'bis' => '']], JSON_UNESCAPED_UNICODE)]);

echo "Seed fertig: " . count($users) . " Testbenutzer, $n Statistikzeilen\n";
