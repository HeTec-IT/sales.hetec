<?php
declare(strict_types=1);

namespace HeTec\PS\Security;

/**
 * Verschlüsselung vertraulicher Felder ausschließlich mit libsodium (XSalsa20-Poly1305, secretbox).
 * Keine eigene Kryptografie: nur die etablierten sodium_*-Funktionen.
 */
final class Crypto
{
    private const VERSION = "\x01";

    public function __construct(private string $dataKey, private string $indexKey)
    {
        if (strlen($dataKey) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES || strlen($indexKey) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
            throw new \InvalidArgumentException('Schlüssel müssen 32 Byte lang sein');
        }
    }

    /** $context bindet den Geheimtext an einen Zweck (z. B. 'offer:<id>'), damit Werte nicht zwischen Datensätzen vertauscht werden können. */
    public function encrypt(string $plain, string $context): string
    {
        $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $key = $this->subKey($context);
        $c = sodium_crypto_secretbox($plain, $nonce, $key);
        sodium_memzero($key);
        return self::VERSION . $nonce . $c;
    }

    public function decrypt(string $blob, string $context): string
    {
        if ($blob === '' || $blob[0] !== self::VERSION || strlen($blob) < 1 + SODIUM_CRYPTO_SECRETBOX_NONCEBYTES + SODIUM_CRYPTO_SECRETBOX_MACBYTES) {
            throw new \RuntimeException('Ungültiger Geheimtext');
        }
        $nonce = substr($blob, 1, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $c = substr($blob, 1 + SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
        $key = $this->subKey($context);
        $p = sodium_crypto_secretbox_open($c, $nonce, $key);
        sodium_memzero($key);
        if ($p === false) {
            throw new \RuntimeException('Entschlüsselung fehlgeschlagen');
        }
        return $p;
    }

    /** Deterministischer Suchschlüssel (HMAC-SHA256 über libsodium-generichash mit Schlüssel). */
    public function indexHmac(string $value): string
    {
        return bin2hex(sodium_crypto_generichash($value, $this->indexKey, 32));
    }

    public function hashIp(string $ip): string
    {
        // eigener, abgeleiteter Schlüssel → keine Überschneidung mit Suchindex-HMACs
        $k = sodium_crypto_generichash('ps-ip-hash', $this->indexKey, 32);
        return bin2hex(sodium_crypto_generichash($ip, $k, 32));
    }

    private function subKey(string $context): string
    {
        return sodium_crypto_generichash('ps-data:' . $context, $this->dataKey, SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
    }
}
