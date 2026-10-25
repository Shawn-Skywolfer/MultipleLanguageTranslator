# 本地工作台与 Windows

源码位于 assets/workbench。PDF 与 Skill 共用固定版本 PDFMathTranslate，CSV/PPTX 路径保持。

## 启动

使用 Node.js 20+ 与 Python 3.11/3.12：

```bash
python3.12 "$SKILL_ROOT/assets/workbench/tools/setup_pdf.py"
node "$SKILL_ROOT/scripts/start_workbench.cjs" 8765
```

或在独立本地包双击 Start-Local.cmd（Windows），macOS/Linux 运行 ./start-local.sh。首次安装联网下载依赖，首次标准排版下载 DocLayout 模型及目标字体。已缓存后复用。不是完全离线包，CDN 与模型端点仍需网络。

选择直接翻译（1 次调用）/ 校验后修订（2 次）/ 多轮校验（5 次），失败重试另计；完整 DSL 兼容旧配置（3 次）。PDF 排版另选 standard / native-fast。更换模式不会自动降低所选语义审校深度。

含图片或 OCR 页先展示原文件链接与识别文字，用户核对并勾选后继续；检查图片文字或表格标签是否遗漏，未完整识别时先停止修复。HTML 来自最终 PDF 页面渲染，Markdown/DOCX 是辅助阅读稿。浏览器端不再运行旧 PDF 覆盖模块。托管网页无法运行 Python 时明确要求使用本地版。

模型请求沿用项目现有代理与用户设置；PDF 引擎进程不接收模型 API Key。设置导出默认不含 Key。

## Windows 便携 EXE

项目 GitHub Actions 的 windows-portable.yml 在 Windows 上打包 CPython 3.12 与 PDFMathTranslate 到便携 EXE。首次模型/字体仍会下载。独立本地源码 ZIP 中含启动脚本，需预装 Node.js 和 Python。

PPTX 保留原页并追加对应译文页；真实 PowerPoint 验证需要 Windows 和 Microsoft PowerPoint。桌面导出执行打开、规范化另存、再次打开、页数和对象数检查。不要把包结构检查称作 PowerPoint 实机验证，也不关闭门禁来绕过问题。

本地运行只绑定 127.0.0.1，核验 Host/Origin。不要将本地工作台或 Python 任务接口公开到公网。
