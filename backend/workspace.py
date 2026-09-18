"""Private workspace records routed by entity UUID."""
import asyncio
import json
import math
import re
import time
import uuid
from pathlib import Path
from urllib.parse import quote
from tornado.iostream import StreamClosedError

from psycopg.types.json import Jsonb
import tornado.web

from backend.server import BaseHandler
from backend.inference_models import BY_ID as CLOUD_BY_ID

ID = re.compile(r'^[0-9a-f]{32}$')


async def owned(pool, block_id, owner, kind):
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'=%s",
            (block_id, owner, kind), block_id=block_id)).fetchone()
    if not row:
        raise tornado.web.HTTPError(404, reason='内容不存在或无权访问')
    return row


def finite(value, low, high):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def validate_project(data):
    if not isinstance(data, dict):
        raise ValueError('项目格式不正确')
    for field, limit in [('title', 160), ('subtitle', 240), ('description', 10000)]:
        if not isinstance(data.get(field, ''), str) or len(data.get(field, '')) > limit:
            raise ValueError('标题或描述过长')
    if not data.get('title', '').strip():
        raise ValueError('请输入主标题')
    covers = data.get('covers', [])
    if not isinstance(covers, list) or len(covers) > 20 or any(not isinstance(x, str) or not ID.fullmatch(x) for x in covers):
        raise ValueError('封面列表格式不正确（最多 20 张）')
    canvas = data.get('canvas', {'viewport': {'x': 60, 'y': 60, 'zoom': 1}, 'cards': []})
    cards = canvas.get('cards') if isinstance(canvas, dict) else None
    if not isinstance(cards, list) or len(cards) > 200:
        raise ValueError('画布最多 200 张卡片')
    viewport = canvas.get('viewport', {})
    if not all(finite(viewport.get(k), lo, hi) for k, lo, hi in [('x', -1e7, 1e7), ('y', -1e7, 1e7), ('zoom', .15, 3)]):
        raise ValueError('画布视角不正确')
    seen = set()
    for card in cards:
        if not isinstance(card, dict) or not isinstance(card.get('id'), str) or not ID.fullmatch(card['id']) or card['id'] in seen:
            raise ValueError('卡片 UUID 不正确或重复')
        seen.add(card['id'])
        if not isinstance(card.get('title', ''), str) or len(card.get('title', '')) > 160:
            raise ValueError('卡片名称最多 160 个字符')
        if card.get('type') not in ('image', 'video', 'asset', 'chat') or card.get('mode') not in (('chat',) if card.get('type') == 'chat' else ('media',) if card.get('type') == 'asset' else ('text', 'image', 'reference','edit','series')):
            raise ValueError('卡片模式不正确')
        if card['type'] == 'chat' and (not isinstance(card.get('chat_id'), str) or not ID.fullmatch(card['chat_id'])):
            raise ValueError('评论区 ID 不正确')
        if card['type'] == 'chat' and (not isinstance(card.get('name', ''), str) or len(card.get('name', '')) > 160):
            raise ValueError('评论区名称过长')
        if not all(finite(card.get(k), lo, hi) for k, lo, hi in [('x', -1e7, 1e7), ('y', -1e7, 1e7), ('w', 380, 3000), ('h', 200 if card.get('type') == 'asset' else 520, 4000)]):
            raise ValueError('卡片尺寸不正确')
        if card['type'] == 'asset' and (not isinstance(card.get('asset_id'), str) or not ID.fullmatch(card['asset_id'])):
            raise ValueError('素材 UUID 不正确')
        drafts = card.get('drafts', {})
        if not isinstance(drafts, dict) or set(drafts) - {'text', 'image', 'reference','edit','series'}:
            raise ValueError('卡片参数格式不正确')
        for draft in drafts.values():
            if not isinstance(draft, dict) or not isinstance(draft.get('prompt', ''), str) or len(draft.get('prompt', '')) > 12000:
                raise ValueError('提示词格式不正确')
            if 'model' in draft and draft['model'] not in ('z-image-turbo', 'z-image', 'minimax-h3', 'minimax-h3-ref2va', 'ltx-2.5') and draft['model'] not in CLOUD_BY_ID:
                raise ValueError('未知模型')
            if not isinstance(draft.get('negative_prompt', ''), str) or len(draft.get('negative_prompt', '')) > 12000:
                raise ValueError('反向提示词格式不正确')
            refs = draft.get('refs', [])
            if not isinstance(refs, list) or len(refs) > 8 or any(not isinstance(ref, str) or not ID.fullmatch(ref) for ref in refs):
                raise ValueError('参考图片列表不正确')
            for key in ('width', 'height', 'steps', 'seed', 'denoise', 'duration', 'cfg'):
                if key in draft and not finite(draft[key], -1, 2**53 - 1):
                    raise ValueError('卡片数值参数不正确')
        hidden = card.get('hiddenJobs', [])
        if not isinstance(hidden, list) or len(hidden) > 10000 or any(not isinstance(job, str) or not ID.fullmatch(job) for job in hidden):
            raise ValueError('隐藏结果列表格式不正确')
        pins = card.get('pins', [])
        if not isinstance(pins, list) or len(pins) > 8 or any(not isinstance(pin, str) or not ID.fullmatch(pin) for pin in pins):
            raise ValueError('固定对比项格式不正确')
        if not isinstance(card.get('syncPinPlayback', False), bool):
            raise ValueError('视频同时播放设置不正确')
        if not finite(card.get('pinLimit', 2), 0, 8):
            raise ValueError('对比位数量不正确')
    connections = canvas.get('connections', [])
    if not isinstance(connections, list) or len(connections) > 1000:
        raise ValueError('画布最多 1000 条连接线')
    edge_ids, pairs = set(), set()
    for edge in connections:
        if not isinstance(edge, dict) or not isinstance(edge.get('id'), str) or not ID.fullmatch(edge['id']) or edge['id'] in edge_ids:
            raise ValueError('连接线 UUID 不正确或重复')
        source, target = edge.get('source'), edge.get('target')
        if not isinstance(source, str) or not isinstance(target, str) or source not in seen or target not in seen or source == target or (source, target) in pairs:
            raise ValueError('连接线必须连接当前画布的两张不同卡片且不能重复')
        edge_ids.add(edge['id']); pairs.add((source, target))
    from backend.timeline import validate_timelines
    validate_timelines(canvas)
    if len(json.dumps(canvas)) > 2_000_000:
        raise ValueError('画布数据过大')
    return {k: data.get(k, '') for k in ('title', 'subtitle', 'description')} | {'covers': covers, 'canvas': canvas}


