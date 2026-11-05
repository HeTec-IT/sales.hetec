<?php
declare(strict_types=1);

namespace PS;

// Dokumentenspeicher auf MySQL/MariaDB (eine Tabelle ps_docs).
//   coll + id = Schluessel (wie Firestore: Sammlung/Dokument-ID), data = JSON.
//   Zusaetzlich einige Schluesselspalten (k_*), damit Abfragen nach Standort, Benutzer,
//   E-Mail und Zeit in der Datenbank statt im Speicher laufen.
final class Store
{
    public const MAX_DOC = 2000000; // Bytes JSON je Dokument
    // Spalten, nach denen die Datenbank filtern darf: Feld im Dokument => Spalte
    public const PUSH = ['shopId' => 'k_shop', 'userUid' => 'k_user', 'uid' => 'k_uid', 'email' => 'k_email', 'ts' => 'k_ts'];
    public const MAX_KEY = 200; // Bytes (k_shop, k_user, k_uid, k_email)
    public const MAX_TS = 100;  // Bytes (k_ts)

    private array $dbCfg;
    private ?\PDO $pdo = null;
    private ?\PDO $injected;

    public function __construct(array $dbCfg, ?\PDO $pdo = null)
    {
        $this->dbCfg = $dbCfg;
        $this->injected = $pdo;
    }

    public function pdo(): \PDO
    {
        if ($this->pdo !== null) return $this->pdo;
        if ($this->injected !== null) return $this->pdo = $this->injected;
        $c = $this->dbCfg;
        $dsn = (string)($c['dsn'] ?? ('mysql:host=' . ($c['host'] ?? 'localhost') . ';port=' . (int)($c['port'] ?? 3306) . ';dbname=' . ($c['name'] ?? '') . ';charset=utf8mb4'));
        try {
            $this->pdo = new \PDO($dsn, (string)($c['user'] ?? ''), (string)($c['pass'] ?? ''), [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_EMULATE_PREPARES => false,
                \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
                \PDO::ATTR_TIMEOUT => 6,
                \PDO::MYSQL_ATTR_USE_BUFFERED_QUERY => false,
            ]);
            $this->pdo->exec("SET NAMES utf8mb4");
        } catch (\PDOException $e) {
            error_log('PS: Datenbankverbindung fehlgeschlagen: ' . $e->getMessage());
            throw E::unavailable('Datenbank nicht erreichbar.');
        }
        return $this->pdo;
    }

