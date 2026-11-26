import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
const dir=path.dirname(fileURLToPath(import.meta.url)),out=path.join(dir,'generated');
await build({root:dir,base:'./',build:{outDir:out,emptyOutDir:true,target:'es2022',rollupOptions:{input:path.join(dir,'smart-scan-worker.mjs'),output:{entryFileNames:'smart-scan-worker.mjs',chunkFileNames:'chunks/[name]-[hash].mjs',assetFileNames:'assets/[name]-[hash][extname]'}}}});
await fs.mkdir(path.join(out,'wasm'),{recursive:true});
const ort=path.join(dir,'node_modules/onnxruntime-web/dist');
for(const f of await fs.readdir(ort))if(/^ort-wasm.*\.(wasm|mjs)$/.test(f))await fs.copyFile(path.join(ort,f),path.join(out,'wasm',f));
const host='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
for(const name of ['PP-OCRv6_tiny_det','PP-OCRv6_tiny_rec']){
  const r=await fetch(host+name+'_onnx_infer.tar',{signal:AbortSignal.timeout(120000)});
  if(!r.ok)throw Error('model download '+name+' '+r.status);
  const b=Buffer.from(await r.arrayBuffer());
  if(b.length<10240||b.length%512!==0)throw Error('Invalid tar '+name);
  await fs.writeFile(path.join(out,name+'.tar'),b);
}
