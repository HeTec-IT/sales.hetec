<?php
declare(strict_types=1);

namespace HeTec\PS;

use HeTec\PS\Auth\EntraLogin;
use HeTec\PS\Auth\Principal;
use HeTec\PS\Controller;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;
use HeTec\PS\Http\Router;
use HeTec\PS\Repo\UserRepository;
use HeTec\PS\Security\Crypto;
use HeTec\PS\Security\RateLimiter;
use HeTec\PS\Security\SessionManager;

/**
 * Front-Controller der HeTec-API. Jede Route deklariert ihre Anforderungen:
 *   auth  → angemeldeter, freigegebener Benutzer nötig
 *   csrf  → schreibende Anfrage braucht X-PS-CSRF-Header (Double-Submit an die Sitzung gebunden)
 *   perm  → Berechtigung aus role_permissions
 * Alles wird serverseitig geprüft; das Frontend blendet nur aus.
 */
final class App
{
    public const VERSION = '57.0.0-beta.2';

    public readonly Db $db;
    public readonly Crypto $crypto;
    public readonly SessionManager $session;
    public readonly UserRepository $users;
    public readonly Audit $audit;
    public readonly RateLimiter $rate;
    public readonly EntraLogin $entra;
    private Router $router;
    private ?Principal $principal = null;
    public ?Request $request = null;

    public function __construct(public readonly Config $config, public readonly string $appRoot)
    {
        $this->db = new Db($config);
        $this->crypto = new Crypto($config->dataKey(), $config->indexKey());
        $this->session = new SessionManager($this->db, $config);
        $this->users = new UserRepository($this->db);
        $this->audit = new Audit($this->db, $this->crypto);
        $this->rate = new RateLimiter($this->db);
        $this->entra = new EntraLogin($config, $this->session, $this->users, $this->audit);
        $this->router = new Router();
        $this->routes();
    }

    private function routes(): void
    {
        $r = $this->router;
        $auth = new Controller\AuthController($this);
        $data = new Controller\DataController($this);
        $stats = new Controller\StatsController($this);
        $idx = new Controller\PdfIndexController($this);
        $dl = new Controller\DownloadController($this);
        $admin = new Controller\AdminController($this);

        $r->add('GET', '/v1/health', [$auth, 'health']);
        $r->add('GET', '/v1/session', [$auth, 'session']);
        $r->add('GET', '/v1/auth/login', [$auth, 'login']);
        $r->add('GET', '/v1/auth/callback', [$auth, 'callback']);
        $r->add('POST', '/v1/auth/logout', [$auth, 'logout'], ['csrf' => true]);
        $r->add('PATCH', '/v1/me/profile', [$auth, 'updateProfile'], ['auth' => true, 'csrf' => true]);

        $r->add('GET', '/v1/shops', [$data, 'shops'], ['auth' => true]);
        $r->add('GET', '/v1/news/{brand}', [$data, 'getNews'], ['auth' => true]);
        $r->add('PUT', '/v1/news/{brand}', [$data, 'putNews'], ['auth' => true, 'csrf' => true, 'perm' => 'news.manage']);

        $r->add('GET', '/v1/offers', [$data, 'listOffers'], ['auth' => true, 'perm' => 'offers.own_shop']);
        $r->add('GET', '/v1/offers/{id}', [$data, 'getOffer'], ['auth' => true, 'perm' => 'offers.own_shop']);
        $r->add('PUT', '/v1/offers/{id}', [$data, 'putOffer'], ['auth' => true, 'csrf' => true, 'perm' => 'offers.own_shop']);
        $r->add('DELETE', '/v1/offers/{id}', [$data, 'deleteOffer'], ['auth' => true, 'csrf' => true, 'perm' => 'offers.own_shop']);

        $r->add('GET', '/v1/skip/me', [$data, 'skipMe'], ['auth' => true]);
        $r->add('POST', '/v1/skip/me/increment', [$data, 'skipIncrement'], ['auth' => true, 'csrf' => true]);
        $r->add('GET', '/v1/skip/agents', [$data, 'skipAgents'], ['auth' => true, 'perm' => 'skip.manage']);
        $r->add('PUT', '/v1/skip/agents/{userId}', [$data, 'skipUpdate'], ['auth' => true, 'csrf' => true, 'perm' => 'skip.manage']);

        $r->add('POST', '/v1/tool-usage', [$data, 'toolUsage'], ['auth' => true, 'csrf' => true]);
        $r->add('GET', '/v1/tool-usage', [$data, 'toolUsageList'], ['auth' => true, 'perm' => 'analytics.read_all']);

        $r->add('GET', '/v1/settings/{key}', [$data, 'getSetting'], ['auth' => true]);
        $r->add('PUT', '/v1/settings/{key}', [$data, 'putSetting'], ['auth' => true, 'csrf' => true, 'perm' => 'settings.manage']);

        $r->add('POST', '/v1/analytics/batch', [$stats, 'batch'], ['auth' => true, 'csrf' => true, 'perm' => 'analytics.write_own']);
        $r->add('GET', '/v1/analytics', [$stats, 'list'], ['auth' => true]);
        $r->add('DELETE', '/v1/analytics', [$stats, 'deleteAll'], ['auth' => true, 'csrf' => true, 'perm' => 'analytics.delete_all']);
        $r->add('GET', '/v1/statistics/summary', [$stats, 'summary'], ['auth' => true]);

        $r->add('PUT', '/v1/pdf-index/{id}', [$idx, 'put'], ['auth' => true, 'csrf' => true]);
        $r->add('POST', '/v1/pdf-index/import', [$idx, 'import'], ['auth' => true, 'csrf' => true, 'perm' => 'archive.import']);
        $r->add('GET', '/v1/pdf-index/search', [$idx, 'search'], ['auth' => true]);
        $r->add('GET', '/v1/pdf-index/mine', [$idx, 'mine'], ['auth' => true]);
        $r->add('GET', '/v1/pdf-index/probe', [$idx, 'probe'], ['auth' => true]);
        $r->add('DELETE', '/v1/pdf-index/{id}', [$idx, 'delete'], ['auth' => true, 'csrf' => true, 'perm' => 'archive.import']);
        $r->add('POST', '/v1/archive/flow', [$idx, 'flowProxy'], ['auth' => true, 'csrf' => true]);
        $flows = new Controller\FlowController($this);
        $r->add('POST', '/v1/flows/{name}', [$flows, 'post'], ['auth' => true, 'csrf' => true, 'perm' => 'consultation.use']);

        $r->add('POST', '/v1/downloads', [$dl, 'create'], ['auth' => true, 'csrf' => true, 'perm' => 'consultation.use']);
        $r->add('DELETE', '/v1/downloads/{id}', [$dl, 'delete'], ['auth' => true, 'csrf' => true]);
        $r->add('GET', '/v1/downloads/{id}/file', [$dl, 'file']);   // öffentlich per 128-Bit-Token (Kunde ohne Konto), 24 h gültig

        $r->add('GET', '/v1/admin/users', [$admin, 'users'], ['auth' => true, 'perm' => 'users.read']);
        $r->add('PATCH', '/v1/admin/users/{id}', [$admin, 'updateUser'], ['auth' => true, 'csrf' => true, 'perm' => 'users.manage']);
        $r->add('POST', '/v1/admin/users/{id}/revoke-sessions', [$admin, 'revokeSessions'], ['auth' => true, 'csrf' => true, 'perm' => 'users.manage']);
        $r->add('GET', '/v1/admin/roles', [$admin, 'roles'], ['auth' => true, 'perm' => 'users.read']);
        $r->add('GET', '/v1/admin/audit', [$admin, 'audit'], ['auth' => true, 'perm' => 'audit.read']);
        $r->add('POST', '/v1/admin/migrate', [$admin, 'migrate'], ['auth' => true, 'csrf' => true, 'perm' => 'system.migrate']);
        $r->add('POST', '/v1/admin/cleanup', [$admin, 'cleanup'], ['auth' => true, 'csrf' => true, 'perm' => 'settings.manage']);

        // Isolierter Test-Login: nur wenn env=development UND backend/dev/ existiert (fehlt im Release).
        $devFile = $this->appRoot . '/dev/DevAuthController.php';
        if ($this->config->isDevelopment() && is_file($devFile)) {
            require_once $devFile;
            $dev = new \HeTec\PS\Dev\DevAuthController($this);
            $r->add('POST', '/v1/dev/login', [$dev, 'login'], ['csrf' => false]);
            $r->add('GET', '/v1/dev/users', [$dev, 'users']);
        }
    }

