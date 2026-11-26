/*
 * Smart Scan – ui-dialog.js
 * Oberfläche: Smart-Scan-Dialog (Kompakt-/Vollansicht, Produktkarten, Summenkarten, SIM-/Aktionskarten-Knopf, Mehrseiten, manuelle Korrektur).
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// Obergrenzen je Foto-Etappe (mehr passt nicht sinnvoll auf die Angebotskarte)
const PS_O2_MAX = { tarife: 6, geraete: 6, internet: 2 };
// v56.0-beta.3: Kompaktansicht (Hochformat) fuer das Ergebnis – Linien-Symbole und Kartentext (nur Anzeige, die Daten bleiben unveraendert)
const PS_O2_ICO = {
  scan: ['M3 7V5a2 2 0 0 1 2-2h2', 'M17 3h2a2 2 0 0 1 2 2v2', 'M21 17v2a2 2 0 0 1-2 2h-2', 'M7 21H5a2 2 0 0 1-2-2v-2', 'M7 12h10'],
  phone: ['M9.5 2h5A2.5 2.5 0 0 1 17 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-5A2.5 2.5 0 0 1 7 19.5v-15A2.5 2.5 0 0 1 9.5 2z', 'M12 18h.01'],
  signal: ['M2 20h.01', 'M7 20v-4', 'M12 20v-8', 'M17 20V8', 'M22 4v16'],
  wifi: ['M5 12.55a11 11 0 0 1 14.08 0', 'M1.42 9a16 16 0 0 1 21.16 0', 'M8.53 16.11a6 6 0 0 1 6.95 0', 'M12 20h.01'],
  camera: ['M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z', [12, 13, 3]],
  upload: ['M16 5h6', 'M19 2v6', 'M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5', 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21', [9, 9, 2]],
  check: ['M20 6 9 17l-5-5'],
  checkc: [[12, 12, 10], 'm9 12 2 2 4-4'],
  alert: [[12, 12, 10], 'M12 8v4', 'M12 16h.01'],
  chev: ['m6 9 6 6 6-6'],
  pencil: ['M12 20h9', 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z'],
  shield: ['M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z', 'm9 12 2 2 4-4'],
  x: ['M18 6 6 18', 'm6 6 12 12'],
  sim: ['M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M9 13h6v5H9z', 'M12 13v5', 'M9 15.5h6']
};
function psO2Ico(n, sz) {
  const h = React.createElement;
  return h('svg', { viewBox: '0 0 24 24', width: sz || 20, height: sz || 20, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', style: { flex: 'none' } },
    (PS_O2_ICO[n] || []).map((p, i) => typeof p === 'string' ? h('path', { key: i, d: p }) : h('circle', { key: i, cx: p[0], cy: p[1], r: p[2] })));
}
// Titel und Untertitel einer Produktkarte: Handy "Name, Farbe" -> Titel + Farbe; Tarif -> Datenvolumen + Rabatt; Internet -> Art + Inhalte
function psO2CardText(key, it) {
  const det = String(it.det || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean), nm = String(it.name || '').trim(), out = [];
  let title = nm || (key === 'geraete' ? 'Handy' : key === 'tarife' ? 'Tarif' : 'Internet@Home');
  if (key === 'geraete' && nm.indexOf(',') > 0) { title = nm.slice(0, nm.indexOf(',')).trim(); out.push(nm.slice(nm.indexOf(',') + 1).trim()); }
  if (it.art) out.push(it.art);
  if (key === 'tarife') { const g = det.map(x => /(\d+(?:[.,]\d+)?)\s*GB/i.exec(x)).find(Boolean); if (g) out.push(g[1] + ' GB'); }
  else det.slice(0, 2).forEach(x => out.push(x));
  if (it.rb && it.rb.m) out.push(psO2Fmt(Math.abs(it.rb.m)) + ' € monatlicher Rabatt');
  if (it.rb && it.rb.e) out.push(psO2Fmt(Math.abs(it.rb.e)) + ' € einmaliger Rabatt');
  return { title, sub: out.filter(Boolean).join(' · ') };
}
// v56.0-beta.4: verkleinerte Kopie des Fotos fuer die Vollansicht (nur im Arbeitsspeicher, wird beim Schliessen freigegeben, nie gespeichert)
async function psO2Thumb(file) {
  let bmp = null, src = null, w = 0, hh = 0;
  try { bmp = await createImageBitmap(file); } catch (e) { bmp = null; }
  if (bmp) { src = bmp; w = bmp.width; hh = bmp.height; }
  else {
    const u = URL.createObjectURL(file);
    try { src = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = u; }); w = src.naturalWidth; hh = src.naturalHeight; }
    finally { URL.revokeObjectURL(u); }
  }
  if (!w || !hh) return '';
  const sc = Math.min(1, 1800 / Math.max(w, hh)), cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * sc)); cv.height = Math.max(1, Math.round(hh * sc));
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  if (bmp && bmp.close) bmp.close();
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.82));
  cv.width = cv.height = 0;
  return blob ? URL.createObjectURL(blob) : '';
}
// Querformat auf Tablet/PC -> Vollansicht (Foto links, Ergebnis rechts); Hochformat bleibt die Kompaktansicht
function psO2Wide() { try { return window.innerWidth >= 900 && window.innerWidth > window.innerHeight * 1.15; } catch (e) { return false; } }
function PsO2Import({ onApply, onClose, initial }) {
  const h = React.createElement;
  const camRef = React.useRef(null);
  const libRef = React.useRef(null);
  const stageRef = React.useRef('tarife');
  React.useEffect(() => { const t = setTimeout(() => { psO2Warm(); }, 300); return () => clearTimeout(t); }, []);
  const [seen, setSeen] = React.useState('');
  const [blur, setBlur] = React.useState(null);
  const libModeRef = React.useRef(false);
  // Beim erneuten Oeffnen (nachtraeglich Tarif/Handy dazu) sind die bisherigen Eintraege schon da.
  const [d, setD] = React.useState(() => {
    const i = initial || {};
    const arr = v => Array.isArray(v) ? v.map(x => ({ ...x })) : [];
    return { internet: arr(i.internet), tarife: arr(i.tarife), geraete: arr(i.geraete), einmalig: i.einmalig || '', monatlich: i.monatlich || '', hinweis: i.hinweis || '', beratungsId: i.beratungsId || '' };
  });
  const had = !!(initial && (['internet', 'tarife', 'geraete'].some(k => (initial[k] || []).length) || initial.einmalig || initial.monatlich));
  const dRef = React.useRef(d); dRef.current = d;
  const initD = React.useRef(d), [askClose, setAskClose] = React.useState(false);
  // v56.0-beta.3: Kompaktansicht – aufgeklappte Produktkarten, "Bearbeiten" (alle Felder offen), Scan-Einstellungen
  const [openG, setOpenG] = React.useState({}), [editAll, setEditAll] = React.useState(false), [showSet, setShowSet] = React.useState(false);
  // v56.0-beta.4: Originalfotos (verkleinert, nur im Arbeitsspeicher) + Querformat-Erkennung fuer die Vollansicht
  const [photos, setPhotos] = React.useState([]), [photoSel, setPhotoSel] = React.useState(0), [zoom, setZoom] = React.useState(false);
  const photoIds = React.useRef(new WeakMap()), photoSeq = React.useRef(0), photosRef = React.useRef([]); photosRef.current = photos;
  const [wide, setWide] = React.useState(() => psO2Wide());
  React.useEffect(() => {
    let t = 0; const f = () => { setWide(psO2Wide()); clearTimeout(t); t = setTimeout(() => setWide(psO2Wide()), 350); };
    window.addEventListener('resize', f); window.addEventListener('orientationchange', f);
    return () => { clearTimeout(t); window.removeEventListener('resize', f); window.removeEventListener('orientationchange', f); };
  }, []);
  React.useEffect(() => () => { photosRef.current.forEach(x => { try { URL.revokeObjectURL(x.url); } catch (e) {} }); }, []);
  const [busy, setBusy] = React.useState('');
  const [note, setNote] = React.useState('');
  // v55.224: jede Erkennung bekommt eine Lauf-Nummer; ein abgebrochener / ueberholter / nach dem Schliessen fertig gewordener Lauf aendert nichts mehr
  const runRef = React.useRef(0), engRef = React.useRef(null), aliveRef = React.useRef(true);
  // v55.225: Kennzeichen des Angebots im Dialog (Beratungs-ID / "erstellt am") + ein Foto, das zu einem ANDEREN Angebot gehoert und auf Bestaetigung wartet
  const offerRef = React.useRef({ id: (initial && initial.beratungsId) || '', ts: '' });
  const [pending, setPending] = React.useState(null);
  React.useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; runRef.current++; try { engRef.current && engRef.current.cancel('unmount'); } catch (e) {} psO2Release(); }; }, []);
  const cancelRead = () => { runRef.current++; try { engRef.current && engRef.current.cancel('user'); } catch (e) {} setBusy(''); setNote('Erkennung abgebrochen – neu fotografieren oder unten von Hand eintragen. Bereits Erkanntes bleibt erhalten.'); };
  const [crop, setCrop] = React.useState(null);
  // Zuschneiden ist nur noetig, wenn das Foto nicht lesbar war (dann oeffnet sich der Rahmen von selbst) – oder per Haken immer.
  const [alwaysCrop, setAlwaysCrop] = React.useState(() => { try { return localStorage.getItem('ps_o2_cropalways') === '1'; } catch (e) { return false; } });
  const toggleAlwaysCrop = v => { setAlwaysCrop(v); try { localStorage.setItem('ps_o2_cropalways', v ? '1' : '0'); } catch (e) {} };
  // Etappen: jede Taste fotografiert genau einen Bereich. Kamera-Eingang wie bei "Foto einfuegen" (iPad: Foto aufnehmen / Mediathek / Dateien),
  // 🖼 = Foto aus der Mediathek.
  // v55.196: eigene Kamera mit Rahmen und Schaerfe-Anzeige (Haken im Dialog; Rueckfall: normale Kamera-App)
  // v55.211: Standard = normale Kamera-App des Geraets (volle Aufloesung, Geraet schaerft/entrauscht selbst – schaerfer als jedes Videobild).
  // Die eigene Kamera mit Rahmen bleibt per Haken waehlbar (neuer Schluessel: alle starten mit der Kamera-App).
  const [ownCam, setOwnCam] = React.useState(() => { try { return localStorage.getItem('ps_o2_owncam2') === '1'; } catch (e) { return false; } });
  const toggleOwnCam = v => { setOwnCam(v); try { localStorage.setItem('ps_o2_owncam2', v ? '1' : '0'); } catch (e) {} };
  // v55.199: Modus "Block-Fotos": die Kamera bleibt offen, je Block ein Foto (Block 1, Block 2 ...), zuletzt der Kostenblock.
  // Gelesen wird nacheinander im Hintergrund; "Ganzes Foto" = bisheriges Verhalten (eine Taste je Bereich).
  // v55.203: dritter Modus "Bildschirm" (nur am PC): Activate+ Fenster freigeben, Rahmen ziehen = lesen
  // v55.226: Modus "Bildschirm" entfernt; am PC (Bildschirmfreigabe vorhanden) nur noch "Foto"
  const isPc = psO2SnipSupported(), snipOk = false;
  // v55.209: Tablet-Standard = "Scannen" (Block-Fotos und QR vom PC entfallen in der Auswahl)
  const [mode, setModeS] = React.useState(() => { try { const mv = localStorage.getItem('ps_o2_mode'); if (mv === 'ganz' || mv === 'snip' || mv === 'scan') return mv; } catch (e) {} return snipOk ? 'snip' : 'ganz'; });
  const setMode = m => { setModeS(m); try { localStorage.setItem('ps_o2_mode', m); } catch (e) {} };
  // v55.205: Tablet (ohne Bildschirmfreigabe): Knopf "Vom PC scannen" immer oben, kein eigener Modus mehr
  const camOk = psO2CamSupported() && !isPc, eff = mode === 'snip' || (mode === 'scan' && !camOk) ? 'ganz' : mode;
  const blockMode = false, scanMode = eff === 'scan' && camOk, snipMode = eff === 'snip' && snipOk, scanOk = false, quick = scanMode || snipMode;
  const lastRRef = React.useRef(null), scanPrevRef = React.useRef(null), droppedRef = React.useRef([]);
  // v55.211: Beim Zusammensetzen mehrerer Fotos als "schon da" verworfene Eintraege: passen die Summen zum Kostenblock erst,
  // wenn einer davon doch mitzaehlt (zwei gleiche Tarife untereinander), wird er automatisch wieder eingefuegt.
  React.useEffect(() => {
    const dr = droppedRef.current; if (!dr.length || busy) return;
    const ok = c => c && [c.e, c.m].every(x => !x || x.ok), c0 = psO2Check(d);
    if (!c0 || ok(c0)) return;
    for (let n = 1; n <= dr.length; n++) {
      const cand = { ...d, tarife: d.tarife.slice(), geraete: d.geraete.slice(), internet: d.internet.slice() };
      dr.slice(0, n).forEach(x => { const a = cand[x.kind]; if (a.length < PS_O2_MAX[x.kind]) a.splice(Math.min(a.length, x.pos), 0, x.it); });
      if (ok(psO2Check(cand))) { droppedRef.current = dr.slice(n); setD(cand); setNote('✓ Gleicher Eintrag stand mehrfach im Vorschlag – ergänzt, Summen stimmen jetzt.'); return; }
    }
  }, [d, busy]);
  // v55.214: Fehlt genau der Preis eines schon gelesenen Eintrags (einmalig UND monatlich, z. B. 39,99 € / 19,99 € = O2 Mobile S),
  // stand dieser Eintrag mehrfach im Vorschlag und wurde nur einmal erkannt -> automatisch ergaenzen, wenn es genau EINE Loesung gibt.
  React.useEffect(() => {
    if (busy || !(d.einmalig && d.monatlich)) return;
    const ok = c => c && [c.e, c.m].every(x => !x || x.ok), c0 = psO2Check(d);
    if (!c0 || ok(c0) || ![c0.e, c0.m].every(x => x && x.val >= Math.min.apply(null, x.calc))) return;
    const sols = [];
    // v55.220: Internet@Home kommt in einem Vorschlag praktisch nie doppelt vor (ein Anschluss je Adresse) -
    // hier NIE von selbst verdoppeln, auch wenn die Summe rechnerisch dazu passen wuerde. Nur Tarif/Handy,
    // die tatsaechlich mehrfach verkauft werden, duerfen automatisch ergaenzt werden.
    ['tarife', 'geraete'].forEach(kind => {
      const seen = new Set();
      d[kind].forEach((it, i) => {
        const key = it.name + '|' + JSON.stringify(it.am || null); if (seen.has(key) || !it.am) return; seen.add(key);
        for (let n = 1; n <= 3 && d[kind].length + n <= PS_O2_MAX[kind]; n++) {
          const arr = d[kind].slice(); let last = i; arr.forEach((x, k) => { if (x.name === it.name) last = k; });
          for (let k = 0; k < n; k++) arr.splice(last + 1, 0, { ...it });
          const cand = { ...d, [kind]: arr };
          if (ok(psO2Check(cand))) { sols.push({ cand, txt: it.name + (n > 1 ? ' (' + (n + 1) + '×)' : ' (2×)') }); break; }
        }
      });
    });
    if (sols.length === 1) { setD(sols[0].cand); setNote('✓ ' + sols[0].txt + ' stand mehrfach im Vorschlag – ergänzt, Summen stimmen jetzt.'); }
  }, [d, busy]);
  const openScan = () => {
    setNote(''); scanPrevRef.current = null;
    psO2CamOpen({ scan: true, onShot: (file, st, f) => {
      const job = jobRef.current.then(() => readPhoto(Promise.resolve(file), 'scan', null, f)).then(t => {
        const q = lastRRef.current;
        return { t, end: !!(q && q.einmalig && q.monatlich) };
      });
      jobRef.current = job.catch(() => {});
      return job;
    } });
  };
  const myShop = () => { try { return String(window.__PS_SHOP || ''); } catch (e) { return ''; } };
  const shopName = id => (typeof SHOPS !== 'undefined' && SHOPS[id] && SHOPS[id].name) || id;
  const sendQr = async () => {
    setNote('');
    try {
      const x = dRef.current, nT = x.tarife.length, nG = x.geraete.length, nN = x.internet.length, parts = [];
      if (nT) parts.push(nT + (nT === 1 ? ' Tarif' : ' Tarife'));
      if (nG) parts.push(nG + (nG === 1 ? ' Handy' : ' Handys'));
      if (nN) parts.push('Internet@Home');
      if (x.einmalig) parts.push('Einmalig ' + x.einmalig + ' €');
      if (x.monatlich) parts.push('Monatlich ' + x.monatlich + ' €');
      const c = psO2Check(x), sure = !!c && [c.e, c.m].every(r => !r || r.ok);
      await psO2QrShow(await psO2QrPack(x, myShop(), sure), shopName(myShop()) + ': ' + (parts.join(' · ') || 'nichts erkannt'),
        sure ? '' : c ? '⚠ Summen passen nicht ganz – am PC prüfen oder weiter lesen' : 'Summen nicht geprüft – am Tablet kurz kontrollieren');
      return sure;
    }
    catch (e) { setNote('QR-Code nicht möglich: ' + (e && e.message || e)); return false; }
  };
  const scanQr = async auto => {
    setNote('');
    if (!auto) { try { localStorage.setItem('ps_o2_autoscan', '1'); } catch (e) {} }
    let txt = null;
    try { txt = await psO2QrScan(); } catch (e) { setNote('QR-Scanner nicht möglich: ' + (e && e.message || e)); return; }
    // vom Mitarbeiter selbst abgebrochen: nicht mehr von selbst oeffnen
    if (!txt) { if (auto) { try { localStorage.setItem('ps_o2_autoscan', '0'); } catch (e) {} } return; }
    const r = await psO2QrUnpack(txt, myShop());
    if (r.err) { setNote(r.err); return; }
    // Summen stimmen schon am PC -> gleich ins Angebot (sonst zur Kontrolle anzeigen)
    if (r.ok && !had) { onApply(r.d); return; }
    setD(r.d);
    const nT = r.d.tarife.length, nG = r.d.geraete.length, nN = r.d.internet.length, parts = [];
    if (nT) parts.push(nT + (nT === 1 ? ' Tarif' : ' Tarife'));
    if (nG) parts.push(nG + (nG === 1 ? ' Handy' : ' Handys'));
    if (nN) parts.push('Internet@Home');
    if (r.d.einmalig || r.d.monatlich) parts.push('Kosten');
    setNote('✓ Vom PC übernommen: ' + (parts.join(', ') || 'nichts') + ' – bitte kurz prüfen.');
  };
  const openSnip = async () => {
    setNote('');
    const res = await psO2SnipOpen({ auto: true, onShot: (file, art) => {
      const job = jobRef.current.then(() => readPhoto(Promise.resolve(file), art === 'snip' ? 'ganz' : 'block', null));
      jobRef.current = job.catch(() => {});
      return job;
    } });
    if (res === 'geschwaerzt') setNote('Der Bildschirm kommt nur schwarz an – die Umgebung blockiert Aufnahmen. Bitte „Block-Fotos“ mit der Kamera nehmen.');
    else if (res === 'leer') setNote('Keine Vorschlag-Seite erkannt. Falsches Fenster geteilt? Dann „Anderes Fenster wählen“. Sonst im Edge der Windows App den Vorschlag öffnen und noch einmal „Bildschirm lesen“.');
    // etwas gelesen: QR-Code fuers Tablet gleich anzeigen (kein weiterer Klick)
    else if (res === 'fertig') {
      await new Promise(r => setTimeout(r, 200));
      const x = dRef.current;
      // alles stimmig und QR-Code geschlossen: Dialog schliesst sich selbst
      if (x.tarife.length || x.geraete.length || x.internet.length || x.einmalig || x.monatlich) { if (await sendQr()) onClose(); }
    }
  };
  const jobRef = React.useRef(Promise.resolve());
  // PC: beim Oeffnen gleich die Fensterauswahl zeigen (Klick auf "o2-Vorschlag einlesen" zaehlt noch als Nutzeraktion; sonst Knopf)
  const autoOpenRef = React.useRef(false);
  React.useEffect(() => { if (autoOpenRef.current) return; autoOpenRef.current = true;
    if (snipOk && eff === 'snip' && !had) openSnip();
    else if (false && scanOk && !had) { let off = false; try { off = localStorage.getItem('ps_o2_autoscan') === '0'; } catch (e) {} if (!off) scanQr(true); } }, []);
  const openBlocks = step => {
    setNote('');
    psO2CamOpen({ session: true, step, onShot: (file, st) => {
      const job = jobRef.current.then(() => readPhoto(Promise.resolve(file), st === 'kosten' ? 'kosten' : 'block', null));
      jobRef.current = job.catch(() => {});
      return job;
    } });
  };
  const CAM_LABEL = { tarife: 'Tarif', geraete: 'Handy', internet: 'Internet@Home', kosten: 'Kostenblock' };
  const pick = (stage, lib) => {
    stageRef.current = stage; libModeRef.current = !!lib; setNote('');
    const nat = () => { try { const r = lib ? libRef.current : camRef.current; r.value = ''; r.click(); } catch (e) {} };
    if (lib || !ownCam || !psO2CamSupported()) { nat(); return; }
    psO2CamOpen({ label: CAM_LABEL[stage] || '' }).then(res => {
      if (res === 'native') nat();
      else if (res && res.file) {
        if (alwaysCrop) setCrop({ file: res.file, stage });
        else if (res.auto) readPhoto(Promise.resolve(res.file), stage, res.file); // schon live auf Schaerfe geprueft
        else checkThenRead(res.file, stage);
      }
    });
  };
  const conv = (kind, it) => ({ name: kind === 'geraete' ? psO2Pretty(it.name) : it.name, art: it.art || '', det: (it.details || []).join('\n'), ...(typeof it.t === 'number' ? { t: it.t } : {}), ...(it.am ? { am: it.am } : {}), ...(it.rb ? { rb: it.rb } : {}) });
  // Foto gewaehlt -> sofort lesen (Tarif/Handy/Internet/Kosten erkennt die App selbst an den Ueberschriften)
  const onFile = e => {
    const files = Array.from(e.target.files || []);
    const file = files.find(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || ''));
    if (!file) { if (files.length) setNote('Bitte ein Foto auswählen (kein PDF).'); return; }
    if (alwaysCrop) { setCrop({ file, stage: stageRef.current }); return; }
    checkThenRead(file, stageRef.current);
  };
  // Unscharfe oder zu dunkle Fotos sofort melden, statt den Mitarbeiter erst 20 Sekunden warten zu lassen
  const checkThenRead = async (file, stage) => {
    setNote(''); setBlur(null); setSeen('');
    try {
      const q = await psO2Quality(file);
      if (q.sharp < PS_O2_SHARP_MIN || q.hell < PS_O2_HELL_MIN) { setBlur({ file, stage, dark: q.hell < PS_O2_HELL_MIN }); return; }
    } catch (e) { /* laesst sich nicht pruefen -> einfach lesen */ }
    readPhoto(Promise.resolve(file), stage, file);
  };
  const readPhoto = async (jobP, stage, retryFile, ovF, pre) => {
    let sum = ''; // kurzer Text "was wurde erkannt" (fuer die Block-Reihe in der Kamera)
    const myRun = ++runRef.current, live = () => aliveRef.current && runRef.current === myRun;
    const job = psO2NewJob(); engRef.current = job; const tStart = Date.now();
    setBlur(null); setPending(null);
    try {
      setBusy('Foto wird vorbereitet …');
      const file = await jobP;
      if (!live()) return sum;
      addPhoto(file);
      const missOf = q => stage === 'tarife' ? !q.tarife.length : stage === 'geraete' ? !q.geraete.length : stage === 'internet' ? !q.internet.length : stage === 'kosten' ? !(q.einmalig || q.monatlich) : false;
      const got = q => !!(q && (q.tarife.length || q.geraete.length || q.internet.length || q.einmalig || q.monatlich));
      let txt = pre ? pre.txt : '', r = pre ? pre.r : null, cloudThin = false, locFail = '', locCancelled = false, cloudFail = '';
      // Smart Scan 2: Angebotsfotos bleiben lokal. Handschrift-Dienst unverändert.
      // 2. Weg: Texterkennung auf dem Gerät (v55.193: Bildschirm zuerst ausschneiden, Auswertung nach Position), bei Bedarf mit weiteren Aufbereitungen.
      if (!r || cloudThin) {
        const loc = await psO2ReadLocal(file, m => { if (live()) setBusy(m); }, q => !missOf(q), { job, t: { budget: Math.min(PS_O2_T.budget, Math.max(10000, PS_O2_T.total - (Date.now() - tStart))) } });
        if (!live()) return sum;
        locFail = loc.fail; locCancelled = loc.cancelled;
        if (!r) { r = loc.r; txt = loc.txt; }
        else {
          txt = loc.txt;
          // Nicht nur fehlende Kategorien ergaenzen, sondern auch eine erkennbar ABGESCHNITTENE Kategorie
          // des Dienstes durch die des Geraets ersetzen – aber nur, wenn jeder Name des Geraets mit dem
          // (kuerzeren) Namen des Dienstes beginnt (= eindeutig abgeschnitten, kein nur zufaellig laengerer
          // oder anders gelesener Name – sonst wuerde z. B. ein falsch eingefuegtes Zeichen des Geraets eine
          // an sich richtige Kategorie des Dienstes verdraengen).
          const cut = (rc, lc) => rc.every((it, i) => {
            const cn = String((it && it.name) || ''), ln = String((lc[i] && lc[i].name) || '');
            return cn && ln.length > cn.length && ln.slice(0, cn.length) === cn;
          });
          ['tarife', 'geraete', 'internet'].forEach(k => {
            const rc = r[k], lc = loc.r[k];
            if (lc.length > rc.length) r[k] = lc;
            else if (lc.length === rc.length && lc.length > 0 && cut(rc, lc)) r[k] = lc;
            else if (lc.length) r[k] = psO2FillPrices(rc, [{ [k]: rc }, { [k]: lc }], k);
          });
          if (!r.einmalig && loc.r.einmalig) r.einmalig = loc.r.einmalig;
          if (!r.monatlich && loc.r.monatlich) r.monatlich = loc.r.monatlich;
          if (!r.internetFortsetzung || !r.internetFortsetzung.length) r.internetFortsetzung = loc.r.internetFortsetzung || [];
        }
      }
      if (psO2SuspectTotals(r)) r.monatlich = '';
      const internetContinue = [].concat(r.internetFortsetzung || [], psO2Page2InternetDetails(txt));
      setSeen(txt); lastRRef.current = r;
      // v55.217: Zeigt der Bildschirm eine Beratungs-ID, wird sie gleich mit erkannt und spaeter beim
      // Uebernehmen oben eingetragen (nur wenn dort noch keine steht – nichts wird ueberschrieben).
      if (!r.beratungsId) {
        const bm = /Beratungs[\s-]?[I1l][D0]\D{0,4}(\d[\d .\-]{2,20}\d)/i.exec(txt);
        if (bm) r.beratungsId = bm[1].replace(/\D/g, '').slice(0, 15);
      }
      if (!r.offerTs) { const tm = /erstellt\s*am\s*([^\n]{6,32})/i.exec(txt); if (tm) r.offerTs = psO2OfferTs(tm[1]); }
      // v55.225: gehoert das Foto zu einem ANDEREN Angebot als dem im Dialog? Dann nie stillschweigend mischen, sondern nachfragen.
      const d0 = dRef.current, has0 = !!(d0.tarife.length || d0.geraete.length || d0.internet.length || d0.einmalig || d0.monatlich);
      if (!(pre && pre.force) && has0 && got(r) && psO2OfferCmp(offerRef.current, { id: r.beratungsId, ts: r.offerTs }) === 'other') {
        setPending({ r, txt, stage, ovF, file }); setBusy('');
        setNote('Anderes Angebot erkannt – bitte wählen, wie das Foto übernommen werden soll. Bisher Erkanntes bleibt unverändert.');
        return sum;
      }
      // v55.214: gleicher Name, Preise vertauscht (schraeges Foto: Zeilen verrutscht) -> Preise des ersten gleichen Eintrags
      ['tarife', 'geraete', 'internet'].forEach(kind => (r[kind] || []).forEach((it, i, arr) => { const f = arr.find(x => x !== it && x.name === it.name && x.am && it.am && x.am[0] === it.am[1] && x.am[1] === it.am[0]); if (f && arr.indexOf(f) < i) it.am = f.am.slice(); }));
      sum = [].concat(r.tarife.map(x => x.name), r.geraete.map(x => psO2Pretty(x.name)), r.internet.map(x => x.name)).join(', ') || (r.einmalig || r.monatlich ? 'Kosten ' + (r.einmalig || '–') + ' / ' + (r.monatlich || '–') + ' €' : '');
      // Immer noch nicht gelesen, was die Taste verspricht? Dann (einmalig) den Rahmen aufmachen und den Ausschnitt noch einmal lesen.
      const miss = missOf(r);
      if (miss && retryFile) { setCrop({ file: retryFile, stage, auto: true }); setBusy(''); return; }
      // Zwei Fotos derselben (PDF-)Seite ueberschneiden sich oft: die ersten neuen Eintraege sind dann die letzten schon vorhandenen -> nicht doppelt
      const cur = dRef.current, nmOf = (kind, it) => kind === 'geraete' ? psO2Pretty(it.name) : it.name;
      const ovl = kind => {
        const old = cur[kind], neu = r[kind];
        for (let k = Math.min(old.length, neu.length); k >= 1; k--) if (neu.slice(0, k).every((it, i) => psO2Similar(old[old.length - k + i].name, nmOf(kind, it)))) return k;
        return 0;
      };
      // Block-Fotos zeigen je einen eigenen Block: da gibt es keine Ueberschneidung (zwei gleiche Tarife sind zwei Tarife)
      // Scannen: ein Eintrag ist nur dann schon da, wenn er im vorigen Foto an der passenden Stelle stand (Lage + gewanderte Strecke).
      // So bleiben zwei gleiche Tarife untereinander zwei Tarife.
      const prevS = scanPrevRef.current, mv = 1 - (ovF || 0);
      const ovlS = kind => {
        if (!ovF || !prevS || !prevS[kind] || !prevS[kind].length) return 0;
        const used = new Set(); let k = 0;
        for (const it of r[kind]) {
          const y = (it.yf || 0) + mv, nm = nmOf(kind, it);
          const j = prevS[kind].findIndex((q, qi) => !used.has(qi) && Math.abs(q.yf - y) < 0.17 && psO2Similar(q.name, nm));
          if (j < 0) break;
          used.add(j); k++;
        }
        return Math.min(k, cur[kind].length);
      };
      const ov = stage === 'block' ? { tarife: 0, geraete: 0, internet: 0 } : stage === 'scan' ? { tarife: ovlS('tarife'), geraete: ovlS('geraete'), internet: ovlS('internet') } : { tarife: ovl('tarife'), geraete: ovl('geraete'), internet: ovl('internet') };
      if (stage === 'scan') scanPrevRef.current = { tarife: r.tarife.map(it => ({ yf: it.yf || 0, name: it.name })), geraete: r.geraete.map(it => ({ yf: it.yf || 0, name: psO2Pretty(it.name) })), internet: r.internet.map(it => ({ yf: it.yf || 0, name: it.name })) };
      if (stage !== 'block') ['tarife', 'geraete', 'internet'].forEach(kind => { const ol = cur[kind].length; for (let i = 0; i < ov[kind]; i++) droppedRef.current.push({ kind, pos: ol - ov[kind] + i + 1, it: conv(kind, r[kind][i]) }); });
      const merge = (kind, p) => {
        const old = p[kind].slice(), k = ov[kind], neu = r[kind];
        // Bei der Ueberschneidung die vollstaendigere Fassung behalten (am Seitenrand sind Inhalte oft abgeschnitten)
        for (let i = 0; i < k; i++) {
          const o = old[old.length - k + i], nw = neu[i], nd = (nw.details || []).length;
          const more = nd > String(o.det || '').split('\n').filter(Boolean).length, am2 = psO2FillAm(o.am, nw.am); // v55.225: Preise nur ergaenzen, nie ueberschreiben
          if (more || am2 !== o.am || (!o.rb && nw.rb)) old[old.length - k + i] = { ...o, ...(more ? { det: nw.details.join('\n') } : {}), ...(am2 ? { am: am2 } : {}), ...(!o.rb && nw.rb ? { rb: nw.rb } : {}) };
        }
        return old.concat(neu.slice(k)).slice(0, PS_O2_MAX[kind]);
      };
      // v55.225: gedruckte Gesamtkosten werden nicht still ueberschrieben: ein neues Foto ersetzt eine vorhandene Summe nur, wenn es der Kostenblock-Knopf war,
      // die Summe gleich ist oder nur die neue zu den Einzelpreisen passt. Sonst bleibt der bisherige Wert und es wird gemeldet.
      const totTake = { einmalig: false, monatlich: false }, totConf = [];
      [['einmalig', 'e'], ['monatlich', 'm']].forEach(([f, c]) => {
        if (!r[f]) return;
        if (!cur[f] || cur[f] === r[f] || stage === 'kosten' ||
            (f === 'monatlich' && cur.einmalig === cur.monatlich &&
             (psO2Cents(cur.einmalig) || 0) >= 100000 && r.einmalig === cur.einmalig && r.monatlich !== r.einmalig)) { totTake[f] = true; return; }
        const cN = psO2Check(r), cO = psO2Check(cur);
        if (cN && cN[c] && cN[c].ok && !(cO && cO[c] && cO[c].ok)) totTake[f] = true; else totConf.push(f);
      });
      offerRef.current = has0 ? { id: offerRef.current.id || r.beratungsId || '', ts: offerRef.current.ts || r.offerTs || '' } : { id: r.beratungsId || '', ts: r.offerTs || '' };
      setD(p => {
        const n = { ...p };
        if (r.tarife.length) n.tarife = merge('tarife', p).map(it => it.det !== undefined ? it : conv('tarife', it));
        // Kamen Tarife UND Handys von einem einzigen Foto (z. B. ganze Vorschlagsseite), gehoert jedes Handy zu dem Tarif darueber
        const one = !r.mixed && !p.tarife.length && !p.geraete.length && r.tarife.length && r.geraete.length;
        // Scannen: Handy gehoert zum Tarif darueber – auch wenn der im vorigen Foto stand
        const tOf = it => stage === 'scan' ? { ...it, t: Math.max(0, p.tarife.length - ov.tarife) + r.tarife.filter(x => x.idx < it.idx).length } : one ? { ...it, t: r.tarife.filter(x => x.idx < it.idx).length } : it;
        if (r.geraete.length) n.geraete = merge('geraete', p).map(it => it.det !== undefined ? it : conv('geraete', tOf(it)));
        if (r.internet.length) n.internet = merge('internet', p).map(it => it.det !== undefined ? it : conv('internet', it));
        // Internet@Home-Block von Seite 1: Fortsetzungszeilen von Seite 2 anhängen.
        if (internetContinue.length && n.internet.length && !r.internet.length) {
          n.internet = n.internet.slice();
          const k = n.internet.length - 1, it = n.internet[k];
          n.internet[k] = { ...it, det: psO2JoinDetails(it.det, internetContinue) };
        }
        if (totTake.einmalig) n.einmalig = r.einmalig;
        if (totTake.monatlich) n.monatlich = r.monatlich;
        if (r.hinweis && !p.hinweis) n.hinweis = r.hinweis;
        if (r.beratungsId && !p.beratungsId) n.beratungsId = r.beratungsId;
        return n;
      });
      const tip = ' – näher ran, gerade von vorne und noch einmal fotografieren.';
      const vd = psO2Verdict(r, { txt, fail: locFail || (cloudFail === 'timeout' ? 'timeout' : ''), cancelled: locCancelled });
      const keep = (cur.tarife.length || cur.geraete.length || cur.internet.length || cur.einmalig || cur.monatlich) ? ' Bereits Erkanntes bleibt erhalten.' : '';
      const what = vd.cnt ? ' Erkannt (und übernommen): ' + vd.cnt + '.' : '';
      if (vd.kind === 'cancelled') setNote(vd.msg + keep);
      else if (vd.kind === 'fail' || vd.kind === 'notext' || vd.kind === 'nopos') setNote(vd.msg + keep);
      else if (stage === 'tarife' && !r.tarife.length) setNote('Kein Tarif erkannt' + tip + what);
      else if (stage === 'geraete' && !r.geraete.length) setNote('Kein Handy erkannt' + tip + what);
      else if (stage === 'internet' && !r.internet.length) setNote('Kein Internet@Home erkannt' + tip + what);
      else if (stage === 'kosten' && !(r.einmalig || r.monatlich)) setNote('Kostenblock nicht erkannt' + tip + what);
      else if (stage === 'kosten' && !(r.einmalig && r.monatlich)) setNote('Nur ' + (r.einmalig ? 'die einmaligen' : 'die monatlichen') + ' Kosten erkannt – bitte ergänzen.');
      else {
        // Egal welche Taste: alles, was auf dem Foto steht, wird uebernommen – hier steht, was erkannt wurde.
        const parts = [], nT = r.tarife.length - ov.tarife, nG = r.geraete.length - ov.geraete, nN = r.internet.length - ov.internet;
        if (nT) parts.push(nT + (nT === 1 ? ' Tarif' : ' Tarife'));
        if (nG) parts.push(nG + (nG === 1 ? ' Handy' : ' Handys'));
        if (nN) parts.push('Internet@Home');
        if (r.einmalig || r.monatlich) parts.push('Kosten');
        const same = ov.tarife + ov.geraete + ov.internet, c0 = !!psO2Check(r);
        // PDF-Vorschlag: "Seite 1 von 2" und noch keine Summen -> der Kostenblock steht auf der naechsten Seite
        const pg = /Seite\s*(\d)\s*v[o0]n\s*(\d)/i.exec(txt);
        const more = stage !== 'scan' && pg && +pg[1] < +pg[2] && !(r.einmalig || r.monatlich) && !(cur.einmalig || cur.monatlich) ? ' · Seite ' + pg[1] + ' von ' + pg[2] + ': die Kosten stehen auf Seite ' + (+pg[1] + 1) + ' – bitte noch fotografieren (📷 Kosten)' : '';
        const lap = same ? ' · Überschneidung mit dem vorigen Foto, nichts doppelt (gleicher Eintrag nochmal: „+1“)' : '';
        const ok = parts.length ? (vd.kind === 'ok' ? '✓ Erkennung abgeschlossen: ' + parts.join(', ') + (c0 ? ', Summen stimmen' : ', bitte kurz prüfen') : vd.msg) + lap + more : (same ? '✓ Nichts Neues – das Foto überschneidet sich mit dem vorigen' + more : vd.msg + keep);
        if (had && stage !== 'kosten' && (dRef.current.einmalig || dRef.current.monatlich) && parts.length) setNote('Neu dazu (' + parts.join(', ') + ') – bitte den Kostenblock neu fotografieren, die Summe hat sich geändert.');
        else setNote(ok);
      }
      if (totConf.length) setNote('Gesamtkosten weichen ab (' + totConf.map(f => f === 'einmalig' ? 'einmalig bisher ' + cur.einmalig + ', neues Foto ' + r.einmalig : 'monatlich bisher ' + cur.monatlich + ', neues Foto ' + r.monatlich).join('; ') + ' €) – die bisherigen Werte bleiben, bitte prüfen.');
    } catch (err) {
      console.error('[O2]', err && err.message || 'Fehler');
      if (live()) setNote('Lesen fehlgeschlagen – bitte erneut fotografieren oder unten von Hand eintragen. Bereits Erkanntes bleibt erhalten.');
    }
    if (live()) setBusy('');
    return sum;
  };
  const pendingGo = mode => {
    const p = pending; if (!p) return; setPending(null);
    if (mode === 'drop') { dropPhoto(p.file); setNote('Foto verworfen – das bisherige Angebot ist unverändert.'); return; }
    if (mode === 'replace') { const e = { internet: [], tarife: [], geraete: [], einmalig: '', monatlich: '', hinweis: '', beratungsId: '' }; dRef.current = e; droppedRef.current = []; scanPrevRef.current = null; offerRef.current = { id: '', ts: '' }; setD(e); keepPhoto(p.file); }
    readPhoto(Promise.resolve(p.file), p.stage, null, p.ovF, { r: p.r, txt: p.txt, force: true });
  };
  const inp = (v, on, ph, big) => h('input', { value: v || '', placeholder: ph, onChange: e => on(e.target.value), className: 'w-full px-3 py-2 rounded-lg border border-slate-300 text-slate-900', style: { fontSize: big ? 20 : 15, fontWeight: big ? 800 : 600 }, inputMode: big ? 'decimal' : 'text' });
  const setItem = (key, i, f, v) => setD(p => ({ ...p, [key]: p[key].map((x, k) => k === i ? { ...x, [f]: v } : x) }));
  const unpair = p => ({ ...p, geraete: p.geraete.map(g => { const c = { ...g }; delete c.t; return c; }) });
  const delItem = (key, i) => setD(p => unpair({ ...p, [key]: p[key].filter((x, k) => k !== i) }));
  // Gleicher Tarif / gleiches Handy mehrfach: einfach "+1" statt nochmal fotografieren
  const dupItem = (key, i) => setD(p => {
    if (p[key].length >= PS_O2_MAX[key]) return p;
    const arr = p[key].slice(); arr.splice(i + 1, 0, { ...p[key][i] });
    return unpair({ ...p, [key]: arr });
  });
  const money = v => String(v || '').replace(/[^\d,.]/g, '');
  // v55.212: gleiche Eintraege direkt untereinander (z. B. 2x O2 Mobile S) als EIN Eintrag mit "2×" – Aenderungen gelten fuer alle,
  // ✕ nimmt einen weg, +1 fuegt einen dazu
  const sameIt = (a, b) => a && b && a.name === b.name && !!a.ak === !!b.ak && (a.art || '') === (b.art || '') && JSON.stringify(a.am || null) === JSON.stringify(b.am || null); // Inhalte koennen durch Lesefehler leicht abweichen
  const groups = key => { const g = []; d[key].forEach((it, i) => { const l = g[g.length - 1]; if (l && sameIt(d[key][l[0]], it)) l.push(i); else g.push([i]); }); return g; };
  const setItemG = (key, idxs, f, v) => setD(p => ({ ...p, [key]: p[key].map((x, k) => idxs.indexOf(k) > -1 ? { ...x, [f]: v } : x) }));
  const item = (key, idxs, ph) => {
    const i = idxs[0], j = idxs[idxs.length - 1], it = d[key][i], n = idxs.length;
    return h('div', { key: key + i, className: 'mt-2 rounded-xl border border-slate-200 bg-slate-50 p-2' },
    d[key].length > 1 ? h('div', { className: 'flex items-center gap-2 text-[11px] font-black text-slate-400 mb-0.5' }, ph.toUpperCase() + ' ' + (i + 1) + (n > 1 ? '–' + (j + 1) : ''),
      n > 1 ? h('span', { className: 'px-2 py-0.5 rounded-full bg-blue-600 text-white text-[12px]' }, n + '×') : null) : null,
    h('div', { className: 'flex items-center gap-1' }, h('div', { className: 'flex-1' }, inp(it.name, v => setItemG(key, idxs, 'name', v), ph)),
      key !== 'internet' ? h('button', { onClick: () => dupItem(key, j), disabled: d[key].length >= PS_O2_MAX[key], className: 'px-2 py-2 rounded-lg border border-blue-300 text-blue-700 font-black text-sm disabled:opacity-30', title: 'Gleichen Eintrag noch einmal hinzufügen', 'aria-label': 'Gleichen Eintrag noch einmal hinzufügen' }, '+1') : null,
      h('button', { onClick: () => delItem(key, j), className: 'text-slate-400 font-bold px-2 py-2', 'aria-label': n > 1 ? 'Einen entfernen' : 'Entfernen' }, n > 1 ? '−1' : '✕')),
    key === 'tarife' && d.tarife.length > 1 ? h('div', { className: 'flex items-center gap-2 mt-1 flex-wrap' },
      h('button', { onClick: () => toggleAk(idxs), 'aria-pressed': !!it.ak, className: 'px-3 py-2 rounded-lg text-xs font-black border ' + (it.ak ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-slate-300 text-slate-500') }, (it.ak ? '✓ ' : '') + 'Aktionskarte'),
      it.ak ? h('span', { className: 'text-xs font-bold text-amber-700' }, 'erscheint bei Tarif 1 als „inkl. Aktionskarte' + (psO2AkGb(it) ? ' ' + psO2AkGb(it) : '') + '“ – Preis zählt weiter') : null) : null,
    h('details', { className: 'mt-1' },
      h('summary', { className: 'cursor-pointer select-none py-2 text-xs font-bold text-blue-700' }, 'Details & Einzelpreise bearbeiten', (!it.am || !it.am[0] || (key !== 'geraete' && !it.am[1])) ? h('span', { className: 'ml-2 text-amber-700' }, '· Preis prüfen') : null),
      h('div', { className: 'pb-1' },
    it.art ? h('div', { className: 'mt-1' }, inp(it.art, v => setItemG(key, idxs, 'art', v), 'Vertragsart')) : null,
    // v55.227: Einzelpreise sichtbar und korrigierbar (fehlt einer, sieht man es hier sofort; die Summenpruefung rechnet live mit)
    h('div', { className: 'flex items-center gap-2 mt-1' }, [0, 1].map(c => h('label', { key: c, className: 'flex-1 flex items-center gap-1 text-[11px] font-black text-slate-400' }, c ? 'MTL.' : 'EINM.',
      h('input', { value: (it.am && it.am[c]) || '', placeholder: '–', inputMode: 'decimal', 'aria-label': (c ? 'Monatlicher' : 'Einmaliger') + ' Preis ' + ph,
        onChange: e => { const v = money(e.target.value), am = it.am ? it.am.slice() : [null, null]; am[c] = v || null; setItemG(key, idxs, 'am', am[0] == null && am[1] == null ? undefined : am); },
        className: 'w-full px-2 py-1.5 rounded-lg border text-slate-900 ' + ((it.am && it.am[c]) || (c === 1 && key === 'geraete') ? 'border-slate-300' : 'border-amber-300 bg-amber-50'), style: { fontSize: 15, fontWeight: 700 } }), '€')),
      it.rb && (it.rb.e || it.rb.m) ? h('span', { className: 'text-[11px] font-bold text-emerald-700 whitespace-nowrap' }, 'Rabatt ' + [it.rb.e ? psO2Fmt(it.rb.e) + ' einm.' : '', it.rb.m ? psO2Fmt(it.rb.m) + ' mtl.' : ''].filter(Boolean).join(' / ')) : null),
    h('textarea', { value: it.det || '', placeholder: 'Inhalte – eine Zeile pro Punkt', rows: Math.min(6, Math.max(2, String(it.det || '').split('\n').length)), onChange: e => setItemG(key, idxs, 'det', e.target.value), className: 'w-full mt-1 px-3 py-2 rounded-lg border border-slate-300 text-slate-900', style: { fontSize: 14, fontWeight: 500 } }))));
  };
  const sBtn = 'px-3 py-2 rounded-lg bg-blue-600 text-white font-black text-sm disabled:opacity-50';
  const gBtn = 'px-3 py-2 rounded-lg border border-slate-300 text-slate-600 font-bold text-sm disabled:opacity-50';
  const sec = (title, n, stage, label, hideBtn, body, max) => h('div', { className: 'mt-2 rounded-xl border border-slate-200 p-2.5' },
    h('div', { className: 'flex items-center justify-between gap-2' },
      h('div', { className: 'text-[11px] font-black tracking-wide text-blue-700' }, title + (n ? ' · ' + n + (max ? '/' + max : '') : '')),
      hideBtn || snipMode || (blockMode || scanMode) && stage !== 'kosten' ? null : h('div', { className: 'flex gap-2' },
        h('button', { onClick: () => blockMode ? openBlocks('kosten') : pick(stage, false), disabled: !!busy, className: sBtn }, label),
        blockMode ? null : h('button', { onClick: () => pick(stage, true), disabled: !!busy, className: gBtn, 'aria-label': 'Foto aus der Mediathek wählen' }, '🖼'))),
    body);
  const photoActions = more => h('div', { className: 'grid grid-cols-2 gap-2 mt-2' },
    h('button', { onClick: () => pick('ganz', false), disabled: !!busy, className: sBtn + ' py-3' }, more ? '📷 Weiteres Foto' : '📷 Vorschlag fotografieren'),
    h('button', { onClick: () => pick('ganz', true), disabled: !!busy, className: gBtn + ' py-3' }, 'Foto hochladen'));
  const any = d.einmalig || d.monatlich || d.tarife.length || d.geraete.length || d.internet.length;
  const nItems = d.tarife.length + d.geraete.length + d.internet.length, compact = nItems > 0;
  const closeTap = () => { const dirty = JSON.stringify(d) !== JSON.stringify(initD.current); if (!dirty || askClose) { onClose(); return; } setAskClose(true); setTimeout(() => setAskClose(false), 3500); };
  const resetAll = () => { runRef.current++; try { engRef.current && engRef.current.cancel('reset'); } catch (e) {} setBusy(''); droppedRef.current = []; offerRef.current = { id: '', ts: '' }; setPending(null); setBlur(null); setNote(''); setOpenG({}); setEditAll(false); photosRef.current.forEach(x => { try { URL.revokeObjectURL(x.url); } catch (e) {} }); photoIds.current = new WeakMap(); setPhotos([]); setZoom(false); setD({ internet: [], tarife: [], geraete: [], einmalig: '', monatlich: '', hinweis: '', beratungsId: '' }); };
  const modeBtns = (camOk || snipOk) ? h('div', { className: 'flex gap-2 mt-2' }, [['ganz', 'Foto']].concat(camOk ? [['scan', 'Scannen']] : [], snipOk ? [['snip', 'Bildschirm']] : []).map(([m, lbl]) =>
        h('button', { key: m, onClick: () => setMode(m), className: 'flex-1 px-3 py-2 rounded-lg font-black text-sm border ' + (eff === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-300') }, lbl))) : null;
  const optChecks = quick ? null : h(React.Fragment, null, h('label', { className: 'flex items-center gap-2 mt-2 text-xs font-bold text-slate-500' },
        h('input', { type: 'checkbox', checked: alwaysCrop, onChange: e => toggleAlwaysCrop(e.target.checked) }), 'Foto vor dem Lesen immer zuschneiden'),
      h('label', { className: 'flex items-center gap-2 mt-1 text-xs font-bold text-slate-500' },
        h('input', { type: 'checkbox', checked: ownCam, onChange: e => toggleOwnCam(e.target.checked) }), 'Kamera mit Rahmen und Auto-Auslöser (statt Kamera-App)'));
  const busyEl = busy ? h('div', { className: 'mt-3 rounded-lg bg-blue-50 text-blue-800 text-sm font-bold p-3 flex items-center justify-between gap-2', role: 'status' },
        h('span', { className: 'flex-1 text-center' }, busy),
        h('button', { onClick: cancelRead, className: 'px-3 py-2 rounded-lg border border-blue-300 bg-white text-blue-800 font-black text-sm' }, '✕ Abbrechen')) : null;
  const blurEl = blur ? h('div', { className: 'mt-3 rounded-xl bg-amber-50 border border-amber-300 p-3' },
        h('div', { className: 'text-sm font-black text-amber-900' }, blur.dark ? 'Foto ist zu dunkel.' : 'Foto ist unscharf. Bitte Kamera ruhig halten und erneut fotografieren.'),
        h('div', { className: 'text-xs font-bold text-amber-800 mt-1' }, blur.dark ? 'Mehr Licht, oder den Bildschirm heller stellen – oder „Trotzdem lesen“.' : 'Näher heran, mit beiden Händen halten und kurz scharfstellen lassen – oder „Trotzdem lesen“.'),
        h('div', { className: 'flex gap-2 mt-2' },
          h('button', { onClick: () => { const b = blur; setBlur(null); pick(b.stage, libModeRef.current); }, className: sBtn }, '📷 Neu aufnehmen'),
          h('button', { onClick: () => { const b = blur; setBlur(null); readPhoto(Promise.resolve(b.file), b.stage, b.file); }, className: gBtn }, 'Trotzdem lesen'))) : null;
  const pendingEl = pending ? h('div', { className: 'mt-3 rounded-xl bg-amber-50 border-2 border-amber-400 p-3', role: 'alert' },
        h('div', { className: 'text-sm font-black text-amber-900' }, 'Anderes Angebot erkannt'),
        h('div', { className: 'text-xs font-bold text-amber-800 mt-1' }, 'Das Foto gehört nicht zum bisherigen Angebot (Beratungs-ID bzw. Erstellzeit weichen ab). Es wird nicht automatisch vermischt.'),
        h('div', { className: 'flex flex-wrap gap-2 mt-2' },
          h('button', { onClick: () => pendingGo('replace'), className: sBtn }, 'Neues Angebot – bisherige Angaben ersetzen'),
          h('button', { onClick: () => pendingGo('merge'), className: gBtn }, 'Trotzdem zusammenführen'),
          h('button', { onClick: () => pendingGo('drop'), className: gBtn }, 'Foto verwerfen'))) : null;
  const noteEl = note ? h('div', { className: 'mt-3 text-sm font-bold ' + (/fehlgeschlagen/.test(note) ? 'text-red-600' : /^✓/.test(note) ? 'text-green-700' : 'text-amber-700') }, compact ? String(note).replace(/oder unten (?:von Hand )?eintragen/, 'oder über „Bearbeiten“ eintragen') : note) : null;
  const seenEl = note && !/^✓/.test(note) && seen ? h('details', { className: 'mt-1 text-xs text-slate-500' }, h('summary', { className: 'cursor-pointer font-bold' }, 'Was die App gelesen hat'), h('pre', { className: 'whitespace-pre-wrap mt-1 p-2 rounded bg-slate-50 border border-slate-200', style: { maxHeight: 160, overflow: 'auto' } }, String(seen).slice(0, 1500))) : null;
  const stat = () => {
        const c = psO2Check(d), hasK = !!(d.einmalig && d.monatlich), okS = !!c && [c.e, c.m].every(x => !x || x.ok), done2 = hasK && (okS || !c);
        const more = !!c && [c.e, c.m].some(x => x && !x.ok && !x.incomplete && x.val > Math.max.apply(null, x.calc));
        const inc = !!c && [c.e, c.m].some(x => x && !x.ok && x.incomplete);
        const msg = !d.einmalig && !d.monatlich ? 'Gesamtkosten fehlen noch – Kostenblock fotografieren (Liste am PC weiterscrollen) oder unten eintragen.' : !hasK ? 'Nur die ' + (d.einmalig ? 'einmaligen' : 'monatlichen') + ' Gesamtkosten gelesen – die ' + (d.einmalig ? 'monatlichen' : 'einmaligen') + ' bitte ergänzen.' : okS ? '✓ Summen stimmen – fertig.' : inc ? '⚠ Einige Angaben benötigen eine Kontrolle: bei einem Tarif fehlt der Einzelpreis, die gelesene Summe bleibt stehen.' : more ? '⚠ Es fehlen noch Einträge (Summe höher als gelesen) – Liste am PC weiterscrollen und weiteres Foto machen.' : c ? '⚠ Summen passen noch nicht – bitte unten prüfen.' : 'Kostenblock gelesen – bitte kurz prüfen.';
    return { c, hasK, okS, done2, msg };
  };
  const costSuggest = () => {
          const sg = psO2Suggest(d);
          return sg ? h('div', { className: 'mt-2 flex flex-wrap items-center gap-1 text-xs font-bold text-amber-800' },
            h('span', null, 'Summe nicht gelesen – Einzelpreise ergeben:'),
            [['einmalig', 'einmalig'], ['monatlich', 'monatlich']].filter(x => sg[x[0]]).map(([f, l]) => sg[f].map(v => h('button', { key: f + v, onClick: () => setD(p => ({ ...p, [f]: psO2Fmt(v) })), className: 'px-2 py-1 rounded-md bg-white border border-amber-400 text-amber-900 font-black' }, l + ' ' + psO2Fmt(v) + ' €'))),
            h('span', null, '(nur Vorschlag – bitte prüfen)')) : null;
  };
  const costCheck = onlyBad => {
          const c = psO2Check(d);
          if (!c) return null;
          const bad = [['einmalig', 'Einmalig', c.e], ['monatlich', 'Monatlich', c.m]].filter(x => x[2] && !x[2].ok);
          if (!bad.length) return onlyBad ? null : h('div', { className: 'mt-2 text-xs font-bold text-green-700' }, '✓ Summen stimmen mit den Einzelpreisen überein');
          return h('div', { className: 'mt-2 rounded-lg bg-amber-50 border border-amber-300 p-2 text-xs font-bold text-amber-800' },
            bad.map(([f, lbl, r]) => r.incomplete
              ? h('div', { key: f, className: 'py-0.5' }, lbl + ': gelesen ' + psO2Fmt(r.val) + ' € – bei einem Tarif fehlt der Einzelpreis, die Summe lässt sich nicht prüfen (bitte Preis ' + (onlyBad ? 'im Produkt' : 'oben') + ' ergänzen).')
              : r.val > Math.max.apply(null, r.calc)
              // Kostenblock hoeher als alles Gelesene: vermutlich fehlt noch ein Tarif / Handy / Internet@Home
              ? h('div', { key: f, className: 'py-0.5' }, lbl + ': Kostenblock ' + psO2Fmt(r.val) + ' €, Einzelpreise ergeben bisher ' + psO2Fmt(Math.max.apply(null, r.calc)) + ' € – fehlt noch ein Tarif, Handy oder Internet@Home?')
              : h('div', { key: f, className: 'flex flex-wrap items-center gap-1 py-0.5' },
                h('span', null, lbl + ': gelesen ' + psO2Fmt(r.val) + ' €, Einzelpreise ergeben'),
                r.calc.map(v => h('button', { key: v, onClick: () => setD(p => ({ ...p, [f]: psO2Fmt(v) })), className: 'px-2 py-1 rounded-md bg-white border border-amber-400 text-amber-900 font-black' }, psO2Fmt(v) + ' €')),
                h('span', null, '– bitte prüfen'))));
  };
  const editor = () => h(React.Fragment, null,
      sec('HANDY', d.geraete.length, 'geraete', '📷 + Handy', d.geraete.length >= PS_O2_MAX.geraete, groups('geraete').map(g => item('geraete', g, 'Handy')), PS_O2_MAX.geraete),
      sec('TARIF', d.tarife.length, 'tarife', '📷 + Tarif', d.tarife.length >= PS_O2_MAX.tarife, groups('tarife').map(g => item('tarife', g, 'Tarif')), PS_O2_MAX.tarife),
      sec('INTERNET@HOME', d.internet.length, 'internet', d.internet.length ? '📷 + Internet@Home' : '📷 Internet@Home', d.internet.length >= PS_O2_MAX.internet, groups('internet').map(g => item('internet', g, 'Internet@Home')), PS_O2_MAX.internet),
      sec('KOSTENBLOCK', 0, 'kosten', '📷 Kosten', false, h('div', null,
        h('div', { className: 'flex gap-3 mt-2' },
          h('div', { className: 'flex-1' }, h('div', { className: 'text-[11px] font-black text-slate-500 mb-1' }, 'EINMALIGE KOSTEN (€)'), inp(d.einmalig, v => setD(p => ({ ...p, einmalig: money(v) })), 'Offen', true)),
          h('div', { className: 'flex-1' }, h('div', { className: 'text-[11px] font-black text-slate-500 mb-1' }, 'MONATLICHE KOSTEN (€)'), inp(d.monatlich, v => setD(p => ({ ...p, monatlich: money(v) })), 'Offen', true))),
        costSuggest(),
        costCheck(false),
        h('div', { className: 'mt-2' }, inp(d.hinweis, v => setD(p => ({ ...p, hinweis: v })), 'Hinweis (optional, wird nur bei Eingabe in die Karte geschrieben)')))));
  // v56.0-beta.4: Foto merken / entfernen, Aktionskarte pro Eintrag
  const addPhoto = file => {
    try {
      if (!file || photoIds.current.has(file)) return;
      const id = ++photoSeq.current; photoIds.current.set(file, id);
      psO2Thumb(file).then(url => {
        if (!url) return;
        if (!aliveRef.current) { URL.revokeObjectURL(url); return; }
        setPhotos(p => { const n = p.concat([{ id, url }]); while (n.length > 6) URL.revokeObjectURL(n.shift().url); return n; });
        setPhotoSel(id); setZoom(false);
      }).catch(() => {});
    } catch (e) {}
  };
  const dropPhoto = f => { const id = photoIds.current.get(f); if (!id) return; setPhotos(p => p.filter(x => { if (x.id !== id) return true; try { URL.revokeObjectURL(x.url); } catch (e) {} return false; })); };
  const keepPhoto = f => { const id = photoIds.current.get(f); setPhotos(p => p.filter(x => { if (x.id === id) return true; try { URL.revokeObjectURL(x.url); } catch (e) {} return false; })); };
  // Aktionskarte schaltet immer nur EINEN Eintrag um (bei "2×" der letzte): so bleibt ein Haupttarif, die Gruppe teilt sich auf
  const toggleAk = idxs => { const j = idxs[idxs.length - 1]; setItem('tarife', j, 'ak', !d.tarife[j].ak); };
  // Originalfoto (links in der Vollansicht): Antippen = vergroessern, bei mehreren Fotos Vorschaubilder unten
  const photoPanel = () => {
    const cur = photos.find(x => x.id === photoSel) || photos[photos.length - 1];
    return h(React.Fragment, null,
      h('div', { className: 'flex items-center justify-between gap-2 mb-2 flex-none' },
        h('div', { className: 'text-sm font-black tracking-wide text-slate-500' }, 'ORIGINALFOTO' + (photos.length > 1 ? ' · ' + (photos.indexOf(cur) + 1) + '/' + photos.length : '')),
        h('button', { onClick: () => setZoom(z => !z), 'aria-pressed': zoom, className: 'px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-bold text-slate-600' }, zoom ? 'Einpassen' : 'Vergrößern')),
      h('div', { className: 'flex-1 min-h-0 rounded-2xl bg-white border border-slate-200 relative ' + (zoom ? 'overflow-auto' : 'overflow-hidden') },
        zoom
          ? h('img', { src: cur.url, alt: 'Originalfoto', onClick: () => setZoom(false), style: { width: '230%', maxWidth: 'none', height: 'auto', display: 'block' } })
          : h('img', { src: cur.url, alt: 'Originalfoto', onClick: () => setZoom(true), style: { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', cursor: 'zoom-in' } })),
      photos.length > 1 ? h('div', { className: 'flex gap-2 mt-2 overflow-x-auto flex-none' }, photos.map((p, i) =>
        h('button', { key: p.id, onClick: () => { setPhotoSel(p.id); setZoom(false); }, 'aria-label': 'Foto ' + (i + 1), className: 'w-16 h-16 rounded-lg overflow-hidden border-2 flex-none ' + (p.id === cur.id ? 'border-blue-600' : 'border-slate-200') },
          h('img', { src: p.url, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } })))) : null);
  };
  // v56.0-beta.3/4: Kompaktansicht – Status, Summen, erkannte Produkte als Karten; "Bearbeiten" zeigt die bisherigen Felder.
  // Liefert { body, foot }: Hochformat = untereinander, Vollansicht (Querformat) = Inhalt scrollt, Fuss bleibt unten stehen.
  const compactParts = full => {
    const st = stat(), ok = st.hasK && st.okS;
    const cat = { geraete: ['SMARTPHONE', 'phone', 'Handy'], tarife: ['MOBILFUNK', 'signal', 'Tarif'], internet: ['INTERNET@HOME', 'wifi', 'Internet@Home'] };
    const title = ok ? 'Angebot erfolgreich erkannt' : !d.einmalig && !d.monatlich ? 'Gesamtkosten fehlen noch' : 'Bitte kurz prüfen';
    const unten = t => String(t).replace(/oder unten (?:von Hand )?eintragen/, 'oder über „Bearbeiten“ eintragen').replace(/bitte unten prüfen/, 'bitte prüfen');
    const sub = ok ? nItems + (nItems === 1 ? ' Produkt' : ' Produkte') + ' erkannt · Summen stimmen überein' : unten(String(st.msg).replace(/^⚠\s*/, ''));
    const showNote = note && !(ok && /^✓ Erkennung abgeschlossen[^·]*$/.test(note));
    const outBtn = 'flex items-center justify-center gap-2 px-3 ' + (full ? 'py-3.5' : 'py-3.5') + ' rounded-2xl border border-slate-300 bg-white text-blue-600 font-bold text-base disabled:opacity-50';
    const simOk = d.tarife.length > 1;
    const cards = h('div', { className: 'mt-2 space-y-2.5' }, [].concat.apply([], ['geraete', 'tarife', 'internet'].map(key => groups(key).map(g => {
      const it = d[key][g[0]], n = g.length, id = key + g[0], open = !!openG[id], tx = psO2CardText(key, it), cc = cat[key];
      const miss = !it.am || !it.am[0] || (key !== 'geraete' && !it.am[1]);
      return h('div', { key: id, className: 'rounded-2xl border bg-white ' + (miss ? 'border-amber-300' : 'border-slate-200') },
        h('div', { className: 'flex items-center' },
          h('button', { onClick: () => setOpenG(p => ({ ...p, [id]: !p[id] })), 'aria-expanded': open, className: 'flex-1 min-w-0 flex items-center gap-3 p-3.5 text-left' },
            h('div', { className: 'w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center flex-none' }, psO2Ico(cc[1], 24)),
            h('div', { className: 'flex-1 min-w-0' },
              h('div', { className: 'text-xs font-black tracking-wide text-blue-600' }, cc[0]),
              h('div', { className: 'flex items-center gap-2 flex-wrap' },
                h('span', { className: 'text-[17px] font-extrabold text-[#0b1e42] leading-snug break-words' }, tx.title),
                n > 1 ? h('span', { className: 'px-2 py-0.5 rounded-full bg-blue-600 text-white text-xs font-black flex-none' }, n + '×') : null,
                key === 'tarife' && it.ak ? h('span', { className: 'px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-black flex-none' }, 'Aktionskarte') : null),
              tx.sub ? h('div', { className: 'text-sm font-medium text-slate-500 break-words' }, tx.sub) : null),
            h('span', { className: miss ? 'text-amber-500' : 'text-green-600', role: 'img', 'aria-label': miss ? 'Preis prüfen' : 'erkannt' }, psO2Ico(miss ? 'alert' : 'checkc', 22)),
            h('span', { className: 'text-slate-400 ' + (open ? 'rotate-180' : '') }, psO2Ico('chev', 22))),
          key === 'tarife' && simOk ? h('div', { className: 'flex-none pr-3' },
            h('button', { onClick: () => toggleAk(g), 'aria-pressed': !!it.ak, 'aria-label': 'Aktionskarte', title: it.ak ? 'Ist Aktionskarte – antippen zum Entfernen' : 'Als Aktionskarte markieren', className: 'w-12 h-12 rounded-xl border flex items-center justify-center ' + (it.ak ? 'bg-amber-500 border-amber-500 text-white' : 'bg-white border-slate-300 text-slate-400') }, psO2Ico('sim', 26))) : null),
        open ? h('div', { className: 'px-3 pb-3' }, item(key, g, cc[2])) : null);
    }))));
    const body = h(React.Fragment, null,
      pendingEl, blurEl, busyEl,
      busy ? null : h('div', { className: 'mt-3 rounded-2xl px-4 py-3 flex items-start gap-3 ' + (ok ? 'bg-green-50' : 'bg-amber-50'), role: 'status' },
        h('span', { className: 'mt-0.5 ' + (ok ? 'text-green-600' : 'text-amber-500') }, psO2Ico(ok ? 'checkc' : 'alert', 24)),
        h('div', { className: 'min-w-0' },
          h('div', { className: 'text-lg font-black leading-tight ' + (ok ? 'text-green-700' : 'text-amber-900') }, title),
          h('div', { className: 'text-sm font-semibold mt-0.5 ' + (ok ? 'text-green-700' : 'text-amber-800') }, sub))),
      showNote ? noteEl : null, showNote ? seenEl : null,
      h('div', { className: 'mt-3 grid grid-cols-2 gap-3' }, [['Einmalige Gesamtkosten', d.einmalig, 'text-[#0b1e42]'], ['Monatliche Gesamtkosten', d.monatlich, 'text-blue-600']].map(([l, v, col]) =>
        h('div', { key: l, className: 'rounded-2xl bg-[#eef3fc] px-4 py-3 min-w-0' },
          h('div', { className: 'text-sm font-semibold text-slate-500' }, l),
          h('div', { className: 'text-3xl font-black tabular-nums leading-tight mt-0.5 ' + (v ? col : 'text-slate-400') }, v ? v + ' €' : 'Offen')))),
      ok ? null : h('div', null, costSuggest(), costCheck(true)),
      h('div', { className: 'mt-5 flex items-center justify-between gap-2' },
        h('div', { className: 'text-base font-black text-[#0b1e42]' }, 'Erkannte Produkte (' + nItems + ')'),
        h('button', { onClick: () => setEditAll(v => !v), 'aria-pressed': editAll, className: 'flex items-center gap-1.5 px-2 py-2 text-sm font-bold text-blue-600' }, editAll ? 'Fertig' : 'Bearbeiten', psO2Ico(editAll ? 'check' : 'pencil', 16))),
      simOk && d.tarife.every(t => t.ak) ? h('div', { className: 'mt-1 rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-xs font-bold text-amber-800' }, 'Aktionskarte: mindestens ein Tarif muss Haupttarif bleiben – sonst hat die Markierung keine Wirkung.') : null,
      editAll ? editor() : cards,
      had ? h('div', { className: 'mt-3 text-xs font-semibold text-slate-500 text-center' }, 'Beim Übernehmen werden die Angebotskarten neu geschrieben.') : null);
    const camBtn = h('button', { onClick: () => scanMode ? openScan() : pick('ganz', false), disabled: !!busy, className: outBtn }, psO2Ico('camera', 20), scanMode ? 'Weiter scannen' : 'Weiteres Foto');
    const upBtn = h('button', { onClick: () => pick('ganz', true), disabled: !!busy, className: outBtn }, psO2Ico('upload', 20), 'Hochladen');
    const applyBtn = h('button', { onClick: () => onApply(d), disabled: !!busy || !any, className: 'w-full ' + (full ? '' : 'mt-3 ') + 'py-4 rounded-2xl bg-blue-600 text-white font-black text-lg flex items-center justify-center gap-2 disabled:opacity-50' }, psO2Ico('check', 22), 'Angebot übernehmen');
    const links = h('div', { className: full ? 'flex items-center text-sm font-medium text-slate-500' : 'mt-3 text-center text-sm font-medium text-slate-500' },
      h('button', { onClick: resetAll, className: 'px-2 py-2' }, 'Neu beginnen'), ' · ',
      h('button', { onClick: () => setShowSet(v => !v), 'aria-expanded': showSet, className: 'px-2 py-2' }, 'Scan-Einstellungen'));
    const shield = h('div', { className: full ? 'flex items-center gap-1.5 text-sm font-medium text-slate-500' : 'mt-4 flex items-center justify-center gap-1.5 text-sm font-medium text-slate-500' }, psO2Ico('shield', 16), 'Verarbeitung direkt auf deinem Gerät');
    const settings = showSet ? h('div', { className: 'mt-1 rounded-2xl border border-slate-200 bg-slate-50 p-3' },
      h('div', { className: 'text-xs font-black tracking-wide text-slate-500' }, 'SCAN-EINSTELLUNGEN'),
      modeBtns, optChecks) : null;
    const foot = full
      ? h(React.Fragment, null,
        h('div', { className: 'grid gap-3', style: { gridTemplateColumns: '1fr 1fr 1.7fr' } }, camBtn, upBtn, applyBtn),
        h('div', { className: 'mt-1 flex items-center justify-between gap-3' }, shield, links),
        settings)
      : h(React.Fragment, null,
        shield,
        h('div', { className: 'mt-4 border-t border-slate-200' }),
        h('div', { className: 'grid grid-cols-2 gap-3 mt-4' }, camBtn, upBtn),
        applyBtn, links, settings);
    return { body, foot };
  };
  const sharedEls = [
      crop ? h(PsO2Crop, { key: 'crop', file: crop.file, hint: crop.auto ? 'Nicht gut lesbar – bitte nur den Bereich einrahmen (Ecken ziehen, schräg ist ok)' : '',
        onOk: p => { const st = crop.stage; setCrop(null); readPhoto(p, st); },
        onSkip: () => { const c = crop; setCrop(null); readPhoto(Promise.resolve(c.file), c.stage); },
        onCancel: () => setCrop(null),
        onRetake: () => { const st = crop.stage, lib = libModeRef.current; setCrop(null); pick(st, lib); } }) : null,
      h('input', { ref: camRef, type: 'file', accept: 'image/*, application/pdf', capture: 'environment', hidden: true, onChange: onFile, 'aria-label': 'Foto aufnehmen' }),
      h('input', { ref: libRef, type: 'file', accept: 'image/*', hidden: true, onChange: onFile, 'aria-label': 'Foto auswählen' }),
  ];
  const headerInner = [
    h('div', { key: 'i', className: 'w-11 h-11 rounded-xl bg-blue-600 text-white flex items-center justify-center flex-none' }, psO2Ico('scan', 24)),
    h('div', { key: 't', className: 'flex-1 min-w-0' },
      h('div', { className: 'text-xl font-black text-[#0b1e42] leading-tight' }, 'Smart Scan 2'),
      h('div', { className: 'text-sm font-medium text-slate-500' }, (had ? 'o2-Vorschlag bearbeiten' : 'o2-Angebotsimport') + ' · Lokale KI')),
    any && !compact ? h('button', { key: 'n', onClick: resetAll, className: 'text-xs font-bold text-slate-500 underline px-2 py-2' }, 'Neu beginnen') : null,
    h('button', { key: 'c', onClick: closeTap, 'aria-label': askClose ? 'Wirklich verwerfen?' : 'Schließen', className: askClose ? 'px-3 py-2 rounded-xl bg-red-600 text-white font-black text-sm' : 'w-10 h-10 rounded-full text-slate-500 flex items-center justify-center' }, askClose ? 'Verwerfen?' : psO2Ico('x', 22))
  ];
  const hadNoteEl = had && !compact ? h('div', { className: 'mt-2 rounded-lg bg-slate-50 border border-slate-200 p-2 text-sm font-bold text-slate-700' }, 'Einträge unten direkt korrigieren oder ein weiteres Foto machen – dann „Ins Angebot übernehmen“: die Karten werden neu geschrieben.') : null;
  // bisherige Ansicht (noch nichts erkannt: Foto aufnehmen, Bereiche, Kostenblock von Hand)
  const legacyEl = () => h(React.Fragment, null,
      scanOk ? h('button', { onClick: () => scanQr(false), disabled: !!busy, className: sBtn + ' w-full mt-2 py-4 text-base' }, '📲 Vom PC scannen') : null,
      scanOk ? h('div', { className: 'text-xs text-slate-500 mt-1 text-center' }, 'Am PC erscheint der QR-Code, sobald dort der Bildschirm gelesen wurde. Oder selbst fotografieren:') : null,
      modeBtns,
      h('div', { className: 'text-sm text-slate-600 mt-2' }, snipMode
        ? 'Beim ersten Mal im Reiter „Fenster“ das Edge der Windows App wählen (Edge-Symbol mit kleinem Windows-Logo) und „Teilen“ – Pencil Selling bleibt vorn. Danach wird der Vorschlag sofort gelesen und der QR-Code erscheint.'
        : scanMode
        ? 'Tablet oben an den Vorschlag halten und langsam nach unten führen – oder Tablet ruhig halten und am PC langsam scrollen. Die Fotos macht die App selbst, beim Kostenblock ist Schluss. Auch für 2–3 Seiten.'
        : blockMode
        ? 'Je Block ein Foto (Tarif, Handy, Internet@Home), zuletzt der Kostenblock. Die Kamera bleibt offen, bis du „Fertig“ tippst. Karte 1 = Tarif 1 + Handy 1 · Karte 2 = alle weiteren · Karte 3 = Internet@Home.'
        : 'Den Vorschlag gerade von vorne fotografieren, so groß wie möglich im Rahmen. Geht er über mehrere Seiten: weiterblättern und noch ein Foto. Karte 1 = Tarif 1 + Handy 1 · Karte 2 = alle weiteren · Karte 3 = Internet@Home.'),
      !quick && !any ? photoActions(false) : null,
      !quick && any && !busy ? (() => {
        // Stand nach dem Foto: Kostenblock da und Summen stimmig -> "Fertig" gross; sonst "Weiteres Foto" gross
        const { c, hasK, okS, done2, msg } = stat();
        return h('div', { className: 'mt-3 rounded-xl border-2 p-3 ' + (done2 && okS ? 'border-green-500 bg-green-50' : 'border-blue-300 bg-blue-50') },
          h('div', { className: 'text-sm font-black ' + (done2 && okS ? 'text-green-800' : 'text-slate-800') }, msg),
          photoActions(true),
          h('div', { className: 'flex gap-2 mt-2' },
            h('button', { onClick: () => onApply(d), className: (done2 ? sBtn : gBtn) + ' flex-1 py-3 text-base' }, '✓ Fertig – übernehmen')));
      })() : null,
      snipMode && any ? h('button', { onClick: sendQr, disabled: !!busy, className: sBtn + ' w-full mt-2 py-3 text-base' }, '📲 QR-Code fürs Tablet') : null,
      snipMode ? h('button', { onClick: openSnip, disabled: !!busy, className: (any ? gBtn : sBtn) + ' w-full mt-2 py-3 text-base' }, any ? '🖥 Nochmal lesen (z. B. nach Scrollen)' : '🖥 Bildschirm lesen') : null,
      snipMode && psO2SnipLive() ? h('div', { className: 'mt-2 flex justify-center gap-4 text-xs font-bold text-slate-500' },
        h('button', { onClick: () => { psO2SnipStop(); openSnip(); }, disabled: !!busy, className: 'underline' }, 'Anderes Fenster wählen'),
        h('button', { onClick: () => { psO2SnipStop(); setNote('Freigabe beendet.'); }, className: 'underline text-slate-400' }, 'Freigabe beenden')) : null,
      scanMode ? h('button', { onClick: openScan, disabled: !!busy, className: sBtn + ' w-full mt-2 py-4 text-base' }, any ? '📷 Weiter scannen' : '📷 Scannen starten') : null,
      blockMode ? h('button', { onClick: () => openBlocks('block'), disabled: !!busy, className: sBtn + ' w-full mt-2 py-3 text-base' }, d.tarife.length || d.geraete.length || d.internet.length ? '📷 Weitere Blöcke fotografieren' : '📷 Block-Fotos starten') : null,
      optChecks,
      busyEl, blurEl, pendingEl, noteEl, seenEl,
      any ? h('div', { className: 'mt-3 grid grid-cols-2 gap-2 rounded-xl bg-[#0b1e42] p-3 text-white' },
         [['Einmalig', d.einmalig], ['Monatlich', d.monatlich]].map(([lbl, val]) => h('div', { key: lbl, className: 'min-w-0' }, h('div', { className: 'text-xs font-bold text-blue-100' }, lbl + ' gesamt'), h('div', { className: 'text-xl font-black tabular-nums' }, val ? val + ' €' : 'Offen')))) : null,
      editor(),
      h('div', { className: 'flex gap-2 mt-4' },
        h('button', { onClick: closeTap, className: 'px-4 py-3 rounded-lg border font-bold text-sm ' + (askClose ? 'border-red-500 bg-red-600 text-white' : 'border-slate-300 text-slate-600') }, askClose ? 'Wirklich verwerfen?' : 'Abbrechen'),
        h('button', { onClick: () => onApply(d), disabled: !!busy || !any, className: 'flex-1 px-4 py-3 rounded-lg bg-blue-600 text-white font-black text-sm disabled:opacity-50' }, 'Ins Angebot übernehmen')));
  const full = wide && photos.length > 0;
  const parts = compact ? compactParts(full) : null;
  return h('div', { className: 'fixed inset-0 flex items-center justify-center' + (full ? '' : ' p-3'), style: { zIndex: 100002, background: 'rgba(15,23,42,0.6)' } },
    full
      ? h('div', { className: 'bg-white w-full h-full flex flex-col', style: { overflow: 'hidden' } },
        h('div', { className: 'flex items-center gap-3 px-5 py-3 border-b border-slate-200 flex-none' }, ...headerInner),
        h('div', { className: 'flex-1 min-h-0 flex' },
          h('div', { className: 'flex-none bg-slate-100 border-r border-slate-200 p-4 min-h-0 flex flex-col', style: { width: '46%' } }, photoPanel()),
          h('div', { className: 'flex-1 min-w-0 min-h-0 flex flex-col' },
            h('div', { className: 'flex-1 min-h-0 overflow-y-auto px-5 pt-1 pb-4' }, hadNoteEl, parts ? parts.body : legacyEl()),
            parts ? h('div', { className: 'flex-none border-t border-slate-200 bg-white px-5 py-3' }, parts.foot) : null)),
        ...sharedEls)
      : h('div', { className: 'bg-white rounded-3xl shadow-2xl p-5 w-full', style: { maxWidth: 640, maxHeight: '94vh', overflowY: 'auto' } },
        h('div', { className: 'flex items-center gap-3' }, ...headerInner),
        hadNoteEl,
        ...sharedEls,
        parts ? h(React.Fragment, null, parts.body, parts.foot) : legacyEl()));
}
