"""Private projects/assets in director1; generation records in director2."""
import asyncio
import json
import math
import re
import time
import uuid

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
        if card.get('type') not in ('image', 'video') or card.get('mode') not in ('text', 'image', 'reference'):
            raise ValueError('卡片模式不正确')
        if not all(finite(card.get(k), lo, hi) for k, lo, hi in [('x', -1e7, 1e7), ('y', -1e7, 1e7), ('w', 380, 3000), ('h', 520, 4000)]):
            raise ValueError('卡片尺寸不正确')
        drafts = card.get('drafts', {})
        if not isinstance(drafts, dict) or set(drafts) - {'text', 'image', 'reference'}:
            raise ValueError('卡片参数格式不正确')
        for draft in drafts.values():
            if not isinstance(draft, dict) or not isinstance(draft.get('prompt', ''), str) or len(draft.get('prompt', '')) > 12000:
                raise ValueError('提示词格式不正确')
            if 'model' in draft and draft['model'] not in ('z-image-turbo', 'minimax-h3'):
                raise ValueError('未知模型')
            refs = draft.get('refs', [])
            if not isinstance(refs, list) or len(refs) > 8 or any(not isinstance(ref, str) or not ID.fullmatch(ref) for ref in refs):
                raise ValueError('参考图片列表不正确')
            for key in ('width', 'height', 'steps', 'seed', 'denoise', 'duration'):
                if key in draft and not finite(draft[key], -1, 2**53 - 1):
                    raise ValueError('卡片数值参数不正确')
        pins = card.get('pins', [])
        if not isinstance(pins, list) or len(pins) > 8 or any(not isinstance(pin, str) or not ID.fullmatch(pin) for pin in pins):
            raise ValueError('固定对比项格式不正确')
        if not finite(card.get('pinLimit', 2), 0, 8):
            raise ValueError('对比位数量不正确')
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
    for asset_id in asset_ids:
        await owned(handler.projects, asset_id, handler.owner, 'asset')
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
        if len(files) != 1 or len(files[0]['body']) > 20 * 1024 * 1024:
            raise tornado.web.HTTPError(400, reason='请选择一张不超过 20 MB 的图片')
        raw = files[0]['body']
        if raw.startswith(b'\x89PNG\r\n\x1a\n'):
            ext, mime = 'png', 'image/png'
        elif raw.startswith(b'\xff\xd8\xff'):
            ext, mime = 'jpg', 'image/jpeg'
        elif raw.startswith(b'RIFF') and raw[8:12] == b'WEBP':
            ext, mime = 'webp', 'image/webp'
        else:
            raise tornado.web.HTTPError(400, reason='支持 PNG、JPEG 和 WebP 图片')
        asset_id = uuid.uuid4().hex
        directory = self.settings['config']['data_dir'] / 'media'
        directory.mkdir(exist_ok=True)
        filename = asset_id + '.' + ext
        await asyncio.to_thread((directory / filename).write_bytes, raw)
        body = dict(kind='asset', owner_id=self.owner, filename=filename, mime=mime, name=files[0]['filename'][:254])
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (asset_id, Jsonb(body)))
        self.finish({'id': asset_id, 'url': '/api/assets/' + asset_id})


class AssetHandler(PrivateHandler):
    async def get(self, asset_id):
        row = await owned(self.projects, asset_id, self.owner, 'asset')
        path = self.settings['config']['data_dir'] / 'media' / row['body']['filename']
        if not path.is_file():
            raise tornado.web.HTTPError(404)
        self.set_header('Content-Type', row['body']['mime'])
        self.finish(await asyncio.to_thread(path.read_bytes))


def workspace_routes():
    from backend.generation import ModelsHandler, GenerateHandler, HistoryHandler, OutputHandler
    return [
        (r'/api/projects', ProjectsHandler), (r'/api/projects/([0-9a-f]{32})', ProjectHandler),
        (r'/api/assets', UploadHandler), (r'/api/assets/([0-9a-f]{32})', AssetHandler),
        (r'/api/models', ModelsHandler), (r'/api/projects/([0-9a-f]{32})/generate', GenerateHandler),
        (r'/api/projects/([0-9a-f]{32})/history', HistoryHandler),
        (r'/api/outputs/([0-9a-f]{32})/(\d+)', OutputHandler),
    ]
