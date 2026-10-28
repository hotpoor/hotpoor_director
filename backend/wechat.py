"""Account-private, read-only WeChat exports backed by encrypted static cloud files."""
import asyncio
import csv
import hashlib
import io
import json
import os
import re
import uuid
from urllib.parse import quote

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.types.json import Jsonb
from tornado.web import HTTPError
from backend.workspace import PrivateHandler, owned
from backend import cloud_storage as storage

MAX_BYTES = 10 * 1024 * 1024
MAX_MESSAGES = 20000
MAGIC = b'DIRECTOR-WECHAT-1\n'


def text(value, limit, label):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(label + '格式或长度不正确')
    return value


def parse_export(name, content, title=''):
    text(name, 255, '文件名'); text(content, MAX_BYTES, '文件内容')
    if len(content.encode('utf-8')) > MAX_BYTES:
        raise ValueError('单个文件不能超过 10 MB，请按会话或时间分批导出')
    content = content.lstrip('\ufeff')
    if name.lower().endswith('.json'):
        try:
            value = json.loads(content)
        except (ValueError, RecursionError):
            raise ValueError('JSON 无法解析') from None
        if isinstance(value, dict):
            title = title or value.get('title') or value.get('name') or ''
            rows = value.get('messages')
        else:
            rows = value
    elif name.lower().endswith('.csv'):
        try:
            rows = list(csv.DictReader(io.StringIO(content)))
        except csv.Error:
            raise ValueError('CSV 无法解析') from None
    elif name.lower().endswith('.txt'):
        rows = []
        # Explicitly supported text format: YYYY-MM-DD HH:MM:SS sender, then body.
        header = re.compile(r'^\[?(\d{4}[-/]\d{2}[-/]\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)\]?\s+(.+?)\s*$')
        for line in content.splitlines():
            match = header.match(line)
            if match:
                rows.append({'time': match[1], 'sender': match[2], 'text': ''})
            elif rows:
                rows[-1]['text'] += ('\n' if rows[-1]['text'] else '') + line
            elif line.strip():
                raise ValueError('TXT 需以“2026-10-29 09:30:00 张三”消息头开始；可下载 JSON 示例转换导入')
    else:
        raise ValueError('请导入 UTF-8 编码的 JSON、CSV 或 TXT；不支持微信加密数据库或备份文件')
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_MESSAGES:
        raise ValueError('每次导入需包含 1–20000 条消息，请分批导入')
    messages = []
    for number, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError('消息必须是对象')
        def field(*keys, default=''):
            return next((row[k] for k in keys if k in row and row[k] is not None), default)
        sender = text(field('sender', 'sender_name', '发送者'), 500, '发送者')
        timestamp = field('time', 'timestamp', '时间')
        if type(timestamp) in (int, float): timestamp = str(timestamp)
        timestamp = text(timestamp, 100, '时间')
        message = text(field('text', 'content', '内容'), 100000, '消息内容')
        if not sender.strip() or not timestamp.strip() or not message.strip():
            raise ValueError(f'第 {number+1} 条消息缺少发送者、时间或内容')
        is_self = field('is_self', 'isSelf', default=False)
        if is_self not in (True, False, 'true', 'false', '1', '0', 1, 0):
            raise ValueError('is_self 必须是布尔值')
        kind = field('type', default='text')
        messages.append({'id': str(number), 'sender': sender, 'time': timestamp, 'text': message,
                         'is_self': is_self in (True, 'true', '1', 1),
                         'type': text(kind, 50, '消息类型')})
    title = text(title or name.rsplit('.', 1)[0], 200, '会话名称').strip()
    if not title: raise ValueError('请输入会话名称')
    # Keep source order: exports can include same timestamps, revisions and system messages.
    result = {'version': 1, 'title': title, 'messages': messages}
    if len(json.dumps(result, ensure_ascii=False).encode()) > MAX_BYTES:
        raise ValueError('规范化后的消息超过 10 MB，请分批导入')
    return result


def archive_key(config, create=False):
    path = config['data_dir'] / '.wechat-archive.key'
    if create and not path.exists():
        temporary = path.with_name('.wechat-key-' + uuid.uuid4().hex)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(AESGCM.generate_key(bit_length=256))
                stream.flush()
                os.fsync(stream.fileno())
            try: os.link(temporary, path)
            except FileExistsError: pass
        finally: temporary.unlink(missing_ok=True)
    if not path.exists(): raise ValueError('云归档解密密钥不存在，请恢复当前账号的数据目录备份')
    key = path.read_bytes()
    if len(key) != 32: raise ValueError('云归档解密密钥无效')
    return key


