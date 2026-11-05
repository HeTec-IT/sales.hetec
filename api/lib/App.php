<?php
declare(strict_types=1);

namespace PS;

require_once __DIR__ . '/Core.php';
require_once __DIR__ . '/Config.php';
require_once __DIR__ . '/Auth.php';
require_once __DIR__ . '/Rules.php';
require_once __DIR__ . '/Store.php';
require_once __DIR__ . '/Engine.php';

// Verbindet Konfiguration, Login-Pruefung und Datenbank-Engine.
final class App
{
    private Config $cfg;
    private Auth $auth;
    private ?Engine $engine = null;
    private ?Store $store;

    public function __construct(?Config $cfg = null, ?Store $store = null)
    {
        $this->cfg = $cfg ?? Config::load();
        $this->auth = new Auth($this->cfg);
        $this->store = $store;
    }

    public function config(): Config { return $this->cfg; }

    private function engine(): Engine
    {
        return $this->engine ??= new Engine($this->store ?? new Store($this->cfg->db));
    }

    // Token (Header x-ps-token) -> Kontext; ohne Token: null
    private function context(string $token): ?Ctx
    {
        if ($token === '') return null;
        return $this->auth->context($this->auth->verify($token));
    }

    // Gibt [HTTP-Status, JSON-Text] zurueck
    public function handle(string $token, string $rawBody): array
    {
        try {
            if (strlen($rawBody) > 4000000) return [413, Json::encode(['ok' => false, 'code' => 'invalid-argument', 'message' => 'Anfrage zu gross.'])];
            $body = Json::decode($rawBody);
            $ctx = $this->context($token);
            $res = $this->engine()->handle($body, $ctx);
            return [200, Json::encode(array_merge(['ok' => true], $res))];
        } catch (ApiError $e) {
            return [$e->status, Json::encode(['ok' => false, 'code' => $e->errCode, 'message' => $e->getMessage()])];
        } catch (\Throwable $e) {
            error_log('PS: Interner Fehler: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
            return [500, Json::encode(['ok' => false, 'code' => 'internal', 'message' => 'Interner Fehler.'])];
        }
    }

    // Ohne Geheimnisse: nur ja/nein, damit die Einrichtung pruefbar ist.
    public function health(): array
    {
        $g = $this->cfg->groups;
        $out = [
            'ok' => true,
            'php' => PHP_VERSION,
            'openssl' => function_exists('openssl_verify'),
            'pdo_mysql' => extension_loaded('pdo_mysql'),
            'curl' => function_exists('curl_init'),
            'mbstring' => function_exists('mb_strtolower'),
            'microsoft_keys' => false,
            'tenant' => $this->cfg->tenantId !== '',
            'client' => $this->cfg->clientId !== '',
            'groups' => ['admin' => count($g['admin']), 'regional' => count($g['regional']), 'springer' => count($g['springer']), 'shops' => count($g['shops'])],
            'database' => false,
        ];
        try {
            $store = $this->store ?? new Store($this->cfg->db);
            $store->init();
            $out['database'] = true;
        } catch (\Throwable $e) {
            $out['database'] = false;
        }
        try {
            $out['microsoft_keys'] = $this->cfg->tenantId !== '' && $this->auth->keysReachable();
        } catch (\Throwable $e) {
            $out['microsoft_keys'] = false;
        }
        $out['ok'] = $out['openssl'] && $out['pdo_mysql'] && $out['mbstring'] && $out['tenant'] && $out['client'] && $out['database'] && $out['microsoft_keys']
            && ($out['groups']['admin'] + $out['groups']['shops'] > 0 || count($this->cfg->adminEmails) > 0);
        return $out;
    }
}
