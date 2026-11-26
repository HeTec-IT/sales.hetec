<?php
declare(strict_types=1);

namespace HeTec\PS\Security;

use HeTec\PS\Config;
use HeTec\PS\Db;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;

/**
 * Serverseitige Sitzungen in der Datenbank.
 * - Cookie enthält nur eine zufällige 256-Bit-ID; in der DB liegt nur deren SHA-256-Hash.
 * - HttpOnly, Secure, SameSite=Lax, Path=/ (mit __Host-Präfix in Produktion).
 * - Leerlauf- und absolute Laufzeit; serverseitig widerrufbar (Sperren eines Benutzers beendet alle Sitzungen).
 */
final class SessionManager
{
    private ?string $id = null;
    /** @var array<string,mixed> */
    private array $data = [];
    private bool $dirty = false;
    private bool $destroyed = false;
    private ?string $createdAt = null;
    private bool $loaded = false;

    public function __construct(private Db $db, private Config $config)
    {
    }

    public function load(Request $req): void
    {
        $this->loaded = true;
        $name = $this->config->session()['cookie_name'];
        $raw = $req->cookies[$name] ?? '';
        if (!preg_match('/^[a-f0-9]{64}$/', $raw)) {
            return;
        }
        $row = $this->db->one(
            'SELECT data, created_at FROM sessions WHERE id_hash = :h AND expires_at > UTC_TIMESTAMP(3)',
            ['h' => hash('sha256', $raw)]
        );
        if (!$row) {
            return;
        }
        $data = json_decode((string) $row['data'], true);
        $this->id = $raw;
        $this->data = is_array($data) ? $data : [];
        $this->createdAt = (string) $row['created_at'];
        $this->dirty = true; // last_seen/Leerlauf verlängern
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return $this->data[$key] ?? $default;
    }

    public function set(string $key, mixed $value): void
    {
        $this->data[$key] = $value;
        $this->dirty = true;
    }

    public function remove(string $key): void
    {
        unset($this->data[$key]);
        $this->dirty = true;
    }

    public function has(): bool
    {
        return $this->id !== null;
    }

    /** Neue Sitzungs-ID (z. B. nach erfolgreicher Anmeldung → Schutz vor Session Fixation). */
    public function regenerate(bool $keepData = false): void
    {
        if ($this->id !== null) {
            $this->db->exec('DELETE FROM sessions WHERE id_hash = :h', ['h' => hash('sha256', $this->id)]);
        }
        $this->id = Ids::token(32);
        $this->createdAt = null;
        if (!$keepData) {
            $this->data = [];
        }
        $this->dirty = true;
        $this->destroyed = false;
    }

    public function ensureStarted(): void
    {
        if ($this->id === null) {
            $this->regenerate(true);
        }
    }

    public function destroy(): void
    {
        if ($this->id !== null) {
            $this->db->exec('DELETE FROM sessions WHERE id_hash = :h', ['h' => hash('sha256', $this->id)]);
        }
        $this->id = null;
        $this->data = [];
        $this->destroyed = true;
        $this->dirty = false;
    }

    public function csrfToken(): string
    {
        $t = (string) $this->get('csrf', '');
        if ($t === '') {
            $t = Ids::token(32);
            $this->set('csrf', $t);
        }
        return $t;
    }

    public function persist(Response $res, string $userAgent = ''): void
    {
        $s = $this->config->session();
        $cookieName = $s['cookie_name'];
        if ($this->destroyed) {
            $this->addCookie($res, $cookieName, '', time() - 3600);
            return;
        }
        if ($this->id === null || !$this->dirty) {
            return;
        }
        $idle = $s['idle_minutes'] * 60;
        $absolute = $s['absolute_hours'] * 3600;
        $created = $this->createdAt !== null ? (int) strtotime($this->createdAt . ' UTC') : time();
        $expires = min(time() + $idle, $created + $absolute);
        if ($expires <= time()) {
            $this->destroy();
            $this->addCookie($res, $cookieName, '', time() - 3600);
            return;
        }
        $userId = $this->get('uid');
        $this->db->exec(
            'INSERT INTO sessions (id_hash, user_id, data, created_at, last_seen_at, expires_at, user_agent)
             VALUES (:h, :u, :d, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), :e, :ua)
             ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), data = VALUES(data), last_seen_at = UTC_TIMESTAMP(3), expires_at = VALUES(expires_at)',
            [
                'h' => hash('sha256', $this->id),
                'u' => is_int($userId) ? $userId : null,
                'd' => json_encode($this->data, JSON_THROW_ON_ERROR),
                'e' => gmdate('Y-m-d H:i:s', $expires),
                'ua' => mb_substr($userAgent, 0, 200),
            ]
        );
        $this->addCookie($res, $cookieName, $this->id, $created + $absolute);
    }

    private function addCookie(Response $res, string $name, string $value, int $expires): void
    {
        $secure = !$this->config->isDevelopment() || str_starts_with($this->config->appUrl(), 'https://');
        if (str_starts_with($name, '__Host-') && !$secure) {
            throw new \RuntimeException('__Host-Cookies erfordern HTTPS');
        }
        $parts = [
            rawurlencode($name) . '=' . rawurlencode($value),
            'Expires=' . gmdate('D, d M Y H:i:s \G\M\T', $expires),
            'Path=/',
            'HttpOnly',
            'SameSite=Lax',
        ];
        if ($secure) {
            $parts[] = 'Secure';
        }
        $res->headers['Set-Cookie'] = implode('; ', $parts);
    }

    /** Alle Sitzungen eines Benutzers beenden (Sperre, Rechteentzug, „überall abmelden“). */
    public function revokeUser(int $userId): int
    {
        return $this->db->exec('DELETE FROM sessions WHERE user_id = :u', ['u' => $userId]);
    }
}
