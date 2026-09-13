"""Install the local queue adapter, then restart ComfyUI when its queue is idle."""
import argparse
from pathlib import Path
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('comfy_root', type=Path)
args = parser.parse_args()
root = args.comfy_root.resolve()
if not (root / 'server.py').is_file() or not (root / 'custom_nodes').is_dir():
    parser.error('Expected a ComfyUI source directory')
source = Path(__file__).resolve().parents[1] / 'comfy_extensions' / 'director_queue'
target = root / 'custom_nodes' / 'director_queue'
target.mkdir(exist_ok=True)
for name in ('__init__.py', 'ordering.py'):
    shutil.copy2(source / name, target / name)
print('Queue extension installed. Restart ComfyUI only after pending/running jobs finish.')
