"""Fixed, local ComfyUI workflows. No client-supplied graphs or output paths."""
import asyncio
import json
import secrets
import time
import uuid
from urllib.parse import urlencode

from psycopg.types.json import Jsonb
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest
import tornado.web

from backend.workspace import PrivateHandler, owned, ID

COMFY = 'http://127.0.0.1:8188'
MODELS = [
    dict(id='z-image-turbo', name='Z Image Turbo · 本地', type='image', modes=['text', 'image'],
         note='图生图使用原图潜空间重绘；参考图模式需另接支持参考条件的模型，当前未配置。'),
    dict(id='z-image', name='Z Image 标准版 BF16 · 本地', type='image', modes=['text', 'image'],
         note='支持反向提示词；建议 30–50 步、CFG 3–5。图生图为潜空间重绘。'),
    dict(id='minimax-h3', name='MiniMax H3 · 本地', type='video', modes=['text', 'image'],
         note='图生视频支持首帧和可选尾帧；多元素参考需要 ref2va 权重，当前未安装。'),
]


async def comfy(path, data=None):
    response = await AsyncHTTPClient().fetch(HTTPRequest(COMFY + path,
        method='GET' if data is None else 'POST',
        headers={'Content-Type': 'application/json'},
        body=None if data is None else json.dumps(data), request_timeout=30))
    return json.loads(response.body)


def node(kind, **inputs):
    return {'class_type': kind, 'inputs': inputs}


def workflow(kind, mode, p, refs, job_id):
    width, height, seed, steps = p['width'], p['height'], p['seed'], p['steps']
    if kind == 'image':
        standard = p.get('model') == 'z-image'
        graph = {
            '1': node('UNETLoader', unet_name='z_image_bf16.safetensors' if standard else 'z_image_turbo_bf16.safetensors', weight_dtype='default'),
            '2': node('CLIPLoader', clip_name='qwen_3_4b.safetensors', type='lumina2', device='default'),
            '3': node('VAELoader', vae_name='ae.safetensors'),
            '4': node('CLIPTextEncode', clip=['2', 0], text=p['prompt']),
            '5': node('CLIPTextEncode', clip=['2', 0], text=p.get('negative_prompt', '')) if standard else node('ConditioningZeroOut', conditioning=['4', 0]),
            '6': node('ModelSamplingAuraFlow', model=['1', 0], shift=3),
            '7': node('EmptySD3LatentImage', width=width, height=height, batch_size=1),
            '8': node('KSampler', model=['6', 0], positive=['4', 0], negative=['5', 0], latent_image=['7', 0],
                      seed=seed, steps=steps, cfg=p.get('cfg', 4) if standard else 1, sampler_name='res_multistep', scheduler='simple', denoise=p['denoise'] if mode == 'image' else 1),
            '9': node('VAEDecode', samples=['8', 0], vae=['3', 0]),
            '10': node('SaveImage', images=['9', 0], filename_prefix='director/' + job_id),
        }
        if mode == 'image':
            graph.update({'11': node('LoadImage', image=refs[0]),
                '12': node('ImageScale', image=['11', 0], upscale_method='lanczos', width=width, height=height, crop='center'),
                '7': node('VAEEncode', pixels=['12', 0], vae=['3', 0])})
        return graph
    length = round(p['duration'] * 24)
    length += (5 - length % 17) % 17
    graph = {
        '1': node('UNETLoader', unet_name='minimax_h3_fl2va_pruned_fp8_scaled.safetensors', weight_dtype='default'),
        '2': node('CLIPLoader', clip_name='qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', type='minimax', device='default'),
        '3': node('VAELoader', vae_name='minimax_h3_video_vae_fp16.safetensors'),
        '4': node('VAELoader', vae_name='minimax_h3_audio_vae_fp32.safetensors'),
        '5': node('MiniMaxH3ImageToVideo', clip=['2', 0], vae=['3', 0], prompt=p['prompt'], width=width, height=height, length=length),
        '6': node('LoraLoaderModelOnly', model=['1', 0], lora_name='minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', strength_model=1),
        '7': node('BasicGuider', model=['6', 0], conditioning=['5', 0]),
        '8': node('RandomNoise', noise_seed=seed),
        '9': node('KSamplerSelect', sampler_name='res_multistep'),
        '10': node('BasicScheduler', model=['6', 0], scheduler='simple', steps=steps, denoise=1),
        '11': node('SamplerCustomAdvanced', noise=['8', 0], guider=['7', 0], sampler=['9', 0], sigmas=['10', 0], latent_image=['5', 1]),
        '12': node('VAEDecode', samples=['11', 0], vae=['3', 0]),
        '13': node('VAEDecodeAudio', samples=['11', 0], vae=['4', 0]),
        '14': node('CreateVideo', images=['12', 0], audio=['13', 0], fps=24),
        '15': node('SaveVideo', video=['14', 0], filename_prefix='director/' + job_id, format='mp4', codec='h264'),
    }
    for i, image in enumerate(refs):
        key = str(20 + i)
        graph[key] = node('LoadImage', image=image)
        graph['5']['inputs']['first_frame' if i == 0 else 'last_frame'] = [key, 0]
    return graph


