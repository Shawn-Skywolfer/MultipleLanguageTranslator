# Digital Power 批量翻译工具

一个单文件、零构建依赖的静态网页应用，用于批量翻译 CSV 文案，并直接导出已清洗的多语言 CSV。项目核心文件是 [`index.html`](./index.html)，可直接在浏览器中打开，也可部署到任意静态站点托管平台。

## 项目亮点

- **单 HTML 文件运行**：不需要安装后端服务、数据库或前端构建工具。
- **OpenAI-compatible 接口**：默认配置 AIHubMix，也可切换到任何兼容 OpenAI Chat Completions 的 Provider。
- **模型管理**：支持连通测试、刷新模型列表、按关键字筛选模型、点击模型快速选择。
- **批量 CSV 翻译**：支持一次上传多个 CSV 文件，自动识别表头并选择原文列。
- **多语言输出**：内置常用欧洲语言，可全选、清空、选择欧洲常用语言，也可添加自定义语言。
- **两种工作流模式**：完整 DSL 模式更接近原始工作流，快速模式更适合低成本批处理。
- **两种输出结构**：宽表模式为每个目标语言新增一列；长表模式为每个目标语言生成一行。
- **自动兼容参数**：当模型不支持 `max_tokens`、`max_completion_tokens` 或 `temperature` 时，会自动调整参数并重试。
- **本地隐私控制**：API Key 默认只保存在当前页面内；只有勾选保存选项后才会写入浏览器 `localStorage`。

## 文件结构

```text
MultipleLanguageTranslator/
├── index.html   # 应用主体：页面、样式与全部前端逻辑
└── README.md    # 项目说明文档
```

## 快速开始

### 方式一：直接打开

1. 下载或克隆本仓库。
2. 使用最新版 Chrome、Edge 或其他现代浏览器打开 `index.html`。
3. 在「模型配置」中填写 Provider、Base URL、API Key 和模型 ID。
4. 点击「连通测试」确认接口可用。
5. 切换到「批量翻译」，上传 CSV，选择原文列、目标语言和输出格式。
6. 点击「开始批量翻译」，完成后下载生成的 `_clean.csv` 文件。

### 方式二：本地静态服务

如果浏览器对本地文件权限或网络请求限制较多，可在仓库目录启动任意静态服务，例如：

```bash
python3 -m http.server 8000
```

然后访问：

```text
http://localhost:8000
```

也可以使用 Node.js 生态中的静态服务器：

```bash
npx serve .
```

> 工具本身不依赖 Python 或 Node.js；这些命令仅用于本地预览。

## 模型配置

打开页面后，首先进入「1. 模型配置」。

| 字段 | 默认值/示例 | 说明 |
| --- | --- | --- |
| Provider 名称 | `AIHubMix` | 仅用于页面展示 |
| Base URL | `https://aihubmix.com/v1` | OpenAI-compatible API 根地址 |
| API Key | `sk-...` | Provider API Key；请不要带 `Bearer` 前缀、中文空格、引号或备注文字 |
| 当前模型 ID | `gpt-5.4` | 实际调用的模型 ID |
| Temperature | 留空或数字 | 留空则不传该参数 |
| Max Tokens | 留空或正整数 | 会优先使用 `max_tokens`，必要时自动切换为 `max_completion_tokens` |

### 连通测试

点击「连通测试」后，页面会向：

```text
POST {Base URL}/chat/completions
```

发送一个短请求，并在「模型/接口日志」中显示结果。

### 刷新模型列表

点击「一键刷新模型列表」后，页面会请求：

```text
GET {Base URL}/models
```

刷新成功后，可在模型列表中筛选并选择模型。

## CSV 要求

- 文件格式：`.csv`。
- 第一行必须是表头。
- 至少包含一列待翻译文本。
- 可选包含国家/地区列，用于为不同市场生成更贴近当地表达的译文。
- 建议使用 UTF-8 CSV；工具也会尝试识别 UTF-8 BOM、UTF-16LE、UTF-16BE、GB18030/GBK 等常见编码。

示例：

```csv
id,source,country
1,"Smart PV and ESS solution",Germany
2,"Residential energy storage",Spain
```

## 批量翻译流程

1. 在「上传 CSV」区域点击「上传CSV文件」，或将 CSV 拖入上传区域。
2. 在「输入列与输出方式」中选择：
   - 原文列
   - 源语言
   - 国家/地区（可选）
   - 国家/地区列（可选，优先于全局国家/地区）
   - 工作流模式
   - 输出格式
   - 并发数
   - 失败重试次数
