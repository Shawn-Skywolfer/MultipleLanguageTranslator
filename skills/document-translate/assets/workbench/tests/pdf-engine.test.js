'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('app.js','utf8');
const slice=(a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i+1);assert(i>=0&&j>i);return src.slice(i,j);};
const c={console,Map,chat:async()=>{c.calls++;return '译文 {v0}';},calls:0,
 promptImprove:()=>[],promptTranslation:()=>[],promptSuggestions:()=>[]};
vm.createContext(c);vm.runInContext(slice('async function workflowTranslate(', 'function buildTasksForRows('),c);
vm.runInContext(slice('function validatePdfResultCoverage(', 'function xmlFrom('),c);
vm.runInContext(slice('function collectDocumentTasks(', 'function validatePptxTranslationChecklist('),c);
(async()=>{
 for(const [depth,count] of [['fast',1],['reviewed',2],['full',3],['multi-pass',5]]){
  c.calls=0;await c.workflowTranslate('Source {v0}','English','Chinese','',{},depth,'log');assert.equal(c.calls,count,depth);
 }
 const doc={type:'pdf',pages:[{pageNo:1,blocks:[{id:'engine-hash',text:'Source'}]},{pageNo:2,blocks:[]}]};
 assert.equal(c.collectDocumentTasks(doc)[0].id,'engine-hash');
 assert.throws(()=>c.validatePdfResultCoverage(doc,new Map()),/PDF_TRANSLATION_INCOMPLETE/);
 assert.equal(c.validatePdfResultCoverage(doc,new Map([['engine-hash',{text:'译文'}]])).expected,1);
 const handler=require('../api/pdf-engine.js');
 let status=200,result;const response={status:n=>{status=n;return response;},json:x=>{result=x;}};
 await handler({method:'POST',body:{op:'status'}},response);assert.equal(status,503);assert.match(result.error,/本地/);
 await handler({method:'GET'},response);assert.equal(status,405);
 const html=fs.readFileSync('index.html','utf8');assert(!html.includes('pdf-overlay.js'));assert(html.includes('id="docPdfLayout"'));
 assert(!src.includes('window.PdfOverlay'));
 console.log('PDFMathTranslate routing, stable task IDs, structural rejection and actual 1/2/3/5-call depths passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
