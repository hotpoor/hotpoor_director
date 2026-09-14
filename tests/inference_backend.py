"""Standalone mocked backend for UI smoke tests; never loaded by the application."""
import asyncio
import base64
import json
import os
from pathlib import Path
import socket
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from backend.config import load_config
from backend import inference
from backend.__main__ import main

config=load_config()
# Each smoke invocation owns an isolated database port and data directory.
if not (config['data_dir']/'postgres').exists():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));config['postgres']['port']=sock.getsockname()[1]
    (config['data_dir']/'config.json').write_text(json.dumps({k:v for k,v in config.items() if k not in ('data_dir','pg_bin')}))

fake_key='fake-ui-key-not-a-real-credential'
calls={}
async def fake_api(key,path,data=None):
    if key not in (fake_key,'second-ui-key-not-real'):raise inference.ProviderError('API Key 无效',401)
    if path=='/v1/models':
        return {'data':[{'id':m['remote_model'],'type':m['type']} for m in inference.BY_ID.values() if key==fake_key or m['type']=='video']}
    if data is None and path.startswith('/v2/video/tasks?'):return {'tasks':[]}
    if path=='/v1/images/generations':
        return {'data':[{'b64_json':base64.b64encode((Path(__file__).resolve().parent.parent/'assets/icon.png').read_bytes()).decode(),'output_format':'png'}]*data.get('sequential_image_generation_options',{}).get('max_images',1), 'usage':{'generated_images':1,'total_tokens':16}}
    if data is not None and path.endswith('/video/generate'):
        remote_id='mvt-'+str(len(calls)+1);calls[remote_id]=0
        return {'task':{'id':remote_id,'status':'pending'}}
    if data is None and '/video/tasks/' in path:
        remote_id=path.rsplit('/',1)[1];calls[remote_id]=calls.get(remote_id,0)+1
        if calls[remote_id]<2:return {'task':{'id':remote_id,'status':'processing'}}
        return {'task':{'id':remote_id,'status':'completed','outputs':['https://fixture.example/video.mp4'],'usage':{'total_tokens':32}}}
    raise AssertionError('Unexpected mock route')

async def fake_download(url,path):
    import av
    with av.open(str(path),'w') as container:
        stream=container.add_stream('libx264',rate=24);stream.width=64;stream.height=64;stream.pix_fmt='yuv420p'
        for _ in range(12):
            frame=av.VideoFrame(64,64,'yuv420p')
            for plane in frame.planes:plane.update(bytes([90])*plane.buffer_size)
            for packet in stream.encode(frame):container.mux(packet)
        for packet in stream.encode():container.mux(packet)

inference.api=fake_api
inference.download=fake_download
inference.InferenceManager.poll_intervals={'v1':.05,'v2':.05}
# Cloud-storage smoke tests exercise real signing; external object services are simulated.
from backend import cloud_storage
cloud_storage.probe=lambda profile:None
cloud_storage.verify_object=lambda *args:None
async def fake_public(*args):pass
cloud_storage.verify_public=fake_public
async def fake_read_cloud_image(body):return (Path(__file__).resolve().parent.parent/'assets/icon.png').read_bytes()
cloud_storage.read_cloud_image=fake_read_cloud_image
main()