class PrivateHandler(BaseHandler):
    @property
    def settings(self):
        settings = super().settings
        actor_id = self.request.headers.get('X-Director-Actor', '')
        actor = settings.get('collaboration_actors', {}).get(actor_id)
        if actor and (self.request.method == 'POST' or self.request.path == '/api/models'):
            return {**settings, 'config': actor['config'], 'inference_manager': actor['manager']}
        return settings

    def on_finish(self):
        if hasattr(self, '_actor_token'):
            from backend.entities import actor_context
            actor_context.reset(self._actor_token)


    async def prepare(self):
        super().prepare()
        self.user = await self.session_user()
        if not self.user:
            raise tornado.web.HTTPError(401, reason='请先登录')
        self.owner = self.user['user_id']
        actor = self.application.settings.get('collaboration_actors', {}).get(self.request.headers.get('X-Director-Actor', ''))
        if actor: self.user = actor['user']
        self.collaboration_project = self.request.headers.get('X-Director-Project')
        from backend.entities import actor_context
        self._actor_token = actor_context.set({'user_id': self.user['user_id'], 'login': self.user['login']})
        self.projects = self.jobs = self.settings['entities']

    def data(self):
        try:
            value = json.loads(self.request.body)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, TypeError):
            raise tornado.web.HTTPError(400, reason='JSON 格式不正确')


