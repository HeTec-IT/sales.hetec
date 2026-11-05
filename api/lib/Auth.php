<?php
declare(strict_types=1);

namespace PS;

// Benutzerkontext einer Anfrage (aus den Entra-Gruppen im Token)
final class Ctx
{
    public string $uid = '';
    public string $email = '';
    public string $name = '';
    public string $given = '';
    public string $family = '';
    public bool $isAdmin = false;
    public bool $isRegional = false;
    public bool $isStaff = false;
    public bool $allShops = false;
    public bool $active = false;
    /** @var string[] */
    public array $shops = [];
    public string $home = '';
    public string $reason = '';
    /** @var string[] */
    public array $ownUids = [];
    public bool $legacyLoaded = false;
}

final class Auth
{
    private Config $cfg;

    public function __construct(Config $cfg) { $this->cfg = $cfg; }

    // ------------------------------------------------------------ Token ----
    private static function b64u(string $s): string
    {
        $r = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
        if ($r === false) throw new \RuntimeException('base64');
        return $r;
    }

    private static function asn1Len(int $l): string
    {
        if ($l < 128) return chr($l);
        $b = '';
        while ($l > 0) { $b = chr($l & 0xff) . $b; $l >>= 8; }
        return chr(0x80 | strlen($b)) . $b;
    }

    private static function asn1Int(string $bin): string
    {
        $bin = ltrim($bin, "\0");
        if ($bin === '' || ord($bin[0]) > 127) $bin = "\0" . $bin;
        return "\x02" . self::asn1Len(strlen($bin)) . $bin;
    }

    private static function asn1Seq(string $c): string { return "\x30" . self::asn1Len(strlen($c)) . $c; }

