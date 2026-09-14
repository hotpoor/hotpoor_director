"""Fixed, local ComfyUI workflows. No client-supplied graphs or output paths."""
import asyncio
import copy
import json
import secrets
import time
import uuid
import tempfile
from pathlib import Path
from urllib.parse import urlencode

from psycopg.types.json import Jsonb
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest
import tornado.web

from backend.reference_media import prepare_reference
from backend.comfy_settings import endpoint
from backend.workspace import PrivateHandler, owned, ID
from backend.inference_models import MODELS as CLOUD_MODELS, BY_ID as CLOUD_BY_ID, PROVIDER

COMFY = 'http://127.0.0.1:8188'
MODELS = [
    dict(id='z-image-turbo', name='Z Image Turbo · 本地', type='image', modes=['text', 'image'],
         note='图生图使用原图潜空间重绘；参考图模式需另接支持参考条件的模型，当前未配置。'),
    dict(id='z-image', name='Z Image 标准版 BF16 · 本地', type='image', modes=['text', 'image'],
         note='支持反向提示词；建议 30–50 步、CFG 3–5。图生图为潜空间重绘。'),
    dict(id='minimax-h3', name='MiniMax H3 · 本地', type='video', modes=['text', 'image'],
         note='图生视频支持首帧和可选尾帧；多图参考请选择 H3-Base-Ref2VA。'),
    dict(id='minimax-h3-ref2va', name='H3-Base-Ref2VA · 多元素参考', type='video', modes=['reference'],
         ref_limit=8, ref_types=["image", "video", "audio"], default_steps=20, default_duration=5, default_width=512, default_height=320,
         note='混合参考共 1–8 项，视频、音频各最多 3 项。用 <Picture 1> / <Video 1> / <Audio 1> 引用；视频取开头并转 24 fps（仅画面），声音请单独添加音频。参考片段截至生成时长，建议至少 5 秒。'),
    dict(id='ltx-2.5', name='LTX-2.5 22B 蒸馏版 · 本地', type='video', modes=['text', 'image'],
         ref_limit=1, default_steps=11, fixed_steps=True, default_width=512, default_height=320, dimension_step=64,
         sampler_nodes=['344', '368'], note='首帧图生视频；固定 8＋3 步并进行 2 倍潜空间放大，尺寸为最终输出，需为 64 的倍数。'),
]


for model in MODELS:
    is_image = model['type'] == 'image'
    model['size_limits'] = dict(minimum=256, maximum=1536,
        step=64 if model['id']=='ltx-2.5' else 16 if is_image else 32,
        max_pixels=1536**2 if is_image else 1344*768,
        presets=[[1024,1024],[1280,720],[720,1280]] if is_image else [[512,320],[768,512],[512,768]])

MODELS.extend(CLOUD_MODELS)

def size_error(model_id, width, height):
    limits = next(m['size_limits'] for m in MODELS if m['id']==model_id)
    for label,value in [('宽度',width),('高度',height)]:
        if not isinstance(value,int) or isinstance(value,bool) or not limits['minimum'] <= value <= limits['maximum']:
            return f"{label}需为 {limits['minimum']}–{limits['maximum']} px 的整数"
        if value % limits['step']:
            return f"{label} {value} px 不符合要求，需为 {limits['step']} 的倍数"
    if width*height > limits['max_pixels']:
        return f"总像素 {width*height:,} 超过本机上限 {limits['max_pixels']:,}，请降低宽度或高度（例如 768×512）"
    return ''


async def comfy(path, data=None, base_url=COMFY):
    response = await AsyncHTTPClient().fetch(HTTPRequest(base_url + path,
        method='GET' if data is None else 'POST',
        headers={'Content-Type': 'application/json'},
        body=None if data is None else json.dumps(data), request_timeout=30))
    return json.loads(response.body)


