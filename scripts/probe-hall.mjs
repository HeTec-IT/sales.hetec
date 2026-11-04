// TEMPORAER: Hin-und-her-Wechsel Hall/Aalen auf der ECHTEN Seite. Danach loeschen.
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
const BASE = 'https://hetec-it.github.io/PS-Dashboard/';
const O2 = { 'index.html': 'c080be97d7346357a7ba02bfebb8c42749d36ff5b8c2c89e2524ab55c104a56f', 'index-neu.html': '71d09428f96dcabf67a7c7b1e7d42785ff09c84566b81ef5bd07e9ed361f3a03' };
const R = (...a) => console.log('RESULT', ...a);
const sha = b => createHash('sha256').update(b).digest('hex');
for (const [f, s] of Object.entries(O2)) {
  const st = [];
  for (let t = 1; t <= 4; t++) { const r = await fetch(BASE + f + '?t=' + Date.now() + t, { cache: 'no-store' }); const b = Buffer.from(await r.arrayBuffer()); st.push(r.status + (sha(b) === s ? 'ok' : 'x')); await new Promise(r => setTimeout(r, 1500)); }
  R('DATEI', f, st.join(','));
}
const br = await chromium.launch();
async function rundlauf(name, zyklen, pause, ls) {
  const ctx = await br.newContext({ viewport: { width: 1180, height: 820 }, locale: 'de-DE' });
  await ctx.addInitScript(([ls]) => { try { if (!localStorage.getItem('__i')) { localStorage.setItem('__i', '1'); for (const k in ls) localStorage.setItem(k, ls[k]); } } catch (e) {} }, [ls]);
  const p = await ctx.newPage(); const fe = [];
  p.on('pageerror', e => fe.push(e.message.slice(0, 100)));
  const wo = async () => { const u = new URL(p.url()); const v = await p.evaluate(() => window.APP_VERSION).catch(() => '?'); return (/index-neu/.test(u.pathname) ? 'NEU' : 'ALT') + ' v' + v; };
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}); await p.waitForTimeout(pause);
  const out = ['Start ' + await wo()];
  for (let z = 1; z <= zyklen; z++) {
    await p.evaluate(() => { localStorage.setItem('ps_shop', 'aalen'); const u = new URL(location.href); u.searchParams.set('shop', 'aalen'); u.searchParams.delete('alt'); location.replace(u.toString()); }).catch(() => {});
    await p.waitForTimeout(pause); const a = await wo();
    await p.evaluate(() => { localStorage.setItem('ps_shop', 'schwaebisch-hall'); const u = new URL(location.href); u.searchParams.set('shop', 'schwaebisch-hall'); u.searchParams.delete('alt'); location.replace(u.toString()); }).catch(() => {});
    await p.waitForTimeout(pause); const b = await wo();
    out.push('Z' + z + ' Aalen=' + a + ' | Hall=' + b);
  }
  R('RUNDLAUF', name, out.join(' || '), 'Fehler=' + JSON.stringify(fe.slice(0, 3)));
  await ctx.close();
}
await rundlauf('frisch (ohne Cache), Shop Hall gespeichert, 5 s Pause', 5, 5000, { ps_shop: 'schwaebisch-hall' });
await rundlauf('mit Cache, 4 s Pause', 5, 4000, { ps_shop: 'schwaebisch-hall', ps_rollout: '["schwaebisch-hall"]' });
await rundlauf('Neu-Start ueber Link-Shop (vorher Aalen gespeichert), 5 s', 3, 5000, { ps_shop: 'aalen' });
await br.close();
R('FERTIG');
