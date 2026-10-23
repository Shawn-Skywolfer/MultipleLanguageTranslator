---
name: document-translate
description: Translate PDF, PPTX and CSV documents with source preservation, protected terms and export validation and in-place white-background/black-text PDF overlays. Use for bilingual document translation, scanned PDF OCR, translated reports with charts, batch multilingual CSV, or PowerPoint translation through the MultipleLanguageTranslator workbench. Supports 128K-context models through bounded PDF batches, resumable checkpoints and host-native parallel agents, plus the bundled web/Windows workbench.
---

# 文档翻译大师

使用当前 Agent 完成 PDF 翻译；让确定性脚本完成抽取、OCR、覆盖检查、原位覆盖、导出和回读验证。保留项目现有 CSV、PPTX 工作台能力。

## 选择入口

| 输入/需求 | 执行方式 | 输出 |
|---|---|---|
| PDF，无需另配模型 Key | 下述 Agent 原生流程 | 原页＋原位覆盖译文页 PDF、双语 Markdown、原位对照 HTML、验证报告 |
| PDF，需要工作台操作或 DOCX | 本地工作台 | 原位对照 PDF / HTML、双语 DOCX / Markdown |
| PPTX | 本地工作台；需真实 PowerPoint 验证时运行 Windows 桌面版 | 保留原页并插入译文页的 PPTX |
| CSV | 本地工作台 | 项目原有多语言 CSV/ZIP 输出 |

**PDF 必须严格输出 2N 页：原页 1、原位译文页 1、原页 2、原位译文页 2……。** 译文页从原页复制，保留尺寸、旋转、裁剪、图表和背景；只在原文文字坐标内加白底并叠黑色译文。按原始字号自动缩小，框不扩大，不添加续页，不改成从上至下的阅读稿。极端长译文在最小字号仍放不下时，报告具体块 ID，忠实精炼后重试；禁止截断、删事实或静默转用其他版式。不要把 PDF 描述成可编辑 PPTX。图片内的文字必须有 OCR 坐标并视觉核对。

## PDF：无需 API Key 的执行流程

把本文件所在目录记为 `SKILL_ROOT`，用绝对路径执行脚本。依赖 Python 3.10+、`PyMuPDF>=1.26.6,<1.28`；扫描/混排页还需 Tesseract 及源语言数据。先检查依赖，只在缺失时安装。中文 OCR 使用 `chi_sim+eng`，德文使用 `deu+eng`，按实际源语言选择。不能下载语言包时明确报告缺失，不能退回英文 OCR 冒充完成。

1. 确认输入、目标语言与术语。未指定目标语言时使用 English。保持公司名、型号、数字、单位、引文与 URL；禁止增补原文没有的结论。
2. 在当前任务临时目录抽取：

```bash
python "$SKILL_ROOT/scripts/pdf_translate.py" extract input.pdf --manifest work/manifest.json --ocr auto --ocr-language chi_sim+eng
```

旧版 manifest 和批次需重新提取/规划，不能使用旧阅读稿的无坐标缓存。提取结果保留原始字号、文字旋转和未旋转页面的文字框；不同列及表格单元格保持分开。`auto` 对含图片、无文字页做 OCR；混排页保留原生文字并识别图片区域。OCR 异常立即停止。不要以 `--ocr never` 绕过识别失败来交付完整翻译。

3. **默认按 128K 上下文、最大 8192 输出、最多 3 个并行 Agent 运行。** 不把全文 manifest、捆绑源码或全部译文读入主 Agent。读取 [128K 分批与多 Agent 执行](references/parallel-translation.md)，先用脚本生成任务，再只读取状态摘要：

```bash
python "$SKILL_ROOT/scripts/translation_batches.py" plan work/manifest.json --language English --context-tokens 128000 --max-output-tokens 8192 --agents 3 --work-dir work/batches
python "$SKILL_ROOT/scripts/translation_batches.py" status work/batches/plan.json
```

如果宿主实际最大输出低于 8192，先降低 `--max-output-tokens`；无法确认时不要假设 128K 上下文意味着能输出 128K。每批同时受输入和译文膨胀预算约束。脚本使用保守的 UTF-8 字节估算，不是模型精确分词器；宿主系统提示、推理和工具开销需纳入预留。有限上下文工具也不要一次打印完整 manifest。

