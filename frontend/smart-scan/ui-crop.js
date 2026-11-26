/*
 * Smart Scan – ui-crop.js
 * Oberfläche: Zuschneiden/Entzerren-Dialog (nur Darstellung und Bedienung).
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// Zuschneiden/Entzerren nach dem Foto (wie beim Scannen): Ecken einzeln ziehen, Kanten verschieben je zwei Ecken, Mitte verschiebt alles.
function PsO2Crop({ file, onOk, onSkip, onCancel, onRetake, hint }) {
  const h = React.createElement;
  const [src, setSrc] = React.useState('');
  const [q, setQ] = React.useState(() => psO2QuadLoad());
  const baseRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const dragRef = React.useRef(null);
  React.useEffect(() => {
    let dead = false, url = '';
    (async () => {
      try {
        const bmp = await createImageBitmap(file);
        const sc = Math.min(1, 4000 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        baseRef.current = c;
        const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
        if (dead) return;
        url = URL.createObjectURL(blob); setSrc(url);
      } catch (e) { if (!dead) onSkip(); }
    })();
    return () => { dead = true; if (url) { try { URL.revokeObjectURL(url); } catch (e) {} } };
  }, [file]);
  const down = (mode, e) => {
    e.preventDefault(); e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) {}
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, q: q.map(p => p.slice()) };
  };
  const move = e => {
    const dr = dragRef.current, w = wrapRef.current;
    if (!dr || !w) return;
    const r = w.getBoundingClientRect();
    const dx = (e.clientX - dr.sx) / r.width, dy = (e.clientY - dr.sy) / r.height, m = dr.mode, o = dr.q;
    const cl = v => Math.max(0, Math.min(1, v));
    const shift = idx => {
      const xs = idx.map(i => o[i][0]), ys = idx.map(i => o[i][1]);
      const ddx = Math.max(-Math.min.apply(null, xs), Math.min(1 - Math.max.apply(null, xs), dx)), ddy = Math.max(-Math.min.apply(null, ys), Math.min(1 - Math.max.apply(null, ys), dy));
      return o.map((p, i) => idx.indexOf(i) >= 0 ? [p[0] + ddx, p[1] + ddy] : p.slice());
    };
    let n;
    if (m === 'move') n = shift([0, 1, 2, 3]);
    else if (m[0] === 'p') { const i = +m[1]; n = o.map((p, k) => k === i ? [cl(p[0] + dx), cl(p[1] + dy)] : p.slice()); }
    else { const i = +m[1]; n = shift([i, (i + 1) % 4]); }
    setQ(n);
  };
  const up = () => { dragRef.current = null; };
  const go = whole => {
    const c = baseRef.current;
    if (!c) return;
    let q2 = whole ? [[0, 0], [1, 0], [1, 1], [0, 1]] : q;
    if (!whole) {
      if (!psO2Convex(q2)) { const xs = q2.map(p => p[0]), ys = q2.map(p => p[1]), a = Math.min.apply(null, xs), b = Math.max.apply(null, xs), c0 = Math.min.apply(null, ys), d = Math.max.apply(null, ys); q2 = [[a, c0], [b, c0], [b, d], [a, d]]; }
      psO2QuadSave(q2);
    }
    onOk((async () => {
      const o = psO2Warp(c, q2);
      const blob = await new Promise(r => o.toBlob(r, 'image/jpeg', 0.95));
      return new File([blob], (file && file.name) || 'ausschnitt.jpg', { type: 'image/jpeg' });
    })());
  };
  const pct = v => (v * 100) + '%';
  const HS = 44;
  const hnd = (mode, x, y, inner) => h('div', { key: mode, 'data-crop': mode, onPointerDown: e => down(mode, e), onPointerMove: move, onPointerUp: up, onPointerCancel: up,
    style: { position: 'absolute', left: pct(x), top: pct(y), width: HS, height: HS, marginLeft: -HS / 2, marginTop: -HS / 2, touchAction: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3 } }, inner);
  const dot = h('div', { style: { width: 22, height: 22, borderRadius: 11, background: '#fff', border: '3px solid #0ea5e9', boxShadow: '0 1px 4px rgba(0,0,0,.5)' } });
  const sq = h('div', { style: { width: 16, height: 16, borderRadius: 4, background: '#fff', border: '3px solid #0ea5e9', boxShadow: '0 1px 4px rgba(0,0,0,.5)' } });
  const pts = q.map(p => (p[0] * 100) + ',' + (p[1] * 100)).join(' ');
  const bs = (pri, dis) => ({ padding: '12px 16px', borderRadius: 10, fontWeight: 900, fontSize: 14, cursor: 'pointer', opacity: dis ? 0.5 : 1, color: pri ? '#fff' : '#e2e8f0', background: pri ? '#2563eb' : 'transparent', border: pri ? '1px solid #2563eb' : '1px solid #64748b' });
  return h('div', { style: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100003, background: '#0b1220', display: 'flex', flexDirection: 'column', userSelect: 'none', WebkitUserSelect: 'none' } },
    h('div', { style: { color: '#e2e8f0', fontWeight: 700, fontSize: 14, padding: '12px 16px 4px', textAlign: 'center' } }, hint || 'Bereich einrahmen – Ecken einzeln ziehen (schräg ist ok, wird geradegerichtet)'),
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14 } },
      src ? h('div', { ref: wrapRef, style: { position: 'relative', lineHeight: 0, touchAction: 'none' } },
        h('img', { src, draggable: false, alt: '', style: { display: 'block', maxWidth: 'calc(100vw - 28px)', maxHeight: 'calc(100dvh - 190px)', width: 'auto', height: 'auto' } }),
        h('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', style: { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 2, touchAction: 'none', overflow: 'visible' } },
          h('path', { d: 'M0,0 H100 V100 H0 Z M' + pts.replace(/ /g, ' L') + ' Z', fillRule: 'evenodd', fill: 'rgba(2,6,23,.62)', style: { pointerEvents: 'none' } }),
          h('polygon', { 'data-crop': 'move', points: pts, fill: 'rgba(255,255,255,0.01)', stroke: '#38bdf8', strokeWidth: 2, vectorEffect: 'non-scaling-stroke', onPointerDown: e => down('move', e), onPointerMove: move, onPointerUp: up, onPointerCancel: up, style: { pointerEvents: 'all', cursor: 'move', touchAction: 'none' } })),
        [0, 1, 2, 3].map(i => hnd('e' + i, (q[i][0] + q[(i + 1) % 4][0]) / 2, (q[i][1] + q[(i + 1) % 4][1]) / 2, sq)),
        [0, 1, 2, 3].map(i => hnd('p' + i, q[i][0], q[i][1], dot)))
        : h('div', { style: { color: '#94a3b8', fontWeight: 700 } }, 'Foto wird geladen …')),
    h('div', { style: { display: 'flex', gap: 8, padding: '6px 12px 14px', justifyContent: 'center', flexWrap: 'wrap' } },
      h('button', { onClick: onCancel, style: bs(false, false) }, 'Abbrechen'),
      h('button', { onClick: onRetake, style: bs(false, false) }, '↻ Neu'),
      h('button', { onClick: () => go(true), disabled: !src, style: bs(false, !src) }, 'Ganzes Bild'),
      h('button', { onClick: () => go(false), disabled: !src, style: bs(true, !src) }, 'Zuschneiden & lesen')));
}
