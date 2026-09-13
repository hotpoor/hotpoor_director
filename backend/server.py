import asyncio
from collections import OrderedDict
import json
import hmac
import os
from pathlib import Path
import time

import tornado.web

from backend.auth import authenticate, create_user, normalize_login, token_hash

WEB = Path(__file__).parent / 'web'


class BaseHandler(tornado.web.RequestHandler):
    def set_default_headers(self):
        self.set_header('Cache-Control', 'no-store')
        self.set_header('X-Content-Type-Options', 'nosniff')
        self.set_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

    def prepare(self):
        if self.request.host_name not in ('127.0.0.1', 'localhost'):
            raise tornado.web.HTTPError(403)

    def write_error(self, status_code, **kwargs):
        exception = kwargs.get('exc_info', (None, None, None))[1]
        message = exception.reason if isinstance(exception, tornado.web.HTTPError) and exception.reason else self._reason
        # HTTP reason phrases are ASCII; localized validation belongs in JSON.
        self.set_status(status_code)
        self.finish({'error': message})

    async def session_user(self):
        token = self.get_cookie('director_session')
        if not token or len(token) > 128:
            return None
        async with self.settings['pool'].connection() as conn:
            result = await conn.execute('SELECT l.user_id,l.login FROM auth_sessions s JOIN index_login l USING(user_id) WHERE s.token_hash=%s AND s.expires_at>%s', (token_hash(token), time.time_ns() // 1_000_000))
            return await result.fetchone()


class IndexHandler(BaseHandler):
    def get(self):
        _ = self.xsrf_token
        self.render(str(WEB / 'index.html'))


class LoginHandler(BaseHandler):
    async def post(self):
        try:
            data = json.loads(self.request.body)
            login = normalize_login(data['login'])
            password = data['password']
            if not isinstance(password, str) or not 1 <= len(password) <= 256:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise tornado.web.HTTPError(400, reason='账号或密码格式不正确')
        attempts = self.settings['login_attempts']
        now = time.monotonic()
        count, until = attempts.get(login, (0, now + 60))
        if now >= until:
            count, until = 0, now + 60
        if count >= 10:
            raise tornado.web.HTTPError(429, reason='登录尝试过多，请稍后再试')
        attempts[login] = (count + 1, until)
        attempts.move_to_end(login)
        if len(attempts) > 4096:
            attempts.popitem(last=False)
        async with self.settings['auth_slots']:
            token = await authenticate(self.settings['pool'], login, password)
        if not token:
            raise tornado.web.HTTPError(401, reason='账号或密码错误')
        self.set_cookie('director_session', token, httponly=True, samesite='Strict', path='/', max_age=86400)
        self.finish({'ok': True})


class SetupHandler(BaseHandler):
    def allowed(self):
        expected = self.settings['bootstrap_token']
        return bool(expected) and hmac.compare_digest(self.get_cookie('director_bootstrap', ''), expected)

    async def get(self):
        async with self.settings['pool'].connection() as conn:
            result = await conn.execute('SELECT 1 FROM index_login LIMIT 1')
            empty = not await result.fetchone()
        self.finish({'needs_setup': empty, 'can_setup': empty and self.allowed()})

    async def post(self):
        if not self.allowed():
            raise tornado.web.HTTPError(403)
        try:
            data = json.loads(self.request.body)
            async with self.settings['auth_slots']:
                await create_user(self.settings['pool'], data['login'], data['password'], first_only=True)
        except (ValueError, KeyError, TypeError) as error:
            raise tornado.web.HTTPError(400, reason=str(error))
        self.clear_cookie('director_bootstrap', path='/')
        self.finish({'ok': True})


class MeHandler(BaseHandler):
    async def get(self):
        user = await self.session_user()
        if not user:
            raise tornado.web.HTTPError(401, reason='请先登录')
        self.finish(user)


class LogoutHandler(BaseHandler):
    async def post(self):
        token = self.get_cookie('director_session')
        if token and len(token) <= 128:
            async with self.settings['pool'].connection() as conn:
                await conn.execute('DELETE FROM auth_sessions WHERE token_hash=%s', (token_hash(token),))
        self.clear_cookie('director_session', path='/')
        self.finish({'ok': True})


def application(config, pool, projects_pool=None, jobs_pool=None):
    from backend.workspace import workspace_routes
    from backend.progress import ProgressTracker
    from backend.comfy_settings import load_connection, connection_url
    connection = load_connection(config)
    return tornado.web.Application([
        (r'/', IndexHandler), (r'/api/login', LoginHandler), (r'/api/setup', SetupHandler),
        (r'/favicon.ico', tornado.web.RedirectHandler, {'url': '/static/brand/favicon.ico'}),
        (r'/api/me', MeHandler), (r'/api/logout', LogoutHandler),
        *workspace_routes(),
        (r'/static/(.*)', tornado.web.StaticFileHandler, {'path': str(WEB)}),
    ], comfy_connection=connection, comfy_lock=asyncio.Lock(), progress_tracker=ProgressTracker(connection_url(connection)), pool=pool, projects_pool=projects_pool, jobs_pool=jobs_pool, config=config,
       cookie_secret=config['cookie_secret'], xsrf_cookies=True,
       xsrf_cookie_kwargs={'samesite': 'Strict'}, login_attempts=OrderedDict(),
       auth_slots=asyncio.Semaphore(4), bootstrap_token=os.environ.get('DIRECTOR_BOOTSTRAP_TOKEN', ''),
       compiled_template_cache=not config.get('development', False),
       static_hash_cache=not config.get('development', False), debug=False)
