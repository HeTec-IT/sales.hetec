#!/usr/bin/env python3
# Hotfix fuer Pencil Selling Beta (index.html / v55.223).
# Auf dem Branch ausfuehren: python3 scripts/apply_o2_ocr_hotfix.py
# Das Skript bricht ohne Schreibzugriff ab, falls sich eine erwartete Stelle geaendert hat.
from pathlib import Path

path = Path(__file__).resolve().parent.parent / "index.html"
raw = path.read_bytes()
count = 0

def crlf(text):
    return text.encode("utf-8").replace(b"\n", b"\r\n")

def change(old, new, expected=1):
    global raw, count
    before, after = crlf(old), crlf(new)
    matches = raw.count(before)
    if matches != expected:
        raise RuntimeError(f"Erwartete Fundstellen: {expected}, gefunden: {matches}. Patch wurde NICHT geschrieben.")
    raw = raw.replace(before, after)
    count += matches

def section(start, end, replacement):
    global raw, count
    a, b = raw.find(start.encode("utf-8")), -1
    if a < 0 or raw.find(start.encode("utf-8"), a + 1) >= 0:
        raise RuntimeError("Startanker fehlt oder mehrfach vorhanden. Keine Aenderung geschrieben.")
    b = raw.find(end.encode("utf-8"), a + len(start))
    if b < 0:
        raise RuntimeError("Endanker fehlt. Keine Aenderung geschrieben.")
    raw = raw[:a] + crlf(replacement) + raw[b:]
    count += 1

change("window.APP_VERSION = '55.223';", "window.APP_VERSION = '55.224';")

# Optionaler zweiter Tesseract-Worker darf den ersten nicht beim Initialisieren blockieren.
change(
    "      try { if (!__psO2Worker2 && (navigator.hardwareConcurrency || 2) >= 2) __psO2Worker2 = await window.Tesseract.createWorker('deu', 1); } catch (e) { __psO2Worker2 = null; }",
    """      try {
        if (!__psO2Worker2 && (navigator.hardwareConcurrency || 2) >= 4) {
          window.Tesseract.createWorker('deu', 1).then(w => {
            if (!__psO2Worker2) __psO2Worker2 = w;
            else { try { Promise.resolve(w.terminate()).catch(() => {}); } catch (_) {} }
          }).catch(() => {});
        }
      } catch (e) { /* Der erste Worker reicht aus. */ }"""
)
change(
    """  if (!__psO2Worker) {
    await psO2Warm();
    if (!__psO2Worker) {
      await psPortLoadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      __psO2Worker = await window.Tesseract.createWorker('deu', 1);
    }
  }
  onMsg && onMsg(attempt ? nth : 'Vorschlag wird gelesen …');
  const w = worker || __psO2Worker;""",
    """  if (!worker && !__psO2Worker) {
    await psO2Warm();
    if (!__psO2Worker) {
      await psPortLoadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
      __psO2Worker = await window.Tesseract.createWorker('deu', 1);
    }
  }
  onMsg && onMsg(attempt ? nth : 'Vorschlag wird gelesen …');
  const w = worker || __psO2Worker;
  if (!w) throw new Error('worker-unavailable');"""
)

# Die bisherige Fehlerbehandlung wartete im Catch erneut mit await createWorker() - ohne Timeout.
section(
    "  // v55.223: Ein Durchgang kann auf einem schwachen/ueberlasteten Geraet haengen bleiben",
    "    const cls = psO2Parse(o.text)",
    """  // Feste Obergrenze pro OCR-Durchgang und fuer den ganzen lokalen Erkennungslauf.
  // Nach einem Timeout keinen neuen Worker synchron oder mit await starten!
  const PS_O2_PASS_TIMEOUT_MS = 18000, PS_O2_READ_BUDGET_MS = 45000, started = Date.now();
  const empty = () => ({ r: { tarife: [], geraete: [], internet: [], einmalig: '', monatlich: '' }, t: '' });
  const pass = async (mode, w) => {
    if (Date.now() - started >= PS_O2_READ_BUDGET_MS) return empty();
    let o, timeoutId;
    try {
      const ms = Math.max(1000, Math.min(PS_O2_PASS_TIMEOUT_MS, PS_O2_READ_BUDGET_MS - (Date.now() - started)));
      o = await Promise.race([
        psO2RecognizeFull(file, onMsg, mode, res.length, w),
        new Promise((_, rej) => { timeoutId = setTimeout(() => rej(new Error('timeout')), ms); })
      ]);
    } catch (e) {
      console.warn('[O2 Lesen] Durchgang abgebrochen:', e && e.message || e);
      const broken = w || __psO2Worker;
      if (broken && broken.terminate) {
        try { Promise.resolve(broken.terminate()).catch(() => {}); } catch (_) {}
      }
      if (broken === __psO2Worker) __psO2Worker = null;
      if (broken === __psO2Worker2) __psO2Worker2 = null;
      __psO2WarmP = null;
      return empty();
    } finally { if (timeoutId) clearTimeout(timeoutId); }
"""
)
change(
    """  for (let k = 0; k < modes.length; ) {
    if (__psO2Worker2 && k + 1 < modes.length) {""",
    """  for (let k = 0; k < modes.length; ) {
    if (Date.now() - started >= PS_O2_READ_BUDGET_MS || (k > 0 && !__psO2Worker && !__psO2Worker2)) break;
    if (__psO2Worker2 && k + 1 < modes.length) {"""
)

