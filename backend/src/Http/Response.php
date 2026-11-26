<?php
declare(strict_types=1);

namespace HeTec\PS\Http;

final class Response
{
    /** @param array<string,string> $headers */
    public function __construct(
        public int $status = 200,
        public string $body = '',
        public array $headers = [],
    ) {
    }

    public static function json(mixed $data, int $status = 200): self
    {
        return new self($status, (string) json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), [
            'Content-Type' => 'application/json; charset=utf-8',
        ]);
    }

    public static function redirect(string $url): self
    {
        return new self(302, '', ['Location' => $url]);
    }

    public static function noContent(): self
    {
        return new self(204);
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach (self::securityHeaders() + $this->headers as $k => $v) {
            header($k . ': ' . $v);
        }
        echo $this->body;
    }

    /** @return array<string,string> */
    public static function securityHeaders(): array
    {
        return [
            'Cache-Control' => 'no-store, max-age=0',
            'Pragma' => 'no-cache',
            'X-Content-Type-Options' => 'nosniff',
            'X-Frame-Options' => 'DENY',
            'Referrer-Policy' => 'no-referrer',
            'Cross-Origin-Resource-Policy' => 'same-origin',
            'Content-Security-Policy' => "default-src 'none'; frame-ancestors 'none'",
            'Strict-Transport-Security' => 'max-age=31536000; includeSubDomains',
        ];
    }
}
