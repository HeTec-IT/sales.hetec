// TEMPORÄR (3): Telekom-Tarifseiten mit Preistabellen
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const { chromium } = await import('playwright');
const br = await chromium.launch();
const ctx = await br.newContext({ userAgent: UA, locale: 'de-DE', viewport: { width: 1400, height: 1000 } });
const besuch = async (u, max) => {
  console.log('\n=== ' + u);
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000);
    for (const name of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) { try { await page.getByRole('button', { name }).first().click({ timeout: 1500 }); break; } catch (_) {} }
    await page.waitForTimeout(3000);
    const t = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    console.log('HTTP ' + (resp && resp.status()) + ' Titel=' + (await page.title()) + ' Länge ' + t.length);
    const i = t.search(/SmartStream|MegaStream/);
    console.log('TEXT ab erstem Stream-Treffer (' + i + '): ' + t.slice(Math.max(0, i - 600), Math.max(0, i - 600) + max));
  } catch (e) { console.log('Fehler: ' + e.message); } finally { await page.close(); }
};
await besuch('https://www.telekom.de/magenta-tv/tarife-und-optionen/magenta-tv-mit-internet-festnetz', 7000);
await besuch('https://www.telekom.de/magenta-tv/tarife-und-optionen/magenta-tv-mit-app', 5000);
await br.close();
