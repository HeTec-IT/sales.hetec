<?php
declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Db;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;
use HeTec\PS\Security\Ids;

/**
 * Eigene Statistikverwaltung (ersetzt Firestore 'analytics').
 * - Zeilen-IDs kommen vom Gerät → mehrfaches Senden (Offline-Warteschlange, Wiederholung) erzeugt KEINE Doppelzählung.
 * - Eine fremde Zeile kann nie überschrieben werden.
 * - Die fachliche Bedeutung der Felder (result, canvasStats, …) bleibt unverändert; das Dashboard rechnet wie bisher.
 */
final class StatsController
{
    private const MAX_BATCH = 500;
    private const MAX_ROW_BYTES = 65536;
    private const MAX_AGE_DAYS = 15;
    private const RESULTS = ['Abschluss', 'Angebot', 'Anfrage', 'offen', 'Abgebrochen', 'Übersprungen', 'Geparkt'];

    public function __construct(private App $app)
    {
    }

    public function batch(Request $r): Response
    {
        $p = $this->app->principal();
        $rows = $r->json()['rows'] ?? null;
        if (!is_array($rows) || count($rows) > self::MAX_BATCH) {
            throw new HttpException(422, 'invalid_rows');
        }
        $accepted = [];
        $rejected = [];
        foreach ($rows as $row) {
            $id = is_array($row) ? (string) ($row['id'] ?? '') : '';
            try {
                $this->upsertRow($p, $row);
                $accepted[] = $id;
            } catch (HttpException $e) {
                $rejected[] = ['id' => $id, 'reason' => $e->errorCode];
            }
        }
        return Response::json(['ok' => true, 'accepted' => $accepted, 'rejected' => $rejected]);
    }

    private function upsertRow(\HeTec\PS\Auth\Principal $p, mixed $row): void
    {
        if (!is_array($row)) {
            throw new HttpException(422, 'invalid_row');
        }
        $id = (string) ($row['id'] ?? '');
        if (!Ids::validClientId($id)) {
            throw new HttpException(422, 'invalid_id');
        }
        $shopId = (string) ($row['shopId'] ?? '');
        if (!$p->hasShop($shopId)) {
            throw new HttpException(403, 'shop_forbidden');
        }
        $tsRaw = (string) ($row['ts'] ?? '');
        $ts = strtotime($tsRaw);
        // Offline-Warteschlange hält Einträge max. 14 Tage → ältere Zeitstempel sind nicht plausibel
        if ($ts === false || $ts < time() - self::MAX_AGE_DAYS * 86400 || $ts > time() + 86400) {
            throw new HttpException(422, 'invalid_ts');
        }
        $result = (string) ($row['result'] ?? 'offen');
        if (!in_array($result, self::RESULTS, true)) {
            $result = mb_substr($result, 0, 32);
        }
        // Server-seitig gesetzte Felder (Client kann sie nicht fälschen): Name aus dem Profil,
        // Ausnahme-Kennzeichen (wie bisher: Admin oder vom Admin freigestellt) aus der DB
        unset($row['userUid'], $row['syncedAt']);
        $row['user'] = $p->displayName;
        $row['exempt'] = $p->isAdmin()
            || (int) ($this->app->db->scalar('SELECT exempt FROM skip_limits WHERE user_id = :u', ['u' => $p->id]) ?? 0) === 1;
        $payload = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        if (strlen($payload) > self::MAX_ROW_BYTES) {
            throw new HttpException(413, 'row_too_large');
        }
        $ms = (int) round(((float) (new \DateTimeImmutable($tsRaw))->format('U.u')) * 1000);
        $this->app->db->tx(function () use ($p, $id, $shopId, $row, $result, $payload, $ms) {
            $existing = $this->app->db->one('SELECT user_id FROM analytics_events WHERE id = :id FOR UPDATE', ['id' => $id]);
            if ($existing && (int) $existing['user_id'] !== $p->id) {
                throw new HttpException(409, 'conflict');
            }
            $shopName = (string) ($this->app->db->scalar('SELECT name FROM shops WHERE id = :s', ['s' => $shopId]) ?? '');
            $brand = (string) ($this->app->db->scalar('SELECT brand_id FROM shops WHERE id = :s', ['s' => $shopId]) ?? 'o2');
            $params = [
                'id' => $id,
                'u' => $p->id,
                'un' => mb_substr($p->displayName, 0, 120),
                's' => $shopId,
                'sn' => $shopName,
                'b' => $brand,
                'ts' => Db::fromMs($ms),
                'r' => $result,
                'bid' => mb_substr((string) ($row['beratungsId'] ?? ''), 0, 64),
                'ex' => $row['exempt'] ? 1 : 0,
                'dm' => isset($row['durationMin']) && is_numeric($row['durationMin']) ? (int) $row['durationMin'] : null,
                'p' => $payload,
            ];
            if ($existing) {
                $this->app->db->exec(
                    'UPDATE analytics_events SET user_name = :un, shop_id = :s, shop_name = :sn, brand_id = :b, ts = :ts, result = :r, beratungs_id = :bid,
                     exempt = :ex, duration_min = :dm, payload = :p WHERE id = :id AND user_id = :u',
                    $params
                );
            } else {
                $this->app->db->exec(
                    'INSERT INTO analytics_events (id, user_id, user_name, shop_id, shop_name, brand_id, ts, result, beratungs_id, exempt, duration_min, payload)
                     VALUES (:id, :u, :un, :s, :sn, :b, :ts, :r, :bid, :ex, :dm, :p)',
                    $params
                );
            }
        });
    }

