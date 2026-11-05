<?php
declare(strict_types=1);

namespace PS;

// Fuehrt die Datenbank-Operationen der App aus (get / query / set / update / delete / add / batch).
// Gleiche Schnittstelle wie bisher - die App merkt keinen Unterschied zu Firestore.
final class Engine
{
    private const COLLECTIONS = ['users', 'analytics', 'saved_offers', 'pdf_index', 'skip_limits', 'tool_usage', 'news', 'aktionsmappe', 'portierung_files'];
    private const OPS = ['==', '!=', '<', '<=', '>', '>=', 'in', 'array-contains', 'array-contains-any'];
    private const MAX_BATCH = 500;
    private const MAX_RESULT = 100000;
    private const FILE_TTL_MS = 24 * 3600 * 1000;

    private Store $store;
    /** @var array<string,\stdClass> */
    private array $profiles = [];

    public function __construct(Store $store) { $this->store = $store; }

    public function store(): Store { return $this->store; }

    // ---------------------------------------------------------------- Werte ----
    private static function str($v, string $what = 'Wert', int $max = 300): string
    {
        if (!is_string($v) || $v === '' || strlen($v) > $max) throw E::bad($what . ' fehlt oder ist ungueltig.');
        return $v;
    }

    private static function assertSafe($v, int $depth = 0): void
    {
        if ($depth > 20) throw E::bad('Daten zu tief verschachtelt.');
        if (is_array($v)) { foreach ($v as $x) self::assertSafe($x, $depth + 1); return; }
        if ($v instanceof \stdClass) {
            foreach ($v as $k => $x) {
                if ($k === '__proto__' || $k === 'constructor' || $k === 'prototype') throw E::bad('Ungueltiger Feldname.');
                self::assertSafe($x, $depth + 1);
            }
        }
    }

    // Platzhalter der App: increment / serverTimestamp / delete
    private static function resolve($cur, $v)
    {
        if ($v instanceof \stdClass) {
            $ps = Val::get($v, '__ps');
            if ($ps === 'inc') {
                $n = Val::get($v, 'n');
                if (!Val::isNum($n) || !is_finite((float)$n)) throw E::bad('Ungueltiger Zaehlerwert.');
                return (Val::isNum($cur) ? $cur : 0) + $n;
            }
            if ($ps === 'ts') return Val::nowMs();
            if ($ps === 'del') return Val::del();
            $out = new \stdClass();
            foreach ($v as $k => $x) {
                $r = self::resolve(Val::get($cur, (string)$k), $x);
                if ($r !== Val::del()) $out->{(string)$k} = $r;
            }
            return $out;
        }
        return $v;
    }

    private static function hasPs($v): bool { return $v instanceof \stdClass && Val::truthy(Val::get($v, '__ps')); }

    private static function deepMerge(\stdClass $base, \stdClass $data): \stdClass
    {
        $out = clone $base;
        foreach ($data as $k => $v) {
            $k = (string)$k;
            $cur = Val::get($out, $k);
            if ($v instanceof \stdClass && !self::hasPs($v) && $cur instanceof \stdClass) {
                $out->$k = self::deepMerge($cur, $v);
            } else {
                $r = self::resolve($cur, $v);
                if ($r === Val::del()) unset($out->$k); else $out->$k = $r;
            }
        }
        return $out;
    }

    private static function applyUpdate(?\stdClass $base, \stdClass $data): \stdClass
    {
        $out = $base === null ? new \stdClass() : Val::copy($base);
        foreach ($data as $path => $v) {
            $parts = explode('.', (string)$path);
            $node = $out;
            for ($i = 0; $i < count($parts) - 1; $i++) {
                $p = $parts[$i];
                if (!(Val::get($node, $p) instanceof \stdClass)) $node->$p = new \stdClass();
                $node = $node->$p;
            }
            $last = $parts[count($parts) - 1];
            $r = self::resolve(Val::get($node, $last), $v);
            if ($r === Val::del()) unset($node->$last); else $node->$last = $r;
        }
        return $out;
    }

