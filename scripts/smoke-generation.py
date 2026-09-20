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
    model = os.environ.get('DIRECTOR_TEST_MODEL', 'z-image-turbo')
    mode = os.environ.get('DIRECTOR_TEST_MODE', 'image')
    standard = model == 'z-image'
    video = model in ('minimax-h3-ref2va', 'ltx-2.5')
    turbo = model == 'minimax-h3-ref2va' and os.environ.get('DIRECTOR_TEST_TURBO') == '1'
    suffix = '-'+model+'-'+mode if video else '-standard-' + mode if standard else ''
    if turbo:
        suffix += '-turbo'
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
                    {'id':card_id,'type':'video' if video else 'image','mode':mode,'x':0,'y':0,'w':480,'h':720,'drafts':{'image':{'refs':[asset]}}}]}})
                path = '/api/projects/' + project['block_id']
                payload = {'request_id':uuid.uuid4().hex,'card_id':card_id,'mode':mode,'model':model,
                           'prompt':'A monochrome cinema emblem on a dark background','width':512 if standard else 256,'height':512 if standard else 256,'steps':11 if model=='ltx-2.5' else 20 if video else 30 if standard else 4,'duration':1,'seed':42,'denoise':.5,'refs':[asset], 'negative_prompt':'blurry, low quality', 'cfg':4}
                if model=='minimax-h3-ref2va':
                    payload['turbo_mode'] = turbo
                    if turbo:
                        payload['steps'] = 4
                        for invalid in [{'steps':20}, {'turbo_mode':'true'}]:
                            assert client.post(path+'/generate',json={**payload,**invalid}).status_code == 400
                    payload['prompt']='A ceramic cup next to the cinema emblem. Use <Picture 1> and <Picture 2> as visual references. Slow camera movement.'
                    extra=client.post('/api/assets',files={'file':('second.png',(ROOT/'.test-data/studio-smoke/generated.png').read_bytes(),'image/png')});extra.raise_for_status();payload['refs'].append(extra.json()['id'])
                if os.environ.get('DIRECTOR_TEST_MULTIMODAL'):
                    sys.path.insert(0, str(ROOT))
                    from backend.reference_media import prepare_reference
                    source_video = DIRECTORY / 'generated-ltx-2.5-image.mp4'
                    audio_file = DIRECTORY / 'reference-audio.wav'
                    prepare_reference(source_video, audio_file, 'audio', 1, 256, 256)
                    for file, mime in [(source_video, 'video/mp4'), (audio_file, 'audio/wav')]:
                        extra = client.post('/api/assets', files={'file': (file.name, file.read_bytes(), mime)})
                        extra.raise_for_status()
                        payload['refs'].append(extra.json()['id'])
                    payload['prompt'] = 'Use <Picture 1> and <Picture 2> for the emblem and cup. Follow the gentle camera motion in <Video 1> and ambient sound in <Audio 1>.'
                    saved = project['body']
                    saved['canvas']['cards'][0]['drafts'] = {'reference': {'model': model, 'refs': payload['refs']}}
                    post(path, saved)
                    reopened = client.get(path).json()
                    info = reopened['body']['canvas']['cards'][0]['drafts']['reference']['ref_info']
                    assert [info[r]['mime'].split('/')[0] for r in payload['refs']] == ['image', 'image', 'video', 'audio']
                    for invalid_refs in [payload['refs'][-2:-1]*4, payload['refs'][-1:]*4]:
                        assert client.post(path+'/generate', json={**payload, 'refs': invalid_refs}).status_code == 400
                    suffix += '-multimodal'
                if video:
                    for invalid in [{'mode':'reference' if model=='ltx-2.5' else 'image'}, {'refs':[]}, {'refs':[asset]*9}, {'width':288}] if model=='ltx-2.5' else [{'mode':'image'},{'refs':[]},{'refs':[asset]*9}]:
                        assert client.post(path+'/generate',json={**payload,**invalid}).status_code==400
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
                        if turbo:
                            assert record['body']['params']['turbo_mode'] is True
                            assert record['body']['params']['steps'] == 4
                        if standard:
                            assert record['body']['model'] == model
                            assert record['body']['params']['negative_prompt'] == payload['negative_prompt']
                            assert record['body']['params']['cfg'] == 4
                        assert observed_progress, 'No real sampling progress observed'
                        media = client.get('/api/outputs/' + record['block_id'] + '/0')
                        assert media.status_code == 200 and media.headers['content-type'].startswith('video/' if video else 'image/')
                        assert record['body']['usage']['tokens'] is None
                        (DIRECTORY / ('generated'+suffix+('.mp4' if video else '.png'))).write_bytes(media.content)
                        (DIRECTORY / ('generation-record'+suffix+'.json')).write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
                        print(f'PASS: {model} / {mode}, real progress, persisted history, private output, idempotency, and honest token usage.', flush=True)
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
