"""Register an existing local Qwen3-TTS runtime as the workstation default."""
import argparse
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.speech import validate_runtime
from backend.config import load_config

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--python',required=True)
parser.add_argument('--model-path',required=True)
parser.add_argument('--device',choices=['cpu','mps','cuda:0'],default='cpu')
args=parser.parse_args()
runtime=validate_runtime({'python':args.python,'model_path':args.model_path,'device':args.device})
config=load_config();file=config['data_dir']/'.speech-default.json'
if file.exists():
    import time
    file.replace(file.with_suffix(f'.backup-{time.time_ns()}'))
staging=file.with_suffix('.tmp');staging.write_text(json.dumps(runtime,indent=2));staging.chmod(0o600);os.replace(staging,file)
print(json.dumps({'registered':True,'model_id':runtime['model_id'],'device':runtime['device'],'runtime_file':str(file)}))
