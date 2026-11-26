// Gemeinsame Hilfen für Browser-Tests (Playwright JavaScript, ohne Python).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pw = null;
export async function playwright() {
  if (pw) return pw;
  try { pw = await import('playwright'); } catch { pw = null; }
  return pw;
}
// Chromium (immer) und WebKit (wenn installiert: npx playwright install webkit)
// only: z. B. ['chromium'] – nur diese starten (nicht gestartete Browser können den Testprozess nicht offen halten)
export async function browsers(only) {
  const p = await playwright();
  if (!p) return [];
  const out = [];
  for (const name of (process.env.PS_BROWSERS || 'chromium,webkit').split(',').filter(n => !only || only.includes(n))) {
    try { const b = await p[name].launch({ args: name === 'chromium' ? ['--no-sandbox'] : [] }); out.push({ name, b }); } catch (e) { if (process.env.PS_REQUIRE_BROWSERS) throw e; }
  }
  return out;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.webmanifest': 'application/manifest+json' };
/** Statischer Server für das Repository (nur für Tests, 127.0.0.1). */
export function staticServer(root = ROOT) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(c => srv.close(c)) })));
}

/** Synthetisches, scharfes Foto ohne Text (Blockmuster) als JPEG-Buffer – erzeugt im Browser (Canvas API). */
export async function dummyPhoto(page, seed = 3) {
  const b64 = await page.evaluate(s => {
    let x = s; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const c = document.createElement('canvas'); c.width = 600; c.height = 900;
    const g = c.getContext('2d');
    for (let yy = 0; yy < 150; yy++) for (let xx = 0; xx < 100; xx++) { const v = rnd() > 0.5 ? 230 : 30; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(xx * 6, yy * 6, 6, 6); }
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, seed);
  return Buffer.from(b64, 'base64');
}

/**
 * Problemfotos aus einem Ausgangsfoto erzeugen (Ersatz für make_variants.py, Canvas API im Browser, ohne Python):
 * gradient, glare, blur_light, blur_heavy, jpeg30, lowres, rot4, noise, blank, top_only, bottom_only, truncated, garbage.
 * Rückgabe: { name: Buffer }
 */
export async function makeVariants(page, src) {
  const b64 = src.toString('base64');
  const out = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;
    const mk = (w = W, h = H) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
    const jpg = (c, q = 0.92) => c.toDataURL('image/jpeg', q).split(',')[1];
    const res = {};
    let [c, g] = mk(); g.drawImage(img, 0, 0); res.orig = jpg(c);
    // Helligkeitsverlauf links dunkel → rechts hell
    [c, g] = mk(); g.drawImage(img, 0, 0); { const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H); } res.gradient = jpg(c);
    // Spiegelung: heller elliptischer Fleck
    [c, g] = mk(); g.drawImage(img, 0, 0); { g.save(); g.translate(W * 0.6, H * 0.4); g.scale(1, (H * 0.12) / (W * 0.25)); const rg = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.25); rg.addColorStop(0, 'rgba(255,255,255,0.35)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(-W, -W, 2 * W, 2 * W); g.restore(); } res.glare = jpg(c);
    [c, g] = mk(); g.filter = 'blur(2.2px)'; g.drawImage(img, 0, 0); res.blur_light = jpg(c);
    [c, g] = mk(); g.filter = 'blur(12px)'; g.drawImage(img, 0, 0); res.blur_heavy = jpg(c);
    [c, g] = mk(); g.drawImage(img, 0, 0); res.jpeg30 = jpg(c, 0.3);
    [c, g] = mk(Math.round(W / 2) + 8, Math.round(H / 2) + 8); g.imageSmoothingQuality = 'low'; g.drawImage(img, 0, 0, c.width, c.height); res.lowres = jpg(c);
    { const a = 4 * Math.PI / 180, nw = Math.ceil(W * Math.cos(a) + H * Math.sin(a)), nh = Math.ceil(W * Math.sin(a) + H * Math.cos(a)); [c, g] = mk(nw, nh); g.fillStyle = 'rgb(20,20,20)'; g.fillRect(0, 0, nw, nh); g.translate(nw / 2, nh / 2); g.rotate(-a); g.drawImage(img, -W / 2, -H / 2); res.rot4 = jpg(c); }
    // Moiré-artiges Raster über dem Bild (fotografierter Monitor)
    [c, g] = mk(); g.drawImage(img, 0, 0); { g.globalAlpha = 0.12; for (let y = 0; y < H; y += 3) { g.fillStyle = y % 6 ? '#000' : '#fff'; g.fillRect(0, y, W, 1); } g.globalAlpha = 1; } res.moire = jpg(c);
    [c, g] = mk(); { const id = g.createImageData(W, H); let x = 7; for (let i = 0; i < id.data.length; i += 4) { x = (x * 1103515245 + 12345) % 2147483648; const v = x % 256; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; } g.putImageData(id, 0, 0); } res.noise = jpg(c, 0.85);
    [c, g] = mk(); g.fillStyle = 'rgb(240,240,240)'; g.fillRect(0, 0, W, H); res.blank = jpg(c);
    [c, g] = mk(W, Math.round(H * 0.62)); g.drawImage(img, 0, 0); res.top_only = jpg(c);
    [c, g] = mk(W, H - Math.round(H * 0.5)); g.drawImage(img, 0, -Math.round(H * 0.5)); res.bottom_only = jpg(c);
    return res;
  }, b64);
  const bufs = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  bufs.truncated = bufs.orig.subarray(0, Math.floor(bufs.orig.length / 5));
  bufs.garbage = Buffer.from('this is not an image'.repeat(50));
  return bufs;
}

