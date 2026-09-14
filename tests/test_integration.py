import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import sys
import threading
import tempfile
import time

import httpx
import psycopg
import pytest

from backend.auth import create_user
from backend.config import DATABASES, connection_kwargs, load_config
from backend.database import initialize, make_pool

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope='module')
def service():
    test_root = ROOT / '.test-data'
    test_root.mkdir(exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='postgres-', dir=test_root))
    previous = os.environ.get('DIRECTOR_DATA_DIR')
    os.environ['DIRECTOR_DATA_DIR'] = str(directory)
    config = load_config()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    config['postgres']['port'] = port
    saved = {k: v for k, v in config.items() if k not in ('data_dir', 'pg_bin')}
    with (directory / 'config.json').open('r+', encoding='utf-8') as stream:
        stream.write(json.dumps(saved))
        stream.truncate()
    errors = (directory / 'backend.log').open('w', encoding='utf-8')
    executable = os.environ.get('DIRECTOR_BACKEND_EXE')
    command = [executable] if executable else [sys.executable, '-m', 'backend']
    process = subprocess.Popen([*command, 'serve', '--port', '0', '--desktop'],
                               cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True,
                               env={**os.environ, 'DIRECTOR_BOOTSTRAP_TOKEN': 'test-bootstrap-only',
                                    'DIRECTOR_PG_BIN': str(config['pg_bin'])})
    lines = queue.Queue()
    threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
    try:
        line = lines.get(timeout=360)
        assert line, (directory / 'backend.log').read_text()
        ready = json.loads(line)
        if os.name == 'nt':
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        url = f"http://127.0.0.1:{ready['port']}"
        with httpx.Client(base_url=url, trust_env=False) as client:
            client.get('/')
            headers = {'X-XSRFToken': client.cookies['_xsrf']}
            values = {'login': 'Director', 'password': 'a-local-test-password-123'}
            assert client.get('/api/setup').json() == {'needs_setup': True, 'can_setup': False}
            assert client.post('/api/setup', json=values, headers=headers).status_code == 403
            client.cookies.set('director_bootstrap', 'test-bootstrap-only')
            assert client.post('/api/setup', json=values, headers=headers).status_code == 200
            client.cookies.set('director_bootstrap', 'test-bootstrap-only')
            assert client.post('/api/setup', json=values, headers=headers).status_code == 400
        yield config, url
    finally:
        if process.poll() is None:
            process.communicate('shutdown\n', timeout=180)
        errors.close()
        if previous is None:
            os.environ.pop('DIRECTOR_DATA_DIR', None)
        else:
            os.environ['DIRECTOR_DATA_DIR'] = previous


def test_exact_entity_schema_and_millisecond_updates(service):
    config, _ = service
    for database in DATABASES[1:]:
        with psycopg.connect(**connection_kwargs(config, database)) as conn:
            tables = conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public'").fetchall()
            assert tables == [('entities',)]
            columns = conn.execute("SELECT column_name,data_type FROM information_schema.columns WHERE table_name='entities' ORDER BY ordinal_position").fetchall()
            assert columns == [('block_id', 'character varying'), ('body', 'jsonb'), ('createtime', 'bigint'), ('updatetime', 'bigint')]
            row = conn.execute("INSERT INTO entities(body) VALUES ('{\"title\":\"scene\"}') RETURNING block_id,createtime,updatetime").fetchone()
            assert len(row[0]) == 32 and 0 <= int(row[0], 16) < 2**128
            assert abs(time.time() * 1000 - row[1]) < 5000
            time.sleep(.02)
            changed = conn.execute("UPDATE entities SET body=body || '{\"shot\":2}'::jsonb WHERE block_id=%s RETURNING createtime,updatetime,body", (row[0],)).fetchone()
            assert changed[0] == row[1] and changed[1] > row[2]
            assert changed[2]['shot'] == 2


def test_invalid_uuid_rejected(service):
    config, _ = service
    with psycopg.connect(**connection_kwargs(config, DATABASES[1])) as conn:
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO entities(block_id) VALUES ('not-a-uuid')")


