<?php
declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Auth\Principal;
use HeTec\PS\Db;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;

/**
 * Suchindex für das PDF-Archiv (die PDFs selbst liegen weiterhin in SharePoint).
 * Kundenname/Rufnummer werden verschlüsselt gespeichert; gesucht wird über HMAC-Schlüssel.
 * Mitarbeiter sehen nur ihre zugeordneten Shops (wie bisher die Firestore-Regeln), Admins alle.
 */
final class PdfIndexController
{
    public function __construct(private App $app)
    {
    }

    private static function normId(string $fileName): string
    {
        return substr((string) preg_replace('/[^a-z0-9._+\-]/', '_', strtolower($fileName)), 0, 180);
    }

    /** @return array<string,mixed> */
    private function sanitize(array $e, Principal $p): array
    {
        $fileName = mb_substr((string) ($e['fileName'] ?? ''), 0, 180);
        if ($fileName === '') {
            throw new HttpException(422, 'invalid_entry');
        }
        $keys = [];
        foreach ((array) ($e['keys'] ?? []) as $k) {
            if (is_string($k) && $k !== '' && strlen($k) <= 80) {
                $keys[] = $k;
            }
            if (count($keys) >= 40) {
                break;
            }
        }
        return [
            'fileName' => $fileName,
            'typ' => ($e['typ'] ?? '') === 'abschluss' ? 'abschluss' : 'angebot',
            'shopId' => strtolower(mb_substr((string) ($e['shopId'] ?? ''), 0, 40)),
            'kunde' => mb_substr((string) ($e['kunde'] ?? ''), 0, 80),
            'ruf' => mb_substr((string) preg_replace('/[^0-9+]/', '', (string) ($e['ruf'] ?? '')), 0, 24),
            'nsn' => mb_substr((string) ($e['nsn'] ?? ''), 0, 24),
            'datum' => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($e['datum'] ?? '')) ? (string) $e['datum'] : gmdate('Y-m-d'),
            'agent' => mb_substr((string) ($e['agent'] ?? ''), 0, 40),
            'ts' => is_numeric($e['ts'] ?? null) ? (int) $e['ts'] : (int) floor(microtime(true) * 1000),
            'keys' => $keys,
            'offerId' => mb_substr((string) ($e['offerId'] ?? ''), 0, 80),
            'src' => ($e['src'] ?? '') === 'import' ? 'import' : 'app',
            'uid' => $p->publicId,
            'v' => 1,
        ];
    }

    private function write(array $entry, Principal $p, bool $onlyIfNew): bool
    {
        $id = self::normId($entry['fileName']);
        if ($entry['shopId'] !== '' && !$p->hasShop($entry['shopId'])) {
            throw new HttpException(403, 'shop_forbidden');
        }
        $shopExists = $entry['shopId'] !== '' && $this->app->db->scalar('SELECT 1 FROM shops WHERE id = :s', ['s' => $entry['shopId']]);
        return $this->app->db->tx(function () use ($id, $entry, $p, $onlyIfNew, $shopExists) {
            $exists = $this->app->db->one('SELECT user_id, shop_id FROM pdf_index WHERE id = :id FOR UPDATE', ['id' => $id]);
            if ($exists) {
                if ($onlyIfNew) {
                    return false;
                }
                if ((int) $exists['user_id'] !== $p->id && !$p->can('archive.import')) {
                    throw new HttpException(409, 'conflict');
                }
                $this->app->db->exec('DELETE FROM pdf_index WHERE id = :id', ['id' => $id]);
            }
            $this->app->db->exec(
                'INSERT INTO pdf_index (id, file_name, shop_id, user_id, typ, src, ts_client, entry_enc) VALUES (:id, :f, :s, :u, :t, :src, :ts, :e)',
                [
                    'id' => $id, 'f' => $entry['fileName'], 's' => $shopExists ? $entry['shopId'] : null, 'u' => $p->id,
                    't' => $entry['typ'], 'src' => $entry['src'], 'ts' => $entry['ts'],
                    'e' => $this->app->crypto->encrypt(json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), 'pdfidx:' . $id),
                ]
            );
            foreach (array_unique($entry['keys']) as $k) {
                $this->app->db->exec('INSERT IGNORE INTO pdf_index_keys (index_id, key_hmac) VALUES (:i, :k)', ['i' => $id, 'k' => $this->app->crypto->indexHmac($k)]);
            }
            return true;
        });
    }

    public function put(Request $r): Response
    {
        $p = $this->app->principal();
        $entry = $this->sanitize($r->json(), $p);
        if (self::normId($entry['fileName']) !== $r->param('id')) {
            throw new HttpException(422, 'id_mismatch');
        }
        $this->write($entry, $p, false);
        return Response::json(['ok' => true]);
    }

    public function import(Request $r): Response
    {
        $p = $this->app->principal();
        $entries = $r->json()['entries'] ?? null;
        if (!is_array($entries) || count($entries) > 500) {
            throw new HttpException(422, 'invalid_entries');
        }
        $neu = 0;
        foreach ($entries as $e) {
            if (is_array($e) && $this->write($this->sanitize($e, $p), $p, true)) {
                $neu++;
            }
        }
        return Response::json(['ok' => true, 'neu' => $neu]);
    }

    /** @return list<array<string,mixed>> */
    private function decodeRows(array $rows): array
    {
        $out = [];
        foreach ($rows as $row) {
            try {
                $d = json_decode($this->app->crypto->decrypt((string) $row['entry_enc'], 'pdfidx:' . $row['id']), true);
            } catch (\Throwable) {
                continue;
            }
            if (is_array($d)) {
                $d['uid'] = (string) ($row['user_public'] ?? '');
                $out[] = $d;
            }
        }
        return $out;
    }

    private function shopFilter(Principal $p, string $shop, array &$params): string
    {
        $all = $p->can('archive.search_all');
        if (!$all && !$p->can('archive.search_shops')) {
            throw new HttpException(403, 'permission-denied');   // Recht gilt immer, auch mit shopId
        }
        if ($shop !== '') {
            if (!$all && !$p->hasShop($shop)) {
                throw new HttpException(403, 'permission-denied');
            }
            $params['shop'] = $shop;
            return ' AND i.shop_id = :shop';
        }
        if ($all) {
            return '';
        }
        [$in, $ip] = Db::in($p->shopIds, 'sh');
        $params += $ip;
        return " AND i.shop_id IN ($in)";
    }

    public function search(Request $r): Response
    {
        $p = $this->app->principal();
        $key = $r->q('key');
        if ($key === '' || strlen($key) > 80) {
            throw new HttpException(422, 'invalid_key');
        }
        $limit = max(1, min(150, (int) $r->q('limit', '150')));
        $params = ['k' => $this->app->crypto->indexHmac($key)];
        $sql = 'SELECT i.id, i.entry_enc, u.public_id AS user_public FROM pdf_index_keys k JOIN pdf_index i ON i.id = k.index_id
                LEFT JOIN users u ON u.id = i.user_id WHERE k.key_hmac = :k' . $this->shopFilter($p, $r->q('shopId'), $params)
            . ' ORDER BY i.ts_client DESC LIMIT ' . $limit;
        $rows = $this->app->db->all($sql, $params);
        return Response::json(['ok' => true, 'items' => $this->decodeRows($rows), 'limited' => count($rows) >= $limit]);
    }

    public function mine(Request $r): Response
    {
        $p = $this->app->principal();
        $since = (int) $r->q('since', '0');
        $rows = $this->app->db->all(
            "SELECT i.id, i.entry_enc, u.public_id AS user_public FROM pdf_index i LEFT JOIN users u ON u.id = i.user_id
             WHERE i.user_id = :u AND i.src = 'app' AND i.ts_client >= :s ORDER BY i.ts_client DESC LIMIT 300",
            ['u' => $p->id, 's' => $since]
        );
        return Response::json(['ok' => true, 'items' => $this->decodeRows($rows)]);
    }

    /** Selbsttest: darf der Benutzer den Index eines Shops lesen? (fremde Shops → 403) */
    public function probe(Request $r): Response
    {
        $p = $this->app->principal();
        $params = [];
        $this->shopFilter($p, $r->q('shopId'), $params);
        return Response::json(['ok' => true]);
    }

    public function delete(Request $r): Response
    {
        $p = $this->app->principal();
        $n = $this->app->db->exec('DELETE FROM pdf_index WHERE id = :id', ['id' => $r->param('id')]);
        $this->app->audit->log($p->id, 'pdf_index_deleted', 'pdf_index', $r->param('id'));
        return Response::json(['ok' => true, 'deleted' => $n]);
    }

    /**
     * Archiv-Flow (Power Automate) über das Backend: Der Flow vertraut dem Backend (geheimer Header),
     * das Backend liefert die geprüfte Identität und die erlaubten Shops mit. Der Browser braucht dafür
     * kein Firebase-Token mehr. Der Flow muss entsprechend angepasst werden (docs/HETZNER-DEPLOYMENT.md).
     */
    public function flowProxy(Request $r): Response
    {
        $p = $this->app->principal();
        if (!$p->can('archive.search_all') && !$p->can('archive.search_shops')) {
            throw new HttpException(403, 'permission-denied');
        }
        $cfg = $this->app->config->archiveFlow();
        if ($cfg['url'] === '' || $cfg['shared_secret'] === '') {
            throw new HttpException(503, 'flow_not_configured');
        }
        if (!str_starts_with($cfg['url'], 'https://') && !$this->app->config->isDevelopment()) {
            throw new HttpException(500, 'flow_url_insecure');
        }
        $payload = $r->json()['payload'] ?? null;
        if (!is_array($payload)) {
            throw new HttpException(422, 'invalid_payload');
        }
        $action = (string) ($payload['action'] ?? '');
        if (!in_array($action, ['status', 'get', 'exists', 'list', 'probe'], true)) {
            throw new HttpException(422, 'invalid_action');
        }
        if ($action === 'list' && !$p->can('archive.import')) {
            throw new HttpException(403, 'forbidden');
        }
        $this->app->rate->hit('flow:' . $p->id, 120, 60);
        $body = json_encode([
            'request' => $payload,
            'identity' => [
                'userId' => $p->publicId,
                'email' => $p->email,
                'isAdmin' => $p->can('archive.search_all'),
                'shops' => $p->shopIds,
            ],
        ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        $ch = curl_init($cfg['url']);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-HeTec-Flow-Secret: ' . $cfg['shared_secret']],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 90,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $resp = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (!is_string($resp)) {
            throw new HttpException(502, 'flow_unreachable');
        }
        $j = json_decode($resp, true);
        if (!is_array($j)) {
            throw new HttpException(502, 'flow_invalid_response');
        }
        return Response::json($j, $status >= 200 && $status < 600 ? $status : 502);
    }
}