    private static function applyWrite(?\stdClass $old, \stdClass $data, string $op, bool $merge): \stdClass
    {
        if ($op === 'update') return self::applyUpdate($old, $data);
        if ($merge && $old !== null) return self::deepMerge($old, $data);
        $r = self::resolve(Val::undef(), $data);
        if (!($r instanceof \stdClass)) throw E::bad('Daten ungueltig.');
        return $r;
    }

    // -------------------------------------------------------------- Abfragen ----
    private static function matches(\stdClass $data, string $id, array $w): bool
    {
        $v = $w[0] === '__name__' ? $id : Val::path($data, $w[0]);
        $x = $w[2];
        if ($v === Val::undef()) return false;
        switch ($w[1]) {
            case '==': return Val::eq($v, $x);
            case '!=': return !Val::eq($v, $x);
            case '<': case '<=': case '>': case '>=':
                $c = Val::cmpSame($v, $x);
                if ($c === null) return false;
                return $w[1] === '<' ? $c < 0 : ($w[1] === '<=' ? $c <= 0 : ($w[1] === '>' ? $c > 0 : $c >= 0));
            case 'in': return Val::inList($v, $x);
            case 'array-contains': return is_array($v) && Val::inList($x, $v);
            case 'array-contains-any':
                if (!is_array($v) || !is_array($x)) return false;
                foreach ($x as $y) if (Val::inList($y, $v)) return true;
                return false;
        }
        return false;
    }

    private static function fieldName($f): string
    {
        $f = Val::jsString($f);
        if (!preg_match('/^(__name__|[A-Za-z0-9_][A-Za-z0-9_.\-]{0,99})$/', $f)) throw E::bad('Feldname ungueltig.');
        return $f;
    }

    private static function normWheres($w): array
    {
        if ($w === null || $w instanceof Marker) return [];
        if (!is_array($w) || count($w) > 10) throw E::bad('where ungueltig.');
        $out = [];
        foreach ($w as $x) {
            if (!is_array($x) || count($x) !== 3) throw E::bad('where ungueltig.');
            $f = self::fieldName($x[0]);
            if (!is_string($x[1]) || !in_array($x[1], self::OPS, true)) throw E::bad('Operator ungueltig.');
            self::assertSafe($x[2]);
            $out[] = [$f, $x[1], $x[2]];
        }
        return $out;
    }

    private static function normOrder($o): array
    {
        if ($o === null || $o instanceof Marker) return [];
        if (!is_array($o) || count($o) > 3) throw E::bad('orderBy ungueltig.');
        $out = [];
        foreach ($o as $x) {
            $f = self::fieldName(is_array($x) ? ($x[0] ?? '') : $x);
            $d = is_array($x) && ($x[1] ?? null) === 'desc' ? 'desc' : 'asc';
            $out[] = [$f, $d];
        }
        return $out;
    }

    private function coll($c): string
    {
        if (!is_string($c) || !in_array($c, self::COLLECTIONS, true)) throw E::denied('Unbekannte Sammlung.');
        return $c;
    }

    // ----------------------------------------------------------- Profil ----
    private static function has($v): bool { return is_string($v) && trim($v) !== ''; }

    private function deriveProfile(Ctx $ctx, ?\stdClass $stored): \stdClass
    {
        $s = $stored ?? new \stdClass();
        $vorname = $ctx->given;
        $nachname = $ctx->family;
        if ($vorname === '' && $nachname === '' && $ctx->name !== '') {
            if (strpos($ctx->name, ',') !== false) {
                $pp = explode(',', $ctx->name);
                $nachname = trim($pp[0]);
                $vorname = trim(implode(',', array_slice($pp, 1)));
            } else {
                $p = preg_split('/\s+/', $ctx->name);
                $vorname = count($p) > 1 ? $p[0] : '';
                $nachname = count($p) > 1 ? implode(' ', array_slice($p, 1)) : $p[0];
            }
        }
        $sName = Val::get($s, 'name');
        $sVor = Val::get($s, 'vorname');
        $sNach = Val::get($s, 'nachname');
        $name = self::has($sName) ? $sName : ($ctx->name !== '' ? $ctx->name : (trim($vorname . ' ' . $nachname) !== '' ? trim($vorname . ' ' . $nachname) : $ctx->email));
        $p = clone $s;
        $p->email = $ctx->email;
        $p->name = $name;
        $p->vorname = (self::has($sVor) || self::has($sNach)) ? (Val::truthy($sVor) ? $sVor : '') : $vorname;
        $p->nachname = self::has($sNach) ? $sNach : (self::has($sVor) ? '' : $nachname);
        $p->role = $ctx->isAdmin ? 'admin' : 'verkaeufer';
        $p->regional = $ctx->isRegional;
        $p->allShops = $ctx->allShops;
        $p->active = $ctx->active;
        $p->status = $ctx->active ? 'approved' : ($ctx->reason !== '' ? $ctx->reason : 'no-group');
        $p->shopId = $ctx->isAdmin ? '' : $ctx->home;
        $p->shop = $ctx->isAdmin ? 'Verwaltung / Alle Shops' : $ctx->home;
        $p->allowedShopIds = $ctx->shops;
        $p->isTestUser = Val::get($s, 'isTestUser') === true;
        $ca = Val::get($s, 'createdAt');
        $p->createdAt = Val::truthy($ca) ? $ca : Val::nowMs();
        return $p;
    }

