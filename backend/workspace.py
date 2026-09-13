"""Private projects/assets in director1; generation records in director2."""
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

ID = re.compile(r'^[0-9a-f]{32}$')


async def owned(pool, block_id, owner, kind):
    async with pool.connection() as conn:
        row = await (await conn.execute(
            "SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'=%s",
            (block_id, owner, kind))).fetchone()
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
        if card.get('type') not in ('image', 'video', 'asset') or card.get('mode') not in (('media',) if card.get('type') == 'asset' else ('text', 'image', 'reference')):
            raise ValueError('卡片模式不正确')
        if not all(finite(card.get(k), lo, hi) for k, lo, hi in [('x', -1e7, 1e7), ('y', -1e7, 1e7), ('w', 380, 3000), ('h', 200 if card.get('type') == 'asset' else 520, 4000)]):
            raise ValueError('卡片尺寸不正确')
        if card['type'] == 'asset' and (not isinstance(card.get('asset_id'), str) or not ID.fullmatch(card['asset_id'])):
            raise ValueError('素材 UUID 不正确')
        drafts = card.get('drafts', {})
        if not isinstance(drafts, dict) or set(drafts) - {'text', 'image', 'reference'}:
            raise ValueError('卡片参数格式不正确')
        for draft in drafts.values():
            if not isinstance(draft, dict) or not isinstance(draft.get('prompt', ''), str) or len(draft.get('prompt', '')) > 12000:
                raise ValueError('提示词格式不正确')
            if 'model' in draft and draft['model'] not in ('z-image-turbo', 'z-image', 'minimax-h3', 'minimax-h3-ref2va', 'ltx-2.5'):
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
    if len(json.dumps(canvas)) > 2_000_000:
        raise ValueError('画布数据过大')
    return {k: data.get(k, '') for k in ('title', 'subtitle', 'description')} | {'covers': covers, 'canvas': canvas}


class PrivateHandler(BaseHandler):
    async def prepare(self):
        super().prepare()
        self.user = await self.session_user()
        if not self.user:
            raise tornado.web.HTTPError(401, reason='请先登录')
        self.owner = self.user['user_id']
        self.projects = self.settings['projects_pool']
        self.jobs = self.settings['jobs_pool']

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
            rows = await (await conn.execute("SELECT block_id, body - 'canvas' AS body, createtime, updatetime FROM entities WHERE body->>'kind'='project' AND body->>'owner_id'=%s ORDER BY updatetime DESC", (self.owner,))).fetchall()
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
            asset = await owned(handler.projects, card['asset_id'], handler.owner, 'asset')
            card.update(name=asset['body']['name'], mime=asset['body']['mime'], size=asset['body'].get('size', 0))
    body.update(kind='project', owner_id=handler.owner)
    async with handler.projects.connection() as conn:
        if project_id:
            row = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'owner_id'=%s AND body->>'kind'='project' FOR UPDATE", (project_id, handler.owner))).fetchone()
            if not row:
                raise tornado.web.HTTPError(404)
            if data.get('revision') != row['body'].get('revision', 1):
                raise tornado.web.HTTPError(409, reason='此项目已在其他窗口更新，请导出草稿后重新打开')
            body['revision'] = row['body'].get('revision', 1) + 1
            row = await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s RETURNING *', (Jsonb(body), project_id))).fetchone()
        else:
            body['revision'] = 1
            row = await (await conn.execute('INSERT INTO entities(body) VALUES (%s) RETURNING *', (Jsonb(body),))).fetchone()
    handler.finish(row)


class UploadHandler(PrivateHandler):
    async def post(self):
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
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (asset_id, Jsonb(body)))
        self.finish({'id': asset_id, 'url': '/api/assets/' + asset_id, 'name': body['name'], 'mime': mime, 'size': len(raw)})


class AssetHandler(PrivateHandler):
    async def head(self, asset_id):
        await self.get(asset_id, include_body=False)

    async def get(self, asset_id, include_body=True):
        row = await owned(self.projects, asset_id, self.owner, 'asset')
        path = self.settings['config']['data_dir'] / 'media' / row['body']['filename']
        if not path.is_file():
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
    from backend.comfy_settings import ComfySettingsHandler, ComfyTestHandler
    from backend.generation import ModelsHandler, GenerateHandler, HistoryHandler, OutputHandler, CancelGenerationHandler, QueueOrderHandler
    return [
        (r'/api/settings/comfyui', ComfySettingsHandler), (r'/api/settings/comfyui/test', ComfyTestHandler),
        (r'/api/projects', ProjectsHandler), (r'/api/projects/([0-9a-f]{32})', ProjectHandler),
        (r'/api/assets', UploadHandler), (r'/api/assets/([0-9a-f]{32})', AssetHandler),
        (r'/api/generations/([0-9a-f]{32})/cancel', CancelGenerationHandler),
        (r'/api/projects/([0-9a-f]{32})/queue-order', QueueOrderHandler),
        (r'/api/models', ModelsHandler), (r'/api/projects/([0-9a-f]{32})/generate', GenerateHandler),
        (r'/api/projects/([0-9a-f]{32})/history', HistoryHandler),
        (r'/api/outputs/([0-9a-f]{32})/(\d+)', OutputHandler),
    ]
