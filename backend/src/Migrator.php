<?php
declare(strict_types=1);

namespace HeTec\PS;

/**
 * Versionierte Datenbankmigrationen: migrations/NNNN_name.sql, jede genau einmal, in Reihenfolge.
 * Prüfsumme wird gespeichert – eine nachträglich veränderte, bereits angewandte Migration bricht ab.
 */
final class Migrator
{
    public function __construct(private Db $db, private string $dir)
    {
    }

    /** @return list<string> angewandte Migrationen */
    public function run(): array
    {
        $pdo = $this->db->pdo();
        $pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(190) NOT NULL PRIMARY KEY,
            checksum CHAR(64) NOT NULL,
            applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
        $done = [];
        foreach ($this->db->all('SELECT version, checksum FROM schema_migrations') as $row) {
            $done[(string) $row['version']] = (string) $row['checksum'];
        }
        $files = glob($this->dir . '/*.sql') ?: [];
        sort($files, SORT_STRING);
        $applied = [];
        foreach ($files as $file) {
            $version = basename($file, '.sql');
            if (!preg_match('/^\d{4}_[a-z0-9_]+$/', $version)) {
                throw new \RuntimeException('Ungültiger Migrationsname: ' . $version);
            }
            $sql = (string) file_get_contents($file);
            $sum = hash('sha256', $sql);
            if (isset($done[$version])) {
                if (!hash_equals($done[$version], $sum)) {
                    throw new \RuntimeException("Migration $version wurde nach dem Anwenden verändert");
                }
                continue;
            }
            foreach (self::split($sql) as $stmt) {
                $pdo->exec($stmt);
            }
            $this->db->exec('INSERT INTO schema_migrations (version, checksum) VALUES (:v, :c)', ['v' => $version, 'c' => $sum]);
            $applied[] = $version;
        }
        return $applied;
    }

    /** Zerlegt eine SQL-Datei an Semikolons außerhalb von Zeichenketten/Kommentaren. @return list<string> */
    public static function split(string $sql): array
    {
        $out = [];
        $buf = '';
        $len = strlen($sql);
        $q = null;
        for ($i = 0; $i < $len; $i++) {
            $c = $sql[$i];
            $n = $i + 1 < $len ? $sql[$i + 1] : '';
            if ($q === null && $c === '-' && $n === '-') {
                while ($i < $len && $sql[$i] !== "\n") {
                    $i++;
                }
                $buf .= "\n";
                continue;
            }
            if ($q === null && ($c === "'" || $c === '"' || $c === '`')) {
                $q = $c;
            } elseif ($q !== null && $c === $q) {
                if ($n === $q) {
                    $buf .= $c . $n;
                    $i++;
                    continue;
                }
                $q = null;
            } elseif ($q !== null && $c === '\\') {
                $buf .= $c . $n;
                $i++;
                continue;
            }
            if ($q === null && $c === ';') {
                if (trim($buf) !== '') {
                    $out[] = trim($buf);
                }
                $buf = '';
                continue;
            }
            $buf .= $c;
        }
        if (trim($buf) !== '') {
            $out[] = trim($buf);
        }
        return $out;
    }
}
