// TEMPORAER: prueft die ECHTE Veroeffentlichung von PS-Dashboard (Hall-Test) mit echtem Browser. Danach loeschen.
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const BASE = 'https://hetec-it.github.io/PS-Dashboard/';
const ERWARTET = {
  'index.html': 'fb11063bd973002a2afb0f3ac1cc773f837510055ed04a32a8a1c581c6e08ccf',
  'index-neu.html': '32e2bba4aca23529a6355e11b334cfceebc39f773c82155d26f6eb10f6138f30',
  'rollout.json': 'f8c66e364c433e9f741869ccf9dd990c543402bf3cec04fd33249702fc19e3c7',
  'sw.js': '641349f858e9a4ec6a2f8c4b79332b87617588457483d1a5968bef66338374f0',
  'manifest.webmanifest': '958535a745ce6db3317173c0c55fac4a4837407cecabdacf7f6412f70bde04d7'
};
const R = (...a) => console.log('RESULT', ...a);
const sha = b => createHash('sha256').update(b).digest('hex');
// 1) Dateien im Deploy == Repo-Stand
for (const [f, soll] of Object.entries(ERWARTET)) {
  const r = await fetch(BASE + f + '?t=' + Date.now(), { cache: 'no-store' });
  const b = Buffer.from(await r.arrayBuffer());
  R('DATEI', f, 'HTTP', r.status, 'Bytes', b.length, sha(b) === soll ? 'IDENTISCH' : 'ABWEICHUNG ' + sha(b).slice(0, 12) + ' soll ' + soll.slice(0, 12));
}
// 2) Daten-JSONs im Deploy
const pruefen = {
  'tv-preise.json': j => j.preise && ['classic', 'smart', 'prem', 'prempro'].every(k => typeof j.preise[k] === 'number'),
  'kabel-preise.json': j => typeof j.preis === 'number',
  'netflix-preise.json': j => Array.isArray(j.tarife) && j.tarife.length === 3,
  'disney-preise.json': j => Array.isArray(j.tarife) && j.tarife.length === 3,
  'telekom-tv-preise.json': j => j.preise && ['smart', 'stream', 'mega'].every(k => typeof j.preise[k] === 'number'),
  'vodafone-tv-preise.json': j => j.preise && typeof j.preise.s === 'number' && typeof j.preise.m === 'number',
  'pixel-geraete.json': j => JSON.stringify(j).length > 500
};
for (const [f, ok] of Object.entries(pruefen)) {
  try { const r = await fetch(BASE + f + '?t=' + Date.now(), { cache: 'no-store' }); const j = await r.json(); R('JSON', f, 'HTTP', r.status, ok(j) ? 'OK' : 'FORM FALSCH'); } catch (e) { R('JSON', f, 'FEHLER', e.message); }
}
// 3) Browser-Szenarien gegen die echte Seite
const br = await chromium.launch();
async function szenario(name, { ls = {}, url = BASE, seiten = 1, warte = 12000 }) {
  const ctx = await br.newContext({ viewport: { width: 1180, height: 820 }, locale: 'de-DE' });
  await ctx.addInitScript(([ls]) => { try { if (!localStorage.getItem('__i')) { localStorage.setItem('__i', '1'); for (const k in ls) localStorage.setItem(k, ls[k]); } } catch (e) {} }, [ls]);
  for (let n = 1; n <= seiten; n++) {
    const p = await ctx.newPage(); const fe = [], rq = [], bad = [];
    p.on('pageerror', e => fe.push('pageerror: ' + e.message.slice(0, 120)));
    p.on('console', m => { if (m.type() === 'error') fe.push('console: ' + m.text().slice(0, 120)); });
    p.on('response', r => { const u = r.url(); if (r.status() >= 400 && /hetec-it\.github\.io/.test(u)) bad.push(r.status() + ' ' + u.replace(BASE, '')); });
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => fe.push('goto: ' + e.message.slice(0, 80)));
    await p.waitForTimeout(warte);
    const info = await p.evaluate(() => ({ v: window.APP_VERSION, titel: document.title, text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160), shop: localStorage.getItem('ps_shop'), roll: localStorage.getItem('ps_rollout'), react: typeof React, fb: typeof firebase })).catch(e => ({ fehler: e.message.slice(0, 80) }));
    R('SZENARIO', name, '#' + n, 'URL=' + p.url().replace(BASE, '') , JSON.stringify(info), 'Fehler=' + JSON.stringify(fe.slice(0, 4)), 'HTTP>=400=' + JSON.stringify(bad.slice(0, 4)));
  }
  await ctx.close();
}
await szenario('Hall (frisch, kein Cache) Start 1+2', { ls: { ps_shop: 'schwaebisch-hall' }, seiten: 2 });
await szenario('Aalen (bleibt alt)', { ls: { ps_shop: 'aalen' } });
await szenario('Hall mit ?alt=1 (alt erzwungen)', { ls: { ps_shop: 'schwaebisch-hall' }, url: BASE + '?alt=1' });
await szenario('index-neu.html direkt (kein Shop gespeichert)', { url: BASE + 'index-neu.html' });
await br.close();
R('FERTIG');
