<?php
declare(strict_types=1);

namespace PS;

// Grundbausteine: Fehler, Werte-Hilfen (JavaScript-nahe Vergleiche) und JSON-Ausgabe.
// Dokumente sind stdClass-Objekte (JSON-Objekte) und PHP-Arrays (JSON-Listen) - nie
// Assoziativ-Arrays, damit {} und [] sowie Schluessel wie "0" erhalten bleiben.

final class ApiError extends \Exception
{
    public int $status;
    public string $errCode;

    public function __construct(int $status, string $code, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errCode = $code;
    }
}

// Fehlercodes entsprechen bewusst den bisherigen Codes der App (permission-denied usw.), damit sie unveraendert darauf reagiert.
final class E
{
    public static function unauth(string $m = 'Nicht angemeldet.'): ApiError { return new ApiError(401, 'unauthenticated', $m); }
    public static function denied(string $m = 'Keine Berechtigung.'): ApiError { return new ApiError(403, 'permission-denied', $m); }
    public static function notFound(string $m = 'Nicht gefunden.'): ApiError { return new ApiError(404, 'not-found', $m); }
    public static function bad(string $m = 'Ungueltige Anfrage.'): ApiError { return new ApiError(400, 'invalid-argument', $m); }
    public static function conflict(string $m = 'Konflikt, bitte erneut versuchen.'): ApiError { return new ApiError(409, 'aborted', $m); }
    public static function unavailable(string $m = 'Dienst nicht erreichbar.'): ApiError { return new ApiError(503, 'unavailable', $m); }
}

final class Marker
{
    public string $name;
    public function __construct(string $name) { $this->name = $name; }
}

// Fertiges JSON (so wie gespeichert) - wird beim Ausgeben unveraendert eingefuegt.
final class Raw
{
    public string $json;
    public function __construct(string $json) { $this->json = $json; }
}

final class Val
{
    private static ?Marker $undef = null;
    private static ?Marker $del = null;

    public static function undef(): Marker { return self::$undef ??= new Marker('undefined'); }
    public static function del(): Marker { return self::$del ??= new Marker('delete'); }

    public static function isObj($v): bool { return $v instanceof \stdClass; }
    public static function isNum($v): bool { return is_int($v) || is_float($v); }

    // Feld eines Objekts oder undef()
    public static function get($o, string $k)
    {
        return ($o instanceof \stdClass && property_exists($o, $k)) ? $o->$k : self::undef();
    }

    // Wert oder Standard (fehlend/null)
    public static function opt($o, string $k, $default = null)
    {
        $v = self::get($o, $k);
        return ($v === self::undef() || $v === null) ? $default : $v;
    }

    // Punkt-Pfad ("a.b.c") in verschachtelten Objekten
    public static function path($data, string $path)
    {
        $cur = $data;
        foreach (explode('.', $path) as $k) {
            if ($cur instanceof \stdClass) {
                if (!property_exists($cur, $k)) return self::undef();
                $cur = $cur->$k;
            } elseif (is_array($cur) && ctype_digit($k) && array_key_exists((int)$k, $cur)) {
                $cur = $cur[(int)$k];
            } else {
                return self::undef();
            }
        }
        return $cur;
    }

    public static function copy($v)
    {
        if ($v instanceof \stdClass) {
            $o = new \stdClass();
            foreach ($v as $k => $x) $o->{(string)$k} = self::copy($x);
            return $o;
        }
        if (is_array($v)) return array_map([self::class, 'copy'], $v);
        return $v;
    }

    // JavaScript: String(v)
    public static function jsString($v): string
    {
        if (is_string($v)) return $v;
        if (is_int($v)) return (string)$v;
        if (is_float($v)) {
            if ($v == floor($v) && abs($v) < 1e15) return (string)(int)$v;
            $s = json_encode($v);
            return $s === false ? 'NaN' : $s;
        }
        if (is_bool($v)) return $v ? 'true' : 'false';
        if ($v === null) return 'null';
        if ($v instanceof Marker) return 'undefined';
        if (is_array($v)) return implode(',', array_map(fn($x) => ($x === null ? '' : self::jsString($x)), $v));
        return '[object Object]';
    }

