"""Private API-key settings and durable cloud generation, independent of ComfyUI."""
import asyncio
import base64
import ipaddress
import json
import os
import re
import socket
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit

from psycopg.types.json import Jsonb
from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest
import tornado.web

from backend.inference_models import BY_ID, PROVIDER
from backend.workspace import PrivateHandler, owned, ID
from backend.cloud_storage import StorageError
from backend.billing import reported_cost, job_cost, log_charges

BASE_URL = 'https://model.service-inference.ai'
ACTIVE = ('submitting', 'queued', 'running')
RATIOS = ['16:9','4:3','1:1','3:4','9:16','21:9']
MAX_OUTPUT = 210 * 1024 * 1024


def load_keys(config):
    path=config['data_dir']/'.service-inference.json'
    if not path.exists():return {'active_key_id':None,'keys':[]}
    value=json.loads(path.read_text())
    if 'keys' in value:return value
    key=value.get('api_key','')
    return {'active_key_id':'legacy' if key else None,'keys':[{'id':'legacy','name':'原有 Key','api_key':key,'models':None}] if key else []}


def enabled_ids(value):
    saved=value.get('enabled_key_ids')
    return [p['id'] for p in value['keys'] if p['id'] in (saved if isinstance(saved,list) else [p['id'] for p in value['keys']])]


def key_profile(value,key_id=None):
    target=value['active_key_id'] if key_id is None else key_id
    return next((p for p in value['keys'] if p['id']==target),None)


def load_key(config,key_id=None):
    profile=key_profile(load_keys(config),key_id)
    return profile['api_key'] if profile else ''


def save_keys(config,value,filename='.service-inference.json'):
    directory=config['data_dir'];path=directory/filename
    temporary=directory/('.service-inference-'+uuid.uuid4().hex+'.tmp')
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as stream:json.dump(value,stream,ensure_ascii=False)
        os.replace(temporary,path)
    finally:temporary.unlink(missing_ok=True)


def save_key(config,key):
    # Compatibility helper for existing callers and single-key data.
    value=load_keys(config);profile=key_profile(value)
    if key:
        if profile:profile.update(api_key=key,models=None)
        else:value['keys'].append({'id':'legacy','name':'原有 Key','api_key':key,'models':None});value['active_key_id']='legacy'
    elif profile:
        value['keys'].remove(profile);value['active_key_id']=None
    save_keys(config,value)


def model_inventory(models):
    registry={m['remote_model']:m for m in BY_ID.values()};result=[]
    for item in models or []:
        name=item['id'];known=registry.get(name)
        kind=known['type'] if known else 'video' if item.get('type')=='video' else 'image' if item.get('type')=='image' or 'image' in name or 'seedream' in name else None
        if kind:result.append({'id':name,'type':kind,'integrated':known is not None,'name':known['name'] if known else name})
    return result


def keys_view(value):
    return dict(configured=bool(enabled_ids(value)),base_url=BASE_URL,active_key_id=value['active_key_id'],enabled_key_ids=enabled_ids(value),
        keys=[{'id':p['id'],'name':p['name'],'models_checked_at':p.get('models_checked_at'),
               'management_key_id':p.get('management_key_id'),
               'models':model_inventory(p.get('models')),'models_loaded':p.get('models') is not None} for p in value['keys']])


async def discover_models(key):
    result=await api(key,'/v1/models');items=result.get('data')
    if not isinstance(items,list):raise ProviderError('模型列表返回格式不正确')
    models={}
    for item in items:
        if isinstance(item,dict) and isinstance(item.get('id'),str) and re.fullmatch(r'[a-zA-Z0-9_.:/-]{1,200}',item['id']):
            models[item['id']]={'id':item['id'],'type':item.get('type') if item.get('type') in ('image','video','llm') else None}
    return list(models.values())


async def refresh_profile(profile):
    models=await discover_models(profile['api_key'])
    profile.update(models=models,models_checked_at=int(time.time()))


async def model_access(config,manager,all_keys=False):
    async with manager.lock:
        value=load_keys(config);error=None
        profiles=[p for p in value['keys'] if p['id'] in enabled_ids(value)] if all_keys else [key_profile(value)]
        allowed=set()
        for profile in profiles:
            if not profile:continue
            if profile.get('models') is None:
                try:await refresh_profile(profile);save_keys(config,value)
                except ProviderError as e:error=str(e)
            allowed.update(m['id'] for m in profile.get('models') or [])
        return allowed,error



def valid_key(value):
    if not isinstance(value, str) or not 8 <= len(value.strip()) <= 4096 or any(c.isspace() for c in value.strip()):
        raise tornado.web.HTTPError(400, reason='请输入有效的 API Key')
    if value.strip().startswith('sk-mgmt-'):
        raise tornado.web.HTTPError(400, reason='管理 AK 请填写到管理 AK 配置，不能用于生成')
    return value.strip()


class ProviderError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


