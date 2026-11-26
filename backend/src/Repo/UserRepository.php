<?php
declare(strict_types=1);

namespace HeTec\PS\Repo;

use HeTec\PS\Auth\Principal;
use HeTec\PS\Db;
use HeTec\PS\Security\Ids;

final class UserRepository
{
    public function __construct(private Db $db)
    {
    }

    /** @return array<string,mixed>|null */
    public function findByEntra(string $tenantId, string $objectId): ?array
    {
        return $this->db->one(
            'SELECT * FROM users WHERE entra_tenant_id = :t AND entra_object_id = :o AND deleted_at IS NULL',
            ['t' => strtolower($tenantId), 'o' => strtolower($objectId)]
        );
    }

    /** @return array<string,mixed>|null */
    public function findById(int $id): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE id = :id AND deleted_at IS NULL', ['id' => $id]);
    }

    /** @return array<string,mixed>|null */
    public function findByPublicId(string $publicId): ?array
    {
        return $this->db->one('SELECT * FROM users WHERE public_id = :p AND deleted_at IS NULL', ['p' => $publicId]);
    }

    /**
     * Migrierte Benutzer (aus Firestore) haben noch keine Entra-Identität. Kandidat nur, wenn genau ein
     * unverknüpfter, nicht gelöschter Datensatz mit derselben E-Mail existiert. Die E-Mail (UPN) ist veränderlich
     * und kein Berechtigungsmerkmal: Die Verknüpfung setzt das Konto daher auf 'pending' – erst die Freigabe
     * durch einen Admin aktiviert Rolle, Shops und Historie (siehe EntraLogin::establish).
     * @return array<string,mixed>|null
     */
    public function findLinkableLegacy(string $email): ?array
    {
        $rows = $this->db->all(
            'SELECT * FROM users WHERE email = :e AND entra_object_id IS NULL AND legacy_firebase_uid IS NOT NULL AND deleted_at IS NULL',
            ['e' => strtolower($email)]
        );
        return count($rows) === 1 ? $rows[0] : null;
    }

    public function linkEntra(int $userId, string $tenantId, string $objectId, bool $keepApproved = false): void
    {
        // Freigegebene Altkonten werden nach der Verknüpfung erneut zur Freigabe vorgelegt (gesperrte bleiben gesperrt).
        // Ausnahme: in der Server-Konfiguration hinterlegte Hauptadmins (bootstrap_super_admins), sonst gäbe es niemanden,
        // der die übrigen Konten freigeben kann.
        $this->db->exec(
            "UPDATE users SET entra_tenant_id = :t, entra_object_id = :o,
                    status = IF(status = 'approved' AND :keep = 0, 'pending', status)
              WHERE id = :id AND entra_object_id IS NULL",
            ['t' => strtolower($tenantId), 'o' => strtolower($objectId), 'id' => $userId, 'keep' => $keepApproved ? 1 : 0]
        );
    }

    /**
     * Rangregel für alle Eingriffe in fremde Konten (Rechte, Sitzungen, Skip-Limits):
     * nur Hauptadministratoren oder Benutzer mit höherem Rang als das Zielkonto; nie das eigene Konto.
     * @param array<string,mixed> $target
     */
    public function assertCanManage(\HeTec\PS\Auth\Principal $p, array $target): void
    {
        if ((int) $target['id'] === $p->id) {
            throw new \HeTec\PS\Http\HttpException(403, 'cannot_modify_self');
        }
        if ($p->roleId === 'super_admin') {
            return;
        }
        $rank = (int) $this->db->scalar('SELECT rank_level FROM roles WHERE id = :r', ['r' => $target['role_id']]);
        if ($rank >= $p->roleRank) {
            throw new \HeTec\PS\Http\HttpException(403, 'insufficient_rank');
        }
    }

    public function hasActiveSuperAdmin(): bool
    {
        // nur mit Microsoft verknüpfte Hauptadmins zählen (migrierte, noch unverknüpfte können sich noch nicht anmelden)
        return (int) $this->db->scalar("SELECT COUNT(*) FROM users WHERE role_id = 'super_admin' AND status = 'approved'
            AND entra_object_id IS NOT NULL AND deleted_at IS NULL") > 0;
    }

    /** @param array{email:string,display_name:string,vorname:string,nachname:string} $p */
    public function createPending(string $tenantId, string $objectId, array $p, string $roleId = 'mitarbeiter', string $status = 'pending'): int
    {
        $this->db->exec(
            'INSERT INTO users (public_id, entra_tenant_id, entra_object_id, email, display_name, vorname, nachname, role_id, status)
             VALUES (:pid, :t, :o, :e, :dn, :vn, :nn, :r, :s)',
            [
                'pid' => Ids::ulid(),
                't' => strtolower($tenantId),
                'o' => strtolower($objectId),
                'e' => strtolower($p['email']),
                'dn' => mb_substr($p['display_name'], 0, 120),
                'vn' => mb_substr($p['vorname'], 0, 80),
                'nn' => mb_substr($p['nachname'], 0, 80),
                'r' => $roleId,
                's' => $status,
            ]
        );
        return $this->db->lastId();
    }

    public function touchLogin(int $id, string $email): void
    {
        $this->db->exec('UPDATE users SET last_login_at = UTC_TIMESTAMP(3), email = :e WHERE id = :id', ['id' => $id, 'e' => strtolower($email)]);
    }

    /** Lädt den Benutzer inkl. Rechten und Shops. Gibt null zurück, wenn er nicht (mehr) freigegeben ist. */
    public function principal(int $id): ?Principal
    {
        $u = $this->db->one(
            'SELECT u.*, r.rank_level FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id AND u.deleted_at IS NULL',
            ['id' => $id]
        );
        if (!$u || $u['status'] !== 'approved') {
            return null;
        }
        $perms = array_column($this->db->all('SELECT permission_id FROM role_permissions WHERE role_id = :r', ['r' => $u['role_id']]), 'permission_id');
        $isAdmin = in_array($u['role_id'], ['super_admin', 'admin'], true);
        if ($isAdmin || (int) $u['all_shops'] === 1) {
            $shops = array_column($this->db->all('SELECT id FROM shops WHERE active = 1 ORDER BY id'), 'id');
        } else {
            $shops = array_column($this->db->all(
                'SELECT s.id FROM shops s WHERE s.active = 1 AND (s.id = :h OR s.id IN (SELECT shop_id FROM user_shops WHERE user_id = :u)) ORDER BY s.id',
                ['h' => $u['home_shop_id'], 'u' => $id]
            ), 'id');
        }
        return new Principal(
            (int) $u['id'],
            (string) $u['public_id'],
            (string) $u['email'],
            (string) $u['display_name'],
            (string) $u['role_id'],
            (int) $u['rank_level'],
            array_values(array_map('strval', $perms)),
            array_values(array_map('strval', $shops)),
            $u['home_shop_id'] !== null ? (string) $u['home_shop_id'] : null,
            (int) $u['all_shops'] === 1 || $isAdmin,
            (int) $u['is_test_user'] === 1,
        );
    }

    /** @return list<array<string,mixed>> */
    public function listForAdmin(?array $restrictShops = null): array
    {
        $sql = 'SELECT u.public_id, u.email, u.display_name, u.anrede, u.vorname, u.nachname, u.role_id, u.status, u.all_shops,
                       u.home_shop_id, u.is_test_user, u.created_at, u.last_login_at, u.approved_at,
                       (u.entra_object_id IS NOT NULL) AS entra_linked,
                       (SELECT GROUP_CONCAT(shop_id ORDER BY shop_id) FROM user_shops us WHERE us.user_id = u.id) AS extra_shops
                FROM users u WHERE u.deleted_at IS NULL';
        $params = [];
        if ($restrictShops !== null) {
            [$in1, $p1] = Db::in($restrictShops, 'sa');
            [$in2, $p2] = Db::in($restrictShops, 'sb');
            $params = $p1 + $p2;
            $sql .= " AND (u.home_shop_id IN ($in1) OR u.id IN (SELECT user_id FROM user_shops WHERE shop_id IN ($in2)))";
        }
        $sql .= ' ORDER BY u.status = \'pending\' DESC, u.display_name';
        return array_map(static function (array $r): array {
            return [
                'id' => $r['public_id'],
                'email' => $r['email'],
                'name' => $r['display_name'],
                'anrede' => $r['anrede'],
                'vorname' => $r['vorname'],
                'nachname' => $r['nachname'],
                'role' => $r['role_id'],
                'status' => $r['status'],
                'allShops' => (int) $r['all_shops'] === 1,
                'homeShopId' => $r['home_shop_id'],
                'extraShopIds' => $r['extra_shops'] ? explode(',', (string) $r['extra_shops']) : [],
                'isTestUser' => (int) $r['is_test_user'] === 1,
                'entraLinked' => (int) $r['entra_linked'] === 1,
                'createdAt' => $r['created_at'],
                'lastLoginAt' => $r['last_login_at'],
                'approvedAt' => $r['approved_at'],
            ];
        }, $this->db->all($sql, $params));
    }

    /** @param list<string> $shopIds */
    public function setExtraShops(int $userId, array $shopIds): void
    {
        $this->db->exec('DELETE FROM user_shops WHERE user_id = :u', ['u' => $userId]);
        foreach (array_unique($shopIds) as $s) {
            $this->db->exec('INSERT INTO user_shops (user_id, shop_id) VALUES (:u, :s)', ['u' => $userId, 's' => $s]);
        }
    }

    public function idByDisplayName(string $name): ?int
    {
        $rows = $this->db->all('SELECT id FROM users WHERE display_name = :n AND deleted_at IS NULL', ['n' => $name]);
        return count($rows) === 1 ? (int) $rows[0]['id'] : null;
    }
}
