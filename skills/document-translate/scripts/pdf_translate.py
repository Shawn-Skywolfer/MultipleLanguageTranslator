#!/usr/bin/env python3
"""PDFMathTranslate adapter: extract Agent jobs, replay translations, verify fixed-page output."""
import argparse
import base64
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import tempfile

SCHEMA = 'document-translate/pdfmath-v1'
ENGINE_COMMIT = 'fe3d2f37ef1b54abff5ebda091a7fd4fac9fbd08'


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path, data):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def engine():
    import pymupdf
    import pdf2zh
    if pdf2zh.__version__ != '1.9.12':
        raise ValueError('PDF_ENGINE_VERSION: run tools/setup_pdf.py to install the pinned PDFMathTranslate engine.')
    return pymupdf


def language_code(value):
    names = {'english':'en','chinese':'zh','简体中文':'zh','中文':'zh','traditional chinese':'zh-tw',
             '繁體中文':'zh-tw','japanese':'ja','korean':'ko','german':'de','french':'fr','spanish':'es',
             'italian':'it','portuguese':'pt','russian':'ru','arabic':'ar','auto':'en'}
    return names.get(value.lower().strip(), value.lower().strip())


def placeholders(text):
    return sorted(re.findall(r'\{v\d+\}', text))


class Bridge:
    def __init__(self, manifest, targets=None, min_font_size=.5):
        self.manifest, self.targets = manifest, targets
        self.min_font_size = min_font_size
        self.records = {}
        self.errors = []
        self.seen = set()

    def block_id(self, text, page):
        return f'p{page}-pm-' + hashlib.sha256(text.encode()).hexdigest()[:24]

    def register(self, page, sources, paragraphs):
        for source, p in zip(sources, paragraphs):
            if not source.strip() or re.fullmatch(r'\{v\d+\}', source.strip()):
                continue
            number = page.pageid + 1
            key = self.block_id(source, number)
            bbox = [p.x0, page.height-p.y1, p.x1, page.height-p.y0]
            if key not in self.records:
                block = dict(id=key, source=source, bbox=bbox, font_size=p.size, rotation=0,
                             occurrences=[dict(page=number,bbox=bbox)])
                self.records[key] = block
                self.manifest['pages'][number-1]['blocks'].append(block)
            elif dict(page=number,bbox=bbox) not in self.records[key]['occurrences']:
                self.records[key]['occurrences'].append(dict(page=number,bbox=bbox))

    def translate(self, text, page):
        key = self.block_id(text,page); self.seen.add(key)
        if self.targets is None:
            return text
        value = self.targets.get(key)
        if not isinstance(value, str) or not value.strip() or placeholders(value) != placeholders(text):
            self.errors.append('PDF_TRANSLATION_OR_FORMULA_MISSING: ' + key)
            return text  # Never enter upstream's unbounded retries; fail before publishing instead.
        return value


def run_engine(data, manifest, targets=None, min_font_size=.5):
    fitz = engine()
    # Analyze in unrotated page coordinates. Upstream's normal layout mask and
    # pdfminer disagree on /Rotate for cropped pages; restore metadata afterward.
    with fitz.open(stream=data) as original:
        rotations=[p.rotation for p in original]
        for p in original:p.set_rotation(0)
        data=original.tobytes()
    import pdf2zh.high_level as high
    import pdfmath_converter as local
    from pdf2zh import ocr
    bridge = Bridge(manifest, targets, min_font_size)
    class AgentTranslator:
        name = 'agent-bridge'
        def __init__(self, lang_in, lang_out, *args, **kwargs):
            self.lang_in, self.lang_out, self.bridge = lang_in, lang_out, bridge
        def translate(self, text):
            return bridge.translate(text, 1)
    local.GoogleTranslator = AgentTranslator
    high.TranslateConverter = local.TranslateConverter
    old_ocr = ocr.translate_ocr_page
    def ocr_page(page, detection, translator, font, thread, cancellation_event=None):
        # Use upstream's OCR grouping and typesetting; register its actual jobs first.
        groups = ocr.ocr_paragraphs(page, detection)
        for bounds, source, size, words in groups:
            key = bridge.block_id(source,page.number+1)
            if key not in bridge.records:
                block = dict(id=key,source=source,bbox=list(bounds),font_size=size,rotation=0,
                             occurrences=[dict(page=page.number+1,bbox=list(bounds))])
                bridge.records[key]=block;manifest['pages'][page.number]['blocks'].append(block)
        if groups:
            manifest['pages'][page.number]['review_required'] = True
        from types import SimpleNamespace
        proxy=SimpleNamespace(translate=lambda text:bridge.translate(text,page.number+1))
        return old_ocr(page,detection,proxy,font,thread,cancellation_event)
    ocr.translate_ocr_page = ocr_page
    mode = manifest['engine']['layout']
    model = None
    if mode == 'standard':
        from pdf2zh.doclayout import OnnxModel
        model = OnnxModel.from_pretrained()
    try:
        mono, _ = high.translate_stream(data,lang_in=manifest['engine']['source_language'],
                         lang_out=language_code(manifest.get('language','English')),
                         service='agent-bridge', thread=1 if targets is None else 4,
                         model=model,ultrafast=mode=='native-fast',ignore_cache=True,skip_subset_fonts=True)
    finally:
        ocr.translate_ocr_page = old_ocr
    if bridge.errors:
        raise ValueError('; '.join(sorted(set(bridge.errors))[:12]))
    if targets is not None and bridge.seen != set(targets):
        raise ValueError('PDF_ENGINE_JOB_CHANGED: re-extract before exporting.')
    with fitz.open(stream=mono) as output:
        for page,rotation in zip(output,rotations):page.set_rotation(rotation)
        mono=output.tobytes(garbage=3,deflate=True)
    return mono, bridge