class ProjectsHandler(PrivateHandler):
    async def get(self):
        async with self.projects.connection() as conn:
            rows = await (await conn.scan("SELECT block_id, body - 'canvas' AS body, createtime, updatetime FROM entities WHERE body->>'kind'='project' AND body->>'owner_id'=%s ORDER BY updatetime DESC", (self.owner,), order_by='updatetime')).fetchall()
        self.finish({'projects': rows})

    async def post(self):
        await save_project(self)


class ProjectHandler(PrivateHandler):
    async def get(self, project_id):
        self.finish(await owned(self.projects, project_id, self.owner, 'project'))

    async def post(self, project_id):
        await save_project(self, project_id)


async def save_project(handler, project_id=None):
    data = handler.data()
    try:
        body = validate_project(data)
    except ValueError as error:
        raise tornado.web.HTTPError(400, reason=str(error))
    asset_ids = set(body['covers'])
    for card in body['canvas']['cards']:
        if card['type'] == 'chat':
            chat = await owned(handler.projects, card['chat_id'], handler.owner, 'chat')
            if chat['body']['project_id'] != project_id:
                raise tornado.web.HTTPError(400, reason='评论区不属于此项目')
        for draft in card.get('drafts', {}).values():
            if not isinstance(draft, dict) or not isinstance(draft.get('refs', []), list):
                raise tornado.web.HTTPError(400, reason='参考素材格式不正确')
            asset_ids.update(x for x in draft.get('refs', []) if isinstance(x, str))
    asset_info = {}
    for asset_id in asset_ids:
        asset = await owned(handler.projects, asset_id, handler.owner, 'asset')
        asset_info[asset_id] = {'mime': asset['body']['mime'], 'name': asset['body']['name']}
        if asset_id in body['covers'] and not asset['body']['mime'].startswith('image/'):
            raise tornado.web.HTTPError(400, reason='封面和参考图必须是图片')
    for card in body['canvas']['cards']:
        for draft in card.get('drafts', {}).values():
            draft['ref_info'] = {ref: asset_info[ref] for ref in draft.get('refs', [])}
            kinds = [draft['ref_info'][ref]['mime'].split('/')[0] for ref in draft.get('refs', [])]
            allowed = ('image', 'video', 'audio') if draft.get('model') == 'minimax-h3-ref2va' else ('image',)
            if any(k not in allowed for k in kinds) or any(kinds.count(k) > 3 for k in ('video', 'audio')):
                raise tornado.web.HTTPError(400, reason='该模型不支持此参考类型或视频/音频超过各 3 项')
        if card['type'] == 'asset':
            cloud=card.get('storage')=='cloud'
            asset = await owned(handler.projects, card['asset_id'], handler.owner, 'cloud_upload' if cloud else 'asset')
            if cloud and asset['body'].get('status')!='completed':raise tornado.web.HTTPError(400,reason='云存储素材尚未完成上传确认')
            card.update(name=asset['body']['name'], mime=asset['body']['mime'], size=asset['body'].get('size', 0))
            if cloud:card.update(storage='cloud',url=asset['body']['url'],provider=asset['body']['provider'])
            else:
                for key in ('storage','url','provider'):card.pop(key,None)
    from backend.comments import attachment
    from backend.timeline import timelines
    for clip in (clip for sequence in timelines(body['canvas']) for clip in sequence['clips']):
        clip['media'] = await attachment(handler, clip['media'], project_id)
        if not clip['media']['mime'].startswith('video/'):
            raise tornado.web.HTTPError(400, reason='时间轴仅接受视频素材')
    body.update(kind='project', owner_id=handler.owner)
    creating = project_id is None
    project_id = project_id or uuid.uuid4().hex
    async with handler.projects.connection() as conn:
        if not creating:
            row = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'='project' FOR UPDATE", (project_id, handler.owner), block_id=project_id)).fetchone()
            if not row:
                raise tornado.web.HTTPError(404)
            if data.get('revision') != row['body'].get('revision', 1):
                raise tornado.web.HTTPError(409, reason='此项目已在其他窗口更新，请导出草稿后重新打开')
            from backend.editing import check_locks
            await check_locks(conn, handler, project_id, row['body'], body)
            body['revision'] = row['body'].get('revision', 1) + 1
            row = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s RETURNING *', (Jsonb(body), project_id), block_id=project_id)).fetchone()
        else:
            body['revision'] = 1
            row = await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) RETURNING *', (project_id, Jsonb(body)), block_id=project_id)).fetchone()
    handler.finish(row)


