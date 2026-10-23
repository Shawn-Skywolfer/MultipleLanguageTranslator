#!/usr/bin/env python3
"""PDF manifest -> agent translations -> verified bilingual PDF/HTML/Markdown. No API calls."""
import argparse
import base64
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import unicodedata

SCHEMA = 'document-translate/pdf-v1'


def engine():
    try:
        import pymupdf
        return pymupdf
    except ImportError as exc:
        raise ValueError('Install the PDF dependency: python -m pip install "PyMuPDF>=1.26.6,<1.28"') from exc


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f'PDF_DUPLICATE_JSON_KEY: {key}')
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding='utf-8'), object_pairs_hook=unique)


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def normalized(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value).replace('\u00ad', ''))


def open_source(path):
    fitz = engine()
    doc = fitz.open(path)
    if not doc.is_pdf or doc.needs_pass or doc.is_repaired or not len(doc):
        doc.close()
        raise ValueError('PDF_SOURCE_INVALID: encrypted, damaged, non-PDF or empty source. Supply an intact unlocked PDF.')
    return doc


def extract_regions(page, textpage=None):
    """Keep columns, table cells and distinct font sizes separate; join aligned paragraph lines."""
    regions = []
    for block in page.get_text('dict', textpage=textpage, sort=True)['blocks']:
        if block.get('type') != 0:
            continue
        current = None
        for line in block.get('lines', []):
            spans = [span for span in line['spans'] if span.get('text', '').strip()]
            direction = line.get('dir', (1, 0))
            text, previous = '', None
            def projected_bounds(box):
                x0,y0,x1,y1 = box
                values = [x*direction[0]+y*direction[1] for x,y in [(x0,y0),(x0,y1),(x1,y0),(x1,y1)]]
                return min(values),max(values)
            for span in spans:
                if previous and text and not text[-1].isspace() and not span['text'][0].isspace():
                    gap = projected_bounds(span['bbox'])[0] - projected_bounds(previous['bbox'])[1]
                    if gap > min(span['size'],previous['size'])*.12:
                        text += ' '
                text += span['text']
                previous = span
            text = text.strip()
            if not text:
                continue
            box = list(line['bbox'])
            size = sum(span['size'] * max(1, len(span['text'])) for span in spans) / sum(max(1, len(span['text'])) for span in spans)
            direction = line.get('dir', (1, 0))
            angle = math.degrees(math.atan2(-direction[1], direction[0])) % 360
            rotation = int(round(angle / 90) * 90) % 360
            if abs((angle - rotation + 180) % 360 - 180) > 1:
                raise ValueError('PDF_TEXT_ANGLE: non-orthogonal text requires an explicitly reviewed region before export.')
            join = current and rotation == current['rotation'] == 0 and abs(box[0] - current['bbox'][0]) <= size * .7 and abs(size - current['font_size']) <= size * .18 and box[1] > current['last_top'] + 1 and -.25 * size <= box[1] - current['bbox'][3] <= size * .85
            if join:
                current['source'] += '\n' + text
                current['bbox'] = [min(current['bbox'][0], box[0]), min(current['bbox'][1], box[1]), max(current['bbox'][2], box[2]), max(current['bbox'][3], box[3])]
                current['last_top'] = box[1]
            else:
                current = dict(source=text, bbox=box, font_size=size, rotation=rotation, last_top=box[1])
                regions.append(current)
    for index, region in enumerate(regions):
        region.pop('last_top')
        region['id'] = f'p{page.number + 1}-b{index + 1}'
    return regions


def extract(args):
    source = Path(args.input).resolve()
    manifest_path = Path(args.manifest).resolve()
    if source == manifest_path:
        raise ValueError('Do not overwrite the source PDF.')
    manifest = dict(schema=SCHEMA, source=str(source), sha256=sha(source), pages=[])
    with open_source(source) as doc:
        manifest['page_count'] = len(doc)
        for index, page in enumerate(doc):
            has_images = bool(page.get_image_info())
            native = page.get_text('text').strip()
            use_ocr = args.ocr == 'always' or (args.ocr == 'auto' and (has_images or not native))
            textpage = None
            if use_ocr:
                try:
                    # Partial OCR retains digital text and recognizes image regions in mixed pages.
                    textpage = page.get_textpage_ocr(language=args.ocr_language, dpi=200,
                                                     full=args.ocr == 'always' or not native)
                except Exception as exc:
                    raise ValueError(f'PDF_OCR_FAILED: page {index + 1}; check Tesseract and {args.ocr_language} language data. {exc}') from exc
            blocks = extract_regions(page, textpage)
            bounds = page.rect * page.derotation_matrix
            manifest['pages'].append(dict(page=index + 1, width=page.rect.width, height=page.rect.height,
                                          rotation=page.rotation, coordinate_space='unrotated-top-left',
                                          bounds=list(bounds), extraction='ocr' if use_ocr else 'text',
                                          review_required=use_ocr or has_images or not blocks, blocks=blocks))
    write_json(manifest_path, manifest)
    print(json.dumps(dict(manifest=str(manifest_path), pages=manifest['page_count'],
                          blocks=sum(len(p['blocks']) for p in manifest['pages']),
                          review_pages=[p['page'] for p in manifest['pages'] if p['review_required']])))