    public function handle(Request $req): Response
    {
        $this->request = $req;
        $this->audit->setIp($req->ip);
        try {
            [$handler, $opts, $params] = $this->router->match($req->method, $req->path);
            $req->params = $params;
            $this->checkOrigin($req);
            $this->session->load($req);
            if (!empty($opts['csrf'])) {
                $this->checkCsrf($req);
            }
            if (!empty($opts['auth'])) {
                $p = $this->principal();
                if ($p === null) {
                    throw new HttpException(401, 'unauthenticated');
                }
                if (!empty($opts['perm'])) {
                    $p->require((string) $opts['perm']);
                }
                $this->rate->hit('u:' . $p->id . ':' . $req->method, $req->method === 'GET' ? 600 : 300, 60);
            } else {
                $this->rate->hit('ip:' . $req->ip, 300, 60);
            }
            $res = $handler($req);
        } catch (HttpException $e) {
            $res = Response::json(['ok' => false, 'error' => $e->errorCode] + $e->extra, $e->status);
            if ($e->status === 429 && isset($e->extra['retryAfter'])) {
                $res->headers['Retry-After'] = (string) $e->extra['retryAfter'];
            }
        } catch (\Throwable $e) {
            error_log('[HeTec API] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            $res = Response::json(['ok' => false, 'error' => 'server_error'], 500);
        }
        try {
            $this->session->persist($res, $req->header('user-agent'));
        } catch (\Throwable $e) {
            error_log('[HeTec API] Session: ' . $e->getMessage());
        }
        return $res;
    }

    public function principal(): ?Principal
    {
        if ($this->principal !== null) {
            return $this->principal;
        }
        $uid = $this->session->get('uid');
        if (!is_int($uid)) {
            return null;
        }
        $p = $this->users->principal($uid);
        if ($p === null) {
            // gesperrt / Rolle entzogen / gelöscht → Sitzung sofort beenden
            $this->session->destroy();
            return null;
        }
        return $this->principal = $p;
    }

    /** Für den isolierten Dev-Login und Tests. */
    public function resetPrincipal(): void
    {
        $this->principal = null;
    }

    private function checkOrigin(Request $req): void
    {
        // Browser senden Origin bei allen nicht-GET-Anfragen (und bei CORS). Fremde Origins → abgelehnt.
        $origin = $req->header('origin');
        if ($origin === '') {
            return;
        }
        if (!in_array(rtrim($origin, '/'), $this->config->allowedOrigins(), true)) {
            throw new HttpException(403, 'origin_not_allowed');
        }
    }

    private function checkCsrf(Request $req): void
    {
        $sent = $req->header('x-ps-csrf');
        $expected = (string) $this->session->get('csrf', '');
        if ($expected === '' || $sent === '' || !hash_equals($expected, $sent)) {
            throw new HttpException(403, 'csrf_invalid');
        }
    }
}