    public function init(): void
    {
        $this->pdo()->exec("CREATE TABLE IF NOT EXISTS ps_docs (
            coll VARBINARY(40) NOT NULL,
            id VARBINARY(250) NOT NULL,
            data LONGBLOB NOT NULL,
            k_shop VARBINARY(200) NULL,
            k_user VARBINARY(200) NULL,
            k_uid VARBINARY(200) NULL,
            k_email VARBINARY(200) NULL,
            k_ts VARBINARY(100) NULL,
            k_ts_bad TINYINT(1) NOT NULL DEFAULT 0,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (coll, id),
            KEY ix_shop (coll, k_shop, k_ts),
            KEY ix_user (coll, k_user, k_ts),
            KEY ix_uid (coll, k_uid),
            KEY ix_email (coll, k_email),
            KEY ix_ts (coll, k_ts),
            KEY ix_bad (coll, k_ts_bad),
            KEY ix_upd (coll, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    }

    // Fuehrt aus; fehlt die Tabelle (Fehler 1146), wird sie angelegt und es wird einmal wiederholt.
    private function run(callable $fn)
    {
        try {
            return $fn($this->pdo());
        } catch (\PDOException $e) {
            if ((int)($e->errorInfo[1] ?? 0) === 1146) {
                $this->init();
                return $fn($this->pdo());
            }
            throw $e;
        }
    }

    private static function validKey(string $s, int $max): void
    {
        if ($s === '' || strlen($s) > $max) throw E::bad('Ungueltige Dokument-ID.');
    }

    // Schluesselspalten aus einem Dokument
    public static function keys(\stdClass $d): array
    {
        $s = function (string $f, int $max) use ($d): ?string {
            $v = Val::get($d, $f);
            return (is_string($v) && strlen($v) <= $max) ? $v : null;
        };
        $bad = 0;
        if (property_exists($d, 'ts')) {
            $v = $d->ts;
            if (!is_string($v) || strlen($v) > self::MAX_TS) $bad = 1;
        }
        return [
            $s('shopId', self::MAX_KEY), $s('userUid', self::MAX_KEY), $s('uid', self::MAX_KEY), $s('email', self::MAX_KEY),
            $bad ? null : $s('ts', self::MAX_TS), $bad,
        ];
    }

    // ------------------------------------------------------------ Einzeln ----
    // => ['id'=>..., 'json'=>..., 'modified'=>ms] oder null
    public function get(string $coll, string $id): ?array
    {
        self::validKey($coll, 40);
        self::validKey($id, 250);
        return $this->run(function (\PDO $p) use ($coll, $id) {
            $st = $p->prepare('SELECT data, updated_at FROM ps_docs WHERE coll = ? AND id = ?');
            $st->execute([$coll, $id]);
            $row = $st->fetch();
            $st->closeCursor();
            return $row ? ['id' => $id, 'json' => (string)$row['data'], 'modified' => (int)$row['updated_at']] : null;
        });
    }

    public function put(string $coll, string $id, \stdClass $data): void
    {
        self::validKey($coll, 40);
        self::validKey($id, 250);
        $json = Json::encode($data);
        if (strlen($json) > self::MAX_DOC) throw E::bad('Dokument zu gross (' . strlen($json) . ' Bytes).');
        $k = self::keys($data);
        $this->run(function (\PDO $p) use ($coll, $id, $json, $k) {
            $st = $p->prepare('REPLACE INTO ps_docs (coll, id, data, k_shop, k_user, k_uid, k_email, k_ts, k_ts_bad, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
            $st->execute([$coll, $id, $json, $k[0], $k[1], $k[2], $k[3], $k[4], $k[5], Val::nowMs()]);
            $st->closeCursor();
        });
    }

    public function remove(string $coll, string $id): void
    {
        self::validKey($coll, 40);
        self::validKey($id, 250);
        $this->run(function (\PDO $p) use ($coll, $id) {
            $st = $p->prepare('DELETE FROM ps_docs WHERE coll = ? AND id = ?');
            $st->execute([$coll, $id]);
            $st->closeCursor();
        });
    }

    // Lesen-aendern-schreiben, pro Dokument exklusiv (named lock). $fn(?\stdClass alt): \stdClass neu
    public function mutate(string $coll, string $id, callable $fn): \stdClass
    {
        self::validKey($coll, 40);
        self::validKey($id, 250);
        $name = 'ps:' . sha1($coll . "\0" . $id);
        $p = $this->pdo();
        $got = $this->run(function (\PDO $p) use ($name) {
            $st = $p->prepare('SELECT GET_LOCK(?, 15) AS l');
            $st->execute([$name]);
            $r = $st->fetch();
            $st->closeCursor();
            return (int)($r['l'] ?? 0) === 1;
        });
        if (!$got) throw E::conflict();
        try {
            $cur = $this->get($coll, $id);
            $next = $fn($cur ? Json::decode($cur['json']) : null);
            $this->put($coll, $id, $next);
            return $next;
        } finally {
            try {
                $st = $p->prepare('SELECT RELEASE_LOCK(?)');
                $st->execute([$name]);
                $st->closeCursor();
            } catch (\Throwable $e) { /* Sperre endet mit der Verbindung */ }
        }
    }

    // --------------------------------------------------------- Abfragen ----
    // Bedingungen: Liste von Varianten (ODER), jede Variante eine Liste von [spalte, wert] (UND).
    // Spalten: id oder eine Schluesselspalte k_*.
    private static function scopeSql(array $variants, array &$params): string
    {
        $or = [];
        foreach ($variants as $conds) {
            if (count($conds) === 0) return '1=1';
            $and = [];
            foreach ($conds as $c) {
                $col = $c[0];
                if ($col !== 'id' && !in_array($col, array_values(self::PUSH), true)) throw new \LogicException('Spalte ' . $col);
                $and[] = $col . ' = ?';
                $params[] = $c[1];
            }
            $or[] = '(' . implode(' AND ', $and) . ')';
        }
        return count($or) ? '(' . implode(' OR ', $or) . ')' : '1=1';
    }

    private static function likeSql(array $likes, array &$params): string
    {
        $sql = '';
        foreach ($likes as $l) {
            $sql .= " AND data LIKE ? ESCAPE '!'";
            $params[] = '%' . str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $l) . '%';
        }
        return $sql;
    }

    // Alle Dokumente einer Sammlung, die zu einer der Varianten passen (zeilenweise, speicherschonend).
    // $likes: Teiltexte, die im JSON vorkommen muessen (Vorfilter). $cb(id, json): false = abbrechen
    public function scan(string $coll, array $variants, array $likes, callable $cb): void
    {
        self::validKey($coll, 40);
        $params = [$coll];
        $sql = 'SELECT id, data FROM ps_docs WHERE coll = ? AND ' . self::scopeSql($variants, $params) . self::likeSql($likes, $params) . ' ORDER BY id';
        $this->run(function (\PDO $p) use ($sql, $params, $cb) {
            $st = $p->prepare($sql);
            $st->execute($params);
            while (($row = $st->fetch()) !== false) {
                if ($cb((string)$row['id'], (string)$row['data']) === false) break;
            }
            $st->closeCursor();
        });
    }

    // Gibt es im Bereich Dokumente, deren ts-Feld kein kurzer Text ist? (dann nicht in der Datenbank sortierbar)
    public function hasBadTs(string $coll, array $variants): bool
    {
        $params = [$coll];
        $sql = 'SELECT 1 FROM ps_docs WHERE coll = ? AND k_ts_bad = 1 AND ' . self::scopeSql($variants, $params) . ' LIMIT 1';
        return $this->run(function (\PDO $p) use ($sql, $params) {
            $st = $p->prepare($sql);
            $st->execute($params);
            $r = $st->fetch() !== false;
            $st->closeCursor();
            return $r;
        });
    }

    // Seite sortiert in der Datenbank. $order: 'id' oder 'k_ts'; $dir: 'asc'|'desc'.
    // $after: null oder [tsWert|null, id] (Schluessel des letzten Dokuments der vorigen Seite).
    // Gibt Zeilen [id, json] zurueck (hoechstens $limit).
    public function page(string $coll, array $variants, string $order, string $dir, ?array $after, int $limit): array
    {
        $params = [$coll];
        $sql = 'SELECT id, data FROM ps_docs WHERE coll = ? AND ' . self::scopeSql($variants, $params);
        $d = $dir === 'desc' ? 'DESC' : 'ASC';
        if ($order === 'k_ts') {
            $sql .= ' AND k_ts IS NOT NULL';
            if ($after !== null) {
                $op = $dir === 'desc' ? '<' : '>';
                $sql .= " AND (k_ts $op ? OR (k_ts = ? AND id > ?))";
                array_push($params, $after[0], $after[0], $after[1]);
            }
            $sql .= " ORDER BY k_ts $d, id ASC";
        } else {
            if ($after !== null) {
                $sql .= ' AND id ' . ($dir === 'desc' ? '<' : '>') . ' ?';
                $params[] = $after[1];
            }
            $sql .= " ORDER BY id $d";
        }
        $sql .= ' LIMIT ' . max(1, $limit);
        return $this->run(function (\PDO $p) use ($sql, $params) {
            $st = $p->prepare($sql);
            $st->execute($params);
            $out = [];
            while (($row = $st->fetch()) !== false) $out[] = [(string)$row['id'], (string)$row['data']];
            $st->closeCursor();
            return $out;
        });
    }

    // Schluesselwert (k_ts) eines Dokuments im Bereich - null, wenn es nicht im Bereich liegt
    public function keyOf(string $coll, array $variants, string $id): ?array
    {
        $params = [$coll, $id];
        $sql = 'SELECT k_ts FROM ps_docs WHERE coll = ? AND id = ? AND ' . self::scopeSql($variants, $params);
        return $this->run(function (\PDO $p) use ($sql, $params) {
            $st = $p->prepare($sql);
            $st->execute($params);
            $r = $st->fetch();
            $st->closeCursor();
            return $r === false ? null : [$r['k_ts'] === null ? null : (string)$r['k_ts']];
        });
    }

    // Abgelaufene QR-Download-Dateien entfernen
    public function removeOlderThan(string $coll, int $beforeMs, int $max = 200): void
    {
        $this->run(function (\PDO $p) use ($coll, $beforeMs, $max) {
            $st = $p->prepare('DELETE FROM ps_docs WHERE coll = ? AND updated_at < ? LIMIT ' . (int)$max);
            $st->execute([$coll, $beforeMs]);
            $st->closeCursor();
        });
    }
}
