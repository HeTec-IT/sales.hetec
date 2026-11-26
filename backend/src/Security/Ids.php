<?php
declare(strict_types=1);

namespace HeTec\PS\Security;

final class Ids
{
    private const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

    /** 26 Zeichen, zeitlich sortierbar (48 Bit ms) + 80 Bit Zufall – ULID-Format. */
    public static function ulid(): string
    {
        $ms = (int) floor(microtime(true) * 1000);
        $time = '';
        for ($i = 0; $i < 10; $i++) {
            $time = self::CROCKFORD[$ms % 32] . $time;
            $ms = intdiv($ms, 32);
        }
        $rand = '';
        $bytes = random_bytes(16);
        for ($i = 0; $i < 16; $i++) {
            $rand .= self::CROCKFORD[ord($bytes[$i]) % 32];
        }
        return $time . $rand;
    }

    public static function token(int $bytes = 32): string
    {
        return bin2hex(random_bytes($bytes));
    }

    /** Client-IDs (Angebote, Statistikzeilen): nur sichere Zeichen, begrenzte Länge. */
    public static function validClientId(string $id, int $max = 80): bool
    {
        return $id !== '' && strlen($id) <= $max && preg_match('/^[A-Za-z0-9._:-]+$/', $id) === 1;
    }
}
