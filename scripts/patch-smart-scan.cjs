// Targeted patch for 55.230. Refuses unknown source versions/anchors.
const fs=require('node:fs'),path=require('node:path');
const bridge=fs.readFileSync(path.join(__dirname,'../ocr/bridge.js'),'utf8');
const hook=fs.readFileSync(path.join(__dirname,'../ocr/local-hook.js'),'utf8');
function patchHtml(raw){
  if(raw.includes("window.APP_VERSION = '56.0-beta.1';"))return raw;
  const nl=raw.includes('\r\n')?'\r\n':'\n';let h=raw.replace(/\r\n/g,'\n');
  function one(a,b){if(h.split(a).length!==2)throw Error('Anchor not unique: '+a.slice(0,100));h=h.replace(a,()=>b);}
  one("window.APP_VERSION = '55.230';","window.APP_VERSION = '56.0-beta.1';");
  const start=h.indexOf('      // 1. Weg: der Dienst (liest Fotos vom Bildschirm am besten).');
  const end=h.indexOf('      // 2. Weg: Texterkennung auf dem Gerät',start);
  if(start<0||end<start)throw Error('Cloud block not found');
  h=h.slice(0,start)+'      // Smart Scan 2: Angebotsfotos bleiben lokal. Handschrift-Dienst unverändert.\n'+h.slice(end);
  one('const PS_O2_AMT = /(\\d{1,3}(?:\\.\\d{3})*,\\d{2})\\s*€?/g;','const PS_O2_AMT = /((?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d{2})(?!\\d)\\s*€?/g;');
  one('const head = l => { const a = l.search(/\\d{1,3}(?:\\.\\d{3})*,\\d{2}/);','const head = l => { const a = l.search(/(?:\\d{1,3}(?:\\.\\d{3})+|\\d+),\\d{2}/);');
  one('const psO2Tick = () => new Promise(r => setTimeout(r, 0));',bridge+'\nconst psO2Tick = () => new Promise(r => setTimeout(r, 0));');
  one("function psO2Warm() { return psO2Worker(PS_O2_T.workerCold).catch(() => null); }","function psO2Warm() { return typeof Worker==='undefined' ? psO2Worker(PS_O2_T.workerCold).catch(()=>null) : psSmartWarm(); }");
  one("function psO2Release() { if (__psO2Job && !__psO2Job.done) __psO2Job.cancel('release'); psO2ResetEngine(); }","function psO2Release() { if (__psO2Job && !__psO2Job.done) __psO2Job.cancel('release'); psO2ResetEngine(); psSmartStop('release'); }");
  one("if (job.inBuild || job.inRecog) psO2ResetEngine(); // nur wenn der Arbeiter gerade rechnet/startet: sonst bleibt er fuer das naechste Foto warm","if (job.inBuild || job.inRecog) psO2ResetEngine();\n    if(job.inNeural)psSmartStop('cancelled');");
  one("const T = Object.assign({}, PS_O2_T, opts.t || {}), H = opts.hooks || {};","const T = Object.assign({}, PS_O2_T, opts.t || {}), H = opts.hooks || {};\n  const smart = !opts.hooks && typeof Worker!=='undefined';\n  if(smart)T.budget=Math.min(T.budget,12000);");
  one('let plan = PS_O2_PLAN.slice();','let plan = PS_O2_PLAN.slice();\n'+hook);
  one('const o = await psO2Pass(job, src, plan[k], T, left(), say, H);',"const o = await (smart ? psO2WithTimeout(psO2Pass(job,src,plan[k],T,left(),say,H),Math.max(1,left()),'total-deadline').catch(e=>{if(e.psTimeout){job.cancel('deadline');throw psO2Err('timeout','total-deadline');}throw e;}) : psO2Pass(job,src,plan[k],T,left(),say,H));");
  one('if (k > 0 && left() < Math.max(T.minPass, lastMs * (r && psO2Score(r) > 0 ? 1.2 : 0.5))) break;','if ((smart&&left()<=0)||(k > 0 && left() < Math.max(T.minPass, lastMs * (r && psO2Score(r) > 0 ? 1.2 : 0.5)))) break;');
  one('if (plan[k] !== PS_O2_PLAN_LIGHT) plan.splice(k + 1, plan.length, PS_O2_PLAN_LIGHT);','if(smart&&left()<=0)break;\n          if (plan[k] !== PS_O2_PLAN_LIGHT) plan.splice(k + 1, plan.length, PS_O2_PLAN_LIGHT);');
  one('return { r, txt, fail, timedOut, ms: Date.now() - t0, tries, cancelled: job.cancelled };',"return { r, txt, fail, timedOut, ms: Date.now() - t0, tries, cancelled: job.cancelled&&job.why!=='deadline' };");
  return h.replace(/\n/g,nl);
}
function patchSw(s){
  if(s.includes('pencil-o2-smart-scan-2-beta1'))return s;
  if(!s.includes('pencil-o2-v33'))throw Error('Service worker version changed');
  const extra=[
    'if (bypass(url)) return;',
    "  if (url.origin === self.location.origin && url.pathname.includes('/ocr/generated/')) {",
    "    e.respondWith(caches.open(CACHE).then(async c=>{",
    "      const hit=await c.match(e.request);if(hit)return hit;",
    "      const res=await fetch(e.request);",
    "      if(res.ok&&res.status!==206)await c.put(e.request,res.clone()).catch(()=>{});",
    "      return res;",
    "    }));return;",
    "  }"].join('\n');
  return s.replace('pencil-o2-v33','pencil-o2-smart-scan-2-beta1')
   .replace('r || c.match("./")','r || (request.mode === "navigate" ? c.match("./") : Response.error())')
   .replace('if (bypass(url)) return;',extra);
}
if(require.main===module){
  const h=path.join(__dirname,'../index.html'),s=path.join(__dirname,'../sw.js');
  const html=patchHtml(fs.readFileSync(h,'utf8')),sw=patchSw(fs.readFileSync(s,'utf8'));
  fs.writeFileSync(h,html);fs.writeFileSync(s,sw);
}
module.exports={patchHtml,patchSw};
