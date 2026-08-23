'use strict';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
]);
const API_HANDLERS = new Map([
  ['/api/chat-completions', require('../api/chat-completions.js')],
  ['/api/models', require('../api/models.js')],
  ['/api/pv', require('../api/pv.js')],
]);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateZipEnvelope(buffer) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('文件不是完整的 PPTX/ZIP 包。');
  const start = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= start; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('PPTX 缺少 ZIP 中央目录结束标记，文件已截断。');
  const entries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (!entries || centralOffset + centralSize > eocd) throw new Error('PPTX ZIP 中央目录不完整。');
  return { entries };
}

async function writeFsync(filePath, bytes) {
  const handle = await fsp.open(filePath, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAndReadBack(filePath, bytes) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tempPath = `${filePath}.writing-${process.pid}-${crypto.randomUUID()}.tmp`;
    try {
      await writeFsync(tempPath, bytes);
      const tempRead = await fsp.readFile(tempPath);
      if (tempRead.length !== bytes.length || sha256(tempRead) !== sha256(bytes)) throw new Error('临时文件回读校验失败。');
      await fsp.copyFile(tempPath, filePath);
      const finalRead = await fsp.readFile(filePath);
      if (finalRead.length !== bytes.length || sha256(finalRead) !== sha256(bytes)) throw new Error('最终文件回读校验失败。');
      await fsp.unlink(tempPath).catch(() => {});
      return { bytes:finalRead, attempt };
    } catch (error) {
      lastError = error;
      await fsp.unlink(tempPath).catch(() => {});
    }
  }
  throw lastError;
}

function base64Text(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function powerPointScript(filePath, repairPath) {
  const repairBlock = repairPath ? `
$repairPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Text(repairPath)}'))
$presentation = $powerPoint.Presentations.Open2007($filePath, 0, 0, 0, -1)
$presentation.SaveCopyAs($repairPath, 24, 0)
` : `
$presentation = $powerPoint.Presentations.Open2007($filePath, -1, 0, 0, 0)
`;
  return `$ErrorActionPreference = 'Stop'
$filePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64Text(filePath)}'))
$powerPoint = $null
$presentation = $null
try {
  try { $powerPoint = New-Object -ComObject PowerPoint.Application }
  catch { [Console]::Error.WriteLine('POWERPOINT_UNAVAILABLE'); exit 31 }
  ${repairBlock}
  [Console]::Out.WriteLine('POWERPOINT_OK')
}
catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 32
}
finally {
  if ($presentation -ne $null) { try { $presentation.Close() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
  if ($powerPoint -ne $null) { try { $powerPoint.Quit() } catch {}; [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}`;
}

function runPowerPoint(filePath, repairPath = '') {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ ok:false, unavailable:true, error:'仅 Windows 支持 PowerPoint COM 验证。' });
    const encoded = Buffer.from(powerPointScript(filePath, repairPath), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide:true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve({ ok:false, unavailable:true, error:error.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        ok:code === 0 && stdout.includes('POWERPOINT_OK'),
        unavailable:code === 31 || stderr.includes('POWERPOINT_UNAVAILABLE'),
        error:(stderr || stdout || `PowerPoint 验证进程退出码 ${code}`).trim(),
      });
    });
  });
}

async function validateOrRepairWithPowerPoint(filePath) {
  const normal = await runPowerPoint(filePath);
  if (normal.ok) return { validated:true, repaired:false };
  if (normal.unavailable) return { validated:false, repaired:false, unavailable:true, message:normal.error };
  const repairPath = `${filePath}.powerpoint-repaired-${crypto.randomUUID()}.pptx`;
  try {
    const repair = await runPowerPoint(filePath, repairPath);
    if (!repair.ok) throw new Error(`PowerPoint Open and Repair 失败：${repair.error}`);
    const repairedBytes = await fsp.readFile(repairPath);
    validateZipEnvelope(repairedBytes);
    const repairedProbe = await runPowerPoint(repairPath);
    if (!repairedProbe.ok) throw new Error(`PowerPoint 修复后的文件仍无法正常打开：${repairedProbe.error}`);
    await writeAndReadBack(filePath, repairedBytes);
    const finalProbe = await runPowerPoint(filePath);
    if (!finalProbe.ok) throw new Error(`最终文件复验失败：${finalProbe.error}`);
    return { validated:true, repaired:true };
  } finally {
    await fsp.unlink(repairPath).catch(() => {});
  }
}

