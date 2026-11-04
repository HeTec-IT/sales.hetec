// TEMPORÄR (2): vollständiger Browser-Text + Links der Telekom- und Vodafone-Seite
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const { chromium } = await import('playwright');
const br = await chromium.launch();
const ctx = await br.newContext({ userAgent: UA, locale: 'de-DE', viewport: { width: 1400, height: 1000 } });
const besuch = async (u, volltext, links) => {
  console.log('\n=== ' + u);
  const page = await ctx.newPage();
  try {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000);
    for (const name of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) { try { await page.getByRole('button', { name }).first().click({ timeout: 1500 }); break; } catch (_) {} }
    await page.waitForTimeout(3000);
    const t = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    console.log('Titel=' + (await page.title()) + ' URL=' + page.url() + ' Länge ' + t.length);
    if (volltext) console.log('TEXT: ' + t.slice(0, 7000));
    if (links) {
      const ls = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href + ' | ' + (a.innerText || '').trim().slice(0, 50)));
      const u2 = [...new Set(ls.filter(l => /magenta-?tv|tv-tarif|smartstream|megastream|stream/i.test(l)))];
      console.log('LINKS:\n' + u2.slice(0, 60).join('\n'));
    }
  } catch (e) { console.log('Fehler: ' + e.message); } finally { await page.close(); }
};
await besuch('https://www.telekom.de/magenta-tv', true, true);
await besuch('https://www.vodafone.de/privat/fernsehen.html', true, false);
for (const u of ['https://www.telekom.de/magenta-tv/tarife', 'https://www.telekom.de/magenta-tv/magentatv-smartstream', 'https://www.telekom.de/magenta-tv/magentatv-megastream', 'https://www.telekom.de/magenta-tv/tv-tarife']) await besuch(u, false, false);
await br.close();