    /**
     * scope=own   eigene Zeilen
     * scope=shops Zeilen der zugeordneten Shops (analytics.read_shops)
     * scope=all   alle Zeilen (analytics.read_all)
     * Seitenweise über cursor (ts|id), absteigend nach Zeit – wie bisher orderBy('ts','desc').
     */
    public function list(Request $r): Response
    {
        $p = $this->app->principal();
        $scope = $r->q('scope', 'own');
        $where = [];
        $params = [];
        if ($scope === 'all') {
            $p->require('analytics.read_all');
        } elseif ($scope === 'shops') {
            if (!$p->can('analytics.read_shops') && !$p->can('analytics.read_all')) {
                throw new HttpException(403, 'forbidden');
            }
            [$in, $ip] = Db::in($p->shopIds, 's');
            $where[] = "e.shop_id IN ($in)";
            $params += $ip;
        } else {
            $p->require('analytics.read_own');
            $where[] = 'e.user_id = :me';
            $params['me'] = $p->id;
        }
        foreach (['from' => '>=', 'to' => '<'] as $k => $op) {
            $v = $r->q($k);
            if ($v !== '') {
                $t = strtotime($v);
                if ($t === false) {
                    throw new HttpException(422, 'invalid_' . $k);
                }
                $where[] = "e.ts $op :$k";
                $params[$k] = gmdate('Y-m-d H:i:s', $t);
            }
        }
        $cursor = $r->q('cursor');
        if ($cursor !== '') {
            [$cts, $cid] = array_pad(explode('|', $cursor, 2), 2, '');
            $where[] = '(e.ts < :cts OR (e.ts = :cts2 AND e.id < :cid))';
            $params['cts'] = $cts;
            $params['cts2'] = $cts;
            $params['cid'] = $cid;
        }
        $limit = max(1, min(1000, (int) $r->q('limit', '1000')));
        $sql = 'SELECT e.id, e.ts, e.user_name, e.shop_id, e.shop_name, e.result, e.payload, u.public_id AS user_public
                FROM analytics_events e LEFT JOIN users u ON u.id = e.user_id'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
            . ' ORDER BY e.ts DESC, e.id DESC LIMIT ' . ($limit + 1);
        $rows = $this->app->db->all($sql, $params);
        $next = null;
        if (count($rows) > $limit) {
            array_pop($rows);
            $last = end($rows);
            $next = $last['ts'] . '|' . $last['id'];
        }
        $out = array_map(static function (array $row): array {
            $d = json_decode((string) $row['payload'], true) ?: [];
            $d['id'] = $row['id'];
            $d['ts'] = (new \DateTimeImmutable($row['ts'], new \DateTimeZone('UTC')))->format('Y-m-d\TH:i:s.v\Z');
            $d['user'] = $row['user_name'];
            $d['userUid'] = $row['user_public'] ?? '';
            $d['shopId'] = $row['shop_id'];
            $d['shop'] = $row['shop_name'] !== '' ? $row['shop_name'] : ($d['shop'] ?? '');
            $d['result'] = $row['result'];
            return $d;
        }, $rows);
        return Response::json(['ok' => true, 'rows' => $out, 'next' => $next]);
    }

