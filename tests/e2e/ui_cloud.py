#!/usr/bin/env python3
"""Browser-Test des Einlese-Dialogs (PsO2Import aus index.html) mit ATTRAPPE fuer den Cloud-Dienst - ohne echtes Foto, ohne Kundendaten.
Prueft: Angebot A/B, Summen, identische Tarife, Teilerfolg, zwei Fotos desselben Angebots, anderes Angebot (Rueckfrage), Timeout,
Abbruch (Anfrage wird abgebrochen), verspaetete Antwort, zwei schnelle Fotos hintereinander, Summenschutz.
Voraussetzungen wie ui_scenarios.py (npm i --no-save tesseract.js@5.1.1 @tesseract.js-data/deu react@18.3.1 react-dom@18.3.1; pip install playwright pillow numpy).
Aufruf: python3 tests/e2e/ui_cloud.py     (optional CHROME=/pfad/zu/chrome, PORT=8792)"""
import os, sys, json, time, subprocess, signal, tempfile
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CHROME = os.environ.get('CHROME') or None
PORT = os.environ.get('PORT', '8792')
TMP = tempfile.mkdtemp(prefix='o2cloud_')
# scharfes, helles Dummy-Foto (besteht die Schaerfe-Pruefung; enthaelt keinerlei Text)
rng = np.random.default_rng(3); blocks = (rng.random((150, 100)) > 0.5).astype(np.uint8) * 200 + 30
Image.fromarray(np.kron(blocks, np.ones((6, 6), dtype=np.uint8))).convert('RGB').save(os.path.join(TMP, 'dummy.jpg'), quality=92)
PHOTO = os.path.join(TMP, 'dummy.jpg')
Image.fromarray(np.kron(((rng.random((150, 100)) > 0.5).astype(np.uint8) * 200 + 30), np.ones((6, 6), dtype=np.uint8))).convert('RGB').save(os.path.join(TMP, 'dummy2.jpg'), quality=92)
PHOTO2 = os.path.join(TMP, 'dummy2.jpg')

def it(name, e, m, **x):
    d = dict(name=name, details=[], einmalig=e, monatlich=m, rabattEinmalig='', rabattMonatlich=''); d.update(x)
    return d
def offer(**k):
    d = dict(tarife=[], geraete=[], internet=[], einmalig='', monatlich='', hinweis='', erstelltAm='', beratungsId='', readable=True); d.update(k)
    return dict(ok=True, data=d)
DET = ['International Voice Standard', 'Inklusiv Datenvolumen 150 GB']
def A(): return offer(tarife=[it('O2 Mobile L (2026)', '39,99', '34,99', details=DET), it('O2 Mobile L (2026)', '39,99', '34,99', details=DET)], geraete=[it('Apple iPhone 18 Pro 1TB, Burgunder', '2.389,00', '', tarif=1)])
def mk(o, **extra): o['data'].update(extra); return o
A_ = lambda: mk(A(), einmalig='2.468,98', monatlich='69,98', erstelltAm='23.11.2026 17:15', beratungsId='4711')
def B_(): return mk(offer(tarife=[it('O2 Mobile M Plus (2026)', '39,99', '29,99', rabattMonatlich='15,00', details=['Inklusiv Datenvolumen 60 GB'])], geraete=[it('Apple iPhone 18 Pro 1TB, Burgunder', '2.389,00', '', tarif=1)], internet=[it('O2 Home XL 600', '9,99', '54,99', details=['Download bis zu 600 MBit/s'])]),
                    einmalig='2.438,98', monatlich='69,98', erstelltAm='23.11.2026 18:02', beratungsId='4712')

INIT = """
localStorage.setItem('ps_htr_url', 'http://test.invalid/handwritingToText'); localStorage.setItem('ps_o2_mode', 'ganz');
window.__betaAuth = { currentUser: { getIdToken: async () => 'tok' } };
window.__cloud = { queue: [], calls: 0, aborted: 0, delivered: 0 };
const of = window.fetch.bind(window);
window.fetch = (url, init) => {
  if (!String(url).includes('handwritingToText')) return of(url, init);
  const c = window.__cloud; c.calls++;
  const spec = c.queue.length ? c.queue.shift() : { status: 502, body: { ok: false } };
  return new Promise((resolve, reject) => {
    const sig = init && init.signal;
    if (sig) sig.addEventListener('abort', () => { c.aborted++; reject(new DOMException('Aborted', 'AbortError')); });
    if (spec.never) return;
    setTimeout(() => { if (sig && sig.aborted) return; c.delivered++; resolve(new Response(JSON.stringify(spec.body), { status: spec.status || 200, headers: { 'Content-Type': 'application/json' } })); }, spec.delay || 0);
  });
};
"""
srv = subprocess.Popen([sys.executable, '-m', 'http.server', PORT, '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
RES = []
def check(name, cond, info=''):
    RES.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + (' – ' + str(info) if info else '')); sys.stdout.flush()
def new_page(b, queue, cloud_ms=None):
    pg = b.new_page(viewport={'width': 900, 'height': 1500}); pg.add_init_script(INIT)
    pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)[:200]))
    pg.goto(f'http://127.0.0.1:{PORT}/tests/e2e/harness_ui.html'); pg.wait_for_function('window.__ready === true', timeout=15000)
    pg.evaluate('q => { window.__cloud.queue = q; }', queue)
    if cloud_ms: pg.evaluate(f'PS_O2_T.cloud = {cloud_ms}')
    pg.evaluate('mountUi()'); pg.wait_for_timeout(400); return pg
