<?php
declare(strict_types=1);

namespace HeTec\PS\Security;

use HeTec\PS\Db;
use HeTec\PS\Http\HttpException;

/** Einfaches Festfenster-Rate-Limit in der DB (funktioniert ohne Redis/APCu auf klassischem Webhosting). */
final class RateLimiter
{
    public function __construct(private Db $db)
    {
    }

    public function hit(string $key, int $max, int $windowSeconds): void
    {
        $window = intdiv(time(), $windowSeconds) * $windowSeconds;
        $k = hash('sha256', $key);
        $this->db->exec(
            'INSERT INTO rate_limits (rl_key, window_start, hits) VALUES (:k, :w, 1) ON DUPLICATE KEY UPDATE hits = hits + 1',
            ['k' => $k, 'w' => $window]
        );
        $hits = (int) $this->db->scalar('SELECT hits FROM rate_limits WHERE rl_key = :k AND window_start = :w', ['k' => $k, 'w' => $window]);
        if (random_int(1, 200) === 1) {
            $this->db->exec('DELETE FROM rate_limits WHERE window_start < :t', ['t' => time() - 86400]);
        }
        if ($hits > $max) {
            throw new HttpException(429, 'rate_limited', ['retryAfter' => $window + $windowSeconds - time()]);
        }
    }
}
