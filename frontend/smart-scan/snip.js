/*
 * Smart Scan – snip.js
 * Bildschirm-Ausschnitt am PC (getDisplayMedia).
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// === v55.203 (Beta): BILDSCHIRM-SNIP (PC) ================================================================
// Am PC den Activate+ Bildschirm (Fenster der Windows App) freigeben, Rahmen ueber einen Block ziehen -> Ausschnitt in voller
// Aufloesung geht sofort zum Lesen (pixelscharf, keine Foto-Unschaerfe). Tablets/Handys koennen keine Bildschirmfreigabe.
// opts.onShot(file, art) -> Promise<kurzer Text, leer = nichts erkannt>; art = 'block' (Rahmen) | 'snip' (ganzer Bildschirm).
// Ergebnis: 'fertig' | 'geschwaerzt' (Schutz zeigt nur Schwarz) | 'leer' (Auto-Lauf: nichts erkannt) | null (abgebrochen).
function psO2SnipSupported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia); }
// v55.206: die Freigabe bleibt offen, bis der Browser sie beendet oder "Bildschirmfreigabe beenden" gedrueckt wird -> kein erneutes Auswaehlen
function psO2SnipLive() { const s = window.__psO2SnipStream; return !!(s && s.getVideoTracks().some(t => t.readyState === 'live')); }
function psO2SnipStop() { try { const s = window.__psO2SnipStream; if (s) s.getTracks().forEach(t => t.stop()); } catch (e) {} window.__psO2SnipStream = null; }
function psO2SnipOpen(opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let stream = null;
    if (psO2SnipLive()) { go(window.__psO2SnipStream, true); return; }
    try {
      // direkt im Klick aufrufen (Browser verlangt eine Nutzeraktion). Liste: Reiter "Fenster" vorgewaehlt (das Edge der Windows App ist
      // ein eigenes Fenster), kein "Gesamter Bildschirm". Nach "Teilen" springt der Browser NICHT zum geteilten Fenster (Pencil Selling bleibt vorn).
      let ctl = null; try { if (window.CaptureController) ctl = new CaptureController(); } catch (e) { ctl = null; }
      const cons = { video: { frameRate: 5, displaySurface: 'window' }, audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' };
      if (ctl) cons.controller = ctl;
      navigator.mediaDevices.getDisplayMedia(cons).then(st => {
        try { if (ctl) ctl.setFocusBehavior('no-focus-change'); } catch (e) {}
        window.__psO2SnipStream = st;
        try { st.getVideoTracks()[0].addEventListener('ended', () => { if (window.__psO2SnipStream === st) window.__psO2SnipStream = null; }); } catch (e) {}
        go(st, false);
      }, () => resolve(null));
    } catch (e) { resolve(null); return; }
    function go(st, reused) {
      stream = st;
      let done = false, finishing = false, pend = 0, drag = null, blockN = 1, tries = 0, btries = 0, autoStarted = false;
      const results = [];
      const el = (tag, css, txt) => { const n = document.createElement(tag); if (css) n.setAttribute('style', css); if (txt != null) n.textContent = txt; return n; };
      const btn = (txt, css, fn, label) => { const b = el('button', 'font:700 14px system-ui,sans-serif;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;' + css, txt); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.onclick = fn; return b; };
      const root = el('div', 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:100020;background:#0b1220;display:flex;flex-direction:column;-webkit-user-select:none;user-select:none');
      root.setAttribute('data-ps-snip', '1');
      const bar = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;color:#fff;font:800 16px system-ui,sans-serif');
      const title = el('div', 'flex:1;text-align:center', 'Bildschirm snippen');
      bar.appendChild(btn('✕', 'background:#1e293b;color:#fff;padding:8px 12px', () => finish(null), 'Abbrechen'));
      bar.appendChild(title);
      bar.appendChild(btn('Ganzer Bildschirm', 'background:#1e293b;color:#fff;padding:8px 12px', () => snip(null, 'snip'), 'Ganzen Bildschirm lesen'));
      const hintRow = el('div', 'display:flex;justify-content:center;padding:0 12px 8px');
      const hint = el('div', 'color:#fff;font:800 15px system-ui,sans-serif;padding:8px 16px;border-radius:999px;text-align:center;max-width:94%;background:#334155', o.auto ? 'Vorschlag wird gelesen …' : 'Rahmen über einen Block ziehen – wird sofort gelesen');
      hintRow.appendChild(hint);
      const stage = el('div', 'position:relative;flex:1;overflow:hidden;min-height:0;cursor:crosshair;touch-action:none');
      const video = el('video', 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;background:#000');
      video.muted = true; video.autoplay = true; video.setAttribute('playsinline', '');
      const sel = el('div', 'position:absolute;display:none;border:3px solid #22c55e;background:rgba(34,197,94,.18);border-radius:6px;pointer-events:none');
      const flash = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .25s');
      stage.appendChild(video); stage.appendChild(sel); stage.appendChild(flash);
      const chips = el('div', 'display:flex;flex-wrap:wrap;justify-content:center;gap:6px;padding:8px 12px 0;min-height:8px');
      const paintChips = () => {
        chips.textContent = '';
        results.slice(-5).forEach(r => {
          const bg = r.st === 'ok' ? '#15803d' : r.st === 'leer' ? '#b91c1c' : '#334155';
          chips.appendChild(el('div', 'color:#fff;font:700 13px system-ui,sans-serif;padding:5px 10px;border-radius:999px;background:' + bg, r.st === 'ok' ? '✓ ' + r.l + ': ' + r.t : r.st === 'leer' ? '✗ ' + r.l + ': nichts erkannt – nochmal ziehen' : '… ' + r.l + ' wird gelesen'));
        });
      };
      const bottom = el('div', 'display:flex;align-items:center;justify-content:center;padding:12px 16px;gap:8px');
      bottom.appendChild(btn('Fertig', 'background:#2563eb;color:#fff;min-width:140px;font-size:16px;padding:12px 22px', () => finishSession(), 'Fertig'));
      root.appendChild(bar); root.appendChild(hintRow); root.appendChild(stage); root.appendChild(chips); root.appendChild(bottom);

      const finish = res => {
        if (done) return; done = true;
        document.removeEventListener('keydown', onKey, true);
        try { video.srcObject = null; } catch (e) {}
        if (root.parentNode) root.parentNode.removeChild(root);
        resolve(res);
      };
      const finishSession = () => {
        finishing = true;
        if (!pend) { finish('fertig'); return; }
        hint.textContent = 'Wird gelesen …';
      };
      const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
      // Sichtbarer Bildbereich im Element (object-fit: contain) -> Skalierung und Versatz
      const geo = () => {
        const W = video.videoWidth, H = video.videoHeight, r = stage.getBoundingClientRect();
        if (!W || !H) return null;
        const k = Math.min(r.width / W, r.height / H), dw = W * k, dh = H * k;
        return { W, H, k, dx: (r.width - dw) / 2, dy: (r.height - dh) / 2, dw, dh, rect: r };
      };
      const snip = (box, art) => {
        if (done || finishing) return;
        const g = geo(); if (!g) return;
        let sx = 0, sy = 0, sw = g.W, sh = g.H;
        if (box) {
          sx = Math.max(0, (box.l - g.dx) / g.k); sy = Math.max(0, (box.t - g.dy) / g.k);
          sw = Math.min(g.W - sx, box.w / g.k); sh = Math.min(g.H - sy, box.h / g.k);
        }
        if (sw < 24 || sh < 12) return;
        const c = document.createElement('canvas'), q = Math.min(1, 4096 / Math.max(sw, sh));
        c.width = Math.round(sw * q); c.height = Math.round(sh * q);
        c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
        flash.style.opacity = '0.6'; setTimeout(() => { flash.style.opacity = '0'; }, 80);
        c.toBlob(b => {
          if (!b || done) return;
          const file = new File([b], 'o2-snip.png', { type: 'image/png', lastModified: Date.now() });
          const item = { l: art === 'snip' ? 'Bildschirm' : 'Block ' + blockN, n: blockN, t: '', st: 'lade' };
          results.push(item); pend++;
          if (art !== 'snip') blockN++;
          paintChips();
          let p; try { p = Promise.resolve(o.onShot(file, art)); } catch (e) { p = Promise.resolve(''); }
          p.then(t => { item.t = String(t || ''); item.st = item.t ? 'ok' : 'leer'; }, () => { item.st = 'leer'; }).then(() => {
            pend--;
            if (item.st === 'leer' && art !== 'snip' && blockN - 1 === item.n) blockN--;
            paintChips();
            if (done) return;
            // automatisch gelesen und etwas erkannt: Fenster schliesst sich von selbst
            if (o.auto && art === 'snip' && item.st === 'ok') finishing = true;
            else if (o.auto && art === 'snip' && item.st === 'leer' && !finishing) { finish('leer'); return; }
            else if (item.st === 'leer' && !finishing) hint.textContent = 'Nichts erkannt – Rahmen über den Block ziehen oder „Ganzer Bildschirm“';
            if (finishing && !pend) finish('fertig');
          });
        }, 'image/png');
      };
      // Rahmen ziehen: loslassen = lesen
      stage.addEventListener('pointerdown', e => {
        const g = geo(); if (!g || finishing) return;
        const r = g.rect;
        drag = { x: Math.min(Math.max(e.clientX - r.left, g.dx), g.dx + g.dw), y: Math.min(Math.max(e.clientY - r.top, g.dy), g.dy + g.dh) };
        sel.style.display = 'block'; sel.style.left = drag.x + 'px'; sel.style.top = drag.y + 'px'; sel.style.width = '0px'; sel.style.height = '0px';
        try { stage.setPointerCapture(e.pointerId); } catch (er) {}
      });
      const boxOf = e => {
        const g = geo(), r = g.rect;
        const x = Math.min(Math.max(e.clientX - r.left, g.dx), g.dx + g.dw), y = Math.min(Math.max(e.clientY - r.top, g.dy), g.dy + g.dh);
        return { l: Math.min(x, drag.x), t: Math.min(y, drag.y), w: Math.abs(x - drag.x), h: Math.abs(y - drag.y) };
      };
      stage.addEventListener('pointermove', e => {
        if (!drag || !geo()) return;
        const b = boxOf(e); sel.style.left = b.l + 'px'; sel.style.top = b.t + 'px'; sel.style.width = b.w + 'px'; sel.style.height = b.h + 'px';
      });
      stage.addEventListener('pointerup', e => {
        if (!drag || !geo()) { drag = null; return; }
        const b = boxOf(e); drag = null; sel.style.display = 'none';
        snip(b, 'block');
      });
      // Zeigt das Bild nur Schwarz (Schutz gegen Bildschirmaufnahmen in der Umgebung), ist das Snippen sinnlos -> klare Meldung
      const blocked = () => {
        if (!video.videoWidth) return false;
        const W = 160, H = Math.max(8, Math.round(W * video.videoHeight / video.videoWidth)), c = document.createElement('canvas'); c.width = W; c.height = H;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(video, 0, 0, W, H);
        const d = x.getImageData(0, 0, W, H).data, n = W * H; let s = 0, s2 = 0;
        for (let i = 0, p = 0; i < n; i++, p += 4) { const v = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; s += v; s2 += v * v; }
        const m = s / n, sd = Math.sqrt(Math.max(0, s2 / n - m * m));
        return sd < 5 || m < 12;
      };
      const check = () => {
        if (done) return;
        if (!video.videoWidth) { if (++tries < 12) setTimeout(check, 250); return; }
        if (blocked()) {
          if (++btries < 5) { setTimeout(check, 700); return; }
          stage.innerHTML = '';
          const box = el('div', 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;color:#fff;text-align:center;font:700 16px system-ui,sans-serif');
          box.appendChild(el('div', '', 'Der Bildschirm kommt nur schwarz an – die Umgebung blockiert Aufnahmen. Bitte Block-Fotos mit der Kamera nehmen.'));
          box.appendChild(btn('Schließen', 'background:#2563eb;color:#fff;font-size:16px;padding:14px 22px', () => finish('geschwaerzt')));
          stage.appendChild(box); hint.textContent = ''; hint.style.background = 'transparent';
          return;
        }
        // Bild ist da und nicht schwarz: ganzen Bildschirm gleich lesen (ohne weiteren Klick)
        if (o.auto && !autoStarted) { autoStarted = true; setTimeout(() => snip(null, 'snip'), 350); }
      };
      document.body.appendChild(root);
      document.addEventListener('keydown', onKey, true);
      st.getVideoTracks()[0].addEventListener('ended', () => { if (!done) { if (pend) finishSession(); else finish(results.length ? 'fertig' : null); } });
      video.srcObject = st;
      video.play().catch(() => {});
      setTimeout(check, reused ? 200 : 600);
    }
  });
}
