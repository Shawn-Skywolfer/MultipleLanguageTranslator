"""End-to-end coverage, OCR, long translations, CJK, rotated pages and atomic export."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import pymupdf as fitz

CLI = Path(__file__).resolve().parents[1] / 'tools/pdf_translate.py'
spec = importlib.util.spec_from_file_location('pdf_translate', CLI)
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)


class PdfCliTests(unittest.TestCase):
    def call(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(CLI), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return result

    def test_export_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root/'source.pdf'; manifest = root/'manifest.json'; targets = root/'translations.json'
            doc = fitz.open()
            p = doc.new_page(); p.insert_text((60, 60), 'Digital Power 2026: PCS availability 99.99%.')
            p.draw_rect(fitz.Rect(60, 90, 200, 150), fill=(.9, .1, .1))
            p = doc.new_page(width=400, height=600); p.insert_text((40, 40), 'Quarterly report'); p.set_rotation(90)
            doc.new_page()  # blank page must be explicitly reviewed
            doc.save(source); doc.close()
            self.call('extract', source, '--manifest', manifest, '--ocr', 'never')
            m = mod.load(manifest)
            translations = {'language':'English', 'protected_terms':['Digital Power', 'PCS'],
                            'translations':{b['id']:'Digital Power PCS. Rated output: 100 MW.' if p['page'] == 1 else '季度报告 / Quarterly report' for p in m['pages'] for b in p['blocks']},
                            'page_reviews':{'3':'no_text'}}
            mod.write_json(targets, translations)
            self.call('validate', manifest, targets)
            result = self.call('export', manifest, targets, '--output-dir', root/'out')
            data = json.loads(result.stdout)
            self.assertEqual(data['output_pages'], 6, 'exactly one overlay page per original page')
            self.assertTrue(data['original_pages_pixel_checked'])
            report = mod.load(next((root/'out').glob('*.validation.json')))
            with fitz.open(next((root/'out').glob('*.pdf'))) as final:
                self.assertEqual(len(final), report['output_pages'])
                self.assertIn('季度报告', ''.join(p.get_text() for p in final))
            self.assertTrue(report['background_outside_regions_checked'])
            # Extreme text must never spill, create an extra page, or overwrite a valid output.
            long_target=json.loads(json.dumps(translations))
            long_target['translations'][next(iter(long_target['translations']))]='Digital Power PCS. '+'Very long translated sentence. '*450
            mod.write_json(targets,long_target)
            self.call('export',manifest,targets,'--output-dir',root/'overflow',ok=False)
            self.assertFalse(list((root/'overflow').glob('*.pdf')))
            mod.write_json(targets,translations)
            # Every missing, empty, surplus translation and unreviewed page blocks publication.
            key = next(iter(translations['translations']))
            for change in ['missing', 'empty', 'extra', 'review', 'term']:
                broken = json.loads(json.dumps(translations))
                if change == 'missing': del broken['translations'][key]
                if change == 'empty': broken['translations'][key] = ''
                if change == 'extra': broken['translations']['unexpected'] = 'extra'
                if change == 'review': broken['page_reviews'] = {}
                if change == 'term': broken['translations'][key] = 'Missing protected names.'
                mod.write_json(targets, broken)
                self.call('export', manifest, targets, '--output-dir', root/change, ok=False)
                self.assertFalse(list((root/change).glob('*.pdf')) if (root/change).exists() else [])
            # Manifest bound to the original bytes.
            mod.write_json(targets, translations)
            source.write_bytes(source.read_bytes() + b'\n')
            self.call('validate', manifest, targets, ok=False)

    def test_geometry_and_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'geometry.pdf';manifest=root/'manifest.json';targets=root/'translations.json'
            doc=fitz.open()
            for rotation in [0,90,180,270]:
                page=doc.new_page(width=650,height=450)
                page.insert_text((60,80),'Left column energy insight',fontsize=16)
                page.insert_text((350,80),'Right column market view',fontsize=16)
                page.insert_text((60,130),'Long source text wraps in this region.',fontsize=10)
                page.draw_rect(fitz.Rect(40,180,500,300),fill=(.2,.5,.8))
                page.draw_line((40,90),(540,90))
                page.insert_text((560,300),'Vertical side note',fontsize=10,rotate=90)
                page.set_cropbox(fitz.Rect(20,10,620,420));page.set_rotation(rotation)
            doc.save(source);doc.close()
            self.call('extract',source,'--manifest',manifest,'--ocr','never')
            m=mod.load(manifest)
            self.assertTrue(all(len(p['blocks'])==4 for p in m['pages']),'columns must remain distinct')
            t=dict(language='Chinese',translations={b['id']:'原位置覆盖译文：光储市场洞察。' for p in m['pages'] for b in p['blocks']},page_reviews={})
            mod.write_json(targets,t)
            result=json.loads(self.call('export',manifest,targets,'--output-dir',root/'out').stdout)
            self.assertEqual(result['output_pages'],8)
            self.assertTrue(result['background_outside_regions_checked'])
            with fitz.open(source) as a,fitz.open(next((root/'out').glob('*.pdf'))) as b:
                for i in range(4):
                    self.assertEqual(a[i].rect,b[i*2+1].rect)
                    self.assertEqual(a[i].cropbox,b[i*2+1].cropbox)
                    self.assertEqual(a[i].rotation,b[i*2+1].rotation)

    def test_scan_and_mixed_ocr(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); source=root/'scan.pdf'
            image_doc=fitz.open(); p=image_doc.new_page(width=600,height=180)
            p.insert_text((30,90), 'Scanned energy report 2026', fontsize=28)
            image=p.get_pixmap(matrix=fitz.Matrix(2,2)).tobytes('png'); image_doc.close()
            doc=fitz.open()
            p=doc.new_page(); p.insert_image(fitz.Rect(0,100,595,278), stream=image)
            p=doc.new_page(); p.insert_text((30,40),'Native heading should remain.'); p.insert_image(fitz.Rect(0,100,595,278),stream=image)
            doc.save(source); doc.close()
            manifest=root/'manifest.json'
            self.call('extract', source,'--manifest',manifest,'--ocr-language','eng')
            data=mod.load(manifest)
            self.assertTrue(all(p['extraction']=='ocr' and p['review_required'] for p in data['pages']))
            text=' '.join(b['source'] for b in data['pages'][1]['blocks'])
            self.assertIn('Native heading',text); self.assertIn('Scanned energy report',text)
            targets=root/'translations.json'
            mod.write_json(targets,dict(language='Chinese',translations={b['id']:'扫描图中文字' for p in data['pages'] for b in p['blocks']},page_reviews={'1':'checked','2':'checked'}))
            output=json.loads(self.call('export',manifest,targets,'--output-dir',root/'out').stdout)
            self.assertEqual(output['output_pages'],4)
            self.assertTrue(output['background_outside_regions_checked'])
            # Missing language data must not silently fall back to another language.
            self.call('extract',source,'--manifest',root/'bad.json','--ocr-language','not_a_real_language',ok=False)
            self.assertFalse((root/'bad.json').exists())


if __name__ == '__main__': unittest.main()