class UploadHandler(PrivateHandler):
    async def post(self):
        if self.settings['config'].get('cloud_mode'):
            raise tornado.web.HTTPError(403, reason='服务器版仅支持云存储，请通过云存储直传导入素材')
        files = self.request.files.get('file', [])
        if len(files) != 1 or len(files[0]['body']) > 200 * 1024 * 1024:
            raise tornado.web.HTTPError(400, reason='请选择一个不超过 200 MB 的素材文件')
        raw = files[0]['body']
        suffix = Path(files[0]['filename']).suffix.lower()
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            ext, mime = 'png', 'image/png'
        elif raw.startswith(b'\xff\xd8\xff'):
            ext, mime = 'jpg', 'image/jpeg'
        elif raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
            ext, mime = 'webp', 'image/webp'
        elif raw[4:8] == b'ftyp' and suffix in ('.mp4', '.m4v', '.m4a'):
            ext, mime = ('m4a', 'audio/mp4') if suffix == '.m4a' else ('mp4', 'video/mp4')
        elif raw.startswith(b'\x1a\x45\xdf\xa3') and suffix in ('.webm', '.weba'):
            ext, mime = ('weba', 'audio/webm') if suffix == '.weba' else ('webm', 'video/webm')
        elif raw.startswith(b'RIFF') and raw[8:12] == b'WAVE':
            ext, mime = 'wav', 'audio/wav'
        elif raw.startswith(b'OggS') and suffix in ('.ogg', '.oga', '.opus'):
            ext, mime = 'ogg', 'audio/ogg'
        elif suffix == '.mp3' and (raw.startswith(b'ID3') or (len(raw) > 1 and raw[0] == 255 and raw[1] & 224 == 224)):
            ext, mime = 'mp3', 'audio/mpeg'
        else:
            raise tornado.web.HTTPError(400, reason='支持 PNG/JPEG/WebP、MP4/WebM 和 MP3/WAV/OGG/M4A 音视频')
        if mime.startswith('image/') and len(raw) > 20 * 1024 * 1024:
            raise tornado.web.HTTPError(400, reason='图片不能超过 20 MB')
        asset_id = uuid.uuid4().hex
        directory = self.settings['config']['data_dir'] / 'media'
        directory.mkdir(exist_ok=True)
        filename = asset_id + '.' + ext
        await asyncio.to_thread((directory / filename).write_bytes, raw)
        body = dict(kind='asset', owner_id=self.owner, filename=filename, mime=mime, name=files[0]['filename'][:254], size=len(raw))
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (asset_id, Jsonb(body)), block_id=asset_id)
        self.finish({'id': asset_id, 'url': '/api/assets/' + asset_id, 'name': body['name'], 'mime': mime, 'size': len(raw)})


