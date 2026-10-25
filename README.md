# Digital Power 多格式翻译工作台

一个多格式翻译工作台：CSV/PPTX 可部署到 Vercel，PDFMathTranslate PDF 模块在本地运行。

- 中英文界面：页面右上角可随时切换中文 / English，并自动记住本机选择
- `CSV` 批量翻译：保持原有多语言批量翻译能力
- `PDF` 文档翻译：支持文字型 PDF 与图片型 PDF
- 输出每个目标语言独立下载的双语 `Markdown` 与双语 `DOCX`
- `PPTX` 翻译稿生成：保留原始页，并在每页后新增高亮译文页
- 多模态图片翻译：识别 PPTX 图片中的文字和位置，在译文页对应区域覆盖译文
- 提供直接翻译、校验后修订、多轮校验，并兼容原三轮 DSL
- 支持标准翻译库、术语保护、自定义规则和多目标语言
- 默认直接进入文档翻译；模型配置位于右上角独立“设置”入口
- 模型、目标语言、重试、输出、术语和规则支持版本化 JSON 一键导入 / 导出
- 提供 Windows 单文件便携版 `.exe`，无需安装

## 教程与演示

- [Step by Step 使用教程](docs/TUTORIAL.md)：部署、模型配置、CSV / PDF / PPTX 全流程详解与常见问题
- [旧版功能演示动画](docs/tutorial-video.html)：展示原 CSV/PPTX 与历史 PDF 交互，PDF 新版以当前教程为准；浏览器打开可播放约 78 秒演示；点击「⬇ 导出视频」一键录制并下载 WebM 视频文件（可导入剪映 / Premiere 转 MP4）

## 项目结构

```text
/workspace
├── api/
│   ├── chat-completions.js   # Vercel Function，代理模型 chat/completions
│   └── models.js             # Vercel Function，代理模型列表
├── desktop/                  # Electron 本地服务、落盘校验与 PowerPoint COM 验证
├── .github/workflows/        # Windows Portable EXE 自动构建
├── app.js                    # 前端主逻辑：CSV/PDF/PPTX 解析、翻译编排、OCR、导出
├── index.html                # 前端页面
├── package.json              # 桌面版与自动测试配置
└── README.md
```

## 当前实现

### CSV 批量翻译

- 支持 `CSV`
- 可上传多个 CSV 文件
- 支持原文列选择、源语言、国家列 / 全局国家、工作流模式、并发数、重试次数
- 支持宽表输出和长表输出
- 保留标准翻译库、术语保护和自定义规则

### 第一阶段

- 支持 `PDF`
- 文字型 PDF：使用 PDFMathTranslate 识别段落、公式与位置
- 图片型 PDF：使用 PDFMathTranslate 的本地 OCR（需本地版）
- 输出：
  - 双语 `Markdown`
  - 双语 `DOCX`
  - 图文对照 `HTML`：按原页、对应译页逐页截图，展示引擎最终排版结果。适合快速阅读带大量图表的资料型 PDF（如分析师报告）
- 每个目标语言单独导出一个文件

### 第二阶段

