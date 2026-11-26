import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { loadOcr,BELEG } from '../tests/ocr/helpers.mjs';
const ctx=vm.createContext({});
const x=loadOcr();
ctx.psO2Check=x.psO2Check;ctx.psO2Gaps=x.psO2Gaps;
vm.runInContext(fs.readFileSync(new URL('../ocr/bridge.js',import.meta.url),'utf8')+'\nthis.layout=psSmartLayout;this.exact=psSmartExact;this.region=psSmartCostRegion;',ctx);
test('line boxes grouped by y and ordered left-to-right',()=>{
 const b=(text,x,y,w)=>({text,score:.99,poly:[[x,y],[x+w,y],[x+w,y+12],[x,y+12]]});
 const o=ctx.layout([b('69,98 €',210,50,50),b('Monatliche Kosten',10,50,130),b('TARIF',10,10,40)]);
 assert.equal(o.text,'TARIF\nMonatliche Kosten 69,98 €');
 assert.equal(o.words[1].ln,2);assert.ok(ctx.region(o,{width:300,height:300}));
});
test('exact totals and duplicate tariffs',()=>{
 const r=x.psO2Parse(BELEG);assert.equal(r.tarife.length,2);assert.equal(ctx.exact(r,BELEG),true);
 r.monatlich='79,98';assert.equal(ctx.exact(r,BELEG),false);
});
test('ungrouped 4-digit sum preserved',()=>{
 const r=x.psO2Parse('Einmalige Kosten 2468,98 €\nMonatliche Kosten 69,98 €');
 assert.equal(x.psO2Cents(r.einmalig),246898);assert.equal(r.monatlich,'69,98');
});
test('offer-photo UI has no cloud recognition call',()=>{
 const h=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const a=h.indexOf('const readPhoto = async (jobP, stage, retryFile, ovF, pre)'),b=h.indexOf('const pendingGo = mode',a);
 assert.ok(a>=0&&b>a);assert.doesNotMatch(h.slice(a,b),/psO2CloudRead\s*\(/);
});
