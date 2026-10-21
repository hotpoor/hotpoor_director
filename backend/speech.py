"""Independent local Qwen3-TTS dubbing. No cloud fallback or model installation."""
import asyncio
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import uuid
import wave

from psycopg.types.json import Jsonb
import tornado.web

from backend.workspace import PrivateHandler, owned, ensure_local_asset, ID

LANGUAGES = ['Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']
ACTIVE = ('queued', 'running')


def validate_runtime(value):
    if not isinstance(value, dict) or value.get('device') not in ('cpu', 'mps', 'cuda:0'):
        raise ValueError('请选择 CPU、Apple GPU 或 NVIDIA GPU')
    for key in ('python', 'model_path'):
        if not isinstance(value.get(key), str) or not Path(value[key]).is_absolute():
            raise ValueError('Python 和模型目录必须是绝对路径')
    if not Path(value['python']).is_file():
        raise ValueError('Python 不存在')
    directory = Path(value['model_path'])
    cfg = json.loads((directory / 'config.json').read_text())
    if not isinstance(cfg, dict) or cfg.get('model_type') != 'qwen3_tts' or cfg.get('tts_model_type') not in ('base', 'custom_voice') or cfg.get('tts_model_size') not in ('0b6', '1b7'):
        raise ValueError('请选择 Qwen3-TTS Base 克隆模型或 CustomVoice 预设音色模型')
    if not all((directory / name).is_file() for name in ('model.safetensors', 'speech_tokenizer/model.safetensors')):
        raise ValueError('模型或语音编码器权重不完整')
    return {key: value[key] for key in ('python', 'model_path', 'device')} | {
        'mode': 'clone' if cfg['tts_model_type'] == 'base' else 'custom',
        'speakers': list(cfg.get('talker_config', {}).get('spk_id', {})),
        'supports_instruction': cfg['tts_model_type']=='custom_voice' and cfg['tts_model_size']=='1b7',
        'model_id': f"Qwen/Qwen3-TTS-12Hz-{'1.7B' if cfg['tts_model_size']=='1b7' else '0.6B'}-{'Base' if cfg['tts_model_type']=='base' else 'CustomVoice'}"}


def settings_path(config, owner):
    if not ID.fullmatch(owner): raise ValueError('无效用户')
    return config['data_dir'] / f'.speech-{owner}.json'


def load_runtime(config, owner):
    file = settings_path(config, owner)
    if not file.exists(): file = config['data_dir'] / '.speech-default.json'
    return validate_runtime(json.loads(file.read_text())) if file.exists() else None


def validate_text(data, runtime):
    if not isinstance(data.get('text'), str) or not 1 <= len(data['text'].strip()) <= 600:
        raise ValueError('配音台词需为 1–600 个字符')
    if data.get('language') not in LANGUAGES:
        raise ValueError('请选择支持的配音语言')
    result = {'text': data['text'].strip(), 'language': data['language'], 'mode': runtime['mode']}
    if runtime['mode'] == 'custom':
        if data.get('speaker') not in runtime['speakers']: raise ValueError('请选择模型支持的预设音色')
        instruction = data.get('instruction', '')
        if not isinstance(instruction, str) or len(instruction) > 1000: raise ValueError('说话方式最多 1000 个字符')
        if instruction and not runtime.get('supports_instruction'): raise ValueError('此模型不支持说话方式指令，请留空或使用 1.7B CustomVoice')
        result.update(speaker=data['speaker'], instruction=instruction)
    else:
        if not isinstance(data.get('reference_id'), str) or not ID.fullmatch(data['reference_id']): raise ValueError('请选择 WAV 参考音频')
        transcript = data.get('reference_text', '')
        if not isinstance(transcript, str) or len(transcript) > 10000: raise ValueError('参考录音原文过长')
        if data.get('instruction'): raise ValueError('Base 克隆模型不支持独立风格指令')
        result.update(reference_id=data['reference_id'], reference_text=transcript)
    return result