# Wenn die KI nur eine der beiden Summen liefert, nochmal lokal gegenlesen.
change(
    "              cloudThin = catN < 2 && !(cd.einmalig || cd.monatlich);",
    "              cloudThin = (catN < 2 && !(cd.einmalig || cd.monatlich)) || (!!cd.einmalig !== !!cd.monatlich);"
)
change(
    "stage === 'kosten' ? !(q.einmalig || q.monatlich) : false;",
    "stage === 'kosten' ? !(q.einmalig && q.monatlich) : false;"
)

# Eine bestaetigte Einmalsumme allein ist keine abgeschlossene Kostenpruefung.
change(
    "const ok = c => c && [c.e, c.m].every(x => !x || x.ok), c0 = psO2Check(d);",
    "const ok = c => !!(c && c.e && c.m && c.e.ok && c.m.ok), c0 = psO2Check(d);",
    expected=2
)
change(
    "const c = psO2Check(x), sure = !!c && [c.e, c.m].every(r => !r || r.ok);",
    "const c = psO2Check(x), sure = !!(c && c.e && c.m && c.e.ok && c.m.ok);"
)
change(
    "const msg = !hasK ? 'Kostenblock fehlt noch – Liste am PC weiterscrollen und weiteres Foto machen.' : okS ?",
    "const msg = !hasK ? (d.einmalig ? 'Monatliche Kosten fehlen – bitte den Kostenblock erneut fotografieren oder den Betrag eintragen.' : d.monatlich ? 'Einmalige Kosten fehlen – bitte den Kostenblock erneut fotografieren oder den Betrag eintragen.' : 'Kostenblock fehlt noch – Liste am PC weiterscrollen und weiteres Foto machen.') : okS ?"
)
change(
    "inp(d.monatlich, v => setD(p => ({ ...p, monatlich: money(v) })), '0,00', true)",
    "inp(d.monatlich, v => setD(p => ({ ...p, monatlich: money(v) })), 'fehlt', true)"
)
change(
    """          const c = psO2Check(d);
          if (!c) return null;
          const bad = [['einmalig', 'Einmalig', c.e], ['monatlich', 'Monatlich', c.m]].filter(x => x[2] && !x[2].ok);
          if (!bad.length) return h('div', { className: 'mt-2 text-xs font-bold text-green-700' }, '✓ Summen stimmen mit den Einzelpreisen überein');""",
    """          const c = psO2Check(d);
          if (!d.einmalig || !d.monatlich) return h('div', { className: 'mt-2 text-xs font-bold text-amber-800' }, '⚠ Kostenblock unvollständig: einmalige UND monatliche Gesamtsumme prüfen.');
          if (!c) return null;
          const bad = [['einmalig', 'Einmalig', c.e], ['monatlich', 'Monatlich', c.m]].filter(x => x[2] && !x[2].ok);
          if (!bad.length) return h('div', { className: 'mt-2 text-xs font-bold text-green-700' }, '✓ Beide Summen stimmen mit den Einzelpreisen überein');"""
)

if b"PS_O2_PASS_TIMEOUT_MS = 25000" in raw or b"PS_O2_READ_BUDGET_MS = 45000" not in raw:
    raise RuntimeError("Validierung fehlgeschlagen. Datei bleibt unveraendert.")
path.write_bytes(raw)
print(f"Hotfix angewendet: {count} gezielte Aenderungen; index.html aktualisiert.")