class CloudAssetHandler(PrivateHandler):
    async def post(self):
        upload = await owned(self.projects, self.data().get('upload_id'), self.owner, 'cloud_upload')
        body = upload['body']
        if body.get('status') != 'completed' or not body.get('url', '').startswith('https://'):
            raise tornado.web.HTTPError(400, reason='请先完成 HTTPS 云存储上传确认')
        identifier = uuid.uuid5(uuid.NAMESPACE_URL, 'cloud-asset:' + self.owner + ':' + upload['block_id']).hex
        value = dict(kind='asset', owner_id=self.owner, project_id=body.get('project_id'), created_by=self.user, remote_url=body['url'], name=body['name'], mime=body['mime'], size=body['size'])
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT DO NOTHING', (identifier, Jsonb(value)), block_id=identifier)
        self.finish({'id': identifier, 'url': '/api/assets/' + identifier, 'name': body['name'], 'mime': body['mime'], 'size': body['size']})


class AssetHandler(PrivateHandler):
    async def head(self, asset_id):
        await self.get(asset_id, include_body=False)

    async def get(self, asset_id, include_body=True):
        row = await owned(self.projects, asset_id, self.owner, 'asset')
        if row['body'].get('remote_url', '').startswith('https://') and (self.settings['config'].get('cloud_mode') or not row['body'].get('filename')):
            self.redirect(row['body']['remote_url']); return
        path = self.settings['config']['data_dir'] / 'media' / row['body']['filename']
        if not path.is_file():
            if row['body'].get('remote_url', '').startswith('https://'):
                self.redirect(row['body']['remote_url']); return
            raise tornado.web.HTTPError(404)
        size = path.stat().st_size
        start, end = 0, size - 1
        requested = self.request.headers.get('Range')
        if requested:
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', requested)
            try:
                if not match or not any(match.groups()):
                    raise ValueError()
                first, last = match.groups()
                if not first:
                    suffix = int(last)
                    if suffix <= 0:
                        raise ValueError()
                    start = max(0, size - suffix)
                else:
                    start = int(first)
                    end = min(int(last), end) if last else end
                if start > end or start >= size:
                    raise ValueError()
            except ValueError:
                self.set_status(416)
                self.set_header('Content-Range', f'bytes */{size}')
                self.finish()
                return
            self.set_status(206)
            self.set_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.set_header('Content-Type', row['body']['mime'])
        self.set_header('Accept-Ranges', 'bytes')
        self.set_header('Content-Length', max(0, end-start+1))
        self.set_header('Content-Disposition', "inline; filename*=UTF-8''" + quote(row['body']['name'], safe=''))
        if include_body:
            try:
                with path.open('rb') as stream:
                    stream.seek(start)
                    remaining = end-start+1
                    while remaining > 0:
                        chunk = await asyncio.to_thread(stream.read, min(1024*1024, remaining))
                        if not chunk:
                            break
                        self.write(chunk)
                        await self.flush()
                        remaining -= len(chunk)
            except StreamClosedError:
                return
        self.finish()


