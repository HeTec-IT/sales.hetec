/*
 * Smart Scan – qr-transfer.js
 * Angebot per QR-Code vom PC aufs Tablet (lokal, ohne Server).
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// === v55.204 (Beta): ANGEBOT PER QR-CODE VOM PC AUFS TABLET =================================================
// PC (Modus "Bildschirm"): gelesenes Angebot als QR-Code anzeigen. Tablet (Modus "Vom PC"): QR-Code scannen -> Angebot uebernehmen.
// Ohne Server: die Daten stecken im QR-Code (gepackt, ca. 0,5-1,5 KB). Der Shop-Code steht mit drin: das Tablet nimmt nur Angebote
// des eigenen Shops an, und nur, wenn der QR-Code hoechstens 15 Minuten alt ist.
const PS_O2_QR_MAX_AGE = 15 * 60 * 1000;
const psO2B64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const psO2UnB64 = t => { const b = atob(t.replace(/-/g, '+').replace(/_/g, '/')), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
async function psO2QrPack(d, shop, sure) {
  const it = k => (d[k] || []).map(x => [x.name || '', x.art || '', x.det || '', typeof x.t === 'number' ? x.t : null, x.am || null, x.rb || null]);
  const o = { v: 1, s: shop || '', ts: Date.now(), k: it('tarife'), g: it('geraete'), i: it('internet'), e: d.einmalig || '', m: d.monatlich || '', h: d.hinweis || '', c: sure ? 1 : 0 };
  const raw = new TextEncoder().encode(JSON.stringify(o));
  let bytes = raw, tag = 'r';
  if (typeof CompressionStream !== 'undefined') {
    try { bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); tag = 'z'; } catch (e) { bytes = raw; tag = 'r'; }
  }
  return 'PSO2' + tag + psO2B64(bytes);
}
// -> { d } oder { err: Text }
async function psO2QrUnpack(txt, myShop) {
  try {
    if (!/^PSO2[zr]/.test(txt || '')) return { err: 'Das ist kein Angebots-QR-Code von Pencil Selling.' };
    let bytes = psO2UnB64(txt.slice(5));
    if (txt[4] === 'z') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    const o = JSON.parse(new TextDecoder().decode(bytes));
    if (!o || o.v !== 1) return { err: 'QR-Code stammt von einer anderen App-Version.' };
    const nm = id => (typeof SHOPS !== 'undefined' && SHOPS[id] && SHOPS[id].name) || id;
    if (o.s && myShop && o.s !== myShop) return { err: 'Dieses Angebot ist von ' + nm(o.s) + ' – dieses Tablet gehört zu ' + nm(myShop) + '. Es wird nicht übernommen.' };
    if (!o.ts || Date.now() - o.ts > PS_O2_QR_MAX_AGE || o.ts - Date.now() > 5 * 60 * 1000) return { err: 'Der QR-Code ist abgelaufen (älter als 15 Minuten) – am PC bitte neu anzeigen.' };
    const back = a => (a || []).map(x => ({ name: x[0], art: x[1], det: x[2], ...(typeof x[3] === 'number' ? { t: x[3] } : {}), ...(x[4] ? { am: x[4] } : {}), ...(x[5] ? { rb: x[5] } : {}) }));
    return { d: { tarife: back(o.k), geraete: back(o.g), internet: back(o.i), einmalig: o.e || '', monatlich: o.m || '', hinweis: o.h || '' }, ok: o.c === 1 };
  } catch (e) { return { err: 'QR-Code nicht lesbar – bitte noch einmal scannen.' }; }
}
// QR-Code gross auf den Bildschirm (PC). Schliessen-Knopf; Ergebnis: Promise, wenn zu.
async function psO2LoadLib(local) {
  await psPortLoadScript(local); // nur selbst gehostet, kein CDN-Rückfall
}
async function psO2QrShow(payload, info, warn) {
  await psO2LoadLib('vendor/qrcode.js');
  // Fehlerkorrektur M, bei sehr grossen Angeboten L (mehr Platz)
  let qr; try { qr = window.qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make(); } catch (e) { qr = window.qrcode(0, 'L'); qr.addData(payload, 'Byte'); qr.make(); }
  const n = qr.getModuleCount(), q = 4, S = n + 2 * q, px = Math.max(3, Math.floor(840 / S));
  const c = document.createElement('canvas'); c.width = c.height = S * px;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) x.fillRect((k + q) * px, (r + q) * px, px, px);
  return new Promise(resolve => {
    const el = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.setAttribute('style', css); if (txt != null) e.textContent = txt; return e; };
    const root = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:100020;background:rgba(2,6,23,.85);display:flex;align-items:center;justify-content:center;padding:16px');
    root.setAttribute('data-ps-qr', '1');
    const card = el('div', 'background:#fff;border-radius:18px;padding:20px;max-width:640px;width:100%;text-align:center;font:600 15px system-ui,sans-serif;color:#0f172a;max-height:100%;overflow:auto');
    card.appendChild(el('div', 'font:900 20px system-ui,sans-serif;margin-bottom:4px', 'Angebot ans Tablet senden'));
    card.appendChild(el('div', 'color:#475569;margin-bottom:12px', 'Am Tablet „o2-Vorschlag einlesen“ antippen – der Scanner öffnet sich von selbst'));
    c.setAttribute('style', 'width:min(72vmin,680px);height:min(72vmin,680px);image-rendering:pixelated;border:1px solid #e2e8f0;border-radius:8px');
    card.appendChild(c);
    card.appendChild(el('div', 'margin-top:10px;color:#166534;font-weight:800', info || ''));
    if (warn) card.appendChild(el('div', 'margin-top:4px;color:#b45309;font-weight:800', warn));
    card.appendChild(el('div', 'margin-top:2px;color:#64748b;font-size:13px', 'Gilt 15 Minuten und nur für den eigenen Shop'));
    const b = el('button', 'margin-top:14px;font:800 16px system-ui,sans-serif;border:0;border-radius:12px;padding:13px 26px;background:#2563eb;color:#fff;cursor:pointer', 'Fertig');
    b.type = 'button';
    const done = () => { document.removeEventListener('keydown', onKey, true); if (root.parentNode) root.parentNode.removeChild(root); resolve(); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
    b.onclick = done; root.onclick = e => { if (e.target === root) done(); }; card.appendChild(b); root.appendChild(card); document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
  });
}
// QR-Code mit der Kamera scannen (Tablet). BarcodeDetector wo vorhanden (Chrome/Android), sonst jsQR. Ergebnis: Text oder null (abgebrochen).
async function psO2QrScan() {
  let det = null;
  try { if (window.BarcodeDetector && (!BarcodeDetector.getSupportedFormats || (await BarcodeDetector.getSupportedFormats()).indexOf('qr_code') >= 0)) det = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { det = null; }
  if (!det) await psO2LoadLib('vendor/jsQR.js');
  return new Promise(resolve => {
    let stream = null, done = false, timer = 0, busy = false;
    const el = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.setAttribute('style', css); if (txt != null) e.textContent = txt; return e; };
    const root = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:100020;background:#000;display:flex;flex-direction:column');
    root.setAttribute('data-ps-scan', '1');
    const bar = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;color:#fff;font:800 16px system-ui,sans-serif');
    const close = el('button', 'font:700 14px system-ui,sans-serif;border:0;border-radius:10px;padding:8px 12px;background:#1e293b;color:#fff;cursor:pointer', '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Abbrechen');
    bar.appendChild(close); bar.appendChild(el('div', 'flex:1;text-align:center', 'QR-Code vom PC scannen'));
    bar.appendChild(el('div', 'width:44px'));
    const hint = el('div', 'color:#fff;font:700 15px system-ui,sans-serif;padding:0 16px 8px;text-align:center', 'QR-Code des PC-Bildschirms in die Mitte halten');
    const stage = el('div', 'position:relative;flex:1;overflow:hidden;min-height:0');
    const video = el('video', 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;background:#000'); video.muted = true; video.autoplay = true; video.setAttribute('playsinline', '');
    const box = el('div', 'position:absolute;left:50%;top:50%;width:min(70vmin,420px);height:min(70vmin,420px);transform:translate(-50%,-50%);border:4px solid #22c55e;border-radius:16px;box-shadow:0 0 0 100vmax rgba(0,0,0,.45);pointer-events:none');
    stage.appendChild(video); stage.appendChild(box);
    root.appendChild(bar); root.appendChild(hint); root.appendChild(stage);
    const finish = res => {
      if (done) return; done = true; clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { video.srcObject = null; } catch (e) {}
      if (root.parentNode) root.parentNode.removeChild(root);
      resolve(res);
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    close.onclick = () => finish(null);
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (done) return;
      timer = setTimeout(tick, 150);
      if (busy || video.readyState < 2 || !video.videoWidth) return;
      busy = true;
      try {
        let txt = '';
        if (det) { const r = await det.detect(video); if (r && r.length) txt = r[0].rawValue || ''; }
        else {
          const W = Math.min(800, video.videoWidth), H = Math.round(W * video.videoHeight / video.videoWidth);
          if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
          cx.drawImage(video, 0, 0, W, H);
          const r = window.jsQR(cx.getImageData(0, 0, W, H).data, W, H, { inversionAttempts: 'attemptBoth' });
          if (r) txt = r.data || '';
        }
        if (txt) { try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {} finish(txt); }
      } catch (e) {}
      busy = false;
    };
    document.body.appendChild(root); document.addEventListener('keydown', onKey, true);
    (async () => {
      try {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } } }); }
        catch (e) { if (e && /NotAllowed|Security|PermissionDenied/i.test(e.name || '')) throw e; stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); }
        if (done) { stream.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = stream; try { await video.play(); } catch (e) {}
        tick();
      } catch (e) {
        hint.textContent = 'Kein Zugriff auf die Kamera – in den Geräte-Einstellungen erlauben.';
        const cl = el('button', 'margin:16px auto;font:800 16px system-ui,sans-serif;border:0;border-radius:12px;padding:12px 22px;background:#2563eb;color:#fff;cursor:pointer', 'Schließen'); cl.type = 'button'; cl.onclick = () => finish(null); root.appendChild(cl);
      }
    })();
  });
}
