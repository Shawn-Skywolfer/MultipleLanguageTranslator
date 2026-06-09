(() => {
  'use strict';

  const STORAGE_KEY = 'digitalPowerUiLanguage';
  const DEFAULT_LANGUAGE = 'zh-CN';
  const supportedLanguages = new Set(['zh-CN', 'en']);
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();

  const english = {
    'Digital Power 多格式翻译工作台': 'Digital Power Multi-format Translation Workbench',
    '统一处理 `CSV`、`PDF` 和 `PPTX`。CSV 继续保留原有批量翻译能力；PDF 支持文字抽取与 OCR 回退并导出双语 Markdown / DOCX；PPTX 保留原始页，并在每页后新增一页对应的高亮译文页。模型调用统一走站内 API 代理，适合 Vercel 一键部署。': 'Translate CSV, PDF, and PPTX files in one place. CSV supports batch translation; PDF supports text extraction, OCR fallback, and bilingual Markdown/DOCX exports; PPTX preserves each original slide and adds a highlighted translated slide after it. Model requests use the built-in API proxy for easy Vercel deployment.',
    'CSV 批量翻译': 'CSV Batch Translation', 'PDF 文本抽取 + OCR': 'PDF Text Extraction + OCR',
    '双语 Markdown / DOCX': 'Bilingual Markdown / DOCX', 'PPTX 逐页译文页': 'PPTX Translated Slides', 'Vercel 友好': 'Vercel Ready',
    '页面访问量（PV）': 'Page Views (PV)', '已上传文件': 'Files Uploaded', '已生成输出': 'Outputs Generated', '失败 / 警告': 'Errors / Warnings',
    '1. 模型配置': '1. Model Settings', '2. CSV 批量翻译': '2. CSV Translation', '3. 文档翻译': '3. Document Translation',
    'Provider 与模型配置': 'Provider & Model Settings',
    '浏览器只请求当前站点的 `/api/chat-completions` 和 `/api/models`，再由 Vercel Functions 转发到你配置的 Provider，因此不依赖浏览器直连 CORS。': 'The browser only calls this site’s `/api/chat-completions` and `/api/models` endpoints. Vercel Functions forward requests to your configured provider, avoiding browser-side CORS restrictions.',
    'Provider 名称': 'Provider Name', '当前模型 ID': 'Current Model ID', 'Temperature（留空则不传）': 'Temperature (leave blank to omit)', 'Max Tokens（自动兼容）': 'Max Tokens (auto-compatible)',
    '连通测试': 'Test Connection', '刷新模型列表': 'Refresh Models', '保存配置到本机': 'Save Settings Locally', '清除本机保存': 'Clear Saved Settings',
    '常用 Provider 快速配置': 'Provider Presets', '只填充 Provider 名称、Base URL、模型 ID 和候选模型列表，不覆盖 API Key。': 'Fills in the provider name, Base URL, model ID, and candidate model list without replacing your API key.',
    '保存 API Key 到本机浏览器 localStorage': 'Save API key in browser localStorage',
    '当前实现默认走站内代理，更适合直接部署到 Vercel。部署后只需填写你的 Provider 参数即可开始翻译。': 'Requests use the built-in proxy by default for easy Vercel deployment. After deployment, enter your provider settings to start translating.',
    '模型关键字筛选': 'Filter Models', '模型 / 接口日志': 'Model / API Log', '导出操作日志': 'Export Activity Log', '清空操作日志': 'Clear Activity Log', '准备就绪。': 'Ready.',
    '上传 CSV': 'Upload CSV', '上传一个或多个 CSV 文件，自动识别表头并按共享的目标语言、术语规则和标准翻译库执行批量翻译。': 'Upload one or more CSV files. Headers are detected automatically, and shared target languages, terminology rules, and translation memory are applied.',
    '清空': 'Clear', '也可以把 CSV 文件拖到这里': 'You can also drop CSV files here', '尚未上传 CSV。': 'No CSV files uploaded.', 'CSV 翻译参数': 'CSV Translation Settings',
    '原文列': 'Source Column', '先上传 CSV': 'Upload a CSV first', '源语言': 'Source Language', '国家 / 地区（可选，全局）': 'Country / Region (optional, global)', '国家 / 地区列（可选，优先于全局）': 'Country / Region Column (optional, takes priority)', '不使用列': 'Do not use a column',
    '工作流模式': 'Workflow Mode', '完整 DSL：初译 + 建议 + 改译': 'Full DSL: Draft + Review + Revision', '快速模式：直接最终翻译': 'Fast Mode: Direct Final Translation',
    '输出格式': 'Output Format', '宽表：每个目标语言新增一列': 'Wide: Add one column per target language', '长表：每个目标语言生成一行': 'Long: Add one row per target language', '并发数': 'Concurrency', '失败重试次数': 'Retry Attempts',
    '开始批量翻译': 'Start Batch Translation', '停止': 'Stop', '尚未开始。': 'Not started.', 'CSV 翻译结果': 'CSV Translation Results',
    '文件': 'File', '状态': 'Status', '任务数': 'Tasks', '说明': 'Details', '下载': 'Download', '还没有 CSV 翻译结果。': 'No CSV translation results yet.',
    '上传文档': 'Upload Documents', '支持 `PDF` 和 `PPTX`。PDF 会优先做文字抽取，文本不足时自动回退到 OCR；PPTX 会保留原始页，并在每页后新增对应的高亮译文页。': 'Supports PDF and PPTX. PDFs use text extraction first and automatically fall back to OCR when needed. PPTX files preserve each original slide and add a highlighted translated slide after it.',
    '上传 PDF / PPTX': 'Upload PDF / PPTX', '也可以把 PDF 或 PPTX 文件拖到这里': 'You can also drop PDF or PPTX files here', '尚未上传文档。': 'No documents uploaded.', '文档翻译参数': 'Document Translation Settings',
    '导出双语 Markdown（仅 PDF）': 'Export Bilingual Markdown (PDF only)', '导出双语 DOCX（仅 PDF）': 'Export Bilingual DOCX (PDF only)',
    'PPTX 会输出“原始页保留 + 每页后新增 1 页译文页”的翻译版 PPTX。译文页会直接复用原始幻灯片中的图片、图形元素和文本框位置，只替换对应文本框文字，并用黄色底色、黑色文字高亮。': 'The translated PPTX preserves every original slide and adds one translated slide after it. Translated slides reuse the original images, shapes, and text-box positions, replacing only the text and highlighting it with a yellow background and black type.',
    '开始文档翻译': 'Start Document Translation', '文档翻译结果': 'Document Translation Results', '语言': 'Language', '类型': 'Type', '还没有文档翻译结果。': 'No document translation results yet.',
    '共享翻译规则与目标语言': 'Shared Translation Rules & Target Languages', '标准翻译库（可选）': 'Translation Memory (optional)', '上传标准翻译 CSV': 'Upload Translation Memory CSV', '清空标准库': 'Clear Translation Memory',
    '命中标准译文时': 'When a Translation Memory Match Is Found', '直接使用标准译文（不调用模型）': 'Use the saved translation directly (no model call)', '仍调用完整 DSL 评审': 'Run the full DSL review',
    '尚未上传标准翻译库。支持窄表：source/source_text/原文 + target_lang/language + translation/target_text/标准译文；也支持宽表：source + German/French/Chinese 等语言列。': 'No translation memory uploaded. Narrow format is supported: source/source_text/原文 + target_lang/language + translation/target_text/标准译文. Wide format is also supported: source + language columns such as German/French/Chinese.',
    '术语保护与自定义规则（可选）': 'Protected Terms & Custom Rules (optional)', '受保护术语（一行一个）': 'Protected Terms (one per line)', '命中源文时，要求译文保留完全一致的大小写、空格、连字符、型号和商标。': 'When found in the source, the translation must preserve the exact capitalization, spacing, hyphens, model numbers, and trademarks.',
    '自定义规则': 'Custom Rules', '支持自由文本，会原样传入模型。': 'Free-form text is supported and passed to the model as entered.', '上传术语 CSV': 'Upload Terminology CSV', '清空规则': 'Clear Rules',
    '可选上传术语 CSV：优先读取 term/protected_term/术语/词条列；未找到时读取第一列非空值并追加到受保护术语。': 'Optionally upload a terminology CSV. The term/protected_term/术语/词条 column is preferred; otherwise, non-empty values from the first column are appended to protected terms.',
    '目标翻译语言多选': 'Target Languages', '全选': 'Select All', '清空语言': 'Clear Languages', '选择欧洲常用语言': 'Select Common European Languages', '添加自定义语言': 'Add a Custom Language', '添加': 'Add',
    '成功': 'Success', '失败': 'Failed', '无': 'None', '进度：': 'Progress: ', '界面语言': 'Interface language'
  };

  const attributeTranslations = {
    '请粘贴 Key 本身；不要带 Bearer、中文空格、换行或备注文字': 'Paste the key only; do not include Bearer, spaces, line breaks, or notes',
    '输入 gpt / claude / gemini / deepseek / qwen 等': 'Enter gpt / claude / gemini / deepseek / qwen, etc.',
    '例如 Germany / Spain / France': 'For example: Germany / Spain / France',
    '例如：\nDigital Power\nESS\nSmart PV\nSUN2000-10KTL-M1': 'For example:\nDigital Power\nESS\nSmart PV\nSUN2000-10KTL-M1',
    '例如：\nDigital Power 不翻译\nESS 保持英文缩写\n产品型号不得增删字符': 'For example:\nDo not translate Digital Power\nKeep ESS as an English abbreviation\nDo not add or remove characters in product model numbers',
    '例如 Japanese / Arabic / Swedish': 'For example: Japanese / Arabic / Swedish'
  };

  const patterns = [
    [/^已载入 (\d+) 个 CSV：(.+)$/, 'Loaded $1 CSV file(s): $2'],
    [/^已载入 (\d+) 个文档：(.+)$/, 'Loaded $1 document(s): $2'],
    [/^进度：(\d+)\/(\d+) \((\d+)%\)$/, 'Progress: $1/$2 ($3%)'],
    [/^正在读取 (.+)\.\.\.$/, 'Reading $1...'],
    [/^开始文档翻译\.\.\.$/, 'Starting document translation...'],
    [/^开始批量翻译\.\.\.$/, 'Starting batch translation...'],
    [/^已停止。$/, 'Stopped.'], [/^文档翻译结束。/, 'Document translation complete.'], [/^批量翻译结束。/, 'Batch translation complete.'],
    [/^读取表头失败：(.+)$/, 'Failed to read headers: $1'], [/^失败：(.+)$/, 'Failed: $1'],
    [/^页面访问记录：PV=(\d+)$/, 'Page view recorded: PV=$1'],
    [/^已保存配置到本机浏览器。(.+)$/, 'Settings saved in this browser. $1'],
    [/^已清除本机保存的配置。$/, 'Saved local settings have been cleared.'],
    [/^收到停止指令；正在等待当前请求结束。$/, 'Stop requested; waiting for the current request to finish.'],
    [/^已清空标准翻译库。$/, 'Translation memory cleared.']
  ];

  function normalizeLanguage(language) {
    return supportedLanguages.has(language) ? language : DEFAULT_LANGUAGE;
  }

  function translate(source) {
    if (english[source]) return english[source];
    for (const [pattern, replacement] of patterns) {
      if (pattern.test(source)) return source.replace(pattern, replacement);
    }
    return source;
  }

  function translateTextNode(node, language) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const source = originalText.get(node);
    if (!source || !source.trim()) return;
    if (language === DEFAULT_LANGUAGE) {
      node.nodeValue = source;
      return;
    }
    const leading = source.match(/^\s*/)[0];
    const trailing = source.match(/\s*$/)[0];
    node.nodeValue = leading + translate(source.trim()) + trailing;
  }

  function translateElementAttributes(element, language) {
    if (!(element instanceof Element)) return;
    const attributes = ['placeholder', 'title', 'aria-label'];
    let stored = originalAttributes.get(element);
    if (!stored) {
      stored = {};
      originalAttributes.set(element, stored);
    }
    attributes.forEach(attribute => {
      if (!element.hasAttribute(attribute)) return;
      if (!(attribute in stored)) stored[attribute] = element.getAttribute(attribute);
      const source = stored[attribute];
      element.setAttribute(attribute, language === DEFAULT_LANGUAGE ? source : (attributeTranslations[source] || translate(source)));
    });
  }

  function apply(root = document) {
    const language = I18n.language;
    if (root.nodeType === Node.TEXT_NODE) translateTextNode(root, language);
    if (root.nodeType === Node.ELEMENT_NODE) translateElementAttributes(root, language);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) translateTextNode(node, language);
      else translateElementAttributes(node, language);
    }
    document.documentElement.lang = language;
    document.title = language === 'en' ? english['Digital Power 多格式翻译工作台'] : 'Digital Power 多格式翻译工作台';
    document.querySelectorAll('[data-language]').forEach(button => {
      const active = button.dataset.language === language;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setLanguage(language) {
    I18n.language = normalizeLanguage(language);
    localStorage.setItem(STORAGE_KEY, I18n.language);
    apply();
  }

  const savedLanguage = localStorage.getItem(STORAGE_KEY);
  const I18n = window.I18n = {
    language: normalizeLanguage(savedLanguage || DEFAULT_LANGUAGE),
    setLanguage,
    apply,
    text: source => I18n.language === 'en' ? translate(source) : source,
    attribute: source => I18n.language === 'en' ? (attributeTranslations[source] || translate(source)) : source
  };

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-language]').forEach(button => {
      button.addEventListener('click', () => setLanguage(button.dataset.language));
    });
    apply();
    const observer = new MutationObserver(mutations => {
      if (I18n.language !== 'en') return;
      mutations.forEach(mutation => mutation.addedNodes.forEach(node => apply(node)));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
