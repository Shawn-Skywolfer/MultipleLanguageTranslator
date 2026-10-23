# PDF 数据与故障处理

## 翻译文件

```json
{
  "language": "English",
  "protected_terms": ["Digital Power", "PCS"],
  "translations": {
    "p1-b1": "First translated text block.",
    "p1-b2": "Second translated text block."
  },
  "page_reviews": {"1": "checked", "2": "no_text"}
}
```

每个 manifest 块必须恰好有一个非空译文，不能有多余 ID。用程序合并分批结果并检查重复 ID，不能依赖普通 JSON 解析保留重复键。源文件路径与 SHA-256 绑定，文件改变后需重新提取。多个目标语言分别保存翻译 JSON 并导出，文件名包含目标语言。

原文 manifest 只作来源，禁止删除困难内容来通过覆盖校验。OCR 漏识别时，可在视觉核对后更正/补充相应页原文块与 bbox，为新增块分配新的稳定 ID，再翻译全部块。保留校对前 manifest 副本和更正理由；不把没有 OCR 的图表页冒充空白页。

## 错误码

| 错误 | 处理 |
|---|---|
| PDF_SOURCE_INVALID | 要求完整、未加密的原件；不能把引擎自动修复的输入作为完好源件 |
| PDF_OCR_FAILED | 检查 Tesseract 与所需语言包；重试识别并核对页面 |
| PDF_SOURCE_CHANGED | 当前输入与 manifest 不一致；重新抽取 |
| PDF_TRANSLATION_COVERAGE / PDF_EMPTY_TRANSLATION | 补齐缺少或空白 ID；保留数字、符号等有意义内容 |
| PDF_VISUAL_REVIEW_REQUIRED | 渲染对应页并核对 OCR；之后才写入 review 状态 |
| PDF_PROTECTED_TERM | 恢复相应块的精确术语写法 |
| PDF_RENDERED_TEXT_MISSING | 检查目标语言字体、无法渲染字符、超长单词和布局；不得裁短译文 |
| PDF_ORIGINAL_RENDER_CHANGED | 保留原页失败；停止导出，检查源页注释、字体或引擎行为 |
| PDF_SAVED_HASH | 保存后的文件与验证候选不一致；换输出位置重试 |

自动检查不衡量翻译准确率。对照原页核验数字、表头与系列名称；原生文字在混排页中的阅读顺序、OCR 的表格列关系尤其需要核对。PDF 含旋转页、异常裁剪框、表单或注释时逐页检查；输出用于阅读，不能承诺保留表单交互、数字签名或所有批注行为。

## 依赖

```bash
python -m pip install 'PyMuPDF>=1.26.6,<1.28'
tesseract --list-langs
```

使用操作系统的 Tesseract 安装和语言数据；只装英文数据不能用于完整中文识别。PyMuPDF 的分发与集成遵循其上游许可。字体由 MuPDF Story 选择与嵌入；未覆盖字符会被回读文字检查或最终视觉检查捕获。

参考：[PyMuPDF Story](https://pymupdf.readthedocs.io/en/latest/story-class.html)、[Page OCR](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_textpage_ocr)。
