<?php
declare(strict_types=1);

namespace HeTec\PS;

use HeTec\PS\Security\Crypto;

/** Audit-Protokoll. Niemals Kundendaten, Tokens oder Passwörter in $details schreiben. */
final class Audit
{
    private string $ipHash = '';

    public function __construct(private Db $db, private Crypto $crypto)
    {
    }

    public function setIp(string $ip): void
    {
        $this->ipHash = $this->crypto->hashIp($ip);
    }

    /** @param array<string,mixed> $details */
    public function log(?int $actor, string $action, string $entity = '', string $entityId = '', ?string $shopId = null, array $details = []): void
    {
        $this->db->exec(
            'INSERT INTO audit_log (actor_user_id, action, entity, entity_id, shop_id, ip_hash, details) VALUES (:a, :ac, :e, :ei, :s, :ip, :d)',
            [
                'a' => $actor,
                'ac' => mb_substr($action, 0, 64),
                'e' => mb_substr($entity, 0, 64),
                'ei' => mb_substr($entityId, 0, 190),
                's' => $shopId,
                'ip' => $this->ipHash,
                'd' => $details ? json_encode($details, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) : null,
            ]
        );
    }
}
