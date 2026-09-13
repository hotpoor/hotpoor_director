"""Opt-in GPU cancellation test; requires an empty ComfyUI queue."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import httpx

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / '.test-data' / 'studio-smoke'


def main():
    with httpx.Client(trust_env=False) as probe:
        queue = probe.get('http://127.0.0.1:8188/queue').json()
        assert not queue['queue_running'] and not queue['queue_pending'], 'Existing jobs: postpone this test'
    with (DIRECTORY / 'queue-backend.log').open('w') as errors:
        process = subprocess.Popen([sys.executable, '-m', 'backend', 'serve', '--port', '0', '--desktop'],
            cwd=ROOT, env={**os.environ, 'DIRECTOR_DATA_DIR':str(DIRECTORY)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            ready = json.loads(process.stdout.readline())
            with httpx.Client(base_url=f"http://127.0.0.1:{ready['port']}", timeout=90, trust_env=False) as client:
                client.get('/')
                client.headers['X-XSRFToken'] = client.cookies['_xsrf']
                def post(path, data):
                    response = client.post(path, json=data)
                    response.raise_for_status()
                    return response.json()
                post('/api/login', {'login':'studio-smoke','password':'local-ui-test-password-123'})
                card_id = uuid.uuid4().hex
                project = post('/api/projects', {'title':'Cancellation API smoke', 'canvas':{
                    'viewport':{'x':0,'y':0,'zoom':1}, 'cards':[{'id':card_id,'type':'image',
                    'mode':'text','x':0,'y':0,'w':480,'h':720,'drafts':{}}]}})
                path = '/api/projects/' + project['block_id']
                payload = dict(card_id=card_id,mode='text',model='z-image-turbo',
                    prompt='A ceramic cup on a wooden table',width=512,height=512,steps=40,seed=42)
                def submit(**changes):
                    row = post(path+'/generate', {**payload,'request_id':uuid.uuid4().hex,**changes})
                    assert row['body']['status']=='queued', row
                    return row
                running = submit()
                pending = submit(steps=4,width=256,height=256)
                successor = submit(steps=4,width=256,height=256)
                rows=client.get(path+'/history').json()
                assert rows['reorder_available']
                original=[pending['block_id'],successor['block_id']]
                desired=list(reversed(original))
                post(path+'/queue-order', {'order':desired,'previous':original})
                queue=client.get('http://127.0.0.1:8188/queue').json()
                assert [q[1] for q in sorted(queue['queue_pending'])]==[successor['body']['prompt_id'],pending['body']['prompt_id']]
                assert client.post(path+'/queue-order',json={'order':original,'previous':original}).status_code==409
                assert client.post(path+'/queue-order',json={'order':[running['block_id']],'previous':desired}).status_code==409
                print('PASS: real pending queue reordered with stable prompt IDs; stale order and running job rejected.',flush=True)
                def cancel(job):
                    return post('/api/generations/'+job['block_id']+'/cancel', {})
                cancel(pending)
                cancel(pending)
                print('Pending cancellation accepted.', flush=True)
                assert client.post('/api/generations/'+uuid.uuid4().hex+'/cancel', json={}).status_code==404
                def history():
                    return {r['block_id']:r for r in client.get(path+'/history').json()['history']}
                for _ in range(300):
                    if history()[running['block_id']]['body'].get('progress',{}).get('phase')=='sampling':
                        break
                    time.sleep(1)
                else:
                    raise TimeoutError('No sampling progress')
                cancel(running)
                print('Targeted stop requested during sampling.', flush=True)
                for attempt in range(300):
                    rows = history()
                    states = [rows[j['block_id']]['body']['status'] for j in (running,pending,successor)]
                    if states == ['cancelled','cancelled','completed']:
                        break
                    if attempt%10==0:
                        print(states, flush=True)
                    time.sleep(1)
                else:
                    raise TimeoutError(str(states))
                assert cancel(successor)['body']['status']=='completed'
                assert cancel(running)['body']['status']=='cancelled'
                (DIRECTORY/'queue-records.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
                print('PASS: pending removal, running interruption, repeat cancellation, unknown job 404, successor completion, preserved completed output.',flush=True)
        finally:
            if process.poll() is None:
                process.communicate('shutdown\n', timeout=180)


if __name__ == '__main__':
    main()