async def comfy_at(url, path, data=None):
    if url == COMFY:
        return await comfy(path, data) if data is not None else await comfy(path)
    return await comfy(path, data, base_url=url)


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
    if p.get('model') == 'ltx-2.5':
        return ltx_workflow(mode, p, refs, job_id)
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
        '15': node('SaveVideo', video=['14', 0], filename_prefix='director/' + job_id, format='mp4', **{'format.codec': 'h264'}),
    }
    reference = p.get('model') == 'minimax-h3-ref2va'
    if reference:
        graph['1']['inputs']['unet_name'] = 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors'
        graph['5'] = node('MiniMaxH3ReferenceToVideo', clip=['2', 0], vae=['3', 0], audio_vae=['4', 0], prompt=p['prompt'], width=width, height=height, length=length, ref_image_size='match')
        del graph['6']
        graph['7']['inputs']['model'] = ['1', 0]
        graph['10']['inputs']['model'] = ['1', 0]
    counts = {'image': 0, 'video': 0, 'audio': 0}
    for i, ref in enumerate(refs):
        media = ref if isinstance(ref, dict) else {'name': ref, 'kind': 'image'}
        media_kind, filename = media['kind'], media['name']
        key = str(20 + i * 3)
        number = counts[media_kind]
        counts[media_kind] += 1
        if reference and media_kind == 'video':
            graph[key] = node('LoadVideo', file=filename)
            components = str(21 + i * 3)
            graph[components] = node('GetVideoComponents', video=[key, 0])
            graph['5']['inputs'][f'ref_videos.ref_video_{number}'] = [components, 0]
        elif reference and media_kind == 'audio':
            graph[key] = node('LoadAudio', audio=filename)
            graph['5']['inputs'][f'ref_audios.ref_audio_{number}'] = [key, 0]
        else:
            graph[key] = node('LoadImage', image=filename)
            graph['5']['inputs'][f'ref_images.ref_image_{number}' if reference else ('first_frame' if i == 0 else 'last_frame')] = [key, 0]
    return graph