def validate(manifest, translations):
    if manifest.get('schema') != SCHEMA:
        raise ValueError('PDF_MANIFEST_SCHEMA: unsupported manifest version.')
    if sha(manifest['source']) != manifest['sha256']:
        raise ValueError('PDF_SOURCE_CHANGED: re-extract the current source before exporting.')
    pages = manifest['pages']
    if len(pages) != manifest['page_count'] or [p['page'] for p in pages] != list(range(1, len(pages) + 1)):
        raise ValueError('PDF_PAGE_COVERAGE: missing, duplicate or reordered pages.')
    ids = [b['id'] for p in pages for b in p['blocks']]
    if len(set(ids)) != len(ids):
        raise ValueError('PDF_DUPLICATE_BLOCK: duplicate block IDs.')
    targets = translations.get('translations', {})
    if not isinstance(targets, dict) or set(targets) != set(ids):
        missing = sorted(set(ids) - set(targets)) if isinstance(targets, dict) else ids
        raise ValueError(f'PDF_TRANSLATION_COVERAGE: every ID must appear exactly once. Missing: {missing[:20]}')
    if not isinstance(translations.get('language'), str) or not translations['language'].strip():
        raise ValueError('PDF_TARGET_LANGUAGE: specify language in the translation JSON.')
    for page in pages:
        for block in page['blocks']:
            value = targets[block['id']]
            if not isinstance(value, str) or not value.strip() or '\x00' in value:
                raise ValueError(f'PDF_EMPTY_TRANSLATION: {block["id"]}')
            for term in translations.get('protected_terms', []):
                if term in block['source'] and term not in value:
                    raise ValueError(f'PDF_PROTECTED_TERM: {block["id"]} lacks {term}')
        if page['review_required']:
            review = translations.get('page_reviews', {}).get(str(page['page']))
            expected = 'checked' if page['blocks'] else 'no_text'
            if review != expected:
                raise ValueError(f'PDF_VISUAL_REVIEW_REQUIRED: inspect source page {page["page"]}; then set page_reviews to {expected!r}.')
    return dict(pages=len(pages), blocks=len(ids), language=translations['language'])


def escaped(text):
    return html.escape(text).replace('\n', '<br>')


def verify_pixels_outside(original, translated, boxes, page):
    """Require unchanged pixels except inside the declared overlay rectangles (2px AA allowance)."""
    if (original.width, original.height, original.n) != (translated.width, translated.height, translated.n):
        raise ValueError('PDF_PAGE_GEOMETRY_CHANGED: overlay page dimensions differ.')
    fitz = engine()
    sx, sy = original.width / page.rect.width, original.height / page.rect.height
    rects = []
    for box in boxes:
        r = fitz.Rect(box) * page.rotation_matrix
        rects.append((max(0, math.floor(r.x0*sx)-2), max(0, math.floor(r.y0*sy)-2),
                      min(original.width, math.ceil(r.x1*sx)+2), min(original.height, math.ceil(r.y1*sy)+2)))
    a, b, channels = original.samples, translated.samples, original.n
    for row in range(original.height):
        intervals = sorted((x0,x1) for x0,y0,x1,y1 in rects if y0 <= row < y1)
        cursor = 0
        for left,right in intervals + [(original.width, original.width)]:
            if left > cursor:
                start, end = (row*original.width+cursor)*channels, (row*original.width+left)*channels
                if a[start:end] != b[start:end]:
                    raise ValueError('PDF_BACKGROUND_CHANGED: pixels outside text regions changed.')
            cursor = max(cursor,right)


