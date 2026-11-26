<?php

declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;

/**
 * Stellvertretender Aufruf der bestehenden Power-Automate-Flows (Archiv-Upload, Folgetermin).
 * Die Flows bleiben unverändert (gleicher Payload, gleicher Trigger). Neu ist nur:
 * - die signierten Trigger-Adressen und der gemeinsame Schlüssel stehen ausschließlich in config.php,
 * - nur angemeldete, freigegebene Mitarbeiter können die Flows auslösen (vorher: jeder mit der URL).
 */
final class FlowController
{
    public function __construct(private App $app)
    {
    }

    public function post(Request $r): Response
    {
        $p = $this->app->principal();
        $name = $r->param('name');
        $cfg = $this->app->config->powerAutomate();
        $url = $cfg['flows'][$name] ?? '';
        if ($url === '') {
            throw new HttpException(503, 'flow_not_configured');
        }
        if (!str_starts_with($url, 'https://') && !$this->app->config->isDevelopment()) {
            throw new HttpException(500, 'flow_url_insecure');
        }
        $this->app->rate->hit('paflow:' . $p->id, 60, 60);
        $payload = $r->json();
        if (array_key_exists('key', $payload)) {
            $payload['key'] = $cfg['shared_key'];   // Schlüssel setzt der Server (nicht mehr im Browser)
        }
        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => ['Content-Type: text/plain'],   // wie bisher vom Browser gesendet
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 25,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $resp = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (!is_string($resp)) {
            throw new HttpException(502, 'flow_unreachable');
        }
        $this->app->audit->log($p->id, 'flow_called', 'flow', $name, null, ['status' => $status]);
        return Response::json(['ok' => $status >= 200 && $status < 300, 'status' => $status], $status >= 200 && $status < 300 ? 200 : 502);
    }
}