    // JavaScript: Boolean(v)
    public static function truthy($v): bool
    {
        if ($v instanceof Marker || $v === null || $v === false || $v === 0 || $v === 0.0 || $v === '') return false;
        return true;
    }

    // JavaScript: a === b (fuer Werte aus JSON)
    public static function eq($a, $b): bool
    {
        if (is_string($a) && is_string($b)) return $a === $b;
        if (self::isNum($a) && self::isNum($b)) return $a == $b;
        if (is_bool($a) && is_bool($b)) return $a === $b;
        if ($a === null && $b === null) return true;
        return false;
    }

    // Vergleich gleichartiger Werte (Zahl/Text/Wahrheitswert); null = verschiedene Typen
    public static function cmpSame($a, $b): ?int
    {
        if (self::isNum($a) && self::isNum($b)) return $a <=> $b;
        if (is_string($a) && is_string($b)) { $c = strcmp($a, $b); return $c < 0 ? -1 : ($c > 0 ? 1 : 0); }
        if (is_bool($a) && is_bool($b)) return ((int)$a) <=> ((int)$b);
        return null;
    }

    // Sortier-Vergleich wie in der bisherigen Schnittstelle
    public static function cmp($a, $b): int
    {
        if (self::eq($a, $b)) return 0;
        if (self::isNum($a) && self::isNum($b)) return $a < $b ? -1 : 1;
        return strcmp(self::jsString($a), self::jsString($b)) < 0 ? -1 : 1;
    }

    public static function inList($v, $list): bool
    {
        if (!is_array($list)) return false;
        foreach ($list as $x) if (self::eq($v, $x)) return true;
        return false;
    }

    public static function nowMs(): int { return (int)floor(microtime(true) * 1000); }
}

final class Json
{
    // Eigener Encoder: kennt Raw, behaelt {} bei stdClass und []/{} bei Arrays bei.
    public static function encode($v, int $depth = 0): string
    {
        if ($depth > 64) throw E::bad('Daten zu tief verschachtelt.');
        if ($v instanceof Raw) return $v->json;
        if ($v === null) return 'null';
        if (is_bool($v)) return $v ? 'true' : 'false';
        if (is_int($v)) return (string)$v;
        if (is_float($v)) {
            if (!is_finite($v)) throw E::bad('Ungueltige Zahl.');
            return json_encode($v);
        }
        if (is_string($v)) return self::str($v);
        if (is_array($v)) {
            $isList = true;
            $i = 0;
            foreach ($v as $k => $_) { if ($k !== $i++) { $isList = false; break; } }
            $parts = [];
            if ($isList) {
                foreach ($v as $x) $parts[] = self::encode($x, $depth + 1);
                return '[' . implode(',', $parts) . ']';
            }
            foreach ($v as $k => $x) $parts[] = self::str((string)$k) . ':' . self::encode($x, $depth + 1);
            return '{' . implode(',', $parts) . '}';
        }
        if ($v instanceof \stdClass) {
            $parts = [];
            foreach ($v as $k => $x) $parts[] = self::str((string)$k) . ':' . self::encode($x, $depth + 1);
            return '{' . implode(',', $parts) . '}';
        }
        throw E::bad('Ungueltiger Wert.');
    }

    public static function str(string $s): string
    {
        $r = json_encode($s, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($r === false) throw E::bad('Ungueltiges Textzeichen.');
        return $r;
    }

    // Eingehendes JSON -> stdClass/Array. Wirft invalid-argument.
    public static function decode(string $json)
    {
        try {
            return json_decode($json, false, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw E::bad('Kein gueltiges JSON.');
        }
    }
}
