'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync('app.js', 'utf8');
function slice(a, b) { const start=src.indexOf(a); return src.slice(start,src.indexOf(b,start+1)); }
const context = { console, Map, state:{cancel:false}, window:{}, log() {} };
vm.createContext(context);
vm.runInContext(slice('function isPdfCanvasBlank(', 'function xmlFrom('), context);
const doc={pages:[{pageNo:1,blocks:[{text:'a'},{text:'99.99%'}]},{pageNo:2,blocks:[]}]};
const results=new Map([['page-1-block-1',{text:'translated'}]]);
assert.throws(()=>context.validatePdfResultCoverage(doc,results),/PDF_TRANSLATION_INCOMPLETE/);
results.set('page-1-block-2',{text:' ',error:''});
assert.throws(()=>context.validatePdfResultCoverage(doc,results),/PDF_TRANSLATION_INCOMPLETE/);
results.set('page-1-block-2',{text:'99.99%',error:'upstream failure'});
assert.throws(()=>context.validatePdfResultCoverage(doc,results),/PDF_TRANSLATION_INCOMPLETE/);
results.set('page-1-block-2',{text:'99.99%'});
assert.equal(context.validatePdfResultCoverage(doc,results).expected,2);
const canvas = data=>({width:1,height:1,getContext:()=>({getImageData:()=>({data})})});
assert.equal(context.isPdfCanvasBlank(canvas([255,255,255,255])),true);
assert.equal(context.isPdfCanvasBlank(canvas([20,20,20,255])),false);
// Exercise the actual translation coordinator: failures repair twice; empty results never pass.
let attempts=0;
Object.assign(context,{
  state:{cancel:false,errors:0,done:0,translationMemoryStats:{hits:0,missesByLang:{}}},
  collectDocumentTasks:()=>[{id:'page-1-block-1',source:'Source'}],
  lookupTranslationMemory:()=>null,
  withRetry:fn=>fn(), workflowTranslate:async()=>{ attempts++; if(attempts===1)throw Error('transient');return 'Repaired text'; },
  validateProtectedTerms:()=>[],validatePptxTranslationChecklist:()=>[],stat(){},updateProgress(){},
});
vm.runInContext(slice('async function translateDocumentToLanguage(', 'function validatePptxResultCoverage('),context);
(async()=>{
  const meta={sourceLang:'English',concurrency:1,retries:0,protectedTerms:[],workflowMode:'fast',translationMemoryMode:'review'};
  let output=await context.translateDocumentToLanguage({type:'pdf'},'German',meta,{done:0,total:1});
  assert.equal(output.get('page-1-block-1').text,'Repaired text');assert.equal(attempts,2);
  context.workflowTranslate=async()=>{attempts++;return '';};attempts=0;
  output=await context.translateDocumentToLanguage({type:'pdf'},'German',meta,{done:0,total:1});
  assert.equal(attempts,3,'one initial attempt plus two bounded repair rounds');
  assert.throws(()=>context.validatePdfResultCoverage({pages:[{pageNo:1,blocks:[{}]}]},output),/PDF_TRANSLATION_INCOMPLETE/);
  // PDF cancellation during extraction destroys the source document.
  let destroyed=false;
  context.state.cancel=true;
  context.window.pdfjsLib={getDocument:()=>({promise:Promise.resolve({numPages:1,destroy:async()=>{destroyed=true;}})})};
  vm.runInContext(slice('function pdfNativeRegions(', 'function isPdfCanvasBlank('),context);
  await assert.rejects(context.extractPdfDocument({name:'test.pdf',arrayBuffer:async()=>new ArrayBuffer(0)},'English'),/取消/);
  assert.equal(destroyed,true);

  // Exercise mixed-page detection and merge: retain native text and numeric labels.
  destroyed=false;context.state.cancel=false;
  context.groupPdfTextItems=()=>[{id:'text-1',text:'Native title'},{id:'text-2',text:'99.99%'}];
  context.collectNestedOcrLines=data=>data.lines;context.ocrBBox=line=>line.bbox;
  context.getPptxOcrWorker=async()=>({recognize:async()=>({data:{text:'Native title\n99.99%\nImage caption',lines:[{text:'Native title',bbox:{x0:10,y0:10,x1:110,y1:30}},{text:'99.99%',bbox:{x0:10,y0:40,x1:80,y1:60}},{text:'Image caption',bbox:{x0:10,y0:70,x1:110,y1:90}}]}})});
  context.renderPdfPageToCanvas=async()=>({width:600,height:800});context.window.Tesseract={};
  context.window.pdfjsLib={OPS:{paintImageXObject:85},getDocument:()=>({promise:Promise.resolve({numPages:1,
    getPage:async()=>({getViewport:()=>({width:600,height:800}),getTextContent:async()=>({items:[]}),getOperatorList:async()=>({fnArray:[85]}),cleanup(){}}),
    destroy:async()=>{destroyed=true;}})})};
  const mixed=await context.extractPdfDocument({name:'mixed.pdf',arrayBuffer:async()=>new ArrayBuffer(0)},'English');
  assert.equal(mixed.pages[0].extraction,'ocr');
  assert.deepEqual(Array.from(mixed.pages[0].blocks,b=>b.text),['Native title','99.99%','Image caption']);
  assert.equal(destroyed,true);

  console.log('PDF integrity checks passed: coverage, empty/error rejection, bounded retries, blank detection and cancellation cleanup.');
})().catch(error=>{console.error(error);process.exitCode=1;});
