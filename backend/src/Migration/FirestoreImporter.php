<?php
declare(strict_types=1);

namespace HeTec\PS\Migration;

use HeTec\PS\Db;
use HeTec\PS\Security\Crypto;
use HeTec\PS\Security\Ids;

/**
 * Übernahme eines Firestore-Exports (tools/firestore-export) in die relationale Datenbank.
 *
 * Grundsätze:
 *  - wiederholbar: IDs aus Firestore bleiben erhalten (users.legacy_firebase_uid, analytics_events.id, saved_offers.id …),
 *    ein zweiter Lauf erzeugt keine Dubletten
 *  - kontrolliert: Benutzer werden NICHT mit Microsoft verknüpft. Die Verknüpfung passiert erst bei der ersten
 *    Microsoft-Anmeldung und nur, wenn genau EIN migrierter Benutzer dieselbe E-Mail hat (EntraLogin::establish)
 *  - nachvollziehbar: Bericht mit Anzahl übernommen / übersprungen (mit Grund) / nicht zuordenbar je Sammlung
 *  - rücknehmbar: jede neu angelegte Zeile steht in import_log; --rollback=<lauf> löscht genau diese Zeilen
 *  - Testlauf (--dry-run): alles in einer Transaktion, am Ende zurückgerollt
 */
final class FirestoreImporter
{
    private string $batch = '';
    /** @var array<string,array<string,int|array<string,int>>> */
    private array $report = [];
    /** @var array<string,int> Firebase-UID → users.id */
    private array $uidMap = [];
    /** @var array<string,int|null> Anzeigename → users.id (null = mehrdeutig) */
    private array $nameMap = [];
    /** @var list<string> */
    private array $shops = [];

    public function __construct(private Db $db, private Crypto $crypto, private array $superAdminEmails = [])
    {
    }

