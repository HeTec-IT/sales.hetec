<?php
declare(strict_types=1);

namespace HeTec\PS;

use PDO;

/** Dünne PDO-Hülle: ausschließlich vorbereitete Anweisungen, Transaktionen, UTC. */
final class Db
{
    private ?PDO $pdo = null;

    public function __construct(private Config $config)
    {
    }

    public function pdo(): PDO
    {
        if ($this->pdo === null) {
            $c = $this->config->db();
            $this->pdo = new PDO($c['dsn'], $c['user'], $c['password'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_STRINGIFY_FETCHES => false,
            ]);
            $this->pdo->exec("SET time_zone = '+00:00'");
            $this->pdo->exec("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'");
        }
        return $this->pdo;
    }

    /** @param array<int|string,mixed> $params @return list<array<string,mixed>> */
    public function all(string $sql, array $params = []): array
    {
        $st = $this->pdo()->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    /** @param array<int|string,mixed> $params @return array<string,mixed>|null */
    public function one(string $sql, array $params = []): ?array
    {
        $st = $this->pdo()->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    /** @param array<int|string,mixed> $params */
    public function scalar(string $sql, array $params = []): mixed
    {
        $st = $this->pdo()->prepare($sql);
        $st->execute($params);
        $v = $st->fetchColumn();
        return $v === false ? null : $v;
    }

    /** @param array<int|string,mixed> $params */
    public function exec(string $sql, array $params = []): int
    {
        $st = $this->pdo()->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    public function lastId(): int
    {
        return (int) $this->pdo()->lastInsertId();
    }

    /**
     * @template T
     * @param callable():T $fn
     * @return T
     */
    public function tx(callable $fn): mixed
    {
        $pdo = $this->pdo();
        if ($pdo->inTransaction()) {
            return $fn();
        }
        $pdo->beginTransaction();
        try {
            $r = $fn();
            $pdo->commit();
            return $r;
        } catch (\Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    /** IN-Liste mit Platzhaltern: [$sqlFragment, $params] */
    public static function in(array $values, string $prefix = 'p'): array
    {
        $ph = [];
        $params = [];
        foreach (array_values($values) as $i => $v) {
            $ph[] = ':' . $prefix . $i;
            $params[$prefix . $i] = $v;
        }
        return [$ph ? implode(',', $ph) : 'NULL', $params];
    }

    public static function now(): string
    {
        return gmdate('Y-m-d H:i:s.v');
    }

    public static function fromMs(int $ms): string
    {
        return gmdate('Y-m-d H:i:s', intdiv($ms, 1000)) . sprintf('.%03d', $ms % 1000);
    }
}
