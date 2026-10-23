# 128K 分批与多 Agent 执行

## 预算与分工

默认 `context_tokens=128000`，系统/工具预留 16000、安全余量 16000、单次最大输出 8192，译文膨胀系数 2.5。共享术语 JSON、任务 JSON、前后邻接原文也计入输入；输入预算上限 8000。实际任务预算还会被 `(最大输出-1024)/膨胀系数` 限制，默认约 2867 个保守估算单位，留余量给输出键及 JSON。

估算单位是 UTF-8 字节数，刻意偏保守，不是厂商 token 的精确结果。计划参数不会修改宿主模型设置；在宿主中选择实际支持的上下文和最大输出，并让这些预算不超过其可用额度。不同语言、模型的分词、思考输出和工具开销不一样；先确认可用的单次输出上限，必要时调小批次。长块自动按段落、句子或词边界分片，极端长词按 Unicode 字符边界切分；分片原文拼接必须等于原块。不能因长块而截断或省略。

默认最多 3 个翻译 Agent；尊重实际并发/速率配额。429 时降为 1–2 个并发，指数退避，只重跑失败批次。只有 1 个批次时无需启动多个空闲 Agent。不要承诺固定加速倍数。

## 创建计划

先确定术语，并在任务目录写 rules.json（可选）：

```json
{
  "protected_terms": ["Digital Power", "PCS"],
  "glossary": {"构网型储能": "grid-forming energy storage"},
  "rules": ["Preserve all numbers, units, dates, product models and source claims."]
}
```

```bash
python "$SKILL_ROOT/scripts/translation_batches.py" plan work/manifest.json --language English --rules work/rules.json --work-dir work/batches --context-tokens 128000 --max-output-tokens 8192 --agents 3
python "$SKILL_ROOT/scripts/translation_batches.py" status work/batches/plan.json
```

`plan.json` 是调度索引，不含全文原文。`requests/batch-XXXX.json` 包含该批分片、统一术语、少量只读邻接上下文和分配的复核页。`results/` 只保存验证后结果。多个语言使用不同 work-dir；不要复用一个目录。

主 Agent 不要读取全部 requests 或历史回复。`status` 只返回 ID、状态、哈希、路径、页码与估算预算，按这些信息调度。超长任务可将 status 的 JSON 保存到磁盘，再用脚本筛出 pending 的前 N 条，而不是把全部清单打印到上下文。

## 主 Agent 调度

1. 检查宿主公开的多 Agent 能力，实际可用才并行。Codex 有 `spawn_agent` 时，每批用新线程且 `fork_turns="none"`；其他宿主使用其真实的子 Agent/新会话机制。不要假定每个 Skill 平台都有这一能力。
2. 按 plan.suggested_concurrency 维持最多 N 个活动翻译 Agent，每个批次只派发一个 worker。不给它整份文档或主会话历史。候选文件用 `candidates/<batch-id>-<worker-id>.json` 独立命名。
3. 把下面的 worker 提示填入路径和 ID 后派发。返回消息只包含批次 ID、状态、结果路径及简短问题。子 Agent 不回传整段译文到主会话。
4. 一个完成便派下一个 pending 批次。失败批次最多重跑两次，先确认旧 worker 已终止，不能让重复 worker 同时修改同一候选文件。
5. 主 Agent 单独承担合并和最终导出，子 Agent 不合并、不改 manifest、不生成 PDF。没有多 Agent 工具时，同一 Agent 每次只处理一批，写盘后丢弃批次正文；上下文重置后从 status 恢复。

## Worker 提示模板

> 使用 `$document-translate`。仅完成 `<batch-id>`。读取 `<request-path>`，预期请求文件 SHA-256 为 `<request-sha256>`，计划路径为 `<plan-path>`。遵循其中的共享术语、目标语言和 rules。只翻译 tasks 中的 ID，邻接上下文只作理解，不放入结果。若含 review_pages，先渲染并视觉核对整个指定原页，之后才记录指定复核值；没有视觉能力时报告阻塞，不虚构完成。不要读取全文 manifest 或其他批次，不调用外部模型 API，不修改原始文件。候选 JSON 写入 `<candidate-path>`，按下面格式填入身份字段、全部分片译文及分配的页复核。执行 submit，通过后仅返回批次 ID、完成状态和结果路径；失败只返回错误摘要。

```json
{
  "plan_id": "copy the request plan_id",
  "batch_id": "batch-0001",
  "request_sha256": "the exact hash provided by the coordinator",
  "language": "English",
  "translations": {"p1-b1__part_0001": "Translated fragment."},
  "page_reviews": {"1": "checked"}
}
```

没有分配复核页时填 `{}`。分片 ID 必须完整保留。输出长度快达到宿主上限时，停止并报告，主 Agent 用更小输出预算重建计划；不得提交截断的 JSON。可以先在本地文件逐步追加生成，再整体校验，但文件存在不等于成功。

```bash
python "$SKILL_ROOT/scripts/translation_batches.py" submit work/batches/plan.json --batch batch-0001 --candidate work/candidates/batch-0001-worker-1.json
```

submit 校验来源、身份、语言、覆盖、术语和复核归属，再原子发布独立结果。重复提交同内容是幂等；不同内容不会静默覆盖。结果冲突时主 Agent 先比较、确认旧任务停止，把需替换结果移动到单独隔离目录，再重新提交选定候选。不得移走有效结果只是为了跳过质检。

## 恢复、合并与质检

```bash
python "$SKILL_ROOT/scripts/translation_batches.py" status work/batches/plan.json
python "$SKILL_ROOT/scripts/translation_batches.py" merge work/batches/plan.json --output work/translations.json
python "$SKILL_ROOT/scripts/pdf_translate.py" validate work/manifest.json work/translations.json
python "$SKILL_ROOT/scripts/pdf_translate.py" export work/manifest.json work/translations.json --output-dir output
```

只有缺失的批次需重做；完整有效结果直接复用。来源 PDF、manifest、术语文件或请求变化会拒绝继续，先创建新计划。若修改了全局术语，应重新核验所有受影响结果，不把旧版本结果硬塞入新计划。每个原块的分片按序重组，缺片、多片、空片、跨语言结果或重复复核都会阻止合并。

主 Agent 逐批检查 glossary 的统一译法和相邻批次衔接，优先核验标题、表头、专有名词、数字和结论；只取该批原文和译文，避免最终检查时又突破 128K。自动覆盖检查不证明翻译准确，最终仍须视觉和语义核验。

## 能力边界

调度脚本准备、提交与合并文件，不自带模型账户，也不会通过线程或 subprocess 假装启动 Agent。真正的并行翻译由宿主多 Agent 工具执行。当前细粒度分片器用于原生 PDF；CSV/PPTX 通过原工作台按独立文件/语言分工，不能让多个 Agent 共用一个页面和一个输出文件。