def workspace_routes():
    from backend.dialogue_files import DialogueUploadHandler, DialogueFileHandler
    from backend.dialogue import DialogueModelsHandler, DialoguesHandler, DialogueHandler
    from backend.editing import handler_class
    EditingHandler = handler_class()
    from backend.management import ManagementSettingsHandler, ManagementTestHandler, ManagementReportHandler
    from backend.comments import CreateChatHandler, ChatHandler, ChatMessagesHandler, ChatMaterialsHandler
    from backend.comfy_settings import ComfySettingsHandler, ComfyTestHandler
    from backend.inference import InferenceSettingsHandler, InferenceTestHandler, InferenceCostHandler, InferenceCostImportHandler
    from backend.cloud_storage import StorageSettingsHandler, StorageTestHandler, UploadGrantHandler, UploadConfirmHandler, CloudImageHandler
    from backend.generation import ModelsHandler, GenerateHandler, HistoryHandler, OutputHandler, CancelGenerationHandler, QueueOrderHandler
    return [
        (r'/api/dialogue/conversations/([0-9a-f]{32})/files', DialogueUploadHandler),
        (r'/api/dialogue/files/([0-9a-f]{32})', DialogueFileHandler),
        (r'/api/dialogue/models', DialogueModelsHandler),
        (r'/api/dialogue/conversations', DialoguesHandler),
        (r'/api/dialogue/conversations/([0-9a-f]{32})', DialogueHandler),
        (r'/api/projects/([0-9a-f]{32})/chats', CreateChatHandler),
        (r'/api/chats/([0-9a-f]{32})', ChatHandler),
        (r'/api/chats/([0-9a-f]{32})/messages', ChatMessagesHandler),
        (r'/api/chats/([0-9a-f]{32})/materials', ChatMaterialsHandler),
        (r'/api/settings/storage', StorageSettingsHandler),
        (r'/api/settings/storage/test', StorageTestHandler),
        (r'/api/storage/uploads', UploadGrantHandler),
        (r'/api/storage/uploads/([0-9a-f]{32})/image', CloudImageHandler),
        (r'/api/storage/uploads/([0-9a-f]{32})/confirm', UploadConfirmHandler),
        (r'/api/settings/service-inference', InferenceSettingsHandler),
        (r'/api/settings/service-inference/test', InferenceTestHandler),
        (r'/api/settings/service-inference/management', ManagementSettingsHandler),
        (r'/api/settings/service-inference/management/test', ManagementTestHandler),
        (r'/api/service-inference/management/report', ManagementReportHandler),
        (r'/api/settings/comfyui', ComfySettingsHandler), (r'/api/settings/comfyui/test', ComfyTestHandler),
        (r'/api/projects/([0-9a-f]{32})/editing', EditingHandler),
        (r'/api/projects', ProjectsHandler), (r'/api/projects/([0-9a-f]{32})', ProjectHandler),
        (r'/api/assets/cloud', CloudAssetHandler), (r'/api/assets', UploadHandler), (r'/api/assets/([0-9a-f]{32})', AssetHandler),
        (r'/api/generations/([0-9a-f]{32})/cancel', CancelGenerationHandler),
        (r'/api/generations/([0-9a-f]{32})/cost', InferenceCostHandler),
        (r'/api/projects/([0-9a-f]{32})/queue-order', QueueOrderHandler),
        (r'/api/models', ModelsHandler), (r'/api/projects/([0-9a-f]{32})/generate', GenerateHandler),
        (r'/api/projects/([0-9a-f]{32})/history', HistoryHandler),
        (r'/api/projects/([0-9a-f]{32})/cost-import', InferenceCostImportHandler),
        (r'/api/outputs/([0-9a-f]{32})/(\d+)', OutputHandler),
    ]


async def ensure_local_asset(handler, asset):
    """Lazily cache an imported cloud asset before local ComfyUI reference processing."""
    import hashlib
    import os
    from backend.cloud_storage import MIMES
    from backend.inference import download
    body = asset['body']; directory = handler.settings['config']['data_dir'] / 'media'
    current = directory / body.get('filename', '')
    if current.is_file(): return current
    url = body.get('remote_url', '')
    if not url.startswith('https://') or body.get('mime') not in MIMES:
        raise ValueError('参考素材没有可用的本地文件或云端地址')
    directory.mkdir(exist_ok=True)
    name = asset['block_id'] + MIMES[body['mime']]
    temporary = directory / (asset['block_id'] + '-' + uuid.uuid4().hex + '.download')
    try:
        await download(url, temporary)
        if temporary.stat().st_size != body.get('size'):
            raise ValueError('云端参考素材大小变化，原记录保留，请重新导入确认')
        if body.get('sha256'):
            def checksum():
                with temporary.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()
            actual = await asyncio.to_thread(checksum)
            if actual != body['sha256']: raise ValueError('云端参考素材校验和变化，未写入本地缓存')
        os.replace(temporary, directory / name)
        async with handler.projects.connection() as conn:
            await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s', (Jsonb({'filename': name}), asset['block_id']), block_id=asset['block_id'])
        body['filename'] = name
        return directory / name
    finally:
        temporary.unlink(missing_ok=True)
