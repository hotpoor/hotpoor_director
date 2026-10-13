"""Director-owned local selection page and Wiki bridge for Codex tasks."""
import asyncio
import json
import os
from pathlib import Path
import re
import time
import uuid
from urllib.parse import urlencode

import tornado.web

WEB = Path(__file__).parent / 'scope_web'


class ScopeStore:
    def __init__(self, directory):
        self.directory = Path(directory)

    def path(self, thread):
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', thread):
            raise ValueError('任务标识无效')
        return self.directory / (thread + '.json')

    def read(self, thread):
        path = self.path(thread)
        if path.exists():
            value = json.loads(path.read_text(encoding='utf-8'))
        else:
            value = {'thread_id': thread, 'revision': None, 'configured': False,
                     'paths': [], 'updated_at': None}
        return {**value, 'selection_file': str(path)}

    def save(self, thread, value):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = self.path(thread)
        temporary = target.with_suffix('.' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('x', encoding='utf-8') as stream:
                temporary.chmod(0o600)
                json.dump(value, stream, ensure_ascii=False, indent=2)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)


class ScopeApplication(tornado.web.Application):
    def __init__(self, runtime, directory, port=8890):
        from backend.wiki import BuiltinClient
        self.runtime = runtime
        self.client = BuiltinClient(runtime)
        self.store = ScopeStore(directory)
        self.catalog_cache = None
        self.catalog_lock = asyncio.Lock()
        super().__init__([
            (r'/', Page), (r'/(app.js|style.css)', Asset),
            (r'/health', Health), (r'/api/catalog', Catalog),
            (r'/api/scope/([a-zA-Z0-9_-]{1,100})', Scope),
            (r'/wiki/(health|api/tree|api/resolve|api/word|api/search|api/hybrid/search|api/semantic/index|api/semantic/status|api/blocks/[0-9a-fA-F-]+)', WikiBridge),
        ], port=port, xsrf_cookies=True, compress_response=True)

    async def wiki_json(self, route, **params):
        url = self.runtime['base_url'] + route + ('?' + urlencode(params) if params else '')
        response = await self.client.fetch(url, request_timeout=30)
        return json.loads(response.body)

    async def catalog(self, refresh=False):
        async with self.catalog_lock:
            if self.catalog_cache is not None and not refresh:
                return self.catalog_cache
            first = await self.wiki_json('/api/tree', page=1, page_size=100)
            items = list(first['items'])
            pages = first['pagination']['pages']
            for start in range(2, pages + 1, 4):
                batch = await asyncio.gather(*(self.wiki_json('/api/tree', page=p, page_size=100)
                    for p in range(start, min(start + 4, pages + 1))))
                for data in batch:
                    if not data['items'] or data['pagination']['total'] != first['pagination']['total']:
                        raise ValueError('目录读取不完整，请重新刷新')
                    items.extend(data['items'])
            if len(items) != first['pagination']['total'] or len({x['path'] for x in items}) != len(items):
                raise ValueError('目录在读取期间有变化，请重新刷新')
            self.catalog_cache = {'items': items, 'loaded_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                'root': first.get('root'), 'file_count': sum(x['kind'] == 'file' for x in items)}
            return self.catalog_cache


class Base(tornado.web.RequestHandler):
    def prepare(self):
        port = self.settings['port']
        if self.request.host not in (f'127.0.0.1:{port}', f'localhost:{port}'):
            raise tornado.web.HTTPError(403)
        if self.request.headers.get('Origin') not in (None, f'http://{self.request.host}'):
            raise tornado.web.HTTPError(403)

    def write_error(self, status_code, **kwargs):
        self.set_status(status_code)
        error = kwargs.get('exc_info', (None, None))[1]
        self.finish({'error': getattr(error, 'reason', None) or '请求失败，请确认 Director 已启动后重试'})

    def set_default_headers(self):
        self.set_header('Cache-Control', 'no-store')
        self.set_header('X-Content-Type-Options', 'nosniff')
        self.set_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'self'")


class Page(Base):
    def get(self):
        self.xsrf_token
        self.set_header('Content-Type', 'text/html; charset=utf-8')
        self.finish((WEB / 'index.html').read_text(encoding='utf-8'))


class Asset(Base):
    def get(self, name):
        self.set_header('Content-Type', 'text/javascript' if name.endswith('.js') else 'text/css')
        self.finish((WEB / name).read_text(encoding='utf-8'))


class Health(Base):
    async def get(self):
        try:
            health = await self.application.wiki_json('/health')
        except Exception as error:
            raise tornado.web.HTTPError(503, reason='Director 内置知识库暂不可用') from error
        self.finish({'service': 'director-codex-scope', 'ok': health.get('ok') is True,
                     'provider': 'director', 'pid': os.getpid()})


class Catalog(Base):
    async def get(self):
        try:
            self.finish(await self.application.catalog(self.get_argument('refresh', '') == '1'))
        except Exception as error:
            raise tornado.web.HTTPError(502, reason='无法完整读取 Director 知识库目录，请刷新重试。') from error


class Scope(Base):
    def get(self, thread):
        self.finish(self.application.store.read(thread))

    async def post(self, thread):
        store = self.application.store
        try:
            body = json.loads(self.request.body)
            if not isinstance(body, dict):
                raise ValueError('expected object')
            old = store.read(thread)
            if body.get('revision') != old['revision']:
                raise tornado.web.HTTPError(409, reason='另一个页面已更新范围。请重新加载本页后再修改。')
            paths = body['paths']
            if not isinstance(paths, list) or any(not isinstance(p, str) for p in paths):
                raise ValueError('paths')
            available = {x['path'] for x in (await self.application.catalog())['items'] if x['kind'] == 'file'}
            paths = sorted(set(paths))
            if any(p not in available for p in paths):
                raise tornado.web.HTTPError(400, reason='所选范围含目录中不存在的文章，请刷新目录核对。')
            if store.read(thread)['revision'] != old['revision']:
                raise tornado.web.HTTPError(409, reason='范围已在其他页面更新，请重新加载。')
            value = {'thread_id': thread, 'revision': uuid.uuid4().hex, 'configured': True, 'paths': paths,
                'updated_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'wiki_url': 'director://knowledge',
                'policy': 'Search only the saved paths for this task. Empty means no Wiki scope; never fall back to the entire library.'}
            store.save(thread, value)
            self.finish(store.read(thread))
        except (ValueError, KeyError, TypeError) as error:
            raise tornado.web.HTTPError(400, reason='选择数据无效，未保存。') from error


class WikiBridge(Base):
    async def get(self, route):
        await self.forward(route)

    async def post(self, route):
        await self.forward(route)

    async def forward(self, route):
        # Fixed allowlisted routes only; the private process token stays on the server.
        url = self.application.runtime['base_url'] + '/' + route
        if self.request.query:
            url += '?' + self.request.query
        try:
            response = await self.application.client.fetch(url, method=self.request.method,
                body=self.request.body if self.request.method == 'POST' else None,
                headers={'Content-Type': 'application/json'}, request_timeout=180, raise_error=False)
        except Exception as error:
            raise tornado.web.HTTPError(503, reason='Director 内置知识库暂不可用') from error
        self.set_status(response.code)
        self.set_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
        self.finish(response.body)
