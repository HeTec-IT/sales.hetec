/*
 * Smart Scan – hsc-import.js
 * Import aus HeTec Smart Capture: QR-Code vom PC-Bildschirm scannen → HSC-Protokoll prüfen → Angebot ins interne Datenmodell.
 *
 * - Keine erneute OCR auf dem Tablet: der QR-Code enthält bereits die strukturierten Angebotsdaten.
 * - Gültigkeit, Schemaversion, Prüfsumme, Allowlist und personenbezogene Daten prüft frontend/smart-scan/hsc-protocol.js
 *   (byte-identisch mit dem Encoder in Smart Capture).
 * - Mehrfach-QR: der Scanner bleibt offen, bis alle Teile erkannt sind; nie Teilimport.
 * - Die Kamera wird nach dem Scan, beim Abbrechen, beim Verlassen und wenn die App in den Hintergrund geht sofort gestoppt.
 * - Doppelte Übernahme derselben Angebots-ID (+ Version) wird verhindert (gespeichert wird nur die zufällige ID, 24 Stunden).
 * Klassisches Skript (globale Funktionen wie die übrigen Smart-Scan-Module), geladen vor ui-dialog.js.
 */
const PS_HSC_SEEN_KEY = 'ps_hsc_imported';
const PS_HSC_SEEN_MS = 24 * 60 * 60 * 1000;

// HSC-Angebot (Integer-Cent) → internes Datenmodell des o2-Vorschlag-Imports (wie psO2Parse/Foto-Import es liefert)
function psHscToProposal(o) {
  const F = c => (c == null ? null : HSC.centsToText(c));
  const conv = (it, kind) => {
    const x = { name: it.name, art: it.art || '', det: (it.details || []).join('\n') };
    if (it.e != null || it.m != null) x.am = [F(it.e), F(it.m)];
    x.rb = { e: it.re || 0, m: it.rm || 0, bad: !!it.rbBad };
    if (kind === 'tarife' && it.ak) x.ak = true;
    if (kind === 'geraete' && typeof it.t === 'number') x.t = it.t;
    return x;
  };
  const hin = [];
  if ((o.zusatz || []).length) hin.push('Zusatzprodukte: ' + o.zusatz.map(z => z.name + (z.m != null ? ' (' + F(z.m) + ' € mtl.)' : z.e != null ? ' (' + F(z.e) + ' € einm.)' : '')).join(', '));
  (o.priceChanges || []).forEach(p => hin.push('Ab dem ' + p.month + '. Monat: ' + F(p.m) + ' € monatlich'));
  return {
    tarife: (o.tarife || []).map(it => conv(it, 'tarife')),
    geraete: (o.geraete || []).map(it => conv(it, 'geraete')),
    internet: (o.internet || []).map(it => conv(it, 'internet')),
    einmalig: F(o.einmalig) || '', monatlich: F(o.monatlich) || '',
    hinweis: hin.join(' · '), beratungsId: ''
  };
}
// Hinweise der PC-Erkennung als kurzer Text (feste Sätze aus dem Protokoll, keine Kundendaten)
function psHscWarnText(o) {
  return ((o.quality && o.quality.warnings) || []).map(w => HSC.WARN[w]).filter(Boolean).join(' · ');
}
// Bereits übernommene Angebote (nur zufällige ID + Version, keine Angebotsinhalte)
function psHscSeen() {
  try {
    const o = JSON.parse(localStorage.getItem(PS_HSC_SEEN_KEY) || '{}'), now = Date.now(), out = {};
    Object.keys(o).forEach(k => { if (/^[0-9a-z]{10}\.\d{1,3}$/.test(k) && typeof o[k] === 'number' && now - o[k] < PS_HSC_SEEN_MS) out[k] = o[k]; });
    return out;
  } catch (e) { return {}; }
}
const psHscKey = o => o.id + '.' + o.rev;
function psHscWasImported(o) { return !!psHscSeen()[psHscKey(o)]; }
function psHscMarkImported(list) {
  if (!list || !list.length) return;
  try { const s = psHscSeen(); list.forEach(o => { s[psHscKey(o)] = Date.now(); }); localStorage.setItem(PS_HSC_SEEN_KEY, JSON.stringify(s)); } catch (e) {}
}
// Zwei Angebote zusammenführen ("Angebot ergänzen"): Listen anhängen (Obergrenzen wie im Dialog), Summen addieren
function psHscMerge(a, b, max) {
  const lim = k => (max && max[k]) || 6;
  const off = a.tarife.length;
  const add = (x, y) => { const cx = psO2Cents(x), cy = psO2Cents(y); return cx == null ? (y || '') : cy == null ? (x || '') : psO2Fmt(cx + cy); };
  return {
    ...a,
    tarife: a.tarife.concat(b.tarife).slice(0, lim('tarife')),
    geraete: a.geraete.concat(b.geraete.map(g => (typeof g.t === 'number' ? { ...g, t: g.t + off } : g))).slice(0, lim('geraete')),
    internet: a.internet.concat(b.internet).slice(0, lim('internet')),
    einmalig: add(a.einmalig, b.einmalig), monatlich: add(a.monatlich, b.monatlich),
    hinweis: [a.hinweis, b.hinweis].filter(Boolean).join(' · ')
  };
}

