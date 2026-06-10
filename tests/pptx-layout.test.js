'use strict';

// 验证 PPTX 译文页的布局保真：字号 100% 不变、位置 100% 不变、
// 文本框不换行（wrap="none"）、自动缩放被锁定（noAutofit / 固化 fontScale）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// ---- 最小 XML DOM stub，覆盖 app.js 中 PPTX 写出路径用到的 API ----
class StubElement {
  constructor(qualifiedName) {
    this.nodeType = 1;
    this.qualifiedName = qualifiedName;
    this.localName = qualifiedName.includes(':') ? qualifiedName.split(':').pop() : qualifiedName;
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this._text = '';
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() {
    if (!this.childNodes.length) return this._text;
    return this.childNodes.map(node => node.textContent).join('');
  }
  set textContent(value) {
    this.childNodes = [];
    this._text = String(value);
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  setAttributeNS(ns, qualifiedName, value) { this.attrs.set(qualifiedName, String(value)); }
  getAttributeNS(ns, localName) { return this.attrs.get('r:' + localName) || null; }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  insertBefore(node, ref) {
    if (!ref) return this.appendChild(node);
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = this.childNodes.indexOf(ref);
    assert.notEqual(index, -1, 'insertBefore: ref not a child');
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    assert.notEqual(index, -1, 'removeChild: not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(newNode, oldNode) {
    const index = this.childNodes.indexOf(oldNode);
    assert.notEqual(index, -1, 'replaceChild: not a child');
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    this.childNodes[index] = newNode;
    newNode.parentNode = this;
    oldNode.parentNode = null;
    return oldNode;
  }
  getElementsByTagName(name) {
    assert.equal(name, '*', 'stub only supports getElementsByTagName("*")');
    const out = [];
    const walk = node => node.children.forEach(child => { out.push(child); walk(child); });
    walk(this);
    return out;
  }
}
const xmlDoc = { createElementNS: (ns, qualifiedName) => new StubElement(qualifiedName) };
function el(qualifiedName, attrs = {}, children = [], text) {
  const node = new StubElement(qualifiedName);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  children.forEach(child => node.appendChild(child));
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- 从 app.js 提取被测函数（与 i18n.test.js 同为无构建直跑风格） ----
const src = fs.readFileSync('app.js', 'utf8');
function slice(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `cannot slice ${startMarker} .. ${endMarker}`);
  return src.slice(start, end);
}
const code = [
  slice('\nfunction localNameNodes', '\nfunction emuToInch'),
  slice('\nfunction rebalanceLinesToCount', '\nfunction buildPdfMarkdown'),
  slice('\nfunction nextNumericId', '\nasync function buildTranslatedPptx'),
].join('\n');
const context = { console, log() {}, state: {}, Math, Number, String, Array, Object, JSON };
vm.createContext(context);
vm.runInContext(code, context);
const { lockTranslatedBodyLayout, updateTranslatedShape } = context;
assert.equal(typeof lockTranslatedBodyLayout, 'function');
assert.equal(typeof updateTranslatedShape, 'function');

function autofitNames(bodyPr) {
  return bodyPr.children.map(child => child.localName).filter(name => ['noAutofit', 'normAutofit', 'spAutoFit'].includes(name));
}

// 1. normAutofit（无已生效缩放）→ 替换为 noAutofit，且不换行
{
  const bodyPr = el('a:bodyPr', {}, [el('a:normAutofit')]);
  const txBody = el('p:txBody', {}, [bodyPr, el('a:p')]);
  lockTranslatedBodyLayout(txBody, xmlDoc);
  assert.equal(bodyPr.getAttribute('wrap'), 'none');
  assert.deepEqual(autofitNames(bodyPr), ['noAutofit']);
}

// 2. normAutofit fontScale=62500 且所有 run 有显式字号 → 字号固化（1800→1125）后锁定
{
  const rPr = el('a:rPr', { sz: '1800' });
  const run = el('a:r', {}, [rPr, el('a:t', {}, [], 'Hello')]);
  const bodyPr = el('a:bodyPr', {}, [el('a:normAutofit', { fontScale: '62500' })]);
  const txBody = el('p:txBody', {}, [bodyPr, el('a:p', {}, [run])]);
  lockTranslatedBodyLayout(txBody, xmlDoc);
  assert.equal(rPr.getAttribute('sz'), '1125');
  assert.deepEqual(autofitNames(bodyPr), ['noAutofit']);
}

// 3. fontScale 无法固化（run 无显式字号）→ 原样保留 normAutofit，渲染缩放与原文页一致
{
  const run = el('a:r', {}, [el('a:rPr'), el('a:t', {}, [], 'Hello')]);
  const bodyPr = el('a:bodyPr', {}, [el('a:normAutofit', { fontScale: '62500' })]);
  const txBody = el('p:txBody', {}, [bodyPr, el('a:p', {}, [run])]);
  lockTranslatedBodyLayout(txBody, xmlDoc);
  assert.equal(bodyPr.getAttribute('wrap'), 'none');
  assert.deepEqual(autofitNames(bodyPr), ['normAutofit']);
  assert.equal(bodyPr.children[0].getAttribute('fontScale'), '62500');
}

// 4. spAutoFit（形状随文字缩放）→ 替换为 noAutofit，锁定文本框几何
{
  const bodyPr = el('a:bodyPr', {}, [el('a:spAutoFit')]);
  const txBody = el('p:txBody', {}, [bodyPr, el('a:p')]);
  lockTranslatedBodyLayout(txBody, xmlDoc);
  assert.deepEqual(autofitNames(bodyPr), ['noAutofit']);
}

// 5. 缺失 bodyPr → 创建为第一个子节点并锁定
{
  const txBody = el('p:txBody', {}, [el('a:p')]);
  lockTranslatedBodyLayout(txBody, xmlDoc);
  const bodyPr = txBody.children[0];
  assert.equal(bodyPr.localName, 'bodyPr');
  assert.equal(bodyPr.getAttribute('wrap'), 'none');
  assert.deepEqual(autofitNames(bodyPr), ['noAutofit']);
}

// 6. 集成：updateTranslatedShape 替换文本后，字号与 xfrm 位置 100% 不变
{
  const off = el('a:off', { x: '914400', y: '1828800' });
  const ext = el('a:ext', { cx: '4572000', cy: '914400' });
  const rPr1 = el('a:rPr', { sz: '2400', b: '1' });
  const rPr2 = el('a:rPr', { sz: '1400' });
  const sp = el('p:sp', {}, [
    el('p:nvSpPr', {}, [el('p:cNvPr', { id: '5' })]),
    el('p:spPr', {}, [el('a:xfrm', {}, [off, ext])]),
    el('p:txBody', {}, [
      el('a:bodyPr', {}, [el('a:normAutofit')]),
      el('a:p', {}, [
        el('a:r', {}, [rPr1, el('a:t', {}, [], '数字能源')]),
        el('a:r', {}, [rPr2, el('a:t', {}, [], '解决方案')]),
      ]),
    ]),
  ]);
  updateTranslatedShape(sp, 'Digital Power Solutions', xmlDoc);
  assert.equal(rPr1.getAttribute('sz'), '2400', 'run 1 字号必须不变');
  assert.equal(rPr2.getAttribute('sz'), '1400', 'run 2 字号必须不变');
  assert.equal(off.getAttribute('x'), '914400', '文本框 x 偏移必须不变');
  assert.equal(off.getAttribute('y'), '1828800', '文本框 y 偏移必须不变');
  assert.equal(ext.getAttribute('cx'), '4572000', '文本框宽度必须不变');
  assert.equal(ext.getAttribute('cy'), '914400', '文本框高度必须不变');
  const txBody = sp.children[2];
  assert.equal(txBody.textContent.replace(/\s+/g, ' ').trim(), 'Digital Power Solutions');
  const bodyPr = txBody.children[0];
  assert.equal(bodyPr.getAttribute('wrap'), 'none');
  assert.deepEqual(autofitNames(bodyPr), ['noAutofit']);
}

// 7. 多段落：译文行与段落一一对应，不得按字符比例把单词截断到错误段落
{
  const t1 = el('a:t', {}, [], '高效供电系统');
  const t2 = el('a:t', {}, [], '智能监控平台');
  const sp = el('p:sp', {}, [
    el('p:nvSpPr', {}, [el('p:cNvPr', { id: '3' })]),
    el('p:spPr', {}, [el('a:xfrm', {}, [el('a:off', { x: '0', y: '0' }), el('a:ext', { cx: '100', cy: '100' })])]),
    el('p:txBody', {}, [
      el('a:bodyPr'),
      el('a:p', {}, [el('a:r', {}, [el('a:rPr', { sz: '1800' }), t1])]),
      el('a:p', {}, [el('a:r', {}, [el('a:rPr', { sz: '1800' }), t2])]),
    ]),
  ]);
  updateTranslatedShape(sp, 'Hocheffizientes Stromversorgungssystem\nIntelligente Überwachungsplattform', xmlDoc);
  assert.equal(t1.textContent, 'Hocheffizientes Stromversorgungssystem', '第 1 行译文应完整落入第 1 段');
  assert.equal(t2.textContent, 'Intelligente Überwachungsplattform', '第 2 行译文应完整落入第 2 段');
}

console.log('pptx layout fidelity checks passed: font sizes, xfrm positions, wrap=none, autofit locking and per-paragraph line mapping verified.');
