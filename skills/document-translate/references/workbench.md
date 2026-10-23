# 工作台与 Windows 验证

捆绑位置：`assets/workbench/`，来源 `Shawn-Skywolfer/MultipleLanguageTranslator`。快照的 commit 和增强说明见同目录 `SOURCE.json`。工作台是功能快照，运行不需实时克隆 GitHub；后续更新由维护者同步，不在任务中偷偷拉取新代码。

## 工作台

1. 用 `node scripts/start_workbench.cjs 8765` 启动，服务只绑定 `127.0.0.1`。
2. 打开本地地址；右上角设置导入现有配置，或者配置自己的模型服务。API Key 默认不导出。
3. PDF / PPTX 在文档翻译页上传；CSV 在批量翻译页上传。English 为默认第一目标语言。
4. 选择输出、术语及翻译记忆，运行任务并检查逐文件结果和日志。
5. 只有完整性检查通过的结果可交付。PDF 默认勾选“导出原位对照 PDF（白底黑字覆盖原文）”，每张原页只增加一张对应原位译文页；HTML 也为相同原图背景上的位置覆盖对照。Markdown、DOCX 仍作为文字审阅输出。

工作台 UI/模型/OCR 依赖原项目的 CDN 与用户的模型端点。捆绑源码可本地运行，不等于所有网络依赖已离线打包。OCR 图表中的表格关系须视觉核对，工作台会扫描含图片的混排页并保留原生文字；OCR 不能证明识别完整。需要逐页审阅记录和原生矢量译文输出时，使用原生 PDF CLI 的 `--ocr auto` 并逐页核对。

## Windows 便携版

在 Windows 的 `assets/workbench` 目录执行：

```bash
npm install --no-audit --no-fund
npm test
npm run dist:win
```

产物为 `dist/*.exe`。本机安装 Microsoft PowerPoint 后，桌面导出执行真实打开、规范化另存、再次打开，以及页数与对象数检查。只有这些步骤实际成功，才可以报告真实 PowerPoint 验证通过。Linux/macOS 或纯网页不能替代该测试。不要关闭这一门禁、删除 SmartArt 或改写非叶子 OOXML 节点来绕过错误。

所有可编辑标题自动换行，段落统一 1 倍行距；沿用项目原有规则。工作台的 PPTX 路径保留原页并插入对应译文页，不把 PDF 伪装为可编辑 PPTX。
