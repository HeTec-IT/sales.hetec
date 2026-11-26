<?php
declare(strict_types=1);

namespace HeTec\PS\Auth;

use HeTec\PS\Http\HttpException;

/** Der angemeldete, freigegebene Benutzer mit seinen serverseitig ermittelten Rechten und Shops. */
final class Principal
{
    /**
     * @param list<string> $permissions
     * @param list<string> $shopIds      erlaubte Shops (bei allShops: alle aktiven)
     */
    public function __construct(
        public readonly int $id,
        public readonly string $publicId,
        public readonly string $email,
        public readonly string $displayName,
        public readonly string $roleId,
        public readonly int $roleRank,
        public readonly array $permissions,
        public readonly array $shopIds,
        public readonly ?string $homeShopId,
        public readonly bool $allShops,
        public readonly bool $isTestUser,
    ) {
    }

    public function can(string $permission): bool
    {
        return in_array($permission, $this->permissions, true);
    }

    public function require(string $permission): void
    {
        if (!$this->can($permission)) {
            throw new HttpException(403, 'forbidden');
        }
    }

    public function isAdmin(): bool
    {
        return $this->roleId === 'super_admin' || $this->roleId === 'admin';
    }

    public function hasShop(?string $shopId): bool
    {
        return $shopId !== null && $shopId !== '' && in_array($shopId, $this->shopIds, true);
    }

    public function requireShop(?string $shopId): void
    {
        if (!$this->hasShop($shopId)) {
            throw new HttpException(403, 'shop_forbidden');
        }
    }
}
