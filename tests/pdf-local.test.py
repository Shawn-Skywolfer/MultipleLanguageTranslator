"""Run the local Node HTTP service and actual Python PDF engine without model credentials."""
from pathlib import Path
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import urllib.error
import pymupdf as fitz

ROOT=Path(__file__).resolve().parents[1]

class LocalTests(unittest.TestCase):
    def test_real_http_prepare_and_export(self):
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        env=dict(os.environ,MLT_PDF_PYTHON=sys.executable,OMP_NUM_THREADS='2')
        server=subprocess.Popen(['node',str(ROOT/'tools/start_local.cjs'),str(port)],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        url=f'http://127.0.0.1:{port}'
        try:
            for _ in range(60):
                try:urllib.request.urlopen(url,timeout=1);break
                except OSError:time.sleep(.1)
            def post(data,origin=None):
                headers={'Content-Type':'application/json'}
                if origin:headers['Origin']=origin
                req=urllib.request.Request(url+'/api/pdf-engine',json.dumps(data).encode(),headers)
                return json.load(urllib.request.urlopen(req,timeout=180))
            self.assertEqual(post(dict(op='status'))['engine'],'PDFMathTranslate 1.9.12')
            with self.assertRaises(urllib.error.HTTPError) as error:post(dict(op='status'),'https://untrusted.example')
            self.assertEqual(error.exception.code,403)
            with fitz.open() as doc:
                p=doc.new_page();p.insert_text((50,70),'Energy storage at 100 MW.',fontsize=16);data=doc.tobytes()
            job=post(dict(op='prepare',pdf=base64.b64encode(data).decode(),layout='native-fast',language='Chinese',source_language='en'))
            manifest=job['manifest'];blocks=[b for p in manifest['pages'] for b in p['blocks']]
            self.assertGreater(len(blocks),0)
            result=post(dict(op='export',job=job['job'],translations=dict(language='Chinese',depth='direct',translations={b['id']:'储能功率为 100 MW。' for b in blocks},page_reviews={})))
            pdf=next(x for x in result['files'] if x['name'].endswith('.pdf'))
            with fitz.open(stream=base64.b64decode(pdf['bytes'])) as output,fitz.open(stream=data) as source:
                self.assertEqual(output.page_count,2);self.assertIn('储能',output[1].get_text());self.assertEqual(source[0].get_pixmap().samples,output[0].get_pixmap().samples)
            with self.assertRaises(urllib.error.HTTPError) as error:post(dict(op='export',job='../../escape',translations={}))
            self.assertEqual(error.exception.code,422)
        finally:
            server.terminate();server.wait(timeout=10)

if __name__=='__main__':unittest.main()
