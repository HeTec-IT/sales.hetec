<?php
declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;

/**
 * Kurzlebige Kunden-Downloads (QR-Code „Unterlagen aufs Handy“), bisher Firestore 'portierung_files'.
 * - Upload nur angemeldet, nur PDF/JPEG/PNG (Magic-Bytes geprüft), max. 10 MB.
 * - Datei liegt außerhalb des Webroots unter einem zufälligen Namen (kein Path Traversal möglich).
 * - Abruf öffentlich über ein 128-Bit-Zufallstoken, 24 h gültig, danach gelöscht.
 */
final class DownloadController
{
    private const MAX_BYTES = 10 * 1024 * 1024;
    private const TTL_HOURS = 24;

    public function __construct(private App $app)
    {
    }

    private function dir(): string
    {
        $d = $this->app->config->storageDir() . '/downloads';
        if (!is_dir($d) && !mkdir($d, 0700, true) && !is_dir($d)) {
            throw new \RuntimeException('Speicherverzeichnis nicht anlegbar');
        }
        return $d;
    }

    private static function mimeOf(string $bin): ?string
    {
        if (str_starts_with($bin, '%PDF-')) {
            return 'application/pdf';
        }
        if (str_starts_with($bin, "\xFF\xD8\xFF")) {
            return 'image/jpeg';
        }
        if (str_starts_with($bin, "\x89PNG\r\n\x1a\n")) {
            return 'image/png';
        }
        return null;
    }

    public function create(Request $r): Response
    {
        $p = $this->app->principal();
        $this->app->rate->hit('dl-create:' . $p->id, 30, 3600);
        $b = $r->json();
        $bin = base64_decode((string) ($b['data'] ?? ''), true);
        if ($bin === false || $bin === '' || strlen($bin) > self::MAX_BYTES) {
            throw new HttpException(422, 'invalid_file');
        }
        $mime = self::mimeOf($bin);
        if ($mime === null) {
            throw new HttpException(415, 'unsupported_type');
        }
        $shopId = (string) ($b['shopId'] ?? '');
        if ($shopId !== '' && !$p->hasShop($shopId)) {
            throw new HttpException(403, 'shop_forbidden');
        }
        $this->cleanup();
        $id = bin2hex(random_bytes(16));
        $path = $this->dir() . '/' . $id . '.bin';
        $enc = $this->app->crypto->encrypt($bin, 'download:' . $id);
        if (file_put_contents($path, $enc, LOCK_EX) === false) {
            throw new \RuntimeException('Datei konnte nicht gespeichert werden');
        }
        @chmod($path, 0600);
        $this->app->db->exec(
            'INSERT INTO downloads (id, user_id, shop_id, mime, size_bytes, sha256, expires_at) VALUES (:id, :u, :s, :m, :sz, :h, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ' . self::TTL_HOURS . ' HOUR))',
            ['id' => $id, 'u' => $p->id, 's' => $shopId !== '' ? $shopId : null, 'm' => $mime, 'sz' => strlen($bin), 'h' => hash('sha256', $bin)]
        );
        $this->app->audit->log($p->id, 'download_created', 'download', $id, $shopId !== '' ? $shopId : null);
        return Response::json(['ok' => true, 'id' => $id, 'url' => $this->app->config->appUrl() . '/?dl=' . $id, 'expiresInHours' => self::TTL_HOURS]);
    }

    public function delete(Request $r): Response
    {
        $p = $this->app->principal();
        $id = $r->param('id');
        if (!preg_match('/^[a-f0-9]{32}$/', $id)) {
            throw new HttpException(404, 'not_found');
        }
        $row = $this->app->db->one('SELECT user_id FROM downloads WHERE id = :id', ['id' => $id]);
        if ($row && ((int) $row['user_id'] === $p->id || $p->isAdmin())) {
            $this->remove($id);
        }
        return Response::json(['ok' => true]);
    }

    public function file(Request $r): Response
    {
        $this->app->rate->hit('dl-get:' . $r->ip, 60, 600);
        $id = $r->param('id');
        if (!preg_match('/^[a-f0-9]{32}$/', $id)) {
            throw new HttpException(404, 'not_found');
        }
        $row = $this->app->db->one('SELECT mime, sha256 FROM downloads WHERE id = :id AND expires_at > UTC_TIMESTAMP(3)', ['id' => $id]);
        $path = $this->dir() . '/' . $id . '.bin';
        if (!$row || !is_file($path)) {
            throw new HttpException(404, 'expired');
        }
        $bin = $this->app->crypto->decrypt((string) file_get_contents($path), 'download:' . $id);
        if (!hash_equals((string) $row['sha256'], hash('sha256', $bin))) {
            throw new HttpException(500, 'integrity');
        }
        $ext = ['application/pdf' => 'pdf', 'image/jpeg' => 'jpg', 'image/png' => 'png'][$row['mime']] ?? 'bin';
        return new Response(200, $bin, [
            'Content-Type' => (string) $row['mime'],
            'Content-Disposition' => 'attachment; filename="Unterlagen.' . $ext . '"',
            'Content-Length' => (string) strlen($bin),
        ]);
    }

    private function remove(string $id): void
    {
        $this->app->db->exec('DELETE FROM downloads WHERE id = :id', ['id' => $id]);
        $path = $this->dir() . '/' . $id . '.bin';
        if (is_file($path)) {
            @unlink($path);
        }
    }

    public function cleanup(): int
    {
        $n = 0;
        foreach ($this->app->db->all('SELECT id FROM downloads WHERE expires_at <= UTC_TIMESTAMP(3) LIMIT 200') as $row) {
            $this->remove((string) $row['id']);
            $n++;
        }
        return $n;
    }
}
