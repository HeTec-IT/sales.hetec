/*
 * Smart Scan – engine.js
 * OCR-Engine-Steuerung: Tesseract-Worker (selbst gehostet), Zeitbudget, Abbruch, Wiederholungen, lokale Erkennung (psO2ReadLocal).
 *
 * Klassisches Skript (globale Funktionen wie bisher in index.html), geladen vor der App.
 * Ausgelagert aus index.html (v56.0-beta.4) ohne inhaltliche Änderung; Cloud-OCR entfernt.
 */
// === v55.224: ROBUSTE, BEGRENZTE UND ABBRECHBARE ERKENNUNG ====================================================
// Vorher: zwei Arbeiter, zwei Durchgaenge parallel per Promise.all (haengt einer, haengen beide), Skript-Laden und Neuaufbau eines Arbeiters
// ohne Zeitlimit, kein Abbruch durch den Benutzer, Arbeiter wurden nie freigegeben. Jetzt: ein wiederverwendeter Arbeiter, jede Phase mit
// Zeitlimit, ein Gesamtbudget, ein haengender Arbeiter wird wirklich beendet (terminate) und bei Bedarf neu aufgebaut, ein Abbruch
// (Benutzer / neue Aufnahme / Dialog zu) wirkt sofort, und ein alter Durchgang kann nie ein neues Ergebnis ueberschreiben.
const PS_O2_TESS_SRC = window.PS_VENDOR.tesseractScript; // selbst gehostet (vendor/tesseract)
// script = Skript laden, workerCold = erster Aufbau (Sprachdaten laden), workerWarm = Wiederaufbau (Sprachdaten im Cache),
// cloud = Anfrage an den Dienst (Token + Bild + Antwort), total = Obergrenze fuer den ganzen Vorgang (Dienst + Geraet),
// pass = ein Lesedurchgang, budget = alles zusammen, minPass = kuerzeste sinnvolle Restzeit fuer einen weiteren Durchgang
const PS_O2_T = { script: 15000, workerCold: 30000, workerWarm: 12000, pass: 25000, budget: 32000, minPass: 4000, cloud: 22000, total: 45000 };
// Durchgaenge: 1 = Standard (1600 px). 2 nur bei Luecken: anderer Massstab (Moire entsteht je nach Massstab anders). 3 nur bei Luecken: entrauscht.
// Nach einem Timeout geht es mit einer leichteren Variante (weniger Pixel) weiter statt mit demselben Aufwand noch einmal.
// Reihenfolge nach Messung an echten/verschlechterten Fotos: 2. Durchgang = entrauscht (Moire/Kompression), 3. = entrauscht + lokaler Schwellwert (Spiegelung).
// Liefert Durchgang 1 nichts und dafuer sehr viele Schein-Woerter (Reflex/Moire/Rauschen), kommt der Schwellwert-Durchgang direkt als 2.
const PS_O2_PLAN_ADAPT = { side: 1600, blur: 1, adapt: true, psm: 6 }; // entrauscht + lokaler Schwellwert: rettet Spiegelungen/Reflexe, an denen die globale Binarisierung scheitert
const PS_O2_PLAN = [{ side: 1600, blur: 0, psm: 6 }, { side: 1280, blur: 2, paper: true, psm: 11 }, PS_O2_PLAN_ADAPT];
const PS_O2_PLAN_LIGHT = { side: 1200, blur: 1, psm: 6 };
// v55.227: Moiré (Streifen beim Foto vom Monitor): ungeglaettet wird daraus Zeichensalat (viele "Woerter", nichts zuordenbar) -> leicht geglaettet, gross
const PS_O2_PLAN_MOIRE = { side: 2000, blur: 1, psm: 6 };
const psO2Tick = () => new Promise(r => setTimeout(r, 0));
function psO2WithTimeout(p, ms, tag) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(tag || 'timeout'), { psTimeout: true })), ms); });
  return Promise.race([p, to]).then(v => { clearTimeout(t); return v; }, e => { clearTimeout(t); throw e; });
}
let __psO2W = null, __psO2WP = null, __psO2Gen = 0, __psO2Job = null, __psO2JobSeq = 0;
function psO2Kill(w) { try { const p = w && w.terminate && w.terminate(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }
// Arbeiter verwerfen (haengt / abgestuerzt / Dialog zu): der Thread wird wirklich beendet, der naechste Zugriff baut neu auf.
function psO2ResetEngine() { __psO2Gen++; const w = __psO2W; __psO2W = null; __psO2WP = null; psO2Kill(w); }
function psO2Release() { if (__psO2Job && !__psO2Job.done) __psO2Job.cancel('release'); psO2ResetEngine(); psSmartStop('release'); }
function psO2LoadTess() {
  if (window.Tesseract) return Promise.resolve();
  return psO2WithTimeout(psPortLoadScript(PS_O2_TESS_SRC), PS_O2_T.script, 'script-timeout').catch(e => {
    // haengendes Skript-Element entfernen, damit der naechste Versuch neu laedt statt ewig am alten zu warten
    try { document.querySelectorAll('script[data-psport="' + PS_O2_TESS_SRC + '"]').forEach(sc => { if (!sc.dataset.done) sc.remove(); }); } catch (x) {}
    throw e;
  });
}
// Der eine Arbeiter. Ein laufender Aufbau wird geteilt (kein zweiter Aufbau), jeder Aufruf wartet hoechstens ms.
function psO2Worker(ms) {
  if (__psO2W) return Promise.resolve(__psO2W);
  if (!__psO2WP) {
    const gen = __psO2Gen;
    __psO2WP = psO2LoadTess().then(() => window.Tesseract.createWorker('deu', 1, window.PS_VENDOR.tesseractOptions())).then(w => {
      if (gen !== __psO2Gen) { psO2Kill(w); throw new Error('released'); } // inzwischen verworfen: nicht mehr verwenden
      __psO2W = w; __psO2WP = null; return w;
    }, e => { if (gen === __psO2Gen) __psO2WP = null; throw e; });
    __psO2WP.catch(() => {});
  }
  return psO2WithTimeout(__psO2WP, ms, 'worker-timeout');
}
// Texterkennung schon beim Oeffnen des Dialogs laden, damit das erste Foto nicht darauf wartet (Fehler sind hier egal).
const psO2NeuralOn = () => typeof Worker !== 'undefined' && !!(window.PS_SMART_SCAN && window.PS_SMART_SCAN.neural);
function psO2Warm() { return !psO2NeuralOn() ? psO2Worker(PS_O2_T.workerCold).catch(()=>null) : psSmartWarm(); }
// Eine Erkennung ("Job"). Eine neue Erkennung bricht eine noch laufende alte ab; cancel() wirkt sofort und beendet einen haengenden Arbeiter.
function psO2NewJob() {
  if (__psO2Job && !__psO2Job.done) __psO2Job.cancel('replaced');
  const job = { id: ++__psO2JobSeq, cancelled: false, done: false, why: '', inBuild: false, inRecog: false };
  job.cancelP = new Promise((_, rej) => { job.rej = rej; });
  job.cancelP.catch(() => {});
  job.cancel = why => {
    if (job.cancelled || job.done) return;
    job.cancelled = true; job.why = why || 'cancel';
    job.rej(Object.assign(new Error('cancelled'), { psCancel: true }));
    if (job.inBuild || job.inRecog) psO2ResetEngine();
    if(job.inNeural)psSmartStop('cancelled');
  };
  __psO2Job = job;
  return job;
}
const psO2Err = (kind, msg) => Object.assign(new Error(msg || kind), { psKind: kind });
// Ein Lesedurchgang. Wirft psCancel (abgebrochen) oder psKind: 'image' (Foto nicht lesbar), 'engine' (Texterkennung nicht startbar/abgestuerzt),
// 'timeout' (Durchgang zu langsam). Bei engine/timeout wird der Arbeiter beendet, damit er nicht weiterrechnet und neu aufgebaut werden kann.
async function psO2Pass(job, src, v, T, left, say, hooks) {
  const t0 = Date.now(), H = hooks || {};
  const race = p => Promise.race([p, job.cancelP]);
  const chk = () => { if (job.cancelled) throw Object.assign(new Error('cancelled'), { psCancel: true }); };
  chk();
  say && say('prep');
  let c;
  try { c = await race((H.prepare || psO2Prepare)(src, v)); }
  catch (e) { if (e && e.psCancel) throw e; throw psO2Err('image', e && e.message); }
  chk(); await race(psO2Tick()); chk();
  say && say('read');
  let w;
  job.inBuild = true;
  try { w = await race(psO2Worker(__psO2W ? T.workerWarm : T.workerCold)); }
  catch (e) { if (e && e.psCancel) throw e; psO2ResetEngine(); throw psO2Err('engine', e && e.message); }
  finally { job.inBuild = false; }
  chk();
  job.inRecog = true;
  let r;
  try {
    await race(psO2WithTimeout(w.setParameters({ tessedit_pageseg_mode: String(v.psm || 6), tessedit_do_invert: '0' }), 5000, 'param-timeout'));
    r = await race(psO2WithTimeout(w.recognize(c, {}, { text: true, blocks: true, hocr: false, tsv: false }), Math.max(2000, Math.min(T.pass, left)), 'pass-timeout'));
  } catch (e) {
    job.inRecog = false;
    if (e && e.psCancel) throw e;
    psO2ResetEngine();
    throw psO2Err(e && e.psTimeout ? 'timeout' : 'engine', e && e.message);
  }
  job.inRecog = false;
  chk();
  const data = r && r.data ? r.data : {};
  return { sparse: v.psm === 11, text: data.text || '', words: psO2WordsOf(data), ms: Date.now() - t0 };
}
// Lokales Lesen mit Smart-Retry (v55.224). Durchgang 1 = Standard. Weitere Durchgaenge nur, wenn etwas Sichtbares fehlt (Eintrag, Summe,
// Summen passen nicht, mehr Bloecke im Bild als gelesen) oder ein Name nach Lesemuell aussieht - und nur solange das Zeitbudget reicht.
// Jeder Durchgang wird einmal zeilenweise und einmal nach Position ausgewertet (das bessere gilt); die Durchgaenge werden eintragsweise
// zusammengefuehrt, ein spaeterer schwacher Durchgang loescht nie ein Ergebnis eines fruehren.
// Ergebnis: { r, txt, fail, timedOut, ms, tries, cancelled }; fail ('timeout' | 'engine' | 'image' | 'cancelled') nur, wenn gar nichts gelesen werden konnte.
async function psO2ReadLocal(file, onMsg, isDone, opts) {
  opts = opts || {};
  const T = Object.assign({}, PS_O2_T, opts.t || {}), H = opts.hooks || {};
  const smart = !opts.hooks && psO2NeuralOn();
  if(smart)T.budget=Math.min(T.budget,(window.PS_SMART_SCAN && window.PS_SMART_SCAN.totalBudgetMs) || 12000);
  const job = opts.job || psO2NewJob();
  const t0 = Date.now(), res = [];
  let txt = '', r = null, fail = '', timedOut = false, lastMs = 0, tries = 0, src = null, prevScore = -99, prevFill = -1, rawAll = '';
  const left = () => T.budget - (Date.now() - t0);
  const say = k => { if (!onMsg) return; onMsg(k === 'prep' ? 'Foto wird vorbereitet …' : k === 'read' ? (tries > 1 ? 'Text wird erkannt – weiterer Durchgang …' : 'Text wird erkannt …') : k); };
  const empty = () => ({ tarife: [], geraete: [], internet: [], einmalig: '', monatlich: '', hinweis: '', hdr: { tarife: 0, geraete: 0, internet: 0 } });
  const take = o => {
    say('Produkte und Tarife werden zugeordnet …');
    rawAll += '\n' + (o.text || '');
    const cls = psO2Parse(o.text), pt = psO2WordsToText(o.words, o.sparse), pos = pt ? psO2Parse(pt) : null;
    psO2PlaceItems(cls, o.words); psO2PlaceItems(pos, o.words);
    const usePos = !!pos && psO2Score(pos) >= psO2Score(cls) - 1;
    // Nur der untere Teil des Belegs im Bild: die Spaltenzuordnung nach Position kann die Summen vertauschen -> dann gelten die Summen der Zeilenauswertung
    if (usePos && cls.einmalig && cls.monatlich && cls.einmalig !== cls.monatlich && (!pos.einmalig || !pos.monatlich || pos.einmalig === pos.monatlich)) { pos.einmalig = cls.einmalig; pos.monatlich = cls.monatlich; }
    txt += (res.length ? '\n--- Durchgang ' + (res.length + 1) + ' ---\n' : '') + (usePos ? pt : o.text);
    res.push(usePos ? Object.assign(pos, { byPos: true }) : cls);
    say('Preise werden geprüft …');
    r = res.length === 1 ? res[0] : psO2Combine(res);
    // v57: unplausible (vertauschte) Summen eines Einzeldurchgangs verwerfen → weiterer Durchgang bzw. Eingabe von Hand
    if (r && !psO2TotalsPlausible(r, [r])) r = Object.assign({}, r, { einmalig: '', monatlich: '' });
  };
  const hard = () => (isDone && !isDone(r)) || psO2Gaps(r, txt).length > 0 || psO2Score(r) <= 0;
  // Namen, die nach Lesemuell aussehen ("ECT 34"): ein zweiter Durchgang lohnt sich (hoechstens dieser eine)
  const soft = () => ['tarife', 'geraete', 'internet'].some(k => (r[k] || []).some(it => psO2ItemQ(k, it) < 0.8));
  try {
    try { src = await Promise.race([(H.source || psO2Source)(file), job.cancelP]); }
    catch (e) { fail = e && e.psCancel ? 'cancelled' : 'image'; }
    let plan = PS_O2_PLAN.slice();
    if(src&&smart&&!job.cancelled){
      let c=null;
      try{
        const ready=await Promise.race([psO2WithTimeout(psSmartWarm(),Math.min(1600,Math.max(1,left())),'neural-warm'),job.cancelP]);
        if(ready&&left()>4500){
          job.inNeural=true;say('Lokale KI liest den Vorschlag …');
          c=await Promise.race([psO2Prepare(src,{side:1600,blur:src.glare?1:0}),job.cancelP]);
          const blob=await Promise.race([psO2WithTimeout(new Promise((ok,no)=>c.toBlob(b=>b?ok(b):no(Error('encode')),'image/png')),Math.max(1,left()),'encode'),job.cancelP]);
          const started=Date.now(),items=await Promise.race([psO2WithTimeout(psSmartRequest('read',blob),Math.max(1,Math.min(6000,left()-2800)),'neural-read'),job.cancelP]);
          const o=psSmartLayout(items);o.ms=Date.now()-started;
          if(o.text.trim()){
            tries++;take(o);
            if(!psSmartExact(r,txt)&&(!r.einmalig||!r.monatlich)&&!psO2Gaps(r,txt).some(g=>g!=='kosten'&&g!=='summen')&&left()>2200){
              const rect=psSmartCostRegion(o,c);
              if(rect){
                psSmartStop('switch to Tesseract');
                const cut=document.createElement('canvas');cut.width=rect.width;cut.height=rect.height;
                cut.getContext('2d').drawImage(c,rect.left,rect.top,rect.width,rect.height,0,0,rect.width,rect.height);
                try{
                  job.inBuild=true;
                  const w=await Promise.race([psO2Worker(Math.max(1,left())),job.cancelP]);
                  job.inBuild=false;job.inRecog=true;
                  await Promise.race([psO2WithTimeout(w.setParameters({tessedit_pageseg_mode:'6',tessedit_do_invert:'0'}),Math.max(1,left()),'roi-param'),job.cancelP]);
                  const rr=await Promise.race([psO2WithTimeout(w.recognize(cut,{}, {text:true,blocks:false}),Math.max(1,left()),'roi-read'),job.cancelP]);
                  const q=psO2Parse(rr.data.text);tries++;
                  if(!r.einmalig&&q.einmalig)r.einmalig=q.einmalig;
                  if(!r.monatlich&&q.monatlich)r.monatlich=q.monatlich;
                  txt+='\n'+rr.data.text;
                }catch(e){psO2ResetEngine();if(e.psCancel)throw e;}
                finally{job.inBuild=job.inRecog=false;cut.width=cut.height=0;}
              }
            }
            if(psSmartExact(r,txt)&&!o.low&&!hard()&&!soft())plan=[];
          }
        }
      }catch(e){if(e&&e.psCancel)fail='cancelled';else if(job.inNeural)__psSmartCooldown=Date.now()+60000;}
      finally{job.inNeural=false;if(c)c.width=c.height=0;}
      if(plan.length){psSmartStop('fallback');if(left()<T.minPass)plan=[];}
      if(job.cancelled)plan=[];
      if(!res.length&&!plan.length&&!fail){fail='timeout';timedOut=true;}
    }

    for (let k = 0; src && k < plan.length; k++) {
      if (job.cancelled) { fail = 'cancelled'; break; }
      // langsam UND nichts Brauchbares = Rauschen: kein zweiter langer Durchgang. v55.227: ausser der Text zeigt Spuren eines Vorschlags
      // (Ueberschriften, Betraege) - dann ist es Moiré/Spiegelung, und der geglaettete Durchgang liest meist fast alles.
      if (k > 0 && psO2Score(r) <= 0 && lastMs > 8000 && !psO2Signal(txt + rawAll) && !src.glare) break;
      // Restzeit reicht fuer keinen weiteren Durchgang (ohne Ergebnis darf er knapper sein: der entrauschte 2. Durchgang ist meist schneller)
      if ((smart&&left()<=0)||(k > 0 && left() < Math.max(T.minPass, lastMs * (r && psO2Score(r) > 0 ? 1.2 : 0.5)))) break;
      tries++;
      try {
        const o = await (smart ? psO2WithTimeout(psO2Pass(job,src,plan[k],T,left(),say,H),Math.max(1,left()),'total-deadline').catch(e=>{if(e.psTimeout){job.cancel('deadline');throw psO2Err('timeout','total-deadline');}throw e;}) : psO2Pass(job,src,plan[k],T,left(),say,H));
        lastMs = o.ms; take(o);
        // v55.227: Zeichensalat im 1. Durchgang = Moiré oder Spiegelung: bei Spiegelung zuerst lokaler Schwellwert, sonst zuerst geglaettet (Moiré)
        if (k === 0 && psO2Score(r) <= 0 && o.words.length > 350 && plan.length > 2) plan.splice(1, plan.length, PS_O2_PLAN[1], src.glare ? PS_O2_PLAN_ADAPT : PS_O2_PLAN_MOIRE);
      } catch (e) {
        if (e && e.psCancel) { fail = 'cancelled'; break; }
        const kind = (e && e.psKind) || 'engine';
        if (kind === 'timeout') {
          timedOut = true; lastMs = 0;
          if (!res.length) fail = 'timeout';
          if(smart&&left()<=0)break;
          if (plan[k] !== PS_O2_PLAN_LIGHT) plan.splice(k + 1, plan.length, PS_O2_PLAN_LIGHT); // leichtere Variante statt gleichem Aufwand
          continue;
        }
        if (!res.length) fail = kind === 'image' ? 'image' : 'engine';
        break; // Foto nicht lesbar / Texterkennung nicht verfuegbar: weitere Versuche bringen nichts
      }
      fail = ''; // etwas gelesen: ein frueherer Timeout ist kein Gesamtfehler mehr
      // v55.227: auch neu gelesene Einzelpreise/Rabatte zaehlen als Fortschritt (nicht nur mehr Eintraege)
      const sc = psO2Score(r), fl = psO2Filled(r), improved = sc > prevScore || fl > prevFill;
      prevScore = Math.max(prevScore, sc); prevFill = Math.max(prevFill, fl);
      if (!hard() && (k >= 1 || !soft())) break;
      if (k >= 1 && !improved && sc > 0) break; // etwas gelesen, aber der weitere Durchgang hat nichts Neues gebracht -> aufhoeren statt Zeit zu verbrennen
    }
  } finally {
    if (src) src.close();
    job.done = true;
  }
  if (!r) r = empty();
  return { r, txt, fail, timedOut, ms: Date.now() - t0, tries, cancelled: job.cancelled&&job.why!=='deadline' };
}

