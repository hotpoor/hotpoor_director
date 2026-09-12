"""Opt-in local GPU check; uses the isolated studio-smoke database."""
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
    env = {**os.environ, 'DIRECTOR_DATA_DIR': str(DIRECTORY)}
    with (DIRECTORY / 'generation-backend.log').open('w') as errors:
        process = subprocess.Popen([sys.executable, '-m', 'backend', 'serve', '--port', '0', '--desktop'],
                                   cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            ready = json.loads(process.stdout.readline())
            with httpx.Client(base_url=f"http://127.0.0.1:{ready['port']}", timeout=90, trust_env=False) as client:
                client.get('/')
                client.headers['X-XSRFToken'] = client.cookies['_xsrf']
                login = client.post('/api/login', json={'login':'studio-smoke','password':'local-ui-test-password-123'})
                login.raise_for_status()
                def post(path, data):
                    r = client.post(path, json=data)
                    r.raise_for_status()
                    return r.json()
                card_id = uuid.uuid4().hex
                source = (ROOT / 'assets/icon.png').read_bytes()
                upload = client.post('/api/assets', files={'file':('reference.png', source, 'image/png')})
                upload.raise_for_status()
                asset = upload.json()['id']
                project = post('/api/projects', {'title':'Generation API smoke', 'canvas':{'viewport':{'x':0,'y':0,'zoom':1},'cards':[
                    {'id':card_id,'type':'image','mode':'image','x':0,'y':0,'w':480,'h':720,'drafts':{'image':{'refs':[asset]}}}]}})
                path = '/api/projects/' + project['block_id']
                payload = {'request_id':uuid.uuid4().hex,'card_id':card_id,'mode':'image','model':'z-image-turbo',
                           'prompt':'A monochrome cinema emblem on a dark background','width':256,'height':256,'steps':4,'seed':42,'denoise':.5,'refs':[asset]}
                job = post(path + '/generate', payload)
                assert job['body']['status'] == 'queued', job['body']
                assert post(path + '/generate', payload)['block_id'] == job['block_id']
                print('Generation API submitted; duplicate request reused the same job.', flush=True)
                observed_progress = False
                for attempt in range(1200):
                    response = client.get(path + '/history');response.raise_for_status()
                    record = response.json()['history'][0]
                    progress = record['body'].get('progress', {})
                    if progress.get('phase') == 'sampling':
                        observed_progress = True
                        print('Real sampling progress:', progress, flush=True)
                    if record['body']['status'] in ('completed','failed'):
                        assert record['body']['status'] == 'completed', record['body'].get('error')
                        assert observed_progress, 'No real sampling progress observed'
                        media = client.get('/api/outputs/' + record['block_id'] + '/0')
                        assert media.status_code == 200 and media.headers['content-type'].startswith('image/')
                        assert record['body']['usage']['tokens'] is None
                        (DIRECTORY / 'generated.png').write_bytes(media.content)
                        (DIRECTORY / 'generation-record.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
                        print('PASS: reference upload, image-to-image generation, persisted history, private output, idempotency, and honest token usage.', flush=True)
                        return
                    if attempt % 6 == 0:
                        print('Waiting for local GPU:', record['body']['status'], flush=True)
                    time.sleep(1)
                raise TimeoutError('Generation did not finish within 20 minutes')
        finally:
            if process.poll() is None:
                process.communicate('shutdown\n', timeout=180)


if __name__ == '__main__':
    main()
