/*
 * Smart Scan – transfer.js
 * Datenübernahme: erkanntes Angebot → Angebotskarte (HTML/Text), Aktionskarten-Zuordnung.
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
const psO2Esc = s => String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// Digitale Angebotskarte (HTML, scharf im PDF) aus den gepruefen Werten
// Verteilung auf die drei Angebotskarten: Karte 1 = Tarif 1 + Handy 1, Karte 2 = Tarif 2 + Handy 2 und alle weiteren, Karte 3 = Internet.
// Liefert je Karte das HTML (oder null, wenn nichts drauf soll). Der Hinweis kommt auf die letzte belegte Karte.
// v55.216: Aktionskarte – als Aktionstarif markierte Tarife erscheinen nicht als eigener Tarif, sondern bei Tarif 1
// (Tarif 1) als Zeile "inkl. Aktionskarte 15 GB" (nur das Datenvolumen). Preise zaehlen weiter (Kostenblock unveraendert).
function psO2AkGb(t) {
  const ls = String(t.det || '').split('\n'), l = ls.find(x => /Datenvolumen/i.test(x) && /\d\s*GB/i.test(x)) || ls.find(x => /\d\s*GB/i.test(x)) || '';
  const m = /(\d+(?:[.,]\d+)?)\s*GB/i.exec(l) || /(\d+(?:[.,]\d+)?)\s*GB/i.exec(t.name || '');
  return m ? m[1] + ' GB' : '';
}
function psO2AkMerge(tarAll, gerAll) {
  const main = [];
  tarAll.forEach((t, i) => { if (!t.ak) main.push(i); });
  if (!main.length || main.length === tarAll.length) return { tar: tarAll, ger: gerAll };
  const extra = {};
  tarAll.forEach(t => { if (t.ak) (extra[main[0]] = extra[main[0]] || []).push(t); }); // alle Aktionskarten zum Tarif 1 (Haupttarif)
  const line = list => {
    const by = {}; list.forEach(t => { const g = psO2AkGb(t) || t.name; by[g] = (by[g] || 0) + 1; });
    return Object.keys(by).map(g => by[g] > 1 ? 'inkl. ' + by[g] + ' Aktionskarten (je ' + g + ')' : 'inkl. Aktionskarte ' + g).join('\n');
  };
  const tar = main.map(i => extra[i] ? { ...tarAll[i], det: [String(tarAll[i].det || '').trim(), line(extra[i])].filter(Boolean).join('\n') } : tarAll[i]);
  const ger = gerAll.map(g => typeof g.t === 'number' ? { ...g, t: tarAll.slice(0, g.t).filter(x => !x.ak).length } : g);
  return { tar, ger };
}
function psO2Cards(d) {
  const am0 = psO2AkMerge((d.tarife || []).filter(t => t && t.name), (d.geraete || []).filter(g => g && g.name));
  const tar = am0.tar, ger = am0.ger, net = (d.internet || []).filter(t => t && t.name);
  const tot = { tTot: tar.length, gTot: ger.length, nTot: net.length };
  // Mit Zuordnung (aus dem PDF: Handy steht unter seinem Tarif) landet das Handy bei "seinem" Tarif, sonst der Reihe nach.
  const paired = ger.length > 0 && ger.every(g => typeof g.t === 'number');
  const g1 = paired ? ger.filter(g => g.t <= 1) : ger.slice(0, 1), g2 = paired ? ger.filter(g => g.t > 1) : ger.slice(1);
  const parts = [
    { tarife: tar.slice(0, 1), geraete: g1, internet: [], ctx: { ...tot, tOff: 0, gOff: 0, nOff: 0 } },
    { tarife: tar.slice(1), geraete: g2, internet: [], ctx: { ...tot, tOff: 1, gOff: g1.length, nOff: 0 } },
    { tarife: [], geraete: [], internet: net, ctx: { ...tot, tOff: 0, gOff: 0, nOff: 0 } }
  ];
  const has = p => p.tarife.length || p.geraete.length || p.internet.length;
  let last = -1;
  parts.forEach((p, i) => { if (has(p)) last = i; });
  return parts.map((p, i) => has(p) ? psO2Html({ internet: p.internet, tarife: p.tarife, geraete: p.geraete, hinweis: i === last ? d.hinweis : '' }, p.ctx) : null);
}
// v55.217: Standardfall (genau 1 Handy + 1 Tarif, kein Internet auf dieser Karte) bekommt die attraktive
// Kachel-Ansicht: Ueberschrift, Kennzahl-Kacheln (Speicherplatz / Datenvolumen / Aktionskarte), zwei Spalten
// HANDY/TARIF mit Haekchen. Komplexere Karten (mehrere Tarife/Handys, Internet) bleiben bei der Listenansicht.
function psO2HtmlSimple(g, t, hinweis) {
  const E = x => psO2Esc(String(x == null ? '' : x).replace(/\bO2\b/g, 'O₂'));
  const detLines = x => String((x && x.det) || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const gLines = detLines(g), tLinesAll = detLines(t);
  const akRe = /^inkl\.\s/i;
  const akLines = tLinesAll.filter(x => akRe.test(x));
  const tLines = tLinesAll.filter(x => !akRe.test(x));
  const storM = gLines.map(x => /(\d+(?:[.,]\d+)?)\s*(GB|TB)\b/i.exec(x)).find(Boolean);
  const stor = storM ? storM[1].replace('.', ',') + ' ' + storM[2].toUpperCase() : '';
  const dvLine = tLines.find(x => /Datenvolumen/i.test(x)) || tLines.find(x => /\bGB\b/i.test(x)) || '';
  const dvUnl = /unbegrenzt|unlimited/i.test(dvLine) || /unbegrenzt|unlimited/i.test(t.name || '');
  const dvM = /(\d+(?:[.,]\d+)?)\s*GB/i.exec(dvLine);
  const dv = dvUnl ? 'Unbegrenzt' : (dvM ? dvM[1].replace('.', ',') + ' GB' : '');
  const akM = akLines.length ? /(\d+(?:[.,]\d+)?\s*GB)/i.exec(akLines[0]) : null;
  const akGb = akM ? akM[1] : '';
  const ICONS = {
    phone: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"></rect><line x1="11" y1="18" x2="13" y2="18"></line></svg>',
    wifi: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5a10 10 0 0 1 14 0"></path><path d="M8.5 16a5 5 0 0 1 7 0"></path><circle cx="12" cy="19.5" r="1"></circle></svg>',
    bonus: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"></rect><rect x="9" y="11" width="6" height="6" rx="1"></rect></svg>'
  };
  const tiles = [];
  if (stor) tiles.push({ icon: 'phone', val: stor, lbl: 'Speicherplatz' });
  if (dv) tiles.push({ icon: 'wifi', val: dv, lbl: 'Datenvolumen' });
  if (akGb) tiles.push({ icon: 'bonus', val: '+ ' + akGb, lbl: 'Aktionskarte inklusive', ak: true });
  const tileHtml = tiles.map(x => '<div style="flex:1;min-width:110px;border:1px solid ' + (x.ak ? '#fde68a' : '#e2e8f0') + ';background:' + (x.ak ? '#fffbeb' : '#fff') + ';border-radius:14px;padding:14px 16px;box-sizing:border-box">' +
    '<div style="color:' + (x.ak ? '#d97706' : '#1d4ed8') + '">' + ICONS[x.icon] + '</div>' +
    '<div style="font-size:21px;font-weight:900;margin-top:6px">' + E(x.val) + '</div>' +
    '<div style="font-size:11px;font-weight:600;color:' + (x.ak ? '#92400e' : '#475569') + ';margin-top:1px">' + E(x.lbl) + '</div></div>').join('');
  const bullets = arr => arr.map((x, i) => '<div style="display:flex;gap:7px;align-items:flex-start;font-size:13px;font-weight:500;margin-top:' + (i ? 7 : 9) + 'px;line-height:1.3"><span style="flex:0 0 auto;font-weight:900;color:' + (akRe.test(x) ? '#d97706' : '#1d4ed8') + '">✓</span><span>' + E(x) + '</span></div>').join('');
  const headline = E(g.name) + ' <span style="color:#94a3b8;font-weight:800"> + </span>' + E(t.name);
  return '<div style="width:100%;box-sizing:border-box"><div style="font-family:Inter,\'Segoe UI\',system-ui,sans-serif;padding:16px 22px 14px;background:#fff;box-sizing:border-box">' +
    '<div style="font-size:19px;font-weight:900;line-height:1.25;margin-bottom:13px">' + headline + '</div>' +
    (tileHtml ? '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:15px">' + tileHtml + '</div>' : '') +
    '<div style="display:flex;gap:24px;flex-wrap:wrap">' +
      '<div style="flex:1 1 200px;min-width:0"><span style="display:inline-block;background:#dbeafe;border-radius:8px;padding:3px 10px;font-size:11px;font-weight:800;letter-spacing:.08em">HANDY</span>' + bullets(gLines) + '</div>' +
      '<div style="flex:1 1 200px;min-width:0"><span style="display:inline-block;background:#dbeafe;border-radius:8px;padding:3px 10px;font-size:11px;font-weight:800;letter-spacing:.08em">TARIF</span>' + bullets(tLines.concat(akLines)) + '</div>' +
    '</div>' +
    (hinweis ? '<div style="font-size:14px;font-weight:600;margin-top:14px">' + E(hinweis) + '</div>' : '') +
  '</div></div>';
}
function psO2Html(d, ctx) {
  // Bis zu 6 Tarife, 6 Handys, 2 Internet. Bis 3 Positionen: Spalten nebeneinander (Internet | Tarif | Smartphone).
  // Ab 4: nach Art gruppiert (Tarife, Handys, Internet), je Zeile gleich breite Spalten, Schrift etwas kleiner.
  // Hinweis: die App-CSS zwingt im Angebotsfeld alle Textfarben auf eine Farbe, deshalb Hervorhebung ueber Groesse/Fett/Hintergrund.
  const net = (d.internet || []).filter(t => t.name), tar = (d.tarife || []).filter(t => t.name), ger = (d.geraete || []).filter(g => g.name);
  const cx = ctx || {};
  if (ger.length === 1 && tar.length === 1 && !net.length) return psO2HtmlSimple(ger[0], tar[0], d.hinweis);
  // Gleiche Eintraege hintereinander (z. B. 3x Mobile S) werden EINE Spalte: "TARIF 2–4 · 3×"
  const group = (lbl, arr, off, tot) => {
    const T = tot == null ? arr.length : tot, o = off || 0, res = [];
    const key = x => [x.name, x.art || '', x.det || ''].join('\u0001');
    for (let i = 0; i < arr.length;) {
      let j = i;
      while (j + 1 < arr.length && key(arr[j + 1]) === key(arr[i])) j++;
      const c = j - i + 1;
      res.push({ it: arr[i], label: lbl + (T > 1 ? ' ' + (c > 1 ? (o + i + 1) + '–' + (o + j + 1) : (o + i + 1)) : '') + (c > 1 ? ' · ' + c + '×' : '') });
      i = j + 1;
    }
    return res;
  };
  const gNet = group('INTERNET@HOME', net, cx.nOff, cx.nTot), gTar = group('TARIF', tar, cx.tOff, cx.tTot), gGer = group('HANDY', ger, cx.gOff, cx.gTot);
  const n = gNet.length + gTar.length + gGer.length, dense = n > 3, mid = n > 8;
  const fN = mid ? 17 : dense ? 19 : 22, fD = mid ? 13 : dense ? 14 : 16, fA = mid ? 12 : dense ? 13 : 14, gap = mid ? 5 : 7;
  const col = (g, grid) => {
    const lbl = g.label, it = g.it;
    const E = x => psO2Esc(String(x == null ? '' : x).replace(/\bO2\b/g, 'O₂'));
    const det = String(it.det || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    return '<div style="' + (grid ? '' : 'flex:1 1 260px;') + 'min-width:0;box-sizing:border-box">' +
      '<span style="display:inline-block;background:#dbeafe;border-radius:8px;padding:3px 10px;font-size:12px;font-weight:800;letter-spacing:.08em">' + lbl + '</span>' +
      '<div style="font-size:' + fN + 'px;font-weight:800;margin-top:8px;line-height:1.25">' + E(it.name) + '</div>' +
      (it.art ? '<div style="font-size:' + fA + 'px;font-weight:600;margin-top:2px">' + E(it.art) + '</div>' : '') +
      det.map(x => '<div style="display:flex;gap:8px;font-size:' + fD + 'px;font-weight:500;margin-top:' + gap + 'px;line-height:1.3"><span style="flex:0 0 auto;font-weight:900">✓</span><span>' + E(x) + '</span></div>').join('') + '</div>';
  };
  let body;
  if (!dense) {
    body = '<div style="display:flex;flex-wrap:wrap;gap:16px 28px">' + gNet.concat(gTar, gGer).map(g => col(g, false)).join('') + '</div>';
  } else {
    const per = c => c <= 3 ? c : c === 4 ? 2 : 3;
    // Spaltenzahl richtet sich nach der Kartenbreite: hoechstens per(n), auf schmalen Karten weniger (mind. 160 px je Spalte)
    body = [gNet, gTar, gGer].filter(g => g.length).map((g, k) =>
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(max(160px,calc((100% - ' + (per(g.length) - 1) * 24 + 'px)/' + per(g.length) + ')),1fr));gap:14px 24px;' + (k ? 'margin-top:16px;padding-top:14px;border-top:1px solid #e2e8f0' : '') + '">' + g.map(x => col(x, true)).join('') + '</div>').join('');
  }
  return '<div style="width:100%;box-sizing:border-box"><div style="font-family:Inter,\'Segoe UI\',system-ui,sans-serif;padding:16px 22px 14px;background:#fff;box-sizing:border-box">' + body +
    (d.hinweis ? '<div style="font-size:14px;font-weight:600;margin-top:14px">' + psO2Esc(d.hinweis) + '</div>' : '') + '</div></div>';
}
