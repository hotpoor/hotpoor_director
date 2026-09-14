"""Local workstation ComfyUI connection settings."""
import ctypes
import ipaddress
import json
import os
import re

from tornado.httpclient import AsyncHTTPClient, HTTPClientError, HTTPRequest
import tornado.web

from backend.workspace import PrivateHandler

DEFAULT = {'host': '127.0.0.1', 'port': 8188}


def validate_connection(data):
    if not isinstance(data, dict):
        raise ValueError('请输入主机地址和端口')
    host, port = data.get('host'), data.get('port')
    if not isinstance(host, str):
        raise ValueError('请输入主机名或 IP 地址，不包含 http:// 和路径')
    host = host.strip().lower()
    try:
        host = str(ipaddress.ip_address(host))
    except ValueError:
        if len(host) > 253 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', host) or any(not label or len(label)>63 or label.startswith('-') or label.endswith('-') for label in host.split('.')):
            raise ValueError('请输入主机名或 IP 地址，不包含 http://、路径或账号密码')
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('端口必须是 1–65535 的整数')
    return {'host': host, 'port': port}


def connection_url(connection):
    host = connection['host']
    return f"http://{'['+host+']' if ':' in host else host}:{connection['port']}"


def endpoint(settings):
    return connection_url(settings.get('comfy_connection', DEFAULT))


def load_connection(config):
    path = config['data_dir'] / '.comfyui.json'
    return validate_connection(json.loads(path.read_text(encoding='utf-8'))) if path.exists() else dict(DEFAULT)


def save_connection(config, connection):
    path = config['data_dir'] / '.comfyui.json'
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(connection, indent=2), encoding='utf-8')
    os.replace(temporary, path)
    if os.name == 'nt':
        attributes = ctypes.windll.kernel32.GetFileAttributesW(str(path))
        if not ctypes.windll.kernel32.SetFileAttributesW(str(path), attributes | 2):
            raise ctypes.WinError()


async def probe(connection):
    response = await AsyncHTTPClient().fetch(HTTPRequest(connection_url(connection) + '/system_stats',
        connect_timeout=3, request_timeout=5, follow_redirects=False))
    info = json.loads(response.body)
    if not isinstance(info, dict) or not isinstance(info.get('system'), dict) or not isinstance(info.get('devices'), list):
        raise ValueError('该地址没有返回有效的 ComfyUI 服务信息')
    return info['system'].get('comfyui_version', '版本未知')


class ComfySettingsHandler(PrivateHandler):
    async def get(self):
        self.finish({'connection': self.settings['comfy_connection'], 'url': endpoint(self.settings)})

    async def post(self):
        try:
            connection = validate_connection(self.data())
        except ValueError as error:
            raise tornado.web.HTTPError(400, reason=str(error))
        async with self.settings['comfy_lock']:
            if connection != self.settings['comfy_connection']:
                async with self.jobs.connection() as conn:
                    active = await (await conn.execute("SELECT 1 FROM entities WHERE body->>'kind'='generation' AND body->>'provider' IS DISTINCT FROM 'service-inference' AND body->>'status' IN ('submitting','queued','running','stopping') LIMIT 1")).fetchone()
                if active:
                    raise tornado.web.HTTPError(409, reason='还有未结束的生成任务，请等待完成或停止任务后再切换')
            try:
                version = await probe(connection)
            except (HTTPClientError, OSError, ValueError):
                raise tornado.web.HTTPError(502, reason='连接失败，请确认 ComfyUI 已启动且主机地址、端口正确；原配置未更改')
            save_connection(self.settings['config'], connection)
            await self.settings['progress_tracker'].close()
            self.settings['comfy_connection'] = connection
            self.settings['progress_tracker'].base_url = connection_url(connection)
        self.finish({'connection': connection, 'url': connection_url(connection), 'version': version})


class ComfyTestHandler(PrivateHandler):
    async def post(self):
        try:
            connection = validate_connection(self.data())
        except ValueError as error:
            raise tornado.web.HTTPError(400, reason=str(error))
        try:
            version = await probe(connection)
        except (HTTPClientError, OSError, ValueError):
            raise tornado.web.HTTPError(502, reason='连接失败，请确认 ComfyUI 已启动且主机地址、端口正确')
        self.finish({'ok': True, 'version': version, 'url': connection_url(connection)})