def test_auth_schema_and_password_storage(service):
    config, _ = service
    with psycopg.connect(**connection_kwargs(config, DATABASES[0])) as conn:
        columns = conn.execute("SELECT column_name FROM information_schema.columns WHERE table_name='index_login' ORDER BY ordinal_position").fetchall()
        assert columns == [('login',), ('user_id',), ('createtime',), ('updatetime',)]
        encoded = conn.execute('SELECT password_hash FROM auth_credentials').fetchone()[0]
        assert encoded.startswith('$argon2id$')
        assert 'a-local-test-password' not in encoded
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute("INSERT INTO index_login(login,user_id) VALUES ('director',replace(gen_random_uuid()::text,'-',''))")


def test_login_xsrf_logout_and_replay(service):
    config, url = service
    with httpx.Client(base_url=url, trust_env=False) as client:
        assert client.get('/api/me').status_code == 401
        assert client.get('/').status_code == 200
        payload = {'login': 'DIRECTOR', 'password': 'a-local-test-password-123'}
        assert client.post('/api/login', json=payload).status_code == 403
        headers = {'X-XSRFToken': client.cookies['_xsrf']}
        assert client.post('/api/login', json={**payload, 'password': 'wrong'}, headers=headers).status_code == 401
        response = client.post('/api/login', json=payload, headers=headers)
        assert response.status_code == 200
        assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=Strict' in response.headers['set-cookie']
        assert client.get('/api/me').json()['login'] == 'director'
        token = client.cookies['director_session']
        with psycopg.connect(**connection_kwargs(config, DATABASES[0])) as conn:
            stored = conn.execute('SELECT token_hash FROM auth_sessions').fetchone()[0]
            assert stored != token and len(stored) == 64
        assert client.post('/api/logout', json={}, headers=headers).status_code == 200
        client.cookies.set('director_session', token)
        assert client.get('/api/me').status_code == 401


def test_rate_limit(service):
    _, url = service
    with httpx.Client(base_url=url, trust_env=False) as client:
        client.get('/')
        headers = {'X-XSRFToken': client.cookies['_xsrf']}
        for _ in range(10):
            assert client.post('/api/login', json={'login':'missing','password':'wrong'}, headers=headers).status_code == 401
        assert client.post('/api/login', json={'login':'missing','password':'wrong'}, headers=headers).status_code == 429


def test_concurrent_jsonb_writes_and_repeat_init(service):
    config, _ = service
    def insert(index):
        with psycopg.connect(**connection_kwargs(config, DATABASES[2])) as conn:
            return conn.execute('INSERT INTO entities(body) VALUES (jsonb_build_object(\'index\',%s::int)) RETURNING block_id', (index,)).fetchone()[0]
    with ThreadPoolExecutor(max_workers=8) as executor:
        ids = list(executor.map(insert, range(24)))
    assert len(set(ids)) == 24
    initialize(config)
    with psycopg.connect(**connection_kwargs(config, DATABASES[2])) as conn:
        assert conn.execute('SELECT count(*) FROM entities WHERE block_id=ANY(%s)', (ids,)).fetchone()[0] == 24


@contextmanager
def signed_in(url, login='director', password='a-local-test-password-123'):
    client = httpx.Client(base_url=url, trust_env=False)
    client.get('/')
    client.headers['X-XSRFToken'] = client.cookies['_xsrf']
    assert client.post('/api/login', json={'login': login, 'password': password}).status_code == 200
    try:
        yield client
    finally:
        client.close()


def test_private_projects_canvas_and_conflicts(service):
    config, url = service
    async def second_user():
        pool = make_pool(config)
        await pool.open(wait=True)
        try:
            await create_user(pool, 'second-director', 'second-test-password-123')
        finally:
            await pool.close()
    asyncio.run(second_user())
    with signed_in(url) as first, signed_in(url, 'second-director', 'second-test-password-123') as second:
        row = first.post('/api/projects', json={'title': '雨夜来信', 'subtitle': '短片', 'description': '电影测试'}).json()
        assert len(row['block_id']) == 32 and row['body']['revision'] == 1
        path = '/api/projects/' + row['block_id']
        assert second.get(path).status_code == 404
        assert second.get(path + '/history').status_code == 404
        assert not second.get('/api/projects').json()['projects']
        stale = json.loads(json.dumps(row['body']))
        card_id = 'a' * 32
        row['body']['canvas']['cards'] = [{'id': card_id, 'type': 'image', 'mode': 'text', 'x': -250, 'y': 100, 'w': 480, 'h': 860, 'drafts': {'text': {'prompt': 'a tree', 'refs': []}}, 'pins': [], 'pinLimit': 2}]
        updated = first.post(path, json=row['body'])
        assert updated.status_code == 200, updated.text
        assert updated.json()['body']['revision'] == 2
        assert updated.json()['createtime'] == row['createtime']
        assert first.post(path, json=stale).status_code == 409
        assert second.post(path, json=updated.json()['body']).status_code == 404
        assert first.get(path).json()['body']['canvas']['cards'][0]['x'] == -250
        bad = updated.json()['body']
        bad['canvas']['cards'][0]['w'] = -1
        assert first.post(path, json=bad).status_code == 400
        assert first.post(path + '/generate', json={'card_id': card_id, 'request_id': 'b'*32, 'mode': 'reference', 'model': 'z-image-turbo'}).status_code == 400


