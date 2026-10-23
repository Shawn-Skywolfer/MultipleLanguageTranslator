'use strict';
const fs=require('node:fs');
const {createCanvas}=require('@napi-rs/canvas');
const PDFLib=require('pdf-lib');
const api=require('../pdf-overlay.js');
const fixture=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
fixture.doc.sourceBuffer=new Uint8Array(fs.readFileSync(fixture.source));
(async()=>{
 let pdfjs;
 try{pdfjs=require('pdfjs-dist/legacy/build/pdf.js');}catch(_){pdfjs=await import(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));}
 const vm=require('node:vm');const app=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
 const context={};vm.createContext(context);vm.runInContext(app.slice(app.indexOf('function pdfNativeRegions('),app.indexOf('async function extractPdfDocument(')),context);
 const input=await pdfjs.getDocument({data:fixture.doc.sourceBuffer.slice(),useSystemFonts:true,disableFontFace:true}).promise;
 try{
  fixture.doc.pages=[];
  for(let i=1;i<=input.numPages;i++){
   const p=await input.getPage(i),viewport=p.getViewport({scale:1});
   fixture.doc.pages.push({pageNo:i,width:viewport.width,height:viewport.height,transform:viewport.transform,blocks:context.pdfNativeRegions(await p.getTextContent(),viewport)});
  }
 }finally{await input.destroy();}
 const result=await api.createPdf(fixture.doc,new Map(fixture.results),{PDFLib,createCanvas});
 fs.writeFileSync(process.argv[3],result.bytes);
 console.log(JSON.stringify({regions:result.report.length,pages:fixture.doc.pages.length*2}));
})().catch(error=>{console.error(error);process.exitCode=1;});
