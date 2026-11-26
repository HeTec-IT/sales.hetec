<?php
declare(strict_types=1);

namespace HeTec\PS\Http;

/** Fachlicher HTTP-Fehler. $code ist ein stabiler, maschinenlesbarer Fehlercode (kein Freitext an den Client). */
final class HttpException extends \RuntimeException
{
    /** @param array<string,mixed> $extra */
    public function __construct(public readonly int $status, public readonly string $errorCode, public readonly array $extra = [])
    {
        parent::__construct($errorCode, $status);
    }
}
