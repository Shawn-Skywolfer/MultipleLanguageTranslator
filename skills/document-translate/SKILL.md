---
name: document-translate
description: Translate PDF, PPTX and CSV documents while preserving source layouts and protected terms. Use PDFMathTranslate for formula-aware bilingual PDFs, scientific papers, scanned PDFs and white-background black-text translations in the original regions. Offer direct, reviewed or multi-pass translation, bounded 128K-context jobs, resumable checkpoints and host-native parallel agents; retain the bundled local/Windows workbench for PDF, PPTX and CSV.
---

# 文档翻译大师

PDF 使用指定的 **PDFMathTranslate 1.9.12** 引擎（固定源码版本），由当前 Agent 翻译段落，引擎负责公式保留、版面分析与排版。不要调用旧版 PyMuPDF 自制覆盖流程。CSV/PPTX 仍使用捆绑工作台。

## 选择深度与速度

在开始时给用户提供下面的选项；已明确选择时直接执行。未指定时采用 **直接翻译** 并说明，可在下一次任务切换。不要因没有回复而反复等待。

| 选项 | `--depth` | 每批执行 | 适用 |
|---|---|---|---|
| 直接翻译（默认） | `direct` | 只翻译一次，不追加语言润色轮次 | 优先速度 |
| 校验后修订 | `reviewed` | 初译 → 对照源文检查准确性并修订一次 | 平衡质量与速度 |
| 多轮校验翻译 | `multi-pass` | 初译 → 准确性校验修订 → 术语一致性校验修订 → 最终对照修订 | 重要技术资料 |

深度控制语义审校，**任何深度均执行公式占位符、覆盖、原页、页数和文件检查**。不要把程序结构检查称为多轮翻译审校，也不要给 direct 偷加全文复审。实际完成所选轮次后，在候选结果 `quality_checks` 中记录 `[]`、`["accuracy"]` 或 `["accuracy","terminology","final"]`。

排版模式与翻译深度独立：`standard` 使用真实 DocLayout-YOLO 模型，适合复杂版面、公式与扫描页；`native-fast` 使用上游 pdf-inspector 原生文字位置，跳过版面模型和 OCR，适合清晰文字型 PDF。只有确认源文是原生文字页且版面简单时选 native-fast；纯扫描页会明确拒绝。不要为提速漏掉图片文字。

## PDF：当前 Agent 翻译，无需另配 API Key

把技能目录记为 `SKILL_ROOT`。使用绝对路径。Python **3.11 或 3.12**；上游 PyMuPDF 与旧 Skill 依赖冲突，必须使用独立环境。

1. 确认输入、目标语言、深度与术语。未指定语言用 English。数字、单位、型号、引文与 URL 保留，原文没有的结论不添加。
2. 检查独立环境；仅缺失时运行安装（首次联网安装依赖并在解析时下载模型/字体）：

```bash
python3.12 "$SKILL_ROOT/scripts/setup_pdf.py" --env-dir work/pdf-env
```

Windows 用 `py -3.12`，随后解释器为 `work/pdf-env/Scripts/python.exe`；macOS/Linux 为 `work/pdf-env/bin/python`，下文记作 `PDF_PYTHON`。可用 `--download-assets` 提前缓存模型与常用字体。安装失败时报告原因，禁止静默回到旧引擎。

3. 提取引擎实际翻译段落，示例为英文转中文：

```bash
"$PDF_PYTHON" "$SKILL_ROOT/scripts/pdf_translate.py" extract input.pdf --manifest work/manifest.json --language Chinese --source-language en --layout standard --ocr-language eng
```

目标语/源语按任务修改。中文扫描 OCR 用 `chi_sim+eng`，德文用 `deu+eng`；已有语言数据用 `TESSDATA_PREFIX`，否则上游首次下载所需数据。先检查依赖，下载失败明确报告。引擎 OCR 自动处理纯图片页；**原生文字与图片混排时，上游不会自动识别全部图片内文字**，必须视觉检查：图片含待翻译文字则先生成可靠 OCR 文本层/单独扫描稿再用 standard 重新提取，不能勾选复核冒充图片文字已翻译。表格/独立公式可能被上游作为保留区域，检查用户是否要求翻译其中标签，不要声称它们必然全译。