3. 在「目标翻译语言多选」中选择目标语言。
4. 点击「开始批量翻译」。
5. 在「翻译任务结果」中下载输出文件。

## 工作流模式

| 模式 | 说明 | 模型调用次数 |
| --- | --- | --- |
| 完整 DSL | 执行“初译 → 专家建议 → 改译”，更贴近 Multilingual Translation Master 工作流 | 每行每语言约 3 次 |
| 快速模式 | 直接生成最终译文，速度更快、成本更低 | 每行每语言约 1 次 |

## 输出格式

### 宽表模式

每个目标语言新增一列，适合在原表基础上追加译文。

```csv
id,source,country,German,French
1,"Smart PV and ESS solution",Germany,"...","..."
```

### 长表模式

每个目标语言生成一行，适合导入需要“语言维度”字段的系统。

```csv
id,source,country,target_language,translation
1,"Smart PV and ESS solution",Germany,German,"..."
1,"Smart PV and ESS solution",Germany,French,"..."
```

### 文件名

翻译完成后，导出文件名格式为：

```text
原文件名_clean.csv
```

## 支持的默认目标语言

页面默认包含以下目标语言：

- German
- Spanish
- French
- Bulgarian
- Czech
- Greek
- Italian
- Dutch
- Polish
- Romanian
- Turkish
- Hungarian
- Slovakian
- Portuguese
- Croatian
- Danish
- Swedish
- Ukrainian

如果需要更多语言，可在「添加自定义语言」中输入语言名称并添加。

## API Key 与安全说明

- API Key 默认只存在于当前浏览器页面状态中。
- 只有勾选「保存 API Key 到本机浏览器 localStorage」并点击保存后，API Key 才会写入本机浏览器。
- 本项目是纯前端静态页面，请不要把填好 API Key 的页面文件分享给他人。
- 浏览器会直接请求你的 Provider，因此 Provider 必须允许网页端跨域请求（CORS）。
- 如果出现 `Failed to fetch` 或 CORS 报错，需要 Provider 开启 CORS，或通过你自己的代理服务转发请求。

## 浏览器兼容性

推荐使用：

- 最新版 Google Chrome
- 最新版 Microsoft Edge

需要浏览器支持以下能力：

- `fetch`
- `Blob`
- `FileReader`
- `TextDecoder`
- ES6+ JavaScript

## 部署

这是一个静态站点项目，部署时只需要发布仓库根目录即可。

### GitHub Pages

1. 将仓库推送到 GitHub。
2. 进入仓库 `Settings` → `Pages`。
3. Source 选择当前分支，目录选择 `/root` 或 `/`。
4. 保存后等待 GitHub Pages 构建完成。

### Cloudflare Pages / Vercel / Netlify

- 构建命令：留空。
- 输出目录：仓库根目录。
- 发布文件：至少包含 `index.html`。

## 常见问题

### 为什么连通测试失败？

常见原因包括：

- API Key 为空或复制时带了多余字符。
- Base URL 不正确。
- 模型 ID 不存在或当前账号无权限。
- Provider 不允许浏览器跨域请求。
- 当前网络无法访问 Provider。

### 为什么提示参数不支持？

不同模型对生成参数的支持不完全一致。页面已内置兼容逻辑：

- `max_tokens` 不支持时，自动尝试 `max_completion_tokens`。
- `max_completion_tokens` 不支持时，自动尝试 `max_tokens`。
- `temperature` 不支持时，自动移除该参数后重试。

### 为什么翻译成本较高？

完整 DSL 模式会对每行、每个目标语言执行多次模型调用。如果需要降低成本，可：

- 切换到快速模式。
- 减少目标语言数量。
- 降低并发数以便观察费用增长。
- 先用少量数据测试提示词和输出质量。

### 是否会上传我的 CSV 到服务器？

项目本身没有自建后端，不会把 CSV 上传到本项目服务器。但翻译请求会把待翻译文本发送给你配置的模型 Provider，请遵守对应 Provider 的隐私与数据处理政策。

## 开发说明

当前项目没有独立构建步骤，修改后可直接刷新浏览器查看效果。

建议改动流程：

```bash
git status
python3 -m http.server 8000
```

在浏览器打开 `http://localhost:8000` 验证页面。

## 许可证

仓库当前未声明开源许可证。如需对外分发或商业使用，请先补充明确的 LICENSE 文件。
