'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const storage = new Map([['digitalPowerUiLanguage', 'en']]);
const document = {
  nodeType: 9,
  documentElement: { lang: '' },
  title: '',
  body: {},
  addEventListener() {},
  querySelectorAll() { return []; },
  createTreeWalker() { return { nextNode() { return null; } }; }
};
const context = {
  console,
  document,
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, value); }
  },
  Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
  NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
  Element: class Element {},
  MutationObserver: class MutationObserver { observe() {} },
};
context.window = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync('i18n.js', 'utf8'), context);

assert.equal(context.I18n.language, 'en');
assert.equal(context.I18n.text('开始文档翻译'), 'Start Document Translation');
assert.equal(context.I18n.text('进度：2/4 (50%)'), 'Progress: 2/4 (50%)');
assert.equal(context.I18n.attribute('例如 Germany / Spain / France'), 'For example: Germany / Spain / France');

const html = fs.readFileSync('index.html', 'utf8')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '');
const visibleStrings = [...html.matchAll(/>([^<>]+)</g)]
  .map(match => match[1].trim())
  .filter(text => /[\u3400-\u9fff]/u.test(text) && text !== '中文');
const untranslated = visibleStrings.filter(text => context.I18n.text(text) === text);
assert.deepEqual(untranslated, [], `Missing English translations: ${untranslated.join(' | ')}`);

const placeholders = [...html.matchAll(/(?:placeholder|aria-label)="([^"]*[\u3400-\u9fff][^"]*)"/gu)].map(match => match[1].replaceAll('&#10;', '\n'));
const untranslatedAttributes = placeholders.filter(text => context.I18n.attribute(text) === text);
assert.deepEqual(untranslatedAttributes, [], `Missing attribute translations: ${untranslatedAttributes.join(' | ')}`);

context.I18n.setLanguage('zh-CN');
assert.equal(storage.get('digitalPowerUiLanguage'), 'zh-CN');
assert.equal(document.documentElement.lang, 'zh-CN');
assert.equal(document.title, 'Digital Power 多格式翻译工作台');
context.I18n.setLanguage('en');
assert.equal(document.documentElement.lang, 'en');
assert.equal(document.title, 'Digital Power Multi-format Translation Workbench');

console.log(`i18n checks passed for ${visibleStrings.length} visible strings and ${placeholders.length} translated attributes.`);
