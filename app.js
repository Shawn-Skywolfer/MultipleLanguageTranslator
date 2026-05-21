(function () {
'use strict';

const DEFAULT_MODELS = ['gpt-5.4','gpt-4o-mini','gpt-4o','gpt-4.1-mini','claude-3-5-sonnet-latest','claude-sonnet-4-5','gemini-2.5-flash','gemini-2.5-pro','deepseek-chat','deepseek-reasoner','qwen-plus','qwen-max'];
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
};

if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
}

function log(id, msg) {
  const el = $(id);
  if (!el) return;
  const t = new Date().toLocaleTimeString();
  el.textContent += `\n[${t}] ${msg}`;
  el.scrollTop = el.scrollHeight;
}
function setLog(id, msg) {
  const el = $(id);
  if (el) el.textContent = msg;
}
function logShared(msg) {
  ['translateLog', 'documentLog'].forEach(id => { if ($(id)) log(id, msg); });
}
function stat() {
  $('statFiles').textContent = state.documentFiles.length + state.translateFiles.length;
  $('statDone').textContent = state.done;
  $('statErrors').textContent = state.errors;
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
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  a.remove();
}
function tabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.section').forEach(item => item.classList.remove('active'));
    btn.classList.add('active');
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
    throw new Error(`无法访问站内接口 ${url}。如果你当前是直接打开 HTML 文件，或使用了不支持 Serverless Functions 的静态服务器，就会出现这个问题。请部署到 Vercel，或使用 \`vercel dev\` 本地运行。原始错误：${error.message || error}`);
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
    throw new Error(`HTTP ${res.status}: ${raw.slice(0, 1000)}`);
  }
  throw new Error('接口参数兼容重试次数已用完。');
}
function stripOutputObject(text) {
  const raw = String(text ?? '').trim();
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
    row.innerHTML = `<span>${escapeHtml(model)}</span><button class="ghost" type="button">使用</button>`;
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
    ['providerName','baseUrl','modelId','temperature','maxTokens','apiKey'].forEach(key => {
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
  } catch (error) {
    log('modelLog', '连通测试失败：' + (error.message || error));
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
}
function selectedLangs() {
  return Array.from(document.querySelectorAll('.langCheck:checked')).map(el => el.value);
}
function selectLangs(list) {
  document.querySelectorAll('.langCheck').forEach(el => { el.checked = list.includes(el.value); });
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
  $('translateFileInfo').textContent = state.translateFiles.length
    ? `已载入 ${state.translateFiles.length} 个 CSV：` + state.translateFiles.map(item => item.name).join('；')
    : '尚未上传 CSV。';
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
  $('translateProgressText').textContent = `进度：${done}/${total} (${pct}%)`;
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
async function withRetry(fn, retries) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (error) {
      last = error;
      if (i < retries) await sleep(800 * (i + 1));
    }
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
  return {name:item.name, blob, downloadName:fileStem(item.name) + '_clean.csv', tasks:tasks.length, errors:results.filter(x => x.error).length, warnings:results.filter(x => x.warning).length, tmHits};
}
function renderTranslateResult(result, status, message) {
  $('translateTableWrap').classList.remove('hidden');
  $('translateEmpty').classList.add('hidden');
  const tr = document.createElement('tr');
  const dl = result.blob ? '<a class="download-link secondary" href="#">下载</a>' : '-';
  tr.innerHTML = `<td>${escapeHtml(result.name)}</td><td><span class="status ${status === 'ok' ? 'ok' : 'fail'}">${status === 'ok' ? '成功' : '失败'}</span></td><td>${result.tasks || 0}</td><td>${escapeHtml(message || (`错误 ${result.errors || 0} 个；警告 ${result.warnings || 0} 个；输出：${result.downloadName || ''}`))}</td><td>${dl}</td>`;
  $('translateResultBody').appendChild(tr);
  if (result.blob) {
    tr.querySelector('a').addEventListener('click', event => {
      event.preventDefault();
      downloadBlob(result.blob, result.downloadName);
    });
  }
}
async function runTranslate() {
  if (!state.translateFiles.length) { alert('请先上传 CSV 文件。'); return; }
  const langs = selectedLangs();
  if (!langs.length) { alert('请至少选择一个目标语言。'); return; }
  if (!$('apiKey').value.trim() && !(state.translationMemory.size && $('translationMemoryMode').value === 'direct')) {
    alert('请先填写 API Key，或上传标准翻译库并选择命中后直接使用。');
    return;
  }
  state.cancel = false;
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
    }
  }
  $('runTranslateBtn').disabled = false;
  $('cancelTranslateBtn').disabled = true;
  const misses = Object.entries(state.translationMemoryStats.missesByLang).map(([lang, count]) => `${lang} ${count}`).join('；') || '无';
  log('translateLog', (state.cancel ? '已停止。' : '批量翻译结束。') + ` 标准库累计命中 ${state.translationMemoryStats.hits || 0}；未命中语言：${misses}。`);
}
function updateProgress(done, total) {
  const pct = total ? Math.round(done / total * 100) : 0;
  $('documentBar').style.width = pct + '%';
  $('documentProgressText').textContent = `进度：${done}/${total} (${pct}%)`;
}
function isLikelyText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/^[\d\W_]+$/.test(normalized)) return false;
  return normalized.length >= 2;
}
function groupPdfTextItems(items) {
  const normalized = (items || []).map(item => ({
    text: String(item.str || '').replace(/\s+/g, ' ').trim(),
    x: item.transform?.[4] || 0,
    y: item.transform?.[5] || 0,
    h: Math.abs(item.height || item.transform?.[0] || 10),
  })).filter(item => item.text);
  normalized.sort((a, b) => Math.abs(a.y - b.y) < 3 ? a.x - b.x : b.y - a.y);
  const lines = [];
  for (const token of normalized) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - token.y) > Math.max(4, token.h * 0.6)) {
      lines.push({ y: token.y, height: token.h, parts:[token.text] });
    } else {
      last.parts.push(token.text);
      last.height = Math.max(last.height, token.h);
    }
  }
  const blocks = [];
  let current = null;
  lines.forEach(line => {
    const text = line.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return;
    if (!current || Math.abs(current.prevY - line.y) > Math.max(14, line.height * 1.8)) {
      current = { texts:[text], prevY: line.y };
      blocks.push(current);
    } else {
      current.texts.push(text);
      current.prevY = line.y;
    }
  });
  return blocks.map((block, index) => ({ id:`text-${index + 1}`, text:block.texts.join('\n').trim() })).filter(block => isLikelyText(block.text));
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
async function extractPdfDocument(file, sourceLang) {
  log('documentLog', `开始解析 PDF：${file.name}`);
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    let blocks = groupPdfTextItems(textContent.items || []);
    let extraction = 'text';
    if (!blocks.length || blocks.map(item => item.text).join(' ').length < 24) {
      extraction = 'ocr';
      log('documentLog', `第 ${i} 页文本不足，开始 OCR...`);
      const canvas = await renderPdfPageToCanvas(page, 2);
      const result = await window.Tesseract.recognize(canvas, getOcrLanguage(sourceLang), {
        logger: msg => {
          if (msg.status === 'recognizing text' && typeof msg.progress === 'number') {
            $('documentProgressText').textContent = `OCR 第 ${i} 页：${Math.round(msg.progress * 100)}%`;
          }
        },
      });
      blocks = splitOcrText(result.data.text).map((text, index) => ({ id:`ocr-${index + 1}`, text }));
    }
    pages.push({ pageNo:i, extraction, blocks });
  }
  log('documentLog', `PDF 解析完成：${file.name}，共 ${pages.length} 页。`);
  return { type:'pdf', name:file.name, pages };
}
function xmlFrom(text) {
  return new DOMParser().parseFromString(text, 'application/xml');
}
function localNameNodes(root, name) {
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
        shapeNodeId,
        text,
        x: emuToInch(attrAny(off, ['x'])),
        y: emuToInch(attrAny(off, ['y'])),
        w: Math.max(0.8, emuToInch(attrAny(ext, ['cx']))),
        h: Math.max(0.35, emuToInch(attrAny(ext, ['cy']))),
        fontSize,
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
      images.push({
        data,
        x: emuToInch(attrAny(off, ['x'])),
        y: emuToInch(attrAny(off, ['y'])),
        w: Math.max(0.5, emuToInch(attrAny(ext, ['cx']))),
        h: Math.max(0.5, emuToInch(attrAny(ext, ['cy']))),
      });
    }
    slides.push({ index:slideIndex, slidePath, relPath, shapes, images, background });
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
  doc.slides.forEach(slide => slide.shapes.forEach(shape => tasks.push({ id:shape.id, source:shape.text })));
  return tasks;
}
async function translateDocumentToLanguage(doc, targetLang, meta, counter) {
  const tasks = collectDocumentTasks(doc);
  const results = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length && !state.cancel) {
      const task = tasks[cursor++];
      try {
        const standard = lookupTranslationMemory(task.source, targetLang);
        let translated = '';
        if (standard && meta.translationMemoryMode === 'direct') {
          translated = standard.text;
          state.translationMemoryStats.hits++;
        } else {
          if (!standard) state.translationMemoryStats.missesByLang[targetLang] = (state.translationMemoryStats.missesByLang[targetLang] || 0) + 1;
          translated = await withRetry(() => workflowTranslate(task.source, meta.sourceLang, targetLang, '', {
            protectedTerms: meta.protectedTerms,
            customRules: meta.customRules,
            standardTranslation: standard && meta.translationMemoryMode === 'review' ? standard.text : ''
          }, meta.workflowMode, 'documentLog'), meta.retries);
        }
        const missing = validateProtectedTerms(task.source, translated, meta.protectedTerms);
        results.set(task.id, { text: translated, warning: missing.length ? '受保护术语缺失：' + missing.join(' / ') : '', error:'' });
      } catch (error) {
        results.set(task.id, { text:'', warning:'', error:error.message || String(error) });
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
  await Promise.all(Array.from({length: meta.concurrency}, () => worker()));
  return results;
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
function splitTextByWeights(text, weights) {
  if (!weights.length) return [];
  const normalizedWeights = weights.map(weight => Math.max(Number(weight) || 0, 0));
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0) || weights.length;
  const source = String(text || '');
  const parts = [];
  let cursor = 0;
  let cumulativeWeight = 0;
  normalizedWeights.forEach((weight, index) => {
    cumulativeWeight += weight || (totalWeight / weights.length);
    const nextCursor = index === normalizedWeights.length - 1
      ? source.length
      : Math.max(cursor, Math.min(source.length, Math.round(source.length * cumulativeWeight / totalWeight)));
    parts.push(source.slice(cursor, nextCursor));
    cursor = nextCursor;
  });
  return parts;
}
function setTextNodeContent(textNode, value) {
  const content = String(value || '');
  textNode.textContent = content;
  if (/^\s|\s$/.test(content) || /\s{2,}/.test(content)) textNode.setAttribute('xml:space', 'preserve');
  else textNode.removeAttribute('xml:space');
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
  const parts = splitTextByWeights(text, textNodes.map(node => (node.textContent || '').length || 1));
  textNodes.forEach((node, index) => setTextNodeContent(node, parts[index] || ''));
}
function updateTranslatedShape(sp, translatedText, xmlDoc) {
  const txBody = firstLocalName(sp, 'txBody');
  if (!txBody) return;
  const bodyPr = firstLocalName(txBody, 'bodyPr');
  if (bodyPr) bodyPr.setAttribute('wrap', 'square');
  const paragraphs = Array.from(txBody.children).filter(child => child.localName === 'p');
  let paragraph = paragraphs[0];
  if (!paragraph) {
    paragraph = xmlDoc.createElementNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'a:p');
    txBody.appendChild(paragraph);
  }
  const targetParagraphs = paragraphs.length ? paragraphs : [paragraph];
  const normalizedText = String(translatedText || '').replace(/\s*\n+\s*/g, ' ').trim();
  const paragraphParts = splitTextByWeights(normalizedText, targetParagraphs.map(item => {
    const textNodes = localNameNodes(item, 't');
    return textNodes.reduce((sum, node) => sum + ((node.textContent || '').length || 0), 0) || 1;
  }));
  targetParagraphs.forEach((item, index) => replaceParagraphTextPreservingRuns(item, paragraphParts[index] || '', xmlDoc));

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
  spPr.appendChild(fill);
}
async function buildTranslatedPptx(doc, lang, results) {
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
    zip.file(newSlidePath, new XMLSerializer().serializeToString(translatedXml));
    if (zip.file(slideData.relPath)) {
      const relXml = xmlFrom(await zip.file(slideData.relPath).async('text'));
      localNameNodes(relXml, 'Relationship').forEach(relNode => {
        const type = attrAny(relNode, ['Type']);
        if (/\/notesSlide$/.test(type)) relNode.parentNode.removeChild(relNode);
      });
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
  return await zip.generateAsync({ type:'blob' });
}
function renderDocumentResult(result) {
  $('documentTableWrap').classList.remove('hidden');
  $('documentEmpty').classList.add('hidden');
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${escapeHtml(result.name)}</td><td>${escapeHtml(result.lang)}</td><td>${escapeHtml(result.kind)}</td><td><span class="status ${result.status === 'ok' ? 'ok' : 'fail'}">${result.status === 'ok' ? '成功' : '失败'}</span></td><td>${escapeHtml(result.message || '')}</td><td>${result.blob ? '<a class="download-link secondary" href="#">下载</a>' : '-'}</td>`;
  $('documentResultBody').appendChild(tr);
  if (result.blob) {
    tr.querySelector('a').addEventListener('click', event => {
      event.preventDefault();
      downloadBlob(result.blob, result.downloadName);
    });
  }
}
function updateDocumentInfo() {
  $('documentFileInfo').textContent = state.documentFiles.length ? `已载入 ${state.documentFiles.length} 个文档：` + state.documentFiles.map(item => item.name).join('；') : '尚未上传文档。';
  stat();
}
function loadDocumentFiles(files) {
  state.documentFiles = Array.from(files || []).filter(file => /\.(pdf|pptx)$/i.test(file.name)).map(file => ({ name:file.name, file }));
  updateDocumentInfo();
}
async function runDocumentTranslate() {
  if (!state.documentFiles.length) { alert('请先上传 PDF 或 PPTX 文件。'); return; }
  const langs = selectedLangs();
  if (!langs.length) { alert('请至少选择一个目标语言。'); return; }
  if (!$('apiKey').value.trim() && !(state.translationMemory.size && $('translationMemoryMode').value === 'direct')) {
    alert('请先填写 API Key，或上传标准翻译库并选择命中后直接使用。');
    return;
  }
  if (!$('docOutputMarkdown').checked && !$('docOutputDocx').checked && !state.documentFiles.some(item => /\.pptx$/i.test(item.name))) {
    alert('PDF 至少需要勾选一种输出格式。');
    return;
  }
  state.cancel = false;
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
    outputs: { markdown: $('docOutputMarkdown').checked, docx: $('docOutputDocx').checked },
  };
  const parsedDocuments = [];
  let total = 0;
  for (const item of state.documentFiles) {
    const doc = /\.pdf$/i.test(item.name) ? await extractPdfDocument(item.file, meta.sourceLang) : await extractPptxDocument(item.file);
    parsedDocuments.push({ item, doc });
    total += collectDocumentTasks(doc).length * langs.length;
  }
  const counter = { done:0, total };
  updateProgress(0, total);
  for (const { item, doc } of parsedDocuments) {
    if (state.cancel) break;
    for (const lang of langs) {
      if (state.cancel) break;
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
        } else {
          const blob = await buildTranslatedPptx(doc, lang, results);
          renderDocumentResult({ name:item.name, lang, kind:'PPTX 翻译版', status:'ok', message:`原稿 ${doc.slides.length} 页，输出共 ${doc.slides.length * 2} 页；每页后新增对应译文页`, blob, downloadName:`${fileStem(item.name)}_${lang}_translated.pptx` });
        }
      } catch (error) {
        state.errors++;
        stat();
        renderDocumentResult({ name:item.name, lang, kind:doc.type === 'pdf' ? '文档' : 'PPTX 审校版', status:'fail', message:error.message || String(error), blob:null, downloadName:'' });
        log('documentLog', `失败：${item.name} -> ${lang}；${error.message || error}`);
      }
    }
  }
  $('runDocumentBtn').disabled = false;
  $('cancelDocumentBtn').disabled = true;
  const misses = Object.entries(state.translationMemoryStats.missesByLang).map(([lang, count]) => `${lang} ${count}`).join('；') || '无';
  log('documentLog', (state.cancel ? '已停止。' : '文档翻译结束。') + ` 标准库累计命中 ${state.translationMemoryStats.hits || 0}；未命中语言：${misses}。`);
}
function setupDrop(id, callback) {
  const dz = $(id);
  ['dragenter','dragover'].forEach(type => dz.addEventListener(type, event => { event.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave','drop'].forEach(type => dz.addEventListener(type, event => { event.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', event => callback(event.dataTransfer.files));
}
function init() {
  tabs();
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
  $('selectAllLangBtn').addEventListener('click', () => document.querySelectorAll('.langCheck').forEach(item => { item.checked = true; }));
  $('clearLangBtn').addEventListener('click', () => document.querySelectorAll('.langCheck').forEach(item => { item.checked = false; }));
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
  setupDrop('translateDrop', files => loadTranslateFiles(files));
  setupDrop('documentDrop', files => loadDocumentFiles(files));
}
init();
})();
