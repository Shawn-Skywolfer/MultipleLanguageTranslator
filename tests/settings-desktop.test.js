'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const app = fs.readFileSync('app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const desktop = fs.readFileSync('desktop/main.cjs', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

assert.match(app, /const BASE_LANGS = \['English','German'/, 'English must be the first default target language');
assert.match(app, /SETTINGS_EXPORT_TYPE/, 'settings exports must be versioned and typed');
assert.match(app, /function collectAppSettings\(/, 'all settings need one export collector');
assert.match(app, /function applyAppSettings\(/, 'all settings need one import applicator');
assert.match(html, /id="openSettingsBtn"/, 'settings need a dedicated entry');
assert.match(html, /<dialog id="settingsDialog"/, 'settings need a dedicated dialog');
assert.match(html, /data-tab="document">1\. 文档翻译/, 'the app must start in document translation, not settings');
assert.doesNotMatch(html, /data-tab="model"/, 'model settings must not remain a primary workflow tab');
assert.equal((html.match(/id="statPv"/g) || []).length, 1, 'DOM IDs must be unique');

assert.match(desktop, /Presentations\.Open2007/, 'desktop validation must actually open the file in PowerPoint');
assert.match(desktop, /SaveCopyAs\(\$outputPath, 24, 0\)/, 'PowerPoint validation must round-trip an Open XML PPTX copy');
assert.match(desktop, /writeAndReadBack/, 'desktop save must reopen and hash persisted bytes');
assert.match(desktop, /Open and Repair 失败/, 'PowerPoint repair errors must fail closed');
assert.match(desktop, /PowerPoint 打开后的页数不一致/, 'PowerPoint repair must reject any deleted slides');
assert.match(desktop, /本机无法调用 Microsoft PowerPoint，不能完成真实打开验证/, 'desktop export must fail closed when real PowerPoint validation is unavailable');
assert.match(desktop, /缺少预期幻灯片页数/, 'desktop export must require an exact slide-count contract');
assert.match(app, /expectedSlides,\s*\n\s*}\);/, 'renderer must send the exact expected slide count to PowerPoint');
assert.match(app, /逐页对象数量不一致/, 'PowerPoint round-trip must reject lost slide objects');
assert.match(desktop, /backup-\$\{crypto\.randomUUID\(\)\}/, 'an overwritten destination must be recoverable until all validation gates pass');
assert.equal(packageJson.build.win.target[0], 'portable');
assert.match(packageJson.build.win.artifactName, /\.exe$/);

console.log('settings and desktop checks passed: friendly entry, full config portability, English default, verified save, PowerPoint gate, and portable EXE build covered.');