def new_manifest(source, language, layout, source_language):
    fitz=engine()
    with fitz.open(source) as doc:
        if doc.is_encrypted or not doc.page_count:
            raise ValueError('PDF_INPUT: empty or encrypted input.')
        pages=[]
        for i,page in enumerate(doc):
            for block in page.get_text('dict')['blocks']:
                for line in block.get('lines',[]):
                    direction=line.get('dir',(1,0))
                    if abs(direction[0]-1)>.01 or abs(direction[1])>.01:
                        raise ValueError(f'PDF_TEXT_ROTATION_UNSUPPORTED: page {i+1}; rotated text must be normalized before translation.')
            has_images=bool(page.get_images())
            has_text=bool(page.get_text().strip())
            if layout=='native-fast' and has_images and not has_text:
                raise ValueError(f'PDF_OCR_REQUIRED: page {i+1}; use --layout standard, not native-fast.')
            pages.append(dict(page=i+1,width=page.rect.width,height=page.rect.height,rotation=page.rotation,
                              cropbox=list(page.cropbox),review_required=has_images,blocks=[]))
    return dict(schema=SCHEMA,source=str(Path(source).resolve()),sha256=sha(source),page_count=len(pages),
                language=language,engine=dict(name='PDFMathTranslate',version='1.9.12',commit=ENGINE_COMMIT,
                layout=layout,source_language=language_code(source_language)),pages=pages)


def extract(args):
    manifest=new_manifest(args.input,args.language,args.layout,args.source_language)
    if args.ocr_language:
        os.environ['PDF2ZH_OCR_LANGUAGE']=args.ocr_language
    manifest['engine']['ocr_language']=os.environ.get('PDF2ZH_OCR_LANGUAGE','')
    _, bridge=run_engine(Path(manifest['source']).read_bytes(),manifest)
    if not bridge.records and any(p['review_required'] for p in manifest['pages']):
        raise ValueError('PDF_OCR_EMPTY: no translatable text found; inspect source and OCR data.')
    write_json(args.manifest,manifest)
    print(json.dumps(dict(manifest=str(Path(args.manifest).resolve()),pages=manifest['page_count'],blocks=len(bridge.records),engine=manifest['engine'])))


def validate(manifest, translations):
    if manifest.get('schema')!=SCHEMA:
        raise ValueError('PDF_MANIFEST_SCHEMA: re-extract using PDFMathTranslate.')
    if sha(manifest['source'])!=manifest['sha256']:
        raise ValueError('PDF_SOURCE_CHANGED: re-extract.')
    pages=manifest['pages']
    if len(pages)!=manifest['page_count'] or [p['page'] for p in pages]!=list(range(1,len(pages)+1)):
        raise ValueError('PDF_PAGE_COVERAGE')
    blocks=[b for p in pages for b in p['blocks']];ids=[b['id'] for b in blocks]
    targets=translations.get('translations',{})
    if len(set(ids))!=len(ids) or not isinstance(targets,dict) or set(ids)!=set(targets):
        raise ValueError('PDF_TRANSLATION_COVERAGE: missing, duplicate or extra IDs.')
    if not translations.get('language','').strip():
        raise ValueError('PDF_TARGET_LANGUAGE')
    for block in blocks:
        value=targets[block['id']]
        if not isinstance(value,str) or not value.strip() or '\x00' in value:
            raise ValueError('PDF_EMPTY_TRANSLATION: '+block['id'])
        if placeholders(value)!=placeholders(block['source']):
            raise ValueError('PDF_FORMULA_PLACEHOLDERS: '+block['id'])
        for term in translations.get('protected_terms',[]):
            if term in block['source'] and term not in value:
                raise ValueError('PDF_PROTECTED_TERM: '+block['id'])
    for p in pages:
        if p['review_required']:
            expected='checked' if p['blocks'] else 'no_text'
            if translations.get('page_reviews',{}).get(str(p['page']))!=expected:
                raise ValueError('PDF_VISUAL_REVIEW_REQUIRED: '+str(p['page']))
    return dict(pages=len(pages),blocks=len(ids),language=translations['language'])


