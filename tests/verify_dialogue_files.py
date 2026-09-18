"""Real attachment shard placement, private bytes, and owner isolation."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import httpx
import psycopg
from backend.config import load_config, connection_kwargs, DATABASES
from backend.entities import shard_index
config = load_config()
for index, database in enumerate(DATABASES[1:]):
    with psycopg.connect(**connection_kwargs(config, database)) as conn:
        for identifier, body in conn.execute("SELECT block_id,body FROM entities WHERE body->>'kind'='dialogue_file'").fetchall():
            assert shard_index(identifier) == index
            file = config['data_dir'] / 'dialogue-files' / body['filename']
            assert file.is_file() and file.stat().st_size == body['size']
with httpx.Client(base_url=sys.argv[1], trust_env=False) as client:
    client.get('/')
    headers = {'X-XSRFToken': client.cookies['_xsrf']}
    assert client.post('/api/login', json={'login': 'dialogue-other', 'password': 'dialogue-other-password'}, headers=headers).status_code == 200
    assert client.get('/api/dialogue/files/' + sys.argv[2]).status_code == 404
    assert client.post('/api/dialogue/conversations/' + sys.argv[3] + '/files', files={'file': ('private.txt', b'no access')}, headers=headers).status_code == 404
print('Attachment UUID routing, persisted bytes and cross-account read/write denial verified.')