def seal(raw, key, identity):
    nonce = os.urandom(12)
    return MAGIC + nonce + AESGCM(key).encrypt(nonce, raw, identity.encode())


def unseal(raw, key, identity):
    if not raw.startswith(MAGIC): raise ValueError('归档格式无效')
    offset = len(MAGIC)
    return AESGCM(key).decrypt(raw[offset:offset+12], raw[offset+12:], identity.encode())


def location(profile):
    return {k: profile.get(k) for k in ('provider', 'bucket_name', 'region', 'endpoint', 'domain')}


def selected_profile(config, profile_id, expected=None):
    profile = storage.load(config)['profiles'].get(profile_id)
    if not profile: raise ValueError('所选云存储配置不存在，请先添加配置')
    if expected and location(profile) != expected:
        raise ValueError('原云存储位置已更改，请恢复配置后读取；轮换 AK/SK 不受影响')
    if not storage.access_domain(profile).startswith('https://'):
        raise ValueError('微信云归档需要 HTTPS 域名')
    return profile


def upload(profile, key, raw):
    if profile['provider'] == 'qiniu':
        import qiniu
        token = qiniu.Auth(profile['access_key_id'], profile['access_key_secret']).upload_token(
            profile['bucket_name'], key, 600, policy={'insertOnly': 1, 'fsizeLimit': len(raw)})
        result, info = qiniu.put_data(token, key, raw, mime_type='application/octet-stream')
        if info.status_code != 200: raise ValueError('七牛上传未成功')
    elif profile['provider'] == 'aliyun':
        storage.aliyun(profile).put_object(key, raw, headers={'Content-Type': 'application/octet-stream'})
    else:
        storage.tencent(profile).put_object(Bucket=profile['bucket_name'], Key=key, Body=raw,
                                          ContentType='application/octet-stream')


async def download(profile, cloud):
    if profile['provider'] == 'qiniu':
        import qiniu
        url = storage.access_domain(profile) + '/' + quote(cloud['key'], safe='/')
        url = qiniu.Auth(profile['access_key_id'], profile['access_key_secret']).private_download_url(url, expires=120)
        raw = await storage.read_cloud_image({'url': url, 'size': cloud['size']})
    else:
        def read():
            if profile['provider'] == 'aliyun':
                stream = storage.aliyun(profile).get_object(cloud['key'])
            else:
                stream = storage.tencent(profile).get_object(Bucket=profile['bucket_name'], Key=cloud['key'])['Body'].get_raw_stream()
            try: return stream.read(MAX_BYTES + 1024)
            finally:
                if hasattr(stream, 'close'): stream.close()
        raw = await asyncio.to_thread(read)
    if len(raw) != cloud['size'] or hashlib.sha256(raw).hexdigest() != cloud['sha256']:
        raise ValueError('云归档大小或 SHA-256 校验失败')
    return raw


async def contents(handler, row, offset=0, limit=None):
    body = row['body']
    try:
        profile = selected_profile(handler.settings['config'], body['profile_id'], body['cloud']['location'])
        key = archive_key(handler.settings['config'])
        messages = []
        position = 0
        for part in body['cloud']['parts']:
            end = position + part['count']
            if end <= offset:
                position = end
                continue
            if limit is not None and position >= offset + limit: break
            raw = await download(profile, part)
            value = json.loads(unseal(raw, key, handler.owner + ':' + row['block_id'] + ':' + str(part['index'])))
            first = max(0, offset - position)
            last = None if limit is None else max(0, offset + limit - position)
            messages.extend(value['messages'][first:last])
            position = end
        return messages
    except Exception:
        raise HTTPError(502, reason='无法读取加密云归档，请检查原存储配置、对象和账号解密密钥') from None


class WechatPreviewHandler(PrivateHandler):
    async def post(self):
        data = self.data()
        try: value = parse_export(data.get('name'), data.get('content'), data.get('title', ''))
        except (ValueError, TypeError):
            raise HTTPError(400, reason='导入格式不正确：请检查文件大小、必填字段和示例格式') from None
        self.finish({'title': value['title'], 'count': len(value['messages']), 'sample': value['messages'][:5]})


