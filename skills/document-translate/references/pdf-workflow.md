# PDFMathTranslate 引擎与故障处理

## 引擎

使用 PDFMathTranslate 1.9.12，固定源码 `fe3d2f37ef1b54abff5ebda091a7fd4fac9fbd08`。
上游：[仓库](https://github.com/PDFMathTranslate/PDFMathTranslate)、[Python API](https://github.com/PDFMathTranslate/PDFMathTranslate/blob/main/docs/APIS.md)。
通过上游 `translate_stream` 实际解析、识别公式、分组与排版；修改后的上游 converter 在 scripts/pdfmath_converter.py，增加段落桥接、有限失败处理、白底黑字和整体缩放。不是把旧模块换个名称。

`standard` 使用 DocLayout-YOLO；`native-fast` 使用 pdf-inspector 的原生位置，不运行 OCR/ONNX。两者都用固定来源、目标语言及布局配置回放，覆盖变化会阻止输出。

## 数据与复核

manifest `document-translate/pdfmath-v1` 含 source、sha256、engine、language、page_count、pages。pages 中的 blocks 为引擎真正提交给翻译器的文字，包含稳定 id、source、bbox、font_size 和 occurrences。同页完全相同的文字共享结果，跨页 ID 独立。独立公式由引擎保留，不送 Agent 改写。

译文 JSON：

```json
{
  "language": "Chinese",
  "depth": "direct",
  "quality_checks": {},
  "translations": {"p1-pm-actual-hash": "译文 {v0}"},
  "protected_terms": ["PCS"],
  "page_reviews": {"1": "checked"}
}
```

用真实 ID。page_reviews 仅填写被要求复核的页；有段落用 checked，无段落经视觉确认用 no_text。复核不证明 OCR 自动完整。每轮语义审校的质量取决于执行 Agent，程序只核验其记录与任务约定。

## 版面边界

- 翻译 PDF 固定 2N；原页像素逐页回读；译页保持相同尺寸、旋转、CropBox。
- 原生文字采用源区域内白底黑字，译文与行内公式整体缩小，不扩大原框；最小字号默认 3.5pt。
- 上游可能保留整张表格或独立公式区域，其中的可读标签不保证被抽取。视觉发现需要翻译的标签未入任务时，必须解决而非宣称全译。
- 上游自动 OCR 针对纯图片页。混排页的图片文字应先得到完整 OCR 文本层/单独扫描稿并重新提取。不能以 native-fast 绕过纯扫描页。
- 白底覆盖可能涉及扫描页中贴近文字的图案；复杂版式需逐页检查。不要承诺未经检查的背景像素完全不变。
- 旋转页面通过先在未旋转坐标下分析再恢复 /Rotate，覆盖 0/90/180/270 度与 CropBox；文字自身旋转不等同于页面旋转，当前明确以 PDF_TEXT_ROTATION_UNSUPPORTED 拒绝，须先规范化输入。
- HTML 由最终原页/译页图像生成，与最终 PDF 一致；Markdown/DOCX 是文字审阅稿。

## 常见错误

| 错误 | 修复 |
|---|---|
| PDF_ENGINE_VERSION / import failure | 用 setup_pdf.py 建立独立 Python 3.11/3.12 环境，勿混入旧版 PyMuPDF |
| PDF_OCR_REQUIRED | 纯扫描页不能用 native-fast，切换 standard |
| PDF_OCR_EMPTY / language data failure | 检查源语言、TESSDATA_PREFIX 或下载所需语言数据，渲染核对 |
| PDF_MANIFEST_SCHEMA / PDF_ENGINE_JOB_CHANGED | 用当前引擎重新提取并重新规划，勿复用旧版坐标任务 |
| PDF_FORMULA_PLACEHOLDERS | 恢复全部 {vN} 原样占位符与其语义位置 |
| PDF_TEXT_DOES_NOT_FIT | 忠实精炼对应段落；仍不可读时明确报告，勿截断或增加页 |
| PDF_SOURCE_CHANGED | 源文件发生变化，重新提取 |
| PDF_VISUAL_REVIEW_REQUIRED | 实际视觉复核指定源页再提交记录 |
| BATCH_DEPTH_CHECKS | 完成所选语义校验并记录，不能只改字段 |
| 网络限流 | 保留工作文件，降低并发后重试；模型/字体缓存成功后复用 |

导出先写任务临时目录，全部校验通过后替换目标文件；失败不覆盖已存在的有效输出。不要把输入放进输出目录并同名覆盖。
