(function () {
'use strict';

const DEFAULT_MODELS = ['gpt-5.4','gpt-4o-mini','gpt-4o','gpt-4.1-mini','claude-3-5-sonnet-latest','claude-sonnet-4-5','gemini-2.5-flash','gemini-2.5-pro','deepseek-chat','deepseek-reasoner','qwen-plus','qwen-max'];
const MULTIMODAL_MODEL_PATTERNS = [
  /gpt-4o/i, /gpt-4\.1/i, /gpt-5/i, /o[134](?:-|$)/i,
  /claude-(?:3|sonnet|opus)/i, /gemini-(?:1\.5|2|3)/i,
  /qwen.*(?:vl|omni)/i, /glm-4v/i, /kimi.*vision/i,
];
const PROVIDER_PRESETS = [
  {name:'AIHubMix', baseUrl:'https://aihubmix.com/v1', model:'gpt-5.4', models:DEFAULT_MODELS},
  {name:'智谱 BigModel', baseUrl:'https://open.bigmodel.cn/api/paas/v4', model:'glm-5.1', models:['glm-5.1','glm-5-turbo','glm-5','glm-4.7','glm-4.7-flash','glm-4.7-flashx','glm-4.6','glm-4.5-air','glm-4.5-airx','glm-4.5-flash','glm-4-flash-250414','glm-4-flashx-250414']},
  {name:'Kimi Code', baseUrl:'https://api.kimi.com/coding/v1', model:'kimi-for-coding', models:['kimi-for-coding']}
];
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DEFAULT_LANGS = ['German','Spanish','French','Bulgarian','Czech','Greek','Italian','Dutch','Polish','Romanian','Turkish','Hungarian','Slovakian','Portuguese','Croatian','Danish','Swedish','Ukrainian'];
const $ = id => document.getElementById(id);
const state = {
  models: [...DEFAULT_MODELS],
  translateFiles: [],
  documentFiles: [],
  translateResults: [],
  translationMemory: new Map(),
  translationMemoryStats: {entries:0,files:0,rows:0,duplicates:0,hits:0,missesByLang:{}},
  done: 0,
  errors: 0,
  cancel: false,
  running: false,
  progressNote: '',
  translateNote: '',
  documentDownloads: [],
  visionImageCache: new Map(),
  pptxOcrCache: new Map(),
  pptxOcrWorkerPromise: null,
  pptxOcrWorkerLang: '',
  imageTransportBlocked: false,
  upstreamCooldownUntil: 0,
  downloadObjectUrls: new Set(),
  opsLogs: [],
  pv: 0,
};
const OPS_LOG_KEY = 'dp_ops_logs_v1';
const PPTX_REPAIR_MEMORY_KEY = 'dp_pptx_repair_memory_v1';

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function log(id, msg) {
  const el = $(id);
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  const line = `[${t}] ${msg}`;
  el.textContent += `\n${line}`;
  if (el.textContent.length > 120000) el.textContent = '…\n' + el.textContent.slice(-80000);
  el.scrollTop = el.scrollHeight;
  state.opsLogs.push({ at: new Date().toISOString(), area: id, message: String(msg || '') });
  if (state.opsLogs.length > 5000) state.opsLogs = state.opsLogs.slice(-5000);
  localStorage.setItem(OPS_LOG_KEY, JSON.stringify(state.opsLogs));
}
function setLog(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg;
}
function logShared(msg) {
  ['translateLog', 'documentLog'].forEach(id => { if ($(id)) log(id, msg); });
}
function stat() {
  $('statPv').textContent = state.pv;
  $('statFiles').textContent = state.documentFiles.length + state.translateFiles.length;
  $('statDone').textContent = state.done;
  const errEl = $('statErrors');
  errEl.textContent = state.errors;
  errEl.classList.toggle('bad', state.errors > 0);
  $('statHits').textContent = state.translationMemoryStats.hits || 0;
}
function loadOpsLogs() {
  try {
    const raw = localStorage.getItem(OPS_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    state.opsLogs = Array.isArray(list) ? list : [];
  } catch (_) {
    state.opsLogs = [];
  }
}
function exportOpsLogs() {
  const payload = {
    exportedAt: new Date().toISOString(),
    pv: state.pv,
    logs: state.opsLogs,
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type:'application/json;charset=utf-8' }), `ops_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  log('modelLog', `已导出操作日志：${state.opsLogs.length} 条。`);
}
function clearOpsLogs() {
  state.opsLogs = [];
  localStorage.removeItem(OPS_LOG_KEY);
  log('modelLog', '已清空操作日志。');
}
async function increasePv() {
  try {
    const response = await fetch('/api/pv', { method: 'POST' });
    const json = await response.json();
    const pv = Number(json?.pv);
    state.pv = Number.isFinite(pv) ? pv : 0;
  } catch (_) {
    state.pv = 0;
  }
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fileStem(name) {
  return String(name).replace(/\.[^.]+$/, '');
}
function safeNamePart(value) {
  return String(value || '').trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'lang';
}
function buildLangTag(langs) {
  const list = Array.from(new Set((langs || []).map(safeNamePart).filter(Boolean)));
  if (!list.length) return 'no-lang';
  if (list.length === 1) return list[0];
  return `multi_${list.join('+')}`;
}
async function sha256Hex(blob) {
  if (!window.crypto?.subtle) return '';
  const bytes = await blob.arrayBuffer();
  const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
function pptxSavePickerOptions(name) {
  return {
    suggestedName:name,
    types:[{
      description:'PowerPoint Presentation',
      accept:{ 'application/vnd.openxmlformats-officedocument.presentationml.presentation':['.pptx'] },
    }],
  };
}
async function writeAndVerifyPptx(handle, blob, expectedSlides) {
  const expectedHash = await sha256Hex(blob);
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      const persisted = await handle.getFile();
      if (persisted.size !== blob.size) throw new Error(`文件大小不一致：预期 ${blob.size} 字节，实际 ${persisted.size} 字节`);
      const persistedHash = await sha256Hex(persisted);
      if (expectedHash && persistedHash !== expectedHash) throw new Error('文件 SHA-256 与生成结果不一致');
      await validateGeneratedPptxBlob(persisted, expectedSlides);
      return { size:persisted.size, hash:persistedHash || expectedHash, attempt };
    } catch (error) {
      lastError = error;
      if (attempt === 1) log('documentLog', `PPTX 保存后校验失败，正在从内存中的已验证版本自动重写一次：${error.message || error}`);
    }
  }
  throw lastError;
}
async function downloadBlob(blob, name, options) {
  const expectedSlides = Number(options?.expectedSlides) || 0;
  if (expectedSlides && window.isSecureContext && typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker(pptxSavePickerOptions(name));
      const report = await writeAndVerifyPptx(handle, blob, expectedSlides);
      showToast(`PPTX 已安全保存并重新校验通过（${(report.size / 1024 / 1024).toFixed(1)} MB${report.attempt > 1 ? '，第 2 次写入成功' : ''}）。`, 'ok');
      log('documentLog', `PPTX 落盘校验通过：${name}；${report.size} 字节；SHA-256 ${report.hash || '浏览器不支持'}。`);
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') return false;
      showToast('PPTX 保存或落盘校验失败，请不要使用该文件并重新点击下载：' + (error.message || error), 'error');
      log('documentLog', `PPTX 落盘校验失败：${name}；${error.message || error}`);
      return false;
    }
  }
  const a = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  state.downloadObjectUrls.add(objectUrl);
  a.href = objectUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (expectedSlides) {
    showToast('浏览器不支持保存后重读校验；下载链接会保留到页面关闭，避免大文件被过早截断。', 'warn');
    log('documentLog', `PPTX 已通过浏览器兼容下载：${name}。当前浏览器无法自动验证落盘文件。`);
  }
  return true;
}
function releaseDownloadObjectUrls() {
  state.downloadObjectUrls.forEach(url => URL.revokeObjectURL(url));
  state.downloadObjectUrls.clear();
}
function showToast(message, type) {
  const box = $('toastBox');
  if (!box) { alert(message); return; }
  const item = document.createElement('div');
  item.className = 'toast' + (type && type !== 'warn' ? ' ' + type : '');
  item.textContent = message;
  item.addEventListener('click', () => item.remove());
  box.appendChild(item);
  while (box.children.length > 3) box.removeChild(box.firstChild);
  setTimeout(() => item.remove(), 5200);
}
function flashElement(el) {
  if (!el) return;
  el.classList.remove('flash-target');
  void el.offsetWidth;
  el.classList.add('flash-target');
}
function focusSharedRules() {
  const sectionEl = $('sharedRulesSection');
  if (!sectionEl || sectionEl.classList.contains('hidden')) return;
  sectionEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  flashElement(sectionEl);
}
function updateModelStatus(status) {
  const badge = $('modelStatusBadge');
  if (!badge) return;
  const map = { unset: '模型未配置', untested: '模型未测试', ok: '模型已连通', fail: '模型连接失败' };
  badge.classList.remove('ok', 'fail', 'untested');
  if (status === 'ok' || status === 'fail' || status === 'untested') badge.classList.add(status);
  badge.textContent = map[status] || map.unset;
}
function formatBytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return size + ' B';
  if (size < 1048576) return (size / 1024).toFixed(1) + ' KB';
  return (size / 1048576).toFixed(1) + ' MB';
}
function renderFileChips(containerId, files, emptyText, label) {
  const box = $(containerId);
  if (!files.length) { box.textContent = emptyText; return; }
  box.innerHTML = `<span>${escapeHtml(label)}</span><div class="file-chips">` + files.map((item, index) =>
    `<span class="file-chip"><span>${escapeHtml(item.name)}</span><span class="size">${formatBytes(item.file.size)}</span><button type="button" data-remove="${index}" aria-label="移除此文件">×</button></span>`
  ).join('') + '</div>';
}
function updateLangSummaries() {
  const langs = selectedLangs();
  const text = langs.length
    ? `已选 ${langs.length} 种语言：${langs.slice(0, 3).join(', ')}${langs.length > 3 ? ' …' : ''}`
    : '未选择目标语言';
  ['translateLangSummary', 'documentLangSummary'].forEach(id => { const el = $(id); if (el) el.textContent = text; });
  const count = $('langCount');
  if (count) count.textContent = langs.length ? `（已选 ${langs.length}）` : '（未选择）';
}
async function downloadResultsZip(entries, zipName, btn) {
  if (!entries.length) return;
  if (btn) btn.disabled = true;
  try {
    const zip = new window.JSZip();
    entries.forEach(entry => zip.file(entry.downloadName, entry.blob));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, zipName);
    showToast('打包完成，已开始下载。', 'ok');
  } catch (error) {
    showToast('打包失败：' + (error.message || error), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
function addPendingRow(tbodyId, wrapId, emptyId, cellsHtml) {
  $(wrapId).classList.remove('hidden');
  $(emptyId).classList.add('hidden');
  const tr = document.createElement('tr');
  tr.innerHTML = cellsHtml;
  $(tbodyId).appendChild(tr);
  return tr;
}
function tabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => { item.classList.remove('active'); item.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.section').forEach(item => item.classList.remove('active'));
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    $('tab-' + btn.dataset.tab).classList.add('active');
    const sharedRulesSection = $('sharedRulesSection');
    if (sharedRulesSection) {
      sharedRulesSection.classList.toggle('hidden', btn.dataset.tab === 'model');
    }
  }));
}
function sanitizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}
function normalizeKnownBaseUrl(url) {
  const base = sanitizeBaseUrl(url);
  if (/^https:\/\/api\.kimi\.com\/coding$/i.test(base)) return base + '/v1';
  return base;
}
function cleanApiKey(raw) {
  let key = String(raw || '');
  key = key.replace(/[\u200B-\u200D\uFEFF]/g, '');
  key = key.replace(/[\r\n\t]/g, '');
  key = key.replace(/[\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  key = key.trim();
  key = key.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  key = key.replace(/^Bearer\s+/i, '').trim();
  return key;
}
function assertHeaderSafe(name, value) {
  for (const ch of String(value)) {
    if (ch.charCodeAt(0) > 255) {
      throw new Error(`${name} 中包含非英文/非半角字符「${ch}」。请重新复制 API Key。`);
    }
  }
}
function getModelConfig() {
  const apiKey = cleanApiKey($('apiKey').value);
  if (!apiKey) throw new Error('API Key 为空，请先填写 API Key。');
  assertHeaderSafe('API Key', apiKey);
  return {
    providerName: $('providerName').value.trim(),
    baseUrl: normalizeKnownBaseUrl($('baseUrl').value),
    apiKey,
    model: $('modelId').value.trim(),
  };
}
function isLikelyMultimodalModel(model) {
  return MULTIMODAL_MODEL_PATTERNS.some(pattern => pattern.test(String(model || '')));
}
function modelSupportsVision() {
  const mode = $('modelCapability')?.value || 'auto';
  if (mode === 'vision') return true;
  if (mode === 'text') return false;
  return isLikelyMultimodalModel($('modelId').value.trim());
}
function getTokenLimitValue() {
  const value = $('maxTokens').value.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Max Tokens 必须是正数，或留空不传。');
  return Math.floor(n);
}
function addOptionalGenerationParams(body) {
  const temp = $('temperature').value.trim();
  if (temp !== '') {
    const t = Number(temp);
    if (!Number.isFinite(t)) throw new Error('Temperature 必须是数字，或留空不传。');
    body.temperature = t;
  }
  const max = getTokenLimitValue();
  if (max !== null) body.max_tokens = max;
  return body;
}
function unsupportedParam(raw, param) {
  const s = String(raw || '').toLowerCase();
  return s.includes('unsupported parameter') && s.includes(param.toLowerCase());
}
function parseRetryAfterMs(res) {
  const value = res?.headers?.get?.('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}
function buildUpstreamError(res, raw) {
  const status = Number(res?.status) || 0;
  const source = String(raw || '');
  const compact = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320);
  const lower = source.toLowerCase();
  const isCorporateProxy = status === 403 && (
    lower.includes('his proxy notification') || lower.includes('netentsec') ||
    lower.includes('proxyaccess') || lower.includes('xdefend') || lower.includes('swg,proxy')
  );
  const isOverloaded = status === 429 || lower.includes('engine_overloaded') || lower.includes('currently overloaded');
  let code = `HTTP_${status || 'UNKNOWN'}`;
  let message = `HTTP ${status || '错误'}：${compact || '上游接口未返回错误详情'}`;
  if (isCorporateProxy) {
    code = 'CORPORATE_PROXY_BLOCK';
    message = 'HTTP 403：企业网络安全代理（HIS/SWG）拦截了图片请求。应用将自动改用本地 OCR，再通过纯文本请求完成翻译。';
  } else if (isOverloaded) {
    code = 'UPSTREAM_OVERLOADED';
    message = 'HTTP 429：模型引擎当前过载，应用已按指数退避自动重试。';
  }
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryAfterMs = parseRetryAfterMs(res);
  error.retryable = isOverloaded || [408, 425, 500, 502, 503, 504].includes(status);
  return error;
}
async function proxyPost(url, payload) {
  if (window.location.protocol === 'file:') {
    throw new Error('当前版本不能通过直接双击 HTML 文件运行。请部署到 Vercel，或使用 `vercel dev` 这类支持 `/api/*` 的本地环境。');
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    const raw = await res.text();
    return { res, raw };
  } catch (error) {
    const wrapped = new Error(`无法访问站内接口 ${url}。请检查网络连接与 Vercel Functions 状态。原始错误：${error.message || error}`);
    wrapped.code = 'NETWORK_ERROR';
    wrapped.retryable = true;
    throw wrapped;
  }
}
async function postChatCompletion(body, logId) {
  const config = getModelConfig();
  let current = JSON.parse(JSON.stringify(body));
  let switchedMaxTokens = false;
  let switchedMaxCompletionTokens = false;
  let removedTemperature = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { res, raw } = await proxyPost('/api/chat-completions', { config, body: current });
    if (res.ok) {
      try {
        return JSON.parse(raw);
      } catch (_) {
        throw new Error('接口返回不是合法 JSON：' + raw.slice(0, 800));
      }
    }
    if (unsupportedParam(raw, 'max_tokens') && current.max_tokens !== undefined && !switchedMaxTokens) {
      current.max_completion_tokens = current.max_tokens;
      delete current.max_tokens;
      switchedMaxTokens = true;
      if (logId) log(logId, '检测到当前模型不支持 max_tokens，已自动改用 max_completion_tokens 并重试。');
      continue;
    }
    if (unsupportedParam(raw, 'max_completion_tokens') && current.max_completion_tokens !== undefined && !switchedMaxCompletionTokens) {
      current.max_tokens = current.max_completion_tokens;
      delete current.max_completion_tokens;
      switchedMaxCompletionTokens = true;
      if (logId) log(logId, '检测到当前模型不支持 max_completion_tokens，已自动改用 max_tokens 并重试。');
      continue;
    }
    if (unsupportedParam(raw, 'temperature') && current.temperature !== undefined && !removedTemperature) {
      delete current.temperature;
      removedTemperature = true;
      if (logId) log(logId, '检测到当前模型不支持 temperature，已自动移除 temperature 并重试。');
      continue;
    }
    throw buildUpstreamError(res, raw);
  }
  throw new Error('接口参数兼容重试次数已用完。');
}
function stripOutputObject(text) {
  const normalized = Array.isArray(text)
    ? text.map(item => typeof item === 'string' ? item : (item?.text || item?.content || '')).join('')
    : text;
  const raw = String(normalized ?? '').trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, 'output')) return String(obj.output ?? '');
  } catch (_) {}
  return raw;
}
async function chat(messages, logId) {
  const body = addOptionalGenerationParams({
    model: $('modelId').value.trim(),
    messages,
  });
  const json = await postChatCompletion(body, logId);
  return stripOutputObject(json.choices?.[0]?.message?.content ?? json.choices?.[0]?.text ?? '');
}
function parseJsonResponse(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const firstObject = raw.indexOf('{');
  const lastObject = raw.lastIndexOf('}');
  const candidate = firstObject >= 0 && lastObject > firstObject ? raw.slice(firstObject, lastObject + 1) : raw;
  return JSON.parse(candidate);
}
function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}
function normalizeImageRegions(payload) {
  const regions = Array.isArray(payload?.regions) ? payload.regions : [];
  return regions.map((region, index) => {
    const bbox = region?.bbox || {};
    const x = clamp01(bbox.x);
    const y = clamp01(bbox.y);
    const w = clamp01(bbox.w);
    const h = clamp01(bbox.h);
    return {
      id: String(region?.id || `region-${index + 1}`),
      source: String(region?.source || '').trim(),
      text: String(region?.translation || region?.text || '').trim(),
      bbox: { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) },
    };
  }).filter(region => region.text && region.bbox.w >= 0.01 && region.bbox.h >= 0.008);
}
function dataUrlByteLength(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || '';
  return Math.max(0, Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0)));
}
function loadHtmlImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('PPT 图片无法在浏览器中解码，可能是当前模型或浏览器不支持的图片格式。'));
    image.src = dataUrl;
  });
}
async function normalizeVisionImage(dataUrl) {
  const image = await loadHtmlImage(dataUrl);
  const maxEdge = 1600;
  const targetBytes = 850 * 1024;
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  let width = Math.max(1, Math.round(naturalWidth * scale));
  let height = Math.max(1, Math.round(naturalHeight * scale));
  let outputWidth = width;
  let outputHeight = height;
  let output = '';
  for (let resizeAttempt = 0; resizeAttempt < 5; resizeAttempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    outputWidth = width;
    outputHeight = height;
    for (const quality of [0.8, 0.7, 0.6, 0.5]) {
      output = canvas.toDataURL('image/jpeg', quality);
      if (dataUrlByteLength(output) <= targetBytes) break;
    }
    if (dataUrlByteLength(output) <= targetBytes) break;
    width = Math.max(1, Math.round(width * 0.82));
    height = Math.max(1, Math.round(height * 0.82));
  }
  return { dataUrl:output || dataUrl, width:outputWidth, height:outputHeight, bytes:dataUrlByteLength(output || dataUrl) };
}
async function prepareVisionImage(task) {
  const key = task.targetPath || task.id;
  if (!state.visionImageCache.has(key)) {
    state.visionImageCache.set(key, normalizeVisionImage(task.imageData).catch(error => {
      state.visionImageCache.delete(key);
      throw error;
    }));
  }
  return await state.visionImageCache.get(key);
}
function ocrBBox(node) {
  const bbox = node?.bbox || {};
  const x0 = Number(bbox.x0 ?? bbox.left);
  const y0 = Number(bbox.y0 ?? bbox.top);
  const x1 = Number(bbox.x1 ?? bbox.right);
  const y1 = Number(bbox.y1 ?? bbox.bottom);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}
function collectNestedOcrLines(data) {
  if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  const lines = [];
  (data?.blocks || []).forEach(block => (block.paragraphs || []).forEach(paragraph => {
    (paragraph.lines || []).forEach(line => lines.push(line));
  }));
  return lines;
}
function collectNestedOcrWords(data) {
  if (Array.isArray(data?.words) && data.words.length) return data.words;
  const words = [];
  (data?.blocks || []).forEach(block => (block.paragraphs || []).forEach(paragraph => {
    (paragraph.lines || []).forEach(line => (line.words || []).forEach(word => words.push(word)));
  }));
  return words;
}
function groupOcrWordsIntoLines(words) {
  const groups = [];
  words.map(word => ({ word, bbox:ocrBBox(word) })).filter(item => item.bbox && isLikelyText(item.word.text))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0).forEach(item => {
      const centerY = (item.bbox.y0 + item.bbox.y1) / 2;
      const group = groups.find(candidate => centerY >= candidate.y0 && centerY <= candidate.y1);
      if (group) {
        group.items.push(item);
        group.x0 = Math.min(group.x0, item.bbox.x0); group.y0 = Math.min(group.y0, item.bbox.y0);
        group.x1 = Math.max(group.x1, item.bbox.x1); group.y1 = Math.max(group.y1, item.bbox.y1);
      } else {
        groups.push({ items:[item], ...item.bbox });
      }
    });
  return groups.map(group => ({
    text:group.items.sort((a, b) => a.bbox.x0 - b.bbox.x0).map(item => item.word.text).join(' '),
    bbox:{ x0:group.x0, y0:group.y0, x1:group.x1, y1:group.y1 },
  }));
}
function normalizeOcrLines(data, width, height) {
  let lines = collectNestedOcrLines(data).map(line => ({ text:String(line.text || '').trim(), bbox:ocrBBox(line) }))
    .filter(line => line.bbox && isLikelyText(line.text));
  if (!lines.length) lines = groupOcrWordsIntoLines(collectNestedOcrWords(data));
  if (!lines.length) {
    const textLines = splitOcrText(data?.text || '');
    lines = textLines.map((text, index) => ({
      text,
      bbox:{ x0:0, y0:index * height / Math.max(1, textLines.length), x1:width, y1:(index + 1) * height / Math.max(1, textLines.length) },
    }));
  }
  return lines.map((line, index) => ({
    id:`ocr-${index + 1}`,
    source:line.text,
    bbox:{
      x:clamp01(line.bbox.x0 / width), y:clamp01(line.bbox.y0 / height),
      w:clamp01((line.bbox.x1 - line.bbox.x0) / width), h:clamp01((line.bbox.y1 - line.bbox.y0) / height),
    },
  })).filter(line => line.bbox.w >= 0.01 && line.bbox.h >= 0.008);
}
async function getLocalOcrLines(task, prepared, meta) {
  const key = task.targetPath || task.id;
  if (!state.pptxOcrCache.has(key)) {
    state.pptxOcrCache.set(key, (async () => {
      if (!window.Tesseract) throw new Error('企业代理阻止了图片上传，且本地 OCR 组件未加载，无法安全完成图片文字翻译。');
      log('documentLog', `企业代理兼容模式：正在本地 OCR ${task.id}...`);
      const worker = await getPptxOcrWorker(meta.sourceLang);
      const result = await worker.recognize(prepared.dataUrl, {}, { text:true, blocks:true });
      return normalizeOcrLines(result.data || {}, prepared.width, prepared.height);
    })().catch(error => {
      state.pptxOcrCache.delete(key);
      throw error;
    }));
  }
  return await state.pptxOcrCache.get(key);
}
async function getPptxOcrWorker(sourceLang) {
  const lang = getOcrLanguage(sourceLang);
  if (state.pptxOcrWorkerPromise && state.pptxOcrWorkerLang === lang) return await state.pptxOcrWorkerPromise;
  await closePptxOcrWorker();
  state.pptxOcrWorkerLang = lang;
  state.pptxOcrWorkerPromise = window.Tesseract.createWorker(lang, 1).catch(error => {
    state.pptxOcrWorkerPromise = null;
    state.pptxOcrWorkerLang = '';
    throw error;
  });
  return await state.pptxOcrWorkerPromise;
}
async function closePptxOcrWorker() {
  const pending = state.pptxOcrWorkerPromise;
  state.pptxOcrWorkerPromise = null;
  state.pptxOcrWorkerLang = '';
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch (_) {}
}
async function translateLocalOcrLines(task, prepared, targetLang, meta) {
  const lines = await getLocalOcrLines(task, prepared, meta);
  if (!lines.length) return [];
  const rulesBlock = formatTranslationRules(meta);
  const payload = lines.map(line => ({ id:line.id, source:line.source }));
  const out = await chat([
    { role:'system', content:'You translate OCR lines from a presentation image. Output valid JSON only.' },
    { role:'user', content:`Translate every item from ${meta.sourceLang} to ${targetLang}. Return strict JSON only: {"translations":[{"id":"ocr-1","translation":"..."}]}. Preserve numbers, units, product names and protected terms.${rulesBlock ? `\n${rulesBlock}` : ''}\nINPUT:\n${JSON.stringify(payload)}` },
  ], 'documentLog');
  const parsed = parseJsonResponse(out);
  const translated = new Map((parsed.translations || []).map(item => [String(item.id || ''), String(item.translation || '').trim()]));
  const missing = lines.filter(line => !translated.get(line.id));
  if (missing.length) {
    const error = new Error(`本地 OCR 已识别 ${lines.length} 个文字区域，但模型漏回 ${missing.length} 个译文。`);
    error.code = 'OCR_TRANSLATION_INCOMPLETE';
    throw error;
  }
  return lines.map(line => ({ ...line, text:translated.get(line.id) }));
}
async function translatePptxImageTask(task, targetLang, meta) {
  if (!modelSupportsVision()) {
    throw new Error(`图片文字翻译需要多模态模型；当前模型 ${$('modelId').value.trim()} 未标记为多模态。`);
  }
  const prepared = await prepareVisionImage(task);
  if (state.imageTransportBlocked) return await translateLocalOcrLines(task, prepared, targetLang, meta);
  const rulesBlock = formatTranslationRules(meta);
  const prompt = `Inspect this PowerPoint image and find every meaningful text region. Translate the text from ${meta.sourceLang} to ${targetLang}. Return strict JSON only: {"regions":[{"id":"r1","source":"original text","translation":"translated text","bbox":{"x":0.0,"y":0.0,"w":0.0,"h":0.0}}]}. Coordinates are fractions of image width and height from the top-left. Preserve numbers, units, product names and protected terms. Exclude decorative marks and return an empty regions array when no readable text exists.${rulesBlock ? `\n${rulesBlock}` : ''}`;
  try {
    const out = await chat([
      { role:'system', content:'You are a precise OCR and translation engine for presentation images. Output valid JSON only.' },
      { role:'user', content:[
        { type:'text', text:prompt },
        { type:'image_url', image_url:{ url:prepared.dataUrl, detail:'high' } },
      ] },
    ], 'documentLog');
    return normalizeImageRegions(parseJsonResponse(out));
  } catch (error) {
    if (error.code !== 'CORPORATE_PROXY_BLOCK') throw error;
    state.imageTransportBlocked = true;
    log('documentLog', '检测到 HIS/SWG 阻止图片上传；已停止继续发送 Base64 图片，并自动切换为“本地 OCR + 纯文本模型翻译”。');
    return await translateLocalOcrLines(task, prepared, targetLang, meta);
  }
}
function renderModels() {
  const filter = $('modelFilter').value.trim().toLowerCase();
  const list = $('modelList');
  list.innerHTML = '';
  const models = state.models.filter(model => !filter || model.toLowerCase().includes(filter));
  if (!models.length) {
    list.innerHTML = '<div class="model-item"><span class="muted">没有匹配模型</span></div>';
    return;
  }
  models.forEach(model => {
    const row = document.createElement('div');
    row.className = 'model-item';
    const badge = isLikelyMultimodalModel(model) ? '<span class="status ok">多模态</span>' : '<span class="status pending">文本</span>';
    row.innerHTML = `<span>${escapeHtml(model)}</span>${badge}<button class="ghost" type="button">使用</button>`;
    row.addEventListener('click', () => {
      $('modelId').value = model;
      log('modelLog', '已选择模型：' + model);
    });
    list.appendChild(row);
  });
}
function applyProviderPreset(preset) {
  $('providerName').value = preset.name;
  $('baseUrl').value = preset.baseUrl;
  $('modelId').value = preset.model;
  state.models = Array.from(new Set(preset.models));
  $('modelFilter').value = '';
  renderModels();
  log('modelLog', `已填充 ${preset.name}：${preset.baseUrl}，模型 ${preset.model}。请继续填写 API Key 后测试。`);
}
function renderProviderPresets() {
  const box = $('providerPresetButtons');
  box.innerHTML = '';
  PROVIDER_PRESETS.forEach(preset => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'secondary';
    btn.textContent = preset.name;
    btn.addEventListener('click', () => applyProviderPreset(preset));
    box.appendChild(btn);
  });
}
function saveSettings() {
  const data = {
    providerName: $('providerName').value,
    baseUrl: $('baseUrl').value,
    modelId: $('modelId').value,
    temperature: $('temperature').value,
    maxTokens: $('maxTokens').value,
    modelCapability: $('modelCapability').value,
    saveKey: $('saveKey').checked,
    apiKey: $('saveKey').checked ? cleanApiKey($('apiKey').value) : '',
  };
  localStorage.setItem('difyDslTranslatorSettings', JSON.stringify(data));
  log('modelLog', '已保存配置到本机浏览器。' + ($('saveKey').checked ? ' API Key 已保存。' : ' API Key 未保存。'));
}
function loadSettings() {
  try {
    const raw = localStorage.getItem('difyDslTranslatorSettings');
    if (!raw) return;
    const data = JSON.parse(raw);
    ['providerName','baseUrl','modelId','temperature','maxTokens','modelCapability','apiKey'].forEach(key => {
      if (data[key] !== undefined && $(key)) $(key).value = data[key];
    });
    $('saveKey').checked = !!data.saveKey;
  } catch (_) {}
}
function forgetSettings() {
  localStorage.removeItem('difyDslTranslatorSettings');
  log('modelLog', '已清除本机保存的配置。');
}
async function refreshModels() {
  setLog('modelLog', '正在刷新模型列表...');
  try {
    const { res, raw } = await proxyPost('/api/models', { config: getModelConfig() });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 500)}`);
    const json = JSON.parse(raw);
    const arr = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const models = arr.map(item => typeof item === 'string' ? item : item.id).filter(Boolean);
    if (!models.length) throw new Error('返回中没有识别到 data[].id。原始返回：' + raw.slice(0, 500));
    state.models = Array.from(new Set(models)).sort();
    renderModels();
    log('modelLog', `刷新成功：${state.models.length} 个模型。`);
  } catch (error) {
    log('modelLog', '刷新失败：' + (error.message || error));
  }
}
async function testConnection() {
  setLog('modelLog', '正在测试连通性...');
  try {
    const body = addOptionalGenerationParams({
      model: $('modelId').value.trim(),
      messages: [{role:'system', content:'Reply with OK only.'}, {role:'user', content:'Connection test'}],
    });
    const json = await postChatCompletion(body, 'modelLog');
    const out = json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '';
    log('modelLog', '连通测试成功，模型返回：' + out.trim());
    updateModelStatus('ok');
    showToast('连通测试成功', 'ok');
  } catch (error) {
    log('modelLog', '连通测试失败：' + (error.message || error));
    updateModelStatus('fail');
    showToast('连通测试失败：' + (error.message || error), 'error');
  }
}
function renderLanguages() {
  const box = $('languageBox');
  const picked = new Set(selectedLangs());
  box.innerHTML = '';
  DEFAULT_LANGS.forEach((lang, index) => {
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = `<input type="checkbox" class="langCheck" value="${escapeHtml(lang)}" ${(picked.has(lang) || (!picked.size && index === 0)) ? 'checked' : ''} /> ${escapeHtml(lang)}`;
    box.appendChild(label);
  });
  updateLangSummaries();
}
function selectedLangs() {
  return Array.from(document.querySelectorAll('.langCheck:checked')).map(el => el.value);
}
function selectLangs(list) {
  document.querySelectorAll('.langCheck').forEach(el => { el.checked = list.includes(el.value); });
  updateLangSummaries();
}
function normalizeSource(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}
function normalizeLang(lang) {
  return String(lang ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}
function translationMemoryKey(sourceText, targetLang) {
  return normalizeSource(sourceText) + '\u0001' + normalizeLang(targetLang);
}
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], cell = '', i = 0, quoted = false;
  while (i < text.length) {
    const ch = text[i], nx = text[i + 1];
    if (quoted) {
      if (ch === '"') {
        if (nx === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    if (ch === '\r') {
      if (nx === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 2; continue; }
      row.push(cell); rows.push(row); row = []; cell = ''; i++; continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function readFileText(file) {
  const buf = await file.arrayBuffer();
  for (const enc of ['utf-8', 'gb18030']) {
    try { return { text: new TextDecoder(enc, { fatal:true }).decode(buf), encoding: enc }; }
    catch (_) {}
  }
  return { text: new TextDecoder('utf-8').decode(buf), encoding:'utf-8-fallback' };
}
function csvEscape(v) {
  if (v === null || v === undefined) v = '';
  v = String(v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function stringifyCSV(rows) {
  return '\ufeff' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
}
function findCol(headers, name) {
  return headers.findIndex(h => h === name || String(h).trim() === name);
}
function autoPick(headers, candidates) {
  const lower = headers.map(h => String(h).trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate.toLowerCase());
    if (idx >= 0) return headers[idx];
  }
  return headers[0] || '';
}
function fillColumnSelects(headers) {
  const selects = [$('sourceColumn'), $('countryColumn')];
  selects.forEach(sel => {
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = sel.id === 'countryColumn' ? '<option value="">不使用列</option>' : '';
    headers.forEach(header => {
      const option = document.createElement('option');
      option.value = header;
      option.textContent = header;
      sel.appendChild(option);
    });
    if ([...sel.options].some(option => option.value === keep)) sel.value = keep;
  });
  if ($('sourceColumn')) $('sourceColumn').value = autoPick(headers, ['source_text','source text','原文','待翻译文本','text','source','content','英文','中文']);
}
function updateTranslateInfo() {
  renderFileChips('translateFileInfo', state.translateFiles, '尚未上传 CSV。', `已载入 ${state.translateFiles.length} 个 CSV：`);
  stat();
}
async function loadTranslateFiles(files) {
  state.translateFiles = Array.from(files || []).filter(file => file.name.toLowerCase().endsWith('.csv')).map(file => ({name:file.name, file}));
  updateTranslateInfo();
  if (state.translateFiles[0]) {
    try {
      const {text} = await readFileText(state.translateFiles[0].file);
      const headers = parseCSV(text)[0] || [];
      fillColumnSelects(headers);
    } catch (error) {
      log('translateLog', '读取表头失败：' + (error.message || error));
    }
  }
}
function updateTranslateProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $('translateBar').style.width = pct + '%';
  const note = state.translateNote && done < total ? ` · 当前：${state.translateNote}` : '';
  $('translateProgressText').textContent = `进度：${done}/${total} (${pct}%)${note}`;
}
function findAnyCol(headers, candidates) {
  const lower = headers.map(item => String(item).trim().toLowerCase());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}
function updateTranslationMemoryInfo() {
  const s = state.translationMemoryStats;
  $('translationMemoryInfo').textContent = s.entries
    ? `已载入 ${s.entries} 条标准译文，来自 ${s.files} 个文件、${s.rows} 行；重复覆盖 ${s.duplicates} 条。匹配规则：原文去首尾空格并合并空白，目标语言不区分大小写 / 空格 / 连字符。`
    : '尚未上传标准翻译库。支持窄表：source/source_text/原文 + target_lang/language + translation/target_text/标准译文；也支持宽表：source + German/French/Chinese 等语言列。';
}
function parseTranslationMemoryRows(rows, fileName) {
  const headers = rows[0] || [];
  const sourceIdx = findAnyCol(headers, ['source','source_text','source text','原文','待翻译文本','text']);
  if (sourceIdx < 0) return {added:0, rows:0, duplicates:0, warnings:[`${fileName} 没有找到源文本列`]};
  const sourceLangIdx = findAnyCol(headers, ['source_lang','source language','源语言']);
  const targetIdx = findAnyCol(headers, ['target_lang','target language','language','lang','目标语言']);
  const translationIdx = findAnyCol(headers, ['translation','target_text','target text','标准译文','译文']);
  const reserved = new Set([sourceIdx, sourceLangIdx, targetIdx, translationIdx].filter(i => i >= 0));
  const nonLanguageHeaders = new Set(['id','key','sku','country','market','region','comment','comments','note','notes','备注']);
  const wideLangCols = targetIdx < 0 || translationIdx < 0 ? headers.map((h, i) => ({h, i})).filter(item => !reserved.has(item.i) && String(item.h).trim() && !nonLanguageHeaders.has(String(item.h).trim().toLowerCase())) : [];
  let added = 0, duplicates = 0, dataRows = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const source = normalizeSource(row[sourceIdx]);
    if (!source) continue;
    dataRows++;
    const put = (lang, translation) => {
      const targetLang = String(lang ?? '').trim();
      const text = String(translation ?? '').trim();
      if (!targetLang || !text) return;
      const key = translationMemoryKey(source, targetLang);
      if (state.translationMemory.has(key)) duplicates++;
      state.translationMemory.set(key, {text, sourceFile:fileName, line:r + 1, sourceLang:sourceLangIdx >= 0 ? String(row[sourceLangIdx] ?? '').trim() : ''});
      added++;
    };
    if (targetIdx >= 0 && translationIdx >= 0) put(row[targetIdx], row[translationIdx]);
    else wideLangCols.forEach(col => put(col.h, row[col.i]));
  }
  return {added, rows:dataRows, duplicates, warnings:[]};
}
async function loadTranslationMemoryFiles(files) {
  state.translationMemory = new Map();
  state.translationMemoryStats = {entries:0,files:0,rows:0,duplicates:0,hits:0,missesByLang:{}};
  const csvFiles = Array.from(files || []).filter(file => file.name.toLowerCase().endsWith('.csv'));
  for (const file of csvFiles) {
    try {
      const { text } = await readFileText(file);
      const rows = parseCSV(text);
      const result = parseTranslationMemoryRows(rows, file.name);
      state.translationMemoryStats.files++;
      state.translationMemoryStats.rows += result.rows;
      state.translationMemoryStats.duplicates += result.duplicates;
      result.warnings.forEach(msg => logShared('标准库警告：' + msg));
      logShared(`标准库 ${file.name}：载入 ${result.added} 条，数据行 ${result.rows} 行。`);
    } catch (error) {
      logShared('标准库读取失败：' + file.name + '；' + (error.message || error));
    }
  }
  state.translationMemoryStats.entries = state.translationMemory.size;
  updateTranslationMemoryInfo();
  logShared(`标准库加载完成：${state.translationMemoryStats.entries} 条可匹配译文。`);
}
function lookupTranslationMemory(sourceText, targetLang) {
  return state.translationMemory.get(translationMemoryKey(sourceText, targetLang)) || null;
}
function parseLines(text) {
  return Array.from(new Set(String(text || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)));
}
function formatTranslationRules(rules) {
  const terms = Array.isArray(rules?.protectedTerms) ? rules.protectedTerms.filter(Boolean) : [];
  const custom = String(rules?.customRules || '').trim();
  if (!terms.length && !custom) return '';
  const parts = ['TRANSLATION RULES:', 'Do not translate or alter the following protected terms.', 'Keep exact casing, spacing, hyphens, model numbers, and trademarks.'];
  if (terms.length) parts.push('<PROTECTED_TERMS>', ...terms, '</PROTECTED_TERMS>');
  if (custom) parts.push('<CUSTOM_RULES>', custom, '</CUSTOM_RULES>');
  return parts.join('\n');
}
function validateProtectedTerms(sourceText, translatedText, protectedTerms) {
  const source = String(sourceText || '');
  const translated = String(translatedText || '');
  return (protectedTerms || []).filter(term => term && source.includes(term) && !translated.includes(term));
}
async function loadTermsCsvFile(file) {
  if (!file) return;
  try {
    const { text } = await readFileText(file);
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('CSV 为空');
    const headers = rows[0] || [];
    let idx = findAnyCol(headers, ['term','protected_term','protected term','术语','词条','名称','name']);
    if (idx < 0) idx = 0;
    const imported = parseLines(rows.slice(1).map(row => row[idx] || '').join('\n'));
    const merged = Array.from(new Set([...parseLines($('protectedTerms').value), ...imported]));
    $('protectedTerms').value = merged.join('\n');
    $('termsCsvInfo').textContent = `已从 ${file.name} 导入 ${imported.length} 个术语；当前共 ${merged.length} 个受保护术语。`;
    logShared(`术语 CSV ${file.name}：导入 ${imported.length} 个术语。`);
  } catch (error) {
    $('termsCsvInfo').textContent = '术语 CSV 读取失败：' + (error.message || error);
    logShared('术语 CSV 读取失败：' + (error.message || error));
  }
}
function getSharedRules() {
  return {
    protectedTerms: parseLines($('protectedTerms').value),
    customRules: $('customRules').value.trim(),
  };
}
function promptTranslation(sourceLang, targetLang, sourceText, rules) {
  const rulesBlock = formatTranslationRules(rules);
  const rulesText = rulesBlock ? `\n\n${rulesBlock}\nApply these rules from the first draft. Protected terms that appear in the source text must remain unchanged in the translation.` : '';
  return [
    {role:'system', content:`You are an expert linguist, specializing in translation from ${sourceLang} to ${targetLang}.`},
    {role:'user', content:`This is a ${sourceLang} to ${targetLang} translation, please provide the ${targetLang} translation for this text.${rulesText}\nDo not provide any explanations or text apart from the translation.\n\n${sourceText}`},
  ];
}
function promptSuggestions(sourceLang, targetLang, sourceText, translation, country, rules, standardTranslation) {
  const countryLine = country ? `The final style and tone of the translation should match the style of ${targetLang} colloquially spoken in ${country}.\n` : '';
  const standardBlock = standardTranslation ? `\nA standard/reference translation is also provided in <STANDARD_TRANSLATION></STANDARD_TRANSLATION>. Pay special attention to whether the initial translation is consistent with the standard translation, whether the standard translation should be adopted as-is, and mention any terminology differences.\n<STANDARD_TRANSLATION>\n${standardTranslation}\n</STANDARD_TRANSLATION>\n` : '';
  const rulesBlock = formatTranslationRules(rules);
  const rulesText = rulesBlock ? `\n${rulesBlock}\nWhen reviewing, pay special attention to mistranslated, missing, or rewritten protected terms. Mention every protected-term violation explicitly.\n` : '';
  return [{role:'system', content:`Your task is to carefully read a source text and a translation from ${sourceLang} to ${targetLang}, and then give constructive criticism and helpful suggestions to improve the translation.\n${countryLine}${rulesText}The source text and initial translation are as follows:\n<SOURCE_TEXT>\n${sourceText}\n</SOURCE_TEXT>\n<TRANSLATION>\n${translation}\n</TRANSLATION>${standardBlock}When writing suggestions, pay attention to accuracy, fluency, style, and terminology. Output only the suggestions and nothing else.`}];
}
function promptImprove(sourceLang, targetLang, sourceText, translation, suggestions, rules) {
  const rulesBlock = formatTranslationRules(rules);
  const rulesText = rulesBlock ? `\n\n${rulesBlock}\nThe final translation must strictly follow these terminology protection rules. If a protected term appears in the source, keep the exact same term in the final translation.` : '';
  return [
    {role:'system', content:`You are an expert linguist, specializing in translation editing from ${sourceLang} to ${targetLang}.`},
    {role:'user', content:`Your task is to carefully read, then edit, a translation from ${sourceLang} to ${targetLang}, taking into account expert suggestions.${rulesText}\n<SOURCE_TEXT>\n${sourceText}\n</SOURCE_TEXT>\n<TRANSLATION>\n${translation}\n</TRANSLATION>\n<EXPERT_SUGGESTIONS>\n${suggestions}\n</EXPERT_SUGGESTIONS>\nOutput only the new translation and nothing else.`},
  ];
}
async function withRetry(fn, retries, logId) {
  let last;
  let i = 0;
  let allowedRetries = Math.max(0, Number(retries) || 0);
  while (i <= allowedRetries) {
    try {
      const cooldown = Math.max(0, state.upstreamCooldownUntil - Date.now());
      if (cooldown) await sleep(cooldown);
      return await fn();
    }
    catch (error) {
      last = error;
      if (error?.retryable) allowedRetries = Math.max(allowedRetries, 4);
      if (i >= allowedRetries) break;
      const exponential = Math.min(30000, 2000 * (2 ** i));
      const delay = Math.max(Number(error?.retryAfterMs) || 0, exponential + Math.round(Math.random() * 600));
      if (error?.retryable) state.upstreamCooldownUntil = Math.max(state.upstreamCooldownUntil, Date.now() + delay);
      if (logId) log(logId, `${error.message || error} ${Math.ceil(delay / 1000)} 秒后进行第 ${i + 2} 次尝试。`);
      await sleep(delay);
    }
    i++;
  }
  throw last;
}
async function workflowTranslate(sourceText, sourceLang, targetLang, country, rules, workflowMode, logId) {
  const standardTranslation = String(rules?.standardTranslation || '');
  if (workflowMode === 'fast' && !standardTranslation) {
    return await chat(promptImprove(sourceLang, targetLang, sourceText, '', 'Translate the source text directly and produce a polished final translation.', rules), logId);
  }
  const initial = await chat(promptTranslation(sourceLang, targetLang, sourceText, rules), logId);
  const suggestions = await chat(promptSuggestions(sourceLang, targetLang, sourceText, initial, country, rules, standardTranslation), logId);
  return await chat(promptImprove(sourceLang, targetLang, sourceText, initial, suggestions, rules), logId);
}
function buildTasksForRows(rows, headers, meta) {
  const srcIdx = findCol(headers, meta.sourceCol);
  const countryIdx = meta.countryCol ? findCol(headers, meta.countryCol) : -1;
  const tasks = [];
  for (let r = 1; r < rows.length; r++) {
    const source = (rows[r][srcIdx] ?? '').trim();
    if (!source) continue;
    for (const lang of meta.langs) {
      const country = countryIdx >= 0 ? (rows[r][countryIdx] || meta.countryGlobal || '') : meta.countryGlobal;
      tasks.push({rowIndex:r, lang, source, country});
    }
  }
  return tasks;
}
function makeWideOutput(rows, headers, taskResults, langs) {
  const newHeaders = [...headers];
  const colMap = {};
  langs.forEach(lang => {
    let name = `生成结果_${lang}`;
    const base = name;
    let n = 1;
    while (newHeaders.includes(name)) name = `${base}_${n++}`;
    colMap[lang] = newHeaders.length;
    newHeaders.push(name);
  });
  const out = [newHeaders];
  for (let r = 1; r < rows.length; r++) {
    const row = [...rows[r]];
    while (row.length < newHeaders.length) row.push('');
    out.push(row);
  }
  taskResults.forEach(item => {
    out[item.rowIndex][colMap[item.lang]] = item.error ? `[ERROR] ${item.error}` : (item.warning ? `${item.text} [WARNING] ${item.warning}` : item.text);
  });
  return out;
}
function makeLongOutput(rows, headers, taskResults) {
  const out = [[...headers, 'target_lang', 'translation', 'error']];
  taskResults.forEach(item => {
    const row = [...(rows[item.rowIndex] || [])];
    while (row.length < headers.length) row.push('');
    out.push([...row, item.lang, item.error ? '' : item.text, item.error || item.warning || '']);
  });
  return out;
}
async function processOneTranslate(item, meta, counter) {
  const {text} = await readFileText(item.file);
  const rows = parseCSV(text);
  if (!rows.length || !rows[0].length) throw new Error('没有识别到 CSV 表头');
  const headers = rows[0];
  const srcIdx = findCol(headers, meta.sourceCol);
  if (srcIdx < 0) throw new Error('没有找到原文列：' + meta.sourceCol);
  const tasks = buildTasksForRows(rows, headers, meta);
  const results = [];
  let cursor = 0;
  let tmHits = 0;
  async function worker() {
    while (cursor < tasks.length && !state.cancel) {
      const task = tasks[cursor++];
      try {
        const standard = lookupTranslationMemory(task.source, task.lang);
        let translated = '';
        if (standard && meta.translationMemoryMode === 'direct') {
          tmHits++;
          state.translationMemoryStats.hits++;
          translated = standard.text;
          log('translateLog', `标准库命中：${task.lang} 第 ${task.rowIndex + 1} 行，使用 ${standard.sourceFile}:${standard.line}`);
        } else {
          if (standard) {
            tmHits++;
            state.translationMemoryStats.hits++;
          } else {
            state.translationMemoryStats.missesByLang[task.lang] = (state.translationMemoryStats.missesByLang[task.lang] || 0) + 1;
          }
          translated = await withRetry(() => workflowTranslate(task.source, meta.sourceLang, task.lang, task.country, {
            protectedTerms: meta.protectedTerms,
            customRules: meta.customRules,
            standardTranslation: standard && meta.translationMemoryMode === 'review' ? standard.text : ''
          }, meta.workflowMode, 'translateLog'), meta.retries);
        }
        const missing = validateProtectedTerms(task.source, translated, meta.protectedTerms);
        const warning = missing.length ? '受保护术语缺失：' + missing.join(' / ') : '';
        if (warning) log('translateLog', `术语警告：${task.lang} 第 ${task.rowIndex + 1} 行，${warning}`);
        results.push({...task, text:translated, error:'', warning});
      } catch (error) {
        state.errors++;
        stat();
        results.push({...task, text:'', error:error.message || String(error), warning:''});
      } finally {
        state.done++;
        counter.done++;
        stat();
        updateTranslateProgress(counter.done, counter.total);
      }
    }
  }
  await Promise.all(Array.from({length: meta.concurrency}, () => worker()));
  const outRows = meta.outputMode === 'long' ? makeLongOutput(rows, headers, results) : makeWideOutput(rows, headers, results, meta.langs);
  const blob = new Blob([stringifyCSV(outRows)], {type:'text/csv;charset=utf-8'});
  return {name:item.name, blob, downloadName:`${fileStem(item.name)}_${buildLangTag(meta.langs)}_clean.csv`, tasks:tasks.length, errors:results.filter(x => x.error).length, warnings:results.filter(x => x.warning).length, tmHits};
}
function renderTranslateResult(result, status, message) {
  $('translateTableWrap').classList.remove('hidden');
  $('translateEmpty').classList.add('hidden');
  const tr = document.createElement('tr');
  const dl = result.blob ? '<a class="download-link secondary" href="#">下载</a>' : '-';
  tr.innerHTML = `<td data-label="文件">${escapeHtml(result.name)}</td><td data-label="状态"><span class="status ${status === 'ok' ? 'ok' : 'fail'}">${status === 'ok' ? '成功' : '失败'}</span></td><td data-label="任务数">${result.tasks || 0}</td><td data-label="说明">${escapeHtml(message || (`错误 ${result.errors || 0} 个；警告 ${result.warnings || 0} 个；输出：${result.downloadName || ''}`))}</td><td data-label="下载">${dl}</td>`;
  $('translateResultBody').appendChild(tr);
  if (result.blob) {
    tr.querySelector('a').addEventListener('click', event => {
      event.preventDefault();
      downloadBlob(result.blob, result.downloadName);
    });
    $('zipTranslateBtn').classList.remove('hidden');
  }
}
async function runTranslate() {
  if (!state.translateFiles.length) { showToast('请先上传 CSV 文件。'); flashElement($('translateDrop')); return; }
  const langs = selectedLangs();
  if (!langs.length) { showToast('请至少选择一个目标语言。'); focusSharedRules(); return; }
  if (!$('apiKey').value.trim() && !(state.translationMemory.size && $('translationMemoryMode').value === 'direct')) {
    showToast('请先填写 API Key，或上传标准翻译库并选择命中后直接使用。', 'error');
    return;
  }
  state.cancel = false;
  state.running = true;
  state.done = 0;
  state.errors = 0;
  state.translationMemoryStats.hits = 0;
  state.translationMemoryStats.missesByLang = {};
  stat();
  $('runTranslateBtn').disabled = true;
  $('cancelTranslateBtn').disabled = false;
  $('translateResultBody').innerHTML = '';
  $('translateTableWrap').classList.add('hidden');
  $('translateEmpty').classList.remove('hidden');
  $('zipTranslateBtn').classList.add('hidden');
  state.translateResults = [];
  setLog('translateLog', `开始批量翻译... 标准库 ${state.translationMemory.size} 条，模式：${$('translationMemoryMode').value === 'direct' ? '命中直接使用' : '命中后仍评审'}`);
  const sharedRules = getSharedRules();
  const meta = {
    sourceCol: $('sourceColumn').value,
    sourceLang: $('sourceLang').value,
    countryGlobal: $('countryGlobal').value.trim(),
    countryCol: $('countryColumn').value,
    langs,
    concurrency: Number($('concurrency').value),
    retries: Number($('retries').value),
    outputMode: $('outputMode').value,
    workflowMode: $('workflowMode').value,
    translationMemoryMode: $('translationMemoryMode').value,
    protectedTerms: sharedRules.protectedTerms,
    customRules: sharedRules.customRules
  };
  let total = 0;
  for (const item of state.translateFiles) {
    try {
      const {text} = await readFileText(item.file);
      const rows = parseCSV(text);
      total += buildTasksForRows(rows, rows[0] || [], meta).length;
    } catch (_) {}
  }
  const counter = {done:0, total};
  updateTranslateProgress(0, total);
  for (const item of state.translateFiles) {
    if (state.cancel) break;
    state.translateNote = item.name;
    const pendingRow = addPendingRow('translateResultBody', 'translateTableWrap', 'translateEmpty',
      `<td data-label="文件">${escapeHtml(item.name)}</td><td data-label="状态"><span class="status pending">进行中</span></td><td data-label="任务数">-</td><td data-label="说明">正在翻译…</td><td data-label="下载">-</td>`);
    try {
      log('translateLog', '处理文件：' + item.name);
      const result = await processOneTranslate(item, meta, counter);
      state.translateResults.push(result);
      renderTranslateResult(result, 'ok');
      log('translateLog', `完成：${item.name}；标准库命中 ${result.tmHits || 0}/${result.tasks || 0}。`);
    } catch (error) {
      state.errors++;
      stat();
      renderTranslateResult({name:item.name, tasks:0}, 'fail', error.message || String(error));
      log('translateLog', '失败：' + item.name + '；' + (error.message || error));
    } finally {
      pendingRow.remove();
    }
  }
  state.translateNote = '';
  state.running = false;
  $('runTranslateBtn').disabled = false;
  $('cancelTranslateBtn').disabled = true;
  const misses = Object.entries(state.translationMemoryStats.missesByLang).map(([lang, count]) => `${lang} ${count}`).join('；') || '无';
  log('translateLog', (state.cancel ? '已停止。' : '批量翻译结束。') + ` 标准库累计命中 ${state.translationMemoryStats.hits || 0}；未命中语言：${misses}。`);
}
function updateProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $('documentBar').style.width = pct + '%';
  const note = state.progressNote && done < total ? ` · 当前：${state.progressNote}` : '';
  $('documentProgressText').textContent = `进度：${done}/${total} (${pct}%)${note}`;
}
function isLikelyText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (!/\p{L}/u.test(normalized)) return false;
  return normalized.length >= 2;
}
function groupPdfTextItems(items) {
  const normalized = (items || []).map(item => ({
    text: String(item.str || '').replace(/\s+/g, ' ').trim(),
    x: item.transform?.[4] || 0,
    y: item.transform?.[5] || 0,
    w: Math.abs(item.width || 0),
    h: Math.abs(item.height || item.transform?.[0] || 10),
  })).filter(item => item.text);
  normalized.sort((a, b) => Math.abs(a.y - b.y) < 3 ? a.x - b.x : b.y - a.y);
  const lines = [];
  for (const token of normalized) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - token.y) > Math.max(4, token.h * 0.6)) {
      lines.push({ y: token.y, height: token.h, parts:[token.text], x0: token.x, x1: token.x + token.w });
    } else {
      last.parts.push(token.text);
      last.height = Math.max(last.height, token.h);
      last.x0 = Math.min(last.x0, token.x);
      last.x1 = Math.max(last.x1, token.x + token.w);
    }
  }
  const blocks = [];
  let current = null;
  lines.forEach(line => {
    const text = line.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!current || Math.abs(current.prevY - line.y) > Math.max(14, line.height * 1.8)) {
      current = { texts:[text], prevY: line.y, x0: line.x0, x1: line.x1, y0: line.y, y1: line.y + line.height };
      blocks.push(current);
    } else {
      current.texts.push(text);
      current.prevY = line.y;
      current.x0 = Math.min(current.x0, line.x0);
      current.x1 = Math.max(current.x1, line.x1);
      current.y0 = Math.min(current.y0, line.y);
      current.y1 = Math.max(current.y1, line.y + line.height);
    }
  });
  return blocks
    .map((block, index) => ({ id:`text-${index + 1}`, text:block.texts.join('\n').trim(), bbox:{ x0:block.x0, y0:block.y0, x1:block.x1, y1:block.y1 } }))
    .filter(block => isLikelyText(block.text));
}
function splitOcrText(text) {
  return String(text || '').split(/\n{2,}/).map(part => part.replace(/[ \t]+/g, ' ').replace(/\n/g, ' ').trim()).filter(isLikelyText);
}
async function renderPdfPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}
function getOcrLanguage(sourceLang) {
  if (sourceLang === 'Chinese') return 'chi_sim+eng';
  if (sourceLang === 'English') return 'eng';
  return 'eng+chi_sim';
}
async function extractPdfDocument(file, sourceLang, options) {
  const captureImage = !!(options && options.captureImage);
  log('documentLog', `开始解析 PDF：${file.name}`);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    let blocks = groupPdfTextItems(textContent.items || []);
    let extraction = 'text';
    let pageCanvas = null;
    if (!blocks.length || blocks.map(item => item.text).join(' ').length < 24) {
      extraction = 'ocr';
      log('documentLog', `第 ${i} 页文本不足，开始 OCR...`);
      pageCanvas = await renderPdfPageToCanvas(page, 2);
      const result = await window.Tesseract.recognize(pageCanvas, getOcrLanguage(sourceLang), {
        logger: msg => {
          if (msg.status === 'recognizing text' && typeof msg.progress === 'number') {
            $('documentProgressText').textContent = `OCR 第 ${i} 页：${Math.round(msg.progress * 100)}%`;
          }
        },
      });
      blocks = splitOcrText(result.data.text).map((text, index) => ({ id:`ocr-${index + 1}`, text }));
    }
    let image = '';
    if (captureImage) {
      if (!pageCanvas) pageCanvas = await renderPdfPageToCanvas(page, 1.6);
      image = pageCanvas.toDataURL('image/jpeg', 0.82);
    }
    pages.push({ pageNo:i, extraction, blocks, width:viewport.width, height:viewport.height, image });
  }
  log('documentLog', `PDF 解析完成：${file.name}，共 ${pages.length} 页。`);
  return { type:'pdf', name:file.name, pages };
}
function xmlFrom(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}
function localNameNodes(root, name) {
  if (!root) return [];
  return Array.from(root.getElementsByTagName('*')).filter(node => node.localName === name);
}
function firstLocalName(root, name) {
  return localNameNodes(root, name)[0] || null;
}
function attrAny(node, names) {
  if (!node) return '';
  for (const name of names) {
    const value = node.getAttribute(name);
    if (value) return value;
  }
  return '';
}
function relAttr(node, localName) {
  if (!node) return '';
  return node.getAttributeNS(REL_NS, localName) || node.getAttribute('r:' + localName) || '';
}
function emuToInch(value) {
  return Number(value || 0) / 914400;
}
function resolveZipPath(basePath, target) {
  const normalizedBasePath = /\/_rels\/.+\.rels$/i.test(basePath)
    ? basePath.replace('/_rels/', '/').replace(/\.rels$/i, '')
    : basePath;
  const baseParts = normalizedBasePath.split('/');
  baseParts.pop();
  target.split('/').forEach(part => {
    if (!part || part === '.') return;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  });
  return baseParts.join('/');
}
async function parseRelationshipMap(zip, relPath) {
  const relMap = {};
  if (!zip.file(relPath)) return relMap;
  const relXml = xmlFrom(await zip.file(relPath).async('text'));
  localNameNodes(relXml, 'Relationship').forEach(rel => {
    const id = attrAny(rel, ['Id']);
    const target = attrAny(rel, ['Target']);
    if (id && target) relMap[id] = resolveZipPath(relPath, target);
  });
  return relMap;
}
function pickFirstPath(relMap, matcher) {
  return Object.values(relMap || {}).find(path => matcher.test(path)) || '';
}
function findColorHex(node) {
  if (!node) return '';
  const srgb = firstLocalName(node, 'srgbClr');
  if (srgb) return String(attrAny(srgb, ['val'])).toUpperCase();
  return '';
}
async function extractBackgroundSpec(zip, xmlDoc, relMap) {
  const bg = firstLocalName(xmlDoc, 'bg');
  if (!bg) return null;
  const bgPr = firstLocalName(bg, 'bgPr') || bg;
  const blipFill = firstLocalName(bgPr, 'blipFill');
  if (blipFill) {
    const blip = firstLocalName(blipFill, 'blip');
    const rid = relAttr(blip, 'embed') || attrAny(blip, ['embed']);
    const targetPath = relMap[rid];
    if (targetPath) {
      const data = await zipFileToDataUrl(zip, targetPath);
      if (data) return { type:'image', data };
    }
  }
  const solidFill = firstLocalName(bgPr, 'solidFill');
  const color = findColorHex(solidFill);
  if (color) return { type:'color', color };
  return null;
}
async function resolveSlideBackground(zip, slidePath, slideXml, slideRelMap) {
  const slideBg = await extractBackgroundSpec(zip, slideXml, slideRelMap);
  if (slideBg) return slideBg;
  const layoutPath = pickFirstPath(slideRelMap, /ppt\/slideLayouts\/slideLayout\d+\.xml$/i);
  if (!layoutPath || !zip.file(layoutPath)) return null;
  const layoutXml = xmlFrom(await zip.file(layoutPath).async('text'));
  const layoutRelPath = layoutPath.replace('ppt/slideLayouts/', 'ppt/slideLayouts/_rels/') + '.rels';
  const layoutRelMap = await parseRelationshipMap(zip, layoutRelPath);
  const layoutBg = await extractBackgroundSpec(zip, layoutXml, layoutRelMap);
  if (layoutBg) return layoutBg;
  const masterPath = pickFirstPath(layoutRelMap, /ppt\/slideMasters\/slideMaster\d+\.xml$/i);
  if (!masterPath || !zip.file(masterPath)) return null;
  const masterXml = xmlFrom(await zip.file(masterPath).async('text'));
  const masterRelPath = masterPath.replace('ppt/slideMasters/', 'ppt/slideMasters/_rels/') + '.rels';
  const masterRelMap = await parseRelationshipMap(zip, masterRelPath);
  return await extractBackgroundSpec(zip, masterXml, masterRelMap);
}
function getMimeType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}
async function zipFileToDataUrl(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  const bytes = await file.async('uint8array');
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${getMimeType(path)};base64,${btoa(binary)}`;
}
async function extractPptxDocument(file) {
  log('documentLog', `开始解析 PPTX：${file.name}`);
  const sourceBuffer = await file.arrayBuffer();
  const zip = await window.JSZip.loadAsync(sourceBuffer);
  const presentation = xmlFrom(await zip.file('ppt/presentation.xml').async('text'));
  const sizeNode = firstLocalName(presentation, 'sldSz');
  const width = emuToInch(attrAny(sizeNode, ['cx'])) || 13.333;
  const height = emuToInch(attrAny(sizeNode, ['cy'])) || 7.5;
  const slideFiles = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/slide(\d+)/i)[1]) - Number(b.match(/slide(\d+)/i)[1]));
  const slides = [];
  for (const slidePath of slideFiles) {
    const slideIndex = Number(slidePath.match(/slide(\d+)/i)[1]);
    const slideXml = xmlFrom(await zip.file(slidePath).async('text'));
    const relPath = slidePath.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const relMap = await parseRelationshipMap(zip, relPath);
    const background = await resolveSlideBackground(zip, slidePath, slideXml, relMap);
    const shapes = [];
    localNameNodes(slideXml, 'sp').forEach(sp => {
      const txBody = firstLocalName(sp, 'txBody');
      if (!txBody) return;
      const paragraphs = localNameNodes(txBody, 'p').map(p => localNameNodes(p, 't').map(t => t.textContent || '').join('')).filter(Boolean);
      const text = paragraphs.join('\n').replace(/\u000b/g, '\n').trim();
      if (!isLikelyText(text)) return;
      const xfrm = firstLocalName(sp, 'xfrm') || firstLocalName(firstLocalName(sp, 'spPr') || sp, 'xfrm');
      const off = xfrm ? firstLocalName(xfrm, 'off') : null;
      const ext = xfrm ? firstLocalName(xfrm, 'ext') : null;
      const rPr = firstLocalName(txBody, 'rPr') || firstLocalName(txBody, 'defRPr') || firstLocalName(sp, 'rPr');
      const fontSize = Math.max(10, Number(attrAny(rPr, ['sz']) || 1800) / 100);
      const idNode = firstLocalName(sp, 'cNvPr');
      const shapeNodeId = attrAny(idNode, ['id']) || String(shapes.length + 1);
      shapes.push({
        id: `slide-${slideIndex}-shape-${shapeNodeId}`,
        kind: 'shape',
        shapeNodeId,
        text,
        x: emuToInch(attrAny(off, ['x'])),
        y: emuToInch(attrAny(off, ['y'])),
        w: Math.max(0.8, emuToInch(attrAny(ext, ['cx']))),
        h: Math.max(0.35, emuToInch(attrAny(ext, ['cy']))),
        fontSize,
      });
    });
    localNameNodes(slideXml, 'graphicFrame').forEach(frame => {
      const table = firstLocalName(frame, 'tbl');
      if (!table) return;
      const frameNodeId = attrAny(firstLocalName(frame, 'cNvPr'), ['id']) || String(shapes.length + 1);
      localNameNodes(table, 'tc').forEach((cell, cellIndex) => {
        const txBody = firstLocalName(cell, 'txBody');
        if (!txBody) return;
        const paragraphs = Array.from(txBody.children).filter(node => node.localName === 'p')
          .map(p => localNameNodes(p, 't').map(t => t.textContent || '').join('')).filter(Boolean);
        const text = paragraphs.join('\n').replace(/\u000b/g, '\n').trim();
        if (!isLikelyText(text)) return;
        shapes.push({
          id: `slide-${slideIndex}-table-${frameNodeId}-cell-${cellIndex}`,
          kind: 'tableCell', frameNodeId, cellIndex, text,
        });
      });
    });
    const images = [];
    for (const pic of localNameNodes(slideXml, 'pic')) {
      const blip = firstLocalName(pic, 'blip');
      const rid = relAttr(blip, 'embed') || attrAny(blip, ['embed']);
      const targetPath = relMap[rid];
      if (!targetPath) continue;
      const xfrm = firstLocalName(pic, 'xfrm') || firstLocalName(firstLocalName(pic, 'spPr') || pic, 'xfrm');
      const off = xfrm ? firstLocalName(xfrm, 'off') : null;
      const ext = xfrm ? firstLocalName(xfrm, 'ext') : null;
      const data = await zipFileToDataUrl(zip, targetPath);
      if (!data) continue;
      const picNodeId = attrAny(firstLocalName(pic, 'cNvPr'), ['id']) || String(images.length + 1);
      images.push({
        id: `slide-${slideIndex}-image-${picNodeId}`,
        kind: 'image', picNodeId, rid, targetPath,
        data,
        x: emuToInch(attrAny(off, ['x'])),
        y: emuToInch(attrAny(off, ['y'])),
        w: Math.max(0.5, emuToInch(attrAny(ext, ['cx']))),
        h: Math.max(0.5, emuToInch(attrAny(ext, ['cy']))),
      });
    }
    const diagrams = [];
    for (const [relId, diagramPath] of Object.entries(relMap).filter(([, path]) => /^ppt\/diagrams\/(?:data|drawing)\d+\.xml$/i.test(path))) {
      if (!zip.file(diagramPath)) continue;
      const diagramXml = xmlFrom(await zip.file(diagramPath).async('text'));
      const items = localNameNodes(diagramXml, 't').map((node, nodeIndex) => ({
        id:`slide-${slideIndex}-diagram-${relId}-text-${nodeIndex}`,
        kind:'diagram', relId, diagramPath, nodeIndex, text:String(node.textContent || '').trim(),
      })).filter(item => isLikelyText(item.text));
      if (items.length) diagrams.push({ relId, diagramPath, items });
    }
    slides.push({ index:slideIndex, slidePath, relPath, shapes, images, diagrams, background });
  }
  log('documentLog', `PPTX 解析完成：${file.name}，共 ${slides.length} 页。`);
  return { type:'pptx', name:file.name, width, height, slides, sourceBuffer };
}
function collectDocumentTasks(doc) {
  if (doc.type === 'pdf') {
    const tasks = [];
    doc.pages.forEach(page => page.blocks.forEach((block, index) => tasks.push({ id:`page-${page.pageNo}-block-${index + 1}`, source:block.text })));
    return tasks;
  }
  const tasks = [];
  doc.slides.forEach(slide => {
    slide.shapes.forEach(shape => {
      const lines = String(shape.text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      tasks.push({ ...shape, id:shape.id, source:shape.text, lines });
    });
    (slide.diagrams || []).forEach(diagram => diagram.items.forEach(item => {
      const lines = String(item.text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      tasks.push({ ...item, source:item.text, lines });
    }));
    if ($('docTranslateImages')?.checked) {
      slide.images.forEach(image => tasks.push({ ...image, id:image.id, source:'', imageData:image.data }));
    }
  });
  return tasks;
}
function validatePptxTranslationChecklist(task, translated) {
  const sourceLines = (task.lines || []).length;
  const targetLines = String(translated || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).length;
  const issues = [];
  if (sourceLines > 1 && targetLines < sourceLines) issues.push(`行数缩减：原 ${sourceLines} 行，译文 ${targetLines} 行`);
  if (sourceLines > 1 && / \/\s?/.test(String(translated || ''))) issues.push('疑似多列内容被合并为斜杠分隔');
  const sourceEffective = String(task.source || '').replace(/\s+/g, '').length;
  const targetEffective = String(translated || '').replace(/\s+/g, '').length;
  if (sourceEffective >= 12 && targetEffective <= 2) issues.push(`译文有效字符过少：原 ${sourceEffective}，译文 ${targetEffective}`);
  if (sourceLines > 1 && targetLines > sourceLines * 2 + 1) issues.push(`行数异常膨胀：原 ${sourceLines} 行，译文 ${targetLines} 行`);
  return issues;
}
function rebalanceLinesToCount(text, targetCount) {
  const count = Math.max(1, Number(targetCount) || 1);
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return Array(count).fill('');
  if (lines.length === count) return lines;
  if (lines.length > count) return [...lines.slice(0, count - 1), lines.slice(count - 1).join(' ')];
  const words = lines.join(' ').split(/\s+/).filter(Boolean);
  if (!words.length) return Array(count).fill('');
  const out = Array.from({ length: count }, () => []);
  words.forEach((w, i) => out[Math.min(count - 1, Math.floor(i * count / words.length))].push(w));
  return out.map(item => item.join(' '));
}
async function translatePptxTask(task, targetLang, meta, standard) {
  if (!task.lines || task.lines.length <= 1) {
    return await workflowTranslate(task.source, meta.sourceLang, targetLang, '', {
      protectedTerms: meta.protectedTerms,
      customRules: meta.customRules,
      standardTranslation: standard && meta.translationMemoryMode === 'review' ? standard.text : ''
    }, meta.workflowMode, 'documentLog');
  }
  const translatedLines = [];
  for (const line of task.lines) {
    const one = await workflowTranslate(line, meta.sourceLang, targetLang, '', {
      protectedTerms: meta.protectedTerms,
      customRules: meta.customRules,
      standardTranslation: ''
    }, meta.workflowMode, 'documentLog');
    translatedLines.push(String(one || '').trim());
  }
  return rebalanceLinesToCount(translatedLines.join('\n'), task.lines.length).join('\n');
}
async function translateDocumentToLanguage(doc, targetLang, meta, counter) {
  const tasks = collectDocumentTasks(doc);
  const results = new Map();
  const imageResultCache = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length && !state.cancel) {
      const task = tasks[cursor++];
      try {
        if (task.kind === 'image') {
          const cacheKey = `${targetLang}:${task.targetPath || task.id}`;
          if (!imageResultCache.has(cacheKey)) {
            imageResultCache.set(cacheKey, withRetry(() => translatePptxImageTask(task, targetLang, meta), meta.retries, 'documentLog'));
          }
          const regions = await imageResultCache.get(cacheKey);
          results.set(task.id, { regions, text:'', warning:'', error:'' });
          log('documentLog', `图片识别完成 ${task.id}：${regions.length} 个文字区域。`);
          continue;
        }
        const standard = lookupTranslationMemory(task.source, targetLang);
        let translated = '';
        if (standard && meta.translationMemoryMode === 'direct') {
          translated = standard.text;
          state.translationMemoryStats.hits++;
        } else {
          if (!standard) state.translationMemoryStats.missesByLang[targetLang] = (state.translationMemoryStats.missesByLang[targetLang] || 0) + 1;
          translated = await withRetry(() => (
            doc.type === 'pptx'
              ? translatePptxTask(task, targetLang, meta, standard)
              : workflowTranslate(task.source, meta.sourceLang, targetLang, '', {
                protectedTerms: meta.protectedTerms,
                customRules: meta.customRules,
                standardTranslation: standard && meta.translationMemoryMode === 'review' ? standard.text : ''
              }, meta.workflowMode, 'documentLog')
          ), meta.retries, 'documentLog');
        }
        if (doc.type === 'pptx') {
          const checklistIssues = validatePptxTranslationChecklist(task, translated);
          if (checklistIssues.length) {
            log('documentLog', `PPTX 质检提示 ${task.id}：${checklistIssues.join('；')}`);
            const fallbackLines = [];
            for (const line of (task.lines || [task.source])) {
              const one = await withRetry(() => workflowTranslate(line, meta.sourceLang, targetLang, '', {
                protectedTerms: meta.protectedTerms,
                customRules: meta.customRules,
                standardTranslation: ''
              }, meta.workflowMode, 'documentLog'), meta.retries, 'documentLog');
              fallbackLines.push(String(one || '').trim());
            }
            translated = rebalanceLinesToCount(fallbackLines.join('\n'), (task.lines || []).length || 1).join('\n');
          }
        }
        const missing = validateProtectedTerms(task.source, translated, meta.protectedTerms);
        results.set(task.id, { text: translated, warning: missing.length ? '受保护术语缺失：' + missing.join(' / ') : '', error:'' });
      } catch (error) {
        results.set(task.id, { text:'', warning:'', error:error.message || String(error), errorCode:error.code || '' });
        state.errors++;
        stat();
      } finally {
        counter.done++;
        state.done++;
        stat();
        updateProgress(counter.done, counter.total);
      }
    }
  }
  const concurrency = doc.type === 'pptx' && meta.translateImages ? 1 : meta.concurrency;
  if (concurrency !== meta.concurrency) log('documentLog', '已启用图片翻译：本次任务自动使用单并发，避免多模态模型过载。');
  await Promise.all(Array.from({length: concurrency}, () => worker()));
  return results;
}
function validatePptxResultCoverage(doc, results, includeImages) {
  const expected = [];
  doc.slides.forEach(slide => {
    slide.shapes.forEach(item => expected.push(item));
    (slide.diagrams || []).forEach(diagram => diagram.items.forEach(item => expected.push(item)));
    if (includeImages) slide.images.forEach(item => expected.push(item));
  });
  const failures = [];
  expected.forEach(task => {
    const result = results.get(task.id);
    if (!result) failures.push({ id:task.id, code:'MISSING_RESULT', message:'缺少翻译结果' });
    else if (result.error) failures.push({ id:task.id, code:result.errorCode || 'TRANSLATION_ERROR', message:result.error });
    else if (task.kind !== 'image' && !String(result.text || '').trim()) failures.push({ id:task.id, code:'EMPTY_TRANSLATION', message:'译文为空' });
  });
  if (failures.length) {
    const grouped = new Map();
    failures.forEach(item => grouped.set(item.code, (grouped.get(item.code) || 0) + 1));
    const labels = {
      UPSTREAM_OVERLOADED:'模型引擎过载', CORPORATE_PROXY_BLOCK:'企业安全代理拦截',
      NETWORK_ERROR:'网络错误', OCR_TRANSLATION_INCOMPLETE:'OCR 译文不完整',
      MISSING_RESULT:'缺少结果', EMPTY_TRANSLATION:'译文为空', TRANSLATION_ERROR:'其他翻译错误',
    };
    const summary = Array.from(grouped, ([code, count]) => `${labels[code] || code} ${count} 个`).join('；');
    const examples = failures.slice(0, 12).map(item => `${item.id}：${item.message}`).join('\n');
    throw new Error(`PPTX 完整性检查未通过：${failures.length}/${expected.length} 个对象未成功翻译（${summary}）。为避免输出漏译页面，本次不生成 PPTX。\n${examples}`);
  }
  return { expected:expected.length, images:expected.filter(item => item.kind === 'image').length };
}
function buildPdfMarkdown(doc, lang, results) {
  const lines = [`# ${doc.name} - ${lang} 双语文档`, '', `- 输出语言：${lang}`, `- 页面数：${doc.pages.length}`, ''];
  doc.pages.forEach(page => {
    lines.push(`## 第 ${page.pageNo} 页`, '');
    if (!page.blocks.length) {
      lines.push('> 本页未识别到可翻译文本。', '');
      return;
    }
    page.blocks.forEach((block, index) => {
      const item = results.get(`page-${page.pageNo}-block-${index + 1}`) || { text:'', error:'未生成结果', warning:'' };
      lines.push(`### 文本块 ${index + 1}`, '', '**原文**', '', block.text || '(空)', '', '**译文**', '', item.error ? `[ERROR] ${item.error}` : (item.text || '(空)'), '');
      if (item.warning) lines.push(`> Warning: ${item.warning}`, '');
    });
  });
  return lines.join('\n');
}
async function buildPdfDocx(doc, lang, results) {
  const d = window.docx;
  const children = [
    new d.Paragraph({ text:`${doc.name} - ${lang} 双语文档`, heading:d.HeadingLevel.TITLE }),
    new d.Paragraph({ text:`输出语言：${lang}` }),
    new d.Paragraph({ text:`页面数：${doc.pages.length}` }),
  ];
  doc.pages.forEach(page => {
    children.push(new d.Paragraph({ text:`第 ${page.pageNo} 页`, heading:d.HeadingLevel.HEADING_1 }));
    const rows = [new d.TableRow({ children:[new d.TableCell({ children:[new d.Paragraph('原文')] }), new d.TableCell({ children:[new d.Paragraph('译文')] }), new d.TableCell({ children:[new d.Paragraph('备注')] })] })];
    if (!page.blocks.length) {
      rows.push(new d.TableRow({ children:[new d.TableCell({ children:[new d.Paragraph('（空）')] }), new d.TableCell({ children:[new d.Paragraph('（空）')] }), new d.TableCell({ children:[new d.Paragraph('未识别到可翻译文本')] })] }));
    } else {
      page.blocks.forEach((block, index) => {
        const item = results.get(`page-${page.pageNo}-block-${index + 1}`) || { text:'', error:'未生成结果', warning:'' };
        rows.push(new d.TableRow({ children:[
          new d.TableCell({ children:[new d.Paragraph(block.text || '')] }),
          new d.TableCell({ children:[new d.Paragraph(item.error ? '' : (item.text || ''))] }),
          new d.TableCell({ children:[new d.Paragraph(item.error || item.warning || '')] }),
        ] }));
      });
    }
    children.push(new d.Table({ rows, width:{ size:100, type:d.WidthType.PERCENTAGE } }));
  });
  const docxFile = new d.Document({ sections:[{ children }] });
  return await d.Packer.toBlob(docxFile);
}
function pdfBlockRectStyle(block, page) {
  if (!block.bbox || !page.width || !page.height) return '';
  const clamp = value => Math.min(100, Math.max(0, value));
  const left = clamp(block.bbox.x0 / page.width * 100);
  const top = clamp((page.height - block.bbox.y1) / page.height * 100);
  const width = clamp((block.bbox.x1 - block.bbox.x0) / page.width * 100);
  const height = clamp((block.bbox.y1 - block.bbox.y0) / page.height * 100);
  return `left:${left.toFixed(2)}%;top:${top.toFixed(2)}%;width:${Math.max(width, 0.5).toFixed(2)}%;height:${Math.max(height, 0.5).toFixed(2)}%`;
}
function buildPdfComparisonHtml(doc, lang, results) {
  const out = [];
  out.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" />');
  out.push(`<title>${escapeHtml(doc.name)} - ${escapeHtml(lang)} 图文对照</title>`);
  out.push('<meta name="viewport" content="width=device-width, initial-scale=1" />');
  out.push('<style>');
  out.push('body{margin:0;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f3f4f6;color:#111827;}');
  out.push('header{position:sticky;top:0;z-index:10;background:#111827;color:#f9fafb;padding:10px 20px;font-size:14px;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;}');
  out.push('header b{font-size:16px;}header span{opacity:.75;}');
  out.push('.page{max-width:1500px;margin:20px auto;padding:0 16px;}');
  out.push('.page-title{font-size:15px;font-weight:600;margin:0 0 8px;display:flex;gap:8px;align-items:center;}');
  out.push('.badge{font-size:11px;background:#fde68a;color:#92400e;border-radius:999px;padding:1px 8px;font-weight:500;}');
  out.push('.layout{display:flex;gap:14px;align-items:flex-start;}');
  out.push('.preview{flex:0 0 55%;position:sticky;top:52px;}');
  out.push('.canvasWrap{position:relative;border:1px solid #d1d5db;border-radius:6px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);}');
  out.push('.canvasWrap img{display:block;width:100%;}');
  out.push('.noimg{padding:48px 16px;text-align:center;color:#6b7280;font-size:13px;}');
  out.push('.hl{position:absolute;border:2px solid transparent;border-radius:3px;pointer-events:none;transition:all .15s;}');
  out.push('.hl.active{border-color:#f59e0b;background:rgba(245,158,11,.18);box-shadow:0 0 0 3px rgba(245,158,11,.25);}');
  out.push('.blocks{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;}');
  out.push('.block{background:#fff;border:1px solid #e5e7eb;border-left:4px solid #e5e7eb;border-radius:6px;padding:10px 12px;cursor:pointer;}');
  out.push('.block.active{border-left-color:#f59e0b;background:#fffbeb;}');
  out.push('.block .num{display:inline-block;font-size:11px;color:#6b7280;background:#f3f4f6;border-radius:999px;padding:0 8px;margin-bottom:6px;}');
  out.push('.block .tr{white-space:pre-wrap;font-size:14px;line-height:1.65;}');
  out.push('.block details{margin-top:8px;font-size:12px;color:#6b7280;}');
  out.push('.block details pre{white-space:pre-wrap;margin:6px 0 0;font-family:inherit;background:#f9fafb;border-radius:4px;padding:6px 8px;}');
  out.push('.block .warn{margin-top:6px;font-size:12px;color:#b45309;}');
  out.push('.block .err{margin-top:6px;font-size:12px;color:#b91c1c;}');
  out.push('.empty{color:#6b7280;font-size:13px;background:#fff;border:1px dashed #d1d5db;border-radius:6px;padding:14px;}');
  out.push('@media (max-width: 900px){.layout{flex-direction:column;}.preview{position:static;flex:none;width:100%;}}');
  out.push('@media print{.preview{position:static;}header{position:static;}}');
  out.push('</style></head><body>');
  out.push(`<header><b>${escapeHtml(doc.name)}</b><span>译文语言：${escapeHtml(lang)}</span><span>共 ${doc.pages.length} 页</span><span>点击右侧译文块可在左侧原文页上高亮对应位置</span></header>`);
  doc.pages.forEach(page => {
    out.push('<section class="page">');
    out.push(`<h2 class="page-title">第 ${page.pageNo} 页${page.extraction === 'ocr' ? '<span class="badge">OCR 页</span>' : ''}</h2>`);
    out.push('<div class="layout">');
    out.push('<div class="preview"><div class="canvasWrap">');
    if (page.image) {
      out.push(`<img src="${page.image}" alt="第 ${page.pageNo} 页原文" loading="lazy" />`);
      page.blocks.forEach((block, index) => {
        const style = pdfBlockRectStyle(block, page);
        if (style) out.push(`<div class="hl" id="hl-p${page.pageNo}-b${index}" style="${style}"></div>`);
      });
    } else {
      out.push('<div class="noimg">本页未生成原文截图。</div>');
    }
    out.push('</div></div>');
    out.push('<div class="blocks">');
    if (!page.blocks.length) {
      out.push('<div class="empty">本页未识别到可翻译文本。</div>');
    } else {
      page.blocks.forEach((block, index) => {
        const item = results.get(`page-${page.pageNo}-block-${index + 1}`) || { text:'', error:'未生成结果', warning:'' };
        out.push(`<div class="block" data-hl="hl-p${page.pageNo}-b${index}" tabindex="0">`);
        out.push(`<span class="num">第 ${page.pageNo} 页 · 块 ${index + 1}</span>`);
        out.push(`<div class="tr">${item.error ? '' : escapeHtml(item.text || '(空)')}</div>`);
        if (item.error) out.push(`<div class="err">[ERROR] ${escapeHtml(item.error)}</div>`);
        if (item.warning) out.push(`<div class="warn">${escapeHtml(item.warning)}</div>`);
        out.push(`<details><summary>原文</summary><pre>${escapeHtml(block.text || '(空)')}</pre></details>`);
        out.push('</div>');
      });
    }
    out.push('</div></div></section>');
  });
  out.push('<script>');
  out.push('document.addEventListener("click", function (event) {');
  out.push('  var block = event.target.closest(".block");');
  out.push('  if (!block) return;');
  out.push('  var actives = document.querySelectorAll(".active");');
  out.push('  for (var i = 0; i < actives.length; i++) actives[i].classList.remove("active");');
  out.push('  block.classList.add("active");');
  out.push('  var hl = document.getElementById(block.getAttribute("data-hl") || "");');
  out.push('  if (hl) hl.classList.add("active");');
  out.push('});');
  out.push('<\/script></body></html>');
  return out.join('\n');
}
function nextNumericId(values, fallback) {
  const nums = values.map(value => Number(String(value).replace(/^\D+/, ''))).filter(Number.isFinite);
  return (nums.length ? Math.max(...nums) : fallback) + 1;
}
function removeChildrenByLocalNames(parent, names) {
  Array.from(parent.children).forEach(child => {
    if (names.includes(child.localName)) parent.removeChild(child);
  });
}
function ensureTextRun(paragraph, xmlDoc) {
  let run = Array.from(paragraph.children).find(child => child.localName === 'r');
  if (run) return run;
  run = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:r');
  run.appendChild(xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:rPr'));
  run.appendChild(xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:t'));
  const endPara = Array.from(paragraph.children).find(child => child.localName === 'endParaRPr');
  if (endPara) paragraph.insertBefore(run, endPara);
  else paragraph.appendChild(run);
  return run;
}
function setTextNodeContent(textNode, value) {
  const content = String(value || '');
  textNode.textContent = content;
  if (/^\s|\s$/.test(content) || /\s{2,}/.test(content)) textNode.setAttribute('xml:space', 'preserve');
  else textNode.removeAttribute('xml:space');
}
function readParagraphRunBlueprint(paragraph) {
  const runs = localNameNodes(paragraph, 'r').map(run => {
    const rPr = firstLocalName(run, 'rPr');
    const pPr = firstLocalName(paragraph, 'pPr');
    const tNodes = localNameNodes(run, 't');
    return {
      size: String(attrAny(rPr, ['sz']) || ''),
      effective: tNodes.map(n => (n.textContent || '').replace(/\s+/g, '').length).reduce((a, b) => a + b, 0),
      textNodes: tNodes.length || 1,
      paraSpacingBefore: String(attrAny(firstLocalName(pPr, 'spcBef'), ['val']) || ''),
    };
  });
  return runs;
}
function readShapeBlueprint(txBody) {
  const paragraphs = Array.from(txBody.children).filter(child => child.localName === 'p');
  return paragraphs.map(readParagraphRunBlueprint);
}
function validateShapeBlueprint(before, after) {
  if (before.length !== after.length) return '段落数量变化';
  for (let i = 0; i < before.length; i++) {
    if (before[i].length !== after[i].length) return `第 ${i + 1} 段 run 数量变化`;
    for (let j = 0; j < before[i].length; j++) {
      if (before[i][j].size !== after[i][j].size) return `第 ${i + 1} 段第 ${j + 1} 个 run 字号变化`;
      if (before[i][j].textNodes !== after[i][j].textNodes) return `第 ${i + 1} 段第 ${j + 1} 个 run 文本节点数量变化`;
      if (before[i][j].paraSpacingBefore !== after[i][j].paraSpacingBefore) return `第 ${i + 1} 段段前距变化`;
    }
  }
  return '';
}
function replaceParagraphTextPreservingRuns(paragraph, text, xmlDoc) {
  const textNodes = localNameNodes(paragraph, 't');
  if (!textNodes.length) {
    const run = ensureTextRun(paragraph, xmlDoc);
    const textNode = firstLocalName(run, 't') || xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:t');
    if (!textNode.parentNode) run.appendChild(textNode);
    setTextNodeContent(textNode, text);
    return;
  }
  const effectiveCounts = textNodes.map(node => (node.textContent || '').replace(/\s+/g, '').length);
  const totalEffective = effectiveCounts.reduce((sum, count) => sum + count, 0);
  if (!totalEffective) {
    textNodes.forEach((node, index) => setTextNodeContent(node, index === 0 ? text : ''));
    return;
  }
  const chars = Array.from(String(text || ''));
  const effectiveChars = chars.filter(ch => !/\s/.test(ch));
  const targets = [];
  let remainingEffective = effectiveChars.length;
  effectiveCounts.forEach((count, index) => {
    if (index === effectiveCounts.length - 1) {
      targets.push(Math.max(0, remainingEffective));
      remainingEffective = 0;
      return;
    }
    const take = Math.min(count, Math.max(0, remainingEffective));
    targets.push(take);
    remainingEffective -= take;
  });
  let charCursor = 0;
  let effectiveCursor = 0;
  textNodes.forEach((node, index) => {
    const targetStart = effectiveCursor;
    const targetEnd = effectiveCursor + (targets[index] || 0);
    effectiveCursor = targetEnd;
    let consumedEffective = 0;
    const out = [];
    while (charCursor < chars.length) {
      const ch = chars[charCursor];
      const isEffective = !/\s/.test(ch);
      if (isEffective && (targetStart + consumedEffective) >= targetEnd) break;
      out.push(ch);
      if (isEffective) consumedEffective += 1;
      charCursor += 1;
    }
    if (index === textNodes.length - 1 && charCursor < chars.length) out.push(chars.slice(charCursor).join(''));
    setTextNodeContent(node, out.join(''));
  });
}
function splitTextByParagraphEffectiveCounts(text, paragraphs) {
  const source = String(text || '');
  if (/\r?\n/.test(source)) {
    const lines = source.split(/\r?\n/);
    if (lines.length === paragraphs.length) return lines;
    return splitTextByParagraphCount(source, paragraphs.length);
  }
  const chars = Array.from(source);
  const effectiveCounts = paragraphs.map(p => localNameNodes(p, 't').map(n => (n.textContent || '').replace(/\s+/g, '').length).reduce((a, b) => a + b, 0));
  const totalEffective = effectiveCounts.reduce((a, b) => a + b, 0);
  if (!totalEffective) return splitTextByParagraphCount(source, paragraphs.length);
  const totalTranslatedEffective = chars.filter(ch => !/\s/.test(ch)).length;
  const targets = [];
  let remaining = totalTranslatedEffective;
  effectiveCounts.forEach((count, index) => {
    if (index === effectiveCounts.length - 1) {
      targets.push(Math.max(0, remaining));
      return;
    }
    const take = Math.min(count, Math.max(0, remaining));
    targets.push(take);
    remaining -= take;
  });
  let charCursor = 0;
  let effectiveCursor = 0;
  return paragraphs.map((_, index) => {
    const targetStart = effectiveCursor;
    const targetEnd = effectiveCursor + (targets[index] || 0);
    effectiveCursor = targetEnd;
    let consumedEffective = 0;
    const out = [];
    while (charCursor < chars.length) {
      const ch = chars[charCursor];
      const isEffective = !/\s/.test(ch);
      if (isEffective && (targetStart + consumedEffective) >= targetEnd) break;
      out.push(ch);
      if (isEffective) consumedEffective += 1;
      charCursor += 1;
    }
    if (index === paragraphs.length - 1 && charCursor < chars.length) out.push(chars.slice(charCursor).join(''));
    return out.join('');
  });
}
function splitTextByParagraphCount(text, count) {
  const targetCount = Math.max(1, count || 1);
  const sourceText = String(text || '');
  const explicitLines = /\r?\n/.test(sourceText) ? sourceText.split(/\r?\n/) : [];
  if (explicitLines.length) {
    if (explicitLines.length === targetCount) return explicitLines;
    if (explicitLines.length > targetCount) {
      return [
        ...explicitLines.slice(0, targetCount - 1),
        explicitLines.slice(targetCount - 1).join('\n')
      ];
    }
    return [...explicitLines, ...Array(targetCount - explicitLines.length).fill('')];
  }
  const words = sourceText.split(/\s+/).filter(Boolean);
  if (!words.length) return Array(targetCount).fill('');
  if (targetCount === 1) return [words.join(' ')];
  if (words.length === 1) {
    const chars = Array.from(sourceText);
    return Array.from({ length: targetCount }, (_, index) => {
      const start = Math.floor(index * chars.length / targetCount);
      const end = Math.floor((index + 1) * chars.length / targetCount);
      return chars.slice(start, end).join('');
    });
  }
  const lines = Array.from({ length: targetCount }, () => []);
  words.forEach((word, index) => {
    const lineIndex = Math.min(targetCount - 1, Math.floor(index * targetCount / words.length));
    lines[lineIndex].push(word);
  });
  return lines.map(line => line.join(' '));
}
function scaleExplicitFontSizes(txBody, fontScale) {
  if (!fontScale || fontScale === 100000) return;
  Array.from(txBody.getElementsByTagName('*')).forEach(node => {
    if (!['rPr', 'defRPr', 'endParaRPr'].includes(node.localName)) return;
    const sz = Number(node.getAttribute('sz'));
    if (!Number.isFinite(sz) || sz <= 0) return;
    node.setAttribute('sz', String(Math.max(100, Math.round(sz * fontScale / 100000))));
  });
}
function setNoAutofit(bodyPr, xmlDoc, replaceNode) {
  const noAutofit = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:noAutofit');
  if (replaceNode) {
    bodyPr.replaceChild(noAutofit, replaceNode);
    return;
  }
  const tail = Array.from(bodyPr.children).find(child => ['scene3d', 'sp3d', 'flatTx', 'extLst'].includes(child.localName));
  if (tail) bodyPr.insertBefore(noAutofit, tail);
  else bodyPr.appendChild(noAutofit);
}
function lockTranslatedBodyLayout(txBody, xmlDoc) {
  let bodyPr = Array.from(txBody.children).find(child => child.localName === 'bodyPr');
  if (!bodyPr) {
    bodyPr = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:bodyPr');
    txBody.insertBefore(bodyPr, txBody.firstChild);
  }
  bodyPr.setAttribute('wrap', 'none');
  const children = Array.from(bodyPr.children);
  const normAutofit = children.find(child => child.localName === 'normAutofit');
  const spAutoFit = children.find(child => child.localName === 'spAutoFit');
  const hasNoAutofit = children.some(child => child.localName === 'noAutofit');
  if (normAutofit) {
    const fontScale = Number(normAutofit.getAttribute('fontScale') || 100000);
    const lnSpcReduction = Number(normAutofit.getAttribute('lnSpcReduction') || 0);
    if (fontScale === 100000 && !lnSpcReduction) {
      setNoAutofit(bodyPr, xmlDoc, normAutofit);
      return;
    }
    const textRuns = [...localNameNodes(txBody, 'r'), ...localNameNodes(txBody, 'fld')].filter(run => localNameNodes(run, 't').length);
    const allRunsSized = textRuns.length > 0 && textRuns.every(run => {
      const rPr = firstLocalName(run, 'rPr');
      return rPr && Number(rPr.getAttribute('sz')) > 0;
    });
    if (allRunsSized && !lnSpcReduction) {
      scaleExplicitFontSizes(txBody, fontScale);
      setNoAutofit(bodyPr, xmlDoc, normAutofit);
    }
    return;
  }
  if (spAutoFit) {
    setNoAutofit(bodyPr, xmlDoc, spAutoFit);
    return;
  }
  if (!hasNoAutofit) setNoAutofit(bodyPr, xmlDoc, null);
}
function updateTranslatedTextBody(txBody, translatedText, xmlDoc) {
  if (!txBody) return;
  const beforeBlueprint = readShapeBlueprint(txBody);
  const paragraphs = Array.from(txBody.children).filter(child => child.localName === 'p');
  let paragraph = paragraphs[0];
  if (!paragraph) {
    paragraph = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:p');
    txBody.appendChild(paragraph);
  }
  const targetParagraphs = paragraphs.length ? paragraphs : [paragraph];
  const paragraphParts = splitTextByParagraphEffectiveCounts(translatedText, targetParagraphs);
  targetParagraphs.forEach((item, index) => replaceParagraphTextPreservingRuns(item, paragraphParts[index] || '', xmlDoc));
  const afterBlueprint = readShapeBlueprint(txBody);
  const structureError = validateShapeBlueprint(beforeBlueprint, afterBlueprint);
  if (structureError) {
    log('documentLog', `PPTX 结构回退：${structureError}`);
    const translatedParts = rebalanceLinesToCount(translatedText, targetParagraphs.length);
    targetParagraphs.forEach((item, index) => {
      const part = translatedParts[index] || '';
      const tNodes = localNameNodes(item, 't');
      if (!tNodes.length) {
        replaceParagraphTextPreservingRuns(item, part, xmlDoc);
        return;
      }
      tNodes.forEach((node, tIndex) => setTextNodeContent(node, tIndex === 0 ? part : ''));
    });
  }
  lockTranslatedBodyLayout(txBody, xmlDoc);
}

function updateTranslatedShape(sp, translatedText, xmlDoc) {
  const txBody = firstLocalName(sp, 'txBody');
  if (!txBody) return;
  updateTranslatedTextBody(txBody, translatedText, xmlDoc);

  let spPr = firstLocalName(sp, 'spPr');
  if (!spPr) {
    spPr = xmlDoc.createElementNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'p:spPr');
    const txBodyNode = firstLocalName(sp, 'txBody');
    if (txBodyNode) sp.insertBefore(spPr, txBodyNode);
    else sp.appendChild(spPr);
  }
  removeChildrenByLocalNames(spPr, ['solidFill', 'gradFill', 'blipFill', 'pattFill', 'noFill']);
  const fill = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:solidFill');
  const color = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:srgbClr');
  color.setAttribute('val', 'FFF200');
  fill.appendChild(color);
  const insertBefore = Array.from(spPr.children).find(child => ['ln', 'effectLst', 'effectDag', 'scene3d', 'sp3d', 'extLst'].includes(child.localName));
  if (insertBefore) spPr.insertBefore(fill, insertBefore);
  else spPr.appendChild(fill);
}
function randomUint32() {
  if (window.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return value[0];
  }
  return Math.floor(Math.random() * 0x100000000);
}
function randomGuid() {
  if (window.crypto?.randomUUID) return `{${window.crypto.randomUUID().toUpperCase()}}`;
  const hex = () => randomUint32().toString(16).padStart(8, '0').toUpperCase();
  const chars = Array.from(hex() + hex() + hex() + hex());
  chars[12] = '4';
  chars[16] = ['8','9','A','B'][randomUint32() % 4];
  const raw = chars.join('');
  return `{${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20,32)}}`;
}
function regenerateOfficeUniqueIds(xmlDoc) {
  localNameNodes(xmlDoc, 'creationId').forEach(node => {
    if (node.hasAttribute('id')) node.setAttribute('id', randomGuid());
    if (node.hasAttribute('val')) node.setAttribute('val', String(randomUint32()));
  });
  localNameNodes(xmlDoc, 'modId').forEach(node => {
    if (node.hasAttribute('val')) node.setAttribute('val', String(randomUint32()));
  });
}
function appendImageTranslationShape(spTree, xmlDoc, shapeId, rect, text) {
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const make = (ns, name) => xmlDoc.createElementNS(ns, name);
  const sp = make(P, 'p:sp');
  const nvSpPr = make(P, 'p:nvSpPr');
  const cNvPr = make(P, 'p:cNvPr'); cNvPr.setAttribute('id', String(shapeId)); cNvPr.setAttribute('name', `Image translation ${shapeId}`);
  const cNvSpPr = make(P, 'p:cNvSpPr'); cNvSpPr.setAttribute('txBox', '1');
  nvSpPr.appendChild(cNvPr); nvSpPr.appendChild(cNvSpPr); nvSpPr.appendChild(make(P, 'p:nvPr'));
  const spPr = make(P, 'p:spPr');
  const xfrm = make(A, 'a:xfrm');
  const off = make(A, 'a:off'); off.setAttribute('x', String(Math.round(rect.x))); off.setAttribute('y', String(Math.round(rect.y)));
  const ext = make(A, 'a:ext'); ext.setAttribute('cx', String(Math.max(91440, Math.round(rect.w)))); ext.setAttribute('cy', String(Math.max(45720, Math.round(rect.h))));
  xfrm.appendChild(off); xfrm.appendChild(ext); spPr.appendChild(xfrm);
  const geom = make(A, 'a:prstGeom'); geom.setAttribute('prst', 'rect'); geom.appendChild(make(A, 'a:avLst')); spPr.appendChild(geom);
  const fill = make(A, 'a:solidFill'); const fillColor = make(A, 'a:srgbClr'); fillColor.setAttribute('val', 'FFF2CC'); fill.appendChild(fillColor); spPr.appendChild(fill);
  const line = make(A, 'a:ln'); line.appendChild(make(A, 'a:noFill')); spPr.appendChild(line);
  const txBody = make(P, 'p:txBody');
  const bodyPr = make(A, 'a:bodyPr'); bodyPr.setAttribute('wrap', 'square'); bodyPr.setAttribute('anchor', 'ctr'); bodyPr.setAttribute('lIns', '30000'); bodyPr.setAttribute('rIns', '30000'); bodyPr.setAttribute('tIns', '15000'); bodyPr.setAttribute('bIns', '15000'); bodyPr.appendChild(make(A, 'a:normAutofit'));
  txBody.appendChild(bodyPr); txBody.appendChild(make(A, 'a:lstStyle'));
  const p = make(A, 'a:p'); const pPr = make(A, 'a:pPr'); pPr.setAttribute('algn', 'ctr'); p.appendChild(pPr);
  const r = make(A, 'a:r'); const rPr = make(A, 'a:rPr'); rPr.setAttribute('lang', 'en-US'); rPr.setAttribute('dirty', '0');
  const color = make(A, 'a:solidFill'); const black = make(A, 'a:srgbClr'); black.setAttribute('val', '000000'); color.appendChild(black); rPr.appendChild(color);
  const t = make(A, 'a:t'); setTextNodeContent(t, text); r.appendChild(rPr); r.appendChild(t); p.appendChild(r); p.appendChild(make(A, 'a:endParaRPr')); txBody.appendChild(p);
  sp.appendChild(nvSpPr); sp.appendChild(spPr); sp.appendChild(txBody); spTree.appendChild(sp);
}
function addImageTranslationOverlays(translatedXml, slideData, results) {
  const spTree = firstLocalName(translatedXml, 'spTree');
  if (!spTree) return 0;
  let nextId = nextNumericId(localNameNodes(translatedXml, 'cNvPr').map(node => attrAny(node, ['id'])), 1);
  let count = 0;
  slideData.images.forEach(image => {
    const result = results.get(image.id);
    if (!result || result.error || !Array.isArray(result.regions)) return;
    const pic = localNameNodes(translatedXml, 'pic').find(node => attrAny(firstLocalName(node, 'cNvPr'), ['id']) === String(image.picNodeId));
    const xfrm = pic ? firstLocalName(pic, 'xfrm') : null;
    const off = xfrm ? firstLocalName(xfrm, 'off') : null;
    const ext = xfrm ? firstLocalName(xfrm, 'ext') : null;
    const px = Number(attrAny(off, ['x'])); const py = Number(attrAny(off, ['y']));
    const pw = Number(attrAny(ext, ['cx'])); const ph = Number(attrAny(ext, ['cy']));
    if (![px, py, pw, ph].every(Number.isFinite) || pw <= 0 || ph <= 0) return;
    result.regions.forEach(region => {
      appendImageTranslationShape(spTree, translatedXml, nextId++, {
        x:px + pw * region.bbox.x, y:py + ph * region.bbox.y,
        w:pw * region.bbox.w, h:ph * region.bbox.h,
      }, region.text);
      count++;
    });
  });
  return count;
}
function pptxValidationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function loadPptxRepairMemory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PPTX_REPAIR_MEMORY_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}
function rememberPptxAttempt(profile, error) {
  const memory = loadPptxRepairMemory();
  memory.version = 1;
  memory.updatedAt = new Date().toISOString();
  memory.attempts = Number(memory.attempts || 0) + 1;
  if (error) {
    const code = error.code || 'PPTX_UNKNOWN';
    memory.failures = memory.failures || {};
    memory.failures[code] = Number(memory.failures[code] || 0) + 1;
    memory.lastFailure = { code, message:String(error.message || error).slice(0, 500), profile, at:memory.updatedAt };
  } else {
    memory.preferredCompression = profile.compression;
    memory.lastSuccess = { profile, at:memory.updatedAt };
  }
  localStorage.setItem(PPTX_REPAIR_MEMORY_KEY, JSON.stringify(memory));
}
function pptxGenerationProfiles() {
  const preferred = loadPptxRepairMemory().preferredCompression === 'STORE' ? 'STORE' : 'DEFLATE';
  const alternate = preferred === 'DEFLATE' ? 'STORE' : 'DEFLATE';
  return [{ compression:preferred }, { compression:alternate }];
}
function canRetryPptxGeneration(error) {
  return ['PPTX_ZIP_HEADER', 'PPTX_ZIP_TRUNCATED', 'PPTX_ZIP_DIRECTORY', 'PPTX_ZIP_CRC'].includes(error?.code);
}
async function pptxBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input?.arrayBuffer) return new Uint8Array(await input.arrayBuffer());
  return new Uint8Array(input || []);
}
function validateZipEnvelope(bytes) {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw pptxValidationError('PPTX_ZIP_HEADER', 'PPTX 包校验失败：文件头不是完整 ZIP 包。');
  }
  const minOffset = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset--) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw pptxValidationError('PPTX_ZIP_TRUNCATED', 'PPTX 包校验失败：缺少 ZIP 中央目录结束标记，文件可能被截断。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (!entries || centralOffset + centralSize > eocd) {
    throw pptxValidationError('PPTX_ZIP_DIRECTORY', 'PPTX 包校验失败：ZIP 中央目录范围或条目数量异常。');
  }
  return { entries, centralOffset, centralSize, eocd };
}
function relationshipSourcePath(relPath) {
  if (relPath === '_rels/.rels') return '';
  return relPath.replace('/_rels/', '/').replace(/\.rels$/i, '');
}
async function validateGeneratedPptxBlob(blob, expectedSlides) {
  const bytes = await pptxBytes(blob);
  const envelope = validateZipEnvelope(bytes);
  let zip;
  try {
    zip = await window.JSZip.loadAsync(bytes, { checkCRC32:true });
  } catch (error) {
    throw pptxValidationError('PPTX_ZIP_CRC', `PPTX 包校验失败：ZIP 解压或 CRC32 校验未通过。${error.message || error}`);
  }
  const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  const nameSet = new Set(names);
  const required = ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels'];
  required.forEach(name => {
    if (!nameSet.has(name)) throw pptxValidationError('PPTX_REQUIRED_PART', `PPTX 包校验失败：缺少必需部件 ${name}。`);
  });
  const xmlMap = new Map();
  for (const name of names.filter(name => /\.(xml|rels)$/i.test(name))) {
    const xml = xmlFrom(await zip.file(name).async('text'));
    if (xml.getElementsByTagName('parsererror').length) throw pptxValidationError('PPTX_XML_PARSE', `PPTX 包校验失败：${name} XML 无法解析。`);
    xmlMap.set(name, xml);
  }
  const contentTypes = xmlMap.get('[Content_Types].xml');
  const overrides = localNameNodes(contentTypes, 'Override').map(node => attrAny(node, ['PartName']));
  const defaults = new Set(localNameNodes(contentTypes, 'Default').map(node => String(attrAny(node, ['Extension'])).toLowerCase()));
  if (new Set(overrides).size !== overrides.length) throw pptxValidationError('PPTX_CONTENT_TYPES_DUPLICATE', 'PPTX 包校验失败：[Content_Types].xml 存在重复 PartName。');
  const overrideSet = new Set(overrides);
  names.forEach(name => {
    if (name === '[Content_Types].xml') return;
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    if (!overrideSet.has('/' + name) && !defaults.has(extension)) {
      throw pptxValidationError('PPTX_CONTENT_TYPE_MISSING', `PPTX 包校验失败：${name} 没有对应的内容类型声明。`);
    }
  });
  for (const [name, xml] of xmlMap) {
    if (!name.endsWith('.rels')) continue;
    const relationships = localNameNodes(xml, 'Relationship');
    const relationshipIds = relationships.map(rel => attrAny(rel, ['Id']));
    if (relationshipIds.some(id => !id) || new Set(relationshipIds).size !== relationshipIds.length) {
      throw pptxValidationError('PPTX_RELATIONSHIP_ID', `PPTX 包校验失败：${name} 存在空白或重复关系 ID。`);
    }
    const sourcePath = relationshipSourcePath(name);
    if (sourcePath && !nameSet.has(sourcePath)) throw pptxValidationError('PPTX_RELATIONSHIP_SOURCE', `PPTX 包校验失败：${name} 对应的源部件 ${sourcePath} 不存在。`);
    for (const rel of relationships) {
      if (attrAny(rel, ['TargetMode']) === 'External') continue;
      const target = attrAny(rel, ['Target']);
      const resolved = target.startsWith('/') ? target.slice(1) : (name === '_rels/.rels' ? target.replace(/^\.\//, '') : resolveZipPath(name, target));
      if (target && !nameSet.has(resolved)) throw pptxValidationError('PPTX_RELATIONSHIP_TARGET', `PPTX 包校验失败：${name} 的关系 ${attrAny(rel, ['Id'])} 指向不存在的 ${resolved}。`);
    }
  }
  const presentation = xmlMap.get('ppt/presentation.xml');
  const ids = localNameNodes(firstLocalName(presentation, 'sldIdLst'), 'sldId');
  if (ids.length !== expectedSlides) throw pptxValidationError('PPTX_SLIDE_COUNT', `PPTX 包校验失败：预期 ${expectedSlides} 页，实际 ${ids.length} 页。`);
  const numericIds = ids.map(node => attrAny(node, ['id']));
  const relIds = ids.map(node => relAttr(node, 'id'));
  if (new Set(numericIds).size !== numericIds.length || new Set(relIds).size !== relIds.length) throw pptxValidationError('PPTX_SLIDE_ID', 'PPTX 包校验失败：幻灯片 ID 或关系 ID 重复。');
  const presentationRels = localNameNodes(xmlMap.get('ppt/_rels/presentation.xml.rels'), 'Relationship');
  const presentationRelMap = new Map(presentationRels.map(rel => [attrAny(rel, ['Id']), rel]));
  relIds.forEach(relId => {
    const rel = presentationRelMap.get(relId);
    if (!rel || !/\/slide$/.test(attrAny(rel, ['Type']))) throw pptxValidationError('PPTX_SLIDE_RELATIONSHIP', `PPTX 包校验失败：幻灯片关系 ${relId} 缺失或类型错误。`);
  });
  const slidePartNames = names.filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  if (slidePartNames.length !== expectedSlides) throw pptxValidationError('PPTX_SLIDE_PART_COUNT', `PPTX 包校验失败：预期 ${expectedSlides} 个幻灯片部件，实际 ${slidePartNames.length} 个。`);
  const order = { xfrm:0, prstGeom:1, custGeom:1, noFill:2, solidFill:2, gradFill:2, blipFill:2, pattFill:2, grpFill:2, ln:3, effectLst:4, effectDag:4, scene3d:5, sp3d:6, extLst:7 };
  for (const [name, xml] of xmlMap) {
    if (!/^ppt\/slides\/slide\d+\.xml$/i.test(name)) continue;
    const shapeIds = localNameNodes(xml, 'cNvPr').map(node => attrAny(node, ['id']));
    if (shapeIds.some(id => !id) || new Set(shapeIds).size !== shapeIds.length) throw pptxValidationError('PPTX_SHAPE_ID', `PPTX 包校验失败：${name} 存在空白或重复形状 ID。`);
    for (const spPr of localNameNodes(xml, 'spPr')) {
      const ranks = Array.from(spPr.children).map(node => order[node.localName]).filter(Number.isFinite);
      if (ranks.some((rank, index) => index && ranks[index - 1] > rank)) throw pptxValidationError('PPTX_OOXML_ORDER', `PPTX 包校验失败：${name} 存在不符合 OOXML 顺序的 spPr。`);
    }
  }
  return { bytes:bytes.length, entries:envelope.entries, slides:ids.length };
}
async function buildTranslatedPptxAttempt(doc, lang, results, profile) {
  const zip = await window.JSZip.loadAsync(doc.sourceBuffer);
  const presentationPath = 'ppt/presentation.xml';
  const presentationRelPath = 'ppt/_rels/presentation.xml.rels';
  const contentTypesPath = '[Content_Types].xml';
  const presentationXml = xmlFrom(await zip.file(presentationPath).async('text'));
  const presentationRelXml = xmlFrom(await zip.file(presentationRelPath).async('text'));
  const contentTypesXml = xmlFrom(await zip.file(contentTypesPath).async('text'));
  const relRoot = presentationRelXml.documentElement;
  const contentRoot = contentTypesXml.documentElement;
  const sldIdLst = firstLocalName(presentationXml, 'sldIdLst');
  const slideRels = localNameNodes(relRoot, 'Relationship').filter(rel => /\/slide$/.test(attrAny(rel, ['Type'])));
  const originalSlideIdEntries = Array.from(sldIdLst.children).filter(node => node.localName === 'sldId');
  const originalSlidePaths = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name));
  let nextSlideIndex = Math.max(...originalSlidePaths.map(path => Number(path.match(/slide(\d+)\.xml/i)[1])), 0);
  let nextRelId = nextNumericId(localNameNodes(relRoot, 'Relationship').map(rel => attrAny(rel, ['Id'])), 0);
  let nextSlideId = nextNumericId(originalSlideIdEntries.map(node => attrAny(node, ['id'])), 255);
  const slideMap = new Map(doc.slides.map(slide => [slide.slidePath, slide]));

  const newOrder = [];
  for (const originalEntry of originalSlideIdEntries) {
    const relId = relAttr(originalEntry, 'id');
    const rel = slideRels.find(item => attrAny(item, ['Id']) === relId);
    const slidePath = rel ? resolveZipPath(presentationRelPath, attrAny(rel, ['Target'])) : '';
    newOrder.push(originalEntry);
    const slideData = slideMap.get(slidePath);
    if (!slideData) continue;
    const newSlideIndex = ++nextSlideIndex;
    const newSlidePath = `ppt/slides/slide${newSlideIndex}.xml`;
    const newSlideRelPath = `ppt/slides/_rels/slide${newSlideIndex}.xml.rels`;
    const translatedXml = xmlFrom(await zip.file(slideData.slidePath).async('text'));
    localNameNodes(translatedXml, 'sp').forEach(sp => {
      const idNode = firstLocalName(sp, 'cNvPr');
      const shapeNodeId = attrAny(idNode, ['id']);
      if (!shapeNodeId) return;
      const key = `slide-${slideData.index}-shape-${shapeNodeId}`;
      const result = results.get(key);
      if (!result || result.error || !result.text) return;
      updateTranslatedShape(sp, result.text, translatedXml);
    });
    slideData.shapes.filter(item => item.kind === 'tableCell').forEach(item => {
      const result = results.get(item.id);
      if (!result || result.error || !result.text) return;
      const frame = localNameNodes(translatedXml, 'graphicFrame').find(node => attrAny(firstLocalName(node, 'cNvPr'), ['id']) === String(item.frameNodeId));
      const cell = frame ? localNameNodes(firstLocalName(frame, 'tbl'), 'tc')[item.cellIndex] : null;
      if (cell) updateTranslatedTextBody(firstLocalName(cell, 'txBody'), result.text, translatedXml);
    });
    const imageRegions = addImageTranslationOverlays(translatedXml, slideData, results);
    if (imageRegions) log('documentLog', `PPTX 第 ${slideData.index} 页：写入 ${imageRegions} 个图片译文区域。`);
    regenerateOfficeUniqueIds(translatedXml);
    zip.file(newSlidePath, new XMLSerializer().serializeToString(translatedXml));
    if (zip.file(slideData.relPath)) {
      const relXml = xmlFrom(await zip.file(slideData.relPath).async('text'));
      localNameNodes(relXml, 'Relationship').forEach(relNode => {
        const type = attrAny(relNode, ['Type']);
        if (/\/notesSlide$/.test(type)) relNode.parentNode.removeChild(relNode);
      });
      for (const diagram of (slideData.diagrams || [])) {
        const originalPart = diagram.diagramPath;
        const baseName = originalPart.split('/').pop().replace(/\.xml$/i, '');
        const newPart = `ppt/diagrams/${baseName}_translated_${newSlideIndex}.xml`;
        const diagramXml = xmlFrom(await zip.file(originalPart).async('text'));
        const textNodes = localNameNodes(diagramXml, 't');
        diagram.items.forEach(item => {
          const result = results.get(item.id);
          if (result && !result.error && result.text && textNodes[item.nodeIndex]) setTextNodeContent(textNodes[item.nodeIndex], result.text);
        });
        zip.file(newPart, new XMLSerializer().serializeToString(diagramXml));
        const originalPartRel = originalPart.replace('ppt/diagrams/', 'ppt/diagrams/_rels/') + '.rels';
        const newPartRel = newPart.replace('ppt/diagrams/', 'ppt/diagrams/_rels/') + '.rels';
        if (zip.file(originalPartRel)) zip.file(newPartRel, await zip.file(originalPartRel).async('text'));
        const slideRel = localNameNodes(relXml, 'Relationship').find(node => attrAny(node, ['Id']) === diagram.relId);
        if (slideRel) slideRel.setAttribute('Target', `../diagrams/${newPart.split('/').pop()}`);
        const originalOverride = localNameNodes(contentTypesXml, 'Override').find(node => attrAny(node, ['PartName']) === '/' + originalPart);
        if (originalOverride) {
          const override = contentTypesXml.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
          override.setAttribute('PartName', '/' + newPart);
          override.setAttribute('ContentType', attrAny(originalOverride, ['ContentType']));
          contentRoot.appendChild(override);
        }
      }
      zip.file(newSlideRelPath, new XMLSerializer().serializeToString(relXml));
    }
    const override = contentTypesXml.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
    override.setAttribute('PartName', '/' + newSlidePath);
    override.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
    contentRoot.appendChild(override);

    const relationship = presentationRelXml.createElementNS('http://schemas.openxmlformats.org/package/2006/relationships', 'Relationship');
    const newRelId = `rId${nextRelId++}`;
    relationship.setAttribute('Id', newRelId);
    relationship.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide');
    relationship.setAttribute('Target', `slides/slide${newSlideIndex}.xml`);
    relRoot.appendChild(relationship);

    const newSldId = presentationXml.createElementNS('http://schemas.openxmlformats.org/presentationml/2006/main', 'p:sldId');
    newSldId.setAttribute('id', String(nextSlideId++));
    newSldId.setAttributeNS(REL_NS, 'r:id', newRelId);
    newOrder.push(newSldId);
  }
  if (newOrder.length !== originalSlideIdEntries.length * 2) {
    throw new Error(`PPT 译文页插入失败：预期 ${originalSlideIdEntries.length * 2} 页，实际写入 ${newOrder.length} 页。`);
  }

  Array.from(sldIdLst.children).forEach(child => sldIdLst.removeChild(child));
  newOrder.forEach(node => sldIdLst.appendChild(node));
  zip.file(presentationPath, new XMLSerializer().serializeToString(presentationXml));
  zip.file(presentationRelPath, new XMLSerializer().serializeToString(presentationRelXml));
  zip.file(contentTypesPath, new XMLSerializer().serializeToString(contentTypesXml));
  const bytes = await zip.generateAsync({
    type:'uint8array',
    mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    compression:profile.compression,
    compressionOptions:{ level:6 },
  });
  await validateGeneratedPptxBlob(bytes, originalSlideIdEntries.length * 2);
  const blob = new Blob([bytes], { type:'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  return blob;
}
async function buildTranslatedPptx(doc, lang, results) {
  const profiles = pptxGenerationProfiles();
  let lastError = null;
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    try {
      const blob = await buildTranslatedPptxAttempt(doc, lang, results, profile);
      rememberPptxAttempt(profile, null);
      if (index) log('documentLog', `PPTX 自动修复成功：改用 ${profile.compression} 策略重新生成并通过全部校验。`);
      return blob;
    } catch (error) {
      lastError = error;
      rememberPptxAttempt(profile, error);
      if (index === profiles.length - 1 || !canRetryPptxGeneration(error)) throw error;
      log('documentLog', `PPTX 生成校验失败（${error.code || 'UNKNOWN'}），将从未修改的原始文件重新生成，并切换为 ${profiles[index + 1].compression} 策略。`);
    }
  }
  throw lastError;
}
function renderDocumentResult(result) {
  $('documentTableWrap').classList.remove('hidden');
  $('documentEmpty').classList.add('hidden');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td data-label="文件">${escapeHtml(result.name)}</td><td data-label="语言">${escapeHtml(result.lang)}</td><td data-label="类型">${escapeHtml(result.kind)}</td><td data-label="状态"><span class="status ${result.status === 'ok' ? 'ok' : 'fail'}">${result.status === 'ok' ? '成功' : '失败'}</span></td><td data-label="说明">${escapeHtml(result.message || '')}</td><td data-label="下载">${result.blob ? '<a class="download-link secondary" href="#">下载</a>' : '-'}</td>`;
  $('documentResultBody').appendChild(tr);
  if (result.blob) {
    tr.querySelector('a').addEventListener('click', event => {
      event.preventDefault();
      downloadBlob(result.blob, result.downloadName, { expectedSlides:result.expectedSlides });
    });
    state.documentDownloads.push({ blob: result.blob, downloadName: result.downloadName, expectedSlides:result.expectedSlides || 0 });
    $('zipDocumentBtn').classList.remove('hidden');
  }
}
function updateDocumentInfo() {
  renderFileChips('documentFileInfo', state.documentFiles, '尚未上传文档。', `已载入 ${state.documentFiles.length} 个文档：`);
  stat();
}
function loadDocumentFiles(files) {
  state.documentFiles = Array.from(files || []).filter(file => /\.(pdf|pptx)$/i.test(file.name)).map(file => ({ name:file.name, file }));
  updateDocumentInfo();
}
async function runDocumentTranslate() {
  if (!state.documentFiles.length) { showToast('请先上传 PDF 或 PPTX 文件。'); flashElement($('documentDrop')); return; }
  const langs = selectedLangs();
  if (!langs.length) { showToast('请至少选择一个目标语言。'); focusSharedRules(); return; }
  if (!$('apiKey').value.trim() && !(state.translationMemory.size && $('translationMemoryMode').value === 'direct')) {
    showToast('请先填写 API Key，或上传标准翻译库并选择命中后直接使用。', 'error');
    return;
  }
  const hasPptx = state.documentFiles.some(item => /\.pptx$/i.test(item.name));
  if (hasPptx && $('docTranslateImages')?.checked && !modelSupportsVision()) {
    showToast('已启用 PPT 图片文字翻译，请选择带“多模态”标识的模型，或把模型能力手动设为“多模态”。', 'error');
    return;
  }
  if (!$('docOutputMarkdown').checked && !$('docOutputDocx').checked && !$('docOutputHtml').checked && !state.documentFiles.some(item => /\.pptx$/i.test(item.name))) {
    showToast('PDF 至少需要勾选一种输出格式。');
    return;
  }
  state.cancel = false;
  state.running = true;
  state.documentDownloads = [];
  await closePptxOcrWorker();
  state.visionImageCache = new Map();
  state.pptxOcrCache = new Map();
  state.imageTransportBlocked = false;
  state.upstreamCooldownUntil = 0;
  $('zipDocumentBtn').classList.add('hidden');
  $('runDocumentBtn').disabled = true;
  $('cancelDocumentBtn').disabled = false;
  $('documentResultBody').innerHTML = '';
  $('documentTableWrap').classList.add('hidden');
  $('documentEmpty').classList.remove('hidden');
  state.translationMemoryStats.hits = 0;
  state.translationMemoryStats.missesByLang = {};
  setLog('documentLog', '开始文档翻译...');
  const sharedRules = getSharedRules();
  const meta = {
    sourceLang: $('docSourceLang').value,
    workflowMode: $('docWorkflowMode').value,
    concurrency: Number($('docConcurrency').value),
    retries: Number($('docRetries').value),
    translationMemoryMode: $('translationMemoryMode').value,
    protectedTerms: sharedRules.protectedTerms,
    customRules: sharedRules.customRules,
    outputs: { markdown: $('docOutputMarkdown').checked, docx: $('docOutputDocx').checked, html: $('docOutputHtml').checked },
    translateImages: !!$('docTranslateImages')?.checked,
  };
  const parsedDocuments = [];
  let total = 0;
  for (const item of state.documentFiles) {
    const doc = /\.pdf$/i.test(item.name) ? await extractPdfDocument(item.file, meta.sourceLang, { captureImage: meta.outputs.html }) : await extractPptxDocument(item.file);
    parsedDocuments.push({ item, doc });
    total += collectDocumentTasks(doc).length * langs.length;
  }
  const counter = { done:0, total };
  updateProgress(0, total);
  for (const { item, doc } of parsedDocuments) {
    if (state.cancel) break;
    for (const lang of langs) {
      if (state.cancel) break;
      state.progressNote = `${item.name} → ${lang}`;
      const pendingRow = addPendingRow('documentResultBody', 'documentTableWrap', 'documentEmpty',
        `<td data-label="文件">${escapeHtml(item.name)}</td><td data-label="语言">${escapeHtml(lang)}</td><td data-label="类型">-</td><td data-label="状态"><span class="status pending">进行中</span></td><td data-label="说明">正在翻译…</td><td data-label="下载">-</td>`);
      try {
        log('documentLog', `翻译 ${item.name} -> ${lang}`);
        const results = await translateDocumentToLanguage(doc, lang, meta, counter);
        if (doc.type === 'pdf') {
          if (meta.outputs.markdown) {
            const md = buildPdfMarkdown(doc, lang, results);
            renderDocumentResult({ name:item.name, lang, kind:'Markdown', status:'ok', message:`${doc.pages.length} 页双语 Markdown`, blob:new Blob([md], { type:'text/markdown;charset=utf-8' }), downloadName:`${fileStem(item.name)}_${lang}.md` });
          }
          if (meta.outputs.docx) {
            const blob = await buildPdfDocx(doc, lang, results);
            renderDocumentResult({ name:item.name, lang, kind:'DOCX', status:'ok', message:`${doc.pages.length} 页双语 DOCX`, blob, downloadName:`${fileStem(item.name)}_${lang}.docx` });
          }
          if (meta.outputs.html) {
            const html = buildPdfComparisonHtml(doc, lang, results);
            renderDocumentResult({ name:item.name, lang, kind:'图文对照 HTML', status:'ok', message:`${doc.pages.length} 页原文截图 + 译文对照`, blob:new Blob([html], { type:'text/html;charset=utf-8' }), downloadName:`${fileStem(item.name)}_${lang}_compare.html` });
          }
        } else {
          const coverage = validatePptxResultCoverage(doc, results, meta.translateImages);
          const blob = await buildTranslatedPptx(doc, lang, results);
          renderDocumentResult({ name:item.name, lang, kind:'PPTX 翻译版', status:'ok', message:`通过完整性、CRC 与包结构校验：${coverage.expected} 个对象；原稿 ${doc.slides.length} 页，输出 ${doc.slides.length * 2} 页。Chrome/Edge 下载后会自动重读并校验落盘文件。`, blob, downloadName:`${fileStem(item.name)}_${lang}_translated.pptx`, expectedSlides:doc.slides.length * 2 });
        }
      } catch (error) {
        state.errors++;
        stat();
        renderDocumentResult({ name:item.name, lang, kind:doc.type === 'pdf' ? '文档' : 'PPTX 审校版', status:'fail', message:error.message || String(error), blob:null, downloadName:'' });
        log('documentLog', `失败：${item.name} -> ${lang}；${error.message || error}`);
      } finally {
        pendingRow.remove();
      }
    }
  }
  state.progressNote = '';
  await closePptxOcrWorker();
  state.running = false;
  $('runDocumentBtn').disabled = false;
  $('cancelDocumentBtn').disabled = true;
  const misses = Object.entries(state.translationMemoryStats.missesByLang).map(([lang, count]) => `${lang} ${count}`).join('；') || '无';
  log('documentLog', (state.cancel ? '已停止。' : '文档翻译结束。') + ` 标准库累计命中 ${state.translationMemoryStats.hits || 0}；未命中语言：${misses}。`);
}
function setupDrop(id, callback, inputId) {
  const dz = $(id);
  ['dragenter','dragover'].forEach(type => dz.addEventListener(type, event => { event.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(type => dz.addEventListener(type, event => { event.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', event => callback(event.dataTransfer.files));
  if (inputId) {
    dz.addEventListener('click', () => $(inputId).click());
    dz.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $(inputId).click(); }
    });
  }
}
function init() {
  tabs();
  loadOpsLogs();
  loadSettings();
  renderProviderPresets();
  renderModels();
  renderLanguages();
  updateTranslationMemoryInfo();
  updateTranslateInfo();
  updateDocumentInfo();
  stat();
  $('modelFilter').addEventListener('input', renderModels);
  $('refreshModelsBtn').addEventListener('click', refreshModels);
  $('testBtn').addEventListener('click', testConnection);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('forgetSettingsBtn').addEventListener('click', forgetSettings);
  $('exportOpsLogBtn').addEventListener('click', exportOpsLogs);
  $('clearOpsLogBtn').addEventListener('click', clearOpsLogs);
  $('selectAllLangBtn').addEventListener('click', () => { document.querySelectorAll('.langCheck').forEach(item => { item.checked = true; }); updateLangSummaries(); });
  $('clearLangBtn').addEventListener('click', () => { document.querySelectorAll('.langCheck').forEach(item => { item.checked = false; }); updateLangSummaries(); });
  $('selectEuroBtn').addEventListener('click', () => selectLangs(['German','Spanish','French','Italian','Dutch','Polish','Portuguese','Danish','Swedish']));
  $('addLangBtn').addEventListener('click', () => {
    const value = $('customLang').value.trim();
    if (!value || DEFAULT_LANGS.some(lang => lang.toLowerCase() === value.toLowerCase())) return;
    DEFAULT_LANGS.push(value);
    $('customLang').value = '';
    renderLanguages();
    selectLangs(Array.from(new Set([...selectedLangs(), value])));
  });
  $('translateFiles').addEventListener('change', event => loadTranslateFiles(event.target.files));
  $('clearTranslateBtn').addEventListener('click', () => {
    state.translateFiles = [];
    updateTranslateInfo();
    $('translateResultBody').innerHTML = '';
    $('translateTableWrap').classList.add('hidden');
    $('translateEmpty').classList.remove('hidden');
  });
  $('runTranslateBtn').addEventListener('click', runTranslate);
  $('cancelTranslateBtn').addEventListener('click', () => { state.cancel = true; log('translateLog', '收到停止指令；正在等待当前请求结束。'); });
  $('documentFiles').addEventListener('change', event => loadDocumentFiles(event.target.files));
  $('clearDocumentBtn').addEventListener('click', () => { state.documentFiles = []; updateDocumentInfo(); $('documentResultBody').innerHTML = ''; $('documentTableWrap').classList.add('hidden'); $('documentEmpty').classList.remove('hidden'); });
  $('translationMemoryFiles').addEventListener('change', event => loadTranslationMemoryFiles(event.target.files));
  $('clearTranslationMemoryBtn').addEventListener('click', () => { state.translationMemory = new Map(); state.translationMemoryStats = {entries:0,files:0,rows:0,duplicates:0,hits:0,missesByLang:{}}; updateTranslationMemoryInfo(); logShared('已清空标准翻译库。'); });
  $('termsCsvFile').addEventListener('change', event => loadTermsCsvFile(event.target.files[0]));
  $('clearRulesBtn').addEventListener('click', () => { $('protectedTerms').value = ''; $('customRules').value = ''; $('termsCsvFile').value = ''; $('termsCsvInfo').textContent = '可选上传术语 CSV：优先读取 term/protected_term/术语/词条列；未找到时读取第一列非空值并追加到受保护术语。'; });
  $('runDocumentBtn').addEventListener('click', runDocumentTranslate);
  $('cancelDocumentBtn').addEventListener('click', () => { state.cancel = true; log('documentLog', '收到停止指令；正在等待当前请求结束。'); });
  window.addEventListener('pagehide', releaseDownloadObjectUrls);
  setupDrop('translateDrop', files => loadTranslateFiles(files), 'translateFiles');
  setupDrop('documentDrop', files => loadDocumentFiles(files), 'documentFiles');
  $('toggleKeyBtn').addEventListener('click', () => {
    const input = $('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('apiKey').addEventListener('input', () => updateModelStatus($('apiKey').value.trim() ? 'untested' : 'unset'));
  updateModelStatus($('apiKey').value.trim() ? 'untested' : 'unset');
  $('languageBox').addEventListener('change', updateLangSummaries);
  updateLangSummaries();
  ['translateLangSummary', 'documentLangSummary'].forEach(id => $(id).addEventListener('click', focusSharedRules));
  $('zipTranslateBtn').addEventListener('click', () => downloadResultsZip(state.translateResults.filter(item => item.blob), 'csv_translations.zip', $('zipTranslateBtn')));
  $('zipDocumentBtn').addEventListener('click', () => downloadResultsZip(state.documentDownloads, 'document_translations.zip', $('zipDocumentBtn')));
  $('translateFileInfo').addEventListener('click', async event => {
    const index = event.target && event.target.dataset ? event.target.dataset.remove : undefined;
    if (index === undefined) return;
    state.translateFiles.splice(Number(index), 1);
    updateTranslateInfo();
    if (state.translateFiles[0]) {
      try {
        const {text} = await readFileText(state.translateFiles[0].file);
        fillColumnSelects(parseCSV(text)[0] || []);
      } catch (_) {}
    }
  });
  $('documentFileInfo').addEventListener('click', event => {
    const index = event.target && event.target.dataset ? event.target.dataset.remove : undefined;
    if (index === undefined) return;
    state.documentFiles.splice(Number(index), 1);
    updateDocumentInfo();
  });
  window.addEventListener('beforeunload', event => {
    if (!state.running) return;
    event.preventDefault();
    event.returnValue = '';
  });
  increasePv().then(() => {
    stat();
    log('modelLog', `页面访问记录：PV=${state.pv}`);
  });
}
init();
})();