    /** Serverseitige, reproduzierbare Kennzahlen (Anzahl je Ergebnis, gruppiert). */
    public function summary(Request $r): Response
    {
        $p = $this->app->principal();
        $group = $r->q('groupBy', 'shop');
        $col = match ($group) {
            'shop' => 'e.shop_id',
            'user' => 'e.user_id',
            'day' => 'DATE(e.ts)',
            'month' => "DATE_FORMAT(e.ts, '%Y-%m')",
            default => throw new HttpException(422, 'invalid_group'),
        };
        $where = ['1=1'];
        $params = [];
        if ($p->can('analytics.read_all')) {
            // alles
        } elseif ($p->can('analytics.read_shops')) {
            [$in, $ip] = Db::in($p->shopIds, 's');
            $where[] = "e.shop_id IN ($in)";
            $params += $ip;
        } else {
            $p->require('analytics.read_own');
            $where[] = 'e.user_id = :me';
            $params['me'] = $p->id;
        }
        foreach (['from' => '>=', 'to' => '<'] as $k => $op) {
            $v = $r->q($k);
            if ($v !== '') {
                $t = strtotime($v);
                if ($t === false) {
                    throw new HttpException(422, 'invalid_' . $k);
                }
                $where[] = "e.ts $op :$k";
                $params[$k] = gmdate('Y-m-d H:i:s', $t);
            }
        }
        if ($r->q('includeExempt') !== '1') {
            $where[] = 'e.exempt = 0';
        }
        // Gruppierung nach Benutzer über die Benutzer-ID (Namen sind nicht eindeutig); Anzeige-Label = aktueller Name
        $label = $group === 'user' ? ", COALESCE(MAX(u.display_name), MAX(e.user_name)) AS label" : '';
        $join = $group === 'user' ? ' LEFT JOIN users u ON u.id = e.user_id' : '';
        $sql = "SELECT $col AS grp, e.result, COUNT(*) AS n$label FROM analytics_events e$join WHERE " . implode(' AND ', $where) . " GROUP BY grp, e.result ORDER BY grp";
        $out = [];
        foreach ($this->app->db->all($sql, $params) as $row) {
            $g = $group === 'user' ? (string) ($row['label'] ?? '') . ($row['grp'] === null ? ' (ohne Konto)' : '') : (string) $row['grp'];
            $key = $group === 'user' ? 'u' . (string) ($row['grp'] ?? 'null') : $g;
            $out[$key] ??= ['group' => $g, 'total' => 0, 'byResult' => []];
            $g = $key;
            $out[$g]['byResult'][(string) $row['result']] = (int) $row['n'];
            $out[$g]['total'] += (int) $row['n'];
        }
        return Response::json(['ok' => true, 'groupBy' => $group, 'groups' => array_values($out)]);
    }

    public function deleteAll(Request $r): Response
    {
        $p = $this->app->principal();
        if ($r->q('confirm') !== 'ALLE-STATISTIKEN-LOESCHEN') {
            throw new HttpException(422, 'confirmation_required');
        }
        $n = $this->app->db->exec('DELETE FROM analytics_events');
        $this->app->audit->log($p->id, 'analytics_deleted_all', 'analytics', '', null, ['rows' => $n]);
        return Response::json(['ok' => true, 'deleted' => $n]);
    }
}