// QR-Scanner für Smart Capture. Ergebnis: { ok: true, offer } | { ok: false, code, message } | null (abgebrochen)
async function psHscScan() {
  let det = null;
  try { if (window.BarcodeDetector && (!BarcodeDetector.getSupportedFormats || (await BarcodeDetector.getSupportedFormats()).indexOf('qr_code') >= 0)) det = new BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { det = null; }
  // jsQR (selbst gehostet) immer bereithalten: BarcodeDetector ist nicht überall verfügbar (iPad/Safari) und gilt als experimentell
  try { await psO2LoadLib('vendor/jsQR.js'); } catch (e) { if (!det) return { ok: false, code: 'SCANNER', message: 'QR-Scanner konnte nicht geladen werden.' }; }
  return new Promise(resolve => {
    let stream = null, done = false, timer = 0, busy = false, hintT = 0, useDet = !!det;
    const col = new HSC.Collector();
    const el = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.setAttribute('style', css); if (txt != null) e.textContent = txt; return e; };
    const root = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:100030;background:#000;display:flex;flex-direction:column;font-family:system-ui,-apple-system,"Segoe UI",sans-serif');
    root.setAttribute('data-ps-hsc-scan', '1');
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Smart Capture – QR-Code scannen');
    const bar = el('div', 'display:flex;align-items:center;gap:8px;padding:12px 14px;color:#fff;font-weight:800;font-size:17px');
    const close = el('button', 'font:700 15px system-ui,sans-serif;border:0;border-radius:12px;padding:10px 14px;background:#1e293b;color:#fff;cursor:pointer', 'Abbrechen');
    close.type = 'button';
    bar.appendChild(close); bar.appendChild(el('div', 'flex:1;text-align:center', 'Smart Capture – QR-Code scannen')); bar.appendChild(el('div', 'width:96px'));
    const hint = el('div', 'color:#fff;font-weight:700;font-size:15px;padding:0 16px 10px;text-align:center', 'QR-Code am PC-Bildschirm in den Rahmen halten');
    hint.setAttribute('role', 'status');
    const stage = el('div', 'position:relative;flex:1;overflow:hidden;min-height:0');
    const video = el('video', 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;background:#000');
    video.muted = true; video.autoplay = true; video.setAttribute('playsinline', '');
    const box = el('div', 'position:absolute;left:50%;top:50%;width:min(78vmin,560px);height:min(78vmin,560px);transform:translate(-50%,-50%);border:4px solid #3b82f6;border-radius:18px;box-shadow:0 0 0 100vmax rgba(0,0,0,.45);pointer-events:none');
    stage.appendChild(video); stage.appendChild(box);
    root.appendChild(bar); root.appendChild(hint); root.appendChild(stage);
    const say = (t, ms) => { hint.textContent = t; clearTimeout(hintT); if (ms) hintT = setTimeout(() => { if (!done) hint.textContent = col.total > 1 ? 'Teil ' + col.have() + ' von ' + col.total + ' erkannt – weiter auf den QR-Code halten' : 'QR-Code am PC-Bildschirm in den Rahmen halten'; }, ms); };
    const stopCam = () => { try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {} stream = null; try { video.pause(); video.srcObject = null; } catch (e) {} };
    const finish = res => {
      if (done) return; done = true;
      clearTimeout(timer); clearTimeout(hintT);
      stopCam(); // Kamera sofort aus
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      if (root.parentNode) root.parentNode.removeChild(root);
      resolve(res);
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    const onVis = () => { if (document.visibilityState === 'hidden') finish(null); };
    const onHide = () => finish(null);
    close.onclick = () => finish(null);
    const accept = txt => {
      if (!txt) return;
      if (!/^HSC/.test(txt)) { say(/^PSO2/.test(txt) ? 'Das ist ein älterer Pencil-Selling-QR-Code – bitte den QR-Code von HeTec Smart Capture scannen.' : 'Kein QR-Code von HeTec Smart Capture.', 2500); return; }
      let st;
      try { st = col.add(txt); }
      catch (e) {
        if (e && e.hscCode === 'MIXED') { col.reset(); try { st = col.add(txt); } catch (x) { say(x.message, 2500); return; } }
        else { say((e && e.message) || 'QR-Code nicht lesbar.', 2500); return; }
      }
      try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
      if (!st.done) { say('Teil ' + st.have + ' von ' + st.total + ' erkannt – weiter auf den QR-Code halten (wechselt automatisch)'); return; }
      finish(HSC.decode(col));
    };
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (done) return;
      timer = setTimeout(tick, 120);
      if (busy || video.readyState < 2 || !video.videoWidth) return;
      busy = true;
      try {
        let txt = '';
        if (useDet) {
          try { const r = await det.detect(video); if (r && r.length) txt = r[0].rawValue || ''; }
          catch (e) { useDet = false; } // BarcodeDetector fehlerhaft → jsQR
        }
        if (!txt && !useDet && window.jsQR) {
          const W = Math.min(1280, video.videoWidth), H = Math.round(W * video.videoHeight / video.videoWidth);
          if (cv.width !== W) cv.width = W; if (cv.height !== H) cv.height = H;
          cx.drawImage(video, 0, 0, W, H);
          const r = window.jsQR(cx.getImageData(0, 0, W, H).data, W, H, { inversionAttempts: 'dontInvert' });
          if (r) txt = r.data || '';
        }
        if (!done) accept(txt);
      } catch (e) {}
      busy = false;
    };
    document.body.appendChild(root);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotFoundError' });
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } }); }
        catch (e) { if (e && /NotAllowed|Security|PermissionDenied/i.test(e.name || '')) throw e; stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); }
        if (done) { stream.getTracks().forEach(t => t.stop()); stream = null; return; }
        video.srcObject = stream;
        try { await video.play(); } catch (e) {}
        tick();
      } catch (e) {
        stopCam();
        say(e && /NotAllowed|Security|PermissionDenied/i.test(e.name || '') ? 'Kein Zugriff auf die Kamera – bitte in den Geräte-/Browser-Einstellungen für Pencil Selling erlauben.' : 'Keine Kamera gefunden.');
        const cl = el('button', 'margin:16px auto;font:800 16px system-ui,sans-serif;border:0;border-radius:12px;padding:12px 22px;background:#2563eb;color:#fff;cursor:pointer', 'Schließen');
        cl.type = 'button'; cl.onclick = () => finish(null); root.appendChild(cl);
      }
    })();
  });
}
