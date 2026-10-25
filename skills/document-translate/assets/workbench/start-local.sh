#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 20 or newer first.' >&2
  exit 1
fi
if [ ! -f .venv-pdf/.mlt-ready ]; then
  if command -v python3.12 >/dev/null 2>&1; then
    python3.12 tools/setup_pdf.py
  elif command -v python3.11 >/dev/null 2>&1; then
    python3.11 tools/setup_pdf.py
  else
    echo 'Install Python 3.11 or 3.12 first.' >&2
    exit 1
  fi
fi
exec node tools/start_local.cjs "${1:-8765}"
