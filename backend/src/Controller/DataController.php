<?php
declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Db;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;
use HeTec\PS\Security\Ids;

/** Shops, News, gespeicherte Angebote, Skip-Limits, Werkzeug-Nutzung, Einstellungen. */
final class DataController
{
    private const OFFER_MAX_BYTES = 850000;   // wie bisher (Firestore-Grenze), damit sich das Verhalten nicht ändert
    private const OFFER_TTL_DAYS = 30;
    private const NEWS_MAX = 5;
    private const SETTINGS_PUBLIC = ['aktionsmappe'];

    public function __construct(private App $app)
    {
    }

    public function shops(Request $r): Response
    {
        $p = $this->app->principal();
        [$in, $params] = Db::in($p->shopIds, 's');
        $rows = $this->app->db->all("SELECT id, brand_id, name, ort FROM shops WHERE active = 1 AND id IN ($in) ORDER BY name", $params);
        return Response::json(['ok' => true, 'shops' => array_map(static fn ($s) => [
            'id' => $s['id'], 'brand' => $s['brand_id'], 'name' => $s['name'], 'ort' => $s['ort'],
        ], $rows)]);
    }

    // ── News ────────────────────────────────────────────────────────────────
    public function getNews(Request $r): Response
    {
        $brand = $this->brand($r->param('brand'));
        $row = $this->app->db->one('SELECT items FROM news WHERE brand_id = :b', ['b' => $brand]);
        $items = $row ? (json_decode((string) $row['items'], true) ?: []) : [];
        return Response::json(['ok' => true, 'items' => $items]);
    }

