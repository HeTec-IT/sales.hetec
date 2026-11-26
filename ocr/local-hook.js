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
