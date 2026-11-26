<?php
declare(strict_types=1);

namespace HeTec\PS\Auth;

use HeTec\PS\Audit;
use HeTec\PS\Config;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Repo\UserRepository;
use HeTec\PS\Security\SessionManager;
use Jumbojett\OpenIDConnectClientException;

/**
 * Microsoft-Anmeldung (OpenID Connect, Authorization Code Flow mit PKCE, Single-Tenant).
 * Zusätzlich zur Bibliothek geprüft: Tenant-ID, exakter Issuer, Gastkonten, Domain, Object-ID.
 * Ergebnis ist NIE automatisch ein Vollzugriff: neue Konten sind 'pending', bis ein Admin sie freigibt.
 */
final class EntraLogin
{
    private const MS_PERSONAL_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

    public function __construct(
        private Config $config,
        private SessionManager $session,
        private UserRepository $users,
        private Audit $audit,
    ) {
    }

    public function authority(): string
    {
        $e = $this->config->entra();
        $override = (string) ($e['authority_override'] ?? '');
        if ($override !== '') {
            if (!$this->config->isDevelopment()) {
                throw new \RuntimeException('authority_override nur in der Entwicklung');
            }
            return rtrim($override, '/');
        }
        return 'https://login.microsoftonline.com/' . strtolower((string) $e['tenant_id']) . '/v2.0';
    }

    private function client(): EntraOidcClient
    {
        $e = $this->config->entra();
        $authority = $this->authority();
        $c = new EntraOidcClient($this->session, $authority, (string) $e['client_id'], (string) $e['client_secret'], $authority);
        $c->setRedirectURL((string) $e['redirect_uri']);
        $c->addScope(['openid', 'profile', 'email']);
        $c->setCodeChallengeMethod('S256');
        $c->setResponseTypes(['code']);
        $c->setTimeout(15);
        $c->setVerifyHost(true);
        $c->setVerifyPeer(true);
        $c->setIssuerValidator(fn (string $iss): bool => $iss === $authority);
        if ($this->config->isDevelopment() && str_starts_with($authority, 'http://')) {
            $c->setHttpUpgradeInsecureRequests(false);
        }
        return $c;
    }

    public static function safeReturnTo(string $v): string
    {
        if ($v === '' || $v[0] !== '/' || str_starts_with($v, '//') || str_contains($v, '\\') || preg_match('/[\x00-\x1f]/', $v)) {
            return '/';
        }
        return mb_substr($v, 0, 300);
    }

    /** Startet die Anmeldung: liefert die Microsoft-URL. */
    public function begin(string $returnTo): string
    {
        $this->session->ensureStarted();
        $this->session->set('return_to', self::safeReturnTo($returnTo));
        $c = $this->client();
        try {
            $c->authenticate();
        } catch (OpenIDConnectClientException $e) {
            throw new HttpException(502, 'idp_unavailable');
        }
        $url = $c->takeRedirect();
        if ($url === null) {
            throw new HttpException(500, 'login_init_failed');
        }
        return $url;
    }

    /**
     * Callback von Microsoft. Gibt die Ziel-URL in der App zurück (mit ?login=ok|pending|denied|error).
     */
    public function complete(): string
    {
        $app = $this->config->appUrl();
        $returnTo = self::safeReturnTo((string) $this->session->get('return_to', '/'));
        if (!isset($_REQUEST['code']) && !isset($_REQUEST['error'])) {
            return $app . '/?login=error';
        }
        // state VOR dem Code-Tausch prüfen (die Bibliothek prüft erst danach)
        $expectedState = (string) $this->session->get('oidc_openid_connect_state', '');
        $sentState = is_string($_REQUEST['state'] ?? null) ? $_REQUEST['state'] : '';
        if ($expectedState === '' || !hash_equals($expectedState, $sentState)) {
            $this->audit->log(null, 'login_failed', 'auth', '', null, ['reason' => 'state_mismatch']);
            return $app . '/?login=error';
        }
        $c = $this->client();
        try {
            if (!$c->authenticate()) {
                return $app . '/?login=error';
            }
            $claims = $c->getVerifiedClaims();
        } catch (OpenIDConnectClientException $e) {
            $this->audit->log(null, 'login_failed', 'auth', '', null, ['reason' => mb_substr($e->getMessage(), 0, 120)]);
            return $app . '/?login=error';
        }
        try {
            $identity = $this->validateClaims($claims);
        } catch (HttpException $e) {
            $this->audit->log(null, 'login_denied', 'auth', '', null, ['reason' => $e->errorCode]);
            $this->session->destroy();
            return $app . '/?login=denied&reason=' . rawurlencode($e->errorCode);
        }
        return $this->establish($identity, $returnTo);
    }

