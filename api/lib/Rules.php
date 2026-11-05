<?php
declare(strict_types=1);

namespace PS;

// Zugriffsregeln je Sammlung. Ersetzt die frueheren Regeln - aber strenger:
// JEDE Anfrage braucht ein gueltiges Entra-Login (Ausnahme: das Kunden-Download-Dokument per
// QR-Code), Shops und Rollen kommen aus den Gruppen.
final class Rules
{
    public const FILE_ID = '/^[a-f0-9]{32}-\d{1,3}$/';

    private static function isInc($v, ?int $n): bool
    {
        if (!($v instanceof \stdClass) || Val::get($v, '__ps') !== 'inc') return false;
        if ($n === null) return true;
        $x = Val::get($v, 'n');
        return Val::isNum($x) && $x == $n;
    }

    private static function need(?Ctx $ctx): Ctx
    {
        if ($ctx === null) throw E::unauth();
        if (!$ctx->active) throw E::denied('Kein Zugang: Konto ist keiner Pencil-Selling-Gruppe zugeordnet.');
        return $ctx;
    }

    private static function own(Ctx $ctx, $v): bool
    {
        return in_array(Val::truthy($v) ? Val::jsString($v) : '', $ctx->ownUids, true);
    }

    // ---- Einzel-Dokument lesen ---------------------------------------------
    public static function checkRead(?Ctx $ctx, string $coll, string $id, ?\stdClass $d): void
    {
        if ($coll === 'portierung_files') {
            if (!preg_match(self::FILE_ID, $id)) throw E::denied();
            return; // oeffentlich (unratbare 128-Bit-ID, 24 h gueltig) - fuer den QR-Download
        }
        $ctx = self::need($ctx);
        switch ($coll) {
            case 'users':
                if ($id === $ctx->uid || $ctx->isAdmin) return;
                throw E::denied();
            case 'analytics':
                if ($d === null || $ctx->isStaff || self::own($ctx, Val::get($d, 'userUid'))) return;
                throw E::denied();
            case 'saved_offers':
            case 'pdf_index':
                if ($d === null || Auth::canShop($ctx, Val::get($d, 'shopId'))) return;
                throw E::denied();
            case 'skip_limits':
            case 'news':
            case 'aktionsmappe':
                return;
            case 'tool_usage':
                if ($ctx->isStaff) return;
                throw E::denied();
            default:
                throw E::denied();
        }
    }

