from contextlib import contextmanager
import copy
import json
import uuid

import httpx
import pytest

from backend import sync_protocol as p
from test_integration import service


def uid(): return uuid.uuid4().hex


def snapshot():
    project, card, chat, pack, asset, material, edge, image, job = [uid() for _ in range(9)]
    project_body = {'kind': 'project', 'title': '版本保留测试', 'subtitle': '', 'description': '', 'covers': [asset],
        'canvas': {'viewport': {'x': 60, 'y': 60, 'zoom': 1}, 'cards': [
            {'id': card, 'type': 'chat', 'mode': 'chat', 'chat_id': chat, 'x': 0, 'y': 0, 'w': 500, 'h': 600},
            {'id': image, 'type': 'image', 'mode': 'text', 'x': 600, 'y': 0, 'w': 500, 'h': 600,
             'pins': [job], 'drafts': {'text': {'prompt': project, 'refs': [asset]}}}],
            'connections': [{'id': edge, 'source': card, 'target': image}]}}
    return {'version': 1, 'project_id': project, 'records': {project: project_body,
        chat: {'kind': 'chat', 'project_id': project, 'head_id': pack, 'tail_id': pack, 'batch_size': 50, 'message_count': 1, 'pack_count': 1},
        pack: {'kind': 'chat_pack', 'project_id': project, 'chat_id': chat, 'prev_id': None, 'next_id': None, 'capacity': 50,
            'messages': [{'id': material, 'text': project, 'attachments': [{'source': 'asset', 'id': asset, 'url': '/api/assets/' + asset,
                'review': {'kind': 'image', 'shapes': [{'type': 'rect', 'x': .1, 'y': .2, 'w': .2, 'h': .2}]}}]}]},
        asset: {'kind': 'asset', 'name': '图片', 'mime': 'image/png', 'size': 32, 'remote_url': 'https://cdn.example.com/a.png'},
        job: {'kind': 'generation', 'project_id': project, 'card_id': image, 'status': 'completed', 'provider': 'service-inference',
            'type': 'image', 'model': 'test', 'outputs': [{'remote_url': 'https://cdn.example.com/output.png', 'mime': 'image/png'}]}}}


def test_fresh_uuid_copy_preserves_all_references_and_comment_text():
    source = snapshot(); before = copy.deepcopy(source); owner = uid()
    result, mapping = p.fresh_copy(source, owner)
    assert source == before
    assert set(result['records']).isdisjoint(source['records'])
    assert all(b['owner_id'] == owner for b in result['records'].values())
    project = result['records'][result['project_id']]
    assert project['canvas']['cards'][1]['drafts']['text']['prompt'] == source['project_id']
    chat_id = project['canvas']['cards'][0]['chat_id']; chat = result['records'][chat_id]
    pack = result['records'][chat['tail_id']]
    assert pack['chat_id'] == chat_id and pack['messages'][0]['text'] == source['project_id']
    assert pack['messages'][0]['attachments'][0]['url'] == '/api/assets/' + project['covers'][0]
    assert project['canvas']['connections'][0]['source'] == project['canvas']['cards'][0]['id']
    canonical = p.remap({'version': 1, 'project_id': result['project_id'], 'records': {i: p.portable(b) for i, b in result['records'].items()}}, {v: k for k, v in mapping.items()})
    assert canonical == source  # Canonical hash must survive an unlimited number of round trips.


def test_diff_is_three_way_and_ignores_card_array_reordering():
    base = {'cards': [{'id': 'a', 'prompt': 'a'}, {'id': 'b', 'prompt': 'b'}]}
    local = {'cards': [{'id': 'b', 'prompt': 'b'}, {'id': 'a', 'prompt': 'local'}]}
    remote = {'cards': [{'id': 'a', 'prompt': 'remote'}, {'id': 'b', 'prompt': 'b'}]}
    d = p.compare(base, local, remote)
    assert len(d['conflicts']) == 1 and d['conflicts'][0]['path'] == '/cards/a/prompt'
    remote['cards'][0]['prompt'] = 'a'; remote['cards'][1]['prompt'] = 'other'
    assert not p.compare(base, local, remote)['conflicts']


@pytest.mark.parametrize('url', ['http://api.example.com/a', 'https://user:pass@api.example.com/a', 'https://api.example.com/a?key=x', 'https://api.example.com/a/../b', 'https://api.example.com/%2e%2e/a'])
def test_endpoint_rejects_credentials_and_ambiguous_paths(url):
    with pytest.raises(ValueError): p.endpoint(url)


