// TEMPORÄR: Vodafone Giga-TV- und Netflix-Seite lesen
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const { chromium } = await import('playwright');
const br = await chromium.launch();
const ctx = await br.newContext({ userAgent: UA, locale: 'de-DE', viewport: { width: 1400, height: 1000 } });
const T = s => String(s).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&euro;/g, '€').replace(/&nbsp;|&#160;/g, ' ').replace(/&uuml;/g, 'ü').replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&szlig;/g, 'ß').replace(/&amp;/g, '&').replace(/&ndash;/g, '–').replace(/\s+/g, ' ');
for (const u of ['https://www.vodafone.de/privat/fernsehen/giga-tv.html', 'https://www.vodafone.de/privat/fernsehen/streaming-angebote.html']) {
  console.log('\n=== ' + u);
  try { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE' } }); const h = await r.text(); console.log('plain HTTP ' + r.status + ' ' + h.length); if (r.ok) console.log('PLAIN: ' + T(h).slice(0, 6000)); } catch (e) { console.log('plain Fehler ' + e.message); }
  const page = await ctx.newPage();
  try {
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(7000);
    for (const name of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) { try { await page.getByRole('button', { name }).first().click({ timeout: 1500 }); break; } catch (_) {} }
    await page.waitForTimeout(3000);
    const t = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
    console.log('BROWSER ' + t.length + ': ' + t.slice(0, 7000));
  } catch (e) { console.log('Browser Fehler ' + e.message); } finally { await page.close(); }
}
await br.close();