class WechatConversationsHandler(PrivateHandler):
    async def get(self):
        async with self.projects.connection() as conn:
            rows = await (await conn.scan("SELECT block_id, body - 'messages' - 'cloud' AS body, createtime, updatetime FROM entities WHERE body->>'kind'='wechat_conversation' AND body->>'owner_id'=%s ORDER BY updatetime DESC", (self.owner,), order_by='updatetime')).fetchall()
        self.finish({'conversations': rows})

    async def post(self):
        data = self.data()
        try:
            value = parse_export(data.get('name'), data.get('content'), data.get('title', ''))
            mode = data.get('storage', 'cloud')
            if mode != 'cloud': raise ValueError('聊天正文仅保存为云存储静态归档，请选择云配置')
            profile_id = data.get('profile_id')
            if not isinstance(profile_id, str): raise ValueError('请选择云存储配置')
            profile = selected_profile(self.settings['config'], profile_id)
        except (ValueError, TypeError) as error:
            raise HTTPError(400, reason=str(error)) from None
        request_id = data.get('request_id', uuid.uuid4().hex)
        if not isinstance(request_id, str) or not re.fullmatch(r'[0-9a-f]{32}', request_id):
            raise HTTPError(400, reason='导入请求 ID 无效')
        identifier = hashlib.sha256((self.owner + ':' + request_id).encode()).hexdigest()[:32]
        signature = hashlib.sha256(json.dumps([value, mode, profile_id], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        async with self.projects.connection() as conn:
            previous = await (await conn.execute('SELECT body FROM entities WHERE block_id=%s', (identifier,), block_id=identifier)).fetchone()
        if previous:
            if previous['body'].get('import_signature') != signature:
                raise HTTPError(409, reason='同一次导入的内容已改变，请重新选择文件')
            self.finish({'id': identifier, 'title': previous['body']['title'], 'count': previous['body']['count']})
            return
        body = {'kind': 'wechat_conversation', 'owner_id': self.owner, 'title': value['title'],
                'count': len(value['messages']), 'first_time': value['messages'][0]['time'],
                'last_time': value['messages'][-1]['time'], 'source_name': data['name'], 'storage': mode, 'import_signature': signature}
        try:
            encryption_key = archive_key(self.settings['config'], create=True)
            prefix = profile.get('path_prefix', 'director').strip('/')
            parts = []
            for index, start in enumerate(range(0, len(value['messages']), 500)):
                pack = {'version': 1, 'title': value['title'], 'messages': value['messages'][start:start+500]}
                raw = json.dumps(pack, ensure_ascii=False).encode()
                identity = self.owner + ':' + identifier + ':' + str(index)
                cipher = seal(raw, encryption_key, identity)
                key = '/'.join(filter(None, [prefix, 'wechat', self.owner, identifier, str(index)+'-'+uuid.uuid4().hex+'.enc']))
                await asyncio.to_thread(upload, profile, key, cipher)
                part = {'key': key, 'size': len(cipher), 'sha256': hashlib.sha256(cipher).hexdigest(),
                        'count': len(pack['messages']), 'index': index}
                verified = await download(profile, part)
                if unseal(verified, encryption_key, identity) != raw: raise ValueError('归档回读不一致')
                parts.append(part)
            body.update(profile_id=profile_id, storage_name=profile.get('name', profile['provider']),
                        cloud={'parts': parts, 'location': location(profile)})
        except Exception:
            raise HTTPError(502, reason='云归档上传或回读校验未完成，原始文件保留，请检查存储权限和网络后重试') from None
        async with self.projects.connection() as conn:
            await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT (block_id) DO NOTHING', (identifier, Jsonb(body)), block_id=identifier)
        self.finish({'id': identifier, 'title': body['title'], 'count': body['count']})


class WechatConversationHandler(PrivateHandler):
    async def get(self, identifier):
        row = await owned(self.projects, identifier, self.owner, 'wechat_conversation')
        try:
            offset = int(self.get_query_argument('offset', '0'))
            if not 0 <= offset <= MAX_MESSAGES: raise ValueError()
            query = self.get_query_argument('q', '').strip()
            if len(query) > 200: raise ValueError()
        except ValueError: raise HTTPError(400, reason='分页或搜索参数无效') from None
        messages = await contents(self, row, 0 if query else offset, None if query else 100)
        total = row['body']['count']
        if query:
            query = query.casefold()
            messages = [m for m in messages if query in m['text'].casefold() or query in m['sender'].casefold() or query in m['time'].casefold()]
            total = len(messages)
            messages = messages[offset:offset+100]
        self.finish({'id': identifier, 'title': row['body']['title'], 'messages': messages,
                     'total': total, 'next_offset': offset+100 if offset+100 < total else None})


class WechatExportHandler(PrivateHandler):
    async def get(self, identifier):
        row = await owned(self.projects, identifier, self.owner, 'wechat_conversation')
        messages = await contents(self, row)
        self.set_header('Content-Type', 'application/json; charset=utf-8')
        self.set_header('Content-Disposition', 'attachment; filename="wechat-'+identifier+'.json"')
        self.finish(json.dumps({'version': 1, 'title': row['body']['title'], 'messages': messages}, ensure_ascii=False))