async def api(key, path, data=None):
    try:
        response = await AsyncHTTPClient().fetch(HTTPRequest(BASE_URL + path,
            method='GET' if data is None else 'POST',
            headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
            body=None if data is None else json.dumps(data), connect_timeout=20,
            request_timeout=300 if data is not None else 45, follow_redirects=False))
    except HTTPClientError as error:
        # Never echo response bodies: gateways can include the original request/key.
        message = {400:'请求参数或参考素材不符合模型要求',401:'API Key 无效',402:'余额不足或用量超限',
                   403:'当前 Key 没有访问权限',404:'模型或任务不存在',429:'请求频率受限，请稍后查询',
                   503:'服务暂时没有可用容量'}.get(error.code, '网络或服务异常')
        if error.code == 599 and data is not None:
            message = '提交结果未确认，服务可能已受理；请在服务控制台确认，勿直接重复生成'
        raise ProviderError(f'service-inference：{message}（{error.code}）', error.code) from None
    try:
        result = json.loads(response.body)
        if not isinstance(result, dict):
            raise ValueError()
        if result.get('error'):
            raise ProviderError('service-inference 返回错误，请在服务控制台查看详情')
        request_id = response.headers.get('X-Request-Id')
        if isinstance(request_id, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', request_id):
            result['_request_id'] = request_id
        return result
    except (ValueError, TypeError):
        raise ProviderError('service-inference 返回了无法识别的响应') from None


class InferenceSettingsHandler(PrivateHandler):
    async def get(self):self.finish(keys_view(load_keys(self.settings['config'])))

    async def post(self):
        config=self.settings['config'];data=self.data()
        async with self.settings['inference_manager'].lock:
            value=load_keys(config);action=data.get('action','save')
            if action == 'reveal':
                profile = key_profile(value, data.get('id', '')) if data.get('id') else None
                if not profile:
                    raise tornado.web.HTTPError(404, reason='AK 配置不存在')
                self.set_header('Cache-Control', 'no-store')
                self.finish({'api_key': profile['api_key']})
                return
            profile=key_profile(value,data.get('id'));active=key_profile(value)
            value['enabled_key_ids']=enabled_ids(value)
            if data.get('clear'):action='delete';profile=active
            if action in ('select','refresh','delete','enable') and not profile:raise tornado.web.HTTPError(404,reason='Key 配置不存在')
            if action=='delete' or action=='save' and profile and data.get('api_key') and data['api_key'].strip()!=profile['api_key']:
                async with self.jobs.connection() as conn:
                    owner_filter = " AND COALESCE(body->>'credential_owner',body->>'owner_id')=%s" if config.get('cloud_owner') else ''
                    params = (PROVIDER,profile['id']) + ((config['cloud_owner'],) if owner_filter else ())
                    busy=await (await conn.scan("SELECT 1 FROM entities WHERE body->>'provider'=%s AND body->>'status' IN ('submitting','queued','running') AND COALESCE(body->>'credential_id','legacy')=%s" + owner_filter + " LIMIT 1",params)).fetchone()
                if busy:raise tornado.web.HTTPError(409,reason='此 Key 仍有生成任务，请完成后再修改密钥或删除；可以切换其他 Key')
            try:
                if action=='enable':
                    if not isinstance(data.get('enabled'),bool):raise tornado.web.HTTPError(400,reason='启用状态需为布尔值')
                    if data['enabled']:
                        await refresh_profile(profile)
                        if profile['id'] not in value['enabled_key_ids']:value['enabled_key_ids'].append(profile['id'])
                    else:value['enabled_key_ids']=[i for i in value['enabled_key_ids'] if i!=profile['id']]
                    if value['active_key_id'] not in value['enabled_key_ids']:value['active_key_id']=next(iter(value['enabled_key_ids']),None)
                elif action=='delete':
                    value['keys'].remove(profile)
                    value['enabled_key_ids']=[i for i in value['enabled_key_ids'] if i!=profile['id']]
                    if value['active_key_id']==profile['id']:value['active_key_id']=None
                elif action in ('select','refresh'):
                    await refresh_profile(profile)
                    if action=='select':
                        value['active_key_id']=profile['id']
                        if profile['id'] not in value['enabled_key_ids']:value['enabled_key_ids'].append(profile['id'])
                elif action=='save':
                    name=data.get('name') or (profile['name'] if profile else '新 Key')
                    if not isinstance(name,str) or not 1<=len(name.strip())<=80:raise tornado.web.HTTPError(400,reason='名称需为 1–80 个字符')
                    key=valid_key(data.get('api_key') or (profile['api_key'] if profile else ''))
                    if any(p['api_key']==key and p is not profile for p in value['keys']):raise tornado.web.HTTPError(400,reason='此 Key 已保存，请直接选择已有配置')
                    if not profile:
                        if len(value['keys'])>=30:raise tornado.web.HTTPError(400,reason='最多保存 30 个 Key')
                        profile={'id':uuid.uuid4().hex};value['keys'].append(profile)
                    profile.update(name=name.strip(),api_key=key)
                    if 'management_key_id' in data:
                        from backend.management import load as load_management
                        management_id = data['management_key_id']
                        if not isinstance(management_id, str) or not management_id or not key_profile(load_management(config), management_id):
                            raise tornado.web.HTTPError(400, reason='请选择已保存的管理 AK，或先添加管理 AK')
                        profile['management_key_id'] = management_id
                    await refresh_profile(profile)
                    if data.get('activate',True):
                        value['active_key_id']=profile['id']
                        if profile['id'] not in value['enabled_key_ids']:value['enabled_key_ids'].append(profile['id'])
                else:raise tornado.web.HTTPError(400,reason='未知配置操作')
            except ProviderError as error:raise tornado.web.HTTPError(502,reason=str(error))
            save_keys(config,value)
        self.finish(keys_view(value))


class InferenceTestHandler(PrivateHandler):
    async def post(self):
        data=self.data();key=valid_key(data.get('api_key') or load_key(self.settings['config'],data.get('id')))
        try:models=await discover_models(key)
        except ProviderError as error:raise tornado.web.HTTPError(502,reason=str(error))
        self.finish({'ok':True,'models':model_inventory(models)})


class InferenceCostHandler(PrivateHandler):
    async def post(self, job_id):
        row = await owned(self.jobs, job_id, self.owner, 'generation')
        body = row['body']
        if body.get('provider') != PROVIDER or body.get('type') != 'video':
            raise tornado.web.HTTPError(400, reason='仅支持查询 service-inference 视频任务费用')
        if body.get('status') in ACTIVE:
            raise tornado.web.HTTPError(409, reason='任务进行中，完成后可查询费用')
        config = self.settings['config']
        if config.get('cloud_owner') and body.get('credential_owner', body.get('owner_id')) != config['cloud_owner']:
            raise tornado.web.HTTPError(403, reason='请由生成任务的账号查询费用')
        remote_id = body.get('remote_task_id')
        if not isinstance(remote_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', remote_id):
            raise tornado.web.HTTPError(400, reason='此记录没有可查询的云端任务 ID')
        key = load_key(config, body.get('credential_id', 'legacy'))
        if not key:
            raise tornado.web.HTTPError(400, reason='原任务使用的 Key 已删除，请恢复原 Key 配置')
        model = BY_ID.get(body.get('model'))
        if not model:
            raise tornado.web.HTTPError(400, reason='无法识别此记录的模型接口版本')
        try:
            response = await api(key, '/' + model['api_version'] + '/video/tasks/' + quote(remote_id, safe=''))
        except ProviderError as error:
            raise tornado.web.HTTPError(502, reason=str(error))
        cost = reported_cost(response)
        patch = {'cost_checked_at': int(time.time() * 1000)}
        if cost:
            patch['cost'] = cost
        await self.settings['inference_manager'].update(job_id, **patch)
        self.finish({'cost': cost or job_cost(body), 'reported': cost is not None,
                     'checked_at': patch['cost_checked_at'],
                     'message': '已读取服务返回费用' if cost else '任务接口未返回费用；请到服务商账单核对，未知费用不计为零元'})


class InferenceCostImportHandler(PrivateHandler):
    async def post(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        try:
            charges = log_charges(self.data().get('text'))
        except ValueError as error:
            raise tornado.web.HTTPError(400, reason=str(error))
        async with self.jobs.connection() as conn:
            rows = await (await conn.scan("SELECT * FROM entities WHERE body->>'kind'='generation' AND body->>'owner_id'=%s AND body->>'project_id'=%s AND body->>'provider'=%s", (self.owner, project_id, PROVIDER))).fetchall()
        matched = 0
        checked_at = int(time.time() * 1000)
        for row in rows:
            body = row['body']
            model = BY_ID.get(body.get('model'))
            if not model:
                continue
            identifier = body.get('remote_task_id') if body.get('type') == 'video' else body.get('remote_request_id')
            cost = charges.get((identifier, model['remote_model']))
            if cost:
                await self.settings['inference_manager'].update(row['block_id'], cost=cost, cost_checked_at=checked_at)
                matched += 1
        self.finish({'matched': matched, 'charges': len(charges), 'message': f'已回填 {matched} 条生成记录费用；重复导入不会重复累计'})


def public_url(value):
    if not isinstance(value, str) or len(value) > 8192 or any(c.isspace() for c in value):
        raise ValueError('素材 URL 格式不正确')
    parts = urlsplit(value)
    if parts.scheme not in ('http','https') or not parts.hostname or parts.username or parts.password or parts.fragment:
        raise ValueError('请使用不含账号密码的公网 http(s) 素材 URL')
    if parts.hostname.lower() == 'localhost' or parts.hostname.lower().endswith(('.local','.localhost')):
        raise ValueError('云端无法读取本地地址，请填写公网素材 URL')
    try:
        address = ipaddress.ip_address(parts.hostname)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise ValueError('云端无法读取内网地址，请填写公网素材 URL')
    _ = parts.port
    return value


def urls(data, key, limit):
    value = data.get(key, '')
    if not isinstance(value, str):
        raise ValueError('参考 URL 请每行填写一项')
    values = [public_url(line.strip()) for line in value.splitlines() if line.strip()]
    if len(values) > limit:
        raise ValueError(f'参考素材最多 {limit} 项')
    return values


def payload_for(model, mode, data):
    prompt = data.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 12000:
        raise ValueError('请填写提示词（最多 12000 字符）')
    if mode not in model['modes']:
        raise ValueError('模型不支持此模式')
    p = {'model': model['remote_model'], 'prompt': prompt}
    images = urls(data, 'image_urls', model['ref_limit']) if mode != 'text' else []
    if model['type'] == 'image':
        size = data.get('size', model['sizes'][0])
        if size not in model['sizes']:
            raise ValueError('不支持的图片分辨率')
        if mode in ('image','edit','reference') and not images:
            raise ValueError('请填写至少一张公网参考图片 URL')
        if mode=='reference' and len(images)<2:raise ValueError('多图融合请提供至少两张参考图')
        if model.get('image_api') == 'openai':
            output_format = data.get('output_format', 'png')
            quality = data.get('quality', 'auto')
            background = data.get('background', 'auto')
            count = data.get('n', 1)
            if output_format not in model['output_formats']: raise ValueError('此模型不支持该输出格式')
            if quality not in model['qualities']: raise ValueError('此模型不支持该画质')
            if background not in ('auto', 'opaque', 'transparent'): raise ValueError('不支持的背景选项')
            if background == 'transparent' and output_format == 'jpeg': raise ValueError('透明背景请选择 PNG 或 WebP')
            if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 10:
                raise ValueError('生成张数需为 1–10 的整数')
            p.update(size=size, output_format=output_format, quality=quality, background=background, n=count)
            if images: p['images'] = [{'image_url': url} for url in images]
            return p
        output_format=data.get('output_format','jpeg');optimize=data.get('optimize_mode','standard');watermark=data.get('watermark',True)
        if output_format not in model['output_formats']:raise ValueError('此模型不支持该输出格式')
        if optimize not in model['optimize_modes']:raise ValueError('此模型不支持该提示词优化模式')
        if not isinstance(watermark,bool):raise ValueError('水印选项格式不正确')
        p.update(size=size, response_format='b64_json', watermark=watermark,output_format=output_format)
        if 'fast' in model['optimize_modes']:p['optimize_prompt_options']={'mode':optimize}
        if mode=='series':
            count=data.get('max_images',4)
            if not isinstance(count,int) or isinstance(count,bool) or not 1<=count<=15:raise ValueError('组图最多张数需为 1–15 的整数')
            if count+len(images)>15:raise ValueError('参考图数量与最多生成张数之和不能超过 15')
            p.update(sequential_image_generation='auto',sequential_image_generation_options={'max_images':count})
        if images:
            p['image'] = images
        return p
    duration = data.get('duration', 5)
    minimum,maximum=model.get('min_duration',4),model.get('max_duration',15)
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration != int(duration) or not minimum <= duration <= maximum:
        raise ValueError(f'视频时长需为 {minimum}–{maximum} 秒整数')
    resolution = data.get('resolution', model['resolutions'][0])
    ratio = data.get('ratio','16:9')
    if resolution not in model['resolutions'] or ratio not in RATIOS + (['adaptive'] if model['api_version']=='v1' and images else []):
        raise ValueError('不支持的分辨率或画面比例')
    content = [{'type':'text','text':prompt}]
    def add(kind, values, role):
        for value in values:
            content.append({'type':kind+'_url', kind+'_url':{'url':value}, 'role':role})
    if model['api_version'] == 'v1':
        if mode != 'text' and not images:
            raise ValueError('请填写参考图片 URL')
        add('image', images, 'reference_image')
    elif mode == 'image':
        first = urls(data,'first_frame',1)
        last = urls(data,'last_frame',1)
        if not first:
            raise ValueError('请填写首帧图片 URL')
        add('image',first,'first_frame'); add('image',last,'last_frame')
    elif mode == 'reference':
        videos, audios = urls(data,'video_urls',3), urls(data,'audio_urls',3)
        if not 1 <= len(images)+len(videos)+len(audios) <= model['ref_limit']:
            raise ValueError('请填写 1–12 项参考素材')
        add('image',images,'reference_image'); add('video',videos,'reference_video'); add('audio',audios,'reference_audio')
    p = dict(model=model['remote_model'], content=content, duration=int(duration), resolution=resolution, ratio=ratio)
    if model['api_version']=='v2':
        if not isinstance(data.get('generate_audio',True), bool):
            raise ValueError('音频选项格式不正确')
        p['generate_audio'] = data.get('generate_audio',True)
    return p


async def download(url, destination):
    """Download only provider-returned public URLs, without the API key, with bounded size."""
    for _ in range(5):
        public_url(url)
        parts = urlsplit(url)
        addresses = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme=='https' else 80), type=socket.SOCK_STREAM), 15)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError('生成文件地址不是公网地址')
        size = 0
        temporary = destination.with_suffix('.part')
        try:
            with temporary.open('wb') as stream:
                def chunk(data):
                    nonlocal size
                    size += len(data)
                    if size > MAX_OUTPUT:
                        raise ValueError('生成文件超过 210 MB 本地保存上限')
                    stream.write(data)
                response = await AsyncHTTPClient().fetch(HTTPRequest(url, request_timeout=1800,
                    connect_timeout=20, follow_redirects=False, streaming_callback=chunk), raise_error=False)
            if response.code in (301,302,303,307,308):
                url = urljoin(url, response.headers.get('Location',''))
                continue
            if response.code != 200 or not size:
                raise ValueError('生成文件下载失败')
            os.replace(temporary, destination)
            return
        finally:
            temporary.unlink(missing_ok=True)
    raise ValueError('生成文件重定向过多')


