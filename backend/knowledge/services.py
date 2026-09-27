"""Optionally start an existing local Qdrant installation without taking ownership."""
import json
from pathlib import Path
import subprocess
import time
import urllib.request


def ensure_qdrant(home):
    root = Path(home).expanduser().resolve()

    def healthy():
        try:
            # This managed installation uses the standard local Qdrant port.
            with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    'http://127.0.0.1:6333/', timeout=2) as response:
                return json.load(response).get('title') == 'qdrant - vector search engine'
        except (OSError, ValueError):
            return False

    if healthy():
        return
    binary = root / 'bin' / 'qdrant'
    if not binary.is_file() or not (root / 'config.yaml').is_file():
        raise RuntimeError(f'Qdrant installation missing at {root}')
    with (root / 'server.log').open('ab') as log:
        child = subprocess.Popen([str(binary), '--config-path', str(root / 'config.yaml'),
                                  '--disable-telemetry'], cwd=root, stdout=log, stderr=log,
                                 stdin=subprocess.DEVNULL, start_new_session=True)
    (root / 'server.pid').write_text(str(child.pid))
    for _ in range(40):
        if healthy():
            return
        if child.poll() is not None:
            raise RuntimeError(f'Qdrant startup failed; see {root / "server.log"}')
        time.sleep(.25)
    raise RuntimeError('Qdrant startup health check timed out')