    /**
     * @return array{tid:string,oid:string,email:string,name:string,given:string,family:string}
     */
    public function validateClaims(object $claims): array
    {
        $e = $this->config->entra();
        $expectedTenant = strtolower((string) $e['tenant_id']);
        $tid = strtolower((string) ($claims->tid ?? ''));
        $oid = strtolower((string) ($claims->oid ?? ''));
        $iss = (string) ($claims->iss ?? '');
        $guid = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';

        if ($tid === '' || $tid === self::MS_PERSONAL_TENANT || !hash_equals($expectedTenant, $tid)) {
            throw new HttpException(403, 'wrong_tenant');
        }
        if ($iss !== $this->authority()) {
            throw new HttpException(403, 'wrong_issuer');
        }
        if (!preg_match($guid, $oid) || !preg_match($guid, $tid)) {
            throw new HttpException(403, 'invalid_identity');
        }
        if (($e['reject_guests'] ?? true) === true) {
            // Gastkonten: 'idp' zeigt auf den Heimat-Aussteller (≠ unser Issuer); optionaler Claim 'acct' = 1
            if ((isset($claims->idp) && (string) $claims->idp !== $iss) || (isset($claims->acct) && (int) $claims->acct === 1)) {
                throw new HttpException(403, 'guest_not_allowed');
            }
        }
        $email = strtolower(trim((string) ($claims->preferred_username ?? $claims->email ?? $claims->upn ?? '')));
        $domainOk = false;
        foreach ((array) ($e['allowed_domains'] ?? []) as $d) {
            if ($d !== '' && str_ends_with($email, '@' . strtolower((string) $d))) {
                $domainOk = true;
            }
        }
        if (!$domainOk || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            throw new HttpException(403, 'domain_not_allowed');
        }
        return [
            'tid' => $tid,
            'oid' => $oid,
            'email' => $email,
            'name' => trim((string) ($claims->name ?? '')),
            'given' => trim((string) ($claims->given_name ?? '')),
            'family' => trim((string) ($claims->family_name ?? '')),
        ];
    }

    /**
     * Legt eine Sitzung für eine geprüfte Identität an. Wird auch vom isolierten Dev-Login verwendet.
     * @param array{tid:string,oid:string,email:string,name:string,given:string,family:string} $id
     */
    public function establish(array $id, string $returnTo = '/'): string
    {
        $app = $this->config->appUrl();
        $user = $this->users->findByEntra($id['tid'], $id['oid']);
        if (!$user) {
            $legacy = $this->users->findLinkableLegacy($id['email']);
            if ($legacy) {
                $this->users->linkEntra((int) $legacy['id'], $id['tid'], $id['oid']);
                $this->audit->log((int) $legacy['id'], 'entra_linked', 'user', (string) $legacy['public_id']);
                $user = $this->users->findById((int) $legacy['id']);
            }
        }
        if (!$user) {
            $isBootstrap = in_array($id['email'], $this->config->bootstrapSuperAdmins(), true);
            $display = $id['name'] !== '' ? $id['name'] : trim($id['given'] . ' ' . $id['family']);
            $uid = $this->users->createPending($id['tid'], $id['oid'], [
                'email' => $id['email'],
                'display_name' => $display,
                'vorname' => $id['given'],
                'nachname' => $id['family'],
            ], $isBootstrap ? 'super_admin' : 'mitarbeiter', $isBootstrap ? 'approved' : 'pending');
            $this->audit->log($uid, $isBootstrap ? 'user_bootstrap_admin' : 'user_registered', 'user');
            $user = $this->users->findById($uid);
        }
        if (!$user) {
            return $app . '/?login=error';
        }
        $this->session->regenerate();
        if ($user['status'] !== 'approved') {
            $this->session->set('pending_uid', (int) $user['id']);
            return $app . '/?login=' . ($user['status'] === 'pending' ? 'pending' : 'denied');
        }
        $this->users->touchLogin((int) $user['id'], $id['email']);
        $this->session->set('uid', (int) $user['id']);
        $this->session->set('login_at', time());
        $this->session->csrfToken();
        $this->audit->log((int) $user['id'], 'login', 'user', (string) $user['public_id']);
        $sep = str_contains($returnTo, '?') ? '&' : '?';
        return $app . $returnTo . $sep . 'login=ok';
    }

    public function logoutUrl(): string
    {
        $e = $this->config->entra();
        $post = (string) ($e['post_logout_redirect_uri'] ?? $this->config->appUrl() . '/');
        if (($e['authority_override'] ?? '') !== '') {
            return $post;
        }
        return 'https://login.microsoftonline.com/' . rawurlencode(strtolower((string) $e['tenant_id']))
            . '/oauth2/v2.0/logout?post_logout_redirect_uri=' . rawurlencode($post);
    }
}
