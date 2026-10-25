"""Exercise context budgets, Unicode splitting, concurrent publishing, resume and strict merge."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
spec = importlib.util.spec_from_file_location('batches', ROOT/'tools/translation_batches.py')
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)


class BatchesTests(unittest.TestCase):
    def call(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(ROOT/'tools/translation_batches.py'), *map(str,args)], capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stderr)
        return result

    def fixture(self, root, text='Digital Power PCS. ' * 600):
        source=root/'source.pdf'; source.write_bytes(b'immutable source fixture')
        manifest=dict(schema='document-translate/pdfmath-v1', source=str(source), sha256=mod.sha(source), page_count=3,
                      pages=[dict(page=1,review_required=False,blocks=[dict(id='p1-b1',source=text)]),
                             dict(page=2,review_required=True,blocks=[dict(id='p2-b1',source='Scan content.')]),
                             dict(page=3,review_required=True,blocks=[])])
        path=root/'manifest.json';mod.write_json(path,manifest)
        rules=root/'rules.json';mod.write_json(rules,dict(protected_terms=['PCS'],glossary={'储能':'energy storage'}))
        self.call('plan',path,'--rules',rules,'--work-dir',root/'jobs','--source-budget','1200')
        plan=root/'jobs/plan.json'
        return path,plan,mod.load(plan)

    def candidate(self,p,job):
        req=mod.load(job['request'])
        return dict(plan_id=p['plan_id'],batch_id=job['id'],request_sha256=job['request_sha256'],language='English',
                    translations={t['id']:'Translated PCS '+t['source'] for t in req['tasks']},
                    page_reviews={str(r['page']):r['expected'] for r in req['review_pages']})

    def test_unicode_budget_resume_concurrent_merge(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest,plan,p=self.fixture(root,text='储能🙂 PCS 数据 99.99%。\n' * 500)
            flat=[t for j in p['jobs'] for t in mod.load(j['request'])['tasks'] if t['block_id']=='p1-b1']
            self.assertEqual(''.join(t['source'] for t in flat),mod.load(manifest)['pages'][0]['blocks'][0]['source'])
            for job in p['jobs']:
                request=mod.load(job['request'])
                self.assertLessEqual(mod.estimate(request)+16000+16000+8192,128000)
            self.assertGreater(len(p['jobs']),3)
            self.call('merge',plan,'--output',root/'merged.json',ok=False)
            self.assertFalse((root/'merged.json').exists())
            def submit(job):
                path=root/f'{job["id"]}-candidate.json';mod.write_json(path,self.candidate(p,job))
                self.call('submit',plan,'--batch',job['id'],'--candidate',path)
                return path
            # Real concurrent CLI processes publish only their own results.
            with ThreadPoolExecutor(max_workers=3) as workers: list(workers.map(submit,p['jobs']))
            status=json.loads(self.call('status',plan).stdout)
            self.assertEqual(status['complete'],len(p['jobs']))
            job=p['jobs'][0]; candidate=submit(job)  # identical submit is idempotent
            conflict=self.candidate(p,job);first=next(iter(conflict['translations']));conflict['translations'][first]+=' Different.'
            mod.write_json(candidate,conflict)
            self.call('submit',plan,'--batch',job['id'],'--candidate',candidate,ok=False)
            merged=root/'merged.json';self.call('merge',plan,'--output',merged)
            output=mod.load(merged);self.assertEqual(set(output['translations']),{'p1-b1','p2-b1'})
            self.assertEqual(output['page_reviews'],{'2':'checked','3':'no_text'})
            self.assertEqual(output['translations']['p1-b1'], '\n'.join(('Translated PCS '+t['source']).strip() for t in flat))
            # Delete just one result: resume schedules only that job.
            Path(job['result']).unlink();status=json.loads(self.call('status',plan).stdout)
            self.assertEqual(sum(j['status']=='pending' for j in status['jobs']),1)
            self.call('merge',plan,'--output',root/'incomplete.json',ok=False)

    def test_depth_identity_and_review_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest,_,_=self.fixture(root,text='Source {v0} PCS.')
            for depth,checks in [('direct',[]),('reviewed',['accuracy']),('multi-pass',['accuracy','terminology','final'])]:
                directory=root/depth
                self.call('plan',manifest,'--work-dir',directory,'--depth',depth)
                plan=directory/'plan.json';p=mod.load(plan)
                self.assertEqual(p['identity']['depth'],depth)
                for job in p['jobs']:
                    data=self.candidate(p,job);data['quality_checks']=checks
                    req=mod.load(job['request']);self.assertEqual(req['depth'],depth)
                    if checks:
                        path=root/'missing-review.json';bad=dict(data,quality_checks=[]);mod.write_json(path,bad)
                        self.call('submit',plan,'--batch',job['id'],'--candidate',path,ok=False)
                    path=root/'depth-candidate.json';mod.write_json(path,data)
                    self.call('submit',plan,'--batch',job['id'],'--candidate',path)
                output=root/(depth+'.json');self.call('merge',plan,'--output',output)
                self.assertEqual(mod.load(output)['depth'],depth)
                self.assertTrue(all(v==checks for v in mod.load(output)['quality_checks'].values()))

    def test_stale_and_invalid_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest,plan,p=self.fixture(root)
            job=p['jobs'][0];data=self.candidate(p,job);key=next(iter(data['translations']))
            for issue in ['wrong_plan','wrong_language','wrong_request','missing','extra','empty','term','review']:
                broken=json.loads(json.dumps(data))
                if issue=='wrong_plan':broken['plan_id']='old'
                if issue=='wrong_language':broken['language']='German'
                if issue=='wrong_request':broken['request_sha256']='stale'
                if issue=='missing':del broken['translations'][key]
                if issue=='extra':broken['translations']['not_assigned']='extra'
                if issue=='empty':broken['translations'][key]=''
                if issue=='term':broken['translations'][key]='protected term omitted'
                if issue=='review':broken['page_reviews']={'99':'checked'}
                path=root/'bad.json';mod.write_json(path,broken)
                self.call('submit',plan,'--batch',job['id'],'--candidate',path,ok=False)
                self.assertFalse(Path(job['result']).exists())
            # Request corruption must be visible in status, not silently scheduled as valid.
            request=Path(job['request']);original=request.read_bytes();request.write_bytes(original+b' ')
            status=json.loads(self.call('status',plan).stdout);self.assertEqual(status['jobs'][0]['status'],'invalid')
            request.write_bytes(original)
            rules=root/'rules.json';rules.write_text('{}')
            self.call('status',plan,ok=False)

    def test_protected_phrase_boundaries(self):
        phrase='Digital Power PCS'
        source=('prefix '*5+phrase+' tail ')*20
        chunks=mod.split_source(source,60,[phrase])
        self.assertEqual(''.join(chunks),source)
        self.assertEqual(sum(chunk.count(phrase) for chunk in chunks),20)
        with self.assertRaisesRegex(ValueError,'BATCH_TERM_TOO_LONG'):
            mod.split_source('A'*100,64,['A'*100])

    def test_small_budget_and_plan_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);manifest,plan,p=self.fixture(root,'Small source')
            self.call('plan',manifest,'--work-dir',root/'too-small','--context-tokens','16000',ok=False)
            self.call('plan',manifest,'--work-dir',root/'jobs',ok=False)
            # Source changes invalidate all resume/merge actions.
            Path(mod.load(manifest)['source']).write_bytes(b'changed')
            self.call('status',plan,ok=False)


if __name__=='__main__': unittest.main()