def wav_metadata(file):
    try:
        with wave.open(str(file), 'rb') as stream:
            if stream.getsampwidth() != 2 or stream.getnchannels() != 1 or not 8000 <= stream.getframerate() <= 96000:
                raise ValueError('需要完整的 16 位单声道 WAV 音频')
            frames = stream.getnframes()
            if not 0 < frames <= stream.getframerate() * 600 or len(stream.readframes(frames)) != frames * 2:
                raise ValueError('音频为空、截断或超过十分钟')
            return {'duration_ms': round(frames / stream.getframerate() * 1000), 'sample_rate': stream.getframerate()}
    except (wave.Error, EOFError) as error:
        raise ValueError('需要完整的 16 位单声道 WAV 音频') from error


async def update_job(pool, id, patch):
    async with pool.connection() as conn:
        await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s', (Jsonb(patch), id), block_id=id)


class SpeechManager:
    def __init__(self):
        self.slots = asyncio.Semaphore(1)
        self.tasks = {}
        self.processes = {}
        self.committing = set()

    async def close(self):
        await asyncio.gather(*(self.cancel(id) for id in list(self.tasks)), return_exceptions=True)

    def start(self, handler, id, runtime, request):
        task = asyncio.create_task(self.run(handler.projects, handler.settings['config'], handler.owner, id, runtime, request))
        self.tasks[id] = task
        task.add_done_callback(lambda _: self.tasks.pop(id, None))

    async def cancel(self, id):
        task = self.tasks.get(id)
        if task:
            if id in self.committing:
                await asyncio.shield(task)
                return
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError): await task

    async def run(self, pool, config, owner, id, runtime, request):
        directory = config['data_dir'] / 'media'; directory.mkdir(exist_ok=True)
        temporary = directory / f'{id}.pending.wav'
        process = None
        asset_path = None
        committed = False
        try:
            async with self.slots:
                if shutil.disk_usage(directory).free < 512 * 1024**2: raise ValueError('磁盘空间不足，请先预留至少 512 MB')
                await update_job(pool, id, {'status': 'running', 'started_at': int(time.time()*1000)})
                worker = Path(__file__).parent / 'workers/qwen_tts_worker.py'
                process = await asyncio.create_subprocess_exec(runtime['python'], str(worker), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env={**os.environ, 'HF_HUB_OFFLINE':'1', 'TRANSFORMERS_OFFLINE':'1'})
                self.processes[id] = process
                payload = {**request, 'model_path':runtime['model_path'], 'device':runtime['device'], 'output_path':str(temporary)}
                # Worker has no streaming output here, so the response remains small.
                output, _ = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), timeout=1200)
                if process.returncode or len(output) > 64000 or not json.loads(output).get('ok'):
                    raise ValueError('本地配音失败，请检查模型依赖、设备及内存；未切换云端')
                metadata = await asyncio.to_thread(wav_metadata, temporary)
                asset_id = uuid.uuid4().hex; filename = asset_id + '.wav'; asset_path = directory / filename
                raw = temporary.read_bytes()
                name = request['text'][:30] + '.wav'
                body = dict(kind='asset', owner_id=owner, filename=filename, mime='audio/wav', name=name, size=len(raw), sha256=hashlib.sha256(raw).hexdigest(), **metadata)
                os.replace(temporary, asset_path)
                result = {'id':asset_id, 'url':'/api/assets/'+asset_id, 'name':name, 'mime':'audio/wav', 'size':len(raw), **metadata}
                self.committing.add(id)
                async with pool.connection() as conn:
                    await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (asset_id, Jsonb(body)), block_id=asset_id)
                    await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s', (Jsonb({'status':'succeeded','asset':result,'completed_at':int(time.time()*1000)}), id), block_id=id)
                committed = True
        except asyncio.CancelledError:
            await update_job(pool, id, {'status':'cancelled','completed_at':int(time.time()*1000)})
            raise
        except Exception as error:
            message = str(error) if isinstance(error, ValueError) and str(error).startswith(('磁盘空间', '本地配音', '需要完整', '音频为空')) else '本地配音失败或超时，请检查模型环境；任务未自动重试'
            await update_job(pool, id, {'status':'failed','error':message,'completed_at':int(time.time()*1000)})
        finally:
            if process and process.returncode is None:
                with contextlib.suppress(ProcessLookupError): process.terminate()
                try: await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    with contextlib.suppress(ProcessLookupError): process.kill()
                    await process.wait()
            self.committing.discard(id)
            self.processes.pop(id, None)
            temporary.unlink(missing_ok=True)
            if asset_path and not committed: asset_path.unlink(missing_ok=True)


