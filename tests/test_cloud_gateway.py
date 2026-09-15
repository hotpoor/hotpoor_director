"""Cloud gateway against disposable PostgreSQL; no production credentials or network APIs."""
import os
import importlib
import json
import secrets
import subprocess
import sys
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg import sql

from test_integration import service

API_ROOT = Path(os.environ.get('DIRECTOR_API_CHECKOUT', str(Path(__file__).resolve().parents[3] / 'api_xialiwei_com')))


@pytest.fixture(scope='module')
def gateway(service):
    if not API_ROOT.is_dir(): pytest.skip('Companion API checkout is not available')
    pytest.importorskip('fastapi')
    from fastapi.testclient import TestClient
    config, _ = service; pg = config['postgres']
    env = pytest.MonkeyPatch()
    for k, v in {'PGHOST': pg['host'], 'PGPORT': str(pg['port']), 'PGUSER': pg['admin_user'],
                 'PGPASSWORD': pg['admin_password'], 'AUTH_SECRET': secrets.token_hex(32),
                 'DIRECTOR_DATA_DIR': str(config['data_dir'] / 'cloud-runtime')}.items(): env.setenv(k, v)
    with psycopg.connect(host=pg['host'], port=pg['port'], user=pg['admin_user'], password=pg['admin_password'], dbname='postgres', autocommit=True) as conn:
        conn.execute('CREATE ROLE xialiwei_app')
    import os
    for migration in ('init.psql', 'auth.psql', 'director.psql'):
        subprocess.run([str(config['pg_bin'] / 'psql'), '-h', pg['host'], '-p', str(pg['port']), '-U', pg['admin_user'],
            '-d', 'postgres', '-f', str(API_ROOT / 'sql' / migration)], env={**os.environ, 'PGPASSWORD': pg['admin_password']},
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    sys.path.insert(0, str(API_ROOT))
    module = importlib.import_module('app')
    users = []
    for i in range(2):
        identifier = uuid.uuid4().hex; login = 'email:director-test-' + identifier + '@example.com'; token = secrets.token_urlsafe(32)
        with module.db() as conn:
            conn.execute('INSERT INTO auth_accounts(user_id) VALUES(%s)', (identifier,))
            conn.execute('INSERT INTO index_login(login,user_id,email_verified) VALUES(%s,%s,true)', (login, identifier))
            conn.execute('INSERT INTO auth_sessions(token_hash,login,expires_at) VALUES(%s,%s,%s)', (module.digest(token), login, module.now() + 600000))
        users.append({'user_id': identifier, 'login': login, 'token': token})
    try:
        with TestClient(module.app, base_url='https://api.xialiwei.com') as client: yield client, module, users
    finally:
        sys.path.remove(str(API_ROOT)); env.undo()


def login(client, user):
    client.headers.clear(); client.cookies.clear()
    client.cookies.set('__Host-hotpoor_session', user['token'])
    client.headers['Origin'] = 'https://api.xialiwei.com'


def test_device_authorization_scoping_revocation_and_expiry(gateway):
    c, app, users = gateway
    c.cookies.clear(); c.headers.clear()
    start = c.post('/hotpoor/director/auth/device/start', json={'name': '桌面测试'}); assert start.status_code == 200, start.text
    device = start.json()
    assert device['device_secret'] not in device['verification_url']
    poll = {'device_secret': device['device_secret']}
    assert c.post('/hotpoor/director/auth/device/poll', json=poll).json()['status'] == 'pending'
    assert c.post('/hotpoor/director/auth/device/approve', json={'code': device['user_code'], 'expires_at': None}).status_code == 401
    login(c, users[0]); c.headers['Origin'] = 'https://attacker.example'
    assert c.post('/hotpoor/director/auth/device/approve', json={'code': device['user_code'], 'expires_at': None}).status_code == 403
    c.headers['Origin'] = 'https://api.xialiwei.com'
    assert c.post('/hotpoor/director/auth/device/approve', json={'code': device['user_code'], 'expires_at': None}).status_code == 200
    assert c.post('/hotpoor/director/auth/device/approve', json={'code': device['user_code'], 'expires_at': None}).status_code == 409
    with app.db() as db: db.execute('UPDATE director.devices SET last_poll=0 WHERE device_hash=%s', (app.digest(device['device_secret']),))
    c.cookies.clear(); c.headers.clear()
    authorized = c.post('/hotpoor/director/auth/device/poll', json=poll); assert authorized.status_code == 200
    key = authorized.json()['access_key']
    c.headers['Authorization'] = 'Bearer ' + key
    assert c.get('/hotpoor/director/api/me').json()['user_id'] == users[0]['user_id']
    assert c.get('/v1/auth/me').status_code in (401, 404)  # Scoped AK is never a general API session.
    assert c.post('/hotpoor/director/auth/keys', json={'name': 'must use browser login', 'expires_at': None}).status_code == 401
    login(c, users[0]); keys = c.get('/hotpoor/director/auth/keys').json()['keys']; identifier = keys[0]['key_id']
    assert key not in json.dumps(keys) and 'token_hash' not in json.dumps(keys)
    login(c, users[1]); assert c.post('/hotpoor/director/auth/keys/' + identifier + '/revoke', json={}).status_code == 404
    login(c, users[0]); assert c.post('/hotpoor/director/auth/keys/' + identifier + '/revoke', json={}).status_code == 200
    c.cookies.clear(); c.headers.clear(); c.headers['Authorization'] = 'Bearer ' + key
    assert c.get('/hotpoor/director/api/me').status_code == 401


def test_shared_canvas_runtime_owner_isolation_and_static_prefix(gateway):
    c, app, users = gateway
    login(c, users[0])
    page = c.get('/hotpoor/director'); assert page.status_code == 200
    assert '/hotpoor/director/static/studio.js' in page.text and '/hotpoor/director/static/sync.js' in page.text
    assert "'unsafe-inline'" in page.headers['content-security-policy']
    script = c.get('/hotpoor/director/static/studio.js'); assert script.status_code == 200
    assert "request('/hotpoor/director/api/projects'" in script.text
    created = c.post('/hotpoor/director/api/projects', json={'title': '云端真实画布', 'covers': [], 'canvas': {'viewport': {'x': 60, 'y': 60, 'zoom': 1}, 'cards': []}})
    assert created.status_code == 200, created.text
    project_id = created.json()['block_id']
    assert c.get('/hotpoor/director/api/projects/' + project_id).json()['body']['owner_id'] == users[0]['user_id']
    head = c.get('/hotpoor/director/api/sync/head/' + project_id); assert head.status_code == 200, head.text
    assert head.json()['head']['snapshot']['project_id'] == project_id
    login(c, users[1])
    assert c.get('/hotpoor/director/api/projects/' + project_id).status_code == 404
    assert c.get('/hotpoor/director/api/sync/head/' + project_id).json()['head'] is None
    assert c.post('/hotpoor/director/api/settings/comfyui', json={'host': '127.0.0.1', 'port': 8188}).status_code == 403
    # Loopback runtime is not an authentication bypass: the bridge secret is mandatory.
    import httpx
    import director
    runtime_url = director.runtime.apps[users[0]['user_id']]['url']
    assert httpx.get(runtime_url + '/api/projects', trust_env=False).status_code == 403


def test_real_desktop_push_cloud_edit_pull_new_uuid_and_receipt(gateway, service):
    import os
    import socket
    import time
    import httpx
    from contextlib import closing
    from backend.sync_protocol import digest as snapshot_digest
    c, app, users = gateway; config, _ = service
    login(c, users[0])
    key = c.post('/hotpoor/director/auth/keys', json={'name': '双端集成测试', 'expires_at': None}).json()['access_key']
    with closing(socket.socket()) as sock:
        sock.bind(('127.0.0.1', 0)); cloud_port = sock.getsockname()[1]
    directory = config['data_dir'] / 'desktop-sync'; directory.mkdir()
    saved = {k: v for k, v in config.items() if k not in ('data_dir', 'pg_bin')}; saved['postgres'] = {**saved['postgres'], 'mode': 'external'}
    (directory / 'config.json').write_text(json.dumps(saved))
    log = (directory / 'integration.log').open('w')
    cloud = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', str(cloud_port), '--no-access-log'], cwd=API_ROOT,
        env={**os.environ, 'DIRECTOR_DATA_DIR': str(directory / 'cloud')}, stdout=log, stderr=log)
    desktop = None
    try:
        for _ in range(150):
            try:
                if httpx.get(f'http://127.0.0.1:{cloud_port}/health', trust_env=False).status_code == 200: break
            except httpx.TransportError: pass
            time.sleep(.1)
        else: raise AssertionError('cloud failed: ' + (directory / 'integration.log').read_text())
        desktop = subprocess.Popen([sys.executable, 'tests/sync_backend.py', 'serve', '--port', '0', '--desktop'],
            cwd=Path(__file__).resolve().parent.parent,
            env={**os.environ, 'DIRECTOR_DATA_DIR': str(directory), 'DIRECTOR_TEST_CLOUD_URL': f'http://127.0.0.1:{cloud_port}/hotpoor/director'},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True)
        ready = json.loads(desktop.stdout.readline())
        with httpx.Client(base_url=f"http://127.0.0.1:{ready['port']}", trust_env=False, timeout=30) as local:
            local.get('/'); local.headers['X-XSRFToken'] = local.cookies['_xsrf']
            assert local.post('/api/login', json={'login': 'director', 'password': 'a-local-test-password-123'}).status_code == 200
            target = local.post('/api/sync/targets', json={'name': '集成云端', 'url': 'https://cloud.example.com/hotpoor/director', 'access_key': key})
            assert target.status_code == 200, target.text
            target_id = target.json()['targets'][0]['id']; assert key not in target.text
            new = local.post('/api/projects', json={'title': '同步原始版本'}).json(); project_id = new['block_id']
            asset = local.post('/api/assets', files={'file': ('example.png', (Path(__file__).resolve().parent.parent / 'assets/icon.png').read_bytes(), 'image/png')}).json()
            body = new['body']; body['covers'] = [asset['id']]
            card_id = uuid.uuid4().hex
            body['canvas']['cards'] = [{'id': card_id, 'type': 'asset', 'mode': 'media', 'asset_id': asset['id'], 'x': 0, 'y': 0, 'w': 500, 'h': 300}]
            assert local.post('/api/projects/' + project_id, json=body).status_code == 200
            route = '/api/sync/projects/' + project_id + '/targets/' + target_id
            preview = local.post(route, json={'action': 'preview'}); assert preview.status_code == 200, preview.text
            d = preview.json()
            push = local.post(route, json={'action': 'push', 'local_hash': d['local_hash'], 'remote_hash': d['remote_hash']})
            assert push.status_code == 200, push.text
            cloud_id = push.json()['project_id']; assert cloud_id != project_id
            # Re-reading after push must be identical despite UUID remapping and cloud media paths.
            d = local.post(route, json={'action': 'preview'}).json(); assert d['identical'], d
            cloud_base = f'http://127.0.0.1:{cloud_port}/hotpoor/director/api'
            headers = {'Authorization': 'Bearer ' + key}
            project = httpx.get(cloud_base + '/projects/' + cloud_id, headers=headers, trust_env=False).json()
            project['body']['title'] = '线上改过的版本'
            assert httpx.post(cloud_base + '/projects/' + cloud_id, headers={'Cookie': '__Host-hotpoor_session=' + users[0]['token'], 'Origin': 'https://api.xialiwei.com'}, json=project['body'], trust_env=False).status_code == 200
            local_old = local.get('/api/projects/' + project_id).json(); local_old['body']['title'] = '本地也改过的版本'
            assert local.post('/api/projects/' + project_id, json=local_old['body']).status_code == 200
            d = local.post(route, json={'action': 'preview'}).json(); assert d['conflicts']
            blocked = local.post(route, json={'action': 'push', 'local_hash': d['local_hash'], 'remote_hash': d['remote_hash']})
            assert blocked.status_code == 409
            pulled = local.post(route, json={'action': 'pull', 'remote_hash': d['remote_hash']}); assert pulled.status_code == 200, pulled.text
            result = pulled.json(); fresh_id = result['project_id']
            assert fresh_id not in (project_id, cloud_id) and result['pending_receipt'] is False
            assert local.get('/api/projects/' + project_id).json()['body']['title'] == '本地也改过的版本'
            imported = local.get('/api/projects/' + fresh_id).json()
            assert imported['body']['title'] == '线上改过的版本'
            assert imported['body']['canvas']['cards'][0]['id'] != card_id
            assert local.post(route, json={'action': 'pull', 'remote_hash': d['remote_hash']}).json()['project_id'] == fresh_id
            new_route = '/api/sync/projects/' + fresh_id + '/targets/' + target_id
            clean = local.post(new_route, json={'action': 'preview'}); assert clean.status_code == 200, clean.text
            assert clean.json()['identical']
            # The origin mapping receipt is retained online, without another project being created.
            with app.db('xialiwei_api1') as one, app.db('xialiwei_api2') as two:
                receipts = sum(conn.execute("SELECT count(*) AS n FROM director.entities WHERE body->>'kind'='sync_receipt' AND body->'acknowledgement'->>'origin_project_id'=%s", (fresh_id,)).fetchone()['n'] for conn in (one, two))
                assert receipts == 1
    finally:
        if desktop and desktop.poll() is None: desktop.communicate('shutdown\n', timeout=30)
        cloud.terminate(); cloud.wait(timeout=30); log.close()