def ltx_workflow(mode, p, refs, job_id):
    # Based on the official two-stage distilled workflow, verified on local cu126.
    graph = json.loads((Path(__file__).parent / 'workflows' / 'ltx25.json').read_text())
    length = round(p['duration'] * 24 / 8) * 8 + 1
    graph['356']['inputs'].update(width=p['width']//2, height=p['height']//2, length=length)
    graph['366']['inputs']['frames_number'] = length
    graph['364']['inputs']['text'] = p['prompt']
    graph['339']['inputs']['noise_seed'] = p['seed']
    graph['338']['inputs']['noise_seed'] = p['seed']
    graph['75']['inputs']['filename_prefix'] = 'director/' + job_id
    if mode == 'image':
        graph['500'] = node('LoadImage', image=refs[0])
        graph['501'] = node('LTXVImgToVideoInplace', vae=['385', 0], image=['500', 0], latent=['356', 0], strength=.7, bypass=False)
        graph['502'] = node('LTXVImgToVideoInplace', vae=['385', 0], image=['500', 0], latent=['348', 0], strength=1., bypass=False)
        graph['377']['inputs']['video_latent'] = ['501', 0]
        graph['340']['inputs']['video_latent'] = ['502', 0]
    return graph


class ModelsHandler(PrivateHandler):
    async def get(self):
        try:
            await asyncio.wait_for(comfy_at(endpoint(self.settings), '/system_stats'), 3)
            online = True
        except (HTTPClientError, OSError, asyncio.TimeoutError):
            online = False
        from backend.inference import load_key,model_access
        allowed,error=await model_access(self.settings['config'],self.settings['inference_manager'])
        models=[{**m,'available':m.get('provider')!='service-inference' or m['remote_model'] in allowed} for m in MODELS]
        self.finish({'models':models,'online':online,'inference_configured':bool(load_key(self.settings['config'])),'model_error':error})


class GenerateHandler(PrivateHandler):
    async def post(self, project_id):
        data = self.data()
        if data.get('model') in CLOUD_BY_ID:
            from backend.inference import submit
            await submit(self, project_id, data)
            return
        async with self.settings['comfy_lock']:
            await self.submit(project_id)

    async def submit(self, project_id):
        project = await owned(self.projects, project_id, self.owner, 'project')
        data = self.data()
        card = next((c for c in project['body']['canvas']['cards'] if c['id'] == data.get('card_id')), None)
        if not card:
            raise tornado.web.HTTPError(400, reason='请先保存卡片')
        job_id = data.get('request_id', '')
        if not isinstance(job_id, str) or not ID.fullmatch(job_id):
            raise tornado.web.HTTPError(400, reason='请求 UUID 不正确')
        kind, mode = card['type'], data.get('mode')
        if mode not in ('text', 'image', 'reference'):
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
            if any(float(data[k]) != p[k] or isinstance(data[k], bool) for k in ('width','height')):
                raise tornado.web.HTTPError(400, reason='宽度和高度必须是整数像素')
            dimension_error = size_error(expected_model, p['width'], p['height'])
            if dimension_error:
                raise tornado.web.HTTPError(400, reason=dimension_error)
            if not 1 <= p['steps'] <= (60 if expected_model == 'z-image' else 40) or not 0 < p['denoise'] <= 1 or not 1 <= p['duration'] <= 15 or not -1 <= p['seed'] <= 2**53 - 1:
                raise ValueError()
            if expected_model == 'ltx-2.5' and p['steps'] != 11:
                raise ValueError()
            refs = data.get('refs', []) if mode != 'text' else []
            limit = 8 if expected_model == 'minimax-h3-ref2va' else 1 if kind == 'image' or expected_model == 'ltx-2.5' else 2
            if not isinstance(refs, list) or any(not isinstance(ref, str) or not ID.fullmatch(ref) for ref in refs) or (mode != 'text' and not 1 <= len(refs) <= limit):
                raise ValueError()
        except (ValueError, TypeError, KeyError, OverflowError):
            raise tornado.web.HTTPError(400, reason='请检查提示词、尺寸、步数、种子和参考图数量')
        if p['seed'] == -1:
            p['seed'] = secrets.randbelow(2**53)
        assets = [await owned(self.projects, ref, self.owner, 'asset') for ref in refs]
        media_kinds = [asset['body']['mime'].split('/')[0] for asset in assets]
        allowed = ('image', 'video', 'audio') if expected_model == 'minimax-h3-ref2va' else ('image',)
        if any(k not in allowed for k in media_kinds) or any(media_kinds.count(k) > 3 for k in ('video', 'audio')):
            raise tornado.web.HTTPError(400, reason='当前模型不支持该参考类型，或视频/音频超过各 3 项限制')
        body = dict(comfy_url=endpoint(self.settings), kind='generation', owner_id=self.owner, project_id=project_id, card_id=card['id'], type=kind,
                    model=expected_model, mode=mode, params=p, refs=refs, ref_info={a['block_id']: {'mime': a['body']['mime'], 'name': a['body']['name']} for a in assets}, status='submitting', outputs=[],
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
                media_kind = asset['body']['mime'].split('/')[0]
                if media_kind != 'image':
                    with tempfile.TemporaryDirectory(dir=path.parent) as temporary:
                        normalized = Path(temporary) / (asset['block_id'] + ('.mp4' if media_kind == 'video' else '.wav'))
                        await asyncio.to_thread(prepare_reference, path, normalized, media_kind, p['duration'], p['width'], p['height'])
                        raw = await asyncio.to_thread(normalized.read_bytes)
                    filename = job_id + '-' + normalized.name
                else:
                    raw = await asyncio.to_thread(path.read_bytes)
                    filename = asset['body']['filename']
                boundary = uuid.uuid4().hex
                payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\nContent-Type: {asset["body"]["mime"]}\r\n\r\n').encode() + raw + f'\r\n--{boundary}--\r\n'.encode()
                response = await AsyncHTTPClient().fetch(HTTPRequest(body['comfy_url'] + '/upload/image', method='POST', body=payload,
                    headers={'Content-Type': 'multipart/form-data; boundary=' + boundary}, request_timeout=60))
                uploaded = json.loads(response.body)
                name = '/'.join(filter(None, [uploaded.get('subfolder'), uploaded['name']]))
                names.append({'name': name, 'kind': media_kind} if expected_model == 'minimax-h3-ref2va' else name)
            await self.settings['progress_tracker'].ensure(self.owner)
            result = await comfy_at(endpoint(self.settings), '/prompt', {'prompt': workflow(kind, mode, p, names, job_id), 'client_id': 'director-' + self.owner})
            body.update(status='queued', prompt_id=result['prompt_id'])
        except (HTTPClientError, OSError, KeyError, ValueError, IndexError) as error:
            # A timed-out POST may already be accepted. Never automatically submit it again.
            body.update(status='failed', error='ComfyUI 提交未确认，请检查服务或队列后重试。')
            if isinstance(error, (ValueError, IndexError)):
                body['error'] = '参考素材处理失败：' + str(error)[:300]
            if isinstance(error, HTTPClientError) and error.response and error.response.body:
                try:
                    details = json.loads(error.response.body)
                    body['error'] = 'ComfyUI 拒绝工作流：' + json.dumps(details.get('error', details), ensure_ascii=False)[:1000]
                except ValueError:
                    pass
        async with self.jobs.connection() as conn:
            row = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s RETURNING *', (Jsonb(body), job_id))).fetchone()
        self.finish(row)


class CancelGenerationHandler(PrivateHandler):
    async def post(self, job_id):
        row = await owned(self.jobs, job_id, self.owner, 'generation')
        body = row['body']
        if body['status'] in ('completed', 'failed', 'cancelled', 'stopping'):
            self.finish(row)
            return
        if body.get('provider') == PROVIDER:
            raise tornado.web.HTTPError(409, reason='service-inference 文档未提供取消接口，云端任务会继续执行')
        if not body.get('prompt_id'):
            raise tornado.web.HTTPError(409, reason='任务正在提交，请稍后停止')
        try:
            # Native job-scoped cancellation checks the running id atomically.
            # Never fall back to a global /interrupt or clearing the queue.
            result = await comfy_at(body.get('comfy_url', COMFY), '/api/jobs/' + body['prompt_id'] + '/cancel', {})
        except (HTTPClientError, OSError, ValueError):
            raise tornado.web.HTTPError(502, reason='停止请求未确认，请检查 ComfyUI 状态后重试')
        if result.get('cancelled'):
            patch = dict(status='stopping', cancel_requested=True, cancel_requested_at=time.time_ns()//1_000_000)
            async with self.jobs.connection() as conn:
                await conn.execute("UPDATE entities SET body=body || %s WHERE block_id=%s AND body->>'status' IN ('queued','running')", (Jsonb(patch), job_id))
        self.finish(await owned(self.jobs, job_id, self.owner, 'generation'))


class QueueOrderHandler(PrivateHandler):
    async def post(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        order = self.data().get('order')
        if not isinstance(order, list) or len(order) > 1000 or any(not isinstance(x, str) or not ID.fullmatch(x) for x in order) or len(set(order)) != len(order):
            raise tornado.web.HTTPError(400, reason='排序列表不正确')
        async with self.jobs.connection() as conn:
            rows = await (await conn.execute("SELECT * FROM entities WHERE body->>'kind'='generation' AND body->>'owner_id'=%s AND body->>'project_id'=%s", (self.owner, project_id))).fetchall()
        jobs = {r['block_id']: r['body'].get('prompt_id') for r in rows if r['body'].get('provider') != PROVIDER and r['body'].get('comfy_url', COMFY) == endpoint(self.settings)}
        if any(job not in jobs for job in order):
            raise tornado.web.HTTPError(404, reason='任务不存在或无权操作')
        try:
            queue = await comfy_at(endpoint(self.settings), '/queue')
            expected = [item[1] for item in sorted(queue.get('queue_pending', []))]
            pending = {job for job, prompt in jobs.items() if prompt in expected}
            previous = self.data().get('previous')
            current = [job for prompt in expected for job in pending if jobs[job] == prompt]
            if set(order) != pending or previous != current:
                raise tornado.web.HTTPError(409, reason='排队任务已变化，请刷新后重新排序')
            await comfy_at(endpoint(self.settings), '/director/queue-order', {'expected': expected, 'order': [jobs[job] for job in order]})
        except HTTPClientError as error:
            if error.code == 409:
                raise tornado.web.HTTPError(409, reason='队列已变化，请刷新后重试')
            raise tornado.web.HTTPError(503, reason='队列排序扩展未就绪，请确认 ComfyUI 已加载 Director Queue 扩展')
        except (OSError, ValueError):
            raise tornado.web.HTTPError(503, reason='无法读取生成队列，请稍后重试')
        self.finish({'reordered': True})


class HistoryHandler(PrivateHandler):
    async def get(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        async with self.jobs.connection() as conn:
            rows = await (await conn.execute("SELECT * FROM entities WHERE body->>'kind'='generation' AND body->>'owner_id'=%s AND body->>'project_id'=%s ORDER BY createtime DESC", (self.owner, project_id))).fetchall()
        tracker = self.settings['progress_tracker']
        active = any(r['body'].get('provider') != PROVIDER and r['body']['status'] in ('queued', 'running', 'stopping') for r in rows)
        queue = None
        if active:
            await tracker.ensure(self.owner)
            try:
                queue = await comfy_at(endpoint(self.settings), '/queue')
            except (HTTPClientError, OSError, ValueError):
                pass
        for row in rows:
            body = row['body']
            if body.get('provider') == PROVIDER:
                continue
            original = copy.deepcopy(body)
            if body['status'] not in ('queued', 'running', 'stopping') or not body.get('prompt_id'):
                continue
            try:
                entry = (await comfy_at(body.get('comfy_url', COMFY), '/history/' + body['prompt_id'])).get(body['prompt_id'])
            except (HTTPClientError, OSError, ValueError):
                body['progress'] = {'phase': 'unavailable'}
                continue
            if not entry and body.get('cancel_requested'):
                present = queue is None or any(item[1] == body['prompt_id'] for item in queue.get('queue_running', []) + queue.get('queue_pending', []))
                if present:
                    body.update(status='stopping', progress={'phase': 'stopping'})
                    continue
                body.update(status='cancelled', elapsed_ms=time.time_ns()//1_000_000 - body.get('submitted_at', row['createtime']))
                async with self.jobs.connection() as conn:
                    updated = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s AND body=%s RETURNING *', (Jsonb(body), row['block_id'], Jsonb(original)))).fetchone()
                if not updated:
                    row.update(await owned(self.jobs, row['block_id'], self.owner, 'generation'))
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
            if any(event == 'execution_interrupted' for event, _ in status.get('messages', [])):
                body.update(status='cancelled', outputs=[])
            elif status.get('status_str') == 'error':
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
            start, end = timestamps.get('execution_start'), timestamps.get('execution_success') or timestamps.get('execution_interrupted') or timestamps.get('execution_error')
            body['elapsed_ms'] = end - start if start is not None and end is not None else None
            async with self.jobs.connection() as conn:
                updated = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s AND body=%s RETURNING *', (Jsonb(body), row['block_id'], Jsonb(original)))).fetchone()
            if not updated:
                row.update(await owned(self.jobs, row['block_id'], self.owner, 'generation'))
        pending_ids = [item[1] for item in sorted((queue or {}).get('queue_pending', []))]
        positions = {prompt: i+1 for i, prompt in enumerate(pending_ids)}
        for row in rows:
            row['body']['queue_position'] = positions.get(row['body'].get('prompt_id')) if row['body'].get('comfy_url', COMFY) == endpoint(self.settings) else None
        try:
            reorder_available = bool((await asyncio.wait_for(comfy_at(endpoint(self.settings), '/director/queue-capabilities'), 3)).get('reorder')) if any(r['body'].get('provider') != PROVIDER for r in rows) else False
        except (HTTPClientError, OSError, ValueError, asyncio.TimeoutError):
            reorder_available = False
        self.finish({'history': rows, 'reorder_available': reorder_available})


class OutputHandler(PrivateHandler):
    async def get(self, job_id, index):
        row = await owned(self.jobs, job_id, self.owner, 'generation')
        outputs = row['body'].get('outputs', [])
        if int(index) >= len(outputs):
            raise tornado.web.HTTPError(404)
        if row['body'].get('provider') == PROVIDER:
            from backend.inference import serve_output
            await serve_output(self, outputs[int(index)])
            return
        headers = {}
        if self.request.headers.get('Range'):
            headers['Range'] = self.request.headers['Range']
        try:
            response = await AsyncHTTPClient().fetch(HTTPRequest(row['body'].get('comfy_url', COMFY) + '/view?' + urlencode(outputs[int(index)]), headers=headers, request_timeout=120))
        except HTTPClientError:
            raise tornado.web.HTTPError(502, reason='生成文件暂不可用，请确认 ComfyUI 正在运行')
        self.set_status(response.code)
        for name in ('Content-Type', 'Content-Range', 'Accept-Ranges'):
            if name in response.headers:
                self.set_header(name, response.headers[name])
        self.finish(response.body)
