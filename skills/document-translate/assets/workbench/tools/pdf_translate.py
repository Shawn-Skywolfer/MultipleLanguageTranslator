#!/usr/bin/env python3
"""PDF manifest -> agent translations -> verified bilingual PDF/HTML/Markdown. No API calls."""
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
            blocks = []
            for raw in page.get_text('blocks', textpage=textpage, sort=True):
                text = raw[4].strip()
                if raw[6] != 0 or not text:
                    continue
                blocks.append(dict(id=f'p{index + 1}-b{len(blocks) + 1}', source=text, bbox=list(raw[:4])))
            manifest['pages'].append(dict(page=index + 1, width=page.rect.width, height=page.rect.height,
                                          extraction='ocr' if use_ocr else 'text',
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


def export(args):
    fitz = engine()
    manifest, translations = load(args.manifest), load(args.translations)
    summary = validate(manifest, translations)
    source = Path(manifest['source']).resolve()
    out = Path(args.output_dir).resolve()
    out.mkdir(parents=True, exist_ok=True)
    language = re.sub(r'[^\w.-]+', '_', translations['language'], flags=re.UNICODE).strip('._') or 'translated'
    stem = f'{source.stem}_{language}_bilingual'
    names = [stem + ext for ext in ['.pdf', '.md', '.html', '.validation.json']]
    if source in [(out / n).resolve() for n in names]:
        raise ValueError('Do not overwrite the source file.')
    target = translations['translations']
    md = [f'# {source.name} / {translations["language"]}', '']
    sections, mappings = [], []
    # Build all artifacts in a private staging directory. Publish only after validation.
    with tempfile.TemporaryDirectory(prefix='.translation-', dir=out) as temp:
        temp = Path(temp)
        result = fitz.open()
        try:
            with open_source(source) as original:
                if len(original) != manifest['page_count']:
                    raise ValueError('PDF_PAGE_COVERAGE: source page count differs from manifest.')
                for page_info in manifest['pages']:
                    index = page_info['page'] - 1
                    source_output_index = len(result)
                    result.insert_pdf(original, from_page=index, to_page=index)
                    md.extend([f'## Page {index + 1}', ''])
                    body = [f'<h1>Page {index + 1} / {html.escape(translations["language"])}</h1>']
                    for block in page_info['blocks']:
                        body.append(f'<p class="label">{html.escape(block["id"])}</p><p>{escaped(target[block["id"]])}</p>')
                        md.extend([f'### {block["id"]}', '', '**Source**', '', block['source'], '', '**Translation**', '', target[block['id']], ''])
                    if not page_info['blocks']:
                        body.append('<p>Visually reviewed: no translatable text on this page.</p>')
                    story = fitz.Story(html=''.join(body), user_css='body {font-family: sans-serif; font-size:11pt; line-height:1.3;} h1 {font-size:18pt;color:#c7000b;} .label {font-size:8pt;color:#777;} p {overflow-wrap:break-word;}')
                    paper = fitz.paper_rect('a4')
                    def rectfn(number, filled):
                        if number > 2000:
                            raise ValueError('PDF_LAYOUT_LIMIT: translation is too long for one source page.')
                        return paper, paper + (36, 36, -36, -36), None
                    translated_doc = story.write_with_links(rectfn)
                    try:
                        first_translation = len(result)
                        result.insert_pdf(translated_doc)
                        mappings.append(dict(source_page=index + 1, original_output_page=source_output_index + 1,
                                             translation_start=first_translation + 1, translation_end=len(result)))
                    finally:
                        translated_doc.close()
                    image = base64.b64encode(original[index].get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False).tobytes('png')).decode()
                    sections.append(f'<section><h2>Page {index + 1}</h2><div class="pair"><img alt="Source page {index + 1}" src="data:image/png;base64,{image}"><article>{"".join(body)}</article></div></section>')
                result.set_toc([[1, f'Source page {m["source_page"]}', m['original_output_page']] for m in mappings])
                candidate = temp / names[0]
                result.save(candidate, garbage=4, deflate=True)
        finally:
            result.close()
        with open_source(source) as original, open_source(candidate) as reopened:
            if len(reopened) != mappings[-1]['translation_end']:
                raise ValueError('PDF_OUTPUT_PAGE_COUNT: page count changed after writing.')
            for page_info, mapping in zip(manifest['pages'], mappings):
                # Verify every original page still renders identically, including diagrams.
                a = original[page_info['page'] - 1].get_pixmap(matrix=fitz.Matrix(.5, .5), alpha=False)
                b = reopened[mapping['original_output_page'] - 1].get_pixmap(matrix=fitz.Matrix(.5, .5), alpha=False)
                if (a.width, a.height, a.samples) != (b.width, b.height, b.samples):
                    raise ValueError(f'PDF_ORIGINAL_RENDER_CHANGED: page {page_info["page"]}')
                text = ''.join(reopened[i].get_text() for i in range(mapping['translation_start'] - 1, mapping['translation_end']))
                for block in page_info['blocks']:
                    if normalized(target[block['id']]) not in normalized(text):
                        raise ValueError(f'PDF_RENDERED_TEXT_MISSING: {block["id"]}; inspect fonts, layout and supported characters.')
                for index in range(mapping['translation_start'] - 1, mapping['translation_end']):
                    reopened[index].get_pixmap(matrix=fitz.Matrix(.5, .5), alpha=False)
            summary.update(output_pages=len(reopened), mappings=mappings, render_checked=True,
                           original_pages_pixel_checked=True, rendered_translation_coverage=True)
        (temp / names[1]).write_text('\n'.join(md), encoding='utf-8')
        css = 'body{font-family:system-ui,sans-serif;margin:24px;color:#17202a}section{margin-bottom:32px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start}img{width:100%;border:1px solid #ddd}article{overflow-wrap:anywhere}.label{color:#777;font-size:12px}h1{color:#c7000b;font-size:22px}@media(max-width:700px){.pair{grid-template-columns:1fr}}@media print{section{break-before:page}}'
        (temp / names[2]).write_text('<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bilingual document</title><style>' + css + '</style><body>' + ''.join(sections) + '</body></html>', encoding='utf-8')
        expected_hash = sha(candidate)
        summary.update(source_sha256=manifest['sha256'], pdf_sha256=expected_hash,
                       limits='Checks prove extracted-block coverage and file rendering, not semantic translation accuracy or OCR completeness. Visual review is required.')
        write_json(temp / names[3], summary)
        for name in names:
            os.replace(temp / name, out / name)
        if sha(out / names[0]) != expected_hash:
            raise ValueError('PDF_SAVED_HASH: final file differs from validated candidate.')
    print(json.dumps(dict(files=[str(out / n) for n in names], **summary), ensure_ascii=False))


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
