// TEMPORÄR: Diagnose, welche Seiten die Preise von MagentaTV und Giga TV enthalten (wird nach dem Bau der Bots gelöscht)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const URLS = [
  'https://www.telekom.de/magenta-tv/tarife',
  'https://www.telekom.de/magenta-tv',
  'https://www.telekom.de/magenta-tv/tv-tarife',
  'https://www.telekom.de/magenta-tv/magentatv-smart',
  'https://www.telekom.de/magenta-tv/magentatv-smartstream',
  'https://www.telekom.de/magenta-tv/magentatv-megastream',
  'https://www.telekom.de/magenta-tv/streaming-tv',
  'https://www.vodafone.de/privat/fernsehen.html',
  'https://www.vodafone.de/privat/fernsehen/gigatv.html',
  'https://www.vodafone.de/privat/fernsehen/gigatv-home.html',
  'https://www.vodafone.de/privat/fernsehen/gigatv-premium.html'
];
const KEYS = /MagentaTV (?:Smart|SmartStream|MegaStream)|SmartStream|MegaStream|Giga ?TV (?:Home|Premium)|Vodafone Premium|ersten 6 Monate|danach/gi;
const text = (h, s) => {
  let t = String(h || '');
  if (!s) t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  return t.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&euro;|\\u20ac/gi, '€').replace(/&nbsp;|&#160;|\\u00a0| /g, ' ').replace(/\s+/g, ' ');
};
const zeig = (titel, t, max = 8) => {
  let m, n = 0;
  const r = new RegExp(KEYS.source, 'gi');
  const letzte = -999;
  let last = -999;
  console.log('   [' + titel + '] Länge ' + t.length);
  while ((m = r.exec(t)) && n < max) {
    if (m.index - last < 400) continue;
    last = m.index; n++;
    console.log('     …' + t.slice(Math.max(0, m.index - 80), m.index + 380) + '…');
  }
};
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch (_) {}
for (const u of URLS) {
  console.log('\n=== ' + u);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' }, redirect: 'follow' });
    const h = await r.text();
    console.log('   HTTP ' + r.status + ' -> ' + r.url + ', ' + h.length + ' Zeichen');
    if (r.ok) { zeig('einfach, ohne Skripte', text(h, false), 4); zeig('einfach, mit Skripten', text(h, true), 4); }
  } catch (e) { console.log('   einfacher Abruf: ' + e.message); }
  if (chromium && /magenta-tv$|magenta-tv\/tarife|fernsehen\.html/.test(u)) {
    const br = await chromium.launch();
    try {
      const page = await (await br.newContext({ userAgent: UA, locale: 'de-DE' })).newPage();
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(7000);
      for (const name of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) { try { await page.getByRole('button', { name }).first().click({ timeout: 1500 }); break; } catch (_) {} }
      await page.waitForTimeout(3000);
      const t = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      console.log('   Browser: Titel=' + (await page.title()) + ', URL=' + page.url());
      zeig('Browser', t, 10);
    } catch (e) { console.log('   Browser: ' + e.message); } finally { await br.close(); }
  }
}