def make_overlay(source_page, page_info, targets, min_font_size):
    fitz = engine()
    bounds = source_page.rect * source_page.derotation_matrix
    doc = fitz.open()
    page = doc.new_page(width=bounds.width, height=bounds.height)
    layouts = []
    try:
        for block in page_info['blocks']:
            raw = block.get('bbox')
            if not isinstance(raw, list) or len(raw) != 4 or not all(isinstance(x, (float,int)) and math.isfinite(x) for x in raw):
                raise ValueError(f'PDF_REGION_MISSING: {block["id"]}; re-extract with region coordinates.')
            rect = fitz.Rect(raw)
            if rect.is_empty or rect.is_infinite or not bounds.contains(rect):
                raise ValueError(f'PDF_REGION_BOUNDS: {block["id"]}')
            font = max(1, min(96, float(block.get('font_size', min(rect.height*.7, 12)))))
            # White paint is limited to the source region. No region expansion or extra pages.
            page.draw_rect(rect, color=None, fill=(1,1,1), overlay=True)
            layouts.append(dict(id=block['id'], bbox=list(rect), font_size=font, rotation=int(block.get('rotation',0))))
        for layout in layouts:
            font, rect = layout['font_size'], fitz.Rect(layout['bbox'])
            content = '<div>' + escaped(targets[layout['id']]) + '</div>'
            css = f'*{{margin:0;padding:0;color:#000}} body,div{{font-family:sans-serif;font-size:{font}pt;line-height:1;overflow-wrap:anywhere;}}'
            spare, scale = page.insert_htmlbox(rect, content, css=css, scale_low=min(1,min_font_size/font), rotate=layout['rotation'], overlay=True)
            if spare < 0:
                raise ValueError(f'PDF_TEXT_DOES_NOT_FIT: {layout["id"]}; shorten faithfully or adjust the reviewed region. No extra page or clipping is allowed.')
            layout.update(font_size=round(font*scale,3), scale=round(scale,6))
        for layout in layouts:
            text = page.get_text('text', clip=fitz.Rect(layout['bbox']) + (-.1,-.1,.1,.1))
            if normalized(targets[layout['id']]) not in normalized(text):
                raise ValueError(f'PDF_RENDERED_TEXT_MISSING: {layout["id"]}; inspect fonts and region fit.')
        return doc, layouts
    except Exception:
        doc.close()
        raise


