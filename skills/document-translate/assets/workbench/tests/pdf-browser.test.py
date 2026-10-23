"""Exercise actual browser export code using pdf-lib/canvas and verify with an independent PDF renderer."""
import importlib.util
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
import pymupdf as fitz

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('pdf_translate',ROOT/'tools/pdf_translate.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)

class BrowserExport(unittest.TestCase):
    def test_render_geometry(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source.pdf';output=root/'output.pdf'
            doc=fitz.open()
            for rotation in [0,90,180,270]:
                page=doc.new_page(width=650,height=450)
                page.insert_text((60,70),'Grid forming storage insight',fontsize=18)
                page.insert_text((60,130),'Original technical paragraph.',fontsize=12)
                page.draw_rect(fitz.Rect(50,180,500,290),fill=(.2,.5,.8))
                page.insert_text((560,300),'Vertical side note',fontsize=10,rotate=90)
                page.set_cropbox(fitz.Rect(20,10,620,420));page.set_rotation(rotation)
            doc.save(source);doc.close()
            fixture=dict(source=str(source),doc=dict(pages=[]),results=[])
            boxes=[]
            with fitz.open(source) as doc:
                for index,page in enumerate(doc):
                    rotation=page.rotation
                    regions=mod.extract_regions(page)
                    matrix=page.rotation_matrix
                    page.set_rotation(0);transform=page.transformation_matrix;page.set_rotation(rotation)
                    viewport=list(transform*matrix)
                    blocks=[];display=[]
                    for b in regions:
                        r=fitz.Rect(b['bbox'])*matrix
                        blocks.append(dict(id=b['id'],bbox=dict(x0=r.x0,y0=r.y0,x1=r.x1,y1=r.y1),fontSize=b['font_size'],coordinateSpace='display-top-left',rotation=(rotation-b['rotation'])%360))
                        display.append(list(r))
                        fixture['results'].append([f'page-{index+1}-block-{len(blocks)}',dict(text='Precise in-place translated content')])
                    boxes.append([b['bbox'] for b in regions])
                    fixture['doc']['pages'].append(dict(pageNo=index+1,width=page.rect.width,height=page.rect.height,transform=viewport,blocks=blocks))
            path=root/'fixture.json';path.write_text(json.dumps(fixture))
            result=subprocess.run(['node',str(ROOT/'tests/browser-pdf-integration.cjs'),str(path),str(output)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            with fitz.open(source) as a,fitz.open(output) as b:
                self.assertEqual(len(b),8)
                for index in range(4):
                    original=a[index].get_pixmap(alpha=False)
                    copy=b[index*2].get_pixmap(alpha=False)
                    translated=b[index*2+1].get_pixmap(alpha=False)
                    self.assertEqual(original.samples,copy.samples)
                    self.assertNotEqual(original.samples,translated.samples)
                    self.assertEqual(a[index].cropbox,b[index*2+1].cropbox)
                    self.assertEqual(a[index].rotation,b[index*2+1].rotation)
                    mod.verify_pixels_outside(original,translated,boxes[index],a[index])

if __name__=='__main__':unittest.main()