def test_missing_references_and_machine_paths_are_rejected():
    s = snapshot(); asset = s['records'][s['project_id']]['covers'][0]
    del s['records'][asset]
    with pytest.raises(ValueError, match='关联实体'): p.validate(s)
    s = snapshot(); s['records'][s['project_id']]['comfy_url'] = 'http://127.0.0.1:8188'
    with pytest.raises(ValueError, match='私有字段'): p.validate(s)


@contextmanager
def client_for(service):
    client = httpx.Client(base_url=service[1], trust_env=False)
    client.get('/'); client.headers['X-XSRFToken'] = client.cookies['_xsrf']
    assert client.post('/api/login', json={'login': 'director', 'password': 'a-local-test-password-123'}).status_code == 200
    try: yield client
    finally: client.close()


def test_receive_cas_idempotency_fresh_ids_and_audited_history(service):
    with client_for(service) as c:
        s = snapshot(); lineage = uid(); request = {'snapshot': s, 'lineage': lineage, 'request_id': uid(), 'expected_hash': None}
        first = c.post('/api/sync/receive', json=request); assert first.status_code == 200, first.text
        a = first.json(); assert a['project_id'] != s['project_id']
        assert c.post('/api/sync/receive', json=request).json() == a
        head = c.get('/api/sync/head/' + lineage).json()['head']; assert head['hash'] == p.digest(s)
        assert head['snapshot'] == s
        current = c.get('/api/projects/' + a['project_id']).json()
        current['body']['title'] = '云端新编辑'
        updated = c.post('/api/projects/' + a['project_id'], json=current['body']); assert updated.status_code == 200, updated.text
        request['request_id'] = uid(); request['expected_hash'] = a['hash']
        conflict = c.post('/api/sync/receive', json=request); assert conflict.status_code == 409
        assert c.get('/api/projects/' + a['project_id']).json()['body']['title'] == '云端新编辑'
        request['expected_hash'] = c.get('/api/sync/head/' + lineage).json()['head']['hash']
        second = c.post('/api/sync/receive', json=request); assert second.status_code == 200, second.text
        assert second.json()['project_id'] != a['project_id']
        assert c.get('/api/projects/' + a['project_id']).status_code == 200
        events = c.get('/api/sync/projects/' + a['project_id'] + '/timeline').json()['events']
        assert any(any(x['path'] == '/title' and x.get('after') == '云端新编辑' for x in e['changes']) for e in events)
        # Read and mutation access remains scoped by login ownership.
        c.post('/api/logout', json={})
        assert c.get('/api/sync/head/' + lineage).status_code == 401
        assert c.post('/api/sync/receive', json=request).status_code == 401


def test_rich_comment_embedded_media_reference_remaps_but_plain_uuid_text_does_not():
    s = snapshot(); asset = s['records'][s['project_id']]['covers'][0]
    pack = next(b for b in s['records'].values() if b['kind'] == 'chat_pack')
    message = pack['messages'][0]
    message.update(format='html', content='<img src="/api/assets/' + asset + '"><p>' + s['project_id'] + '</p>')
    result, mapping = p.fresh_copy(s, uid())
    changed = next(b for b in result['records'].values() if b['kind'] == 'chat_pack')['messages'][0]
    assert '/api/assets/' + mapping[asset] in changed['content']
    assert '<p>' + s['project_id'] + '</p>' in changed['content']


@pytest.mark.parametrize('corrupt', [False, True])
def test_imported_reference_download_checks_checksum_before_caching(tmp_path, corrupt):
    import asyncio
    import hashlib
    from contextlib import asynccontextmanager
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, patch
    from backend.workspace import ensure_local_asset
    data = b'test image content'; identifier = uid(); conn = SimpleNamespace(execute=AsyncMock())
    @asynccontextmanager
    async def connection(): yield conn
    handler = SimpleNamespace(settings={'config': {'data_dir': tmp_path}}, projects=SimpleNamespace(connection=connection))
    asset = {'block_id': identifier, 'body': {'kind': 'asset', 'filename': '', 'remote_url': 'https://cdn.example.com/a.png',
        'size': len(data), 'mime': 'image/png', 'sha256': '0' * 64 if corrupt else hashlib.sha256(data).hexdigest()}}
    async def download(url, destination): destination.write_bytes(data)
    with patch('backend.inference.download', side_effect=download):
        if corrupt:
            with pytest.raises(ValueError, match='校验和'): asyncio.run(ensure_local_asset(handler, asset))
            conn.execute.assert_not_awaited(); assert not (tmp_path / 'media' / (identifier + '.png')).exists()
        else:
            path = asyncio.run(ensure_local_asset(handler, asset)); assert path.read_bytes() == data
            assert asset['body']['filename'] == path.name
            conn.execute.assert_awaited_once()
