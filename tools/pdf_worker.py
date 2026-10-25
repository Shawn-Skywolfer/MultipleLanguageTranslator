#!/usr/bin/env python3
"""JSON stdin worker for the local UI. Never receives or stores model API keys."""
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from types import SimpleNamespace
import uuid
from pdf_translate import extract,export,load,validate,write_json,engine

ROOT=Path(tempfile.gettempdir())/'mlt-pdfmath-jobs'


def main():
    request=json.load(sys.stdin);op=request.get('op')
    ROOT.mkdir(exist_ok=True)
    if op=='status':
        engine();return dict(ok=True,engine='PDFMathTranslate 1.9.12')
    if op=='prepare':
        # Only expire our own workspaces; never touch user documents.
        import shutil
        for old in ROOT.iterdir():
            if old.is_dir() and re.fullmatch(r'[a-f0-9]{32}',old.name) and time.time()-old.stat().st_mtime>86400:
                shutil.rmtree(old,ignore_errors=True)
        token=uuid.uuid4().hex;folder=ROOT/token;folder.mkdir()
        data=base64.b64decode(request['pdf'],validate=True)
        if not data.startswith(b'%PDF-'):raise ValueError('PDF_INPUT: expected a PDF.')
        if len(data)>70*1024*1024:raise ValueError('PDF_INPUT_TOO_LARGE: limit 70 MiB.')
        (folder/'input.pdf').write_bytes(data)
        extract(SimpleNamespace(input=str(folder/'input.pdf'),manifest=str(folder/'manifest.json'),
            language=request.get('language','English'),source_language=request.get('source_language','en'),
            layout=request.get('layout','standard'),ocr_language=request.get('ocr_language')))
        return dict(job=token,manifest=load(folder/'manifest.json'))
    token=request.get('job','')
    if not re.fullmatch(r'[a-f0-9]{32}',token):raise ValueError('PDF_JOB_INVALID')
    folder=ROOT/token
    if not (folder/'manifest.json').exists():raise ValueError('PDF_JOB_EXPIRED: prepare the input again.')
    if op=='export':
        result=request['translations'];manifest=load(folder/'manifest.json')
        validate(manifest,result);write_json(folder/'translations.json',result)
        export(SimpleNamespace(manifest=str(folder/'manifest.json'),translations=str(folder/'translations.json'),
                               output_dir=str(folder/'output'),min_font_size=3.5))
        files=[]
        for path in sorted((folder/'output').iterdir()):
            files.append(dict(name=path.name,bytes=base64.b64encode(path.read_bytes()).decode()))
        return dict(files=files)
    raise ValueError('PDF_OPERATION_UNSUPPORTED')

if __name__=='__main__':
    try:
        with contextlib.redirect_stdout(sys.stderr):result=main()
        print(json.dumps(result,ensure_ascii=False),flush=True)
    except Exception as exc:
        print(json.dumps(dict(error=str(exc)),ensure_ascii=False),flush=True);sys.exit(1)
