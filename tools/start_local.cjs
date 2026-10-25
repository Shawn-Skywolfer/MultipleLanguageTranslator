#!/usr/bin/env node
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),port=Number(process.argv[2]||8765);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid port');
const handlers=new Map(['chat-completions','models','pv','pdf-engine'].map(name=>['/api/'+name,require(path.join(root,'api',name+'.js'))]));
const files=new Map([['/','index.html'],...['index.html','app.js','i18n.js'].map(x=>['/'+x,x])]);
http.createServer(async(req,res)=>{
  const host=req.headers.host,origin=req.headers.origin;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||origin&&![`http://127.0.0.1:${port}`,`http://localhost:${port}`].includes(origin)){res.writeHead(403).end();return;}
  try{
    const url=new URL(req.url,`http://${host}`),handler=handlers.get(url.pathname);
    if(handler){
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>120*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
      req.body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};req.query=Object.fromEntries(url.searchParams);req.mltLocal=true;
      let code=200;
      const adapter={setHeader:(k,v)=>res.setHeader(k,v),status:n=>{code=n;return adapter;},send:value=>{res.statusCode=code;res.end(String(value));},json:value=>{res.setHeader('Content-Type','application/json; charset=utf-8');adapter.send(JSON.stringify(value));},on:(...args)=>res.on(...args)};
      await handler(req,adapter);return;
    }
    const file=files.get(url.pathname);
    if(!file||req.method!=='GET'){res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':'text/javascript; charset=utf-8'});
    res.end(fs.readFileSync(path.join(root,file)));
  }catch(_){if(!res.headersSent)res.writeHead(500);res.end('Local request failed');}
}).listen(port,'127.0.0.1',()=>console.log(`Workbench: http://127.0.0.1:${port}`));
