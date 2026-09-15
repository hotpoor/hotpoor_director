"""Export the reviewed Director runtime into the API repository (no local data/secrets)."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('destination', type=Path)
args = parser.parse_args()
destination = args.destination.resolve() / 'director_runtime'
destination.mkdir(parents=True, exist_ok=True)
files = []
for path in sorted((root / 'backend').rglob('*')):
    if not path.is_file() or '__pycache__' in path.parts or path.suffix == '.pyc': continue
    relative = path.relative_to(root)
    target = destination / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, target)
    files.append({'path': str(relative), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
(destination / 'manifest.json').write_text(json.dumps({'source': 'hotpoor/hotpoor_director', 'files': files}, ensure_ascii=False, indent=2) + '\n')
print(f'Exported {len(files)} source files to {destination}')
