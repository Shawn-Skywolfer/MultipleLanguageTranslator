"""Real PDFMathTranslate pipeline: formulas, CJK, fit/overflow, crops, rotation, OCR and rejection."""
from pathlib import Path
import contextlib
import io
import json
import os
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
import pdf_translate as m
import pymupdf as fitz


class PDFMathTests(unittest.TestCase):
    def fixture(self,folder,scanned=False):
        source=folder/'source.pdf'
        with fitz.open() as doc:
            for i in range(4 if not scanned else 1):
                p=doc.new_page(width=640,height=440)
                p.insert_text((50,70),'Energy storage',fontsize=16)
                p.insert_text((50,110),'The PCS rating is 100 MW.',fontsize=11)
                p.insert_text((350,70),'Right column',fontsize=16)
                p.insert_text((350,110),'Availability is 99.99%.',fontsize=11)
                p.draw_rect(fitz.Rect(60,190,280,260),fill=(0,.3,.8),color=None)
                p.insert_text((55,155),'Formula: ',fontsize=13)
                p.insert_text((107,155),'E = mc',fontname='tiit',fontsize=13)
                if not scanned:
                    p.set_cropbox(fitz.Rect(20,10,620,420));p.set_rotation(i*90)
            doc.save(source)
        if scanned:
            with fitz.open(source) as doc:pix=doc[0].get_pixmap(matrix=fitz.Matrix(2,2))
            with fitz.open() as doc:
                p=doc.new_page(width=640,height=440);p.insert_image(p.rect,stream=pix.tobytes('png'));doc.save(folder/'scan.pdf')
            return folder/'scan.pdf'
        return source

    def prepare(self,source,path,layout='native-fast'):
        with contextlib.redirect_stdout(io.StringIO()):
            m.extract(NS(input=str(source),manifest=str(path),language='Chinese',layout=layout,source_language='en',ocr_language='eng'))
        return m.load(path)

    def targets(self,manifest):
        translations={}
        for p in manifest['pages']:
            for b in p['blocks']:
                text=b['source'];tokens=' '.join(m.placeholders(text))
                value=('储能系统' if 'Energy' in text else 'PCS 额定功率为 100 MW。' if 'PCS' in text else '右侧栏' if 'Right' in text else '可用率为 99.99%。' if 'Availability' in text else '公式')
                translations[b['id']]=value+(' '+tokens if tokens else '')
        return dict(language='Chinese',translations=translations,page_reviews={str(p['page']):'checked' if p['blocks'] else 'no_text' for p in manifest['pages'] if p['review_required']})

    def output(self,folder,manifest,targets):
        m.write_json(folder/'translations.json',targets)
        with contextlib.redirect_stdout(io.StringIO()):
            m.export(NS(manifest=str(folder/'manifest.json'),translations=str(folder/'translations.json'),output_dir=str(folder/'out'),min_font_size=3.5))
        return folder/'out/source_Chinese_bilingual.pdf'

    def test_real_native_engine_cjk_formula_geometry_fit_and_rejections(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Path(tmp);source=self.fixture(f);before=m.sha(source)
            manifest=self.prepare(source,f/'manifest.json');targets=self.targets(manifest)
            self.assertTrue(any(m.placeholders(b['source']) for p in manifest['pages'] for b in p['blocks']), 'actual engine formula protection must be exercised')
            result=self.output(f,manifest,targets)
            with fitz.open(source) as original,fitz.open(result) as output:
                self.assertEqual(output.page_count,8)
                for i,p in enumerate(original):
                    self.assertEqual(p.get_pixmap().samples,output[2*i].get_pixmap().samples)
                    self.assertEqual(list(p.cropbox),list(output[2*i+1].cropbox));self.assertEqual(p.rotation,output[2*i+1].rotation)
                    self.assertIn('储能',output[2*i+1].get_text())
                    self.assertIn('99.99%',output[2*i+1].get_text())
                    self.assertIn('mc',output[2*i+1].get_text())
                    # Colored diagram region remains intact on all four rotations.
                    rect=fitz.Rect(45,180,280,250)*p.rotation_matrix
                    self.assertEqual(p.get_pixmap(clip=rect).samples,output[2*i+1].get_pixmap(clip=rect).samples)
            self.assertEqual(before,m.sha(source))
            first=next(iter(targets['translations']))
            bad=json.loads(json.dumps(targets));del bad['translations'][first]
            with self.assertRaisesRegex(ValueError,'COVERAGE'):m.validate(manifest,bad)
            for b in [b for p in manifest['pages'] for b in p['blocks'] if m.placeholders(b['source'])][:1]:
                bad=json.loads(json.dumps(targets));bad['translations'][b['id']]='formula omitted'
                with self.assertRaisesRegex(ValueError,'FORMULA'):m.validate(manifest,bad)
            original_bytes=result.read_bytes()
            bad=json.loads(json.dumps(targets));bad['translations'][first]='超长翻译内容'*5000
            with self.assertRaisesRegex(ValueError,'DOES_NOT_FIT'):self.output(f,manifest,bad)
            self.assertEqual(original_bytes,result.read_bytes(),'failed exports must not replace an existing good output')

    def test_real_standard_layout_engine(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Path(tmp);source=self.fixture(f)
            manifest=self.prepare(source,f/'manifest.json','standard')
            self.assertGreater(sum(len(p['blocks']) for p in manifest['pages']),0)
            targets=self.targets(manifest);m.write_json(f/'translations.json',targets)
            with contextlib.redirect_stdout(io.StringIO()):
                m.export(NS(manifest=str(f/'manifest.json'),translations=str(f/'translations.json'),output_dir=str(f/'out'),min_font_size=3.5))
            with fitz.open(f/'out/source_Chinese_bilingual.pdf') as doc:
                self.assertEqual(doc.page_count,8)
                for i in range(1,8,2):
                    self.assertIn('储能',doc[i].get_text())
                    self.assertIn('PCS',doc[i].get_text())
                    self.assertIn('99.99%',doc[i].get_text())

    def test_real_ocr_and_fast_mode_scan_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            f=Path(tmp);scan=self.fixture(f,scanned=True)
            with self.assertRaisesRegex(ValueError,'OCR_REQUIRED'):self.prepare(scan,f/'manifest.json')
            os.environ['TESSDATA_PREFIX']='/usr/share/tesseract-ocr/5/tessdata'
            manifest=self.prepare(scan,f/'manifest.json','standard')
            self.assertTrue(manifest['pages'][0]['review_required'])
            self.assertTrue(any('PCS' in b['source'] for b in manifest['pages'][0]['blocks']))
            targets=self.targets(manifest);bad=dict(targets,page_reviews={})
            with self.assertRaisesRegex(ValueError,'VISUAL_REVIEW'):m.validate(manifest,bad)
            m.write_json(f/'translations.json',targets)
            with contextlib.redirect_stdout(io.StringIO()):
                m.export(NS(manifest=str(f/'manifest.json'),translations=str(f/'translations.json'),output_dir=str(f/'out'),min_font_size=3.5))
            with fitz.open(f/'out/scan_Chinese_bilingual.pdf') as doc:self.assertEqual(doc.page_count,2);self.assertIn('100',doc[1].get_text())

if __name__=='__main__':unittest.main()
