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
assert.match(desktop, /SaveCopyAs\(\$repairPath, 24, 0\)/, 'PowerPoint repair must save an Open XML PPTX copy');
assert.match(desktop, /writeAndReadBack/, 'desktop save must reopen and hash persisted bytes');
assert.match(desktop, /Open and Repair 失败/, 'PowerPoint repair errors must fail closed');
assert.match(desktop, /backup-\$\{crypto\.randomUUID\(\)\}/, 'an overwritten destination must be recoverable until all validation gates pass');
assert.equal(packageJson.build.win.target[0], 'portable');
assert.match(packageJson.build.win.artifactName, /\.exe$/);

console.log('settings and desktop checks passed: friendly entry, full config portability, English default, verified save, PowerPoint gate, and portable EXE build covered.');
