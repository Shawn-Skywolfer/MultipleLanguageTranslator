# Digital Power 多格式翻译工作台

一个适合直接部署到 Vercel 的前端 + Serverless Functions 小工具，用于：

- 中英文界面：页面右上角可随时切换中文 / English，并自动记住本机选择
- `CSV` 批量翻译：保持原有多语言批量翻译能力
- `PDF` 文档翻译：支持文字型 PDF 与图片型 PDF
- 输出每个目标语言独立下载的双语 `Markdown` 与双语 `DOCX`
- `PPTX` 翻译稿生成：保留原始页，并在每页后新增高亮译文页
- 多模态图片翻译：识别 PPTX 图片中的文字和位置，在译文页对应区域覆盖译文
- 继续沿用三轮翻译审校工作流：`初译 -> 建议 -> 改译`
- 支持标准翻译库、术语保护、自定义规则和多目标语言
- 默认直接进入文档翻译；模型配置位于右上角独立“设置”入口
- 模型、目标语言、重试、输出、术语和规则支持版本化 JSON 一键导入 / 导出
- 提供 Windows 单文件便携版 `.exe`，无需安装

## 教程与演示

- [Step by Step 使用教程](docs/TUTORIAL.md)：部署、模型配置、CSV / PDF / PPTX 全流程详解与常见问题
- [功能演示动画](docs/tutorial-video.html)：浏览器打开即可播放约 78 秒的全功能演示；点击「⬇ 导出视频」一键录制并下载 WebM 视频文件（可导入剪映 / Premiere 转 MP4）

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
- 文字型 PDF：直接抽取文本块（保留每个文本块在页面上的坐标）
- 图片型 PDF：当文本不足时自动回退到 `Tesseract.js` OCR
- 输出：
  - 双语 `Markdown`
  - 双语 `DOCX`
  - 图文对照 `HTML`：左侧为原文页面高清截图（图表、版面 100% 原貌），右侧为按阅读顺序排列的译文块；点击译文块可在左侧页面上高亮对应原文位置，译文块内可展开查看原文。适合快速阅读带大量图表的资料型 PDF（如分析师报告）
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

- PDF 的 Markdown / DOCX 输出优先强调“原文 / 译文对应关系”和审校效率；版面与图表原貌请使用图文对照 HTML 输出（原文页以截图呈现，零失真）。
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

## Agent Skill 与强化 PDF 流程

本项目的可安装 Skill 位于 [`skills/document-translate`](skills/document-translate)。将整个目录复制到支持 Agent Skills 的客户端的 skills 目录，通过 `$document-translate` 调用。Skill 捆绑项目工作台源码，可运行现有 CSV/PPTX/PDF 功能；不要求每次从 GitHub 克隆。

PDF 增强包括：

- 浏览器工作台对混排页中的图片执行本地 OCR；保留原生文字及数字标签，复用 OCR Worker。
- PDF 翻译失败块有两轮有限补译；缺少、空白或错误结果阻止全部 PDF 格式导出。
- OCR 识别为空而页面非空时停止；解析失败逐文件报告，资源释放后恢复按钮，取消不输出半成品。
- 新增无模型 API 依赖的 Agent 原生 PDF CLI：当前 Agent 按文本块翻译，脚本负责源文件 SHA-256 绑定、术语检查、覆盖检查与输出。
- CLI 支持文字 PDF、扫描页和混排页；生成“原页＋对应译文页”双语 PDF、Markdown、原页截图/译文对照 HTML 及 JSON 验证报告。译文可自动续页，不挤回原版面。
- PDF 在临时目录生成后重新打开，校验每个译文块可提取、渲染所有输出页、逐原页比对渲染像素，再发布结果。扫描/混排页必须有视觉复核记录。

### PDF CLI

需要 Python 3.10+ 和 `tools/requirements-pdf.txt` 中的依赖。扫描页还需 Tesseract 及源语言数据；中文使用 `chi_sim+eng`，不是仅安装 `eng`。

```bash
python -m pip install -r tools/requirements-pdf.txt
python tools/pdf_translate.py extract report.pdf --manifest work/manifest.json --ocr auto --ocr-language chi_sim+eng
# Agent 按 manifest 稳定 ID 翻译，写出 work/translations.json，并视觉核对 OCR 页。
python tools/pdf_translate.py validate work/manifest.json work/translations.json
python tools/pdf_translate.py export work/manifest.json work/translations.json --output-dir output
```

翻译 JSON、页复核格式和故障处理见 [Skill PDF 流程](skills/document-translate/references/pdf-workflow.md)。浏览器工作台继续提供 Markdown / DOCX / HTML；上述双语 PDF 文件输出由原生 CLI 提供。PDF 不是原位重排，不能转化为可编辑 PPTX。

### 本地工作台与维护

```bash
node skills/document-translate/scripts/start_workbench.cjs 8765
# 打开 http://127.0.0.1:8765
```

该服务只监听本机并拒绝跨来源请求，沿用原模型代理。工作台 CDN、OCR 语言数据与模型调用仍需对应网络连接；Agent 原生 PDF 翻译不需要另配 API Key。Windows 的 PowerPoint 真实打开门禁保持不变。

维护者修改项目后运行 `python tools/sync_skill.py`，同步经过测试的工作台快照和 PDF 脚本；勿把 API Key、个人配置、输入或输出文档加入 Skill。执行 `npm test` 检查前端及现有 PPTX 行为；执行 `python tests/pdf-cli.test.py` 检查 PDF 原生链路（含真实 Tesseract 英文 OCR）。PyMuPDF 按其上游许可使用。

检查证明的是文件能被所用引擎解析/渲染、抽取块被覆盖及原页视觉保留；OCR 完整性、翻译准确性、表格阅读关系仍需逐页审阅，不能据此宣称所有阅读器绝对无错误。

### 128K 上下文与多 Agent 并行

Skill 的原生 PDF 流程新增 `tools/translation_batches.py`：

```bash
python tools/translation_batches.py plan work/manifest.json --language English --context-tokens 128000 --max-output-tokens 8192 --agents 3 --work-dir work/batches
python tools/translation_batches.py status work/batches/plan.json
# 由宿主多 Agent 工具派发独立 request；各 worker 用 submit 提交独立候选。
python tools/translation_batches.py merge work/batches/plan.json --output work/translations.json
```

默认上下文 128K、单次输出预算 8192、最多 3 个并行 Agent（可设 1–8，受宿主配额限制）。规划器同时预留系统、工具、安全和术语空间，并按译文膨胀限制批次；超长原块自动按 Unicode 安全边界分片。使用保守 UTF-8 字节估算，不能替代模型的实际分词器或改变宿主的上下文/输出设置。

主 Agent 只读取调度摘要，worker 在新会话中读取各自批次、共享术语与少量相邻上下文。结果采用独立文件与原子排他提交；身份、语言、来源版本、覆盖、复核归属及分片顺序不一致会阻止合并。status 支持断点续做，完整批次不重跑。没有真实多 Agent 工具时按相同批次串行，不把脚本线程称为 Agent。

详细调度与 worker 提示见 [并行翻译流程](skills/document-translate/references/parallel-translation.md)。此分片器用于原生 PDF；CSV/PPTX 沿用工作台，可按独立文件或语言分配独立实例。执行 `python tests/translation-batches.test.py` 测试预算、Unicode、并发提交、冲突拒绝、断点恢复和严格合并。
