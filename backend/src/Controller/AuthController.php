<?php
declare(strict_types=1);

namespace HeTec\PS\Controller;

use HeTec\PS\App;
use HeTec\PS\Auth\EntraLogin;
use HeTec\PS\Http\HttpException;
use HeTec\PS\Http\Request;
use HeTec\PS\Http\Response;

final class AuthController
{
    public function __construct(private App $app)
    {
    }

    public function health(Request $r): Response
    {
        return Response::json(['ok' => true, 'version' => App::VERSION]);
    }

    /** Zustand der Sitzung + Profil + Rechte (ersetzt das Firestore-Profil users/{uid}). */
    public function session(Request $r): Response
    {
        $p = $this->app->principal();
        $s = $this->app->config->session();
        if ($p === null) {
            $pending = $this->app->session->get('pending_uid');
            $status = 'anonymous';
            $name = '';
            if (is_int($pending)) {
                $u = $this->app->users->findById($pending);
                if ($u) {
                    $status = (string) $u['status'];
                    $name = (string) $u['display_name'];
                }
            }
            // CSRF-Token auch ohne Freigabe (z. B. wartende Konten), damit die Abmeldung serverseitig möglich ist
            $this->app->session->ensureStarted();
            return Response::json(['ok' => true, 'authenticated' => false, 'status' => $status, 'name' => $name,
                'csrfToken' => $this->app->session->csrfToken(), 'version' => App::VERSION]);
        }
        $u = $this->app->users->findById($p->id) ?? [];
        return Response::json([
            'ok' => true,
            'authenticated' => true,
            'version' => App::VERSION,
            'csrfToken' => $this->app->session->csrfToken(),
            'offlineGraceHours' => $s['offline_grace_hours'],
            'serverTime' => time(),
            'user' => [
                'id' => $p->publicId,
                'email' => $p->email,
                'name' => $p->displayName,
                'anrede' => (string) ($u['anrede'] ?? ''),
                'vorname' => (string) ($u['vorname'] ?? ''),
                'nachname' => (string) ($u['nachname'] ?? ''),
                'role' => $p->roleId,
                'isAdmin' => $p->isAdmin(),
                'permissions' => $p->permissions,
                'homeShopId' => $p->homeShopId,
                'allowedShopIds' => $p->shopIds,
                'allShops' => $p->allShops,
                'isTestUser' => $p->isTestUser,
                'needsName' => trim((string) ($u['nachname'] ?? '')) === '' && trim($p->displayName) === '',
            ],
        ]);
    }

    public function login(Request $r): Response
    {
        $this->app->rate->hit('login:' . $r->ip, 30, 300);
        return Response::redirect($this->app->entra->begin($r->q('returnTo', '/')));
    }

    public function callback(Request $r): Response
    {
        $this->app->rate->hit('callback:' . $r->ip, 30, 300);
        return Response::redirect($this->app->entra->complete());
    }

    public function logout(Request $r): Response
    {
        $p = $this->app->principal();
        if ($p) {
            $this->app->audit->log($p->id, 'logout', 'user', $p->publicId);
        }
        $this->app->session->destroy();
        return Response::json(['ok' => true, 'logoutUrl' => $this->app->entra->logoutUrl()]);
    }

    /** Einmalige Namensergänzung (wie bisher „Profil vervollständigen“), nur wenn der Name fehlt. */
    public function updateProfile(Request $r): Response
    {
        $p = $this->app->principal();
        $cur = $this->app->users->findById($p->id) ?? [];
        if (trim((string) ($cur['nachname'] ?? '')) !== '' || trim((string) ($cur['display_name'] ?? '')) !== '') {
            throw new HttpException(409, 'profile_complete');   // Namensänderung nur durch Admin
        }
        $b = $r->json();
        $vorname = trim(mb_substr((string) ($b['vorname'] ?? ''), 0, 80));
        $nachname = trim(mb_substr((string) ($b['nachname'] ?? ''), 0, 80));
        $anrede = (string) ($b['anrede'] ?? '');
        if ($nachname === '' || !in_array($anrede, ['', 'Herr', 'Frau', 'Divers'], true)) {
            throw new HttpException(422, 'invalid_profile');
        }
        $name = $vorname !== '' ? trim($vorname . ' ' . $nachname) : $nachname;
        $this->app->db->exec(
            'UPDATE users SET vorname = :v, nachname = :n, display_name = :d, anrede = :a WHERE id = :id',
            ['v' => $vorname, 'n' => $nachname, 'd' => $name, 'a' => $anrede, 'id' => $p->id]
        );
        $this->app->audit->log($p->id, 'profile_updated', 'user', $p->publicId);
        return Response::json(['ok' => true, 'name' => $name]);
    }
}
