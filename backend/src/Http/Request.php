<?php
declare(strict_types=1);

namespace HeTec\PS\Http;

final class Request
{
    /** @var array<string,string> */
    public array $params = [];
    private ?array $json = null;

    /**
     * @param array<string,string> $query
     * @param array<string,string> $headers  Kleinbuchstaben-Schlüssel
     * @param array<string,string> $cookies
     */
    public function __construct(
        public readonly string $method,
        public readonly string $path,
        public readonly array $query,
        public readonly array $headers,
        public readonly array $cookies,
        public readonly string $body,
        public readonly string $ip,
    ) {
    }

    public static function fromGlobals(string $basePath = '/api'): self
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = (string) parse_url($uri, PHP_URL_PATH);
        $path = '/' . ltrim(rawurldecode($path), '/');
        if ($basePath !== '' && str_starts_with($path, $basePath)) {
            $path = substr($path, strlen($basePath)) ?: '/';
        }
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string) $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }
        $q = [];
        foreach ($_GET as $k => $v) {
            if (is_string($v)) {
                $q[(string) $k] = $v;
            }
        }
        $c = [];
        foreach ($_COOKIE as $k => $v) {
            if (is_string($v)) {
                $c[(string) $k] = $v;
            }
        }
        // Max. 16 MB Body lesen (Downloads/Angebote), Rest ignorieren
        $body = (string) file_get_contents('php://input', false, null, 0, 16 * 1024 * 1024 + 1);
        return new self(
            strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET')),
            $path,
            $q,
            $headers,
            $c,
            $body,
            (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'),
        );
    }

    public function header(string $name): string
    {
        return $this->headers[strtolower($name)] ?? '';
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        if ($this->json !== null) {
            return $this->json;
        }
        if ($this->body === '') {
            return $this->json = [];
        }
        if (strlen($this->body) > 16 * 1024 * 1024) {
            throw new HttpException(413, 'payload_too_large');
        }
        $ct = strtolower($this->header('content-type'));
        if (!str_starts_with($ct, 'application/json')) {
            throw new HttpException(415, 'json_required');
        }
        try {
            $d = json_decode($this->body, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new HttpException(400, 'invalid_json');
        }
        if (!is_array($d)) {
            throw new HttpException(400, 'invalid_json');
        }
        return $this->json = $d;
    }

    public function q(string $k, string $default = ''): string
    {
        return $this->query[$k] ?? $default;
    }

    public function param(string $k): string
    {
        return $this->params[$k] ?? '';
    }
}
