---
name: multilingual-translator
description: Translate CSV files, product copy, UI strings, marketing text, and terminology into multiple target languages using an OpenAI-compatible LLM provider or careful human-quality translation workflow. Use this skill whenever the user asks for multilingual translation, batch CSV translation, localizing copy for specific countries/regions, cleaning JSON-wrapped translation outputs, choosing provider settings for AIHubMix, 智谱 BigModel, Kimi Code, OpenAI-compatible APIs, or generating wide/long multilingual CSV deliverables for Claude Code, OpenCode, or Codex workflows.
---

# Multilingual Translator

Create reliable multilingual translation deliverables from CSV or text inputs. Prefer the bundled CLI for repeatable CSV work; use the workflow instructions for prompt-only or agent-managed translation tasks.

## Quick decision

- For a CSV file or many strings, run `scripts/translate_csv.py` from this skill.
- For a small text snippet, translate directly with the workflow below and return a concise table.
- For provider setup problems, read `references/provider-config.md`.
- For terminology, brand voice, or country-specific copy, ask for or infer a glossary and locale notes before translating.

## CSV workflow

1. Inspect the CSV header and identify the source text column. Prefer columns named `source_text`, `source text`, `source`, `text`, `content`, `原文`, `待翻译文本`, `英文`, or `中文`.
2. Confirm target languages and output format if they are ambiguous:
   - `wide`: original row plus one column per target language.
   - `long`: one row per source row and target language, with `target_language` and `translation` columns.
3. Use the CLI for deterministic processing:

```bash
python skills/multilingual-translator/scripts/translate_csv.py \
  --input input.csv \
  --output output_clean.csv \
  --source-column source \
  --source-language English \
  --target-languages German,French,Spanish \
  --provider-base-url https://open.bigmodel.cn/api/paas/v4 \
  --model glm-5.1 \
  --api-key-env BIGMODEL_API_KEY \
  --output-mode wide \
  --mode fast
```

4. Use `--dry-run` when validating column names, encoding, output shape, or repository tests without calling a Provider.
5. Do not write API keys into files or command history in examples. Prefer environment variables via `--api-key-env`.

## Translation workflow

Use `fast` mode when cost or speed matters. Use `full` mode when quality matters for customer-facing content.

### Fast mode

Prompt the model as an expert linguist. Ask for only the final translation, with no explanation or surrounding quotes.

### Full mode

For each source text and target language:

1. Initial translation: produce a direct target-language translation.
2. Expert suggestions: critique accuracy, fluency, style, terminology, and locale fit. Include the country/region if provided.
3. Improved translation: rewrite the translation using the suggestions. Output only the final translation.

## Quality rules

- Preserve product names, placeholders, variables, HTML tags, Markdown links, SKU codes, and numbers unless the user asks to localize them.
- Keep CSV structure valid and emit UTF-8 with BOM when producing files for spreadsheet users.
- Prefer natural target-language wording over literal translation.
- If a country/region is supplied, adapt vocabulary, tone, punctuation, and formality to that locale.
- Keep translated cells plain text; do not wrap them in JSON unless the user explicitly requests JSON.
- If source text is empty, keep the target translation empty.
- Flag ambiguous source strings rather than inventing missing context.

## Provider defaults

Use these known OpenAI-compatible defaults unless the user supplies different values:

| Provider | Base URL | Default model |
| --- | --- | --- |
| AIHubMix | `https://aihubmix.com/v1` | `gpt-5.4` |
| 智谱 BigModel | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.1` |
| Kimi Code | `https://api.kimi.com/coding/v1` | `kimi-for-coding` |

The CLI normalizes `https://api.kimi.com/coding` to `https://api.kimi.com/coding/v1` before calling `/chat/completions`.

## Deliverable checklist

Before finishing:

- Verify the output row count and headers match the selected `wide` or `long` format.
- Spot-check at least one non-empty translation per target language.
- Mention the exact command used, with API keys redacted or referenced by environment variable.
- Report any provider/network/CORS limitation separately from translation quality problems.