def export(args):
    fitz = engine()
    manifest, translations = load(args.manifest), load(args.translations)
    summary = validate(manifest, translations)
    if any(p.get('coordinate_space') != 'unrotated-top-left' for p in manifest['pages']):
        raise ValueError('PDF_REGION_VERSION: re-extract legacy manifests before exporting in-place overlays.')
    source = Path(manifest['source']).resolve()
    out = Path(args.output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    language = re.sub(r'[^\w.-]+', '_', translations['language'], flags=re.UNICODE).strip('._') or 'translated'
    stem = f'{source.stem}_{language}_bilingual'
    names = [stem + ext for ext in ['.pdf', '.md', '.html', '.validation.json']]
    if source in [(out / n).resolve() for n in names]:
        raise ValueError('Do not overwrite the source file.')
    if not 0.5 <= args.min_font_size <= 36:
        raise ValueError('PDF_FONT_LIMIT: min-font-size must be within 0.5..36 pt.')
    target = translations['translations']
    md = [f'# {source.name} / {translations["language"]}', '']
    sections, mappings = [], []
    with tempfile.TemporaryDirectory(prefix='.translation-', dir=out) as temp:
        temp = Path(temp)
        result = fitz.open()
        try:
            with open_source(source) as original:
                if len(original) != manifest['page_count']:
                    raise ValueError('PDF_PAGE_COVERAGE: source page count differs from manifest.')
                for page_info in manifest['pages']:
                    index = page_info['page'] - 1
                    result.insert_pdf(original, from_page=index, to_page=index)
                    result.insert_pdf(original, from_page=index, to_page=index)
                    overlay, layouts = make_overlay(original[index], page_info, target, args.min_font_size)
                    try:
                        if layouts:
                            translated_page = result[-1]
                            rotation = translated_page.rotation
                            translated_page.set_rotation(0)
                            try:
                                translated_page.show_pdf_page(translated_page.rect, overlay, 0, keep_proportion=False, overlay=True)
                            finally:
                                translated_page.set_rotation(rotation)
                    finally:
                        overlay.close()
                    mappings.append(dict(source_page=index+1, original_output_page=index*2+1,
                                         translation_start=index*2+2, translation_end=index*2+2, regions=layouts))
                    md.extend([f'## Page {index+1}', ''])
                    for block in page_info['blocks']:
                        md.extend([f'### {block["id"]}', '', '**Source**', '', block['source'], '', '**Translation**', '', target[block['id']], ''])
                result.set_toc([[1,f'Source page {m["source_page"]}',m['original_output_page']] for m in mappings])
                candidate = temp / names[0]
                result.save(candidate, garbage=4, deflate=True)
        finally:
            result.close()
        with open_source(source) as original, open_source(candidate) as reopened:
            if len(reopened) != len(original)*2:
                raise ValueError('PDF_OUTPUT_PAGE_COUNT: output must contain exactly two pages per source page.')
            for page_info, mapping in zip(manifest['pages'], mappings):
                src = original[page_info['page']-1]
                a = src.get_pixmap(matrix=fitz.Matrix(1,1), alpha=False)
                source_copy = reopened[mapping['original_output_page']-1]
                translated = reopened[mapping['translation_start']-1]
                b = source_copy.get_pixmap(matrix=fitz.Matrix(1,1), alpha=False)
                c = translated.get_pixmap(matrix=fitz.Matrix(1,1), alpha=False)
                if (a.width,a.height,a.samples) != (b.width,b.height,b.samples):
                    raise ValueError(f'PDF_ORIGINAL_RENDER_CHANGED: page {page_info["page"]}')
                if src.rect != translated.rect or src.rotation != translated.rotation or src.cropbox != translated.cropbox:
                    raise ValueError('PDF_PAGE_GEOMETRY_CHANGED: crop, rotation or dimensions changed.')
                verify_pixels_outside(a,c,[r['bbox'] for r in mapping['regions']],src)
                text = translated.get_text()
                for block in page_info['blocks']:
                    if normalized(target[block['id']]) not in normalized(text):
                        raise ValueError(f'PDF_RENDERED_TEXT_MISSING: {block["id"]}')
                images = [base64.b64encode(pix.tobytes('png')).decode() for pix in [a,c]]
                sections.append(f'<section><h2>Page {page_info["page"]}</h2><div class="pair"><figure><figcaption>Original</figcaption><img alt="Original" src="data:image/png;base64,{images[0]}"></figure><figure><figcaption>Translation</figcaption><img alt="Translation overlay" src="data:image/png;base64,{images[1]}"></figure></div></section>')
            summary.update(output_pages=len(reopened),mappings=mappings,layout='original-plus-in-place-overlay',
                           render_checked=True,original_pages_pixel_checked=True,background_outside_regions_checked=True,
                           rendered_translation_coverage=True)
        (temp/names[1]).write_text('\n'.join(md),encoding='utf-8')
        css = 'body{font-family:system-ui,sans-serif;margin:16px;color:#17202a}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}figure{margin:0}img{display:block;width:100%;border:1px solid #ddd}figcaption{margin:8px 0}@media(max-width:700px){.pair{grid-template-columns:1fr}}@media print{section{break-before:page}}'
        (temp/names[2]).write_text('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>In-place bilingual proof</title><style>'+css+'</style><body>'+''.join(sections)+'</body></html>',encoding='utf-8')
        expected_hash=sha(candidate)
        summary.update(source_sha256=manifest['sha256'],pdf_sha256=expected_hash,
                       limits='Original pages and pixels outside declared white text regions are preserved. Font fitting and extracted-block coverage are checked; OCR completeness and translation semantics need review.')
        write_json(temp/names[3],summary)
        for name in names:
            os.replace(temp/name,out/name)
        if sha(out/names[0]) != expected_hash:
            raise ValueError('PDF_SAVED_HASH: final file differs from validated candidate.')
    print(json.dumps(dict(files=[str(out/n) for n in names],**summary),ensure_ascii=False))


def inspect(args):
    fitz = engine()
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open_source(args.input) as doc:
        indices = range(len(doc)) if not args.pages else [int(x) - 1 for x in args.pages.split(',')]
        for index in indices:
            doc[index].get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False).save(out / f'page-{index + 1}.png')
    print(str(out.resolve()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('extract')
    p.add_argument('input'); p.add_argument('--manifest', required=True)
    p.add_argument('--ocr', choices=['auto', 'always', 'never'], default='auto')
    p.add_argument('--ocr-language', default='eng')
    p = sub.add_parser('validate')
    p.add_argument('manifest'); p.add_argument('translations')
    p = sub.add_parser('export')
    p.add_argument('manifest'); p.add_argument('translations'); p.add_argument('--output-dir', required=True)
    p.add_argument('--min-font-size', type=float, default=3.5)
    p = sub.add_parser('inspect')
    p.add_argument('input'); p.add_argument('--output-dir', required=True); p.add_argument('--pages')
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            print(json.dumps(validate(load(args.manifest), load(args.translations)), ensure_ascii=False))
        else:
            globals()[args.command](args)
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
