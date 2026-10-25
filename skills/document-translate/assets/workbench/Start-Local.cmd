@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist ".venv-pdf\.mlt-ready" (
  py -3.12 tools\setup_pdf.py
  if errorlevel 1 py -3.11 tools\setup_pdf.py
  if errorlevel 1 (
    echo Python 3.11 or 3.12 is required. Check the installation log above.
    pause
    exit /b 1
  )
)
start "" http://127.0.0.1:8765
node tools\start_local.cjs 8765
pause
