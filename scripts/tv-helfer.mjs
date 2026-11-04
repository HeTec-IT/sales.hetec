// Gemeinsame Helfer für die TV-Preis-Bots (MagentaTV, Giga TV): HTML -> Text, Datum, Abruf mit echtem Browser
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export function textAusHtml(html, mitSkripten) {
  let t = String(html || '');
  if (!mitSkripten) t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  return t
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\\u20ac|\\u20AC|&euro;|&#8364;/g, '€')
    .replace(/\\u00a0|&nbsp;|&#160;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ');
}

export const zahl = s => Number(String(s).replace(/\./g, '').replace(',', '.'));

export const heute = () => new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });

// Seite mit echtem Browser öffnen (Cookie-Banner wegklicken) und sichtbaren Text + HTML liefern
export async function mitBrowser(quelle) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    console.log('Playwright nicht installiert:', e.message);
    return null;
  }
  const br = await chromium.launch();
  try {
    const page = await (await br.newContext({ userAgent: UA, locale: 'de-DE', viewport: { width: 1400, height: 1000 } })).newPage();
    await page.goto(quelle, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(7000);
    for (const name of ['Alle akzeptieren', 'Akzeptieren', 'Zustimmen']) {
      try { await page.getByRole('button', { name }).first().click({ timeout: 1500 }); break; } catch (_) {}
    }
    await page.waitForTimeout(3000);
    return { text: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' '), html: await page.content() };
  } catch (e) {
    console.log('Browser-Abruf fehlgeschlagen:', e.message);
    return null;
  } finally {
    await br.close();
  }
}

export function ausschnitte(text, re, n = 6, rand = 160) {
  const out = [];
  let m;
  const r = new RegExp(re, 'gi');
  while ((m = r.exec(text)) && out.length < n) out.push('…' + text.slice(Math.max(0, m.index - rand), m.index + rand) + '…');
  return out;
}