    // ---- Einzel-Dokument schreiben: gibt (ggf. korrigierte) Daten zurueck ----
    // op: 'set' | 'update' | 'delete'; $old = bisheriges Dokument oder null
    public static function checkWrite(?Ctx $ctx, string $coll, string $id, string $op, ?\stdClass $data, ?\stdClass $old): ?\stdClass
    {
        if ($op !== 'delete' && $data === null) throw E::bad('Daten fehlen.');

        if ($coll === 'portierung_files') {
            self::need($ctx);
            if (!preg_match(self::FILE_ID, $id)) throw E::denied();
            if ($op === 'update') throw E::denied();
            return $data;
        }
        $ctx = self::need($ctx);

        switch ($coll) {
            case 'users':
                if ($ctx->isAdmin) return $data;
                if ($id === $ctx->uid && $op === 'update') {
                    $ok = true;
                    foreach ($data as $k => $_) if (!in_array((string)$k, ['name', 'vorname', 'nachname'], true)) $ok = false;
                    if ($ok) return $data;
                }
                throw E::denied();

            case 'analytics':
                if ($op === 'delete' || $op === 'update') {
                    if ($ctx->isAdmin) return $data;
                    throw E::denied();
                }
                if ($old !== null && !$ctx->isAdmin && !self::own($ctx, Val::get($old, 'userUid'))) throw E::denied();
                $out = clone $data;
                if (!$ctx->isAdmin) {
                    $uu = Val::get($out, 'userUid');
                    if (Val::truthy($uu) && !in_array(Val::jsString($uu), $ctx->ownUids, true)) throw E::denied('Zeile gehoert einem anderen Benutzer.');
                    if (!Val::truthy($uu)) $out->userUid = $ctx->uid;
                }
                $shop = Val::get($out, 'shopId');
                if (Val::truthy($shop) && !Auth::canShop($ctx, $shop) && !$ctx->isAdmin) throw E::denied('Fremder Standort.');
                return $out;

            case 'saved_offers':
                if ($op === 'delete') {
                    if ($old === null || $ctx->isAdmin || Auth::canShop($ctx, Val::get($old, 'shopId'))) return $data;
                    throw E::denied();
                }
                $shop = Val::truthy(Val::get($data, 'shopId')) ? Val::get($data, 'shopId') : Val::get($old, 'shopId');
                if (!$ctx->isAdmin && (!Auth::canShop($ctx, $shop) || ($old !== null && !Auth::canShop($ctx, Val::get($old, 'shopId'))))) throw E::denied('Fremder Standort.');
                return $data;

            case 'pdf_index':
                if ($op === 'delete') {
                    if ($old === null || $ctx->isAdmin || self::own($ctx, Val::get($old, 'uid'))) return $data;
                    throw E::denied();
                }
                $shop = Val::truthy(Val::get($data, 'shopId')) ? Val::get($data, 'shopId') : Val::get($old, 'shopId');
                if (!$ctx->isAdmin && (!Auth::canShop($ctx, $shop) || ($old !== null && !Auth::canShop($ctx, Val::get($old, 'shopId'))))) throw E::denied('Fremder Standort.');
                $out = clone $data;
                if (!$ctx->isAdmin && $op === 'set') $out->uid = $ctx->uid;
                return $out;

            case 'skip_limits':
                if ($ctx->isStaff) return $data;
                if ($op === 'delete' || strpos($id, 'skip_') !== 0) throw E::denied();
                // Mitarbeiter duerfen nur den eigenen Zaehler um 1 erhoehen.
                if (self::isInc(Val::get($data, 'count'), 1)) return $data;
                throw E::denied();

            case 'tool_usage':
                if ($ctx->isStaff) return $data;
                if ($op !== 'delete' && self::isInc(Val::get($data, 'count'), 1)) return $data;
                throw E::denied();

            case 'news':
                if ($ctx->isStaff) return $data;
                throw E::denied();

            case 'aktionsmappe':
                if ($ctx->isAdmin) return $data;
                throw E::denied();

            default:
                throw E::denied();
        }
    }

    // ---- Abfragen --------------------------------------------------------
    // Gibt eine Liste von Where-Varianten zurueck (Ergebnisse werden vereinigt).
    // $wheres: Liste von [feld, operator, wert]
    public static function scopeQuery(?Ctx $ctx, string $coll, array $wheres): array
    {
        $ctx = self::need($ctx);
        $eq = fn(string $f): array => array_values(array_filter($wheres, fn($w) => $w[0] === $f && $w[1] === '=='));
        $without = fn(string $f): array => array_values(array_filter($wheres, fn($w) => !($w[0] === $f && $w[1] === '==')));
        switch ($coll) {
            case 'users':
                if ($ctx->isAdmin) return [$wheres];
                throw E::denied();
            case 'analytics':
                if ($ctx->isStaff) return [$wheres];
                foreach ($eq('userUid') as $w) if (!in_array(Val::jsString($w[2]), $ctx->ownUids, true)) throw E::denied();
                // Mitarbeiter sehen nur eigene Zeilen (inkl. uebernommener alter Kennungen aus Altdaten)
                return array_map(fn($u) => array_merge($without('userUid'), [['userUid', '==', $u]]), $ctx->ownUids);
            case 'saved_offers':
            case 'pdf_index':
                $asked = $eq('shopId');
                if (count($asked) > 0) {
                    foreach ($asked as $w) if (!Auth::canShop($ctx, $w[2])) throw E::denied('Fremder Standort.');
                    return [$wheres];
                }
                if ($ctx->allShops) return [$wheres];
                if (count($ctx->shops) === 0) throw E::denied();
                return array_map(fn($s) => array_merge($wheres, [['shopId', '==', $s]]), $ctx->shops);
            case 'skip_limits':
            case 'tool_usage':
            case 'news':
                if ($ctx->isStaff) return [$wheres];
                throw E::denied();
            case 'aktionsmappe':
                if ($ctx->isAdmin) return [$wheres];
                throw E::denied();
            default:
                throw E::denied();
        }
    }
}
