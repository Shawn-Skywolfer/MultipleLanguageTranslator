# Digital Power 文档翻译工作台

一个适合直接部署到 Vercel 的前端 + Serverless Functions 小工具，用于：

- `PDF` 文档翻译：支持文字型 PDF 与图片型 PDF
- 输出每个目标语言独立下载的双语 `Markdown` 与双语 `DOCX`
- `PPTX` 审校稿生成：输出“原始内容 + 原文 / 译文并排审校栏”的双语审校版 `PPTX`
- 继续沿用三轮翻译审校工作流：`初译 -> 建议 -> 改译`
- 支持标准翻译库、术语保护、自定义规则和多目标语言

## 项目结构

```text
/workspace
├── api/
│   ├── chat-completions.js   # Vercel Function，代理模型 chat/completions
│   └── models.js             # Vercel Function，代理模型列表
├── app.js                    # 前端主逻辑：PDF/PPTX 解析、OCR、翻译编排、导出
├── index.html                # 前端页面
└── README.md
```

## 当前实现

### 第一阶段

- 支持 `PDF`
- 文字型 PDF：直接抽取文本块
- 图片型 PDF：当文本不足时自动回退到 `Tesseract.js` OCR
- 输出：
  - 双语 `Markdown`
  - 双语 `DOCX`
- 每个目标语言单独导出一个文件

### 第二阶段

- 支持 `PPTX`
- 解析幻灯片中的文本框与图片
- 输出双语审校版 `PPTX`
- 审校版布局：
  - 左侧保留原始幻灯片里的文本与图片
  - 右侧增加“原文框 + 译文框”并排审校栏
- 每个目标语言单独导出一个文件

## 运行方式

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

1. 在“模型配置”中填写 Provider、Base URL、API Key 和模型 ID。
2. 点击“连通测试”确认当前模型可用。
3. 进入“文档翻译”页，上传 PDF 或 PPTX。
4. 选择源语言、工作流模式、并发数、重试次数。
5. 可选上传标准翻译库、术语 CSV，或填写自定义规则。
6. 选择目标语言。
7. 点击“开始文档翻译”。
8. 在结果表格中分别下载各目标语言输出件。

## 说明与限制

- PDF 输出优先强调“原文 / 译文对应关系”和审校效率，不追求版面保真。
- PPTX 审校版会重建图片和文本框，并在右侧生成双语审校栏；复杂母版、矢量形状、动画和特殊排版不保证完全还原。
- OCR 通过浏览器端 `Tesseract.js` 执行，首次加载语言包会较慢。
- 模型调用经站内 `/api/*` 代理转发，适合部署到 Vercel 后使用。
- 对超大 PDF、超多页 PPTX、多语言高并发任务，浏览器端处理时间会明显增加。

## 后续可继续增强

- PDF 页面截图 + 块编号审校包
- 更精细的 PPTX 样式保留
- 文档任务缓存与断点续跑
- 可视化块级翻译预览
