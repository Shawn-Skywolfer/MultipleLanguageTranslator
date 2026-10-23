#!/usr/bin/env node
'use strict';
// Serve the bundled project without npm install. The loopback API uses the existing handlers.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../assets/workbench');
const handlers = new Map([
  ['/api/chat-completions', require(path.join(root, 'api/chat-completions.js'))],
  ['/api/models', require(path.join(root, 'api/models.js'))],
  ['/api/pv', require(path.join(root, 'api/pv.js'))],
]);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/pdf-overlay.js', ['pdf-overlay.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
]);
const port = Number(process.argv[2] || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
    res.writeHead(403).end(); return;
  }
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) {
    res.writeHead(403).end(); return;
  }
  try {
    if (handlers.has(url.pathname)) {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 120 * 1024 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      req.query = Object.fromEntries(url.searchParams);
      let status = 200;
      const adapter = {
        setHeader: (key, value) => res.setHeader(key, value),
        status: code => { status = code; return adapter; },
        send: value => { res.statusCode = status; res.end(String(value)); },
        json: value => { res.setHeader('Content-Type', 'application/json'); adapter.send(JSON.stringify(value)); },
      };
      await handlers.get(url.pathname)(req, adapter); return;
    }
    const entry = files.get(url.pathname);
    if (!entry || req.method !== 'GET') { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type':entry[1], 'Cache-Control':'no-store' });
    res.end(fs.readFileSync(path.join(root, entry[0])));
  } catch (_) { res.writeHead(500).end('Request failed. Inspect local configuration.'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Workbench: http://127.0.0.1:${port}`));