- 支持 `PPTX`
- 保留原始幻灯片页不变
- 在每一页原始页后新增一页对应的译文页
- 译文页会直接复用原始幻灯片中的图片、图形元素与文本框位置
- 翻译普通文本框、表格单元格与 SmartArt/Diagram 文本；可选用多模态模型翻译图片文字
- 图片文字按多模态模型返回的区域坐标，在译文页覆盖对应译文
- 图片发送前自动缩放并压缩到适合接口传输的体积；相同 PPT 媒体只识别、翻译一次
- 检测到 HIS/SWG 等企业安全代理阻止 Base64 图片上传时，自动停止继续上传图片，改用浏览器本地 OCR 提取文字和位置，再以纯文本请求完成翻译
- 图片任务固定单并发；HTTP 429、模型引擎过载及临时 5xx 错误使用共享冷却时间、指数退避和 `Retry-After` 自动重试
- 任何待翻译对象失败或结果为空时阻止导出，避免把部分漏译的文件标记为成功
- 导出前检查 ZIP 头、中央目录结束标记和全部条目 CRC32，再校验 XML、内容类型、关系源/目标、关系与形状 ID、幻灯片 ID、页数和关键 OOXML 元素顺序
- Chrome / Edge 优先使用 File System Access API 完整写入磁盘；关闭写入流后重新读取文件，比较文件大小与 SHA-256，并再次执行 CRC/OOXML 校验；首次写入异常时自动从内存中的已验证版本重写一次
- 不支持落盘重读的浏览器会把 Blob URL 保留到页面关闭，不再用固定短延时提前释放大文件下载资源
- ZIP 生成故障使用稳定错误码驱动受控修复：每次都从未修改的原始 PPTX 重新生成，自动在 `DEFLATE` / `STORE` 之间切换；通过校验的策略会写入本机修复记忆，下一次优先采用。未知 OOXML 错误不会盲目修改，而是继续阻止导出
- 布局保真保证：
  - 字号 100% 一致：逐 run 保留原始 `sz` 字号；若原文本框已有 `normAutofit` 缩放（`fontScale`），会将该缩放固化进每个 run 的字号，再锁定为 `noAutofit`，避免译文变长后被 PowerPoint 二次缩小
  - 位置 100% 一致：不改动任何 `xfrm` 偏移与尺寸，文本框矩形、对齐与锚点全部继承原页；原文居中对齐的文本，译文与其在水平、垂直方向均保持同心
  - 译文不换行：译文文本框设置 `wrap="none"`，词汇长度差异沿原对齐方向向外延伸，不因换行改变行数与垂直位置
- Windows 桌面版会在生成校验和落盘回读后，调用本机 Microsoft PowerPoint 以 `OpenAndRepair=false` 真实打开最终文件；只有打开成功才显示“PowerPoint 已验证”
- 若首次真实打开失败，桌面版调用 PowerPoint 自带 Open and Repair，另存为 Open XML Presentation，再执行 ZIP/CRC/OOXML 校验和正常打开复验
- 每个目标语言单独导出一个文件

## 运行方式

### Windows 单文件便携版

GitHub Actions 的 `Windows portable EXE` 工作流会生成：

```text
MultipleLanguageTranslator-Portable-2.0.0.exe
```

该文件无需安装即可运行，并在本机启动仅监听 `127.0.0.1` 的内置服务，因此模型代理、超大图片请求和 PPTX 保存不受 Vercel 4.5 MB 请求体限制。若电脑安装了 Microsoft PowerPoint，桌面版会把“真实打开”作为最终验证门禁。

开发者本地运行或构建：

```bash
npm install
npm run desktop
npm run dist:win
```

### 本地完整调试

当前版本依赖 `api/chat-completions.js` 和 `api/models.js` 两个 Vercel Functions，因此不再适合通过“直接双击 `index.html`”或仅用 `python -m http.server` 这类纯静态服务器进行完整测试。

如需本地完整调试，推荐使用：

```bash
npx vercel dev
```

然后访问终端输出的本地地址。

### 仅静态页面预览

如果你只是想快速看页面布局，不测试模型调用，也可以使用：

```bash
python3 -m http.server 8000
```

但这种方式下，`/api/*` 代理接口不可用，刷新模型列表和连通测试会失败。

### Vercel 一键部署

本项目不依赖构建步骤，直接导入仓库即可部署。

推荐配置：

- Framework Preset: `Other`
- Build Command: 留空
- Output Directory: 留空
- Install Command: 留空

Vercel 会自动：

- 将根目录静态文件作为前端页面发布
- 将 `api/*.js` 识别为 Serverless Functions

## 使用说明

