#!/usr/bin/env python3
"""Bounded-context translation jobs for host-native agents. No model SDK or API calls."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile

from pdf_translate import load, sha, validate, write_json

VERSION = 'document-translate/batches-v1'


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def estimate(value):
    """Conservative UTF-8 byte estimate, not an exact provider tokenizer."""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return len(text.encode('utf-8'))


def prefix(text, limit):
    low, high = 0, len(text)
    while low < high:
        mid = (low + high + 1) // 2
        if estimate(text[:mid]) <= limit:
            low = mid
        else:
            high = mid - 1
    return text[:low]


def split_source(text, limit, protected_terms=()):
    chunks = []
    while text:
        head = prefix(text, limit)
        if not head:
            raise ValueError('BATCH_BUDGET_TOO_SMALL: cannot fit one Unicode character.')
        if len(head) < len(text):
            cuts = [head.rfind(marker) + len(marker) for marker in ['\n', ' ', '。', '！', '？', '. ', '; ']]
            cut = max(cuts)
            if cut > len(head) // 2:
                head = head[:cut]
        # Keep shared protected/glossary phrases within one fragment where possible.
        cut = len(head)
        while True:
            previous_cut = cut
            for term in protected_terms:
                if not term:
                    continue
                start = text.find(term, max(0, cut - len(term) + 1))
                if 0 <= start < cut:
                    if start == 0:
                        raise ValueError('BATCH_TERM_TOO_LONG: increase the source/output budget for a protected phrase.')
                    cut = start
            if cut == previous_cut:
                break
        head = text[:cut]
        chunks.append(head)
        text = text[len(head):]
    return chunks


def shared_rules(path, language):
    data = load(path) if path else {}
    if not isinstance(data, dict):
        raise ValueError('BATCH_RULES: rules must be a JSON object.')
    terms = data.get('protected_terms', [])
    if not isinstance(terms, list) or any(not isinstance(x, str) or not x for x in terms):
        raise ValueError('BATCH_RULES: protected_terms must contain nonempty strings.')
    if not isinstance(data.get('glossary', {}), dict):
        raise ValueError('BATCH_RULES: glossary must be an object mapping source to target terms.')
    return dict(language=language, protected_terms=terms, glossary=data.get('glossary', {}),
                rules=data.get('rules', []))


def plan(args):
    manifest_path = Path(args.manifest).resolve()
    manifest = load(manifest_path)
    if sha(manifest['source']) != manifest['sha256']:
        raise ValueError('PDF_SOURCE_CHANGED: re-extract the input.')
    rules = shared_rules(args.rules, args.language)
    if not args.language.strip() or args.agents < 1 or args.agents > 8:
        raise ValueError('BATCH_CONFIG: require a target language and 1..8 agents.')
    if args.context_tokens < 8192 or args.max_output_tokens < 1024 or args.source_budget < 512:
        raise ValueError('BATCH_CONFIG: context/output/source budget is too small.')
    available = args.context_tokens - args.system_reserve - args.safety_reserve - args.max_output_tokens - estimate(rules) - 2048
    budget = min(args.source_budget, available, math.floor((args.max_output_tokens - 1024) / args.expansion_factor))
    if budget < 512 or args.expansion_factor < 1 or min(args.system_reserve, args.safety_reserve) < 0:
        raise ValueError('BATCH_BUDGET_TOO_SMALL: reduce rules/reserves or increase context/output capacity.')
    folder = Path(args.work_dir).resolve()
    if folder.exists() and any(folder.iterdir()):
        raise ValueError('BATCH_PLAN_EXISTS: use status to resume, or choose a new directory.')
    folder.mkdir(parents=True, exist_ok=True)
    identity = dict(schema=VERSION, manifest_sha256=sha(manifest_path), source_sha256=manifest['sha256'],
                    language=args.language, rules=rules, context_tokens=args.context_tokens,
                    max_output_tokens=args.max_output_tokens, task_budget=budget,
                    system_reserve=args.system_reserve, safety_reserve=args.safety_reserve,
                    expansion_factor=args.expansion_factor, agents=args.agents)
    plan_id = digest(identity)
    flat = []
    for page in manifest['pages']:
        for block in page['blocks']:
            if not isinstance(block.get('source'), str) or not block['source'].strip():
                raise ValueError(f'BATCH_SOURCE_EMPTY: {block.get("id")}')
            # Leave room for IDs, JSON metadata and read-only neighbor context.
            parts = split_source(block['source'], max(64, budget - 768), rules['protected_terms'] + list(rules['glossary']))
            for index, source in enumerate(parts):
                flat.append(dict(id=f'{block["id"]}__part_{index + 1:04d}', block_id=block['id'],
                                 page=page['page'], part=index + 1, parts=len(parts), source=source))
    if len({x['id'] for x in flat}) != len(flat):
        raise ValueError('BATCH_DUPLICATE_ID: manifest contains duplicate block IDs.')
    batches, current = [], []
    def flush():
        nonlocal current
        if current:
            batches.append(dict(tasks=current, review_pages=[]))
            current = []
    for task in flat:
        if current and estimate(current + [task]) > budget:
            flush()
        current.append(task)
    flush()
    for page in manifest['pages']:
        if not page['review_required']:
            continue
        owner = next((b for b in batches if any(t['page'] == page['page'] for t in b['tasks'])), None)
        if owner is None:
            owner = dict(tasks=[], review_pages=[]); batches.append(owner)
        owner['review_pages'].append(dict(page=page['page'], expected='checked' if page['blocks'] else 'no_text'))
    if not batches:
        raise ValueError('BATCH_EMPTY_PLAN: manifest has no tasks or review pages.')
    jobs, flat_order = [], [t['id'] for t in flat]
    positions = {key: i for i, key in enumerate(flat_order)}
    for index, batch in enumerate(batches):
        job_id = f'batch-{index + 1:04d}'
        neighbors = {}
        if batch['tasks']:
            first = positions[batch['tasks'][0]['id']]; last = positions[batch['tasks'][-1]['id']]
            if first:
                neighbors['previous_source'] = prefix(flat[first - 1]['source'][::-1], 256)[::-1]
            if last + 1 < len(flat):
                neighbors['next_source'] = prefix(flat[last + 1]['source'], 256)
        request = dict(schema=VERSION, plan_id=plan_id, batch_id=job_id,
                       source=manifest['source'], language=args.language, shared=rules,
                       tasks=batch['tasks'], review_pages=batch['review_pages'], read_only_context=neighbors,
                       max_output_tokens=args.max_output_tokens,
                       instructions='Translate only assigned IDs. Preserve IDs, numbers and protected terms. Read-only neighbors are context only. Visually inspect assigned review pages. Write a candidate JSON; run submit to commit it. Do not read the full manifest, other jobs, or export files.')
        if estimate(request) + args.system_reserve + args.safety_reserve + args.max_output_tokens > args.context_tokens:
            raise ValueError(f'BATCH_CONTEXT_EXCEEDED: {job_id}')
        request_path = folder / 'requests' / f'{job_id}.json'
        write_json(request_path, request)
        jobs.append(dict(id=job_id, request=str(request_path), request_sha256=sha(request_path),
                         result=str(folder / 'results' / f'{job_id}.json'),
                         estimated_input_tokens=estimate(request), fragments=len(batch['tasks']),
                         pages=sorted({t['page'] for t in batch['tasks']} | {p['page'] for p in batch['review_pages']})))
    record = dict(schema=VERSION, plan_id=plan_id, identity=identity, manifest=str(manifest_path),
                  rules_path=str(Path(args.rules).resolve()) if args.rules else None,
                  rules_file_sha256=sha(args.rules) if args.rules else None,
                  suggested_concurrency=min(args.agents, len(jobs)), jobs=jobs)
    write_json(folder / 'plan.json', record)
    write_json(folder / 'shared.json', rules)
    print(json.dumps(dict(plan=str(folder / 'plan.json'), batches=len(jobs), fragments=len(flat),
                          concurrency=record['suggested_concurrency'], task_budget=budget)))


def checked_plan(path):
    p = load(path)
    if p.get('schema') != VERSION or digest(p['identity']) != p.get('plan_id'):
        raise ValueError('BATCH_PLAN_INVALID: version or identity mismatch.')
    if sha(p['manifest']) != p['identity']['manifest_sha256']:
        raise ValueError('BATCH_MANIFEST_CHANGED: create a new plan after source/OCR edits.')
    if sha(load(p['manifest'])['source']) != p['identity']['source_sha256']:
        raise ValueError('PDF_SOURCE_CHANGED: cannot resume an old plan.')
    if p['rules_path'] and sha(p['rules_path']) != p['rules_file_sha256']:
        raise ValueError('BATCH_RULES_CHANGED: create a new plan after changing terminology.')
    return p


def request_for(p, job):
    if sha(job['request']) != job['request_sha256']:
        raise ValueError(f'BATCH_REQUEST_CHANGED: {job["id"]}')
    request = load(job['request'])
    if request['plan_id'] != p['plan_id'] or request['batch_id'] != job['id']:
        raise ValueError('BATCH_REQUEST_ID: wrong job or plan.')
    return request


def validate_result(p, job, data):
    request = request_for(p, job)
    for key, expected in [('plan_id', p['plan_id']), ('batch_id', job['id']),
                          ('request_sha256', job['request_sha256']), ('language', p['identity']['language'])]:
        if data.get(key) != expected:
            raise ValueError(f'BATCH_RESULT_ID: {job["id"]} has incorrect {key}.')
    targets = data.get('translations')
    if not isinstance(targets, dict) or set(targets) != {t['id'] for t in request['tasks']}:
        raise ValueError(f'BATCH_RESULT_COVERAGE: {job["id"]} has missing or extra IDs.')
    for task in request['tasks']:
        value = targets[task['id']]
        if not isinstance(value, str) or not value.strip() or '\x00' in value:
            raise ValueError(f'BATCH_RESULT_EMPTY: {task["id"]}')
        for term in p['identity']['rules']['protected_terms']:
            if term in task['source'] and term not in value:
                raise ValueError(f'BATCH_PROTECTED_TERM: {task["id"]} lacks {term}.')
    expected_reviews = {str(r['page']): r['expected'] for r in request['review_pages']}
    if data.get('page_reviews', {}) != expected_reviews:
        raise ValueError(f'BATCH_REVIEW_REQUIRED: {job["id"]} must review exactly its assigned pages.')
    return request


def submit(args):
    p = checked_plan(args.plan)
    job = next((j for j in p['jobs'] if j['id'] == args.batch), None)
    if not job:
        raise ValueError('BATCH_UNKNOWN: unknown batch ID.')
    data = load(args.candidate)
    validate_result(p, job, data)
    output = Path(job['result']); output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive atomic publish: another worker can never overwrite a committed result.
    fd, temporary = tempfile.mkstemp(prefix='.result-', dir=output.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2); stream.flush(); os.fsync(stream.fileno())
        try:
            os.link(temporary, output)
        except FileExistsError:
            if digest(load(output)) != digest(data):
                raise ValueError('BATCH_RESULT_CONFLICT: committed result differs; resolve explicitly, do not overwrite.')
    finally:
        Path(temporary).unlink(missing_ok=True)
    print(json.dumps(dict(batch=job['id'], result=str(output), status='complete')))


def status(args):
    p = checked_plan(args.plan)
    jobs = []
    for job in p['jobs']:
        record = dict(job)
        try:
            request_for(p, job)
            if Path(job['result']).exists():
                validate_result(p, job, load(job['result'])); record['status'] = 'complete'
            else:
                record['status'] = 'pending'
        except Exception as exc:
            record.update(status='invalid', error=str(exc))
        jobs.append(record)
    print(json.dumps(dict(plan_id=p['plan_id'], concurrency=p['suggested_concurrency'],
                          complete=sum(j['status'] == 'complete' for j in jobs), jobs=jobs), ensure_ascii=False))


def merge(args):
    p = checked_plan(args.plan)
    fragments, by_block, reviews = {}, {}, {}
    for job in p['jobs']:
        if not Path(job['result']).exists():
            raise ValueError(f'BATCH_RESULT_MISSING: {job["id"]}; resume only pending jobs.')
        data = load(job['result']); request = validate_result(p, job, data)
        for task in request['tasks']:
            if task['id'] in fragments:
                raise ValueError('BATCH_DUPLICATE_FRAGMENT: assigned twice.')
            fragments[task['id']] = data['translations'][task['id']]
            by_block.setdefault(task['block_id'], []).append((task['part'], task['parts'], task['id']))
        for page, review in data.get('page_reviews', {}).items():
            if page in reviews:
                raise ValueError('BATCH_DUPLICATE_REVIEW: page assigned twice.')
            reviews[page] = review
    targets = {}
    for key, parts in by_block.items():
        parts.sort()
        if [x[0] for x in parts] != list(range(1, parts[0][1] + 1)) or any(x[1] != len(parts) for x in parts):
            raise ValueError(f'BATCH_PART_COVERAGE: {key}')
        targets[key] = '\n'.join(fragments[x[2]].strip() for x in parts)
    result = dict(language=p['identity']['language'], protected_terms=p['identity']['rules']['protected_terms'],
                  translations=targets, page_reviews=reviews)
    summary = validate(load(p['manifest']), result)
    output = Path(args.output).resolve()
    reserved = {Path(p['manifest']).resolve(), Path(args.plan).resolve(), Path(load(p['manifest'])['source']).resolve()}
    reserved |= {Path(j[k]).resolve() for j in p['jobs'] for k in ['request', 'result']}
    if output in reserved:
        raise ValueError('BATCH_OUTPUT_RESERVED: cannot overwrite inputs, plan, requests or results.')
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.merged-', dir=output.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2); stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, output)
    finally:
        Path(temp).unlink(missing_ok=True)
    print(json.dumps(dict(output=str(output), batches=len(p['jobs']), **summary)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('plan')
    p.add_argument('manifest'); p.add_argument('--language', default='English'); p.add_argument('--rules')
    p.add_argument('--work-dir', required=True); p.add_argument('--agents', type=int, default=3)
    p.add_argument('--context-tokens', type=int, default=128000)
    p.add_argument('--max-output-tokens', type=int, default=8192)
    p.add_argument('--source-budget', type=int, default=8000)
    p.add_argument('--system-reserve', type=int, default=16000)
    p.add_argument('--safety-reserve', type=int, default=16000)
    p.add_argument('--expansion-factor', type=float, default=2.5)
    p = commands.add_parser('status'); p.add_argument('plan')
    p = commands.add_parser('submit'); p.add_argument('plan'); p.add_argument('--batch', required=True); p.add_argument('--candidate', required=True)
    p = commands.add_parser('merge'); p.add_argument('plan'); p.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        globals()[args.command](args)
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr); return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
