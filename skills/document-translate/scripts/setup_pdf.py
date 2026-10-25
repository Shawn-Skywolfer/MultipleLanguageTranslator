#!/usr/bin/env python3
"""Provision the isolated, pinned PDFMathTranslate environment (no model credentials)."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import venv


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--env-dir',default=str(Path(__file__).resolve().parents[1]/'.venv-pdf'))
    p.add_argument('--download-assets',action='store_true',help='Download layout model and common fonts now.')
    args=p.parse_args()
    if not (3,11)<=sys.version_info[:2]<=(3,12):
        raise SystemExit('PDFMathTranslate requires Python 3.11 or 3.12. Run with that interpreter.')
    folder=Path(args.env_dir).resolve()
    if not folder.exists():venv.EnvBuilder(with_pip=True).create(folder)
    python=folder/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
    subprocess.run([str(python),'-m','pip','install','-r',str(Path(__file__).with_name('requirements-pdf.txt'))],check=True)
    if args.download_assets:
        subprocess.run([str(python),'-c',"from pdf2zh.doclayout import OnnxModel; OnnxModel.from_pretrained(); from pdf2zh.high_level import download_remote_fonts; [download_remote_fonts(x) for x in ['zh','en']]"],check=True)
    subprocess.run([str(python),'-c',"import pdf2zh, cv2, onnxruntime; assert pdf2zh.__version__ == '1.9.12'"],check=True)
    (folder/'.mlt-ready').write_text('pdfmathtranslate-fe3d2f37\n',encoding='utf-8')
    print('PDF Python: '+str(python))

if __name__=='__main__':main()