    private function ensureProfile(Ctx $ctx): \stdClass
    {
        if (isset($this->profiles[$ctx->uid])) return $this->profiles[$ctx->uid];
        $cur = $this->store->get('users', $ctx->uid);
        $curData = $cur ? Json::decode($cur['json']) : null;
        $base = $curData instanceof \stdClass ? $curData : null;
        if ($base === null && $ctx->active) {
            // Erstanmeldung: Profil eines frueheren Firebase-Kontos mit gleicher E-Mail uebernehmen
            try {
                $found = null;
                $this->store->scan('users', [[['k_email', $ctx->email]]], [], function (string $id, string $json) use ($ctx, &$found) {
                    if ($id !== $ctx->uid) { $found = [$id, Json::decode($json)]; return false; }
                    return true;
                });
                if ($found !== null && $found[1] instanceof \stdClass) {
                    [$lid, $l] = $found;
                    $legacy = [$lid];
                    $ll = Val::get($l, 'legacyUids');
                    if (is_array($ll)) foreach ($ll as $x) $legacy[] = Val::jsString($x);
                    $base = new \stdClass();
                    $base->legacyUids = $legacy;
                    foreach (['name', 'vorname', 'nachname', 'anrede', 'isTestUser'] as $k) {
                        $v = Val::get($l, $k);
                        if ($v !== Val::undef()) $base->$k = $v;
                    }
                }
            } catch (ApiError $e) { throw $e; } catch (\Throwable $e) { /* Uebernahme ist optional */ }
        }
        $profile = $this->deriveProfile($ctx, $base);
        if ($ctx->active) {
            $hourAgo = Val::nowMs() - 3600000;
            $stale = true;
            if ($curData instanceof \stdClass) {
                $a = clone $curData; $a->lastLoginAt = 0;
                $b = clone $profile; $b->lastLoginAt = 0;
                $last = Val::get($curData, 'lastLoginAt');
                $stale = Json::encode($a) !== Json::encode($b) || !(Val::isNum($last) && $last > $hourAgo);
            }
            if ($stale) {
                $profile->lastLoginAt = Val::nowMs();
                $this->store->put('users', $ctx->uid, $profile);
            } else {
                $profile->lastLoginAt = Val::get($curData, 'lastLoginAt');
            }
        }
        return $this->profiles[$ctx->uid] = $profile;
    }

    // Eigene Kennungen (inkl. aus Firebase uebernommener alter Kennungen) fuer analytics / pdf_index laden
    private function prepare(?Ctx $ctx, string $coll): void
    {
        if ($ctx !== null && $ctx->active && ($coll === 'analytics' || $coll === 'pdf_index') && !$ctx->legacyLoaded) {
            $p = $this->ensureProfile($ctx);
            $ids = [$ctx->uid];
            $lu = Val::get($p, 'legacyUids');
            if (is_array($lu)) foreach ($lu as $x) { $x = Val::jsString($x); if (!in_array($x, $ids, true)) $ids[] = $x; }
            $ctx->ownUids = $ids;
            $ctx->legacyLoaded = true;
        }
    }

