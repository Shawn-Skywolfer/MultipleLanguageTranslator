(function(root) {
'use strict';
const api = {};
const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
api.rect = function(block,page) {
  const box=block.bbox;
  if (!box) throw Error(`PDF_REGION_MISSING: ${block.id}; re-extract with coordinates.`);
  const left=box.x0, top=block.coordinateSpace==='display-top-left'?box.y0:page.height-box.y1;
  const width=box.x1-box.x0,height=box.y1-box.y0;
  if (![left,top,width,height].every(Number.isFinite)||width<=0||height<=0||left<-.1||top<-.1||left+width>page.width+.1||top+height>page.height+.1) throw Error(`PDF_REGION_BOUNDS: ${block.id}`);
  return {left,top,width,height};
};
api.fit = function(text,rect,context,baseFont,rotation=0,minFont=3.5) {
  if (!String(text).trim()) throw Error('PDF_EMPTY_TRANSLATION');
  rotation=((rotation%360)+360)%360;
  if (![0,90,180,270].includes(rotation)) throw Error('PDF_TEXT_ANGLE: unsupported non-orthogonal text.');
  const width=(rotation%180?rect.height:rect.width)-.6;
  const height=(rotation%180?rect.width:rect.height)-.6;
  const upper=Math.max(1,Math.min(96,baseFont||height*.75));
  const lower=Math.min(upper,minFont);
  function layout(size) {
    context.font=`${size}px Arial, "Microsoft YaHei", sans-serif`;
    const lines=[];
    for (const paragraph of String(text).split(/\r?\n/)) {
      let line='';
      const words=paragraph.match(/\S+\s*|\s+/gu)||[''];
      for (const word of words) {
        if(context.measureText(line+word).width<=width) {line+=word;continue;}
        if(line.trim()){lines.push(line.trimEnd());line='';}
        if(context.measureText(word).width<=width){line=word.trimStart();continue;}
        const chars=typeof Intl.Segmenter==='function'?Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(word),x=>x.segment):Array.from(word);
        for(const char of chars) {
          if(context.measureText(line+char).width>width&&line){lines.push(line);line='';}
          line+=char;
        }
      }
      lines.push(line.trimEnd());
    }
    const m=context.measureText('Mg国');
    const ascent=m.actualBoundingBoxAscent||size*.85,descent=m.actualBoundingBoxDescent||size*.2;
    const lineHeight=Math.max(size*1.05,ascent+descent);
    const used=(lines.length-1)*lineHeight+ascent+descent;
    return {fontSize:size,lines,lineHeight,ascent,rotation,fit:used<=height&&lines.every(line=>context.measureText(line).width<=width+.01)};
  }
  let candidate=layout(upper);
  if(candidate.fit)return candidate;
  let best=layout(lower);
  if(!best.fit)throw Error('PDF_TEXT_DOES_NOT_FIT: translation exceeds the original region at minimum font size.');
  let lo=lower,hi=upper;
  for(let i=0;i<14;i++){const mid=(lo+hi)/2;candidate=layout(mid);if(candidate.fit){best=candidate;lo=mid;}else hi=mid;}
  return best;
};
api.paint = function(block,page,text,options={}) {
  const rect=api.rect(block,page);
  const make=options.createCanvas||((w,h)=>{const c=root.document.createElement('canvas');c.width=w;c.height=h;return c;});
  const density=3,canvas=make(Math.max(1,Math.ceil(rect.width*density)),Math.max(1,Math.ceil(rect.height*density)));
  const context=canvas.getContext('2d');
  const layout=api.fit(text,rect,context,block.fontSize,block.rotation||0,options.minFontSize||3.5);
  context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  context.scale(canvas.width/rect.width,canvas.height/rect.height);
  context.translate(rect.width/2,rect.height/2);context.rotate(layout.rotation*Math.PI/180);
  const w=layout.rotation%180?rect.height:rect.width,h=layout.rotation%180?rect.width:rect.height;
  context.fillStyle='#000';context.textBaseline='alphabetic';context.font=`${layout.fontSize}px Arial, "Microsoft YaHei", sans-serif`;
  layout.lines.forEach((line,index)=>context.fillText(line,-w/2+.3,-h/2+.3+layout.ascent+index*layout.lineHeight));
  return {rect,fontSize:layout.fontSize,dataUrl:canvas.toDataURL('image/png')};
};
api.createPdf = async function(doc,results,options={}) {
  const lib=options.PDFLib||root.PDFLib;
  if(!lib)throw Error('PDF 导出组件未加载，请检查网络后重试。');
  if(!doc.sourceBuffer)throw Error('PDF_SOURCE_MISSING: original PDF bytes are required.');
  const source=await lib.PDFDocument.load(doc.sourceBuffer.slice(0));
  const output=await lib.PDFDocument.create();
  if(source.getPageCount()!==doc.pages.length)throw Error('PDF_PAGE_COVERAGE');
  const report=[];
  for(let i=0;i<doc.pages.length;i++){
    const page=doc.pages[i];
    const [original]=await output.copyPages(source,[i]);output.addPage(original);
    const [translated]=await output.copyPages(source,[i]);output.addPage(translated);
    const transform=page.transform;
    if(!transform||transform.length!==6)throw Error('PDF_VIEWPORT_MISSING: re-extract the document.');
    const [a,b,c,d,e,f]=transform,det=a*d-b*c;
    if(!det)throw Error('PDF_VIEWPORT_INVALID');
    const inverse=[d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
    translated.pushOperators(lib.pushGraphicsState(),lib.concatTransformationMatrix(...inverse));
    for(let j=0;j<page.blocks.length;j++){
      const block=page.blocks[j],id=`page-${page.pageNo}-block-${j+1}`,item=results.get(id);
      if(!item||item.error||!String(item.text||'').trim())throw Error(`PDF_TRANSLATION_INCOMPLETE: ${id}`);
      const painted=api.paint(block,page,item.text,options);
      const png=await output.embedPng(painted.dataUrl);
      const {left,top,width,height}=painted.rect;
      // The viewport inverse handles crop offsets, page rotation and PDF bottom-left coordinates.
      translated.drawImage(png,{x:left,y:top+height,width,height:-height});
      report.push({id,fontSize:painted.fontSize,rect:painted.rect});
    }
    translated.pushOperators(lib.popGraphicsState());
  }
  const bytes=await output.save();
  const reopened=await lib.PDFDocument.load(bytes);
  if(reopened.getPageCount()!==source.getPageCount()*2)throw Error('PDF_OUTPUT_PAGE_COUNT');
  return {bytes,report};
};
api.comparisonHtml=function(doc,lang,results,options={}) {
  const sections=doc.pages.map(page=>{
    if(!page.image)throw Error(`PDF_PAGE_IMAGE_MISSING: page ${page.pageNo}`);
    const overlays=page.blocks.map((block,index)=>{
      const id=`page-${page.pageNo}-block-${index+1}`,item=results.get(id);
      if(!item||item.error||!String(item.text||'').trim())throw Error(`PDF_TRANSLATION_INCOMPLETE: ${id}`);
      const painted=api.paint(block,page,item.text,options),r=painted.rect;
      return `<img class="overlay" data-block="${escape(id)}" alt="${escape(item.text)}" src="${painted.dataUrl}" style="left:${r.left/page.width*100}%;top:${r.top/page.height*100}%;width:${r.width/page.width*100}%;height:${r.height/page.height*100}%">`;
    }).join('');
    return `<section><h2>Page ${page.pageNo}</h2><div class="pair"><figure><figcaption>Original</figcaption><div class="sheet"><img class="background" alt="Original" src="${page.image}"></div></figure><figure><figcaption>${escape(lang)}</figcaption><div class="sheet"><img class="background" alt="Preserved original background" src="${page.image}">${overlays}</div></figure></div></section>`;
  }).join('');
  return `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(doc.name)} / ${escape(lang)}</title><style>body{font:14px system-ui;margin:16px}h2{font-size:16px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}figcaption{margin:8px 0}.sheet{position:relative}.background{display:block;width:100%}.overlay{position:absolute;display:block}@media(max-width:700px){.pair{grid-template-columns:1fr}}@media print{section{break-before:page}}</style><body>${sections}</body></html>`;
};
if(typeof module==='object'&&module.exports)module.exports=api;
root.PdfOverlay=api;
})(typeof window!=='undefined'?window:globalThis);