def test_dedicated_cloud_database_migration_is_repeatable(gateway, service):
    config, _ = service; pg = config['postgres']
    with psycopg.connect(host=pg['host'], port=pg['port'], user=pg['admin_user'], password=pg['admin_password'], dbname='postgres', autocommit=True) as conn:
        if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname='director_app'").fetchone(): conn.execute('CREATE ROLE director_app')
    for _ in range(2):
        subprocess.run([str(config['pg_bin'] / 'psql'), '-h', pg['host'], '-p', str(pg['port']), '-U', pg['admin_user'],
            '-d', 'postgres', '-f', str(API_ROOT / 'sql/director-runtime.psql')],
            env={**os.environ, 'PGPASSWORD': pg['admin_password']}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)


def test_user_selected_key_expiration_and_management(gateway):
    c, app, users = gateway
    login(c, users[0])
    route = '/hotpoor/director/auth/keys'
    assert c.post(route, json={'name': 'missing choice'}).status_code == 422
    for invalid in (app.now() - 1, True, 'tomorrow', 253402300800000):
        assert c.post(route, json={'name': 'invalid', 'expires_at': invalid}).status_code == 422
    expires = app.now() + 7 * 86400000
    tokens = []
    for label, expiration in [('permanent', None), ('calendar date', expires)]:
        response = c.post(route, json={'name': label, 'expires_at': expiration})
        assert response.status_code == 200, response.text
        assert response.json()['expires_at'] == expiration
        tokens.append(response.json()['access_key'])
    listed = c.get(route).json()['keys']
    permanent = next(k for k in listed if k['label'] == 'permanent')
    dated = next(k for k in listed if k['label'] == 'calendar date')
    assert permanent['expires_at'] is None and dated['expires_at'] == expires
    for token in tokens:
        c.cookies.clear(); c.headers.clear(); c.headers['Authorization'] = 'Bearer ' + token
        assert c.get('/hotpoor/director/api/me').status_code == 200
    login(c, users[1])
    endpoint = route + '/' + permanent['key_id'] + '/expiration'
    assert c.post(endpoint, json={'expires_at': expires}).status_code == 404
    login(c, users[0])
    assert c.post(endpoint, json={'expires_at': expires}).status_code == 200
    assert c.post(endpoint, json={'expires_at': None}).status_code == 200
    with app.db() as db:
        db.execute('UPDATE director.access_keys SET expires_at=%s WHERE key_id=%s', (app.now()-1, dated['key_id']))
    c.cookies.clear(); c.headers.clear(); c.headers['Authorization'] = 'Bearer ' + tokens[1]
    assert c.get('/hotpoor/director/api/me').status_code == 401
    login(c, users[0])
    assert c.post(route + '/' + permanent['key_id'] + '/revoke', json={}).status_code == 200
    assert c.post(endpoint, json={'expires_at': None}).status_code == 404
    c.cookies.clear(); c.headers.clear(); c.headers['Authorization'] = 'Bearer ' + tokens[0]
    assert c.get('/hotpoor/director/api/me').status_code == 401
