"""Test-only transport adapter; all application/database/sync operations remain real."""
import hashlib
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend import sync
original = sync.remote

async def remote(target, path, body=None, auth=True):
    return await original({**target, 'internal_url': os.environ['DIRECTOR_TEST_CLOUD_URL']}, path, body, auth)

async def upload(target, raw, mime, name):
    sha = hashlib.sha256(raw).hexdigest()
    return {'url': 'https://cdn.example.com/' + target['id'] + '/' + sha, 'name': name, 'mime': mime,
        'size': len(raw), 'sha256': sha, 'verified_at': sync.stamp()}

sync.remote = remote
sync.upload_bytes = upload
from backend.__main__ import main
main()
