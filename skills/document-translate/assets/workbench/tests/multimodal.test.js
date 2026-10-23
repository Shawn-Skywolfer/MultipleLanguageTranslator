'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const src = fs.readFileSync('app.js', 'utf8');
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `cannot slice ${startMarker} .. ${endMarker}`);
  return src.slice(start, end);
}
const constantsStart = src.indexOf('const MULTIMODAL_MODEL_PATTERNS');
const constantsEnd = src.indexOf('\nconst PROVIDER_PRESETS', constantsStart);
const code = [
  src.slice(constantsStart, constantsEnd),
  slice('\nfunction isLikelyMultimodalModel', '\nfunction modelSupportsVision'),
  slice('\nfunction parseRetryAfterMs', '\nasync function proxyPost'),
  slice('\nfunction parseJsonResponse', '\nasync function translatePptxImageTask'),
].join('\n');
const context = { console, JSON, Math, Number, String, Array, Object };
vm.createContext(context);
vm.runInContext(code, context);

assert.equal(context.isLikelyMultimodalModel('gpt-4o'), true);
assert.equal(context.isLikelyMultimodalModel('gemini-2.5-pro'), true);
assert.equal(context.isLikelyMultimodalModel('qwen2.5-vl-72b'), true);
assert.equal(context.isLikelyMultimodalModel('deepseek-chat'), false);

const payload = context.parseJsonResponse('```json\n{"regions":[{"translation":"Hello","bbox":{"x":0.1,"y":0.2,"w":0.3,"h":0.4}}]}\n```');
const regions = context.normalizeImageRegions(payload);
assert.equal(regions.length, 1);
assert.equal(regions[0].text, 'Hello');
assert.equal(JSON.stringify(regions[0].bbox), JSON.stringify({ x:0.1, y:0.2, w:0.3, h:0.4 }));

const hisHtml = '<!doctype html><title>HIS Proxy Notification</title><meta name="keywords" content="SWG,Proxy,NetentSec">';
const proxyError = context.buildUpstreamError({ status:403, headers:{ get:() => '' } }, hisHtml);
assert.equal(proxyError.code, 'CORPORATE_PROXY_BLOCK');
assert.equal(proxyError.retryable, false);
assert.equal(proxyError.message.includes('<!doctype'), false);

const overloadError = context.buildUpstreamError({ status:429, headers:{ get:() => '3' } }, '{"error":{"type":"engine_overloaded_error"}}');
assert.equal(overloadError.code, 'UPSTREAM_OVERLOADED');
assert.equal(overloadError.retryable, true);
assert.equal(overloadError.retryAfterMs, 3000);
assert.equal(context.dataUrlByteLength('data:image/png;base64,YWJj'), 3);

assert.match(src, /image_url:\{ url:prepared\.dataUrl/);
assert.match(src, /translateLocalOcrLines\(task, prepared, targetLang, meta\)/);

console.log('multimodal checks passed: capability detection, image normalization, proxy fallback, and concise upstream errors verified.');
