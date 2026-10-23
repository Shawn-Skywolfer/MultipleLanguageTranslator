---
name: document-translate
description: Translate PDF, PPTX and CSV documents with source preservation, protected terms and export validation. Use for bilingual document translation, scanned PDF OCR, translated reports with charts, batch multilingual CSV, or PowerPoint translation through the MultipleLanguageTranslator workbench. Provides an agent-native PDF extract/translate/export CLI and the project's bundled web/Windows workbench.
---

# 文档翻译大师

使用当前 Agent 完成 PDF 翻译；让确定性脚本完成抽取、OCR、覆盖检查、分页、导出和回读验证。保留项目现有 CSV、PPTX 工作台能力。

## 选择入口

| 输入/需求 | 执行方式 | 输出 |
|---|---|---|
| PDF，无需另配模型 Key | 下述 Agent 原生流程 | 原页＋译文页 PDF、双语 Markdown、原页截图与译文对照 HTML、验证报告 |
| PDF，需要 DOCX 或项目的模型评审流程 | 本地工作台 | 双语 DOCX、Markdown、对照 HTML |
| PPTX | 本地工作台；需真实 PowerPoint 验证时运行 Windows 桌面版 | 保留原页并插入译文页的 PPTX |
| CSV | 本地工作台 | 项目原有多语言 CSV/ZIP 输出 |

不要把 PDF 输出描述成原位重排或可编辑 PPTX。原页保持图表与版面，译文另页自动分页；长译文允许占多页。图片内的文字需要 OCR 和视觉核对。完整性检查只覆盖抽取到的内容，不证明 OCR 或翻译语义绝对正确。

## PDF：无需 API Key 的执行流程

把本文件所在目录记为 `SKILL_ROOT`，用绝对路径执行脚本。依赖 Python 3.10+、`PyMuPDF>=1.26.6,<1.28`；扫描/混排页还需 Tesseract 及源语言数据。先检查依赖，只在缺失时安装。中文 OCR 使用 `chi_sim+eng`，德文使用 `deu+eng`，按实际源语言选择。不能下载语言包时明确报告缺失，不能退回英文 OCR 冒充完成。

1. 确认输入、目标语言与术语。未指定目标语言时使用 English。保持公司名、型号、数字、单位、引文与 URL；禁止增补原文没有的结论。
2. 在当前任务临时目录抽取：

```bash
python "$SKILL_ROOT/scripts/pdf_translate.py" extract input.pdf --manifest work/manifest.json --ocr auto --ocr-language chi_sim+eng
```

`auto` 对含图片、无文字页做 OCR；混排页保留原生文字并识别图片区域。OCR 异常立即停止。不要以 `--ocr never` 绕过识别失败来交付完整翻译。

3. 阅读 manifest 全部页，按稳定 block ID 分批翻译。将每个 ID 的译文保存到 `work/translations.json`。不需要调用外部模型 API，可直接使用当前 Agent。任务很大时分批写入并保留进度；恢复前校验源文件哈希。格式见 [PDF 数据与故障处理](references/pdf-workflow.md)。不要改写 manifest 原文或删除块。
4. 渲染并核对 `review_required` 的所有原页，补全漏识别文字后重新生成一致 manifest。只有确实核对过才记录 `page_reviews`。没有文字的纯图表页填 `no_text`；有块的 OCR/图片页填 `checked`。严禁为了通过检查直接批量标记。用：

```bash
python "$SKILL_ROOT/scripts/pdf_translate.py" inspect input.pdf --output-dir work/source-preview --pages 1,2
```

5. 校验并导出：

```bash
python "$SKILL_ROOT/scripts/pdf_translate.py" validate work/manifest.json work/translations.json
python "$SKILL_ROOT/scripts/pdf_translate.py" export work/manifest.json work/translations.json --output-dir output
```

脚本在临时目录生成 PDF，重新打开，核对源页数、每个译文块的可提取文本，并渲染全部页面；对每个保留原页做像素比较；检查通过后才发布。翻译页自动续页，不能裁掉长译文。

6. 再渲染最终 PDF，视觉检查全部译文页是否有缺字、重叠、裁切、异常换行和阅读顺序错误；抽查术语、金额、日期和表格关系。修正译文或布局再完整导出。提供最终文件及简短验证结论；不要声称经过 Acrobat/PowerPoint 实机打开，除非确实执行过。

## 项目工作台：CSV / PPTX / PDF DOCX

读取 [工作台与 Windows 验证](references/workbench.md)，然后运行：

```bash
node "$SKILL_ROOT/scripts/start_workbench.cjs" 8765
```

在用户授权的浏览器中打开打印出的本地地址。Agent 没有浏览器文件上传/下载能力时，明确说明并交给用户操作，不假装执行完毕。此路径保留原项目设置导入/导出、术语、翻译记忆、多模型流程。工作台模型调用需要用户自选服务配置；不要把 API Key 写进技能或交付文件。

需要桌面 PowerPoint 门禁时使用捆绑工作台的 Windows 版源码，不能把浏览器内 ZIP/XML 校验称作 PowerPoint 实测。先跑项目测试，再构建；这需要 Windows、Node/npm、Electron 依赖与 Microsoft PowerPoint。

## 失败后的处理

按错误码修复特定原因，最多重复导出两次；保留 manifest、译文和错误摘要以断点续做。源文变化重新抽取；漏译补齐对应 ID；OCR 问题修语言数据并视觉核对；文本渲染缺字修字体/排版。未知错误停止交付成功文件，不能删除内容或放松检查以求通过。

若在 ChatGPT Work 内生成文件，按宿主文件保存流程交付；在其他 Agent 内遵循该宿主的文件流程。技能和捆绑工作台不保存用户 API Key。
