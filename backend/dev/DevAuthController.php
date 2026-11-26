<?php
declare(strict_types=1);

namespace HeTec\PS\Dev;

use HeTec\PS\App;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;

/**
 * NUR FÜR DIE LOKALE ENTWICKLUNG. Dieses Verzeichnis (backend/dev/) ist im Release-Artefakt NICHT enthalten
 * (scripts/build-release.mjs schließt es aus, tests/release prüft das).
 * Zusätzliche Sperren, falls es doch auf einen Server gelangt:
 *   1. env muss 'development' sein (Config verweigert Produktionswerte in dev-fremden Umgebungen),
 *   2. app_url muss auf localhost/127.0.0.1 zeigen,
 *   3. die Anfrage muss von der Loopback-Adresse kommen,
 *   4. nur E-Mails synthetischer Testbenutzer (@test.hetec-gmbh.de bzw. konfigurierte Dev-Domain).
 */
final class DevAuthController
{
    private const TEST_DOMAIN = 'hetec-gmbh.de';

    public function __construct(private App $app)
    {
        $host = (string) parse_url($app->config->appUrl(), PHP_URL_HOST);
        if (!$app->config->isDevelopment() || !in_array($host, ['localhost', '127.0.0.1'], true)) {
            throw new \RuntimeException('Dev-Login ist nur lokal verfügbar');
        }
    }

    private function guard(Request $r): void
    {
        if (!in_array($r->ip, ['127.0.0.1', '::1'], true)) {
            throw new HttpException(403, 'dev_login_local_only');
        }
    }

    public function login(Request $r): Response
    {
        $this->guard($r);
        $email = strtolower(trim((string) ($r->json()['email'] ?? '')));
        if (!preg_match('/^test\.[a-z0-9.-]+@' . preg_quote(self::TEST_DOMAIN, '/') . '$/', $email)) {
            throw new HttpException(422, 'only_synthetic_test_users');
        }
        $tenant = strtolower((string) $this->app->config->entra()['tenant_id']);
        $h = hash('sha256', 'dev-oid:' . $email);
        $oid = substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-4' . substr($h, 13, 3) . '-8' . substr($h, 17, 3) . '-' . substr($h, 20, 12);
        $local = explode('@', $email)[0];
        $parts = array_map('ucfirst', array_slice(explode('.', $local), 1));
        $url = $this->app->entra->establish([
            'tid' => $tenant, 'oid' => $oid, 'email' => $email,
            'name' => implode(' ', $parts), 'given' => $parts[0] ?? '', 'family' => $parts[1] ?? ($parts[0] ?? ''),
        ], (string) ($r->json()['returnTo'] ?? '/'));
        $this->app->resetPrincipal();
        return Response::json(['ok' => true, 'redirect' => $url]);
    }

    public function users(Request $r): Response
    {
        $this->guard($r);
        $rows = $this->app->db->all("SELECT email, display_name, role_id, status FROM users WHERE email LIKE 'test.%' ORDER BY role_id, email");
        return Response::json(['ok' => true, 'users' => $rows]);
    }
}
