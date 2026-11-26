<?php
declare(strict_types=1);

namespace HeTec\PS\Auth;

use HeTec\PS\Security\SessionManager;
use Jumbojett\OpenIDConnectClient;
use Jumbojett\OpenIDConnectClientException;

/**
 * Microsoft-Entra-Client auf Basis der etablierten Bibliothek jumbojett/openid-connect-php
 * (Authorization Code Flow + PKCE S256, state, nonce, Signaturprüfung über JWKS).
 *
 * Anpassungen gegenüber der Bibliothek:
 *  - Sitzungsdaten (state/nonce/code_verifier) liegen in unserer DB-Sitzung statt in $_SESSION.
 *  - redirect() beendet den Prozess nicht, sondern übergibt die URL an den Controller.
 *  - verifyJWTClaims() ist strenger: nonce, exp, iat PFLICHT; aud muss exakt unsere Client-ID sein.
 *    Tenant-, Issuer-, Gast- und Domainprüfung erfolgt zusätzlich in EntraLogin.
 */
final class EntraOidcClient extends OpenIDConnectClient
{
    private ?string $redirectTo = null;
    private const PREFIX = 'oidc_';

    public function __construct(private SessionManager $session, string $providerUrl, string $clientId, string $clientSecret, string $issuer)
    {
        parent::__construct($providerUrl, $clientId, $clientSecret, $issuer);
    }

    public function redirect(string $url)
    {
        $this->redirectTo = $url;
    }

    public function takeRedirect(): ?string
    {
        $r = $this->redirectTo;
        $this->redirectTo = null;
        return $r;
    }

    protected function startSession()
    {
        $this->session->ensureStarted();
    }

    protected function commitSession()
    {
    }

    protected function getSessionKey(string $key)
    {
        $v = $this->session->get(self::PREFIX . $key, null);
        return $v === null ? false : $v;
    }

    protected function setSessionKey(string $key, $value)
    {
        $this->session->ensureStarted();
        $this->session->set(self::PREFIX . $key, $value);
    }

    protected function unsetSessionKey(string $key)
    {
        $this->session->remove(self::PREFIX . $key);
    }

    protected function verifyJWTClaims($claims, string $accessToken = null): bool
    {
        $now = time();
        $leeway = 120;
        if (!is_object($claims)) {
            return false;
        }
        $expectedNonce = $this->getNonce();
        if (!isset($claims->nonce) || !is_string($expectedNonce) || $expectedNonce === '' || !hash_equals($expectedNonce, (string) $claims->nonce)) {
            throw new OpenIDConnectClientException('nonce_invalid');
        }
        if (!isset($claims->exp) || !is_int($claims->exp) || $claims->exp < $now - $leeway) {
            throw new OpenIDConnectClientException('token_expired');
        }
        if (!isset($claims->iat) || !is_int($claims->iat) || $claims->iat > $now + $leeway || $claims->iat < $now - 3600) {
            throw new OpenIDConnectClientException('iat_invalid');
        }
        if (isset($claims->nbf) && (!is_int($claims->nbf) || $claims->nbf > $now + $leeway)) {
            throw new OpenIDConnectClientException('nbf_invalid');
        }
        if (!isset($claims->aud) || $claims->aud !== $this->getClientID()) {
            throw new OpenIDConnectClientException('audience_invalid');
        }
        return parent::verifyJWTClaims($claims, $accessToken);
    }

    /** Signatur-Algorithmus fest auf RS256 (kein HS256/none, keine eingebetteten JWKs). */
    public function verifyJWTSignature(string $jwt): bool
    {
        $parts = explode('.', $jwt);
        $header = json_decode((string) base64_decode(strtr($parts[0] ?? '', '-_', '+/')), false);
        if (!is_object($header) || ($header->alg ?? '') !== 'RS256' || isset($header->jwk) || isset($header->jku) || isset($header->x5u)) {
            throw new OpenIDConnectClientException('alg_not_allowed');
        }
        return parent::verifyJWTSignature($jwt);
    }
}
