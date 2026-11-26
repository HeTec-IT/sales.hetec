<?php
declare(strict_types=1);

namespace HeTec\PS\Http;

final class Router
{
    /** @var list<array{0:string,1:string,2:callable,3:array<string,mixed>}> */
    private array $routes = [];

    /** @param array<string,mixed> $opts  z. B. ['auth'=>true,'csrf'=>true,'perm'=>'users.manage'] */
    public function add(string $method, string $pattern, callable $handler, array $opts = []): void
    {
        $this->routes[] = [$method, $pattern, $handler, $opts];
    }

    /** @return array{0:callable,1:array<string,mixed>,2:array<string,string>} */
    public function match(string $method, string $path): array
    {
        $allowed = [];
        foreach ($this->routes as [$m, $pattern, $handler, $opts]) {
            $regex = '#^' . preg_replace('#\{([a-zA-Z_]+)\}#', '(?P<$1>[A-Za-z0-9._~@+-]{1,190})', $pattern) . '$#';
            if (!preg_match($regex, $path, $mm)) {
                continue;
            }
            if ($m !== $method) {
                $allowed[] = $m;
                continue;
            }
            $params = [];
            foreach ($mm as $k => $v) {
                if (is_string($k)) {
                    $params[$k] = $v;
                }
            }
            return [$handler, $opts, $params];
        }
        if ($allowed) {
            throw new HttpException(405, 'method_not_allowed');
        }
        throw new HttpException(404, 'not_found');
    }
}