    // ------------------------------------------------------------- Lesen ----
    private function opGet(\stdClass $body, ?Ctx $ctx): array
    {
        $coll = $this->coll(Val::get($body, 'c'));
        $id = self::str(Val::get($body, 'id'), 'id', 250);
        if ($coll === 'users' && $ctx !== null && $id === $ctx->uid) {
            return ['doc' => ['id' => $id, 'data' => $this->ensureProfile($ctx)]];
        }
        if ($coll === 'portierung_files') {
            Rules::checkRead(null, $coll, $id, null);
            $d = $this->store->get($coll, $id);
            if ($d === null || ($d['modified'] > 0 && Val::nowMs() - $d['modified'] > self::FILE_TTL_MS)) return ['doc' => null];
            return ['doc' => ['id' => $id, 'data' => new Raw($d['json'])]];
        }
        $this->prepare($ctx, $coll);
        if ($ctx === null) throw E::unauth();
        $doc = $this->store->get($coll, $id);
        $data = $doc ? Json::decode($doc['json']) : null;
        Rules::checkRead($ctx, $coll, $id, $data instanceof \stdClass ? $data : null);
        return ['doc' => $doc ? ['id' => $id, 'data' => new Raw($doc['json'])] : null];
    }

    // Zerlegt die Bedingungen einer Variante: Datenbank-Spalten, Vorfilter (LIKE) und Rest (im Speicher)
    private static function split(array $wheres): array
    {
        $cols = []; $likes = []; $rest = [];
        foreach ($wheres as $w) {
            [$f, $op, $x] = $w;
            if ($op === '==' && $f === '__name__' && is_string($x) && $x !== '' && strlen($x) <= 250) { $cols[] = ['id', $x]; $rest[] = $w; continue; }
            if ($op === '==' && isset(Store::PUSH[$f]) && is_string($x) && strlen($x) <= ($f === 'ts' ? Store::MAX_TS : Store::MAX_KEY)) {
                $cols[] = [Store::PUSH[$f], $x];
                continue; // die Datenbank vergleicht exakt (binaer)
            }
            // Vorfilter: der Wert muss als JSON-Text im Dokument vorkommen (nur eindeutig kodierbare ASCII-Texte)
            if (($op === '==' || $op === 'array-contains') && is_string($x) && $x !== '' && strlen($x) <= 200 && preg_match('/^[\x20-\x7e]+$/', $x) && strpos($x, '/') === false) {
                $likes[] = Json::str($x);
            }
            $rest[] = $w;
        }
        return [$cols, $likes, $rest];
    }

    private function memoryGuard(): void
    {
        $lim = ini_get('memory_limit');
        if ($lim === false || $lim === '-1' || $lim === '') return;
        $n = (float)$lim;
        $u = strtolower(substr($lim, -1));
        if ($u === 'g') $n *= 1073741824; elseif ($u === 'm') $n *= 1048576; elseif ($u === 'k') $n *= 1024;
        if ($n > 0 && memory_get_usage(true) > $n * 0.8) throw E::bad('Ergebnis zu gross - bitte Filter einschraenken.');
    }

    private function opQuery(\stdClass $body, ?Ctx $ctx): array
    {
        $coll = $this->coll(Val::get($body, 'c'));
        $this->prepare($ctx, $coll);
        $wheres = self::normWheres(Val::get($body, 'where'));
        $order = self::normOrder(Val::get($body, 'orderBy'));
        $lim = Val::get($body, 'limit');
        $limit = ($lim === Val::undef() || $lim === null) ? self::MAX_RESULT : max(1, min((int)(Val::isNum($lim) ? $lim : (is_string($lim) && is_numeric($lim) ? $lim : 0)), self::MAX_RESULT));
        $variants = Rules::scopeQuery($ctx, $coll, $wheres);
        $after = Val::get($body, 'after');
        $after = $after instanceof \stdClass ? $after : null;

        $res = $this->querySql($coll, $variants, $order, $limit, $after);
        if ($res !== null) return $res;
        return $this->queryGeneric($coll, $variants, $order, $limit, $after);
    }