旧版 manifest、plan 和译文缓存不能复用。`{v0}`、`{v1}` 等是原始公式/符号占位符，必须原样保留，不能翻译、删除、增加或交换对应含义。每页重复段落按稳定 ID 处理；同页重复原文共享译文，所有出现位置仍由引擎渲染。

4. 默认按 **128K 上下文、8192 最大输出、最多 3 个 Agent** 规划；不把全文 manifest/源码读入会话：

```bash
"$PDF_PYTHON" "$SKILL_ROOT/scripts/translation_batches.py" plan work/manifest.json --language Chinese --depth direct --context-tokens 128000 --max-output-tokens 8192 --agents 3 --work-dir work/batches
"$PDF_PYTHON" "$SKILL_ROOT/scripts/translation_batches.py" status work/batches/plan.json
```

宿主输出低于 8192 时先调低。预算是保守 UTF-8 字节估算，不是精确 tokenizer。详见 [128K、深度与并行调度](references/parallel-translation.md)。检查宿主多 Agent 工具确实存在；可用时按批次主动并发，默认最多 3，允许 1–8 且服从配额。每批新会话、不继承主会话，只传 request 路径、哈希、plan 路径和独立候选路径；主 Agent 只接收状态/路径。不可用时按批串行，不能把线程称作 Agent。

5. 每批只翻译分配 ID，按所选深度实际审校并记录。OCR/图片复核页指定唯一 owner：必须渲染并视觉核对源页和抽取文字后才记录 `checked` / `no_text`。不能自动生成已复核记录。漏识别先改输入 OCR 并重建 manifest/plan，不边翻译边改共享输入。
6. 所有批次通过 submit 后合并、校验并导出：

```bash
"$PDF_PYTHON" "$SKILL_ROOT/scripts/translation_batches.py" merge work/batches/plan.json --output work/translations.json
"$PDF_PYTHON" "$SKILL_ROOT/scripts/pdf_translate.py" validate work/manifest.json work/translations.json
"$PDF_PYTHON" "$SKILL_ROOT/scripts/pdf_translate.py" export work/manifest.json work/translations.json --output-dir output
```

输出固定 **2N 页**：原页 1、译文页 1、原页 2、译文页 2……。引擎回放同一组段落，保留公式与图形；本地适配层增加白底黑字与原段落区域内的整体缩放。字号低于默认 3.5pt 时拒绝发布，忠实精炼后重试，不删事实、不截断、不增加续页。输出含 PDF、原页/译页截图 HTML、文字审阅 Markdown 和验证报告。

7. 渲染最终 PDF，逐对核对位置、字体可读性、公式/图表、缺字、重叠、裁切及 OCR 完整性。结构校验验证 2N、原页像素及尺寸/旋转/裁剪；**不等于自动证明所有译文准确或所有背景像素不变**，有问题必须修复并重新导出。PDFMathTranslate 复杂表格、旋转文字和混排 OCR 有边界，详见 [引擎与故障处理](references/pdf-workflow.md)。不要声称经过 Acrobat/PowerPoint 实机打开，除非真的执行。

## 本地工作台 / Windows

读取 [本地工作台](references/workbench.md)。工作台与 Skill 使用同一 Python 引擎；浏览器不再运行旧 PDF 覆盖模块。

```bash
python3.12 "$SKILL_ROOT/assets/workbench/tools/setup_pdf.py"
node "$SKILL_ROOT/scripts/start_workbench.cjs" 8765
```

打开打印地址，导入自己的模型设置，选择直接翻译 / 校验后修订 / 多轮校验。工作台分别调用模型 1 / 2 / 5 次，失败重试另计。工作台对象并发不同于 Skill 的宿主 Agent 并发。CSV/PPTX 需要分工时按独立文件/语言使用独立工作台实例，不共用一个浏览器页面。

PDFMathTranslate 需要 Python，托管静态网页会明确提示下载本地版。便携 EXE 构建包含 Python 与引擎依赖，但首次模型/字体下载和模型端点仍需联网。PPTX 的 Microsoft PowerPoint 实机验证门禁保持不变。API Key 不写入技能或交付物；不假装通过浏览器完成未实际执行的上传/下载。

## 失败与恢复

最多修正并重导出两次；源文/术语/深度变化时重建计划。保留工作 manifest、批次、译文与错误以便恢复。不要删除难译内容、跳过 OCR 或放松结构检查来通过。遵循宿主文件保存流程交付。许可证与修改来源见 `assets/workbench/third_party/pdfmathtranslate/`。
