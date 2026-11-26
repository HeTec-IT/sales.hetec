<?php
declare(strict_types=1);

namespace HeTec\PS;

/**
 * Lädt und validiert die Konfiguration. Unsichere Produktionskonfigurationen werden abgelehnt
 * (Platzhalter, fehlendes HTTPS, Dev-Modus mit produktiver Domain …).
 */
final class Config
{
    /** @param array<string,mixed> $data */
    private function __construct(private array $data)
    {
    }

    public static function load(string $appRoot): self
    {
        $file = getenv('PS_CONFIG_FILE') ?: $appRoot . '/config/config.php';
        if (is_file($file)) {
            $data = require $file;
            if (!is_array($data)) {
                throw new \RuntimeException('config.php muss ein Array zurückgeben');
            }
        } else {
            $data = self::fromEnv();
        }
        $cfg = new self($data);
        $cfg->validate();
        return $cfg;
    }

    /** @return array<string,mixed> */
    private static function fromEnv(): array
    {
        $e = static fn (string $k, string $d = ''): string => (string) (getenv($k) !== false ? getenv($k) : $d);
        return [
            'env' => $e('PS_ENV', 'production'),
            'app_url' => $e('PS_APP_URL', 'https://ps.hetec.de'),
            'allowed_origins' => array_filter(explode(',', $e('PS_ALLOWED_ORIGINS', $e('PS_APP_URL', 'https://ps.hetec.de')))),
            'db' => ['dsn' => $e('PS_DB_DSN'), 'user' => $e('PS_DB_USER'), 'password' => $e('PS_DB_PASSWORD')],
            'entra' => [
                'tenant_id' => $e('PS_ENTRA_TENANT_ID'),
                'client_id' => $e('PS_ENTRA_CLIENT_ID'),
                'client_secret' => $e('PS_ENTRA_CLIENT_SECRET'),
                'redirect_uri' => $e('PS_ENTRA_REDIRECT_URI'),
                'post_logout_redirect_uri' => $e('PS_ENTRA_POST_LOGOUT_URI'),
                'allowed_domains' => array_filter(explode(',', $e('PS_ENTRA_ALLOWED_DOMAINS', 'hetec-gmbh.de'))),
                'reject_guests' => $e('PS_ENTRA_REJECT_GUESTS', '1') === '1',
                'authority_override' => $e('PS_ENTRA_AUTHORITY_OVERRIDE'),
            ],
            'data_key' => $e('PS_DATA_KEY'),
            'index_key' => $e('PS_INDEX_KEY'),
            'session' => [
                'cookie_name' => $e('PS_SESSION_COOKIE', '__Host-ps_sid'),
                'idle_minutes' => (int) $e('PS_SESSION_IDLE_MIN', '480'),
                'absolute_hours' => (int) $e('PS_SESSION_ABS_H', '12'),
                'offline_grace_hours' => (int) $e('PS_OFFLINE_GRACE_H', '12'),
            ],
            'bootstrap_super_admins' => array_filter(explode(',', $e('PS_BOOTSTRAP_SUPER_ADMINS'))),
            'storage_dir' => $e('PS_STORAGE_DIR', sys_get_temp_dir() . '/ps-storage'),
            'archive_flow' => ['url' => $e('PS_ARCHIVE_FLOW_URL'), 'shared_secret' => $e('PS_ARCHIVE_FLOW_SECRET')],
            'allow_web_migrations' => $e('PS_ALLOW_WEB_MIGRATIONS') === '1',
        ];
    }