def manager(handler):
    if 'speech_manager' not in handler.application.settings:
        handler.application.settings['speech_manager'] = SpeechManager()
    return handler.application.settings['speech_manager']


def require_local(handler):
    if handler.settings['config'].get('cloud_mode'):
        raise tornado.web.HTTPError(403, reason='本地 Qwen3-TTS 配音请在桌面工作站使用')


class SpeechSettingsHandler(PrivateHandler):
    async def get(self):
        require_local(self)
        try: runtime = load_runtime(self.settings['config'], self.owner)
        except (ValueError, OSError): runtime = None
        self.finish({'runtime':runtime, 'languages':LANGUAGES})

    async def post(self):
        require_local(self)
        try: runtime = await asyncio.to_thread(validate_runtime, self.data())
        except (ValueError, OSError): raise tornado.web.HTTPError(400, reason='配置无效：检查 Python、完整 Qwen3-TTS 权重和设备')
        path = settings_path(self.settings['config'], self.owner)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(runtime)); temporary.chmod(0o600); os.replace(temporary, path)
        self.finish({'runtime':runtime, 'languages':LANGUAGES})


class SpeechJobsHandler(PrivateHandler):
    async def get(self, project_id):
        require_local(self)
        await owned(self.projects, project_id, self.owner, 'project')
        async with self.projects.connection() as conn:
            rows = await (await conn.scan("SELECT * FROM entities WHERE body->>'kind'='speech' AND body->>'owner_id'=%s AND body->>'project_id'=%s ORDER BY createtime DESC LIMIT 100", (self.owner, project_id), order_by='createtime')).fetchall()
        for row in rows:
            if row['body']['status'] in ACTIVE and row['block_id'] not in manager(self).tasks:
                patch = {'status':'failed', 'error':'上次配音中断，请重新提交', 'completed_at':int(time.time()*1000)}
                await update_job(self.projects, row['block_id'], patch); row['body'].update(patch)
        # Runtime paths and local reference filenames are never exposed in job records.
        self.finish({'jobs':rows})

    async def post(self, project_id):
        require_local(self)
        await owned(self.projects, project_id, self.owner, 'project')
        if len(manager(self).tasks) >= 20: raise tornado.web.HTTPError(429, reason='配音队列已满，请稍后再试')
        try:
            runtime = load_runtime(self.settings['config'], self.owner)
            if not runtime: raise ValueError('请先配置本地 Qwen3-TTS')
            request = validate_text(self.data(), runtime)
            if runtime['mode'] == 'clone':
                asset = await owned(self.projects, request['reference_id'], self.owner, 'asset')
                if asset['body'].get('mime') != 'audio/wav': raise ValueError('请选择 WAV 参考音频')
                reference = await ensure_local_asset(self, asset)
                await asyncio.to_thread(wav_metadata, reference)
                request['reference_path'] = str(reference)
        except (ValueError, OSError) as error:
            raise tornado.web.HTTPError(400, reason=str(error) if isinstance(error, ValueError) else '本地模型或参考音频不可用')
        id = uuid.uuid4().hex
        body = {'kind':'speech','owner_id':self.owner,'project_id':project_id,'text':request['text'],'language':request['language'],'model_id':runtime['model_id'],'device':runtime['device'],'mode':runtime['mode'],'speaker':request.get('speaker'),'reference_id':request.get('reference_id'),'reference_text':request.get('reference_text',''),'instruction':request.get('instruction',''),'status':'queued','queued_at':int(time.time()*1000)}
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (id, Jsonb(body)), block_id=id)
        manager(self).start(self, id, runtime, request)
        self.set_status(202); self.finish({'id':id,'body':body})


class SpeechCancelHandler(PrivateHandler):
    async def post(self, id):
        require_local(self)
        row = await owned(self.projects, id, self.owner, 'speech')
        if row['body']['status'] in ACTIVE:
            await manager(self).cancel(id)
            current = await owned(self.projects, id, self.owner, 'speech')
            if current['body']['status'] in ACTIVE:
                await update_job(self.projects, id, {'status':'cancelled','completed_at':int(time.time()*1000)})
        self.finish({'ok':True})
