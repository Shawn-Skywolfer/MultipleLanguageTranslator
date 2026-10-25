#!/usr/bin/env python3
"""Update the distributable skill from the project's reviewed sources, without user data."""
from pathlib import Path
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
skill = root / 'skills/document-translate'
for name in ['pdf_translate.py', 'pdfmath_converter.py', 'translation_batches.py', 'setup_pdf.py', 'requirements-pdf.txt']:
    shutil.copy2(root / 'tools' / name, skill / 'scripts' / name)
workbench = skill / 'assets/workbench'

if workbench.exists():
    shutil.rmtree(workbench)
workbench.mkdir(parents=True, exist_ok=True)
for name in ['app.js', 'index.html', 'i18n.js', 'package.json', 'Start-Local.cmd', 'start-local.sh', 'api', 'desktop', 'tests', 'third_party']:
    source = root / name
    if source.is_dir():
        shutil.copytree(source, workbench / name, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    else:
        shutil.copy2(source, workbench / name)
(workbench / 'tools').mkdir(exist_ok=True)
for name in ['pdf_translate.py', 'pdfmath_converter.py', 'pdf_worker.py', 'translation_batches.py', 'setup_pdf.py', 'start_local.cjs', 'requirements-pdf.txt']:
    shutil.copy2(root / 'tools' / name, workbench / 'tools' / name)
(workbench / 'SOURCE.json').write_text(json.dumps({
    'repository': 'https://github.com/Shawn-Skywolfer/MultipleLanguageTranslator',
    'base_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'enhancements': ['PDFMathTranslate 1.9.12 pinned engine', 'formula-preserving Agent bridge',
                     'direct/reviewed/multi-pass translation', '128K bounded parallel jobs',
                     'fixed 2N white/black bounded typesetting', 'local Python and portable Windows runtime'],
}, indent=2) + '\n', encoding='utf-8')
print(skill)