    public function putNews(Request $r): Response
    {
        $p = $this->app->principal();
        $brand = $this->brand($r->param('brand'));
        $items = $r->json()['items'] ?? null;
        if (!is_array($items)) {
            throw new HttpException(422, 'invalid_items');
        }
        $clean = [];
        foreach ($items as $it) {
            if (!is_array($it)) {
                continue;
            }
            $text = trim(mb_substr((string) ($it['text'] ?? ''), 0, 300));
            $bis = (string) ($it['bis'] ?? '');
            if ($text === '') {
                continue;
            }
            if ($bis !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $bis)) {
                $bis = '';
            }
            $clean[] = ['text' => $text, 'bis' => $bis];
            if (count($clean) >= self::NEWS_MAX) {
                break;
            }
        }
        $this->app->db->exec(
            'INSERT INTO news (brand_id, items, updated_by) VALUES (:b, :i, :u) ON DUPLICATE KEY UPDATE items = VALUES(items), updated_by = VALUES(updated_by)',
            ['b' => $brand, 'i' => json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'u' => $p->id]
        );
        $this->app->audit->log($p->id, 'news_updated', 'news', $brand);
        return Response::json(['ok' => true, 'items' => $clean]);
    }

    private function brand(string $b): string
    {
        if (!$this->app->db->scalar('SELECT 1 FROM brands WHERE id = :b', ['b' => $b])) {
            throw new HttpException(404, 'unknown_brand');
        }
        return $b;
    }

    // ── Gespeicherte Angebote (30 Tage) ───────────────────────────────────
    public function putOffer(Request $r): Response
    {
        $p = $this->app->principal();
        $id = $r->param('id');
        if (!Ids::validClientId($id)) {
            throw new HttpException(422, 'invalid_id');
        }
        $b = $r->json();
        $shopId = (string) ($b['shopId'] ?? '');
        $p->requireShop($shopId);
        $payload = $b['payload'] ?? null;
        if (!is_string($payload) || $payload === '') {
            throw new HttpException(422, 'invalid_payload');
        }
        if (strlen($payload) > self::OFFER_MAX_BYTES) {
            return Response::json(['ok' => false, 'error' => 'too_big', 'sizeKB' => (int) round(strlen($payload) / 1024)], 413);
        }
        json_decode($payload);
        if (json_last_error() !== JSON_ERROR_NONE) {
            throw new HttpException(422, 'invalid_payload');
        }
        $existing = $this->app->db->one('SELECT shop_id FROM saved_offers WHERE id = :id', ['id' => $id]);
        if ($existing && !$p->hasShop((string) $existing['shop_id'])) {
            throw new HttpException(403, 'shop_forbidden');
        }
        $ts = (int) ($b['ts'] ?? 0) ?: (int) floor(microtime(true) * 1000);
        $c = $this->app->crypto;
        $this->app->db->exec(
            'INSERT INTO saved_offers (id, shop_id, user_id, agent_name, label_enc, kunde_enc, datum, ts_client, payload_enc, size_bytes, expires_at)
             VALUES (:id, :s, :u, :a, :l, :k, :d, :ts, :p, :sz, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ' . self::OFFER_TTL_DAYS . ' DAY))
             ON DUPLICATE KEY UPDATE shop_id = VALUES(shop_id), user_id = VALUES(user_id), agent_name = VALUES(agent_name), label_enc = VALUES(label_enc),
               kunde_enc = VALUES(kunde_enc), datum = VALUES(datum), ts_client = VALUES(ts_client), payload_enc = VALUES(payload_enc),
               size_bytes = VALUES(size_bytes), expires_at = VALUES(expires_at)',
            [
                'id' => $id,
                's' => $shopId,
                'u' => $p->id,
                'a' => mb_substr((string) ($b['agent'] ?? $p->displayName), 0, 120),
                'l' => $c->encrypt(mb_substr((string) ($b['label'] ?? ''), 0, 300), 'offer-label:' . $id),
                'k' => $c->encrypt(mb_substr((string) ($b['kunde'] ?? ''), 0, 300), 'offer-kunde:' . $id),
                'd' => mb_substr((string) ($b['datum'] ?? ''), 0, 32),
                'ts' => $ts,
                'p' => $c->encrypt($payload, 'offer:' . $id),
                'sz' => strlen($payload),
            ]
        );
        return Response::json(['ok' => true, 'sizeKB' => (int) round(strlen($payload) / 1024)]);
    }

    public function listOffers(Request $r): Response
    {
        $p = $this->app->principal();
        $this->purgeExpiredOffers();
        $shop = $r->q('shopId');
        if ($shop !== '') {
            $p->requireShop($shop);
            $shops = [$shop];
        } else {
            $shops = $p->shopIds;
        }
        $all = $r->q('scope') === 'all' && $p->can('offers.all_shops');
        if ($all) {
            $rows = $this->app->db->all('SELECT id, shop_id, agent_name, label_enc, kunde_enc, datum, ts_client FROM saved_offers WHERE expires_at > UTC_TIMESTAMP(3) ORDER BY ts_client DESC LIMIT 2000');
        } else {
            [$in, $params] = Db::in($shops, 's');
            $rows = $this->app->db->all("SELECT id, shop_id, agent_name, label_enc, kunde_enc, datum, ts_client FROM saved_offers WHERE expires_at > UTC_TIMESTAMP(3) AND shop_id IN ($in) ORDER BY ts_client DESC LIMIT 2000", $params);
        }
        $c = $this->app->crypto;
        $out = [];
        foreach ($rows as $row) {
            $id = (string) $row['id'];
            try {
                $label = $c->decrypt((string) $row['label_enc'], 'offer-label:' . $id);
                $kunde = $c->decrypt((string) $row['kunde_enc'], 'offer-kunde:' . $id);
            } catch (\Throwable) {
                continue;
            }
            $out[] = ['id' => $id, 'shopId' => $row['shop_id'], 'ts' => (int) $row['ts_client'], 'label' => $label !== '' ? $label : ($kunde !== '' ? $kunde : 'Angebot'),
                'datum' => $row['datum'], 'agent' => $row['agent_name'], 'kunde' => $kunde];
        }
        return Response::json(['ok' => true, 'offers' => $out]);
    }

    public function getOffer(Request $r): Response
    {
        $p = $this->app->principal();
        $id = $r->param('id');
        $row = $this->app->db->one('SELECT shop_id, payload_enc FROM saved_offers WHERE id = :id AND expires_at > UTC_TIMESTAMP(3)', ['id' => $id]);
        if (!$row) {
            throw new HttpException(404, 'not_found');
        }
        if (!$p->hasShop((string) $row['shop_id']) && !$p->can('offers.all_shops')) {
            throw new HttpException(404, 'not_found'); // fremde Shops: wie „nicht vorhanden“, verrät keine Existenz
        }
        $payload = $this->app->crypto->decrypt((string) $row['payload_enc'], 'offer:' . $id);
        return Response::json(['ok' => true, 'payload' => $payload]);
    }

    public function deleteOffer(Request $r): Response
    {
        $p = $this->app->principal();
        $id = $r->param('id');
        $row = $this->app->db->one('SELECT shop_id FROM saved_offers WHERE id = :id', ['id' => $id]);
        if ($row) {
            if (!$p->hasShop((string) $row['shop_id'])) {
                throw new HttpException(404, 'not_found');
            }
            $this->app->db->exec('DELETE FROM saved_offers WHERE id = :id', ['id' => $id]);
        }
        return Response::json(['ok' => true]);
    }

    private function purgeExpiredOffers(): void
    {
        if (random_int(1, 20) === 1) {
            $this->app->db->exec('DELETE FROM saved_offers WHERE expires_at <= UTC_TIMESTAMP(3)');
        }
    }

    // ── Skip-Limits ─────────────────────────────────────────────────────────
    private static function month(): string
    {
        return gmdate('Y-m');
    }

    /** @return array{count:int,limit:int,exempt:bool} */
    private function skipState(int $userId): array
    {
        $cnt = (int) ($this->app->db->scalar('SELECT count FROM skip_counters WHERE user_id = :u AND month = :m', ['u' => $userId, 'm' => self::month()]) ?? 0);
        $l = $this->app->db->one('SELECT max_limit, exempt FROM skip_limits WHERE user_id = :u', ['u' => $userId]);
        return ['count' => $cnt, 'limit' => $l ? (int) $l['max_limit'] : 15, 'exempt' => $l ? (int) $l['exempt'] === 1 : false];
    }

    public function skipMe(Request $r): Response
    {
        return Response::json(['ok' => true] + $this->skipState($this->app->principal()->id));
    }

    public function skipIncrement(Request $r): Response
    {
        $p = $this->app->principal();
        $this->app->db->exec(
            'INSERT INTO skip_counters (user_id, month, count) VALUES (:u, :m, 1) ON DUPLICATE KEY UPDATE count = count + 1',
            ['u' => $p->id, 'm' => self::month()]
        );
        return Response::json(['ok' => true] + $this->skipState($p->id));
    }

    public function skipAgents(Request $r): Response
    {
        $rows = $this->app->db->all('SELECT id, public_id, display_name FROM users WHERE deleted_at IS NULL AND status = \'approved\' ORDER BY display_name');
        $out = [];
        foreach ($rows as $u) {
            $out[] = ['userId' => $u['public_id'], 'agent' => $u['display_name']] + $this->skipState((int) $u['id']);
        }
        return Response::json(['ok' => true, 'agents' => $out]);
    }

    public function skipUpdate(Request $r): Response
    {
        $p = $this->app->principal();
        $u = $this->app->users->findByPublicId($r->param('userId'));
        if (!$u) {
            throw new HttpException(404, 'not_found');
        }
        $this->app->users->assertCanManage($p, $u);
        $uid = (int) $u['id'];
        $b = $r->json();
        $this->app->db->tx(function () use ($b, $uid) {
            if (array_key_exists('limit', $b) || array_key_exists('exempt', $b)) {
                $cur = $this->skipState($uid);
                $limit = array_key_exists('limit', $b) ? max(0, min(1000, (int) $b['limit'])) : $cur['limit'];
                $exempt = array_key_exists('exempt', $b) ? (bool) $b['exempt'] : $cur['exempt'];
                $this->app->db->exec(
                    'INSERT INTO skip_limits (user_id, max_limit, exempt) VALUES (:u, :l, :e) ON DUPLICATE KEY UPDATE max_limit = VALUES(max_limit), exempt = VALUES(exempt)',
                    ['u' => $uid, 'l' => $limit, 'e' => $exempt ? 1 : 0]
                );
            }
            if (!empty($b['resetCount'])) {
                $this->app->db->exec(
                    'INSERT INTO skip_counters (user_id, month, count) VALUES (:u, :m, 0) ON DUPLICATE KEY UPDATE count = 0',
                    ['u' => $uid, 'm' => self::month()]
                );
            }
        });
        $this->app->audit->log($p->id, 'skip_updated', 'user', (string) $u['public_id'], null, array_intersect_key($b, ['limit' => 1, 'exempt' => 1, 'resetCount' => 1]));
        return Response::json(['ok' => true] + $this->skipState($uid));
    }

    // ── Werkzeug-Nutzung ───────────────────────────────────────────────────
    public function toolUsage(Request $r): Response
    {
        $p = $this->app->principal();
        $tool = (string) ($r->json()['tool'] ?? '');
        if (!preg_match('/^[a-z0-9_-]{1,64}$/i', $tool)) {
            throw new HttpException(422, 'invalid_tool');
        }
        $this->app->db->exec(
            'INSERT INTO tool_usage (user_id, tool, month, count) VALUES (:u, :t, :m, 1) ON DUPLICATE KEY UPDATE count = count + 1',
            ['u' => $p->id, 't' => $tool, 'm' => self::month()]
        );
        return Response::json(['ok' => true]);
    }

    public function toolUsageList(Request $r): Response
    {
        $month = $r->q('month');
        $params = [];
        $where = '';
        if ($month !== '') {
            if (!preg_match('/^\d{4}-\d{2}$/', $month)) {
                throw new HttpException(422, 'invalid_month');
            }
            $where = 'WHERE t.month = :m';
            $params['m'] = $month;
        }
        $rows = $this->app->db->all("SELECT u.display_name AS agent, t.tool, t.month, t.count FROM tool_usage t JOIN users u ON u.id = t.user_id $where ORDER BY t.month DESC, agent", $params);
        return Response::json(['ok' => true, 'rows' => $rows]);
    }

    // ── Einstellungen (z. B. Aktionsmappe) ─────────────────────────────────
    public function getSetting(Request $r): Response
    {
        $key = $r->param('key');
        if (!in_array($key, self::SETTINGS_PUBLIC, true)) {
            throw new HttpException(404, 'not_found');
        }
        $row = $this->app->db->one('SELECT value_json, updated_at FROM app_settings WHERE setting_key = :k', ['k' => $key]);
        return Response::json(['ok' => true, 'value' => $row ? json_decode((string) $row['value_json'], true) : null, 'updatedAt' => $row['updated_at'] ?? null]);
    }

    public function putSetting(Request $r): Response
    {
        $p = $this->app->principal();
        $key = $r->param('key');
        if (!in_array($key, self::SETTINGS_PUBLIC, true)) {
            throw new HttpException(404, 'not_found');
        }
        $value = $r->json()['value'] ?? null;
        $json = json_encode($value, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        if (strlen($json) > 1024 * 1024) {
            throw new HttpException(413, 'payload_too_large');
        }
        $this->app->db->exec(
            'INSERT INTO app_settings (setting_key, value_json, updated_by) VALUES (:k, :v, :u) ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_by = VALUES(updated_by)',
            ['k' => $key, 'v' => $json, 'u' => $p->id]
        );
        $this->app->audit->log($p->id, 'setting_updated', 'setting', $key);
        return Response::json(['ok' => true]);
    }
}