    // Schneller Weg: Sortierung und Seiten in der Datenbank (nur Standort/Benutzer/E-Mail-Gleichheit + Sortierung nach ts oder ID)
    private function querySql(string $coll, array $variants, array $order, int $limit, ?\stdClass $after): ?array
    {
        $ord = count($order) ? $order : [['__name__', 'asc']];
        if (count($ord) !== 1 || !in_array($ord[0][0], ['__name__', 'ts'], true)) return null;
        $variantCols = [];
        foreach ($variants as $v) {
            [$cols, , $rest] = self::split($v);
            foreach ($rest as $w) { if (!($w[1] === '==' && $w[0] === '__name__')) return null; }
            $variantCols[] = $cols;
        }
        $byTs = $ord[0][0] === 'ts';
        $dir = $ord[0][1];
        $afterKey = null;
        if ($after !== null) {
            $aid = Val::jsString(Val::get($after, 'id') === Val::undef() ? '' : Val::get($after, 'id'));
            $vals = Val::get($after, 'values');
            if ($byTs) {
                $own = $this->store->keyOf($coll, $variantCols, $aid);
                if ($own !== null && $own[0] !== null) {
                    $afterKey = [$own[0], $aid];
                } else {
                    $v0 = is_array($vals) && isset($vals[0]) ? $vals[0] : null;
                    if (!is_string($v0) || strlen($v0) > Store::MAX_TS) return null;
                    $afterKey = [$v0, $aid];
                }
            } else {
                $afterKey = [null, $aid];
            }
        }
        if ($byTs && $this->store->hasBadTs($coll, $variantCols)) return null;
        $rows = $this->store->page($coll, $variantCols, $byTs ? 'k_ts' : 'id', $dir, $afterKey, $limit + 1);
        $more = count($rows) > $limit;
        if ($more) array_pop($rows);
        $docs = [];
        foreach ($rows as $r) $docs[] = ['id' => $r[0], 'data' => new Raw($r[1])];
        return ['docs' => $docs, 'more' => $more];
    }

    // Allgemeiner Weg: laden, im Speicher filtern, sortieren, in Seiten teilen
    private function queryGeneric(string $coll, array $variants, array $order, int $limit, ?\stdClass $after): array
    {
        $seen = [];
        foreach ($variants as $v) {
            [$cols, $likes, $rest] = self::split($v);
            $take = function (string $id, string $json) use (&$seen, $rest): void {
                $data = Json::decode($json);
                if (!($data instanceof \stdClass)) return;
                foreach ($rest as $w) if (!self::matches($data, $id, $w)) return;
                $seen[$id] = [$id, $data, $json];
                if (count($seen) > self::MAX_RESULT) throw E::bad('Zu viele Treffer.');
                if ((count($seen) & 255) === 0) $this->memoryGuard();
            };
            $idEq = null;
            foreach ($cols as $c) if ($c[0] === 'id') $idEq = $c[1];
            if ($idEq !== null) {
                $d = $this->store->get($coll, $idEq);
                if ($d !== null) $take($idEq, $d['json']);
            } else {
                $this->store->scan($coll, [$cols], $likes, function (string $id, string $json) use ($take) { $take($id, $json); return true; });
            }
        }
        $rows = array_values($seen);
        $ord = count($order) ? $order : [['__name__', 'asc']];
        $val = fn(array $d, string $f) => $f === '__name__' ? $d[0] : Val::path($d[1], $f);
        if (count($order)) {
            $rows = array_values(array_filter($rows, function ($d) use ($order, $val) {
                foreach ($order as $o) if ($val($d, $o[0]) === Val::undef()) return false;
                return true;
            }));
        }
        usort($rows, function ($a, $b) use ($ord, $val) {
            foreach ($ord as $o) {
                $c = Val::cmp($val($a, $o[0]), $val($b, $o[0]));
                if ($c) return $o[1] === 'desc' ? -$c : $c;
            }
            return Val::cmp($a[0], $b[0]);
        });
        $start = 0;
        if ($after !== null) {
            $vals = Val::get($after, 'values');
            $vals = is_array($vals) ? $vals : [];
            $afterId = Val::jsString(Val::get($after, 'id') === Val::undef() ? '' : Val::get($after, 'id'));
            $pos = -1;
            foreach ($rows as $i => $d) if ($d[0] === $afterId) { $pos = $i; break; }
            if ($pos !== -1) {
                $start = $pos + 1;
            } else {
                $start = -1;
                foreach ($rows as $i => $d) {
                    $decided = false; $greater = false;
                    foreach ($ord as $k => $o) {
                        $c = Val::cmp($val($d, $o[0]), $vals[$k] ?? Val::undef());
                        if ($c) { $greater = ($o[1] === 'desc' ? -$c : $c) > 0; $decided = true; break; }
                    }
                    if (!$decided) $greater = Val::cmp($d[0], $afterId) > 0;
                    if ($greater) { $start = $i; break; }
                }
                if ($start === -1) $start = count($rows);
            }
        }
        $page = array_slice($rows, $start, $limit);
        $docs = [];
        foreach ($page as $d) $docs[] = ['id' => $d[0], 'data' => new Raw($d[2])];
        return ['docs' => $docs, 'more' => $start + $limit < count($rows)];
    }