def test_private_asset_upload_and_owner_checks(service):
    _, url = service
    with signed_in(url) as first, signed_in(url, 'second-director', 'second-test-password-123') as second:
        source = (ROOT / 'assets/icon.png').read_bytes()
        result = first.post('/api/assets', files={'file': ('cover.png', source, 'image/png')})
        assert result.status_code == 200, result.text
        asset = result.json()['id']
        assert first.get('/api/assets/' + asset).content == source
        assert second.get('/api/assets/' + asset).status_code == 404
        assert second.post('/api/projects', json={'title':'stolen', 'covers':[asset]}).status_code == 404
        assert first.post('/api/assets', files={'file': ('bad.svg', b'<svg/>', 'image/svg+xml')}).status_code == 400
        assert first.post('/api/projects', json={'title':'multi-cover', 'covers':[asset,asset]}).status_code == 200


def test_generation_records_are_private(service):
    config, url = service
    with signed_in(url) as first, signed_in(url, 'second-director', 'second-test-password-123') as second:
        project = first.post('/api/projects', json={'title':'history'}).json()
        owner = first.get('/api/me').json()['user_id']
        with psycopg.connect(**connection_kwargs(config, DATABASES[2])) as conn:
            row = conn.execute("INSERT INTO entities(body) VALUES (%s::jsonb) RETURNING block_id", (json.dumps({'kind':'generation', 'owner_id':owner, 'project_id':project['block_id'], 'status':'failed', 'outputs':[]}),)).fetchone()
        assert first.get('/api/projects/' + project['block_id'] + '/history').json()['history'][0]['block_id'] == row[0]
        assert second.get('/api/outputs/' + row[0] + '/0').status_code == 404


def test_imported_media_cards_and_range_requests(service):
    import io
    import wave
    _, url = service
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(8000)
        audio.writeframes(bytes(16000))
    source = buffer.getvalue()
    with signed_in(url) as first, signed_in(url, 'second-director', 'second-test-password-123') as second:
        result = first.post('/api/assets', files={'file':('test.wav', source, 'audio/wav')})
        assert result.status_code == 200, result.text
        asset = result.json()
        assert asset['mime'] == 'audio/wav' and asset['size'] == len(source)
        path = asset['url']
        partial = first.get(path, headers={'Range':'bytes=10-49'})
        assert partial.status_code == 206 and partial.content == source[10:50]
        assert partial.headers['content-range'] == f'bytes 10-49/{len(source)}'
        assert first.get(path, headers={'Range':'bytes=-20'}).content == source[-20:]
        assert first.get(path, headers={'Range':'bytes=999999-'}).status_code == 416
        assert int(first.head(path).headers['content-length']) == len(source)
        assert second.get(path, headers={'Range':'bytes=0-5'}).status_code == 404
        body={'title':'素材项目','canvas':{'viewport':{'x':0,'y':0,'zoom':1},'cards':[{'id':'c'*32,'type':'asset','mode':'media','asset_id':asset['id'],'x':0,'y':0,'w':420,'h':240,'mime':'video/mp4','name':'spoof'}]}}
        saved = first.post('/api/projects', json=body)
        assert saved.status_code == 200, saved.text
        card = saved.json()['body']['canvas']['cards'][0]
        assert card['mime']=='audio/wav' and card['name']=='test.wav'
        assert second.post('/api/projects', json=body).status_code == 404
        assert first.post('/api/projects',json={'title':'invalid cover','covers':[asset['id']]}).status_code == 400