function responseAdapter(response) {
  let statusCode = 200;
  const adapter = {
    setHeader(name, value) { response.setHeader(name, value); },
    status(code) { statusCode = code; return adapter; },
    send(value) { response.statusCode = statusCode; response.end(Buffer.isBuffer(value) ? value : String(value)); },
    json(value) { response.setHeader('Content-Type', 'application/json; charset=utf-8'); adapter.send(JSON.stringify(value)); },
  };
  return adapter;
}

async function readJsonBody(request, maxBytes = 120 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createLocalServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const handler = API_HANDLERS.get(url.pathname);
      if (handler) {
        request.body = request.method === 'POST' ? await readJsonBody(request) : {};
        request.query = Object.fromEntries(url.searchParams);
        await handler(request, responseAdapter(response));
        return;
      }
      const entry = STATIC_FILES.get(url.pathname);
      if (!entry) { response.statusCode = 404; response.end('Not Found'); return; }
      response.setHeader('Content-Type', entry[1]);
      fs.createReadStream(path.join(APP_ROOT, entry[0])).pipe(response);
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error:error.message || String(error) }));
    }
  });
}

let server;

ipcMain.handle('pptx:save-verified', async (_event, payload) => {
  const bytes = Buffer.from(payload?.bytes || []);
  validateZipEnvelope(bytes);
  const selected = await dialog.showSaveDialog({
    title:'保存并验证 PowerPoint 文件',
    defaultPath:String(payload?.suggestedName || 'translated.pptx'),
    filters:[{ name:'PowerPoint Presentation', extensions:['pptx'] }],
  });
  if (selected.canceled || !selected.filePath) return { cancelled:true };
  const existed = await fsp.access(selected.filePath).then(() => true, () => false);
  const backupPath = existed ? `${selected.filePath}.backup-${crypto.randomUUID()}` : '';
  if (backupPath) await fsp.copyFile(selected.filePath, backupPath);
  try {
    const saved = await writeAndReadBack(selected.filePath, bytes);
    const powerPoint = await validateOrRepairWithPowerPoint(selected.filePath);
    const finalBytes = await fsp.readFile(selected.filePath);
    validateZipEnvelope(finalBytes);
    if (backupPath) await fsp.unlink(backupPath).catch(() => {});
    return {
      ok:true,
      path:selected.filePath,
      bytes:new Uint8Array(finalBytes),
      size:finalBytes.length,
      sha256:sha256(finalBytes),
      writeAttempt:saved.attempt,
      powerPointValidated:powerPoint.validated,
      powerPointUnavailable:!!powerPoint.unavailable,
      repaired:powerPoint.repaired,
      message:powerPoint.message || '',
    };
  } catch (error) {
    await fsp.unlink(selected.filePath).catch(() => {});
    if (backupPath) {
      await fsp.copyFile(backupPath, selected.filePath).catch(() => {});
      await fsp.unlink(backupPath).catch(() => {});
    }
    throw error;
  }
});

app.whenReady().then(async () => {
  server = createLocalServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const window = new BrowserWindow({
    width:1440,
    height:960,
    minWidth:980,
    minHeight:720,
    title:'Multiple Language Translator',
    webPreferences:{
      preload:path.join(__dirname, 'preload.cjs'),
      contextIsolation:true,
      nodeIntegration:false,
      sandbox:true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action:'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${address.port}/`)) { event.preventDefault(); shell.openExternal(url); }
  });
  await window.loadURL(`http://127.0.0.1:${address.port}/`);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server?.close());