/**
 * Synthetischer o2-Vorschlag als Bild (keine echten Kunden-/Personendaten): Belegtext mit Preisspalten wie am Monitor.
 * Dient als reproduzierbares Testfoto für die echte Texterkennung.
 */
export async function syntheticOfferPhoto(page, lines, { width = 1400 } = {}) {
  const b64 = await page.evaluate(({ lines, width }) => {
    const lh = 44, pad = 60, H = pad * 2 + lines.length * lh;
    const c = document.createElement('canvas'); c.width = width; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fbfbfd'; g.fillRect(0, 0, width, H);
    g.fillStyle = '#1a1a2e'; g.textBaseline = 'middle';
    lines.forEach((l, i) => {
      const y = pad + i * lh + lh / 2;
      const head = /^(HANDY|TARIF|INTERNET@HOME)$/.test(l);
      const total = /Kosten/.test(l);
      g.font = (head || total ? 'bold ' : '') + (head ? '26px' : '30px') + ' Arial, Helvetica, sans-serif';
      // Preise rechtsbündig in zwei Spalten (einmalig | monatlich)
      const m = l.match(/^(.*?)((?:-?\d{1,3}(?:\.\d{3})*,\d{2} €|–|-)\s*)((?:-?\d{1,3}(?:\.\d{3})*,\d{2} €|–)?)\s*$/);
      if (m && m[2] && /\d|–/.test(m[2]) && !total) {
        g.textAlign = 'left'; g.fillText(m[1].trim(), pad, y);
        g.textAlign = 'right'; g.fillText(m[2].trim(), width - pad - 260, y);
        if (m[3]) g.fillText(m[3].trim(), width - pad, y);
      } else if (total) {
        const mm = l.match(/^(.*?)(\d{1,3}(?:\.\d{3})*,\d{2} €)$/);
        g.textAlign = 'left'; g.fillText(mm ? mm[1].trim() : l, pad, y);
        if (mm) { g.textAlign = 'right'; g.fillText(mm[2], width - pad, y); }
      } else { g.textAlign = 'left'; g.fillText(l, pad, y); }
    });
    return c.toDataURL('image/jpeg', 0.95).split(',')[1];
  }, { lines, width });
  return Buffer.from(b64, 'base64');
}
