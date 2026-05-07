一个完全单文件、无安装包依赖的本地/静态网页应用，用于把 Dify 多语言翻译 DSL 工作流转换为可批处理的前端工具，并将批量翻译输出直接生成为已清洗的 CSV 文件。

应用支持：

- 批量导入 CSV
- 目标翻译语言多选
- AIHubMix / OpenAI-compatible Provider 配置
- 连通测试
- 一键刷新模型列表
- 关键字筛选模型
- 批量翻译后直接输出 clean CSV
- 旧版 Dify `result.csv` 清洗
- Edge / Chrome 文件夹模式下自动创建 `Cleaned` 与 `Processed` 文件夹

---

## 目录

- [功能概览](#功能概览)
- [文件结构](#文件结构)
- [本地使用](#本地使用)
- [模型 Provider 配置](#模型-provider-配置)
- [批量翻译使用流程](#批量翻译使用流程)
- [输出格式说明](#输出格式说明)
- [旧版 Dify result.csv 清洗](#旧版-dify-resultcsv-清洗)
- [部署到 Vercel](#部署到-vercel)
- [部署到 Cloudflare Pages](#部署到-cloudflare-pages)
- [安全说明](#安全说明)
- [常见问题](#常见问题)
- [浏览器兼容性](#浏览器兼容性)
- [版本变更记录](#版本变更记录)

---

## 功能概览

### 1. Dify DSL 工作流一体化

本工具内置了从 Dify DSL 工作流提取出的核心翻译链路：

```text
输入原文
  ↓
初译
  ↓
根据 country 是否为空选择专家建议 Prompt
  ↓
基于专家建议进行改译
  ↓
输出纯文本翻译结果
```

页面中提供两种工作流模式：

| 模式 | 说明 | 模型调用次数 |
|---|---|---|
| 完整 DSL 模式 | 初译 + 专家建议 + 改译，更接近原 Dify 工作流 | 每行 / 每语言 3 次 |
| 快速模式 | 直接生成最终译文，速度更快、成本更低 | 每行 / 每语言 1 次 |

---

### 2. 批量翻译与清洗融合

批量翻译输出结果会自动清洗，不再输出类似下面的 JSON 包装：

```json
{"output":"Für Privathaushalte\n\nIntelligente Photovoltaik- und ESS-Lösung"}
```

而是直接写入纯文本：

```text
Für Privathaushalte

Intelligente Photovoltaik- und ESS-Lösung
```

输出文件名默认类似：

```text
原文件名_translated_clean.csv
```

---

### 3. 多语言批量输出

支持目标翻译语言多选，例如：

- English
- German
- French
- Spanish
- Italian
- Portuguese
- Dutch
- Polish
- Turkish
- Arabic
- Japanese
- Korean

也支持手动添加自定义目标语言。

---

### 4. AIHubMix / OpenAI-compatible Provider

默认 Provider 为：

```text
AIHubMix
```

默认 Base URL 为：

```text
https://aihubmix.com/v1
```

也可以配置任何兼容 OpenAI Chat Completions 接口的 Provider。

支持：

- API Key 配置
- 模型 ID 手动填写
- 连通测试
- 一键刷新模型列表
- 模型关键字筛选
- 点击模型列表快速选择模型
- `max_tokens` / `max_completion_tokens` 自动兼容
- 不支持 `temperature` 的模型自动移除参数后重试

---

## 文件结构

如果你使用的是部署包，推荐结构如下：

```text
dify-translator-cleaner-deploy/
├─ index.html
├─ README.md
├─ package.json
├─ vercel.json
└─ wrangler.toml
```

如果只本地使用，只需要：

```text
index.html
```

---

## 本地使用

### 方式一：直接双击打开

1. 下载或复制 `index.html`
2. 双击打开
3. 建议使用最新版 Microsoft Edge 或 Google Chrome
4. 在页面中配置 Provider、模型和 API Key
5. 上传 CSV 并开始批量翻译

### 方式二：本地静态服务打开

如果浏览器对本地文件权限限制较多，可以使用任意静态服务。

例如使用 Node.js：

```powershell
npx serve .
```

然后访问终端中显示的本地地址。

> 注意：工具本身不依赖 Node.js。Node.js 只是在你想用本地静态服务或部署 CLI 时才需要。

---

## 模型 Provider 配置

进入「模型配置」页面，填写以下信息：

| 字段 | 示例 | 说明 |
|---|---|---|
| Provider 名称 | AIHubMix | 仅用于页面展示 |
| Base URL | `https://aihubmix.com/v1` | OpenAI-compatible API 地址 |
| API Key | `sk-...` | 你的 Provider API Key |
| 当前模型 ID | `gpt-4o-mini` / 其他模型 | 实际调用的模型 |
| Temperature | `0.2` | 可留空，留空则不传 |
| Max Tokens | `4096` | 可留空，工具会自动兼容参数名 |

### 连通测试

点击：

```text
连通测试
```

工具会调用当前模型发送一个简短请求。

成功时会显示模型返回内容。

失败时会在日志窗口中显示错误信息。

### 刷新模型列表

点击：

```text
一键刷新模型列表
```

工具会请求：

```text
GET {Base URL}/models
```

然后把返回的模型展示在列表中。

你可以使用关键字筛选模型，并点击目标模型自动填入「当前模型 ID」。

---

## 批量翻译使用流程

### 1. 选择 CSV

支持两种方式：

#### 多文件模式

点击：

```text
选择多个 CSV
```

适合所有现代浏览器。

#### 文件夹模式

点击：

```text
选择文件夹
```

适合 Microsoft Edge / Google Chrome。

文件夹模式下，工具可以在你授权后自动创建：

```text
Cleaned/
Processed/
```

并将处理后的输出写入 `Cleaned`，将原始文件移动到 `Processed`。

---

### 2. 选择原文列

在「原文列」下拉框中选择需要翻译的 CSV 列。

例如：

```text
source_text
```

或：

```text
原文
```

---

### 3. 设置源语言

填写源语言，例如：

```text
Chinese
```

或：

```text
中文
```

---

### 4. 设置国家 / 地区

可以填写全局国家 / 地区，例如：

```text
Germany
```

也可以选择 CSV 中的一列作为国家 / 地区列。

如果同时设置了：

- 全局国家 / 地区
- 国家 / 地区列

则优先使用 CSV 行内的国家 / 地区列。

---

### 5. 选择目标语言

勾选一个或多个目标语言。

也可以在「添加自定义语言」中输入新语言，然后点击「添加」。

---

### 6. 设置工作流模式

| 模式 | 推荐场景 |
|---|---|
| 完整 DSL 模式 | 对翻译质量要求高、希望接近原 Dify 工作流 |
| 快速模式 | 大批量、追求速度和成本控制 |

---

### 7. 设置输出格式

| 输出格式 | 说明 |
|---|---|
| 宽表 | 每个目标语言新增一列 |
| 长表 | 每个目标语言生成一行 |

#### 宽表示例

```text
id,source_text,German,French,Spanish
1,你好,Hallo,Bonjour,Hola
```

#### 长表示例

```text
id,source_text,target_lang,translation
1,你好,German,Hallo
1,你好,French,Bonjour
1,你好,Spanish,Hola
```

---

### 8. 设置并发与重试

| 字段 | 说明 |
|---|---|
| 并发数 | 同时处理的翻译任务数 |
| 失败重试次数 | 单个任务失败后的自动重试次数 |

建议：

```text
并发数：2
失败重试次数：1 或 2
```

如果 Provider 限流明显，可以把并发数调低。

---

### 9. 开始批量翻译

点击：

```text
开始批量翻译
```

任务执行时可以在日志窗口查看进度。

完成后可以点击：

```text
下载全部结果
```

---

## 输出格式说明

### 输出文件命名

批量翻译后的文件默认命名为：

```text
原文件名_translated_clean.csv
```

例如：

```text
input.csv
```

输出为：

```text
input_translated_clean.csv
```

### 编码

输出 CSV 使用：

```text
UTF-8 with BOM
```

这样更适合直接用 Microsoft Excel 打开，避免中文乱码。

---

## 旧版 Dify result.csv 清洗

如果你已经从 Dify Web App 下载了旧版 `result.csv`，其中「生成结果」列类似：

```json
{"output":"翻译文本"}
```

可以使用页面中的：

```text
Dify result.csv 批量清洗
```

默认配置：

| 字段 | 默认值 |
|---|---|
| 清洗列名 | 生成结果 |
| JSON 字段名 | output |

清洗后会输出：

```text
原文件名_clean.csv
```

---

## 部署到 Vercel

Vercel CLI 可以从项目根目录执行部署，`vercel` 命令本身就是部署命令，也可以使用 `--prod` 发布生产环境。

### 步骤

进入项目目录：

```powershell
cd dify-translator-cleaner-deploy
```

登录 Vercel：

```powershell
npx vercel login
```

部署到生产环境：

```powershell
npx vercel --prod
```

部署成功后，终端会返回公网访问地址，例如：

```text
https://your-project.vercel.app
```

---

## 部署到 Cloudflare Pages

Cloudflare Wrangler 支持将静态目录部署为 Pages 项目。

### 步骤

进入项目目录：

```powershell
cd dify-translator-cleaner-deploy
```

登录 Cloudflare：

```powershell
npx wrangler login
```

部署当前目录：

```powershell
npx wrangler pages deploy . --project-name dify-translator-cleaner
```

部署成功后，终端会返回公网访问地址，例如：

```text
https://dify-translator-cleaner.pages.dev
```

---

## 安全说明

### API Key 不要写死进 HTML

不要把 API Key 直接写入 `index.html` 后发布到公网。

否则任何访问该页面的人都有可能看到或滥用你的 Key。

### API Key 的保存方式

页面支持两种方式：

| 方式 | 说明 |
|---|---|
| 不保存 | API Key 只保存在当前页面内存中，刷新后消失 |
| 保存到本机浏览器 | 勾选后写入当前浏览器的 `localStorage` |

如果部署到公网，建议让每个使用者输入自己的 API Key。

### CORS 限制

这是纯前端静态网页。

如果 Provider 不允许浏览器跨域请求，连通测试会报：

```text
Failed to fetch
```

或：

```text
CORS
```

这种情况下，静态网页无法绕过浏览器安全策略。解决方式包括：

1. 让 Provider 开启 CORS
2. 使用支持浏览器直连的 Provider
3. 自建轻量 API 代理
4. 改造成带后端的版本

---

## 常见问题

### 1. 连通测试报 `max_tokens is not supported`

示例：

```text
Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.
```

工具已经内置自动兼容逻辑：

```text
max_tokens → max_completion_tokens
```

遇到该错误会自动重试。

---

### 2. 连通测试报 `max_completion_tokens is not supported`

某些旧模型或 Provider 可能只支持：

```text
max_tokens
```

工具会自动切回 `max_tokens` 后重试。

---

### 3. 连通测试报 `temperature is not supported`

部分模型不支持自定义 temperature。

工具会自动移除 `temperature` 参数后重试。

---

### 4. 连通测试报 `401 Unauthorized`

通常原因：

- API Key 错误
- API Key 没有权限
- Provider 配置错误

请检查：

```text
Base URL
API Key
模型 ID
```

---

### 5. 连通测试报 `404 Not Found`

通常原因：

- Base URL 填错
- Provider 不是 OpenAI-compatible API
- 模型 ID 不存在

AIHubMix 一般使用：

```text
https://aihubmix.com/v1
```

---

### 6. 报 `Failed to fetch` 或 `CORS`

这通常不是代码错误，而是 Provider 不允许浏览器网页直接访问。

解决方式见上方「CORS 限制」。

---

### 7. CSV 打开乱码

输出文件已经使用 UTF-8 with BOM。

如果仍乱码，请尝试：

1. 用 Excel 的「数据 → 从文本/CSV」导入
2. 编码选择 UTF-8
3. 或用 WPS / LibreOffice 打开

---

### 8. 文件夹模式不可用

文件夹模式依赖浏览器的 File System Access API。

建议使用：

```text
Microsoft Edge
Google Chrome
```

如果浏览器不支持，请使用「选择多个 CSV」模式。

---

### 9. 日志内容太长导致页面变形

新版已经处理：

- 日志窗口内自动换行
- 长字符串不会撑宽布局
- 卡片区域不会互相挤压

---

### 10. 翻译速度慢

完整 DSL 模式每行每语言会调用模型 3 次。

例如：

```text
100 行 × 5 种语言 × 3 次调用 = 1500 次模型调用
```

如果追求速度，可以：

1. 改用快速模式
2. 减少目标语言数量
3. 适当提高并发数
4. 选择速度更快的模型

---

## 浏览器兼容性

| 功能 | Edge / Chrome | Firefox | Safari |
|---|---:|---:|---:|
| 多 CSV 上传 | 支持 | 支持 | 支持 |
| 批量下载 clean CSV | 支持 | 支持 | 支持 |
| 文件夹模式 | 支持 | 不支持或有限支持 | 不支持或有限支持 |
| 自动创建 Cleaned / Processed | 支持 | 不支持 | 不支持 |
| Provider API 浏览器直连 | 取决于 Provider CORS | 取决于 Provider CORS | 取决于 Provider CORS |

---

## 版本变更记录

### v4

- 批量翻译与清洗融合
- 翻译输出直接生成为 clean CSV
- 输出文件名改为 `_translated_clean.csv`
- 保留旧 Dify `result.csv` 清洗作为辅助功能

### v3

- 修复长模型 / 接口日志撑宽页面布局的问题
- 日志窗口支持长文本自动换行
- 增强卡片和 Grid 布局稳定性

### v2

- 增加 `max_tokens` / `max_completion_tokens` 自动兼容
- 增加不支持 `temperature` 时自动移除重试

### v1

- 单文件 HTML 应用
- 批量 CSV 选择
- Dify DSL 工作流前端化
- 目标语言多选
- Provider 配置
- 模型连通测试
- 模型列表刷新与筛选
- 旧 CSV 清洗

---

## 许可证与使用范围

本工具为内部营销翻译与批处理效率工具示例，可按团队需要修改和部署。

如部署到公网，请务必不要内置任何私人 API Key。