async def download_memory(url, progress=None):
    """Fetch provider output with the same public-host restrictions, without disk files."""
    for _ in range(5):
        public_url(url); parts = urlsplit(url)
        addresses = await asyncio.wait_for(asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == 'https' else 80), type=socket.SOCK_STREAM), 15)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError('生成文件地址不是公网地址')
        chunks = []; size = 0; pending = None; reported = 0
        def receive(data):
            nonlocal size, pending, reported
            size += len(data)
            if size > MAX_OUTPUT: raise ValueError('生成文件超过转存上限')
            chunks.append(data)
            if progress and (pending is None or pending.done()) and time.monotonic() - reported >= .5:
                if pending is not None: pending.result()
                pending = asyncio.create_task(progress(size))
                reported = time.monotonic()
        try:
            response = await AsyncHTTPClient().fetch(HTTPRequest(url, request_timeout=1800, connect_timeout=20,
                follow_redirects=False, streaming_callback=receive), raise_error=False)
        finally:
            if pending is not None: await pending
        if progress: await progress(size)
        if response.code in (301, 302, 303, 307, 308):
            url = urljoin(url, response.headers.get('Location', '')); continue
        if response.code != 200 or not size: raise ValueError('生成文件读取失败')
        return b''.join(chunks)
    raise ValueError('生成文件重定向过多')