    // ----------------------------------------------------------- Schreiben ----
    private function writeOne($w, ?Ctx $ctx): array
    {
        if (!($w instanceof \stdClass)) throw E::bad('Schreib-Operation ungueltig.');
        $op = Val::get($w, 'op');
        if (!is_string($op) || !in_array($op, ['set', 'update', 'delete', 'add'], true)) throw E::bad('Unbekannte Schreib-Operation.');
        $coll = $this->coll(Val::get($w, 'c'));
        $this->prepare($ctx, $coll);
        $wop = $op === 'add' ? 'set' : $op;
        $id = $op === 'add' ? bin2hex(random_bytes(10)) : self::str(Val::get($w, 'id'), 'id', 250);
        $data = Val::get($w, 'data');
        if ($wop !== 'delete') {
            if (!($data instanceof \stdClass)) throw E::bad('Daten fehlen.');
            self::assertSafe($data);
        }
        if ($ctx === null) throw E::unauth();
        if ($wop === 'delete') {
            $cur = $this->store->get($coll, $id);
            $old = $cur ? Json::decode($cur['json']) : null;
            Rules::checkWrite($ctx, $coll, $id, 'delete', null, $old instanceof \stdClass ? $old : null);
            $this->store->remove($coll, $id);
        } else {
            $merge = Val::get($w, 'merge') === true;
            $this->store->mutate($coll, $id, function (?\stdClass $old) use ($ctx, $coll, $id, $wop, $data, $merge) {
                if ($wop === 'update' && $old === null) throw E::notFound('Dokument existiert nicht.');
                $checked = Rules::checkWrite($ctx, $coll, $id, $wop, $data, $old);
                return self::applyWrite($old, $checked, $wop, $merge);
            });
        }
        if ($coll === 'portierung_files' && preg_match('/-0$/', $id) && $wop === 'set') {
            try { $this->store->removeOlderThan('portierung_files', Val::nowMs() - self::FILE_TTL_MS - 3600000); } catch (\Throwable $e) { /* Aufraeumen ist best effort */ }
        }
        if ($coll === 'users') unset($this->profiles[$id]);
        return ['id' => $id];
    }

    private function opBatch(\stdClass $body, ?Ctx $ctx): array
    {
        $ops = Val::get($body, 'ops');
        if (!is_array($ops) || !count($ops) || count($ops) > self::MAX_BATCH) throw E::bad('Batch ungueltig.');
        $n = 0;
        foreach ($ops as $w) {
            if ($w instanceof \stdClass && Val::get($w, 'op') === 'add') throw E::bad('add im Batch nicht erlaubt.');
            $this->writeOne($w, $ctx);
            $n++;
        }
        return ['n' => $n];
    }

    // Einstieg: gibt das Ergebnis (ohne "ok") als Array zurueck
    public function handle($body, ?Ctx $ctx): array
    {
        if (!($body instanceof \stdClass)) throw E::bad('Anfrage ungueltig.');
        $op = Val::get($body, 'op');
        switch (is_string($op) ? $op : '') {
            case 'get': return $this->opGet($body, $ctx);
            case 'query': return $this->opQuery($body, $ctx);
            case 'set': case 'update': case 'delete': case 'add': return $this->writeOne($body, $ctx);
            case 'batch': return $this->opBatch($body, $ctx);
        }
        throw E::bad('Unbekannte Operation.');
    }
}
