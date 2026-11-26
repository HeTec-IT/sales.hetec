<?php
declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Db;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;
use HeTec\PS\Migrator;

/** Benutzer-, Rollen- und Shopverwaltung (Microsoft authentifiziert – die Rechte vergibt ausschließlich diese Anwendung). */
final class AdminController
{
    public function __construct(private App $app)
    {
    }

    public function users(Request $r): Response
    {
        $p = $this->app->principal();
        $restrict = $p->can('users.manage') ? null : $p->shopIds;
        return Response::json(['ok' => true, 'users' => $this->app->users->listForAdmin($restrict)]);
    }

    public function roles(Request $r): Response
    {
        $roles = $this->app->db->all('SELECT id, label, rank_level FROM roles ORDER BY rank_level DESC');
        $shops = $this->app->db->all('SELECT id, brand_id AS brand, name, ort, active FROM shops ORDER BY name');
        return Response::json(['ok' => true, 'roles' => $roles, 'shops' => $shops]);
    }

    public function updateUser(Request $r): Response
    {
        $p = $this->app->principal();
        $target = $this->app->users->findByPublicId($r->param('id'));
        if (!$target) {
            throw new HttpException(404, 'not_found');
        }
        $tid = (int) $target['id'];
        if ($tid === $p->id) {
            throw new HttpException(403, 'cannot_modify_self');
        }
        $targetRank = (int) $this->app->db->scalar('SELECT rank_level FROM roles WHERE id = :r', ['r' => $target['role_id']]);
        $isSuper = $p->roleId === 'super_admin';
        if (!$isSuper && $targetRank >= $p->roleRank) {
            throw new HttpException(403, 'insufficient_rank');
        }
        $b = $r->json();
        $set = [];
        $params = ['id' => $tid];
        $revoke = false;
        $changes = [];

        if (array_key_exists('status', $b)) {
            $status = (string) $b['status'];
            if (!in_array($status, ['pending', 'approved', 'blocked', 'rejected'], true)) {
                throw new HttpException(422, 'invalid_status');
            }
            $set[] = 'status = :status';
            $params['status'] = $status;
            if ($status === 'approved' && $target['status'] !== 'approved') {
                $set[] = 'approved_by = :ab';
                $set[] = 'approved_at = UTC_TIMESTAMP(3)';
                $params['ab'] = $p->id;
            }
            $revoke = $revoke || $status !== 'approved';
            $changes['status'] = $status;
        }
        if (array_key_exists('role', $b)) {
            $role = (string) $b['role'];
            $rank = $this->app->db->scalar('SELECT rank_level FROM roles WHERE id = :r', ['r' => $role]);
            if ($rank === null) {
                throw new HttpException(422, 'invalid_role');
            }
            if (!$isSuper && (int) $rank >= $p->roleRank) {
                throw new HttpException(403, 'insufficient_rank');
            }
            $set[] = 'role_id = :role';
            $params['role'] = $role;
            $revoke = $revoke || (int) $rank < $targetRank;
            $changes['role'] = $role;
        }
        if (array_key_exists('homeShopId', $b)) {
            $home = $b['homeShopId'] === null || $b['homeShopId'] === '' ? null : (string) $b['homeShopId'];
            if ($home !== null && !$this->app->db->scalar('SELECT 1 FROM shops WHERE id = :s', ['s' => $home])) {
                throw new HttpException(422, 'invalid_shop');
            }
            $set[] = 'home_shop_id = :home';
            $params['home'] = $home;
            $revoke = true;
            $changes['homeShopId'] = $home;
        }
        if (array_key_exists('allShops', $b)) {
            $set[] = 'all_shops = :all';
            $params['all'] = !empty($b['allShops']) ? 1 : 0;
            $revoke = $revoke || empty($b['allShops']);
            $changes['allShops'] = (bool) $b['allShops'];
        }
        if (array_key_exists('isTestUser', $b)) {
            $set[] = 'is_test_user = :t';
            $params['t'] = !empty($b['isTestUser']) ? 1 : 0;
        }
        foreach (['vorname' => 80, 'nachname' => 80, 'anrede' => 16] as $f => $len) {
            if (array_key_exists($f, $b)) {
                $set[] = "$f = :$f";
                $params[$f] = mb_substr(trim((string) $b[$f]), 0, $len);
            }
        }
        if (array_key_exists('name', $b)) {
            $set[] = 'display_name = :dn';
            $params['dn'] = mb_substr(trim((string) $b['name']), 0, 120);
        }

        $this->app->db->tx(function () use ($set, $params, $b, $tid, &$revoke, &$changes) {
            if ($set) {
                $this->app->db->exec('UPDATE users SET ' . implode(', ', $set) . ' WHERE id = :id', $params);
            }
            if (array_key_exists('extraShopIds', $b)) {
                $ids = array_values(array_filter(array_map('strval', (array) $b['extraShopIds'])));
                if ($ids) {
                    [$in, $ip] = Db::in($ids, 's');
                    $known = array_column($this->app->db->all("SELECT id FROM shops WHERE id IN ($in)", $ip), 'id');
                    if (count($known) !== count(array_unique($ids))) {
                        throw new HttpException(422, 'invalid_shop');
                    }
                }
                $this->app->users->setExtraShops($tid, $ids);
                $revoke = true;
                $changes['extraShopIds'] = $ids;
            }
        });
        if ($revoke) {
            $this->app->session->revokeUser($tid);
        }
        $this->app->audit->log($p->id, 'user_updated', 'user', (string) $target['public_id'], null, $changes);
        $list = $this->app->users->listForAdmin(null);
        $u = array_values(array_filter($list, static fn ($x) => $x['id'] === $target['public_id']))[0] ?? null;
        return Response::json(['ok' => true, 'user' => $u]);
    }

    public function revokeSessions(Request $r): Response
    {
        $p = $this->app->principal();
        $target = $this->app->users->findByPublicId($r->param('id'));
        if (!$target) {
            throw new HttpException(404, 'not_found');
        }
        $this->app->users->assertCanManage($p, $target);
        $n = $this->app->session->revokeUser((int) $target['id']);
        $this->app->audit->log($p->id, 'sessions_revoked', 'user', (string) $target['public_id'], null, ['count' => $n]);
        return Response::json(['ok' => true, 'revoked' => $n]);
    }

    public function audit(Request $r): Response
    {
        $limit = max(1, min(500, (int) $r->q('limit', '200')));
        $rows = $this->app->db->all(
            'SELECT a.id, a.ts, a.action, a.entity, a.entity_id, a.shop_id, a.details, u.display_name AS actor
             FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT ' . $limit
        );
        foreach ($rows as &$row) {
            $row['details'] = $row['details'] !== null ? json_decode((string) $row['details'], true) : null;
        }
        return Response::json(['ok' => true, 'entries' => $rows]);
    }

    public function migrate(Request $r): Response
    {
        $p = $this->app->principal();
        if (!$this->app->config->allowWebMigrations()) {
            throw new HttpException(403, 'web_migrations_disabled');
        }
        $applied = (new Migrator($this->app->db, $this->app->appRoot . '/migrations'))->run();
        $this->app->audit->log($p->id, 'migrations_run', 'system', '', null, ['applied' => $applied]);
        return Response::json(['ok' => true, 'applied' => $applied]);
    }

    public function cleanup(Request $r): Response
    {
        $p = $this->app->principal();
        $res = (new \HeTec\PS\Maintenance($this->app))->run();
        $this->app->audit->log($p->id, 'cleanup_run', 'system', '', null, $res);
        return Response::json(['ok' => true] + $res);
    }
}