    private function validate(): void
    {
        $env = $this->env();
        if (!in_array($env, ['production', 'staging', 'development'], true)) {
            throw new \RuntimeException('Ungültige Umgebung: ' . $env);
        }
        foreach (['data_key', 'index_key'] as $k) {
            $raw = base64_decode((string) ($this->data[$k] ?? ''), true);
            if ($raw === false || strlen($raw) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
                throw new \RuntimeException("Konfiguration '$k' fehlt oder ist kein base64-kodierter 32-Byte-Schlüssel");
            }
        }
        if ($this->data['data_key'] === $this->data['index_key']) {
            throw new \RuntimeException('data_key und index_key müssen verschieden sein');
        }
        if ($env !== 'development') {
            if (!str_starts_with($this->appUrl(), 'https://')) {
                throw new \RuntimeException('app_url muss in Produktion/Staging HTTPS verwenden');
            }
            $entra = $this->entra();
            if (($entra['authority_override'] ?? '') !== '') {
                throw new \RuntimeException('entra.authority_override ist nur in der Entwicklung erlaubt');
            }
            foreach (['tenant_id', 'client_id'] as $k) {
                if (!preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', (string) ($entra[$k] ?? ''))
                    || $entra[$k] === '00000000-0000-0000-0000-000000000000') {
                    throw new \RuntimeException("entra.$k ist nicht gesetzt");
                }
            }
            if (str_contains((string) ($entra['client_secret'] ?? ''), 'PLATZHALTER') || ($entra['client_secret'] ?? '') === '') {
                throw new \RuntimeException('entra.client_secret ist nicht gesetzt');
            }
            if (!str_starts_with((string) $entra['redirect_uri'], 'https://')) {
                throw new \RuntimeException('entra.redirect_uri muss HTTPS verwenden');
            }
        }
    }

    public function env(): string
    {
        return (string) ($this->data['env'] ?? 'production');
    }

    public function isDevelopment(): bool
    {
        return $this->env() === 'development';
    }

    public function appUrl(): string
    {
        return rtrim((string) ($this->data['app_url'] ?? ''), '/');
    }

    /** @return list<string> */
    public function allowedOrigins(): array
    {
        $o = $this->data['allowed_origins'] ?? [];
        return array_values(array_map(static fn ($v) => rtrim((string) $v, '/'), is_array($o) ? $o : []));
    }

    /** @return array{dsn:string,user:string,password:string} */
    public function db(): array
    {
        $d = $this->data['db'] ?? [];
        return ['dsn' => (string) ($d['dsn'] ?? ''), 'user' => (string) ($d['user'] ?? ''), 'password' => (string) ($d['password'] ?? '')];
    }

    /** @return array<string,mixed> */
    public function entra(): array
    {
        return (array) ($this->data['entra'] ?? []);
    }

    public function dataKey(): string
    {
        return (string) base64_decode((string) $this->data['data_key'], true);
    }

    public function indexKey(): string
    {
        return (string) base64_decode((string) $this->data['index_key'], true);
    }

    /** @return array{cookie_name:string,idle_minutes:int,absolute_hours:int,offline_grace_hours:int} */
    public function session(): array
    {
        $s = (array) ($this->data['session'] ?? []);
        return [
            'cookie_name' => (string) ($s['cookie_name'] ?? '__Host-ps_sid'),
            'idle_minutes' => max(5, (int) ($s['idle_minutes'] ?? 480)),
            'absolute_hours' => max(1, (int) ($s['absolute_hours'] ?? 12)),
            'offline_grace_hours' => max(0, min(72, (int) ($s['offline_grace_hours'] ?? 12))),
        ];
    }

    /** @return list<string> */
    public function bootstrapSuperAdmins(): array
    {
        return array_values(array_map(static fn ($v) => strtolower(trim((string) $v)), (array) ($this->data['bootstrap_super_admins'] ?? [])));
    }

    public function storageDir(): string
    {
        return rtrim((string) ($this->data['storage_dir'] ?? ''), '/');
    }

    /** @return array{url:string,shared_secret:string} */
    public function archiveFlow(): array
    {
        $a = (array) ($this->data['archive_flow'] ?? []);
        return ['url' => (string) ($a['url'] ?? ''), 'shared_secret' => (string) ($a['shared_secret'] ?? '')];
    }

    public function allowWebMigrations(): bool
    {
        return (bool) ($this->data['allow_web_migrations'] ?? false);
    }
}
