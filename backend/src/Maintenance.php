<?php
declare(strict_types=1);

namespace HeTec\PS;

/**
 * Datenschutz-Aufräumen (Löschkonzept). Läuft per Cronjob (bin/cleanup.php) oder über die Admin-API.
 *  - abgelaufene Angebote (30 Tage), Downloads (24 h), Sitzungen
 *  - Rate-Limit-Zähler > 1 Tag
 *  - Audit-Protokoll > 400 Tage
 */
final class Maintenance
{
    public function __construct(private App $app)
    {
    }

    /** @return array<string,int> */
    public function run(): array
    {
        $db = $this->app->db;
        $res = [
            'offers' => $db->exec('DELETE FROM saved_offers WHERE expires_at <= UTC_TIMESTAMP(3)'),
            'sessions' => $db->exec('DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP(3)'),
            'rateLimits' => $db->exec('DELETE FROM rate_limits WHERE window_start < :t', ['t' => time() - 86400]),
            'audit' => $db->exec('DELETE FROM audit_log WHERE ts < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 400 DAY)'),
        ];
        $res['downloads'] = (new Controller\DownloadController($this->app))->cleanup();
        return $res;
    }
}