    // RSA-Schluessel (JWK: n, e) -> PEM fuer openssl_verify
    public static function jwkToPem(string $n, string $e): string
    {
        $rsaPub = self::asn1Seq(self::asn1Int(self::b64u($n)) . self::asn1Int(self::b64u($e)));
        $bit = "\x03" . self::asn1Len(strlen($rsaPub) + 1) . "\x00" . $rsaPub;
        $algo = hex2bin('300d06092a864886f70d0101010500');
        $spki = self::asn1Seq($algo . $bit);
        return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($spki), 64, "\n") . "-----END PUBLIC KEY-----\n";
    }

    private function jwksUrl(): string
    {
        return $this->cfg->jwksUrl !== '' ? $this->cfg->jwksUrl
            : 'https://login.microsoftonline.com/' . $this->cfg->tenantId . '/discovery/v2.0/keys';
    }

    private function cacheFile(): string
    {
        $dir = $this->cfg->cacheDir !== '' ? $this->cfg->cacheDir : dirname(__DIR__) . '/cache';
        if (!is_dir($dir)) @mkdir($dir, 0750, true);
        if (!is_dir($dir) || !is_writable($dir)) $dir = sys_get_temp_dir();
        return rtrim($dir, '/\\') . '/ps-jwks-' . md5($this->jwksUrl()) . '.json';
    }

    private function download(string $url): ?string
    {
        if (strpos($url, 'https://') !== 0) {
            $p = strpos($url, 'file://') === 0 ? substr($url, 7) : $url; // lokale Datei (Tests)
            $s = is_file($p) ? file_get_contents($p) : false;
            return $s === false ? null : $s;
        }
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_FOLLOWLOCATION => false]);
            $s = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            return ($s !== false && $code === 200) ? (string)$s : null;
        }
        $s = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 8]]));
        return $s === false ? null : $s;
    }

    // Schluessel zur kid: aus dem Zwischenspeicher (6 h), bei unbekannter kid hoechstens alle 30 s neu laden
    private function key(string $kid): ?string
    {
        $file = $this->cacheFile();
        $keys = null;
        $age = is_file($file) ? time() - (int)filemtime($file) : PHP_INT_MAX;
        if ($age < 6 * 3600) {
            $j = json_decode((string)@file_get_contents($file), true);
            if (is_array($j)) $keys = $j;
        }
        if (($keys === null || !isset($keys[$kid])) && ($keys === null || $age > 30)) {
            $raw = $this->download($this->jwksUrl());
            $j = $raw !== null ? json_decode($raw, true) : null;
            if (is_array($j) && isset($j['keys']) && is_array($j['keys'])) {
                $keys = [];
                foreach ($j['keys'] as $k) {
                    if (($k['kty'] ?? '') === 'RSA' && isset($k['kid'], $k['n'], $k['e'])) $keys[(string)$k['kid']] = [(string)$k['n'], (string)$k['e']];
                }
                @file_put_contents($file . '.tmp', json_encode($keys), LOCK_EX);
                @rename($file . '.tmp', $file);
            } elseif ($keys === null && is_file($file)) {
                // Microsoft nicht erreichbar: alten Zwischenspeicher weiter nutzen
                $old = json_decode((string)@file_get_contents($file), true);
                if (is_array($old)) $keys = $old;
            }
        }
        if (!is_array($keys) || !isset($keys[$kid])) return null;
        return self::jwkToPem($keys[$kid][0], $keys[$kid][1]);
    }

    // Erreicht der Server die Microsoft-Schluessel? (Einrichtungs-Check)
    public function keysReachable(): bool
    {
        $raw = $this->download($this->jwksUrl());
        $j = $raw !== null ? json_decode($raw, true) : null;
        return is_array($j) && !empty($j['keys']);
    }

    // Prueft das Microsoft-Entra-ID-Token (RS256, Aussteller = eigener Tenant, Zielgruppe = Client-ID)
    public function verify(string $token): \stdClass
    {
        $fail = fn() => E::unauth('Login-Token ungueltig oder abgelaufen.');
        if ($this->cfg->tenantId === '' || $this->cfg->clientId === '') throw E::unavailable('Server nicht konfiguriert (Tenant/Client fehlen).');
        if (strlen($token) > 12000) throw $fail();
        $parts = explode('.', $token);
        if (count($parts) !== 3) throw $fail();
        try {
            $head = json_decode(self::b64u($parts[0]));
            $claims = json_decode(self::b64u($parts[1]));
            $sig = self::b64u($parts[2]);
        } catch (\Throwable $e) { throw $fail(); }
        if (!($head instanceof \stdClass) || !($claims instanceof \stdClass)) throw $fail();
        if (($head->alg ?? '') !== 'RS256' || !is_string($head->kid ?? null)) throw $fail();
        $pem = $this->key($head->kid);
        if ($pem === null) throw $fail();
        if (openssl_verify($parts[0] . '.' . $parts[1], $sig, $pem, OPENSSL_ALGO_SHA256) !== 1) throw $fail();

        $now = time();
        $aud = $claims->aud ?? null;
        $audOk = is_string($aud) ? strtolower($aud) === $this->cfg->clientId : (is_array($aud) && in_array($this->cfg->clientId, array_map('strtolower', array_map('strval', $aud)), true));
        if (!$audOk) throw $fail();
        if (($claims->iss ?? '') !== 'https://login.microsoftonline.com/' . $this->cfg->tenantId . '/v2.0') throw $fail();
        if (strtolower((string)($claims->tid ?? '')) !== $this->cfg->tenantId) throw $fail();
        if (!is_numeric($claims->exp ?? null) || (float)$claims->exp < $now - 30) throw $fail();
        if (isset($claims->nbf) && is_numeric($claims->nbf) && (float)$claims->nbf > $now + 30) throw $fail();
        if (empty($claims->oid) && empty($claims->sub)) throw $fail();
        return $claims;
    }

    // -------------------------------------------------------- Rollen -------
    // Rollen und Standorte kommen NUR aus den Entra-Gruppen im Token.
    public function context(\stdClass $claims): Ctx
    {
        $cfg = $this->cfg;
        $email = mb_strtolower(trim((string)($claims->preferred_username ?? $claims->email ?? $claims->upn ?? '')), 'UTF-8');
        $groups = [];
        if (isset($claims->groups) && is_array($claims->groups)) foreach ($claims->groups as $g) $groups[] = mb_strtolower((string)$g, 'UTF-8');
        $overage = isset($claims->_claim_names) && $claims->_claim_names instanceof \stdClass && isset($claims->_claim_names->groups);
        $inAny = function (array $ids) use ($groups): bool {
            foreach ($ids as $g) if (in_array($g, $groups, true)) return true;
            return false;
        };
        $c = new Ctx();
        $c->isAdmin = $inAny($cfg->groups['admin']) || in_array($email, $cfg->adminEmails, true);
        $c->isRegional = $inAny($cfg->groups['regional']);
        $springer = $inAny($cfg->groups['springer']);
        $shops = [];
        foreach ($cfg->groups['shops'] as $gid => $shop) if (in_array((string)$gid, $groups, true) && !in_array($shop, $shops, true)) $shops[] = $shop;
        $domainOk = $cfg->allowedDomain !== '' && str_ends_with($email, '@' . $cfg->allowedDomain);
        $member = $c->isAdmin || $c->isRegional || $springer || count($shops) > 0;
        $c->active = $domainOk && $member;
        $c->reason = '';
        if (!$domainOk) $c->reason = 'domain';
        elseif (!$member) $c->reason = $overage ? 'groups-overage' : 'no-group';
        $uid = (string)(!empty($claims->oid) ? $claims->oid : $claims->sub);
        $c->uid = $uid;
        $c->email = $email;
        $c->name = trim((string)($claims->name ?? ''));
        $c->given = trim((string)($claims->given_name ?? ''));
        $c->family = trim((string)($claims->family_name ?? ''));
        $c->isStaff = $c->isAdmin || $c->isRegional;
        $c->allShops = $c->isAdmin || $c->isRegional || $springer;
        $c->shops = $shops;
        $c->home = $shops[0] ?? '';
        $c->ownUids = [$uid];
        return $c;
    }

    public static function canShop(?Ctx $ctx, $shopId): bool
    {
        $s = mb_strtolower(trim(Val::truthy($shopId) ? Val::jsString($shopId) : ''), 'UTF-8');
        if ($ctx === null || !$ctx->active || $s === '') return false;
        return $ctx->allShops || in_array($s, $ctx->shops, true);
    }
}