1. 可通过页面右上角的“中文 / English”随时切换界面语言。
2. 点击右上角“设置”，填写 Provider、Base URL、API Key 和模型 ID；也可以一键导入完整配置文件。
3. 点击“连通测试”确认当前模型可用。
4. 如需批量表格翻译，进入“CSV 批量翻译”页，上传 CSV 并设置列映射。
5. 如需文档翻译，进入“文档翻译”页，上传 PDF 或 PPTX。
6. 选择源语言、工作流模式、并发数、重试次数。
7. 可选上传标准翻译库、术语 CSV，或填写自定义规则。
8. 选择目标语言。
9. 点击对应入口的开始按钮。
10. 在结果表格中分别下载各目标语言输出件。
11. Windows 便携版安装了 PowerPoint 时，看到“Microsoft PowerPoint 真实打开验证通过”后再对外交付。

## 说明与限制

- PDF 的 Markdown / DOCX 输出优先强调“原文 / 译文对应关系”和审校效率；版面与图表原貌请使用图文对照 HTML 输出（由最终 PDF 页面渲染）。
- 图文对照 HTML 中，位图图表内部的文字暂不做 OCR 翻译（图表以原样呈现）；矢量文字图表的文字会作为文本块参与翻译。
- 勾选图文对照 HTML 时会逐页渲染页面截图，超大 PDF 的解析时间和输出文件体积会相应增加。
- Web 版可执行 ZIP/CRC/OOXML 与落盘回读校验，但浏览器无法直接调用 Microsoft PowerPoint，因此只有 Windows 便携版且本机安装 PowerPoint 时，才能给出“PowerPoint 真实打开通过”的最终证明。
- PPTX 现采用“保留原始页 + 每页后新增译文页”的输出方式，尽量保留原始图片、图形元素与文本框位置；复杂母版、矢量形状、动画和特殊排版仍可能存在兼容边界，桌面版会通过实际打开与必要时的 PowerPoint 自修复兜底。
- 图片文字翻译需要支持 OpenAI-compatible 图片消息格式的多模态模型。模型列表的“多模态”标识根据名称推断，自定义模型可手动指定能力。
- 企业网络若拦截图片请求，应用会自动回退到“本地 OCR + 纯文本模型翻译”；这种兼容模式仍会保留完整性检查，但图片文字识别精度取决于 Tesseract.js。
- OCR 通过浏览器端 `Tesseract.js` 执行，首次加载语言包会较慢。
- 模型调用经站内 `/api/*` 代理转发，适合部署到 Vercel 后使用。
- PV 统计通过 `/api/pv` 计数；若在 Vercel 配置 `KV_REST_API_URL` 与 `KV_REST_API_TOKEN`（Upstash Redis）则为全网持久计数，否则仅函数实例内存计数（不保证持久）。
- 对超大 PDF、超多页 PPTX、多语言高并发任务，浏览器端处理时间会明显增加。

## 后续可继续增强

- 位图图表内文字的 OCR 识别与翻译
- 更精细的 PPTX 样式保留
- 文档任务缓存与断点续跑
- 可视化块级翻译预览

## PDFMathTranslate 引擎、Skill 和本地版

PDF 模块已替换为 [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate) 1.9.12，固定源码 fe3d2f37ef1b54abff5ebda091a7fd4fac9fbd08。使用真实 translate_stream、公式识别、DocLayout-YOLO / pdf-inspector 与上游排版；适配层补充 Agent 翻译接口、白底黑字、原段落缩放与有限失败处理。修改后的上游 converter 在 tools/pdfmath_converter.py，来源与 AGPL-3.0 许可证见 third_party/pdfmathtranslate。

### 本地运行

安装 Python **3.11 或 3.12**、Node.js **20+**。Windows 双击 `Start-Local.cmd`；macOS/Linux 运行 `./start-local.sh`。首次联网安装独立 Python 引擎环境，启动后访问 http://127.0.0.1:8765 。也可手动：

```bash
python3.12 tools/setup_pdf.py
npm start
```

