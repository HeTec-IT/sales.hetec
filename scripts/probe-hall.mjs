// TEMPORAER: prueft die ECHTE Veroeffentlichung (o2 Hall-Test + Telekom) mit echtem Browser. Danach loeschen.
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const BASE = 'https://hetec-it.github.io/PS-Dashboard/';
const TK = 'https://hetec-it.github.io/PS-Dashboard-Telekom/';
const O2 = {
  'index.html': 'f2588fd2e4597f1e6d011a552809f7784f634a7181b551ee133f5a653742840c',
  'index-neu.html': '7644f17c8a3fb01c0d15227864b477a2acc7963865db261fb16f7ef671cf5b29',
  'rollout.json': 'f8c66e364c433e9f741869ccf9dd990c543402bf3cec04fd33249702fc19e3c7',
  'sw.js': '641349f858e9a4ec6a2f8c4b79332b87617588457483d1a5968bef66338374f0',
  'manifest.webmanifest': '958535a745ce6db3317173c0c55fac4a4837407cecabdacf7f6412f70bde04d7'
};
const TKS = {
  'index.html': '3fcaf1e2f7fc66021257a66efb9280f3f2b4211f59b99f345209e261b27493c1',
  'sw.js': 'a0c17f889de9d952c738dc5fd93c40cbe52f8b8c097048f8a0592c9afa14ad24',
  'manifest.webmanifest': '4071d07ed7c56414f2edc85416e60875bb4cefcdc45a963839fe2425facade23',
  'icon-192.png': '80d661ad4b83c819e43443fceb937307a9853e5a5b6338a31da7a67f9295a266',
  'icon-512.png': 'b73772313d16d6008b820e3c4af39c97d49c5d39ebbca921601d33ad7296ba1d'
};
const R = (...a) => console.log('RESULT', ...a);
const sha = b => createHash('sha256').update(b).digest('hex');
async function dateien(label, base, soll) {
  for (const [f, s] of Object.entries(soll)) {
    const r = await fetch(base + f + '?t=' + Date.now(), { cache: 'no-store' });
    const b = Buffer.from(await r.arrayBuffer());
    R('DATEI', label, f, 'HTTP', r.status, 'Bytes', b.length, sha(b) === s ? 'IDENTISCH' : 'ABWEICHUNG ' + sha(b).slice(0, 12));
  }
}
await dateien('o2', BASE, O2);
await dateien('telekom', TK, TKS);
// Inhalt: alt-Fix im ausgelieferten o2-index
{ const t = await (await fetch(BASE + 'index.html?t=' + Date.now(), { cache: 'no-store' })).text(); R('INHALT o2 index.html alt-Fix', t.includes("u.searchParams.delete('alt')") ? 'DA' : 'FEHLT', 'Weiche', t.includes('Rollout-Weiche') ? 'DA' : 'FEHLT'); }
{ const t = await (await fetch(TK + 'index.html?t=' + Date.now(), { cache: 'no-store' })).text(); R('INHALT telekom index.html Weiche', t.includes('Rollout-Weiche') ? 'DA (FALSCH)' : 'nicht vorhanden (richtig)'); }
// Daten-JSONs
const pruefen = {
  'tv-preise.json': j => j.o2 && j.o2.preise && ['classic', 'smart', 'prem', 'prempro'].every(k => typeof j.o2.preise[k] === 'number'),
  'kabel-preise.json': j => typeof j.preis === 'number',
  'netflix-preise.json': j => Array.isArray(j.tarife) && j.tarife.length === 3,
  'disney-preise.json': j => Array.isArray(j.tarife) && j.tarife.length === 3,
  'telekom-tv-preise.json': j => j.preise && ['smart', 'stream', 'mega'].every(k => typeof j.preise[k] === 'number'),
  'vodafone-tv-preise.json': j => j.preise && typeof j.preise.s === 'number' && typeof j.preise.m === 'number' && typeof j.preise.premium === 'number' && j.preise.netflixPreise && typeof j.preise.netflixPreise.standard === 'number',
  'pixel-geraete.json': j => JSON.stringify(j).length > 500
};
for (const [label, base] of [['o2', BASE], ['telekom', TK]]) for (const [f, ok] of Object.entries(pruefen)) {
  try { const r = await fetch(base + f + '?t=' + Date.now(), { cache: 'no-store' }); const j = await r.json(); R('JSON', label, f, 'HTTP', r.status, ok(j) ? 'OK' : 'FORM FALSCH'); } catch (e) { R('JSON', label, f, 'FEHLER', e.message); }
}
const br = await chromium.launch();
async function szenario(name, { base = BASE, ls = {}, url = base, seiten = 1, warte = 12000, offlineDanach = false }) {
  const ctx = await br.newContext({ viewport: { width: 1180, height: 820 }, locale: 'de-DE' });
  await ctx.addInitScript(([ls]) => { try { if (!localStorage.getItem('__i')) { localStorage.setItem('__i', '1'); for (const k in ls) localStorage.setItem(k, ls[k]); } } catch (e) {} }, [ls]);
  for (let n = 1; n <= seiten; n++) {
    const p = await ctx.newPage(); const fe = [], bad = [];
    p.on('pageerror', e => fe.push('pageerror: ' + e.message.slice(0, 120)));
    p.on('console', m => { if (m.type() === 'error') fe.push('console: ' + m.text().slice(0, 120)); });
    p.on('response', r => { const u = r.url(); if (r.status() >= 400 && /hetec-it\.github\.io/.test(u)) bad.push(r.status() + ' ' + u.replace(/https:\/\/hetec-it\.github\.io\//, '')); });
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(e => fe.push('goto: ' + e.message.slice(0, 80)));
    await p.waitForTimeout(warte);
    const info = await p.evaluate(async () => ({ v: window.APP_VERSION, titel: document.title, text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 130), shop: localStorage.getItem('ps_shop'), roll: localStorage.getItem('ps_rollout'), sw: (await navigator.serviceWorker.getRegistrations().catch(() => [])).map(r => (r.active && r.active.scriptURL || '').replace(/^.*\//, '')).join(',') })).catch(e => ({ fehler: e.message.slice(0, 80) }));
    R('SZENARIO', name, '#' + n, 'URL=' + p.url().replace(/https:\/\/hetec-it\.github\.io\//, ''), JSON.stringify(info), 'Fehler=' + JSON.stringify(fe.slice(0, 4)), 'HTTP>=400=' + JSON.stringify(bad.slice(0, 4)));
    if (n === seiten && offlineDanach) {
      await ctx.setOffline(true);
      const q = await ctx.newPage(); const fe2 = [];
      q.on('pageerror', e => fe2.push(e.message.slice(0, 100)));
      await q.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => fe2.push('goto: ' + e.message.slice(0, 80)));
      await q.waitForTimeout(8000);
      const i2 = await q.evaluate(() => ({ v: window.APP_VERSION, text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 110) })).catch(e => ({ fehler: e.message.slice(0, 80) }));
      R('SZENARIO', name, 'OFFLINE', 'URL=' + q.url().replace(/https:\/\/hetec-it\.github\.io\//, ''), JSON.stringify(i2), 'Fehler=' + JSON.stringify(fe2.slice(0, 3)));
    }
  }
  await ctx.close();
}
await szenario('Hall frisch Start 1+2 (+offline)', { ls: { ps_shop: 'schwaebisch-hall' }, seiten: 2, offlineDanach: true });
await szenario('Hall per Link ?shop=schwaebisch-hall (Shop vorher Aalen, nach Shop-Wechsel)', { ls: { ps_shop: 'aalen' }, url: BASE + '?shop=schwaebisch-hall' });
await szenario('Hall Kurzlink ?shop=hall', { ls: {}, url: BASE + '?shop=hall' });
await szenario('Aalen (bleibt alt)', { ls: { ps_shop: 'aalen' } });
await szenario('Backnang (bleibt alt)', { ls: { ps_shop: 'backnang' } });
await szenario('kein Shop gespeichert (bleibt alt)', { ls: {} });
await szenario('Hall mit ?alt=1 (alt erzwungen)', { ls: { ps_shop: 'schwaebisch-hall' }, url: BASE + '?alt=1' });
await szenario('index-neu.html direkt (kein Shop)', { url: BASE + 'index-neu.html' });
await szenario('Telekom (Fachhandel) unveraendert', { base: TK, ls: {}, url: TK, seiten: 1 });
await szenario('Telekom Crailsheim-Shop', { base: TK, ls: { ps_shop: 'schwaebisch-hall' }, url: TK, seiten: 1 });
await br.close();
R('FERTIG');
