// Smart Scan 2: local neural OCR; a dedicated worker can be terminated on cancel or timeout.
let __psSmart=null, __psSmartCooldown=0, __psSmartId=0;
function psSmartStop(reason){
  const s=__psSmart;__psSmart=null;if(!s)return;
  try{s.worker.terminate();}catch(_){}
  for(const p of s.pending.values())p.reject(Error(reason||'stopped'));
  s.pending.clear();
}
function psSmartRequest(type,image){
  if(!__psSmart){
    const worker=new Worker(new URL('./ocr/generated/smart-scan-worker.mjs',location.href),{type:'module'});
    const s={worker,pending:new Map(),warm:null,ready:false};__psSmart=s;
    worker.onmessage=e=>{
      if(__psSmart!==s)return;
      const d=e.data||{},p=s.pending.get(d.id);if(!p)return;
      s.pending.delete(d.id);d.ok?p.resolve(d.items):p.reject(Error('neural OCR unavailable'));
    };
    worker.onerror=worker.onmessageerror=()=>{if(__psSmart===s){__psSmartCooldown=Date.now()+60000;psSmartStop('worker error');}};
  }
  const s=__psSmart,id=++__psSmartId;
  return new Promise((resolve,reject)=>{
    s.pending.set(id,{resolve,reject});
    try{s.worker.postMessage({id,type,image});}catch(e){s.pending.delete(id);reject(e);}
  });
}
function psSmartWarm(){
  if(typeof Worker==='undefined'||Date.now()<__psSmartCooldown)return Promise.resolve(false);
  if(__psSmart&&__psSmart.warm)return __psSmart.warm;
  try{
    const p=psSmartRequest('warm'),s=__psSmart;
    s.warm=psO2WithTimeout(p,45000,'neural-init').then(()=>{if(__psSmart===s)s.ready=true;return __psSmart===s;},()=>{
      if(__psSmart===s){__psSmartCooldown=Date.now()+60000;psSmartStop('init failed');}return false;
    });
    return s.warm;
  }catch(_){__psSmartCooldown=Date.now()+60000;return Promise.resolve(false);}
}
function psSmartLayout(items){
  const boxes=(items||[]).flatMap(it=>{
    if(!it||typeof it.text!=='string'||!it.text.trim()||!Array.isArray(it.poly)||it.poly.length<4)return [];
    const xs=it.poly.map(p=>Number(p[0])),ys=it.poly.map(p=>Number(p[1]));
    if(![...xs,...ys].every(Number.isFinite))return [];
    const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
    return x1>x0&&y1>y0?[{t:it.text.trim(),x0,x1,y0,y1,cy:(y0+y1)/2,score:Number(it.score)}]:[];
  }).sort((a,b)=>a.cy-b.cy||a.x0-b.x0);
  const rows=[];
  for(const b of boxes){
    const q=rows.find(r=>Math.abs(r.cy-b.cy)<=.48*Math.min(r.h,b.y1-b.y0));
    if(q){q.boxes.push(b);q.cy=q.boxes.reduce((n,v)=>n+v.cy,0)/q.boxes.length;}
    else rows.push({cy:b.cy,h:b.y1-b.y0,boxes:[b]});
  }
  const words=[],lines=[];
  rows.sort((a,b)=>a.cy-b.cy).forEach((r,i)=>{
    r.boxes.sort((a,b)=>a.x0-b.x0);lines.push(r.boxes.map(b=>b.t).join(' '));
    // Paddle gives line polygons, not word boxes. Approximate subdivisions for the old parser.
    for(const b of r.boxes)for(const m of b.t.matchAll(/\S+/g)){
      const w=b.x1-b.x0;
      words.push({t:m[0],x0:b.x0+w*m.index/b.t.length,x1:b.x0+w*(m.index+m[0].length)/b.t.length,y0:b.y0,y1:b.y1,ln:i+1});
    }
  });
  return {text:lines.join('\n'),words,boxes,sparse:true,low:boxes.some(b=>/\d[.,]\d{2}|Kosten|TARIF|INTERNET/i.test(b.t)&&(!Number.isFinite(b.score)||b.score<.85))};
}
function psSmartExact(r,txt){
  if(!r||!r.einmalig||!r.monatlich)return false;
  const c=psO2Check(r);
  return !!(c&&[c.e,c.m].every(v=>v&&v.calc.includes(v.val))&&!psO2Gaps(r,txt).length&&(!r.hdr||['tarife','geraete','internet'].every(k=>(r.hdr[k]||0)<=r[k].length)));
}
function psSmartCostRegion(o,c){
  const hits=o.boxes.filter(b=>/(Einmalige|Monatliche|alige|natliche)\s*Kosten/i.test(b.t));
  if(!hits.length)return null;
  const pad=Math.max(24,...hits.map(b=>(b.y1-b.y0)*2.5));
  const y=Math.max(0,Math.floor(Math.min(...hits.map(b=>b.y0))-pad)),end=Math.min(c.height,Math.ceil(Math.max(...hits.map(b=>b.y1))+pad*2));
  return end-y>=20&&end-y<=c.height*.55?{left:0,top:y,width:c.width,height:end-y}:null;
}