Windows CI 的便携 EXE 会同时打包 CPython 与引擎依赖；用户无需另装 Python/Node。首次标准布局模型和目标字体仍需联网，工作台 CDN 与模型端点也需要网络。本地源码包与便携 EXE 有此区别，不要将源码 ZIP 描述为已离线集成全部运行时。

PDF 现在需要本地 Python，Vercel 静态部署中的 PDF 会明确要求使用本地版。CSV/PPTX 继续使用现有路径。PPTX 的真实 PowerPoint 打开门禁不变。

### 翻译深度

| 深度 | Skill 参数 | 工作台模型调用（未命中翻译记忆时，重试另计） |
|---|---|---|
| 直接翻译（默认） | --depth direct | 1 次 |
| 校验后修订 | --depth reviewed | 2 次 |
| 多轮校验翻译 | --depth multi-pass | 5 次 |

所有深度保留覆盖、公式占位符、源文件绑定和导出验证；direct 不额外做全文语义复审。工作台兼容原 full DSL（3 次）。

排版独立选择 standard（真实版面模型，扫描与复杂版面）或 native-fast（上游原生坐标解析，不做 OCR/ONNX）。不能用 native-fast 绕过扫描页。混排图片文字和保留表格标签需核对，上游不保证自动全部识别；未识别完整应先补可靠 OCR 文本层/单独扫描稿再提取。

### Agent Skill

可安装目录为 [skills/document-translate](skills/document-translate)。当前 Agent 翻译引擎任务，不要求另配模型 API Key；脚本负责排版与验证。工作台则使用用户自己的模型设置。

```bash
python3.12 tools/setup_pdf.py
.venv-pdf/bin/python tools/pdf_translate.py extract report.pdf --manifest work/manifest.json --language Chinese --source-language en --layout standard --ocr-language eng
.venv-pdf/bin/python tools/translation_batches.py plan work/manifest.json --language Chinese --depth direct --work-dir work/batches --agents 3
.venv-pdf/bin/python tools/translation_batches.py status work/batches/plan.json
# 按 Skill 生成、submit 所有候选结果后：
.venv-pdf/bin/python tools/translation_batches.py merge work/batches/plan.json --output work/translations.json
.venv-pdf/bin/python tools/pdf_translate.py export work/manifest.json work/translations.json --output-dir output
```

Windows 解释器为 `.venv-pdf\Scripts\python.exe`。完整流程见 [SKILL.md](skills/document-translate/SKILL.md)。旧 manifest / 批次缓存必须重新生成。公式占位符如 `{v0}` 必须严格保留。

128K 预算、8192 输出预算、默认 3 个宿主原生 Agent（允许 1–8）、断点恢复和严格合并继续支持；UTF-8 字节估算是保守预算，不是精确 tokenizer。没有多 Agent 工具时逐批串行。选择深度后，各批在自己的上下文内完成审校，不汇总全文到主 Agent。

### 输出与测试

输出固定 2N 页，每页原稿后紧跟对应译页。翻译区域白底黑字，在原区域整体缩放；低于最小字号时拒绝发布，不加续页。PDF 具有可提取译文文字；HTML 由最终 PDF 逐页截图生成；Markdown/DOCX 是文字审阅稿。导出回读 2N、原页像素、尺寸、旋转及 CropBox。排版/语义与 OCR 完整性仍需实际视觉核对，不声称任意 PDF 都完全无差异。

```bash
npm test
.venv-pdf/bin/python tests/pdf-cli.test.py
.venv-pdf/bin/python tests/translation-batches.test.py
.venv-pdf/bin/python tests/pdf-local.test.py
python tools/sync_skill.py
```

测试使用真实 PDFMathTranslate 引擎与本地 HTTP/Python 导出链路，覆盖双栏、中文、公式、裁剪、页面旋转、扫描 OCR、长译文拒绝、源文件保留及深度校验记录。没有将其称作完整 Chromium UI / Acrobat 测试。
