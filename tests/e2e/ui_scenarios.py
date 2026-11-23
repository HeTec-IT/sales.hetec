#!/usr/bin/env python3
"""Browser-Test des echten o2-Einlese-Dialogs (PsO2Import aus index.html) mit der echten Texterkennung.
Voraussetzungen (nichts davon kommt ins Repo):  npm i --no-save tesseract.js@5.1.1 @tesseract.js-data/deu react@18.3.1 react-dom@18.3.1
                                               pip install playwright pillow numpy   (+ Chrome)
Aufruf:  BELEG_FOTO=/pfad/zum/testfoto.jpg python3 tests/e2e/ui_scenarios.py
Optional: CHROME=/usr/bin/google-chrome, PORT=8791"""
import os, sys, re, time, subprocess, tempfile, signal, json
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FOTO = os.environ.get('BELEG_FOTO')
if not FOTO or not os.path.exists(FOTO): sys.exit('BELEG_FOTO=<Foto des o2-Vorschlags mit Handy + 2 gleichen Tarifen, 2.468,98 / 69,98> setzen')
CHROME = os.environ.get('CHROME') or None
PORT = os.environ.get('PORT', '8791')
VAR = tempfile.mkdtemp(prefix='o2var_')
subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), 'make_variants.py'), FOTO, VAR], check=True, stdout=subprocess.DEVNULL)
srv = subprocess.Popen([sys.executable, '-m', 'http.server', PORT, '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
RES = []
def check(name, cond, info=''):
    RES.append((name, bool(cond), info)); print(('PASS ' if cond else 'FAIL ') + name + (' – ' + info if info else '')); sys.stdout.flush()

def new_page(b):
    pg = b.new_page(viewport={'width': 900, 'height': 1500}); pg.goto(f'http://127.0.0.1:{PORT}/tests/e2e/harness_ui.html')
    pg.errs = []; pg.on('pageerror', lambda e: pg.errs.append(str(e)[:200]))
    pg.wait_for_function('window.__ready === true', timeout=15000)
    pg.evaluate('localStorage.setItem("ps_o2_mode","ganz")'); pg.evaluate('mountUi()'); pg.wait_for_timeout(500)
    return pg
def upload(pg, name, button='📷 Vorschlag fotografieren', wait=True):
    path = os.path.join(VAR, name + '.jpg')
    with pg.expect_file_chooser() as fc: pg.get_by_text(button, exact=False).first.click()
    t0 = time.time(); fc.value.set_files(path)
    if wait:
        pg.wait_for_timeout(1200); pg.wait_for_function('!document.querySelector("[role=status]")', timeout=70000, polling=200)
        pg.wait_for_timeout(300)
    return time.time() - t0
def state(pg):
    pg.evaluate('window.__applied = null')
    btn = pg.query_selector('text=Ins Angebot übernehmen')
    if btn and btn.is_enabled(): btn.click(); pg.wait_for_timeout(150)
    return pg.evaluate('window.__applied')
def page_text(pg): return pg.inner_text('#root')
def full(d): return d and len(d['tarife']) == 2 and len(d['geraete']) == 1 and d['einmalig'] == '2.468,98' and d['monatlich'] == '69,98'
def brief(d): return 'leer' if not d else '%dT %dG E=%s M=%s' % (len(d['tarife']), len(d['geraete']), d['einmalig'], d['monatlich'])

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox'])
    # 1-7: lesbares Foto + Verschlechterungen -> vollstaendig und innerhalb der Zeit
    for name, what in [('orig', 'lesbares Foto'), ('blur_light', 'leichte Unschaerfe (Scharfstell-Pruefung, dann "Trotzdem lesen")'), ('jpeg30', 'starke JPEG-Kompression (Moire-aehnlich)'), ('gradient', 'Helligkeitsunterschiede'), ('rot4', 'schief fotografiert'), ('glare', 'Spiegelung')]:
        pg = new_page(b); sec = upload(pg, name)
        if pg.query_selector('text=Trotzdem lesen'):  # Scharfstell-Pruefung hat angeschlagen: wie am Tablet bewusst weiterlesen
            check(f'{what} ({name}): Hinweis "Foto ist unscharf" erscheint', 'Foto ist unscharf. Bitte Kamera ruhig halten und erneut fotografieren.' in page_text(pg), '')
            t1 = time.time(); pg.get_by_role('button', name='Trotzdem lesen').click(); pg.wait_for_timeout(1200); pg.wait_for_function('!document.querySelector("[role=status]")', timeout=70000, polling=200); sec += time.time() - t1 + 1
        d = state(pg)
        check(f'{what} ({name}): Handy + 2 Tarife + 2.468,98 / 69,98', full(d), brief(d) + f', {sec:.1f} s')
        check(f'{what} ({name}): zwei gleiche Tarifnamen nicht zusammengelegt', d and len(d['tarife']) == 2 and d['tarife'][0]['name'] == d['tarife'][1]['name'], '')
        check(f'{what} ({name}): Dauer <= 20 s', sec <= 20, f'{sec:.1f} s'); check(f'{what} ({name}): keine Skriptfehler', not pg.errs, str(pg.errs)); pg.close()
    # 8: Kostenblock erst auf dem zweiten Foto
    pg = new_page(b); upload(pg, 'top_only'); d1 = state(pg); txt1 = page_text(pg); upload(pg, 'bottom_only', '📷 Weiteres Foto'); d2 = state(pg)
    check('Teilerfolg nach Foto 1: Tarife/Handy da, Gesamtkosten fehlen -> klare Meldung', d1 and len(d1['tarife']) >= 1 and not d1['einmalig'] and 'Gesamtkosten fehlen noch' in txt1, brief(d1))
    check('Kostenblock auf 2. Foto: Summen ergaenzt, nichts doppelt, nichts verloren', d2 and d2['einmalig'] == '2.468,98' and d2['monatlich'] == '69,98' and len(d2['tarife']) == 2 and len(d2['geraete']) == 1, brief(d2)); pg.close()
    # 9: Ergebnis bleibt nach fehlgeschlagenem Versuch
    pg = new_page(b); upload(pg, 'orig'); upload(pg, 'garbage', '📷 Weiteres Foto'); d = state(pg); t = page_text(pg)
    check('Ergebnis bleibt nach kaputter 2. Datei erhalten + klare Meldung', full(d) and 'konnte nicht geöffnet werden' in t, brief(d)); pg.close()
    # 12/13: Benutzer bricht ab, danach neues Foto
    pg = new_page(b); upload(pg, 'orig', wait=False); pg.wait_for_selector('[role=status] button', timeout=8000); pg.wait_for_timeout(800)
    t0 = time.time(); pg.click('[role=status] button'); pg.wait_for_selector('[role=status]', state='detached', timeout=3000); dt = time.time() - t0
    check('Abbrechen wirkt sofort (< 1 s) und zeigt Hinweis', dt < 1 and 'abgebrochen' in page_text(pg), f'{dt:.2f} s')
    sec = upload(pg, 'orig'); d = state(pg); check('neues Foto nach Abbruch wird normal gelesen', full(d), brief(d) + f', {sec:.1f} s'); pg.close()
    # 14/15: fehlerhafte Bilder, kein Text -> keine erfundenen Werte, klare Meldung, begrenzte Zeit
    for name, expect in [('garbage', 'konnte nicht geöffnet werden'), ('truncated', 'konnte nicht geöffnet werden'), ('blank', 'unscharf'), ('noise', 'Kein lesbarer Text'), ('blur_heavy', None)]:
        pg = new_page(b); sec = upload(pg, name); d = state(pg); t = page_text(pg)
        empty = not d or (not d['tarife'] and not d['geraete'] and not d['einmalig'] and not d['monatlich'])
        check(f'unbrauchbares Foto ({name}): nichts erfunden', empty, brief(d))
        check(f'unbrauchbares Foto ({name}): klare Meldung, kein "Nichts erkannt"', 'Nichts erkannt' not in t and (expect is None or expect in t or 'Text gelesen' in t), '')
        check(f'unbrauchbares Foto ({name}): Dauer <= 20 s', sec <= 20, f'{sec:.1f} s'); pg.close()
    b.close()
srv.send_signal(signal.SIGTERM)
bad = [r for r in RES if not r[1]]
print(f'\n{len(RES) - len(bad)} von {len(RES)} Pruefungen bestanden'); sys.exit(1 if bad else 0)