4. 检查宿主的多 Agent 工具是否实际可用。可用时主动并行派发 pending 批次，默认最多 3 个（受宿主额度限制，脚本允许 1–8），每批使用新会话、不继承主会话历史；仅传该批 request 路径、哈希与独立候选结果路径。子 Agent 读取共享术语和邻接短上下文，翻译且只翻译分配 ID，原子提交独立结果。一个批次结束再派下一批，主 Agent 只接收批次 ID/状态/路径。具体提示和命令见上述参考。不可用时按同一批次串行处理，不能把普通 Promise/线程并发说成多 Agent。

5. 将原来需要的 OCR 视觉复核分配给每页唯一的 review owner。子 Agent 渲染并核对分配的 `review_pages`，只有确实核对后才写 `checked` 或 `no_text`；只拿到分片文字不能证明整页 OCR 完整。OCR 漏识别要先修正 manifest、重建计划，不能边翻译边修改共享输入。格式见 [PDF 数据与故障处理](references/pdf-workflow.md)。不要改写原文或删除困难内容来过检。
6. 断点恢复时运行 `status`，跳过 complete，只处理 pending；invalid 或冲突结果须检查并隔离，不能覆盖。所有批次完成后合并：

```bash
python "$SKILL_ROOT/scripts/translation_batches.py" merge work/batches/plan.json --output work/translations.json
```

合并检查来源/manifest/术语版本、目标语言、批次身份、每个片段恰好一次、分片顺序、逐块完整性及复核归属。主 Agent 根据共享 glossary 分批检查关键术语和跨页衔接；只读取有疑问的批次，避免再次把全文载入上下文。

7. 校验并导出：

```bash
python "$SKILL_ROOT/scripts/pdf_translate.py" validate work/manifest.json work/translations.json
python "$SKILL_ROOT/scripts/pdf_translate.py" export work/manifest.json work/translations.json --output-dir output
```

脚本在临时目录生成固定 2N 页 PDF，使用原文坐标白底黑字覆盖并自适应缩小字体；默认最小 3.5pt。分别检查纯译文图层的逐块可提取内容、最终页数与尺寸/旋转/裁剪，以及原页全部像素、译文页覆盖区域以外的像素。白底只能覆盖已声明的文字区域，不得遮住旁边图表。检查通过后才发布。最小字号仍放不下则按 PDF_TEXT_DOES_NOT_FIT 返回具体块，不增加页数；先忠实精炼译文后最多重试两次。

8. 再渲染最终 PDF，按原页/译文页逐对视觉检查坐标是否精准、白底是否盖住原字、字体是否可读、图表和表格线是否保留，以及缺字、重叠、裁切和异常换行；抽查术语、金额、日期和表格关系。修正译文或布局再完整导出。提供最终文件及简短验证结论；不要声称经过 Acrobat/PowerPoint 实机打开，除非确实执行过。

## 项目工作台：CSV / PPTX / PDF DOCX

读取 [工作台与 Windows 验证](references/workbench.md)，然后运行：

```bash
node "$SKILL_ROOT/scripts/start_workbench.cjs" 8765
```

在用户授权的浏览器中打开打印出的本地地址。Agent 没有浏览器文件上传/下载能力时，明确说明并交给用户操作，不假装执行完毕。此路径保留原项目设置导入/导出、术语、翻译记忆、多模型流程。PDF 原生批次的多 Agent 调度不等于工作台对象并发。CSV/PPTX 若分工，按独立文件或语言分配独立工作台实例及输出目录，禁止多 Agent 同时操作一个浏览器页面；不要声称它们已接入 PDF 的片段合并器。工作台模型调用需要用户自选服务配置；不要把 API Key 写进技能或交付文件。

需要桌面 PowerPoint 门禁时使用捆绑工作台的 Windows 版源码，不能把浏览器内 ZIP/XML 校验称作 PowerPoint 实测。先跑项目测试，再构建；这需要 Windows、Node/npm、Electron 依赖与 Microsoft PowerPoint。

## 失败后的处理

按错误码修复特定原因，最多重复导出两次；保留 manifest、译文和错误摘要以断点续做。源文变化重新抽取；漏译补齐对应 ID；OCR 问题修语言数据并视觉核对；文本渲染缺字修字体/排版。未知错误停止交付成功文件，不能删除内容或放松检查以求通过。

若在 ChatGPT Work 内生成文件，按宿主文件保存流程交付；在其他 Agent 内遵循该宿主的文件流程。技能和捆绑工作台不保存用户 API Key。
