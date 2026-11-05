<?php
declare(strict_types=1);

namespace PS;

// Einstellungen aus api/config.php (siehe config.beispiel.php). Keine Geheimnisse im Code.
final class Config
{
    public string $tenantId = '';
    public string $clientId = '';
    public string $allowedDomain = 'hetec-gmbh.de';
    /** @var string[] */
    public array $adminEmails = [];
    /** @var array{admin:string[],regional:string[],springer:string[],shops:array<string,string>} */
    public array $groups = ['admin' => [], 'regional' => [], 'springer' => [], 'shops' => []];
    public array $db = [];
    public string $jwksUrl = '';
    public string $cacheDir = '';

    private static function lowerList($v): array
    {
        $out = [];
        foreach ((is_array($v) ? $v : []) as $x) {
            $s = mb_strtolower(trim((string)$x), 'UTF-8');
            if ($s !== '') $out[] = $s;
        }
        return $out;
    }

    public static function fromArray(array $a): Config
    {
        $c = new Config();
        $c->tenantId = mb_strtolower(trim((string)($a['tenant_id'] ?? '')), 'UTF-8');
        $c->clientId = mb_strtolower(trim((string)($a['client_id'] ?? '')), 'UTF-8');
        $dom = mb_strtolower(trim((string)($a['allowed_domain'] ?? 'hetec-gmbh.de')), 'UTF-8');
        $c->allowedDomain = $dom;
        $c->adminEmails = self::lowerList($a['admin_emails'] ?? []);
        $g = is_array($a['groups'] ?? null) ? $a['groups'] : [];
        $shops = [];
        foreach ((is_array($g['shops'] ?? null) ? $g['shops'] : []) as $gid => $shop) {
            $gid = mb_strtolower(trim((string)$gid), 'UTF-8');
            $shop = mb_strtolower(trim((string)$shop), 'UTF-8');
            if ($gid !== '' && $shop !== '') $shops[$gid] = $shop;
        }
        $c->groups = [
            'admin' => self::lowerList($g['admin'] ?? []),
            'regional' => self::lowerList($g['regional'] ?? []),
            'springer' => self::lowerList($g['springer'] ?? []),
            'shops' => $shops,
        ];
        $c->db = is_array($a['db'] ?? null) ? $a['db'] : [];
        $c->jwksUrl = trim((string)($a['jwks_url'] ?? ''));
        $c->cacheDir = trim((string)($a['cache_dir'] ?? ''));
        return $c;
    }

    // Pfad: Umgebungsvariable PS_CONFIG_FILE (Tests) oder api/config.php
    public static function load(?string $file = null): Config
    {
        $file = $file ?: (getenv('PS_CONFIG_FILE') ?: dirname(__DIR__) . '/config.php');
        if (!is_file($file)) throw E::unavailable('Server nicht eingerichtet: api/config.php fehlt.');
        $a = require $file;
        if (!is_array($a)) throw E::unavailable('api/config.php ist ungueltig.');
        return self::fromArray($a);
    }
}
