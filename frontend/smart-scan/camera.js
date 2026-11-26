/*
 * Smart Scan – camera.js
 * Eigene Kamera (Live-Prüfung von Schärfe, Abstand, Ausrichtung) für Monitorfotos.
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// === v55.196 (Beta): EIGENE KAMERA FUER DEN O2-IMPORT ====================================================
// Live-Bild mit Rahmen und Anzeige "scharf / unscharf": Bildschirm in den Rahmen halten, die App loest von selbst aus,
// sobald das Bild scharf, hell genug und ruhig ist. Das Foto ist schon auf den Rahmen zugeschnitten.
// Rueckfall: normale Kamera-App (Knopf im Overlay bzw. Haken im Dialog).
// w = Analysebreite (nahe an der Breite, auf der die Texterkennung liest); rMin/rel = Schaerfe-Untergrenze bzw. Anteil der besten Schaerfe der letzten 3 s
let __psO2CamHoch = null; // null = automatisch nach Bildformat
const PS_O2_CAM = { ar: 1.7, arP: 0.72, arB: 4.0, arK: 6.5, arS: 1.35, sGo: 0.55, sMax: 1.0, w: 1600, rMin: 0.2, rel: 0.7, vMin: 8, motion: 10, dark: 40, tilt: 0.55, bright: 0.9, hold: 400, warm: 500 };
const PS_O2_CAM_MSG = {
  start: ['Kamera startet …', '#334155', '#ffffff'],
  dark: ['Zu dunkel – mehr Licht oder Bildschirm heller stellen', '#b45309', '#f59e0b'],
  bright: ['Zu hell oder Spiegelung – Winkel leicht ändern', '#b45309', '#f59e0b'],
  blur: ['Unscharf – etwas Abstand, kurz ruhig halten', '#b91c1c', '#ef4444'],
  shaky: ['Ruhig halten …', '#b45309', '#f59e0b'],
  tilt: ['Gerade von vorne halten – eine Seite ist zu dunkel', '#b45309', '#f59e0b'],
  ok: ['Scharf ✓ – ruhig halten', '#15803d', '#22c55e']
};
function psO2CamSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
// Messwerte des Rahmenbereichs (auf feste Breite verkleinert, damit iPad und Samsung-Tab vergleichbar sind):
// Schaerfe = Verhaeltnis der Laplace-Varianz bei voller zu halber Aufloesung (unabhaengig vom Inhalt: unscharfe Bilder verlieren
// die feinen Kanten), dazu Helligkeit, Anteil ueberbelichteter Pixel und Bewegung gegen das vorige Bild.
function psO2CamMeasure(video, fr, cv, cx, prev) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const sx = fr.x * vw, sy = fr.y * vh, sw = fr.w * vw, sh = fr.h * vh, W = Math.max(64, Math.min(PS_O2_CAM.w, Math.round(sw), Math.round(Math.sqrt(2.6e6 * sw / sh)))), H = Math.max(8, Math.round(W * sh / sw));
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  try { cx.imageSmoothingQuality = 'high'; } catch (e) {}
  cx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data, n = W * H, g = new Float32Array(n);
  let sum = 0, sat = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) { const v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; g[i] = v; sum += v; if (v >= 250) sat++; }
  const lapVar = (a, w, hh) => {
    let s1 = 0, s2 = 0, cnt = 0;
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, l = a[i - 1] + a[i + 1] + a[i - w] + a[i + w] - 4 * a[i];
      s1 += l; s2 += l * l; cnt++;
    }
    if (!cnt) return 0;
    const mm = s1 / cnt; return s2 / cnt - mm * mm;
  };
  const v1 = lapVar(g, W, H), W2 = W >> 1, H2 = H >> 1, g2 = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) { const i = 2 * y * W + 2 * x; g2[y * W2 + x] = (g[i] + g[i + 1] + g[i + W] + g[i + W + 1]) / 4; }
  const v2 = lapVar(g2, W2, H2);
  const GX = 48, GY = 30, sub = new Uint8Array(GX * GY);
  for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) sub[gy * GX + gx] = g[Math.min(H - 1, Math.floor((gy + 0.5) * H / GY)) * W + Math.min(W - 1, Math.floor((gx + 0.5) * W / GX))];
  let mo = 0;
  if (prev && prev.length === sub.length) { for (let i = 0; i < sub.length; i++) mo += Math.abs(sub[i] - prev[i]); mo /= sub.length; }
  // helles Ende (Papier) im linken und rechten Drittel: Sichtschutzfolie + schraeg gehalten -> eine Seite deutlich dunkler
  const side = (a, b) => { const v = []; for (let gy = 0; gy < GY; gy++) for (let gx = a; gx < b; gx++) v.push(sub[gy * GX + gx]); v.sort((p, q) => p - q); return v[Math.floor(v.length * 0.9)]; };
  const sl = side(0, 16), sr = side(32, 48), lr = Math.min(sl, sr) / Math.max(1, sl, sr);
  return { sharp: v2 > 1e-6 ? v1 / v2 : 0, v1, mean: sum / n, sat: sat / n, sub, motion: mo, lr };
}
// Entscheidung aus den Messwerten: start | dark | bright | blur | shaky | ok  (peak = beste Schaerfe der letzten Sekunden)
function psO2CamState(m, peak, age) {
  const C = PS_O2_CAM;
  if (age < C.warm) return 'start';
  if (m.mean < C.dark) return 'dark';
  if (m.lr != null && m.lr < C.tilt) return 'tilt';
  if (m.sat > C.bright) return 'bright';
  if (m.v1 < C.vMin || m.sharp < C.rMin || m.sharp < C.rel * peak) return 'blur';
  if (m.motion > C.motion) return 'shaky';
  return 'ok';
}
// Oeffnet die Kamera als Vollbild.
// Einzelfoto: Ergebnis { file, auto } | 'native' (normale Kamera-App nehmen) | null (abgebrochen).
// Block-Fotos (opts.session): die Kamera bleibt offen, jedes Foto geht an opts.onShot(file, schritt) -> Promise<kurzer Text, leer = nichts erkannt>.
// Schritte: "block" (Block 1, 2, ... je ein Tarif-/Handy-/Internet-Block, flacher Rahmen) und "kosten" (Kostenblock, beendet die Reihe). Ergebnis: 'fertig' | null.
// v55.209 Scannen (opts.scan): die Kamera verfolgt, wie weit der Vorschlag durchs Bild gewandert ist (Tablet nach unten fuehren
// ODER am PC scrollen) und macht selbst ein Foto, sobald gut die Haelfte neu ist. opts.onShot(file, 'scan', ueberlappung 0..1)
// -> Promise<Text | { t, end }>; end = Kostenblock gelesen -> Scannen endet von selbst.
function psO2CamOpen(opts) {
  const o = opts || {}, C = PS_O2_CAM, scan = !!o.scan, ses = !!o.session || scan;
  return new Promise(resolve => {
    let stream = null, timer = 0, done = false, shot = false, curHoch = false, vw = 0, vh = 0, fr = { x: 0.03, y: 0.05, w: 0.94, h: 0.9 }, okSince = 0, hist = [], prev = null, cur = '';
    let step = o.step === 'kosten' ? 'kosten' : 'block', blockN = 1, lastSub = null, pend = 0, finishing = false;
    let ic = null, photoSet = null, stillFail = 0, errored = false, lastShotAt = 0, moved = true, moveTicks = 0;
    let travel = 0, prevP = null, nShots = 0;
    const results = [];
    const t0 = Date.now();
    // Einzelfoto: Auto standardmaessig an. Block-Reihe: aus (Foto-Taste), sonst loest jede Handbewegung einen neuen "Block" aus.
    const AK = ses ? 'ps_o2_camauto_s' : 'ps_o2_camauto';
    let auto = !ses; try { const av = localStorage.getItem(AK); if (av != null) auto = av === '1'; } catch (e) {}
    if (scan) auto = true;
    const el = (tag, css, txt) => { const n = document.createElement(tag); if (css) n.setAttribute('style', css); if (txt != null) n.textContent = txt; return n; };
    const btn = (txt, css, fn, label) => { const b = el('button', 'font:700 14px system-ui,sans-serif;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;' + css, txt); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.onclick = fn; return b; };
    const root = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:100020;background:#000;display:flex;flex-direction:column;touch-action:manipulation;-webkit-user-select:none;user-select:none');
    root.setAttribute('data-ps-cam', '1');
    const bar = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;color:#fff;font:800 16px system-ui,sans-serif');
    const title = el('div', 'flex:1;text-align:center', '');
    const paintTitle = () => { title.textContent = scan ? 'Vorschlag scannen' + (nShots ? ' · ' + nShots + (nShots === 1 ? ' Foto' : ' Fotos') : '') : ses ? (step === 'kosten' ? 'Kostenblock fotografieren' : 'Block ' + blockN + ' fotografieren') : (o.label ? o.label + ' fotografieren' : 'Foto aufnehmen'); };
    paintTitle();
    const autoB = btn('', 'background:#1e293b;color:#fff;padding:8px 12px', () => { auto = !auto; okSince = 0; try { localStorage.setItem(AK, auto ? '1' : '0'); } catch (e) {} paintAuto(); }, 'Automatisch auslösen');
    const paintAuto = () => { autoB.textContent = auto ? 'Auto ✓' : 'Auto aus'; };
    paintAuto();
    const oriB = btn('', 'background:#1e293b;color:#fff;padding:8px 12px', () => { __psO2CamHoch = !curHoch; layout(); }, 'Rahmen hoch oder quer');
    bar.appendChild(btn('✕', 'background:#1e293b;color:#fff;padding:8px 12px', () => finish(null), 'Abbrechen'));
    bar.appendChild(title); if (!ses) bar.appendChild(oriB); if (scan) bar.appendChild(el('div', 'width:44px')); else bar.appendChild(autoB);
    const hintRow = el('div', 'display:flex;justify-content:center;padding:0 12px 8px');
    const hint = el('div', 'color:#fff;font:800 15px system-ui,sans-serif;padding:8px 16px;border-radius:999px;text-align:center;max-width:94%;transition:background .2s', '');
    hintRow.appendChild(hint);
    const stage = el('div', 'position:relative;flex:1;overflow:hidden;min-height:0');
    const video = el('video', 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;background:#000');
    video.muted = true; video.autoplay = true; video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
    const frame = el('div', 'position:absolute;box-sizing:border-box;border:4px solid #fff;border-radius:12px;box-shadow:0 0 0 100vmax rgba(0,0,0,.5);pointer-events:none;transition:border-color .2s');
    stage.appendChild(video); stage.appendChild(frame);
    const flash = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .25s');
    stage.appendChild(flash);
    const chips = el('div', 'display:flex;flex-wrap:wrap;justify-content:center;gap:6px;padding:6px 12px 0;min-height:8px');
    const paintChips = () => {
      chips.textContent = '';
      results.slice(-4).forEach(r => {
        const bg = r.st === 'ok' ? '#15803d' : r.st === 'leer' ? '#b91c1c' : '#334155';
        chips.appendChild(el('div', 'color:#fff;font:700 13px system-ui,sans-serif;padding:5px 10px;border-radius:999px;background:' + bg, r.st === 'ok' ? '✓ ' + r.l + ': ' + r.t : r.st === 'leer' ? '✗ ' + r.l + ': nichts erkannt – nochmal' : '… ' + r.l + ' wird gelesen'));
      });
    };
    const bottom = el('div', 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:8px');
    const shutter = el('button', 'width:68px;height:68px;border-radius:50%;border:5px solid #fff;background:#2563eb;cursor:pointer;padding:0');
    shutter.type = 'button'; shutter.setAttribute('aria-label', 'Foto aufnehmen'); shutter.onclick = () => capture(false);
    // Querformat: zusaetzlich je eine Foto-Taste links und rechts (mit jeder Hand erreichbar), unterhalb des Rahmens
    const sideBtn = pos => {
      const b = el('button', 'position:absolute;z-index:3;display:none;' + pos + ':14px;width:76px;height:76px;border-radius:50%;border:5px solid #fff;background:#2563eb;cursor:pointer;padding:0;box-shadow:0 2px 10px rgba(0,0,0,.5)');
      b.type = 'button'; b.setAttribute('aria-label', 'Foto aufnehmen'); b.onclick = () => capture(false); stage.appendChild(b); return b;
    };
    const sideL = sideBtn('left'), sideR = sideBtn('right');
    let stepB = null, doneB = null;
    if (ses) {
      stepB = scan ? null : btn('', 'background:#1e293b;color:#cbd5e1;font-size:13px;min-width:96px', () => { step = step === 'block' ? 'kosten' : 'block'; lastSub = null; okSince = 0; paintTitle(); paintStep(); layout(); }, 'Zwischen Block und Kostenblock wechseln');
      doneB = btn('Fertig', 'background:#2563eb;color:#fff;min-width:96px', () => finishSession(), 'Fertig');
      bottom.appendChild(stepB || el('div', 'min-width:96px')); bottom.appendChild(shutter); bottom.appendChild(doneB);
    } else {
      bottom.appendChild(btn('Kamera-App', 'background:#1e293b;color:#cbd5e1;font-size:13px', () => finish('native'), 'Normale Kamera-App öffnen'));
      bottom.appendChild(shutter); bottom.appendChild(el('div', 'width:96px'));
    }
    const paintStep = () => { if (stepB) stepB.textContent = step === 'block' ? 'Kostenblock →' : '← Block'; };
    paintStep();
    root.appendChild(bar); root.appendChild(hintRow); root.appendChild(stage); if (ses) root.appendChild(chips); root.appendChild(bottom);

    const setState = k => {
      if (k === cur) return; cur = k;
      const m = PS_O2_CAM_MSG[k];
      hint.textContent = m[0]; hint.style.background = m[1]; frame.style.borderColor = m[2];
    };
    // Rahmen mittig im sichtbaren Videobild (object-fit: contain); fr = Rahmen in Anteilen des Videobilds
    const layout = () => {
      const sw = stage.clientWidth, sh = stage.clientHeight;
      if (!sw || !sh) return;
      const w = vw || sw, h = vh || sh, k = Math.min(sw / w, sh / h), dw = w * k, dh = h * k, dx = (sw - dw) / 2, dy = (sh - dh) / 2;
      curHoch = __psO2CamHoch != null ? __psO2CamHoch : h > w;
      oriB.textContent = curHoch ? '▯ Hochformat' : '▭ Querformat';
      let fw, fh;
      if (ses) { const ar = scan ? C.arS : step === 'kosten' ? C.arK : C.arB; fw = dw * 0.94; fh = fw / ar; if (fh > dh * 0.9) { fh = dh * 0.9; fw = fh * ar; } }
      else if (curHoch) { fh = dh * 0.92; fw = fh * C.arP; if (fw > dw * 0.94) { fw = dw * 0.94; fh = fw / C.arP; } }
      else { fw = dw * 0.94; fh = fw / C.ar; if (fh > dh * 0.9) { fh = dh * 0.9; fw = fh * C.ar; } }
      const fl = dx + (dw - fw) / 2, ft = dy + (dh - fh) / 2;
      fr = { x: (fl - dx) / dw, y: (ft - dy) / dh, w: fw / dw, h: fh / dh };
      frame.style.left = fl + 'px'; frame.style.top = ft + 'px'; frame.style.width = fw + 'px'; frame.style.height = fh + 'px';
      const land = (root.clientWidth || sw) > (root.clientHeight || sh), sbTop = ft + fh + 12 + 76 <= sh ? ft + fh + 12 : sh - 76 - 12;
      [sideL, sideR].forEach(b => { b.style.display = land && !errored ? 'block' : 'none'; b.style.top = Math.round(Math.max(8, sbTop)) + 'px'; });
    };
    const finish = res => {
      if (done) return; done = true;
      clearTimeout(timer);
      window.removeEventListener('resize', layout); document.removeEventListener('keydown', onKey, true);
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
      try { video.srcObject = null; } catch (e) {}
      if (root.parentNode) root.parentNode.removeChild(root);
      resolve(res);
    };
    // Reihe beenden: erst wenn alle Fotos gelesen sind
    const finishSession = () => {
      finishing = true;
      if (!pend) { finish('fertig'); return; }
      setState('start'); hint.textContent = 'Wird gelesen …'; hint.style.background = '#334155';
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); capture(false); } };
    // Standbild der Kamera (ImageCapture, z. B. Chrome/Samsung auf Android): eigener Autofokus und volle Sensor-Aufloesung,
    // deutlich schaerfer und groesser als ein Videobild. Es hat nicht immer den gleichen Bildausschnitt wie die Vorschau
    // (4:3-Foto zu 16:9-Vorschau); die Lage wird deshalb per Korrelation mit dem Vorschaubild bestimmt. Passt nichts -> Videobild.
    const MG = 0.03;
    const grayOf = (src, sx, sy, sw, sh, W, H) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high';
      x.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
      const d = x.getImageData(0, 0, W, H).data, g = new Float32Array(W * H);
      for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      return g;
    };
    const ncc = (a, b) => {
      const n = a.length; let ma = 0, mb = 0;
      for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
      ma /= n; mb /= n;
      let sab = 0, saa = 0, sbb = 0;
      for (let i = 0; i < n; i++) { const p = a[i] - ma, q = b[i] - mb; sab += p * q; saa += p * p; sbb += q * q; }
      return saa > 1e-6 && sbb > 1e-6 ? sab / Math.sqrt(saa * sbb) : 0;
    };
    const timeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); }); });
    const cropOf = (src, sw0, sh0, R) => {
      // R = Bereich im Quellbild, der dem ganzen Vorschaubild entspricht
      const x0 = R[0] + Math.max(0, fr.x - fr.w * MG) * R[2], y0 = R[1] + Math.max(0, fr.y - fr.h * MG) * R[3];
      const x1 = R[0] + Math.min(1, fr.x + fr.w * (1 + MG)) * R[2], y1 = R[1] + Math.min(1, fr.y + fr.h * (1 + MG)) * R[3];
      const k = Math.min(1, 4096 / Math.max(x1 - x0, y1 - y0));
      const c = document.createElement('canvas'); c.width = Math.max(8, Math.round((x1 - x0) * k)); c.height = Math.max(8, Math.round((y1 - y0) * k));
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(src, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
      return c;
    };
    const fromVideo = () => cropOf(video, video.videoWidth, video.videoHeight, [0, 0, video.videoWidth, video.videoHeight]);
    // v55.210: 6 Videobilder kurz hintereinander, gegeneinander ausgerichtet (Zeilen-/Spaltenprofil) und gemittelt:
    // Rauschen sinkt deutlich (flaue Bilder durch Sichtschutzfolie, wenig Licht). Rueckfall: ein einzelnes Videobild.
    const fromVideoStack = async () => {
      try {
        const N = 6, first = fromVideo(), CW = first.width, CH = first.height;
        if (CW * CH > 9e6) return first;
        const acc = new Float32Array(CW * CH * 3), cnt = new Uint8Array(CW * CH);
        const SC = Math.min(1, 480 / CW), PW = Math.max(16, Math.round(CW * SC)), PH = Math.max(16, Math.round(CH * SC));
        const pc2 = document.createElement('canvas'); pc2.width = PW; pc2.height = PH; const px2 = pc2.getContext('2d', { willReadFrequently: true });
        const prof = c => {
          px2.drawImage(c, 0, 0, PW, PH); const d = px2.getImageData(0, 0, PW, PH).data, rw = new Float32Array(PH), cl = new Float32Array(PW);
          for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) { const i = (y * PW + x) * 4, v = d[i] + d[i + 1] + d[i + 2]; rw[y] += v; cl[x] += v; }
          return [rw, cl];
        };
        const best = (a, b) => { const S = Math.max(2, Math.round(a.length * 0.03)); let bs = 0, be = Infinity; for (let sh = -S; sh <= S; sh++) { let e = 0, k = 0; for (let i = Math.max(0, -sh); i < a.length && i + sh < a.length; i++) { e += Math.abs(b[i] - a[i + sh]); k++; } e /= k; if (e < be) { be = e; bs = sh; } } return bs; };
        const add = (c, dx, dy) => {
          const d = c.getContext('2d').getImageData(0, 0, CW, CH).data;
          for (let y = 0; y < CH; y++) { const sy = y + dy; if (sy < 0 || sy >= CH) continue; for (let x = 0; x < CW; x++) { const sx = x + dx; if (sx < 0 || sx >= CW) continue; const j = y * CW + x, i = (sy * CW + sx) * 4; acc[j * 3] += d[i]; acc[j * 3 + 1] += d[i + 1]; acc[j * 3 + 2] += d[i + 2]; cnt[j]++; } }
        };
        const p0 = prof(first); add(first, 0, 0);
        for (let k = 1; k < N; k++) {
          await new Promise(r => setTimeout(r, 45));
          if (done) return first;
          const c = fromVideo(); if (c.width !== CW || c.height !== CH) continue;
          const pk = prof(c), dy = Math.round(best(p0[0], pk[0]) / SC), dx = Math.round(best(p0[1], pk[1]) / SC);
          add(c, dx, dy);
        }
        const out = document.createElement('canvas'); out.width = CW; out.height = CH;
        const ox = out.getContext('2d'), od = ox.createImageData(CW, CH);
        for (let j = 0; j < CW * CH; j++) { const n = cnt[j] || 1, i = j * 4; od.data[i] = acc[j * 3] / n; od.data[i + 1] = acc[j * 3 + 1] / n; od.data[i + 2] = acc[j * 3 + 2] / n; od.data[i + 3] = 255; }
        ox.putImageData(od, 0, 0);
        try { window.__psO2CamInfo = Object.assign({}, window.__psO2CamInfo || {}, { stack: N, size: CW + 'x' + CH }); } catch (e) {}
        return out;
      } catch (e) { return fromVideo(); }
    };
    const grabStill = async () => {
      if (!ic) return null;
      const w = video.videoWidth, h = video.videoHeight, arV = w / h, GW = 128, GH = Math.max(8, Math.round(GW / arV));
      try {
        const ref = grayOf(video, 0, 0, w, h, GW, GH);
        let blob;
        try { blob = await timeout(ic.takePhoto(photoSet || undefined), 5000); }
        catch (e) { if (photoSet && !/timeout/.test(e && e.message)) { photoSet = null; blob = await timeout(ic.takePhoto(), 5000); } else throw e; }
        const bmp = await createImageBitmap(blob), pw = bmp.width, ph = bmp.height, arP = pw / ph;
        const cand = [['voll', [0, 0, pw, ph]]];
        if (Math.abs(arP - arV) > 0.02) {
          if (arP < arV) { const sh = pw / arV; cand.push(['band', [0, (ph - sh) / 2, pw, sh]]); }
          else { const sw = ph * arV; cand.push(['band', [(pw - sw) / 2, 0, sw, ph]]); }
        }
        let best = null;
        cand.forEach(cd => { const q = ncc(ref, grayOf(bmp, cd[1][0], cd[1][1], cd[1][2], cd[1][3], GW, GH)); if (!best || q > best.q) best = { n: cd[0], r: cd[1], q }; });
        let c = null;
        if (best && best.q >= 0.6) c = cropOf(bmp, pw, ph, best.r);
        try { window.__psO2CamInfo = { how: c ? 'standbild' : 'video', hyp: best && best.n, ncc: best ? +best.q.toFixed(3) : 0, still: pw + 'x' + ph, video: w + 'x' + h }; } catch (e) {}
        try { bmp.close(); } catch (e) {}
        if (c) stillFail = 0; else stillFail++;
        return c;
      } catch (e) {
        stillFail++;
        try { window.__psO2CamInfo = { how: 'video', fehler: String(e && e.message || e), video: w + 'x' + h }; } catch (e2) {}
        return null;
      } finally { if (stillFail >= 3) ic = null; }
    };
    // Ausloesen: Rahmenbereich (plus 3 % Rand) in voller Aufloesung ausschneiden
    const capture = isAuto => {
      if (done || shot || finishing || !video.videoWidth) return;
      shot = true; lastShotAt = Date.now(); moved = false; moveTicks = 0;
      // Scannen: Anteil, der mit dem vorigen Foto ueberlappt (1 - gewandert); ab hier neu messen
      const capF = scan ? (nShots ? Math.max(0, Math.min(1, 1 - travel)) : 0) : undefined;
      if (scan) { travel = 0; prevP = null; }
      flash.style.opacity = '0.85'; setTimeout(() => { flash.style.opacity = '0'; }, 80);
      const st = step, sub = prev;
      if (ic) { hint.textContent = 'Foto wird aufgenommen …'; hint.style.background = '#334155'; }
      (ic ? grabStill() : Promise.resolve(null)).then(c => c || fromVideoStack()).then(c => new Promise(r => c.toBlob(r, 'image/jpeg', 0.92)), () => null).then(b => {
        cur = '';
        if (!b || done) { shot = false; return; }
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
        const file = new File([b], 'o2-kamera.jpg', { type: 'image/jpeg', lastModified: Date.now() });
        if (!ses) { finish({ file, auto: !!isAuto }); return; }
        // Reihe: das Foto geht zum Lesen in den Dialog, die Kamera bleibt fuer den naechsten Block offen
        if (scan) { nShots++; paintTitle(); }
        const item = { l: scan ? 'Foto ' + nShots : st === 'kosten' ? 'Kostenblock' : 'Block ' + blockN, n: blockN, t: '', st: 'lade' };
        results.push(item); pend++;
        if (st === 'block' && !scan) { blockN++; paintTitle(); }
        lastSub = sub; paintChips();
        let p; try { p = Promise.resolve(o.onShot(file, scan ? 'scan' : st, capF)); } catch (e) { p = Promise.resolve(''); }
        p.then(t => { const ob = t && typeof t === 'object'; item.end = !!(ob && t.end); item.t = String((ob ? t.t : t) || ''); item.st = item.t ? 'ok' : 'leer'; }, () => { item.st = 'leer'; }).then(() => {
          pend--;
          if (item.st === 'leer' && st === 'block' && !scan && blockN - 1 === item.n) { blockN--; paintTitle(); }
          paintChips();
          if (done) return;
          if (scan && item.end) { setState('start'); hint.textContent = '✓ Kostenblock gelesen – fertig'; hint.style.background = '#15803d'; setTimeout(() => finishSession(), 700); }
          else if (st === 'kosten' && item.st === 'ok') finishSession();
          else if (finishing && !pend) finish('fertig');
        });
        setTimeout(() => { shot = false; }, 500);
      });
    };
    const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    // Reihe: erst wieder automatisch ausloesen, wenn sich das Bild deutlich geaendert hat (naechster Block im Rahmen)
    const changed = sub => {
      if (!lastSub || !sub || sub.length !== lastSub.length) return true;
      // Blockmittel (12 x 6) statt Einzelpixel: Handzittern aendert kaum etwas, ein anderer Block im Rahmen deutlich
      const GX = 48, GY = 30, bx = 4, by = 5; let d = 0, n = 0;
      for (let gy = 0; gy < GY; gy += by) for (let gx = 0; gx < GX; gx += bx) {
        let a = 0, b = 0;
        for (let y = 0; y < by; y++) for (let x = 0; x < bx; x++) { const i = (gy + y) * GX + gx + x; a += sub[i]; b += lastSub[i]; }
        d += Math.abs(a - b) / (bx * by); n++;
      }
      return d / n > 8;
    };
    // Scannen: Zeilenprofil des Rahmens (Helligkeit je Zeile) -> vertikale Verschiebung gegen das vorige Bild
    const SP = 160, SW = 48, pcv = document.createElement('canvas'); pcv.width = SW; pcv.height = SP;
    const pcx = pcv.getContext('2d', { willReadFrequently: true });
    const scanProf = () => {
      const W = video.videoWidth, H = video.videoHeight;
      pcx.drawImage(video, fr.x * W, fr.y * H, fr.w * W, fr.h * H, 0, 0, SW, SP);
      const d = pcx.getImageData(0, 0, SW, SP).data, pr = new Float32Array(SP);
      for (let r = 0; r < SP; r++) { let a = 0; for (let x = 0; x < SW; x++) { const i = (r * SW + x) * 4; a += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; } pr[r] = a / SW; }
      let m = 0; for (let r = 0; r < SP; r++) m += pr[r]; m /= SP;
      let v = 0; for (let r = 0; r < SP; r++) v += (pr[r] - m) * (pr[r] - m); v = Math.sqrt(v / SP);
      if (v < 1.5) return null; // leere Flaeche: nichts zu verfolgen
      for (let r = 0; r < SP; r++) pr[r] = (pr[r] - m) / v;
      return pr;
    };
    // > 0: Inhalt ist nach oben gewandert (weiter unten im Vorschlag)
    const scanShift = (a, b) => {
      const S = 48; let best = 0, be = Infinity, e0 = Infinity;
      for (let sh = -S; sh <= S; sh++) {
        let e = 0, n = 0;
        for (let r = Math.max(0, -sh); r < SP && r + sh < SP; r++) { e += Math.abs(b[r] - a[r + sh]); n++; }
        if (n < SP * 0.55) continue;
        e /= n; if (sh === 0) e0 = e;
        if (e < be) { be = e; best = sh; }
      }
      return e0 - be > 0.06 ? best : 0;
    };
    const scanHint = (k, txt, bg, bc) => { if (cur === k) return; cur = k; hint.textContent = txt; hint.style.background = bg; frame.style.borderColor = bc; };
    const tick = () => {
      if (done) return;
      timer = setTimeout(tick, 120);
      if (!stream || video.readyState < 2 || !video.videoWidth || shot) return;
      let m;
      try { m = psO2CamMeasure(video, fr, cv, cx, prev); } catch (e) { return; }
      prev = m.sub;
      const now = Date.now();
      hist.push({ t: now, s: m.sharp });
      while (hist.length && now - hist[0].t > 3000) hist.shift();
      const peak = hist.reduce((a, b) => Math.max(a, b.s), 0);
      const st = psO2CamState(m, peak, now - t0);
      if (scan) { const pr = scanProf(); if (pr && prevP) travel += scanShift(prevP, pr) / SP; if (pr) prevP = pr; }
      if (finishing) {}
      else if (scan && nShots && travel > C.sMax) scanHint('zurueck', 'Zu weit – ein Stück zurück ↑', '#b45309', '#f59e0b');
      else if (scan && nShots && travel < C.sGo && (st === 'ok' || st === 'shaky')) scanHint('weiter', 'Langsam weiter nach unten ↓  (oder am PC scrollen)', '#1d4ed8', '#60a5fa');
      else if (scan && !nShots && st === 'ok') scanHint('erst', 'Scharf ✓ – oben am Vorschlag anfangen', '#15803d', '#22c55e');
      else setState(st);
      if (root.getAttribute('data-dbg')) root.setAttribute('data-m', JSON.stringify({ st, s: +m.sharp.toFixed(3), v1: Math.round(m.v1), peak: +peak.toFixed(3), mean: Math.round(m.mean), sat: +m.sat.toFixed(2), mo: +m.motion.toFixed(1), step, blockN, pend }));
      if (ses) { if (m.motion > 12) moveTicks++; else if (moveTicks > 0) moveTicks--; if (moveTicks >= 3) moved = true; }
      if (st === 'ok' && !finishing) {
        if (!okSince) okSince = now;
        const go = scan ? (nShots ? travel >= C.sGo && travel <= C.sMax && now - okSince >= 250 && now - lastShotAt > 900 : now - okSince >= C.hold)
          : now - okSince >= C.hold && (!ses || (moved && now - lastShotAt > 2000 && changed(m.sub)));
        if (auto && go) capture(true);
      } else okSince = 0;
    };
    const showError = e => {
      const denied = e && /NotAllowed|Security|PermissionDenied/i.test(e.name || '');
      stage.innerHTML = '';
      const box = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;color:#fff;text-align:center;font:700 16px system-ui,sans-serif');
      box.appendChild(el('div', '', denied ? 'Kein Zugriff auf die Kamera. In den Geräte-Einstellungen für diese App erlauben' + (ses ? '.' : ', oder die normale Kamera-App nehmen.') : 'Kamera nicht verfügbar.'));
      box.appendChild(btn(ses ? 'Schließen' : 'Kamera-App öffnen', 'background:#2563eb;color:#fff;font-size:16px;padding:14px 22px', () => finish(ses ? null : 'native')));
      stage.appendChild(box); hint.textContent = ''; hint.style.background = 'transparent'; shutter.style.display = 'none'; errored = true; sideL.style.display = 'none'; sideR.style.display = 'none';
    };
    document.body.appendChild(root);
    window.addEventListener('resize', layout); document.addEventListener('keydown', onKey, true);
    video.addEventListener('loadedmetadata', () => { vw = video.videoWidth; vh = video.videoHeight; layout(); });
    video.addEventListener('resize', () => { if (video.videoWidth) { vw = video.videoWidth; vh = video.videoHeight; layout(); } });
    layout(); setState('start');
    if (o.debug) root.setAttribute('data-dbg', '1');
    (async () => {
      try {
        const md = navigator.mediaDevices;
        try { stream = await md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } }); }
        catch (e) { if (e && /NotAllowed|Security|PermissionDenied/i.test(e.name || '')) throw e; stream = await md.getUserMedia({ audio: false, video: true }); }
        if (done) { stream.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = stream;
        try { await video.play(); } catch (e) {}
        try {
          const tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
          if (cap.focusMode && cap.focusMode.indexOf('continuous') >= 0) await tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        } catch (e) {}
        try {
          if (window.ImageCapture && !o.noStill) {
            ic = new ImageCapture(stream.getVideoTracks()[0]);
            try {
              const pc = await ic.getPhotoCapabilities(), iw = pc && pc.imageWidth, ih = pc && pc.imageHeight, ps = {};
              if (iw && ih && iw.max && ih.max && video.videoWidth) {
                const ar = video.videoWidth / video.videoHeight;
                let W = Math.min(iw.max, 4000), H = Math.round(W / ar);
                if (H > ih.max) { H = ih.max; W = Math.round(H * ar); }
                ps.imageWidth = Math.max(iw.min || 1, W); ps.imageHeight = Math.max(ih.min || 1, H);
              }
              if (pc && pc.fillLightMode && pc.fillLightMode.indexOf && pc.fillLightMode.indexOf('off') >= 0) ps.fillLightMode = 'off';
              photoSet = Object.keys(ps).length ? ps : null;
            } catch (e) {}
          }
        } catch (e) { ic = null; }
        if (video.videoWidth) { vw = video.videoWidth; vh = video.videoHeight; layout(); }
        tick();
      } catch (e) { if (!done) showError(e); }
    })();
  });
}