def test_connections_stay_in_their_project(service):
    _, url = service
    with signed_in(url) as client:
        a={'id':'d'*32,'type':'image','mode':'text','x':0,'y':0,'w':480,'h':600,'hiddenJobs':['a'*32]}
        b={**a,'id':'e'*32,'x':600}
        body={'title':'connected canvas','canvas':{'viewport':{'x':0,'y':0,'zoom':1},'cards':[a,b],'connections':[{'id':'f'*32,'source':a['id'],'target':b['id']}]}}
        result=client.post('/api/projects',json=body)
        assert result.status_code==200,result.text
        saved=result.json();assert client.get('/api/projects/'+saved['block_id']).json()['body']['canvas']['connections']==body['canvas']['connections']
        for target in [a['id'],'0'*32,[]]:
            invalid=json.loads(json.dumps(body));invalid['canvas']['connections'][0]['target']=target
            assert client.post('/api/projects',json=invalid).status_code==400
        duplicate=json.loads(json.dumps(body));duplicate['canvas']['connections'].append({**body['canvas']['connections'][0],'id':'1'*32})
        assert client.post('/api/projects',json=duplicate).status_code==400

        assert client.get('/api/projects/'+saved['block_id']).json()['body']['canvas']['cards'][0]['hiddenJobs']==['a'*32]
        invalid=json.loads(json.dumps(body));invalid['canvas']['cards'][0]['hiddenJobs']=[{}]
        assert client.post('/api/projects',json=invalid).status_code==400


def test_cloud_settings_project_and_private_local_outputs(service):
    config,url=service
    from psycopg.types.json import Jsonb
    with httpx.Client(base_url=url,trust_env=False) as anonymous:
        assert anonymous.get('/api/settings/service-inference').status_code==401
    with signed_in(url) as client:
        assert client.get('/api/settings/service-inference').json()['configured'] is False
        # Invalid params must fail without contacting the paid cloud API.
        model='si:dola-seedream-5-0-pro-260628'
        card={'id':'c'*32,'type':'image','mode':'text','model':model,'x':0,'y':0,'w':480,'h':600,
              'drafts':{'text':{'model':model,'prompt':'a scene','size':'1K','refs':[]}}}
        response=client.post('/api/projects',json={'title':'Cloud persistence','canvas':{'viewport':{'x':0,'y':0,'zoom':1},'cards':[card]}})
        assert response.status_code==200,response.text
        project=response.json();project_id=project['block_id']
        payload={'card_id':card['id'],'request_id':'d'*32,'model':model,'mode':'text','prompt':'a scene','size':'1K'}
        assert client.post(f'/api/projects/{project_id}/generate',json=payload).status_code==400
        from backend.inference import save_key
        save_key(config,'fake-integration-key')
        assert 'api_key' not in client.get('/api/settings/service-inference').json()
        assert client.post(f'/api/projects/{project_id}/generate',json={**payload,'size':'BAD'}).status_code==400
        saved=client.get('/api/projects/'+project_id).json()
        assert saved['body']['canvas']['cards'][0]['drafts']['text']['size']=='1K'
        job_id='e'*32;filename=job_id+'-0.mp4'
        directory=config['data_dir']/'generated';directory.mkdir(exist_ok=True);(directory/filename).write_bytes(b'0123456789')
        owner=client.get('/api/me').json()['user_id']
        body={'kind':'generation','provider':'service-inference','owner_id':owner,'project_id':project_id,'card_id':card['id'],
              'model':model,'type':'video','status':'completed','outputs':[{'filename':filename,'mime':'video/mp4'}]}
        with psycopg.connect(**connection_kwargs(config,DATABASES[2])) as conn:
            conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)',(job_id,Jsonb(body)))
        output=client.get('/api/outputs/'+job_id+'/0',headers={'Range':'bytes=2-4'})
        assert output.status_code==206 and output.content==b'234'
        assert client.get('/api/outputs/'+job_id+'/0',headers={'Range':'bytes=999-'}).status_code==416
        assert client.get(f'/api/projects/{project_id}/history').json()['history'][0]['body']['provider']=='service-inference'
        with httpx.Client(base_url=url,trust_env=False) as anonymous:
            assert anonymous.get('/api/outputs/'+job_id+'/0').status_code==401
        assert client.post('/api/settings/service-inference',json={'clear':True}).status_code==200
