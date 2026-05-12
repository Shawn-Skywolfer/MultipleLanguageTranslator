#!/usr/bin/env python3
"""Translate CSV rows with an OpenAI-compatible Chat Completions provider.

The script intentionally uses only Python standard-library modules so it can run
inside Claude Code, OpenCode, Codex, CI, or a locked-down user workstation.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, Iterable, List, Optional

COMMON_SOURCE_COLUMNS = [
    "source_text",
    "source text",
    "source",
    "text",
    "content",
    "原文",
    "待翻译文本",
    "英文",
    "中文",
]


def normalize_base_url(url: str) -> str:
    base = (url or "").strip().rstrip("/")
    if base.lower() == "https://api.kimi.com/coding":
        return base + "/v1"
    return base


def chat_url(base_url: str) -> str:
    return normalize_base_url(base_url) + "/chat/completions"


def split_languages(raw: str) -> List[str]:
    langs = [part.strip() for part in raw.replace(";", ",").split(",")]
    return [lang for lang in langs if lang]


def read_csv(path: Path) -> List[Dict[str, str]]:
    last_error: Optional[Exception] = None
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            with path.open("r", encoding=encoding, newline="") as fh:
                return list(csv.DictReader(fh))
        except UnicodeError as exc:
            last_error = exc
    raise SystemExit(f"Could not decode {path}: {last_error}")


def fieldnames(path: Path) -> List[str]:
    last_error: Optional[Exception] = None
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            with path.open("r", encoding=encoding, newline="") as fh:
                reader = csv.reader(fh)
                return next(reader, [])
        except UnicodeError as exc:
            last_error = exc
    raise SystemExit(f"Could not decode header in {path}: {last_error}")


def pick_source_column(headers: Iterable[str], requested: Optional[str]) -> str:
    headers = list(headers)
    if requested:
        if requested in headers:
            return requested
        trimmed = {h.strip(): h for h in headers}
        if requested in trimmed:
            return trimmed[requested]
        raise SystemExit(f"Source column {requested!r} not found. Available: {', '.join(headers)}")
    lowered = {h.strip().lower(): h for h in headers}
    for candidate in COMMON_SOURCE_COLUMNS:
        if candidate.lower() in lowered:
            return lowered[candidate.lower()]
    if headers:
        return headers[0]
    raise SystemExit("CSV has no header row")


def prompt_translation(source_lang: str, target_lang: str, source_text: str) -> List[Dict[str, str]]:
    return [
        {"role": "system", "content": f"You are an expert linguist specializing in translation from {source_lang} to {target_lang}."},
        {
            "role": "user",
            "content": (
                f"Translate this {source_lang} text into {target_lang}. "
                "Return only the translation, without explanations, labels, JSON, or quotes.\n\n"
                f"{source_text}"
            ),
        },
    ]


def prompt_suggestions(
    source_lang: str,
    target_lang: str,
    source_text: str,
    translation: str,
    country: str,
) -> List[Dict[str, str]]:
    country_line = f"Adapt the final style to {target_lang} as used in {country}.\n" if country else ""
    return [
        {
            "role": "system",
            "content": (
                "Review the source text and translation. Give concise, specific suggestions to improve "
                f"accuracy, fluency, style, and terminology.\n{country_line}"
                f"<SOURCE_TEXT>\n{source_text}\n</SOURCE_TEXT>\n"
                f"<TRANSLATION>\n{translation}\n</TRANSLATION>\n"
                "Output only the suggestions."
            ),
        }
    ]


def prompt_improve(
    source_lang: str,
    target_lang: str,
    source_text: str,
    translation: str,
    suggestions: str,
) -> List[Dict[str, str]]:
    return [
        {"role": "system", "content": f"You are an expert translation editor for {source_lang} to {target_lang}."},
        {
            "role": "user",
            "content": (
                "Improve the translation using the expert suggestions. Preserve meaning, placeholders, "
                "numbers, tags, and product names. Return only the final translation.\n\n"
                f"SOURCE:\n{source_text}\n\nINITIAL TRANSLATION:\n{translation}\n\nSUGGESTIONS:\n{suggestions}"
            ),
        },
    ]


def clean_api_key(raw: str) -> str:
    key = (raw or "").strip().strip("'\"“”‘’")
    if key.lower().startswith("bearer "):
        key = key[7:].strip()
    return key


def extract_content(data: Dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    first = choices[0]
    message = first.get("message") or {}
    return (message.get("content") or first.get("text") or "").strip()


def post_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: List[Dict[str, str]],
    temperature: Optional[float],
    max_tokens: Optional[int],
    retries: int,
    retry_delay: float,
) -> str:
    body: Dict = {"model": model, "messages": messages}
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens

    switched_max = False
    removed_temperature = False
    attempts = retries + 1
    for attempt in range(attempts):
        request = urllib.request.Request(
            chat_url(base_url),
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = response.read().decode("utf-8")
                return extract_content(json.loads(raw))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            lower = raw.lower()
            if "unsupported parameter" in lower and "max_tokens" in lower and "max_tokens" in body and not switched_max:
                body["max_completion_tokens"] = body.pop("max_tokens")
                switched_max = True
                continue
            if "unsupported parameter" in lower and "max_completion_tokens" in lower and "max_completion_tokens" in body and not switched_max:
                body["max_tokens"] = body.pop("max_completion_tokens")
                switched_max = True
                continue
            if "unsupported parameter" in lower and "temperature" in lower and "temperature" in body and not removed_temperature:
                body.pop("temperature", None)
                removed_temperature = True
                continue
            if attempt >= attempts - 1:
                raise RuntimeError(f"HTTP {exc.code}: {raw[:1000]}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt >= attempts - 1:
                raise RuntimeError(str(exc)) from exc
        time.sleep(retry_delay * (attempt + 1))
    raise RuntimeError("Exhausted retries")


def translate_one(args: argparse.Namespace, api_key: str, source_text: str, target_lang: str, country: str) -> str:
    if not source_text:
        return ""
    if args.dry_run:
        suffix = f" ({country})" if country else ""
        return f"[{target_lang}{suffix}] {source_text}"
    first = post_chat(
        base_url=args.provider_base_url,
        api_key=api_key,
        model=args.model,
        messages=prompt_translation(args.source_language, target_lang, source_text),
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    if args.mode == "fast":
        return first
    suggestions = post_chat(
        base_url=args.provider_base_url,
        api_key=api_key,
        model=args.model,
        messages=prompt_suggestions(args.source_language, target_lang, source_text, first, country),
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    return post_chat(
        base_url=args.provider_base_url,
        api_key=api_key,
        model=args.model,
        messages=prompt_improve(args.source_language, target_lang, source_text, first, suggestions),
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )


def write_rows(path: Path, rows: List[Dict[str, str]], headers: List[str]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Translate a CSV with an OpenAI-compatible LLM provider.")
    parser.add_argument("--input", required=True, type=Path, help="Input CSV path")
    parser.add_argument("--output", required=True, type=Path, help="Output CSV path")
    parser.add_argument("--source-column", help="Column containing source text; auto-detected if omitted")
    parser.add_argument("--source-language", default="Auto", help="Source language label, e.g. English or Chinese")
    parser.add_argument("--target-languages", required=True, help="Comma-separated target language names")
    parser.add_argument("--country", default="", help="Global country/region hint")
    parser.add_argument("--country-column", default="", help="Optional CSV column with row-specific country/region")
    parser.add_argument("--provider-base-url", required=True, help="OpenAI-compatible API base URL")
    parser.add_argument("--model", required=True, help="Model ID")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY", help="Environment variable containing API key")
    parser.add_argument("--api-key", default="", help="API key value; prefer --api-key-env to avoid shell history")
    parser.add_argument("--mode", choices=("fast", "full"), default="fast", help="Translation workflow")
    parser.add_argument("--output-mode", choices=("wide", "long"), default="wide", help="CSV output shape")
    parser.add_argument("--temperature", type=float, help="Optional generation temperature")
    parser.add_argument("--max-tokens", type=int, help="Optional max token limit")
    parser.add_argument("--retries", type=int, default=1, help="Retries per model call")
    parser.add_argument("--retry-delay", type=float, default=1.0, help="Base retry delay in seconds")
    parser.add_argument("--dry-run", action="store_true", help="Validate CSV/output without calling the provider")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    languages = split_languages(args.target_languages)
    if not languages:
        raise SystemExit("Provide at least one target language")

    headers = fieldnames(args.input)
    source_column = pick_source_column(headers, args.source_column)
    if args.country_column and args.country_column not in headers:
        raise SystemExit(f"Country column {args.country_column!r} not found. Available: {', '.join(headers)}")

    rows = read_csv(args.input)
    api_key = clean_api_key(args.api_key or os.environ.get(args.api_key_env, ""))
    if not args.dry_run and not api_key:
        raise SystemExit(f"API key missing. Set {args.api_key_env} or pass --api-key.")

    if args.dry_run:
        print("Dry run: provider calls disabled", file=sys.stderr)
    print(f"Using endpoint: {chat_url(args.provider_base_url)}", file=sys.stderr)
    print(f"Source column: {source_column}; targets: {', '.join(languages)}", file=sys.stderr)

    if args.output_mode == "wide":
        output_headers = list(headers)
        for lang in languages:
            if lang not in output_headers:
                output_headers.append(lang)
        output_rows: List[Dict[str, str]] = []
        for row in rows:
            out = dict(row)
            country = row.get(args.country_column, "") if args.country_column else args.country
            for lang in languages:
                out[lang] = translate_one(args, api_key, row.get(source_column, ""), lang, country)
            output_rows.append(out)
    else:
        output_headers = list(headers) + ["target_language", "translation"]
        output_rows = []
        for row in rows:
            country = row.get(args.country_column, "") if args.country_column else args.country
            for lang in languages:
                out = dict(row)
                out["target_language"] = lang
                out["translation"] = translate_one(args, api_key, row.get(source_column, ""), lang, country)
                output_rows.append(out)

    write_rows(args.output, output_rows, output_headers)
    print(f"Wrote {len(output_rows)} rows to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
