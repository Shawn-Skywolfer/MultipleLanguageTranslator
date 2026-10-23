'use strict';

// 验证 PDF 图文对照输出：文本块坐标聚合（bbox）、坐标到页面百分比的换算、
// 以及对照 HTML 的结构（页面截图、译文块、高亮区域、错误与 OCR 标记）。

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
const code = [
  slice('\nfunction escapeHtml', '\nfunction safeNamePart'),
  slice('\nfunction isLikelyText', '\nasync function renderPdfPageToCanvas'),
  slice('\nfunction pdfBlockRectStyle', '\nfunction nextNumericId'),
].join('\n');
const context = { console };
vm.createContext(context);
vm.runInContext(code, context);
const { groupPdfTextItems, pdfBlockRectStyle, buildPdfComparisonHtml } = context;
assert.equal(typeof groupPdfTextItems, 'function');
assert.equal(typeof buildPdfComparisonHtml, 'function');

// 1. 文本块聚合保留坐标框（pdf.js 坐标系：原点在左下角）
const blocks = groupPdfTextItems([
  { str: 'Revenue grew', transform: [12, 0, 0, 12, 72, 700], width: 80, height: 12 },
  { str: 'strongly', transform: [12, 0, 0, 12, 160, 700], width: 50, height: 12 },
  { str: 'in Q3 2026.', transform: [12, 0, 0, 12, 72, 684], width: 90, height: 12 },
  { str: 'Source: analyst report', transform: [9, 0, 0, 9, 72, 600], width: 100, height: 9 },
]);
assert.equal(blocks.length, 2);
assert.equal(blocks[0].text, 'Revenue grew strongly\nin Q3 2026.');
assert.equal(blocks[1].text, 'Source: analyst report');
assert.equal(JSON.stringify(blocks[0].bbox), JSON.stringify({ x0: 72, y0: 684, x1: 210, y1: 712 }));
assert.equal(JSON.stringify(blocks[1].bbox), JSON.stringify({ x0: 72, y0: 600, x1: 172, y1: 609 }));

// 2. bbox -> 页面百分比定位（top 从顶边算起）
const style = pdfBlockRectStyle(blocks[0], { width: 600, height: 800 });
assert.equal(style, 'left:12.00%;top:11.00%;width:23.00%;height:3.50%');
assert.equal(pdfBlockRectStyle({ text: 'no bbox' }, { width: 600, height: 800 }), '', '无坐标的块（OCR）不输出定位');

// 3. 对照 HTML 结构
const doc = {
  type: 'pdf',
  name: 'report.pdf',
  pages: [
    { pageNo: 1, extraction: 'text', width: 600, height: 800, image: 'data:image/jpeg;base64,AAAA', blocks },
    { pageNo: 2, extraction: 'ocr', width: 600, height: 800, image: 'data:image/jpeg;base64,BBBB', blocks: [{ id: 'ocr-1', text: '扫描页文字' }] },
    { pageNo: 3, extraction: 'text', width: 600, height: 800, image: '', blocks: [] },
  ],
};
const results = new Map([
  ['page-1-block-1', { text: 'Der Umsatz stieg im dritten Quartal 2026 stark an.', warning: '', error: '' }],
  ['page-1-block-2', { text: '', warning: '', error: 'HTTP 500' }],
  ['page-2-block-1', { text: 'Gescannter Seitentext', warning: '受保护术语缺失：Q3', error: '' }],
]);
const html = buildPdfComparisonHtml(doc, 'German', results);
assert.ok(html.startsWith('<!DOCTYPE html>'));
assert.ok(html.includes('data:image/jpeg;base64,AAAA'), '页面截图内嵌');
assert.ok(html.includes('id="hl-p1-b0"') && html.includes('left:12.00%;top:11.00%'), '文本块高亮区域带百分比定位');
assert.ok(html.includes('data-hl="hl-p1-b0"'), '译文块与高亮区域联动');
assert.ok(html.includes('Der Umsatz stieg im dritten Quartal 2026 stark an.'), '译文呈现');
assert.ok(html.includes('Revenue grew strongly'), '原文可展开查看');
assert.ok(html.includes('[ERROR] HTTP 500'), '失败块显示错误');
assert.ok(html.includes('OCR 页'), 'OCR 页有标记');
assert.ok(!html.includes('id="hl-p2-b0"'), 'OCR 块无坐标时不渲染高亮区域');
assert.ok(html.includes('受保护术语缺失：Q3'), '术语警告呈现');
assert.ok(html.includes('本页未生成原文截图。') && html.includes('本页未识别到可翻译文本。'), '空页与无截图占位');

console.log('pdf comparison checks passed: block bboxes, percent positioning and side-by-side HTML structure verified.');