    /** @param array<string,mixed> $export  { meta, collections: { users: {uid: doc}, analytics: {...}, ... } } */
    public function run(array $export, bool $dryRun = false): array
    {
        $cols = (array) ($export['collections'] ?? []);
        $this->shops = array_column($this->db->all('SELECT id FROM shops'), 'id');
        $this->batch = Ids::ulid();
        $pdo = $this->db->pdo();
        $pdo->beginTransaction();
        try {
            $this->db->exec('INSERT INTO import_batches (id, source, dry_run) VALUES (:id, :s, :d)', [
                'id' => $this->batch, 's' => mb_substr((string) ($export['meta']['project'] ?? 'firestore'), 0, 64), 'd' => $dryRun ? 1 : 0,
            ]);
            $this->users((array) ($cols['users'] ?? []));
            $this->analytics((array) ($cols['analytics'] ?? []));
            $this->offers((array) ($cols['saved_offers'] ?? []));
            $this->skip((array) ($cols['skip_limits'] ?? []));
            $this->tools((array) ($cols['tool_usage'] ?? []));
            $this->news((array) ($cols['news'] ?? []));
            $this->pdfIndex((array) ($cols['pdf_index'] ?? []));
            $this->settings((array) ($cols['aktionsmappe'] ?? []));
            $this->db->exec('UPDATE import_batches SET finished_at = UTC_TIMESTAMP(3), report = :r WHERE id = :id', [
                'id' => $this->batch, 'r' => json_encode($this->report, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
            ]);
            if ($dryRun) {
                $pdo->rollBack();
            } else {
                $pdo->commit();
            }
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
        return ['batch' => $this->batch, 'dryRun' => $dryRun, 'report' => $this->report];
    }

    public function rollback(string $batch): array
    {
        $b = $this->db->one('SELECT id, rolled_back_at FROM import_batches WHERE id = :id', ['id' => $batch]);
        if (!$b) {
            throw new \RuntimeException('Import-Lauf nicht gefunden: ' . $batch);
        }
        $order = ['pdf_index', 'saved_offers', 'analytics_events', 'skip_counters', 'skip_limits', 'tool_usage', 'user_shops', 'news', 'app_settings', 'users'];
        $keys = ['pdf_index' => 'id', 'saved_offers' => 'id', 'analytics_events' => 'id', 'news' => 'brand_id', 'app_settings' => 'setting_key', 'users' => 'id'];
        $deleted = [];
        $this->db->tx(function () use ($batch, $order, $keys, &$deleted) {
            foreach ($order as $t) {
                $rows = array_column($this->db->all('SELECT row_key FROM import_log WHERE batch_id = :b AND table_name = :t', ['b' => $batch, 't' => $t]), 'row_key');
                $n = 0;
                foreach ($rows as $k) {
                    if (isset($keys[$t])) {
                        $n += $this->db->exec("DELETE FROM `$t` WHERE `{$keys[$t]}` = :k", ['k' => $k]);
                    } else {
                        // zusammengesetzte Schlüssel: user|tool|month etc.
                        $p = explode('|', $k);
                        $n += match ($t) {
                            'skip_counters' => $this->db->exec('DELETE FROM skip_counters WHERE user_id = :u AND month = :m', ['u' => $p[0], 'm' => $p[1]]),
                            'skip_limits' => $this->db->exec('DELETE FROM skip_limits WHERE user_id = :u', ['u' => $p[0]]),
                            'tool_usage' => $this->db->exec('DELETE FROM tool_usage WHERE user_id = :u AND tool = :t AND month = :m', ['u' => $p[0], 't' => $p[1], 'm' => $p[2]]),
                            'user_shops' => $this->db->exec('DELETE FROM user_shops WHERE user_id = :u AND shop_id = :s', ['u' => $p[0], 's' => $p[1]]),
                            default => 0,
                        };
                    }
                }
                $deleted[$t] = $n;
            }
            $this->db->exec('UPDATE import_batches SET rolled_back_at = UTC_TIMESTAMP(3) WHERE id = :id', ['id' => $batch]);
        });
        return $deleted;
    }

    private function log(string $table, string $key): void
    {
        $this->db->exec('INSERT IGNORE INTO import_log (batch_id, table_name, row_key) VALUES (:b, :t, :k)', ['b' => $this->batch, 't' => $table, 'k' => $key]);
    }

    private function count(string $col, string $what, ?string $reason = null): void
    {
        $this->report[$col] ??= ['imported' => 0, 'existing' => 0, 'skipped' => []];
        if ($what === 'skipped') {
            $this->report[$col]['skipped'][$reason ?? 'unbekannt'] = ($this->report[$col]['skipped'][$reason ?? 'unbekannt'] ?? 0) + 1;
        } else {
            $this->report[$col][$what] = ($this->report[$col][$what] ?? 0) + 1;
        }
    }

    private static function normShop(mixed $v): string
    {
        $s = strtolower(trim((string) $v));
        $s = strtr($s, ['ä' => 'ae', 'ö' => 'oe', 'ü' => 'ue', 'ß' => 'ss']);
        $s = trim((string) preg_replace('/[^a-z0-9]+/', '-', $s), '-');
        return match ($s) {
            'sha', 'schwaebischhall', 'hall' => 'schwaebisch-hall',
            'stuttgart', 'vaihingen' => 'stuttgart-vaihingen',
            'neuotting' => 'neuoetting',
            default => $s,
        };
    }

    private static function truthy(mixed $v): bool
    {
        if ($v === true || $v === 1) {
            return true;
        }
        return is_string($v) && preg_match('/^(1|true|yes|ja|all|alle|\*)$/i', trim($v)) === 1;
    }

    private static function ms(mixed $v): ?int
    {
        if (is_int($v) || is_float($v)) {
            return (int) $v;
        }
        if (is_array($v) && isset($v['_seconds'])) {            // Firestore-Timestamp aus dem Export
            return (int) $v['_seconds'] * 1000 + intdiv((int) ($v['_nanoseconds'] ?? 0), 1000000);
        }
        if (is_string($v) && $v !== '' && ($t = strtotime($v)) !== false) {
            return $t * 1000;
        }
        return null;
    }

    // ── Benutzer ────────────────────────────────────────────────────────────
    private function users(array $docs): void
    {
        foreach ($docs as $uid => $d) {
            if (!is_array($d) || !is_string($uid) || $uid === '') {
                $this->count('users', 'skipped', 'ungültig');
                continue;
            }
            $email = strtolower(trim((string) ($d['email'] ?? '')));
            if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
                $this->count('users', 'skipped', 'keine gültige E-Mail');
                continue;
            }
            $existing = $this->db->one('SELECT id FROM users WHERE legacy_firebase_uid = :u', ['u' => $uid]);
            if ($existing) {
                $this->uidMap[$uid] = (int) $existing['id'];
                $this->count('users', 'existing');
                continue;
            }
            $roleRaw = strtolower((string) ($d['role'] ?? 'verkaeufer'));
            $role = match (true) {
                $roleRaw === 'admin' => in_array($email, $this->superAdminEmails, true) ? 'super_admin' : 'admin',
                in_array($roleRaw, ['super_admin', 'filialbetreuer', 'shop_leiter', 'azubi', 'mitarbeiter'], true) => $roleRaw,
                in_array($roleRaw, ['shopleiter', 'shop-leiter', 'leiter'], true) => 'shop_leiter',
                in_array($roleRaw, ['auszubildende', 'auszubildender', 'azubi'], true) => 'azubi',
                default => 'mitarbeiter',
            };
            $statusRaw = (string) ($d['status'] ?? '');
            $status = ($d['active'] ?? false) === true && $statusRaw === 'approved' ? 'approved'
                : ($statusRaw === 'pending' ? 'pending' : ($statusRaw === 'rejected' ? 'rejected' : (($d['active'] ?? false) === true ? 'approved' : 'blocked')));
            $all = $role === 'admin' || $role === 'super_admin';
            foreach (['shopwechsel', 'shopWechsel', 'shopSwitch', 'canSwitchShop', 'canChangeShop', 'allowShopSwitch', 'allShops', 'isSpringer', 'springer', 'mobileEmployee', 'ueberallEinsetzbar'] as $f) {
                $all = $all || self::truthy($d[$f] ?? null);
            }
            $home = self::normShop($d['shopId'] ?? $d['homeShopId'] ?? '');
            $home = in_array($home, $this->shops, true) ? $home : null;
            $extra = [];
            foreach (['extraShopIds', 'allowedShopIds', 'shopIds', 'allowedShops', 'shops'] as $f) {
                $c = $d[$f] ?? null;
                if (is_array($c)) {
                    foreach ($c as $k => $v) {
                        $id = array_is_list($c) ? self::normShop(is_array($v) ? ($v['id'] ?? $v['shopId'] ?? $v['value'] ?? '') : $v) : (self::truthy($v) ? self::normShop($k) : '');
                        if ($id !== '' && in_array($id, $this->shops, true) && $id !== $home && !in_array($id, $extra, true)) {
                            $extra[] = $id;
                        }
                    }
                }
            }
            $name = trim((string) ($d['name'] ?? trim(($d['vorname'] ?? '') . ' ' . ($d['nachname'] ?? ''))));
            $created = self::ms($d['createdAt'] ?? null);
            $this->db->exec(
                'INSERT INTO users (public_id, email, display_name, anrede, vorname, nachname, role_id, status, all_shops, home_shop_id, is_test_user, legacy_firebase_uid, created_at)
                 VALUES (:p, :e, :n, :a, :v, :nn, :r, :s, :all, :h, :t, :u, :c)',
                [
                    'p' => Ids::ulid(), 'e' => $email, 'n' => mb_substr($name, 0, 120), 'a' => mb_substr((string) ($d['anrede'] ?? ''), 0, 16),
                    'v' => mb_substr((string) ($d['vorname'] ?? ''), 0, 80), 'nn' => mb_substr((string) ($d['nachname'] ?? ''), 0, 80),
                    'r' => $role, 's' => $status, 'all' => $all ? 1 : 0, 'h' => $home, 't' => !empty($d['isTestUser']) ? 1 : 0, 'u' => $uid,
                    'c' => $created ? Db::fromMs($created) : Db::now(),
                ]
            );
            $id = $this->db->lastId();
            $this->uidMap[$uid] = $id;
            $this->log('users', (string) $id);
            foreach ($extra as $s) {
                $this->db->exec('INSERT IGNORE INTO user_shops (user_id, shop_id) VALUES (:u, :s)', ['u' => $id, 's' => $s]);
                $this->log('user_shops', $id . '|' . $s);
            }
            $this->count('users', 'imported');
        }
        foreach ($this->db->all('SELECT id, display_name FROM users WHERE deleted_at IS NULL') as $u) {
            $n = (string) $u['display_name'];
            $this->nameMap[$n] = array_key_exists($n, $this->nameMap) ? null : (int) $u['id'];
        }
        foreach ($this->db->all('SELECT id, legacy_firebase_uid FROM users WHERE legacy_firebase_uid IS NOT NULL') as $u) {
            $this->uidMap[(string) $u['legacy_firebase_uid']] = (int) $u['id'];
        }
    }

    private function userFor(?string $uid, ?string $name): ?int
    {
        if ($uid !== null && $uid !== '' && isset($this->uidMap[$uid])) {
            return $this->uidMap[$uid];
        }
        if ($name !== null && $name !== '' && isset($this->nameMap[$name])) {
            return $this->nameMap[$name];
        }
        return null;
    }

    // ── Statistik ───────────────────────────────────────────────────────────
    private function analytics(array $docs): void
    {
        foreach ($docs as $docId => $d) {
            $id = (string) ($d['id'] ?? $docId);
            if (!is_array($d) || !Ids::validClientId($id)) {
                $this->count('analytics', 'skipped', 'ungültige ID');
                continue;
            }
            if ($this->db->scalar('SELECT 1 FROM analytics_events WHERE id = :id', ['id' => $id])) {
                $this->count('analytics', 'existing');
                continue;
            }
            $ms = self::ms($d['ts'] ?? null);
            if ($ms === null) {
                $this->count('analytics', 'skipped', 'kein Zeitstempel');
                continue;
            }
            $user = $this->userFor($d['userUid'] ?? null, $d['user'] ?? null);
            if ($user === null) {
                $this->count('analytics', 'skipped_user_unresolved_kept');
            }
            $shop = self::normShop($d['shopId'] ?? '');
            $shop = in_array($shop, $this->shops, true) ? $shop : null;
            unset($d['userUid'], $d['syncedAt']);
            $this->db->exec(
                'INSERT INTO analytics_events (id, user_id, user_name, shop_id, shop_name, ts, result, beratungs_id, exempt, duration_min, payload)
                 VALUES (:id, :u, :un, :s, :sn, :ts, :r, :b, :e, :dm, :p)',
                [
                    'id' => $id, 'u' => $user, 'un' => mb_substr((string) ($d['user'] ?? ''), 0, 120), 's' => $shop, 'sn' => mb_substr((string) ($d['shop'] ?? ''), 0, 120),
                    'ts' => Db::fromMs($ms), 'r' => mb_substr((string) ($d['result'] ?? 'offen'), 0, 32), 'b' => mb_substr((string) ($d['beratungsId'] ?? ''), 0, 64),
                    'e' => !empty($d['exempt']) ? 1 : 0, 'dm' => isset($d['durationMin']) && is_numeric($d['durationMin']) ? (int) $d['durationMin'] : null,
                    'p' => json_encode($d, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
                ]
            );
            $this->log('analytics_events', $id);
            $this->count('analytics', 'imported');
        }
        $this->report['analytics']['skipped_user_unresolved_kept'] ??= 0;
    }

    // ── Gespeicherte Angebote ──────────────────────────────────────────────
    private function offers(array $docs): void
    {
        foreach ($docs as $docId => $d) {
            $id = (string) ($d['id'] ?? $docId);
            if (!is_array($d) || !Ids::validClientId($id) || !is_string($d['payload'] ?? null)) {
                $this->count('saved_offers', 'skipped', 'ungültig');
                continue;
            }
            $ts = self::ms($d['ts'] ?? null) ?? 0;
            if ($ts < (time() - 30 * 86400) * 1000) {
                $this->count('saved_offers', 'skipped', 'älter als 30 Tage (Löschfrist)');
                continue;
            }
            $shop = self::normShop($d['shopId'] ?? '');
            if (!in_array($shop, $this->shops, true)) {
                $this->count('saved_offers', 'skipped', 'ohne gültigen Shop (Altbestand)');
                continue;
            }
            if ($this->db->scalar('SELECT 1 FROM saved_offers WHERE id = :id', ['id' => $id])) {
                $this->count('saved_offers', 'existing');
                continue;
            }
            $payload = (string) $d['payload'];
            $this->db->exec(
                'INSERT INTO saved_offers (id, shop_id, user_id, agent_name, label_enc, kunde_enc, datum, ts_client, payload_enc, size_bytes, expires_at)
                 VALUES (:id, :s, :u, :a, :l, :k, :d, :ts, :p, :sz, :exp)',
                [
                    'id' => $id, 's' => $shop, 'u' => $this->userFor($d['userUid'] ?? null, $d['agent'] ?? null), 'a' => mb_substr((string) ($d['agent'] ?? ''), 0, 120),
                    'l' => $this->crypto->encrypt(mb_substr((string) ($d['label'] ?? ''), 0, 300), 'offer-label:' . $id),
                    'k' => $this->crypto->encrypt(mb_substr((string) ($d['kunde'] ?? ''), 0, 300), 'offer-kunde:' . $id),
                    'd' => mb_substr((string) ($d['datum'] ?? ''), 0, 32), 'ts' => $ts,
                    'p' => $this->crypto->encrypt($payload, 'offer:' . $id), 'sz' => strlen($payload),
                    'exp' => Db::fromMs($ts + 30 * 86400 * 1000),
                ]
            );
            $this->log('saved_offers', $id);
            $this->count('saved_offers', 'imported');
        }
    }

    // ── Skip-Limits (Schlüssel bisher nach Agentenname) ─────────────────────
    private function skip(array $docs): void
    {
        foreach ($docs as $docId => $d) {
            if (!is_array($d)) {
                continue;
            }
            $agent = (string) ($d['agent'] ?? '');
            $user = $this->userFor($d['userUid'] ?? null, $agent);
            if ($user === null) {
                $this->count('skip_limits', 'skipped', 'Agent nicht eindeutig zuordenbar');
                continue;
            }
            if (str_starts_with((string) $docId, 'limit_')) {
                if ($this->db->scalar('SELECT 1 FROM skip_limits WHERE user_id = :u', ['u' => $user])) {
                    $this->count('skip_limits', 'existing');
                    continue;
                }
                $this->db->exec('INSERT INTO skip_limits (user_id, max_limit, exempt) VALUES (:u, :l, :e)', ['u' => $user, 'l' => max(0, (int) ($d['max_limit'] ?? 15)), 'e' => !empty($d['exempt']) ? 1 : 0]);
                $this->log('skip_limits', (string) $user);
            } else {
                $month = (string) ($d['month'] ?? '');
                if (!preg_match('/^\d{4}-\d{2}$/', $month)) {
                    $this->count('skip_limits', 'skipped', 'Monat fehlt');
                    continue;
                }
                if ($this->db->scalar('SELECT 1 FROM skip_counters WHERE user_id = :u AND month = :m', ['u' => $user, 'm' => $month])) {
                    $this->count('skip_limits', 'existing');
                    continue;
                }
                $this->db->exec('INSERT INTO skip_counters (user_id, month, count) VALUES (:u, :m, :c)', ['u' => $user, 'm' => $month, 'c' => max(0, (int) ($d['count'] ?? 0))]);
                $this->log('skip_counters', $user . '|' . $month);
            }
            $this->count('skip_limits', 'imported');
        }
    }

    private function tools(array $docs): void
    {
        foreach ($docs as $d) {
            if (!is_array($d)) {
                continue;
            }
            $user = $this->userFor(null, (string) ($d['agent'] ?? ''));
            $tool = (string) ($d['tool'] ?? '');
            $month = (string) ($d['month'] ?? '');
            if ($user === null || !preg_match('/^[a-z0-9_-]{1,64}$/i', $tool) || !preg_match('/^\d{4}-\d{2}$/', $month)) {
                $this->count('tool_usage', 'skipped', 'nicht zuordenbar');
                continue;
            }
            if ($this->db->scalar('SELECT 1 FROM tool_usage WHERE user_id = :u AND tool = :t AND month = :m', ['u' => $user, 't' => $tool, 'm' => $month])) {
                $this->count('tool_usage', 'existing');
                continue;
            }
            $this->db->exec('INSERT INTO tool_usage (user_id, tool, month, count) VALUES (:u, :t, :m, :c)', ['u' => $user, 't' => $tool, 'm' => $month, 'c' => max(0, (int) ($d['count'] ?? 0))]);
            $this->log('tool_usage', $user . '|' . $tool . '|' . $month);
            $this->count('tool_usage', 'imported');
        }
    }

    private function news(array $docs): void
    {
        foreach ($docs as $brand => $d) {
            if (!is_array($d) || !$this->db->scalar('SELECT 1 FROM brands WHERE id = :b', ['b' => $brand])) {
                $this->count('news', 'skipped', 'unbekannte Marke');
                continue;
            }
            if ($this->db->scalar('SELECT 1 FROM news WHERE brand_id = :b', ['b' => $brand])) {
                $this->count('news', 'existing');
                continue;
            }
            $items = array_values(array_filter((array) ($d['items'] ?? []), static fn ($x) => is_array($x) && trim((string) ($x['text'] ?? '')) !== ''));
            $this->db->exec('INSERT INTO news (brand_id, items) VALUES (:b, :i)', ['b' => $brand, 'i' => json_encode(array_slice($items, 0, 5), JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)]);
            $this->log('news', (string) $brand);
            $this->count('news', 'imported');
        }
    }

    private function pdfIndex(array $docs): void
    {
        foreach ($docs as $docId => $d) {
            if (!is_array($d) || trim((string) ($d['fileName'] ?? '')) === '') {
                $this->count('pdf_index', 'skipped', 'ungültig');
                continue;
            }
            $id = substr((string) preg_replace('/[^a-z0-9._+\-]/', '_', strtolower((string) $d['fileName'])), 0, 180);
            if ($this->db->scalar('SELECT 1 FROM pdf_index WHERE id = :id', ['id' => $id])) {
                $this->count('pdf_index', 'existing');
                continue;
            }
            $shop = self::normShop($d['shopId'] ?? '');
            $user = $this->userFor($d['uid'] ?? null, null);
            unset($d['docId']);
            $d['uid'] = '';
            $this->db->exec(
                'INSERT INTO pdf_index (id, file_name, shop_id, user_id, typ, src, ts_client, entry_enc) VALUES (:id, :f, :s, :u, :t, :src, :ts, :e)',
                [
                    'id' => $id, 'f' => mb_substr((string) $d['fileName'], 0, 255), 's' => in_array($shop, $this->shops, true) ? $shop : null, 'u' => $user,
                    't' => ($d['typ'] ?? '') === 'abschluss' ? 'abschluss' : 'angebot', 'src' => ($d['src'] ?? '') === 'import' ? 'import' : 'app',
                    'ts' => (int) (self::ms($d['ts'] ?? null) ?? 0), 'e' => $this->crypto->encrypt(json_encode($d, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'pdfidx:' . $id),
                ]
            );
            foreach (array_unique(array_filter((array) ($d['keys'] ?? []), 'is_string')) as $k) {
                $this->db->exec('INSERT IGNORE INTO pdf_index_keys (index_id, key_hmac) VALUES (:i, :k)', ['i' => $id, 'k' => $this->crypto->indexHmac($k)]);
            }
            $this->log('pdf_index', $id);
            $this->count('pdf_index', 'imported');
        }
    }

    private function settings(array $docs): void
    {
        $g = $docs['global'] ?? null;
        if (!is_array($g) || !isset($g['bundles']) || !is_array($g['bundles'])) {
            return;
        }
        if ($this->db->scalar("SELECT 1 FROM app_settings WHERE setting_key = 'aktionsmappe'")) {
            $this->count('aktionsmappe', 'existing');
            return;
        }
        $this->db->exec("INSERT INTO app_settings (setting_key, value_json) VALUES ('aktionsmappe', :v)", ['v' => json_encode(['bundles' => $g['bundles']], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)]);
        $this->log('app_settings', 'aktionsmappe');
        $this->count('aktionsmappe', 'imported');
    }
}
