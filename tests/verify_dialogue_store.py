"""Inspect the smoke DB routing and seed a restart-interrupted turn."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import psycopg
from psycopg.types.json import Jsonb
from backend.config import load_config, connection_kwargs, DATABASES
from backend.entities import shard_index
config = load_config()
rows = []
for index, database in enumerate(DATABASES[1:]):
    with psycopg.connect(**connection_kwargs(config, database)) as conn:
        result = conn.execute("SELECT block_id,body FROM entities WHERE body->>'kind' IN ('dialogue','dialogue_pack')").fetchall()
        for identifier, body in result:
            assert shard_index(identifier) == index
            assert 'fixture-first' not in json.dumps(body) and 'fixture-second' not in json.dumps(body)
        rows.extend(result)
conversation = next((i, b) for i, b in rows if b['kind'] == 'dialogue')
packs = {i: b for i, b in rows if b['kind'] == 'dialogue_pack'}
assert len(packs) == 2
assert len({shard_index(i) for i in packs}) == 2
assert sum(len(b['turns']) for b in packs.values()) == 28
identifier, body = conversation
assert body['first_id'] in packs and body['last_id'] in packs
assert packs[body['first_id']]['next_id'] == body['last_id']
assert packs[body['last_id']]['prev_id'] == body['first_id']
assert packs[body['last_id']]['turns'][-1]['status'] == 'failed'
# Force a persisted running status with no live task, equivalent to restarting a worker.
pack = packs[body['last_id']];pack['turns'][-1]['status'] = 'running';body['pending_id'] = pack['turns'][-1]['id'];body['pending_started_at'] = 0
for record_id, record_body in [(body['last_id'], pack), (identifier, body)]:
    with psycopg.connect(**connection_kwargs(config, DATABASES[1+shard_index(record_id)])) as conn:
        conn.execute('UPDATE entities SET body=%s WHERE block_id=%s', (Jsonb(record_body), record_id))
# A second local login must never see or append to the first account's conversations.
if len(sys.argv) > 2:
    import httpx, uuid
    from backend.auth import HASHER
    other = uuid.uuid4().hex
    with psycopg.connect(**connection_kwargs(config, DATABASES[0])) as conn:
        conn.execute('INSERT INTO index_login(login,user_id) VALUES (%s,%s)', ('dialogue-other', other))
        conn.execute('INSERT INTO auth_credentials(user_id,password_hash) VALUES (%s,%s)', (other, HASHER.hash('dialogue-other-password')))
    with httpx.Client(base_url=sys.argv[2], trust_env=False) as client:
        client.get('/')
        headers = {'X-XSRFToken': client.cookies['_xsrf']}
        assert client.post('/api/login', json={'login': 'dialogue-other', 'password': 'dialogue-other-password'}, headers=headers).status_code == 200
        assert client.get('/api/dialogue/conversations').json()['conversations'] == []
        assert client.get('/api/dialogue/conversations/' + identifier).status_code == 404
        assert client.get('/api/dialogue/conversations/' + identifier + '?cursor=' + body['last_id']).status_code == 404
        assert client.post('/api/dialogue/conversations/' + identifier, json={'request_id': uuid.uuid4().hex, 'question': 'unauthorized', 'credential_id': 'first', 'model': 'gpt-6-astra'}, headers=headers).status_code == 404
print('Real PostgreSQL: conversation and two linked packs are routed by their own UUID modulo; no credentials in history.')
