import { PaddleOCR } from '@paddleocr/paddleocr-js';
let instance;
const root=new URL('./',self.location.href);
function init(){
  if(!instance){
    const det='PP-OCRv6_tiny_det',rec='PP-OCRv6_tiny_rec';
    instance=PaddleOCR.create({
      textDetectionModelName:det,textRecognitionModelName:rec,
      textDetectionModelAsset:{url:new URL(det+'.tar',root).href},
      textRecognitionModelAsset:{url:new URL(rec+'.tar',root).href},
      textDetectionBatchSize:1,textRecognitionBatchSize:4,
      ortOptions:{backend:'wasm',wasmPaths:new URL('wasm/',root).href,numThreads:1,simd:true}
    });
  }
  return instance;
}
self.onmessage=async({data:d})=>{
  if(!d||!['warm','read'].includes(d.type))return;
  let bmp;
  try{
    const ocr=await init();
    if(d.type==='warm'){self.postMessage({id:d.id,ok:true});return;}
    if(!(d.image instanceof Blob))throw Error('No image');
    bmp=await createImageBitmap(d.image);
    const [r]=await ocr.predict(bmp,{textDetLimitSideLen:1600,textDetLimitType:'max',textDetMaxSideLimit:1800,textDetBoxThresh:0.45,textRecScoreThresh:0.35});
    self.postMessage({id:d.id,ok:true,items:(r.items||[]).map(x=>({text:x.text,score:x.score,poly:x.poly}))});
  }catch(_){self.postMessage({id:d.id,ok:false});}
  finally{if(bmp)bmp.close();}
};