def shoot(pg, wait=True):
    # wie ein Mitarbeiter: ueber die Taste (Auswahldialog), nicht direkt ins versteckte Feld
    btn = '📷 Weiteres Foto' if pg.get_by_text('📷 Weiteres Foto', exact=False).count() else '📷 Vorschlag fotografieren'
    with pg.expect_file_chooser() as fc: pg.get_by_text(btn, exact=False).first.click()
    fc.value.set_files(PHOTO)
    if wait: settle(pg)
def shoot_raw(pg, path):
    # Foto-Ereignis direkt ins Feld (umgeht die gesperrte Taste): simuliert zwei schnelle Ereignisse hintereinander
    pg.set_input_files('input[aria-label="Foto aufnehmen"]', path)
def settle(pg):
    pg.wait_for_timeout(900); pg.wait_for_function('!document.querySelector("[role=status]")', timeout=60000, polling=150); pg.wait_for_timeout(250)
def state(pg):
    pg.evaluate('window.__applied = null'); b = pg.query_selector('text=Ins Angebot übernehmen')
    if b and b.is_enabled(): b.click(); pg.wait_for_timeout(120)
    return pg.evaluate('window.__applied')
def text(pg): return pg.inner_text('#root')
def cnt(d): return (len(d['tarife']), len(d['geraete']), len(d['internet']), d['einmalig'], d['monatlich']) if d else None
R = lambda o, **k: dict(body=o, **k)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox'])
    # 6 identische Tarife + 9 Rabatte/Gesamtkosten (Angebot A, Angebot B)
    pg = new_page(b, [R(A_())]); t0 = time.time(); shoot(pg); d = state(pg); t = text(pg)
    check('Angebot A: Handy + 2 gleiche Tarife (getrennt) + 2.468,98 / 69,98', cnt(d) == (2, 1, 0, '2.468,98', '69,98') and d['tarife'][0]['name'] == d['tarife'][1]['name'], cnt(d))
    check('Angebot A: Meldung "Summen stimmen", Dauer < 5 s, keine Skriptfehler', 'Summen stimmen' in t and time.time() - t0 < 5 and not pg.errs, f'{time.time()-t0:.1f}s {pg.errs}'); pg.close()
    pg = new_page(b, [R(B_())]); shoot(pg); d = state(pg); t = text(pg)
    check('Angebot B: Internet + Handy + Tarif + 2.438,98 / 69,98', cnt(d) == (1, 1, 1, '2.438,98', '69,98'), cnt(d))
    check('Angebot B: Rabatte nachvollzogen, Summen stimmen (keine Abweichungsmeldung)', 'Summen stimmen' in t and 'weichen ab' not in t and 'Kontrolle' not in t, t[-300:].replace('\n', ' ')); pg.close()
    # 5 Teilerfolg + Ergebnis bleibt nach fehlgeschlagenem Versuch
    part = A_(); part['data'].update(einmalig='', monatlich='', geraete=[])
    pg = new_page(b, [R(part), R({'ok': False}, status=502)]); shoot(pg); t1 = text(pg); d1 = state(pg)
    check('Teilerfolg: 2 Tarife erkannt, Gesamtkosten fehlen -> genaue Meldung, nicht "Nichts erkannt"', cnt(d1)[0] == 2 and 'Gesamtkosten konnten nicht sicher zugeordnet werden' in t1 and 'Nichts erkannt' not in t1, t1[-260:].replace('\n', ' '))
    shoot(pg); d2 = state(pg)  # Dienst 502 -> Geraet liest das Dummy-Foto (kein Text) -> nichts Neues
    check('Fehlgeschlagener 2. Versuch loescht nichts', cnt(d2) == cnt(d1), cnt(d2)); pg.close()
    # 7 zwei Fotos desselben Angebots
    pg = new_page(b, [R(B_()), R(B_())]); shoot(pg); shoot(pg); d = state(pg)
    check('Zwei Fotos desselben Angebots: keine doppelten Positionen', cnt(d) == (1, 1, 1, '2.438,98', '69,98'), cnt(d)); pg.close()
    # 8 anderes Angebot -> Rueckfrage, nichts vermischt
    pg = new_page(b, [R(A_()), R(B_())]); shoot(pg); shoot(pg); t = text(pg); d = state(pg)
    check('Anderes Angebot: Rueckfrage statt Vermischung, bisherige Angaben unveraendert', 'Anderes Angebot erkannt' in t and cnt(d) == (2, 1, 0, '2.468,98', '69,98'), cnt(d))
    pg.get_by_role('button', name='Neues Angebot – bisherige Angaben ersetzen').click(); settle(pg); d = state(pg)
    check('Anderes Angebot -> "ersetzen": nur Angebot B im Dialog', cnt(d) == (1, 1, 1, '2.438,98', '69,98'), cnt(d)); pg.close()
    pg = new_page(b, [R(A_()), R(B_())]); shoot(pg); shoot(pg); pg.get_by_role('button', name='Trotzdem zusammenführen').click(); settle(pg); d = state(pg)
    check('Anderes Angebot -> "zusammenfuehren": bewusst gemischt, nichts verloren', d and len(d['tarife']) >= 3 and len(d['internet']) == 1, cnt(d)); pg.close()
    pg = new_page(b, [R(A_()), R(B_())]); shoot(pg); shoot(pg); pg.get_by_role('button', name='Foto verwerfen').click(); pg.wait_for_timeout(200); d = state(pg)
    check('Anderes Angebot -> "verwerfen": Angebot A bleibt', cnt(d) == (2, 1, 0, '2.468,98', '69,98'), cnt(d)); pg.close()
    # Summenschutz: neues Foto desselben Angebots mit abweichender Summe
    bad = A_(); bad['data']['monatlich'] = '79,98'
    pg = new_page(b, [R(A_()), R(bad)]); shoot(pg); shoot(pg); d = state(pg); t = text(pg)
    check('Abweichende Gesamtkosten werden nicht still uebernommen', d['monatlich'] == '69,98' and 'Gesamtkosten weichen ab' in t, d['monatlich']); pg.close()
    # 1 Timeout: Dienst antwortet nie -> Anfrage abgebrochen, Dialog nicht blockiert
    pg = new_page(b, [dict(never=True)], cloud_ms=1500); t0 = time.time(); shoot(pg); dt = time.time() - t0; t = text(pg)
    ab = pg.evaluate('window.__cloud.aborted')
    check('Dienst-Timeout: Anfrage abgebrochen, Dialog frei, klare Meldung, < 12 s', ab == 1 and dt < 12 and 'Nichts erkannt' not in t and 'Ins Angebot übernehmen' in t, f'{dt:.1f}s abgebrochen={ab}'); pg.close()
    # 2 + 4 Abbruch durch Benutzer, verspaetete Antwort
    pg = new_page(b, [R(A_(), delay=3000)]); shoot(pg, wait=False); pg.wait_for_selector('[role=status] button', timeout=8000); pg.wait_for_timeout(500)
    t0 = time.time(); pg.click('[role=status] button'); pg.wait_for_selector('[role=status]', state='detached', timeout=3000)
    check('Abbrechen: sofort frei (< 1 s), Anfrage abgebrochen', time.time() - t0 < 1 and pg.evaluate('window.__cloud.aborted') == 1, f'{time.time()-t0:.2f}s')
    pg.wait_for_timeout(3500); d = state(pg)
    check('Verspaetete Antwort nach Abbruch aendert nichts', d is None or cnt(d) == (0, 0, 0, '', ''), cnt(d)); pg.close()
    # 3 zwei schnelle Fotos hintereinander
    pg = new_page(b, [R(A_(), delay=1500), R(B_(), delay=300)]); shoot(pg, wait=False); pg.wait_for_timeout(250); shoot_raw(pg, PHOTO2); settle(pg); pg.wait_for_timeout(2500); d = state(pg)
    check('Zwei schnelle Fotos: nur der letzte Lauf zaehlt, nichts doppelt, kein Haenger', cnt(d) == (1, 1, 1, '2.438,98', '69,98') and 'role="status"' not in pg.content(), cnt(d)); pg.close()
    b.close()
srv.send_signal(signal.SIGTERM)
print(f'\n{sum(RES)} von {len(RES)} Pruefungen bestanden'); sys.exit(0 if all(RES) else 1)