class ModelsHandler(PrivateHandler):
    async def get(self):
        try:
            await comfy('/system_stats')
            online = True
        except (HTTPClientError, OSError):
            online = False
        self.finish({'models': MODELS, 'online': online})


class GenerateHandler(PrivateHandler):
    async def post(self, project_id):
        project = await owned(self.projects, project_id, self.owner, 'project')
        data = self.data()
        card = next((c for c in project['body']['canvas']['cards'] if c['id'] == data.get('card_id')), None)
        if not card:
            raise tornado.web.HTTPError(400, reason='请先保存卡片')
        job_id = data.get('request_id', '')
        if not isinstance(job_id, str) or not ID.fullmatch(job_id):
            raise tornado.web.HTTPError(400, reason='请求 UUID 不正确')
        kind, mode = card['type'], data.get('mode')
        if mode not in ('text', 'image'):
            raise tornado.web.HTTPError(400, reason='当前模型未配置参考模式所需权重')
        expected_model = data.get('model')
        if not any(m['id'] == expected_model and m['type'] == kind and mode in m['modes'] for m in MODELS):
            raise tornado.web.HTTPError(400, reason='模型与卡片类型不匹配')
        try:
            prompt = data['prompt']
            if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
                raise ValueError()
            p = dict(prompt=prompt, width=int(data['width']), height=int(data['height']), steps=int(data['steps']),
                     seed=int(data.get('seed', -1)), denoise=float(data.get('denoise', .65)), duration=float(data.get('duration', 2)))
            p['model'] = expected_model
            if expected_model == 'z-image':
                p['negative_prompt'] = data.get('negative_prompt', '')
                p['cfg'] = float(data.get('cfg', 4))
                if not isinstance(p['negative_prompt'], str) or len(p['negative_prompt']) > 12000 or not 1 <= p['cfg'] <= 20:
                    raise ValueError()
            grid = 16 if kind == 'image' else 32
            if any(p[k] < 256 or p[k] > 1536 or p[k] % grid for k in ('width', 'height')):
                raise ValueError()
            if p['width'] * p['height'] > (1536**2 if kind == 'image' else 1344*768):
                raise ValueError()
            if not 1 <= p['steps'] <= (60 if expected_model == 'z-image' else 40) or not 0 < p['denoise'] <= 1 or not 1 <= p['duration'] <= 15 or not -1 <= p['seed'] <= 2**53 - 1:
                raise ValueError()
            refs = data.get('refs', []) if mode == 'image' else []
            if not isinstance(refs, list) or any(not isinstance(ref, str) or not ID.fullmatch(ref) for ref in refs) or (mode == 'image' and not 1 <= len(refs) <= (1 if kind == 'image' else 2)):
                raise ValueError()
        except (ValueError, TypeError, KeyError, OverflowError):
            raise tornado.web.HTTPError(400, reason='请检查提示词、尺寸、步数、种子和参考图数量')
        if p['seed'] == -1:
            p['seed'] = secrets.randbelow(2**53)
        assets = [await owned(self.projects, ref, self.owner, 'asset') for ref in refs]
        body = dict(kind='generation', owner_id=self.owner, project_id=project_id, card_id=card['id'], type=kind,
                    model=expected_model, mode=mode, params=p, refs=refs, status='submitting', outputs=[],
                    usage={'tokens': None, 'note': '本地 ComfyUI 未提供 token 用量；不按 token 计费'}, submitted_at=time.time_ns()//1_000_000)
        async with self.jobs.connection() as conn:
            inserted = await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT DO NOTHING RETURNING block_id', (job_id, Jsonb(body)))).fetchone()
        if not inserted:
            self.finish(await owned(self.jobs, job_id, self.owner, 'generation'))
            return
        try:
            names = []
            for asset in assets:
                path = self.settings['config']['data_dir'] / 'media' / asset['body']['filename']
                raw = await asyncio.to_thread(path.read_bytes)
                boundary = uuid.uuid4().hex
                filename = asset['body']['filename']
                payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\nContent-Type: {asset["body"]["mime"]}\r\n\r\n').encode() + raw + f'\r\n--{boundary}--\r\n'.encode()
                response = await AsyncHTTPClient().fetch(HTTPRequest(COMFY + '/upload/image', method='POST', body=payload,
                    headers={'Content-Type': 'multipart/form-data; boundary=' + boundary}, request_timeout=60))
                uploaded = json.loads(response.body)
                names.append('/'.join(filter(None, [uploaded.get('subfolder'), uploaded['name']])))
            await self.settings['progress_tracker'].ensure(self.owner)
            result = await comfy('/prompt', {'prompt': workflow(kind, mode, p, names, job_id), 'client_id': 'director-' + self.owner})
            body.update(status='queued', prompt_id=result['prompt_id'])
        except (HTTPClientError, OSError, KeyError, ValueError) as error:
            # A timed-out POST may already be accepted. Never automatically submit it again.
            body.update(status='failed', error='ComfyUI 提交未确认，请检查服务或队列后重试。')
            if isinstance(error, HTTPClientError) and error.response and error.response.body:
                try:
                    details = json.loads(error.response.body)
                    body['error'] = 'ComfyUI 拒绝工作流：' + json.dumps(details.get('error', details), ensure_ascii=False)[:1000]
                except ValueError:
                    pass
        async with self.jobs.connection() as conn:
            row = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s RETURNING *', (Jsonb(body), job_id))).fetchone()
        self.finish(row)


class HistoryHandler(PrivateHandler):
    async def get(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        async with self.jobs.connection() as conn:
            rows = await (await conn.execute("SELECT * FROM entities WHERE body->>'kind'='generation' AND body->>'owner_id'=%s AND body->>'project_id'=%s ORDER BY createtime DESC", (self.owner, project_id))).fetchall()
        tracker = self.settings['progress_tracker']
        active = any(r['body']['status'] in ('queued', 'running') for r in rows)
        queue = None
        if active:
            await tracker.ensure(self.owner)
            try:
                queue = await comfy('/queue')
            except (HTTPClientError, OSError, ValueError):
                pass
        for row in rows:
            body = row['body']
            if body['status'] not in ('queued', 'running') or not body.get('prompt_id'):
                continue
            try:
                entry = (await comfy('/history/' + body['prompt_id'])).get(body['prompt_id'])
            except (HTTPClientError, OSError, ValueError):
                body['progress'] = {'phase': 'unavailable'}
                continue
            if not entry:
                progress = tracker.values.get((self.owner, body['prompt_id']))
                if progress:
                    body.update(status='running', progress=progress)
                elif queue is not None:
                    running = any(item[1] == body['prompt_id'] for item in queue.get('queue_running', []))
                    body.update(status='running' if running else 'queued', progress={'phase': 'running' if running else 'queued'})
                else:
                    body['progress'] = {'phase': 'unavailable'}
                continue
            outputs = []
            for output in entry.get('outputs', {}).values():
                for key in ('images', 'gifs', 'videos'):
                    for media in output.get(key, []):
                        if isinstance(media, dict) and media.get('filename') and media.get('type') == 'output':
                            outputs.append({k: media.get(k, '') for k in ('filename', 'subfolder', 'type')})
            status = entry.get('status', {})
            if status.get('status_str') == 'error':
                body.update(status='failed', error='生成失败，请查看 ComfyUI 错误信息')
                for event, detail in status.get('messages', []):
                    if event == 'execution_error':
                        body['error'] = str(detail.get('exception_message', body['error']))[:1500]
            elif status.get('completed'):
                body.update(status='completed' if outputs else 'failed', outputs=outputs)
                if not outputs:
                    body['error'] = '任务完成但没有返回媒体文件'
            else:
                continue
            timestamps = {event: detail.get('timestamp') for event, detail in status.get('messages', [])}
            start, end = timestamps.get('execution_start'), timestamps.get('execution_success')
            body['elapsed_ms'] = end - start if start is not None and end is not None else None
            async with self.jobs.connection() as conn:
                await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s', (Jsonb(body), row['block_id']))
        self.finish({'history': rows})


class OutputHandler(PrivateHandler):
    async def get(self, job_id, index):
        row = await owned(self.jobs, job_id, self.owner, 'generation')
        outputs = row['body'].get('outputs', [])
        if int(index) >= len(outputs):
            raise tornado.web.HTTPError(404)
        headers = {}
        if self.request.headers.get('Range'):
            headers['Range'] = self.request.headers['Range']
        try:
            response = await AsyncHTTPClient().fetch(HTTPRequest(COMFY + '/view?' + urlencode(outputs[int(index)]), headers=headers, request_timeout=120))
        except HTTPClientError:
            raise tornado.web.HTTPError(502, reason='生成文件暂不可用，请确认 ComfyUI 正在运行')
        self.set_status(response.code)
        for name in ('Content-Type', 'Content-Range', 'Accept-Ranges'):
            if name in response.headers:
                self.set_header(name, response.headers[name])
        self.finish(response.body)
