import asyncio
from contextlib import asynccontextmanager
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
import wave

import pytest
from backend.speech import SpeechManager, validate_runtime, validate_text, wav_metadata, settings_path


def runtime(tmp_path, kind='base'):
    root = tmp_path/'model'; (root/'speech_tokenizer').mkdir(parents=True, exist_ok=True)
    (root/'config.json').write_text(json.dumps({'model_type':'qwen3_tts','tts_model_type':kind,'tts_model_size':'1b7','talker_config':{'spk_id':{'aiden':1}}}))
    for name in ['model.safetensors','speech_tokenizer/model.safetensors']: (root/name).write_text('test')
    return validate_runtime({'python':sys.executable,'model_path':str(root),'device':'cpu'})


def wav(path):
    with wave.open(str(path),'wb') as file:
        file.setparams((1,2,24000,0,'NONE','not compressed')); file.writeframes(bytes(4800))


class Pool:
    def __init__(self): self.records={}
    @asynccontextmanager
    async def connection(self): yield self
    async def execute(self, sql, params, **kwargs):
        if sql.startswith('INSERT'): self.records[params[0]]=params[1].obj
        elif sql.startswith('UPDATE'): self.records.setdefault(params[1],{}).update(params[0].obj)


def test_runtime_modes_and_invalid_weights(tmp_path):
    base=runtime(tmp_path); assert base['mode']=='clone'
    custom=runtime(tmp_path,'custom_voice'); assert custom['speakers']==['aiden']
    with pytest.raises(ValueError): runtime(tmp_path,'voice_design')
    with pytest.raises(ValueError): validate_runtime({'python':'relative','model_path':str(tmp_path),'device':'cpu'})
    with pytest.raises(ValueError): settings_path({'data_dir':tmp_path},'../evil')


def test_input_validation_and_wav_truncation(tmp_path):
    base=runtime(tmp_path); data={'text':'Hello','language':'English','reference_id':'a'*32}
    assert validate_text(data,base)['mode']=='clone'
    for patcher in [{'text':''},{'text':'x'*601},{'language':'Unknown'},{'reference_id':'../private'},{'instruction':'angry'}]:
        with pytest.raises(ValueError): validate_text(data|patcher,base)
    custom=runtime(tmp_path,'custom_voice')
    assert validate_text(data|{'speaker':'aiden','instruction':'Warm'},custom)['mode']=='custom'
    with pytest.raises(ValueError):validate_text(data|{'speaker':'unknown'},custom)
    path=tmp_path/'sample.wav';wav(path);assert wav_metadata(path)['duration_ms']==100
    path.write_bytes(path.read_bytes()[:-2])
    with pytest.raises(ValueError):wav_metadata(path)


def test_manager_persists_wav_asset_and_task_metadata(tmp_path):
    async def run():
        pool=Pool();manager=SpeechManager();rt=runtime(tmp_path)
        original=asyncio.create_subprocess_exec
        script="import sys,json,wave;r=json.load(sys.stdin);f=wave.open(r['output_path'],'wb');f.setparams((1,2,24000,0,'NONE','none'));f.writeframes(bytes(4800));f.close();print(json.dumps({'ok':True}))"
        async def spawn(*args,**kwargs): return await original(sys.executable,'-c',script,**kwargs)
        with patch('backend.speech.asyncio.create_subprocess_exec',spawn):
            await manager.run(pool,{'data_dir':tmp_path},'a'*32,'b'*32,rt,{'text':'Hello','language':'English','mode':'clone'})
        assert pool.records['b'*32]['status']=='succeeded'
        asset=pool.records['b'*32]['asset']; assert (tmp_path/'media'/f"{asset['id']}.wav").exists()
        assert pool.records[asset['id']]['owner_id']=='a'*32
        assert asset['duration_ms']==100
        assert not list((tmp_path/'media').glob('*.pending.wav'))
    asyncio.run(run())


def test_running_cancel_kills_worker_and_retains_no_output(tmp_path):
    async def run():
        pool=Pool();manager=SpeechManager();rt=runtime(tmp_path);original=asyncio.create_subprocess_exec
        async def spawn(*args,**kwargs): return await original(sys.executable,'-c','import time;time.sleep(60)',**kwargs)
        with patch('backend.speech.asyncio.create_subprocess_exec',spawn):
            task=asyncio.create_task(manager.run(pool,{'data_dir':tmp_path},'a'*32,'c'*32,rt,{'text':'Hello','language':'English'}));manager.tasks['c'*32]=task
            for _ in range(100):
                if manager.processes:break
                await asyncio.sleep(.01)
            assert manager.processes
            process=manager.processes['c'*32];await manager.cancel('c'*32)
            assert process.returncode is not None
        assert pool.records['c'*32]['status']=='cancelled'
        assert not list((tmp_path/'media').iterdir())
    asyncio.run(run())


def test_default_runtime_and_per_user_override(tmp_path):
    from backend.speech import load_runtime
    first=runtime(tmp_path);(tmp_path/'.speech-default.json').write_text(json.dumps(first))
    config={'data_dir':tmp_path}
    assert load_runtime(config,'a'*32)['mode']=='clone'
    second=runtime(tmp_path/'custom','custom_voice');settings_path(config,'a'*32).write_text(json.dumps(second))
    assert load_runtime(config,'a'*32)['mode']=='custom'
    assert load_runtime(config,'b'*32)['mode']=='clone'
    assert settings_path(config,'a'*32)!=settings_path(config,'b'*32)


def test_small_custom_voice_does_not_silently_drop_style(tmp_path):
    value=runtime(tmp_path,'custom_voice')
    cfg=Path(value['model_path'])/'config.json'
    body=json.loads(cfg.read_text());body['tts_model_size']='0b6';cfg.write_text(json.dumps(body))
    value=validate_runtime(value)
    assert not value['supports_instruction']
    with pytest.raises(ValueError,match='不支持说话方式'):
        validate_text({'text':'Hello','language':'English','speaker':'aiden','instruction':'Warm'},value)