def export(args):
    if not .5 <= args.min_font_size <= 36:raise ValueError('PDF_MIN_FONT_SIZE: choose 0.5..36 pt.')
    manifest=load(args.manifest);translations=load(args.translations)
    summary=validate(manifest,translations)
    if manifest['engine'].get('ocr_language'):
        os.environ['PDF2ZH_OCR_LANGUAGE']=manifest['engine']['ocr_language']
    current=new_manifest(manifest['source'],translations['language'],manifest['engine']['layout'],manifest['engine']['source_language'])
    mono,_=run_engine(Path(manifest['source']).read_bytes(),current,translations['translations'],args.min_font_size)
    fitz=engine();folder=Path(args.output_dir).resolve();folder.mkdir(parents=True,exist_ok=True)
    stem=Path(manifest['source']).stem+'_'+re.sub(r'[^\w-]','_',translations['language'])
    reserved={Path(manifest['source']).resolve(),Path(args.manifest).resolve(),Path(args.translations).resolve()}
    with tempfile.TemporaryDirectory(prefix='.pdfmath-',dir=folder) as temp:
        stage=Path(temp)
        with fitz.open(manifest['source']) as source, fitz.open(stream=mono) as translated, fitz.open() as dual:
            if translated.page_count!=source.page_count:raise ValueError('PDF_PAGE_COUNT')
            images=[]
            for i in range(source.page_count):
                if list(source[i].rect)!=list(translated[i].rect) or source[i].rotation!=translated[i].rotation or list(source[i].cropbox)!=list(translated[i].cropbox):
                    raise ValueError('PDF_GEOMETRY_CHANGED: '+str(i+1))
                dual.insert_pdf(source,from_page=i,to_page=i)
                dual.insert_pdf(translated,from_page=i,to_page=i)
                images += [base64.b64encode(p.get_pixmap(matrix=fitz.Matrix(1.5,1.5),alpha=False).tobytes('png')).decode() for p in (source[i],translated[i])]
            pdf=stage/(stem+'_bilingual.pdf');dual.save(pdf,garbage=3,deflate=True)
        with fitz.open(manifest['source']) as source,fitz.open(pdf) as result:
            if result.page_count!=2*source.page_count:raise ValueError('PDF_OUTPUT_PAGE_COUNT')
            for i,p in enumerate(source):
                if p.get_pixmap().samples!=result[2*i].get_pixmap().samples:raise ValueError('PDF_ORIGINAL_CHANGED')
        (stage/(stem+'_compare.html')).write_text('<!doctype html><meta charset="utf-8"><title>PDFMathTranslate</title><style>body{background:#ddd}img{display:block;max-width:95%;margin:12px auto;page-break-after:always}</style>'+''.join('<img alt="'+('Original' if i%2==0 else 'Translation')+'" src="data:image/png;base64,'+value+'">' for i,value in enumerate(images)),encoding='utf-8')
        lines=['# '+translations['language']]
        for p in manifest['pages']:
            lines += ['\n## Page '+str(p['page'])]
            for b in p['blocks']:lines += [b['source'],'',translations['translations'][b['id']],'']
        (stage/(stem+'.md')).write_text('\n'.join(lines),encoding='utf-8')
        report=dict(**summary,engine=manifest['engine'],output_pages=summary['pages']*2,source_pixels_verified=True,
                    layout='PDFMathTranslate in-place white/black',depth=translations.get('depth','direct'),
                    quality_checks=translations.get('quality_checks',{}))
        write_json(stage/(stem+'.validation.json'),report)
        for file in stage.iterdir():
            if (folder/file.name).resolve() in reserved:raise ValueError('PDF_OUTPUT_RESERVED')
        for file in stage.iterdir():os.replace(file,folder/file.name)
    print(json.dumps(dict(output=str(folder/(stem+'_bilingual.pdf')),**report)))


def main():
    parser=argparse.ArgumentParser(description=__doc__);cmd=parser.add_subparsers(dest='command',required=True)
    p=cmd.add_parser('extract');p.add_argument('input');p.add_argument('--manifest',required=True)
    p.add_argument('--language',default='English');p.add_argument('--source-language',default='en')
    p.add_argument('--layout',choices=['standard','native-fast'],default='standard');p.add_argument('--ocr-language')
    p=cmd.add_parser('validate');p.add_argument('manifest');p.add_argument('translations')
    p=cmd.add_parser('export');p.add_argument('manifest');p.add_argument('translations');p.add_argument('--output-dir',required=True)
    p.add_argument('--min-font-size',type=float,default=3.5)
    p=cmd.add_parser('inspect');p.add_argument('manifest')
    args=parser.parse_args()
    try:
        if args.command=='validate':print(json.dumps(validate(load(args.manifest),load(args.translations))))
        elif args.command=='inspect':
            m=load(args.manifest);print(json.dumps(dict(pages=m['page_count'],blocks=sum(len(p['blocks']) for p in m['pages']),engine=m['engine'])))
        else:globals()[args.command](args)
    except Exception as exc:
        print('ERROR: '+str(exc),file=sys.stderr);return 1
    return 0

if __name__=='__main__':sys.exit(main())
