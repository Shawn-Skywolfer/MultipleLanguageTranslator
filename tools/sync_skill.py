#!/usr/bin/env python3
"""Update the distributable skill from the project's reviewed sources, without user data."""
from pathlib import Path
import json
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
skill = root / 'skills/document-translate'
shutil.copy2(root / 'tools/pdf_translate.py', skill / 'scripts/pdf_translate.py')
workbench = skill / 'assets/workbench'
workbench.mkdir(parents=True, exist_ok=True)
for name in ['app.js', 'index.html', 'i18n.js', 'package.json', 'api', 'desktop', 'tests']:
    source = root / name
    if source.is_dir():
        shutil.copytree(source, workbench / name, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    else:
        shutil.copy2(source, workbench / name)
(workbench / 'tools').mkdir(exist_ok=True)
for name in ['pdf_translate.py', 'requirements-pdf.txt']:
    shutil.copy2(root / 'tools' / name, workbench / 'tools' / name)
(workbench / 'SOURCE.json').write_text(json.dumps({
    'repository': 'https://github.com/Shawn-Skywolfer/MultipleLanguageTranslator',
    'base_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
    'enhancements': ['PDF coverage gate', 'mixed-page OCR', 'bounded translation retries',
                     'parse-failure recovery', 'agent-native verified bilingual PDF workflow'],
}, indent=2) + '\n', encoding='utf-8')
print(skill)