def remote_progress(task):
    """Keep only bounded progress counters; never persist arbitrary provider metadata."""
    metadata = task.get('metadata') if isinstance(task.get('metadata'), dict) else {}
    source = task.get('progress', metadata.get('progress'))
    result = {'phase': 'remote', 'checked_at': int(time.time() * 1000)}
    if isinstance(source, dict):
        def number(*names):
            for name in names:
                value = source.get(name)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 10**12:
                    return value
        completed, total = number('completed', 'current', 'value'), number('total', 'maximum')
        if completed is not None and total and completed <= total:
            result.update(value=completed, maximum=total)
        percent = number('percent', 'percentage')
        if 'maximum' not in result and percent is not None and percent <= 100:
            result.update(value=percent, maximum=100)
        stage = source.get('stage', source.get('phase'))
        if stage in ('downloading', 'uploading', 'validating', 'preparing', 'processing', 'pending'):
            result['stage'] = stage
    return result


class InferenceManager:
    poll_intervals = {'v1': 15, 'v2': 10}

    def __init__(self, config, pool):
        self.config, self.pool = config, pool
        self.lock = asyncio.Lock()
        self.tasks = {}
        self.slots = asyncio.Semaphore(3)

    async def update(self, job_id, **patch):
        async with self.pool.connection() as conn:
            await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s', (Jsonb(patch), job_id), block_id=job_id)

    async def start(self):
        async with self.pool.connection() as conn:
            rows = await (await conn.scan("SELECT * FROM entities WHERE body->>'provider'=%s AND body->>'status' IN ('submitting','queued','running')", (PROVIDER,))).fetchall()
        for row in rows:
            if self.config.get('cloud_owner') and row['body'].get('credential_owner', row['body'].get('owner_id')) != self.config['cloud_owner']:
                continue
            if row['body'].get('remote_task_id'):
                self.launch(row['block_id'], row['body'])
            else:
                await self.update(row['block_id'], status='failed', error='应用在提交期间关闭，云端受理结果未确认；请先在服务控制台核对，勿直接重复生成')

    def launch(self, job_id, body, payload=None):
        if job_id in self.tasks:
            return
        task = asyncio.create_task(self.run(job_id, dict(body), payload))
        self.tasks[job_id] = task
        task.add_done_callback(lambda _: self.tasks.pop(job_id, None))

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def store_outputs(self, job_id, body, outputs):
        if body.get('output_storage') == 'cloud' or self.config.get('cloud_mode'):
            if not isinstance(outputs, list) or not 1 <= len(outputs) <= 15: raise ValueError('任务没有返回有效生成文件')
            from backend.cloud_storage import store_generated, fetch_generated_video
            result = []
            for index, output in enumerate(outputs):
                async def phase(stage, **counts):
                    body['_output_phase'] = stage
                    await self.update(job_id, remote_status=stage, error=None, progress={'phase': 'saving', 'maximum': len(outputs), 'item': index + 1, **counts})
                if body['type'] == 'video' and not (isinstance(output, dict) and output.get('b64_json')):
                    direct = await fetch_generated_video(self.config, self.pool, body, output.get('url') if isinstance(output, dict) else output, f'{job_id}-{index}', phase)
                    if direct:
                        result.append(direct)
                        continue
                await phase('reading_output')
                if isinstance(output, dict) and output.get('b64_json'):
                    raw = base64.b64decode(output['b64_json'], validate=True)
                else:
                    async def received(size):
                        await phase('reading_output', bytes=size)
                    raw = await download_memory(output.get('url') if isinstance(output, dict) else output, progress=received)
                if not raw or len(raw) > MAX_OUTPUT: raise ValueError('生成文件大小异常')
                mime = 'video/mp4' if body['type'] == 'video' else 'image/png' if raw.startswith(b'\x89PNG') else 'image/webp' if raw.startswith(b'RIFF') and raw[8:12] == b'WEBP' else 'image/jpeg'
                if body.get('storage_profile_id'):
                    body['_output_phase'] = 'uploading_output'
                    uploaded = await store_generated(self.config, self.pool, body, raw, mime, f'{job_id}-{index}', phase)
                else:
                    # Older online jobs predate pinned storage profiles.
                    from backend.sync import upload_bytes
                    await phase('uploading_output')
                    uploaded = await upload_bytes({}, raw, mime, f'{job_id}-{index}', transport=self.config['storage_transport'])
                result.append({'remote_url': uploaded['url'], 'mime': mime, 'sha256': uploaded['sha256'], 'size': len(raw)})
            return result
        await self.update(job_id, remote_status='downloading', error=None, progress={'phase': 'saving'})
        directory = self.config['data_dir'] / 'generated'
        directory.mkdir(exist_ok=True)
        result = []
        if not isinstance(outputs,list) or not 1 <= len(outputs) <= 15:
            raise ValueError('任务没有返回有效生成文件')
        for index, output in enumerate(outputs):
            extension = 'mp4' if body['type']=='video' else 'jpg'
            if isinstance(output,dict) and output.get('output_format') in ('png', 'webp'):
                extension = output['output_format']
            filename = f'{job_id}-{index}.{extension}'
            path = directory / filename
            if isinstance(output,dict) and output.get('b64_json'):
                raw = base64.b64decode(output['b64_json'], validate=True)
                if not raw or len(raw)>MAX_OUTPUT:
                    raise ValueError('生成图片大小异常')
                if raw.startswith(b'\x89PNG'):
                    extension='png'
                elif raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
                    extension='webp'
                filename=f'{job_id}-{index}.{extension}'; path=directory/filename
                temporary=path.with_suffix('.part')
                await asyncio.to_thread(temporary.write_bytes,raw)
                os.replace(temporary,path)
            else:
                url = output.get('url') if isinstance(output,dict) else output
                await download(url,path)
            result.append({'filename':filename,'mime':'video/mp4' if extension=='mp4' else 'image/'+('jpeg' if extension=='jpg' else extension)})
        return result

    async def complete(self, job_id, body, outputs, usage):
        local = await self.store_outputs(job_id,body,outputs)
        usage = dict(usage) if isinstance(usage,dict) else {}
        usage['tokens'] = usage.get('total_tokens',usage.get('output_tokens'))
        await self.update(job_id,status='completed',outputs=local,usage=usage,
                          error=None,pending_outputs=None,pending_usage=None,failure=None,progress={'phase':'completed'},elapsed_ms=time.time_ns()//1_000_000-body['submitted_at'])

    async def run(self, job_id, body, payload):
        try:
            key = load_key(self.config,body.get('credential_id','legacy'))
            if not key:
                raise ProviderError('请先配置 service-inference API Key')
            if self.config.get('cloud_mode') and not body.get('storage_profile_id'):
                from backend.cloud_storage import load, active_id, fingerprint
                storage = load(self.config); profile_id = active_id(storage)
                profile = storage['profiles'].get(profile_id)
                if profile:
                    pinned = dict(output_storage='cloud', storage_profile_id=profile_id,
                                  storage_profile_name=profile.get('name') or profile.get('provider', '云存储'),
                                  storage_profile_fingerprint=fingerprint(profile))
                    body.update(pinned)
                    await self.update(job_id, **pinned)
            model = BY_ID[body['model']]
            if payload is not None:
                async with self.slots:
                    await self.update(job_id,status='running')
                    endpoint = ('/v1/images/edits' if model.get('image_api') == 'openai' and payload.get('images') else '/v1/images/generations') if body['type']=='image' else '/'+model['api_version']+'/video/generate'
                    response = await api(key, endpoint, payload)
                cost = reported_cost(response)
                if cost:
                    await self.update(job_id, cost=cost, cost_checked_at=int(time.time() * 1000))
                if response.get('_request_id'):
                    await self.update(job_id, remote_request_id=response['_request_id'])
                if body['type']=='image':
                    await self.complete(job_id,body,response.get('data'),response.get('usage'))
                    return
                task = response.get('task',{})
                remote_id = task.get('id')
                if not isinstance(remote_id,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}',remote_id):
                    raise ProviderError('提交响应未返回任务 ID；请在服务控制台确认，勿重复提交')
                body['remote_task_id']=remote_id
                await self.update(job_id,remote_task_id=remote_id,status='queued',remote_status=task.get('status','pending'),progress=remote_progress(task))
            interval = self.poll_intervals[model['api_version']]
            retries = 0
            while True:
                status = ''; operation = 'query'
                try:
                    if body.get('pending_outputs'):
                        task = {'status':'completed','outputs':body['pending_outputs'],'usage':body.get('pending_usage')}
                    else:
                        response = await api(key,'/'+model['api_version']+'/video/tasks/'+quote(body['remote_task_id'],safe=''))
                        task = response.get('task')
                    if not isinstance(task,dict):
                        raise ProviderError('任务查询响应不完整，稍后重试')
                    cost = reported_cost(task if body.get('pending_outputs') else response)
                    if cost:
                        await self.update(job_id, cost=cost, cost_checked_at=int(time.time() * 1000))
                    status=task.get('status','')
                    if task.get('error') or status in ('failed','cancelled','canceled'):
                        await self.update(job_id,status='failed',error='云端任务失败，请在 service-inference 控制台查看任务 '+body['remote_task_id'],remote_status=status)
                        return
                    if status=='completed':
                        operation = 'saving'
                        if not body.get('pending_outputs') and isinstance(task.get('outputs'), list):
                            body['pending_outputs'] = [o.get('url') if isinstance(o,dict) else o for o in task['outputs']]
                            body['pending_usage'] = task.get('usage') or task.get('metadata',{}).get('usage')
                            await self.update(job_id, pending_outputs=body['pending_outputs'], pending_usage=body['pending_usage'])
                        await self.update(job_id,status='running',remote_status='downloading')
                        await self.complete(job_id,body,task.get('outputs'),task.get('usage') or task.get('metadata',{}).get('usage'))
                        return
                    await self.update(job_id,status='queued' if status in ('pending','preparing') else 'running',remote_status=status,error=None,progress=remote_progress(task))
                except (ProviderError,HTTPClientError,OSError,ValueError,StorageError,tornado.web.HTTPError) as error:
                    if isinstance(error, ProviderError) and error.code in (401,403,404):
                        await self.update(job_id,status='failed',error=str(error)+'；远端任务不会被取消，请在控制台核对任务 '+body['remote_task_id'])
                        return
                    # Retry reads/downloads only; never retry a billed submission.
                    retries += 1
                    stage = body.get('_output_phase', 'downloading') if operation == 'saving' else 'query'
                    label = {'query':'查询云端任务', 'downloading':'保存结果到本机', 'reading_output':'读取生成结果',
                             'uploading_output':'上传结果到云存储', 'fetching_output':'云存储抓取生成结果', 'verifying_output':'校验云存储结果'}.get(stage, '保存结果')
                    detail = str(error) if isinstance(error, (StorageError, ProviderError)) else ('HTTP '+str(error.code) if isinstance(error, HTTPClientError) else '网络连接或文件处理异常')
                    if isinstance(error, ValueError) and str(error) in ('生成文件读取失败', '生成文件下载失败', '生成文件超过转存上限', '生成文件地址不是公网地址', '生成文件重定向过多', '任务没有返回有效生成文件'):
                        detail = str(error)
                    if isinstance(error, HTTPClientError) and error.code == 599: detail = '网络连接失败或读取超时'
                    if isinstance(error, tornado.web.HTTPError): detail = '云存储请求失败（HTTP '+str(error.status_code)+'）'
                    await self.update(job_id,error=f'{label}失败：{detail}；将自动重试（第{retries}次），不会重新提交生成',
                                      failure={'stage':stage,'attempt':retries,'at':int(time.time()*1000),'code':getattr(error,'code',None)})
                await asyncio.sleep(min(interval, 2) if status == 'preparing' else interval)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            message=str(error) if isinstance(error,ProviderError) else '云端提交或结果保存失败，请在服务控制台核对结果后再操作'
            await self.update(job_id,status='failed',error=message)


async def submit(handler, project_id, data):
    project = await owned(handler.projects, project_id, handler.owner, 'project')
    card = next((c for c in project['body']['canvas']['cards'] if c['id']==data.get('card_id')),None)
    model = BY_ID.get(data.get('model'))
    if not card or not model or model['type']!=card['type']:
        raise tornado.web.HTTPError(400,reason='请先保存卡片并选择对应模型')
    job_id=data.get('request_id')
    if not isinstance(job_id,str) or not ID.fullmatch(job_id):
        raise tornado.web.HTTPError(400,reason='请求 UUID 不正确')
    try:
        payload=payload_for(model,data.get('mode'),data)
    except (ValueError,TypeError,OverflowError) as error:
        raise tornado.web.HTTPError(400,reason=str(error))
    manager=handler.settings['inference_manager']
    async with manager.lock:
        credentials=load_keys(handler.settings['config']);credential=key_profile(credentials,data.get('credential_id') or None)
        from backend.cloud_storage import load, active_id, access_domain, fingerprint
        config = handler.settings['config']
        destination = 'cloud' if config.get('cloud_mode') else data.get('output_storage', 'local')
        if destination not in ('local', 'cloud'):
            raise tornado.web.HTTPError(400, reason='结果保存位置不正确')
        storage_fields = {'output_storage': destination}
        if destination == 'cloud':
            storage = load(config); profile_id = active_id(storage)
            profile = storage['profiles'].get(profile_id)
            if not profile:
                raise tornado.web.HTTPError(400, reason='请先保存并启用云存储，用于保存生成结果')
            if not access_domain(profile).startswith('https://'):
                raise tornado.web.HTTPError(400, reason='生成结果云存储访问域名必须使用 HTTPS')
            storage_fields.update(storage_profile_id=profile_id, storage_profile_name=profile.get('name') or profile.get('provider', '云存储'),
                                  storage_profile_fingerprint=fingerprint(profile))
        if credential and credential['id'] not in enabled_ids(credentials):
            raise tornado.web.HTTPError(400,reason='所选生成 AK 未启用，请在设置中勾选启用或在卡片选择其他 AK')
        if not credential:
            raise tornado.web.HTTPError(400,reason='请先在 service-inference 设置中保存 API Key')
        if credential.get('models') is None:
            try:await refresh_profile(credential);save_keys(handler.settings['config'],credentials)
            except ProviderError as error:raise tornado.web.HTTPError(502,reason=str(error))
        if model['remote_model'] not in {m['id'] for m in credential['models']}:raise tornado.web.HTTPError(403,reason='所选 AK 的模型列表不包含此模型，请在卡片选择其他 AK 或模型')
        # Explicit allowlist keeps credentials and arbitrary client fields out of history.
        fields=('prompt','size','resolution','ratio','duration','generate_audio','image_urls','video_urls','audio_urls','first_frame','last_frame','output_format','optimize_mode','watermark','max_images','quality','background','n')
        params={k:data[k] for k in fields if k in data}
        params.update({k:payload[k] for k in ('size','resolution','ratio','duration','generate_audio') if k in payload})
        body=dict(provider=PROVIDER,kind='generation',credential_owner=getattr(handler,'user',{'user_id':handler.owner})['user_id'],created_by=getattr(handler,'user',{'user_id':handler.owner}),credential_id=credential['id'],credential_name=credential['name'],owner_id=handler.owner,project_id=project_id,card_id=card['id'],
                  type=card['type'],model=model['id'],mode=data['mode'],params=params,refs=[],ref_info={},
                  status='submitting',outputs=[],usage={'tokens':None},submitted_at=time.time_ns()//1_000_000, **storage_fields)
        async with handler.jobs.connection() as conn:
            inserted=await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT DO NOTHING RETURNING block_id',(job_id,Jsonb(body)), block_id=job_id)).fetchone()
        if inserted:
            manager.launch(job_id,body,payload)
    handler.finish(await owned(handler.jobs,job_id,handler.owner,'generation'))


async def serve_output(handler, output):
    filename=output.get('filename','')
    if not re.fullmatch(r'[0-9a-f]{32}-\d+\.(jpg|png|mp4)',filename):
        raise tornado.web.HTTPError(404)
    path=handler.settings['config']['data_dir']/'generated'/filename
    if not path.is_file():
        raise tornado.web.HTTPError(404,reason='本地生成文件不存在')
    size=path.stat().st_size
    start,end=0,size-1
    requested=handler.request.headers.get('Range')
    if requested:
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',requested)
        if not match or not any(match.groups()):
            handler.set_header('Content-Range',f'bytes */{size}');raise tornado.web.HTTPError(416)
        left,right=match.groups()
        if left:
            start=int(left);end=min(int(right),end) if right else end
        else:
            start=max(0,size-int(right))
        if start>end or start>=size:
            handler.set_header('Content-Range',f'bytes */{size}');raise tornado.web.HTTPError(416)
        handler.set_status(206)
        handler.set_header('Content-Range',f'bytes {start}-{end}/{size}')
    handler.set_header('Content-Type',output['mime'])
    handler.set_header('Accept-Ranges','bytes')
    handler.set_header('Content-Length',end-start+1)
    with path.open('rb') as stream:
        stream.seek(start)
        remaining=end-start+1
        while remaining:
            chunk=stream.read(min(256*1024,remaining))
            if not chunk:break
            remaining-=len(chunk);handler.write(chunk);await handler.flush()
    handler.finish()
