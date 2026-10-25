'use strict';
// Local-only worker bridge. The deployed static service cannot execute Python.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
module.exports = async function pdfEngine(req, res) {
  if (req.method !== 'POST') return res.status(405).json({error:'POST required'});
  if (!req.mltLocal) return res.status(503).json({error:'PDFMathTranslate 需要本地 Python 引擎。请下载本地版并运行启动脚本。'});
  const root = process.env.MLT_PDF_ROOT || (__dirname.includes('app.asar')?path.join(process.resourcesPath,'pdf-engine'):path.resolve(__dirname,'..'));
  const envRoot = process.env.MLT_PDF_ENV || path.join(root,'.venv-pdf');
  const bundledPython=path.join(root,'python','python.exe');
  const python = process.env.MLT_PDF_PYTHON || (process.platform==='win32'&&fs.existsSync(bundledPython)?bundledPython:null) || path.join(envRoot,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if (!fs.existsSync(python)) return res.status(503).json({error:'PDF 引擎未安装。请运行启动脚本，或用 Python 3.11/3.12 执行 tools/setup_pdf.py。'});
  const body=req.body||{};
  if (!['prepare','export','status'].includes(body.op)) return res.status(400).json({error:'Invalid PDF operation'});
  // Do not forward unrelated fields or credentials to the Python process.
  const payload={op:body.op};
  for(const key of ['pdf','language','source_language','layout','ocr_language','job','translations']) if(body[key]!==undefined)payload[key]=body[key];
  await new Promise(resolve=>{
    const child=spawn(python,[path.join(root,'tools/pdf_worker.py')],{windowsHide:true,env:{...process.env,PYTHONUNBUFFERED:'1',OMP_NUM_THREADS:'2'}});
    let stdout='',done=false;
    const finish=(code,value)=>{if(done)return;done=true;clearTimeout(timer);res.status(code).json(value);resolve();};
    const timer=setTimeout(()=>{child.kill();finish(504,{error:'PDF 引擎处理超时（30 分钟）。请按章节拆分文档后重试。'});},30*60*1000);
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>250*1024*1024){child.kill();finish(413,{error:'PDF output too large'});}});
    // No document text, file paths or credentials are copied into HTTP logs.
    child.stderr.on('data',()=>{});
    child.on('error',()=>finish(500,{error:'PDF engine could not start. Check the local Python installation.'}));
    child.on('close',code=>{try{const value=JSON.parse(stdout);finish(code===0?200:422,value);}catch(_){finish(500,{error:'PDF engine failed. Run tools/pdf_translate.py locally for diagnostics.'});}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
    res.on?.('close',()=>{if(!done)child.kill();});
  });
};
