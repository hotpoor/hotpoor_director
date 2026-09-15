"""Multi-destination sync with immutable snapshots, receipts and fresh-UUID imports."""
import asyncio
import copy
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

from psycopg.types.json import Jsonb
from tornado.httpclient import AsyncHTTPClient, HTTPRequest, HTTPClientError
from tornado.web import HTTPError

from backend.workspace import PrivateHandler, owned
from backend import sync_protocol as protocol


def stamp(): return time.time_ns() // 1_000_000

def stable(owner, value): return uuid.uuid5(uuid.NAMESPACE_URL, 'director:' + owner + ':' + value).hex


async def put(conn, identifier, body):
    await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT(block_id) DO UPDATE SET body=excluded.body',
                       (identifier, Jsonb(body)), block_id=identifier)


async def row(conn, identifier):
    return await (await conn.execute('SELECT * FROM entities WHERE block_id=%s', (identifier,), block_id=identifier)).fetchone()


async def capture(conn, owner, project_id, mapping=None, target=None):
    rows = await (await conn.scan("SELECT * FROM entities WHERE body->>'owner_id'=%s AND body->>'kind'=ANY(%s)",
                                  (owner, list(protocol.KINDS)))).fetchall()
    available = {r['block_id']: r['body'] for r in rows}
    if available.get(project_id, {}).get('kind') != 'project': raise HTTPError(404)
    selected = {project_id} | {i for i, b in available.items() if b.get('project_id') == project_id and b['kind'] != 'cloud_upload'}
    pending = list(selected)
    while pending:
        identifier = pending.pop()
        for ref in protocol.references(available[identifier]):
            if ref in available and ref not in selected:
                selected.add(ref); pending.append(ref)
    records = {}
    for identifier in sorted(selected):
        body = copy.deepcopy(available[identifier])
        if target and body.get('cloud_versions', {}).get(target):
            version = body['cloud_versions'][target]
            if body['kind'] == 'asset': body.update(remote_url=version['url'], sha256=version['sha256'])
            elif body['kind'] == 'generation':
                for index, output in enumerate(body.get('outputs', [])):
                    item = version.get(str(index))
                    if item: output.update(remote_url=item['url'], sha256=item['sha256'], size=item['size'])
        try: records[identifier] = protocol.portable(body)
        except ValueError as error: raise HTTPError(409, reason=str(error))
    result = {'version': protocol.VERSION, 'project_id': project_id, 'records': records}
    return protocol.remap(result, mapping or {})


async def head(conn, owner, lineage):
    stored = await row(conn, stable(owner, 'head:' + lineage))
    if not stored:
        project = await row(conn, lineage)
        if not project or project['body'].get('owner_id') != owner or project['body'].get('kind') != 'project': return None
        body = {'project_id': lineage, 'canonical_ids': {}, 'commit_id': None, 'recorded_at': project['updatetime'], 'lineage': lineage}
    else:
        body = stored['body']
    snapshot = await capture(conn, owner, body['project_id'], body['canonical_ids'], 'cloud-self')
    times = await (await conn.scan("SELECT max(createtime) AS changed_at FROM entities WHERE body->>'owner_id'=%s AND body->>'project_id'=%s AND body->>'kind'='change_event'", (owner, body['project_id']))).fetchall()
    changed_at = max([body.get('recorded_at', 0)] + [r['changed_at'] or 0 for r in times])
    return {**body, 'recorded_at': changed_at, 'snapshot': snapshot, 'hash': protocol.digest(snapshot)}


async def materialize(conn, owner, snapshot):
    imported, ids = protocol.fresh_copy(snapshot, owner)
    for identifier, body in imported['records'].items():
        await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (identifier, Jsonb(body)), block_id=identifier)
    return imported['project_id'], ids


async def receive(store, owner, payload):
    snapshot = protocol.validate(payload.get('snapshot'))
    lineage, request_id = payload.get('lineage'), payload.get('request_id')
    if not all(isinstance(x, str) and protocol.ID.fullmatch(x) for x in (lineage, request_id)):
        raise ValueError('缺少有效的同步谱系和请求 UUID')
    identifier = stable(owner, 'receipt:' + request_id)
    content_hash = protocol.digest(snapshot)
    async with store.connection() as conn:
        previous = await row(conn, identifier)
        if previous:
            if previous['body']['hash'] != content_hash or previous['body']['lineage'] != lineage:
                raise HTTPError(409, reason='此同步请求 UUID 已用于不同内容')
            return previous['body']['result']
        current = await head(conn, owner, lineage)
        actual = current['hash'] if current else None
        if payload.get('expected_hash') != actual:
            raise HTTPError(409, reason='云端在预览后有新修改，请重新比较差异；两端内容均已保留')
        if current and actual == content_hash:
            # A pull acknowledgement records the new local UUID mapping without copying again.
            project_id, commit_id = current['project_id'], current['commit_id']
        else:
            project_id, ids = await materialize(conn, owner, snapshot)
            commit_id = uuid.uuid4().hex
            await put(conn, commit_id, {'kind': 'sync_commit', 'owner_id': owner, 'lineage': lineage,
                'project_id': project_id, 'parents': [current['commit_id']] if current and current.get('commit_id') else [],
                'snapshot': snapshot, 'hash': content_hash, 'recorded_at': stamp(),
                'source': str(payload.get('source', 'desktop'))[:160]})
            await put(conn, stable(owner, 'head:' + lineage), {'kind': 'sync_head', 'owner_id': owner,
                'lineage': lineage, 'project_id': project_id, 'commit_id': commit_id,
                'canonical_ids': {new: old for old, new in ids.items()}, 'recorded_at': stamp()})
        result = {'project_id': project_id, 'commit_id': commit_id, 'hash': content_hash, 'recorded_at': stamp()}
        origin = payload.get('origin_project_id')
        if origin is not None and (not isinstance(origin, str) or not protocol.ID.fullmatch(origin)):
            raise ValueError('本地项目 UUID 不正确')
        await put(conn, identifier, {'kind': 'sync_receipt', 'owner_id': owner, 'lineage': lineage,
            'hash': content_hash, 'origin_project_id': origin, 'recorded_at': stamp(), 'result': result})
        return result


def settings_path(handler):
    if handler.settings['config'].get('cloud_mode'): raise HTTPError(403, reason='请在桌面客户端配置同步目标')
    return handler.settings['config']['data_dir'] / ('.director-sync-' + handler.owner + '.json')


def load_targets(handler):
    path = settings_path(handler)
    return json.loads(path.read_text()) if path.exists() else {'targets': {}}


def save_targets(handler, value):
    path = settings_path(handler)
    temporary = path.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    try:
        with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
            json.dump(value, stream, ensure_ascii=False); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally: temporary.unlink(missing_ok=True)


def targets_view(value):
    return {'targets': [{k: v for k, v in target.items() if k not in ('access_key', 'device_secret')}
                         | {'authorized': bool(target.get('access_key'))} for target in value['targets'].values()]}


def target_for(handler, target_id):
    target = load_targets(handler)['targets'].get(target_id)
    if not target: raise HTTPError(404, reason='同步目标不存在')
    return target


async def remote(target, path, body=None, auth=True):
    # Requests originate in the backend; the renderer never receives saved access keys.
    url = (target['internal_url'] if 'internal_url' in target else protocol.endpoint(target['url'])) + path
    headers = {'Content-Type': 'application/json'}
    if 'bridge_secret' in target:
        headers['X-Director-Bridge'] = target['bridge_secret']
    elif auth:
        if not target.get('access_key'): raise HTTPError(401, reason='请先登录云端授权或填写 Access Key')
        headers['Authorization'] = 'Bearer ' + target['access_key']
    try:
        response = await AsyncHTTPClient().fetch(HTTPRequest(url, method='GET' if body is None else 'POST',
            headers=headers, body=None if body is None else json.dumps(body),
            follow_redirects=False, connect_timeout=10, request_timeout=180), raise_error=False)
        data = json.loads(response.body)
    except (HTTPClientError, OSError, ValueError):
        raise HTTPError(502, reason='云端连接失败，请检查地址、网络和证书后重试') from None
    if response.code >= 300:
        raise HTTPError(response.code if response.code in (400, 401, 403, 404, 409, 413, 429) else 502,
                        reason=str(data.get('error') or data.get('detail') or '云端请求失败')[:300])
    return data


class TargetsHandler(PrivateHandler):
    async def get(self): self.finish(targets_view(load_targets(self)))

    async def post(self):
        data = self.data()
        async with self.settings['sync_lock']:
            value = load_targets(self)
            identifier = data.get('id') or uuid.uuid4().hex
            if not isinstance(identifier, str) or not protocol.ID.fullmatch(identifier): raise HTTPError(400)
            previous = value['targets'].get(identifier, {})
            if data.get('action') == 'remove': value['targets'].pop(identifier, None)
            else:
                try: url = protocol.endpoint(data.get('url'))
                except ValueError as e: raise HTTPError(400, reason=str(e))
                name = data.get('name')
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80: raise HTTPError(400, reason='请填写名称（80 字以内）')
                if len(value['targets']) >= 20 and not previous: raise HTTPError(400, reason='最多保存 20 个同步目标')
                key = data.get('access_key') or (previous.get('access_key', '') if previous.get('url') == url else '')
                if not isinstance(key, str) or len(key) > 4096 or any(c.isspace() for c in key): raise HTTPError(400, reason='Access Key 格式不正确')
                value['targets'][identifier] = {'id': identifier, 'name': name.strip(), 'url': url, 'access_key': key}
            save_targets(self, value)
        self.finish(targets_view(value))


class AuthorizationHandler(PrivateHandler):
    async def post(self, target_id):
        async with self.settings['sync_lock']:
            value = load_targets(self); target = target_for(self, target_id)
            if self.data().get('action') == 'poll':
                if not target.get('device_secret'): raise HTTPError(400, reason='请先发起登录授权')
                result = await remote(target, '/auth/device/poll', {'device_secret': target['device_secret']}, auth=False)
                if result.get('access_key'):
                    target['access_key'] = result.pop('access_key'); target.pop('device_secret', None)
                    value['targets'][target_id] = target; save_targets(self, value)
                self.finish(result); return
            result = await remote(target, '/auth/device/start', {'name': target['name']}, auth=False)
            target['device_secret'] = result.pop('device_secret')
            # Do not let a remote endpoint cause the client to open another domain.
            expected = target['url'] + '/authorize?code='
            if not result.get('verification_url', '').startswith(expected): raise HTTPError(502, reason='云端授权地址不匹配')
            value['targets'][target_id] = target; save_targets(self, value)
            self.finish(result)


class HeadHandler(PrivateHandler):
    async def get(self, lineage):
        async with self.projects.connection() as conn: result = await head(conn, self.owner, lineage)
        self.finish({'head': result})


class ReceiveHandler(PrivateHandler):
    async def post(self):
        try: self.finish(await receive(self.projects, self.owner, self.data()))
        except ValueError as e: raise HTTPError(400, reason=str(e))


class TimelineHandler(PrivateHandler):
    async def get(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        cursor = self.get_query_argument('cursor', '')
        condition = ''; params = [self.owner, project_id]
        if cursor:
            try:
                timestamp, identifier = cursor.split(':')
                timestamp = int(timestamp)
                if timestamp < 0 or not protocol.ID.fullmatch(identifier): raise ValueError()
            except (ValueError, TypeError): raise HTTPError(400, reason='历史分页游标不正确')
            condition = ' AND (createtime,block_id)<(%s,%s)'; params += [timestamp, identifier]
        async with self.projects.connection() as conn:
            events = await (await conn.scan("SELECT * FROM entities WHERE body->>'owner_id'=%s AND body->>'project_id'=%s AND body->>'kind'='change_event'" + condition + " ORDER BY createtime DESC,block_id DESC LIMIT 21", params, order_by='createtime')).fetchall()
        page = events[:20]
        self.finish({'events': [{'id': r['block_id'], 'at': r['createtime'], 'entity_id': r['body']['entity_id'],
            'operation': r['body']['operation'], 'changes': protocol.diff(protocol.portable(r['body']['before'], strict=False) if r['body']['before'] else {},
             protocol.portable(r['body']['after'], strict=False) if r['body']['after'] else {})} for r in page],
             'next_cursor': str(page[-1]['createtime']) + ':' + page[-1]['block_id'] if len(events) > 20 else None})


async def binding(conn, owner, project_id, target_id):
    item = await row(conn, stable(owner, 'link:' + project_id + ':' + target_id))
    return item['body'] if item else {'lineage': project_id, 'canonical_ids': {}, 'base': None, 'remote_hash': None}


class ProjectSyncHandler(PrivateHandler):
    async def post(self, project_id, target_id):
        data = self.data(); action = data.get('action', 'preview'); target = target_for(self, target_id)
        project_row = await owned(self.projects, project_id, self.owner, 'project')
        async with self.settings['sync_lock']:
            async with self.projects.connection() as conn:
                link = await binding(conn, self.owner, project_id, target_id)
                local = await capture(conn, self.owner, project_id, link['canonical_ids'], target_id)
            await remote(target, '/api/sync/prepare/' + link['lineage'], {})
            cloud = (await remote(target, '/api/sync/head/' + link['lineage']))['head']
            cloud_snapshot = cloud['snapshot'] if cloud else {}
            comparison = protocol.compare(link['base'], local, cloud_snapshot)
            if action == 'preview':
                self.finish({**comparison, 'local_hash': protocol.digest(local), 'remote_hash': cloud['hash'] if cloud else None,
                    'remote_time': cloud.get('recorded_at') if cloud else None,
                    'local_time': project_row['updatetime'], 'local_project_id': project_id, 'remote_project_id': cloud.get('project_id') if cloud else None,
                    'lineage': link['lineage'], 'base_hash': link.get('remote_hash')}); return
            if action == 'push':
                if data.get('local_hash') != protocol.digest(local) or data.get('remote_hash') != (cloud['hash'] if cloud else None):
                    raise HTTPError(409, reason='预览后有新修改，请重新比较差异')
                if comparison['remote_changes'] and cloud and not comparison['identical'] and data.get('resolution') != 'keep-both':
                    raise HTTPError(409, reason='云端也有修改，请先拉取新副本，或明确选择保留两版后提交')
                await upload_resources(self, project_id, target)
                async with self.projects.connection() as conn:
                    snapshot = await capture(conn, self.owner, project_id, link['canonical_ids'], target_id)
                # Uploading only adds verified media versions; any editing during upload needs a new preview.
                cleaned = copy.deepcopy(snapshot)
                for identifier, b in cleaned['records'].items():
                    original = local['records'].get(identifier, {})
                    if b['kind'] == 'asset':
                        for k in ('remote_url', 'sha256'):
                            if k in original: b[k] = original[k]
                            else: b.pop(k, None)
                    if b['kind'] == 'generation': b['outputs'] = original.get('outputs', [])
                if cleaned != local: raise HTTPError(409, reason='上传期间项目发生修改，资源已保留，请重新比较')
                request_id = stable(self.owner, target_id + ':' + link['lineage'] + ':' + protocol.digest(snapshot) + ':' + str(data.get('remote_hash')))
                result = await remote(target, '/api/sync/receive', {'snapshot': snapshot, 'lineage': link['lineage'],
                    'request_id': request_id, 'expected_hash': data.get('remote_hash'), 'source': target['name'], 'origin_project_id': project_id})
                link.update(base=snapshot, remote_hash=result['hash'], last_sync=stamp(), remote_project_id=result['project_id'])
                await self.store_link(project_id, target_id, link)
                self.finish(result); return
            if action in ('pull', 'retry-receipt'):
                if not cloud: raise HTTPError(404, reason='云端尚无版本')
                if action == 'pull' and data.get('remote_hash') != cloud['hash']: raise HTTPError(409, reason='云端有新修改，请重新比较')
                import_id = stable(self.owner, 'import:' + target_id + ':' + link['lineage'] + ':' + cloud['hash'])
                async with self.projects.connection() as conn:
                    existing = await row(conn, import_id)
                    if existing:
                        new_id = existing['body']['project_id']
                        new_link = await binding(conn, self.owner, new_id, target_id)
                    else:
                        new_id, ids = await materialize(conn, self.owner, cloud_snapshot)
                        new_link = {'kind': 'sync_link', 'owner_id': self.owner, 'project_id': new_id, 'target_id': target_id,
                            'lineage': link['lineage'], 'canonical_ids': {new: old for old, new in ids.items()}, 'base': cloud_snapshot,
                            'remote_hash': cloud['hash'], 'remote_project_id': cloud['project_id'], 'last_sync': stamp(), 'enabled': True, 'pending_receipt': True}
                        await put(conn, stable(self.owner, 'link:' + new_id + ':' + target_id), new_link)
                        await put(conn, import_id, {'kind': 'sync_import', 'owner_id': self.owner, 'project_id': new_id, 'recorded_at': stamp()})
                try:
                    await acknowledge(target, link['lineage'], cloud['hash'], cloud['project_id'], new_id, new_link['canonical_ids'], import_id)
                    new_link['pending_receipt'] = False
                    await self.store_link(new_id, target_id, new_link)
                except HTTPError:
                    self.finish({'project_id': new_id, 'pending_receipt': True, 'note': '本地新副本已保存，回传尚未成功；可重试回执，不会重复创建副本'}); return
                self.finish({'project_id': new_id, 'pending_receipt': False, 'note': '已创建新 UUID 副本并回传云端回执，原本地项目保留'}); return
            raise HTTPError(400, reason='未知同步操作')

    async def store_link(self, project_id, target_id, link):
        async with self.projects.connection() as conn:
            await put(conn, stable(self.owner, 'link:' + project_id + ':' + target_id),
                      {**link, 'kind': 'sync_link', 'owner_id': self.owner, 'project_id': project_id, 'target_id': target_id})


async def upload_resources(handler, project_id, target):
    """Copy bytes to the destination's active storage; keep the local bytes and URLs."""
    async with handler.projects.connection() as conn:
        snapshot = await capture(conn, handler.owner, project_id)
    for identifier, b in snapshot['records'].items():
        if b['kind'] not in ('asset', 'generation'): continue
        record = await owned(handler.projects, identifier, handler.owner, b['kind'])
        original = record['body']; versions = copy.deepcopy(original.get('cloud_versions', {}))
        if b['kind'] == 'asset':
            if versions.get(target['id']) or original.get('remote_url'): continue
            path = handler.settings['config']['data_dir'] / 'media' / original['filename']
            raw = await asyncio.to_thread(path.read_bytes)
            result = await upload_bytes(target, raw, b['mime'], b['name'])
            versions[target['id']] = result
        else:
            saved = versions.setdefault(target['id'], {})
            for index, output in enumerate(original.get('outputs', [])):
                if str(index) in saved or output.get('remote_url'): continue
                # Use existing authenticated output handler, including ComfyUI and service-inference.
                headers = {'Cookie': handler.request.headers.get('Cookie', '')}
                if handler.settings.get('bridge_secret'): headers['X-Director-Bridge'] = handler.settings['bridge_secret']
                try:
                    response = await AsyncHTTPClient().fetch(HTTPRequest('http://' + handler.request.host + f'/api/outputs/{identifier}/{index}',
                        headers=headers, request_timeout=180))
                except (HTTPClientError, OSError, asyncio.TimeoutError):
                    source = '本地生成文件' if original.get('provider') == 'service-inference' else '原 ComfyUI 设备上的生成文件'
                    raise HTTPError(502, reason=f'同步暂停：无法读取任务 {identifier} 的第 {index + 1} 个结果（{source}）。请确认原文件存在、设备在线且网络可达，再重试。已上传资源会保留。') from None
                raw = response.body; mime = response.headers.get('Content-Type', '').split(';')[0]
                saved[str(index)] = await upload_bytes(target, raw, mime, identifier + '-' + str(index))
        async with handler.projects.connection() as conn:
            await conn.execute('UPDATE entities SET body=body || %s WHERE block_id=%s', (Jsonb({'cloud_versions': versions}), identifier), block_id=identifier)


async def upload_bytes(target, raw, mime, name):
    grant = await remote(target, '/api/storage/uploads', {'name': name, 'mime': mime, 'size': len(raw),
                         'md5': hashlib.md5(raw).hexdigest()})
    if grant.get('reused'): result = grant['asset']
    else:
        upload = grant['upload']; from urllib.parse import urlsplit
        parsed = urlsplit(upload['url'])
        suffix = {'qiniu': '.qiniup.com', 'aliyun': '.aliyuncs.com', 'tencent': '.myqcloud.com'}.get(grant.get('provider'))
        if not suffix or parsed.scheme != 'https' or not (parsed.hostname or '').endswith(suffix):
            raise HTTPError(502, reason='云端返回的上传地址不是存储厂商官方 HTTPS 地址')
        headers = dict(upload.get('headers', {})); content = raw
        if upload['method'] == 'POST':
            boundary = 'director' + uuid.uuid4().hex
            chunks = []
            for key, value in upload['fields'].items():
                if key not in ('key', 'token'): raise HTTPError(502, reason='云端上传表单字段不正确')
                chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
            chunks += [f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: {mime}\r\n\r\n'.encode(), raw, f'\r\n--{boundary}--\r\n'.encode()]
            content = b''.join(chunks); headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary
        response = await AsyncHTTPClient().fetch(HTTPRequest(upload['url'], method=upload['method'], body=content,
            headers=headers, follow_redirects=False, request_timeout=1800), raise_error=False)
        if not 200 <= response.code < 300 and not (grant['provider'] == 'qiniu' and response.code == 614):
            raise HTTPError(502, reason='素材上传未完成；本地副本保留，请重试')
        result = await remote(target, '/api/storage/uploads/' + grant['upload_id'] + '/confirm', {})
    return {**result, 'sha256': hashlib.sha256(raw).hexdigest(), 'verified_at': stamp()}


def routes():
    return [(r'/api/sync/targets', TargetsHandler),
        (r'/api/sync/catalog', CatalogHandler),
        (r'/api/sync/ack', AcknowledgeHandler),
        (r'/api/sync/projects/([0-9a-f]{32})/targets/([0-9a-f]{32})/receipt', RetryReceiptHandler),
        (r'/api/sync/prepare/([0-9a-f]{32})', PrepareHandler),
        (r'/api/sync/targets/([0-9a-f]{32})/catalog', RemoteCatalogHandler),
        (r'/api/sync/projects/([0-9a-f]{32})/status', SyncStatusHandler),
        (r'/api/sync/targets/([0-9a-f]{32})/authorize', AuthorizationHandler),
        (r'/api/sync/head/([0-9a-f]{32})', HeadHandler), (r'/api/sync/receive', ReceiveHandler),
        (r'/api/sync/projects/([0-9a-f]{32})/targets/([0-9a-f]{32})', ProjectSyncHandler),
        (r'/api/sync/projects/([0-9a-f]{32})/timeline', TimelineHandler)]

class SyncStatusHandler(PrivateHandler):
    async def get(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        targets = load_targets(self)['targets']; result = []
        async with self.projects.connection() as conn:
            for target_id, target in targets.items():
                link = await binding(conn, self.owner, project_id, target_id)
                try: local = await capture(conn, self.owner, project_id, link['canonical_ids'], target_id)
                except (ValueError, HTTPError): local = None
                base = link.get('base'); cards = {}
                if local:
                    root = local['records'][local['project_id']]
                    old_cards = {c['id']: c for c in (base or {}).get('records', {}).get(local['project_id'], {}).get('canvas', {}).get('cards', [])}
                    for card in root['canvas']['cards']:
                        same = old_cards.get(card['id']) == card
                        dependencies = set(protocol.references(card))
                        dependencies |= {i for i, b in local['records'].items() if b.get('card_id') == card['id'] or b.get('chat_id') == card.get('chat_id') and card.get('chat_id')}
                        if base:
                            same = same and all(local['records'].get(i) == base['records'].get(i) for i in dependencies if i in local['records'])
                        else: same = False
                        actual_id = next((i for i, canonical in link['canonical_ids'].items() if canonical == card['id']), card['id'])
                        cards[actual_id] = '已同步' if same else '待同步'
                result.append({'id': target_id, 'name': target['name'], 'enabled': link.get('enabled', False),
                    'last_sync': link.get('last_sync'), 'pending_receipt': link.get('pending_receipt', False),
                    'status': '已同步' if local and local == base else '待同步', 'cards': cards})
        self.finish({'targets': result})

    async def post(self, project_id):
        await owned(self.projects, project_id, self.owner, 'project')
        data = self.data(); target_id = data.get('target_id'); target_for(self, target_id)
        async with self.projects.connection() as conn:
            link = await binding(conn, self.owner, project_id, target_id)
            link.update(kind='sync_link', owner_id=self.owner, project_id=project_id, target_id=target_id, enabled=data.get('enabled') is True)
            await put(conn, stable(self.owner, 'link:' + project_id + ':' + target_id), link)
        self.finish({'ok': True})


class CatalogHandler(PrivateHandler):
    async def get(self):
        async with self.projects.connection() as conn:
            heads = await (await conn.scan("SELECT body FROM entities WHERE body->>'owner_id'=%s AND body->>'kind'='sync_head'", (self.owner,))).fetchall()
            projects = await (await conn.scan("SELECT block_id,body-'canvas' AS body,updatetime FROM entities WHERE body->>'owner_id'=%s AND body->>'kind'='project' ORDER BY updatetime DESC", (self.owner,), order_by='updatetime')).fetchall()
        by_project = {h['body']['project_id']: h['body']['lineage'] for h in heads}
        self.finish({'projects': [{'project_id': p['block_id'], 'lineage': by_project.get(p['block_id'], p['block_id']),
            'title': p['body']['title'], 'updated_at': p['updatetime']} for p in projects]})


class RemoteCatalogHandler(PrivateHandler):
    async def get(self, target_id): self.finish(await remote(target_for(self, target_id), '/api/sync/catalog'))

    async def post(self, target_id):
        target = target_for(self, target_id); lineage = self.data().get('lineage')
        if not isinstance(lineage, str) or not protocol.ID.fullmatch(lineage): raise HTTPError(400)
        async with self.settings['sync_lock']:
            await remote(target, '/api/sync/prepare/' + lineage, {})
            cloud = (await remote(target, '/api/sync/head/' + lineage))['head']
            if not cloud: raise HTTPError(404)
            snapshot = cloud['snapshot']
            import_id = stable(self.owner, 'import:' + target_id + ':' + lineage + ':' + cloud['hash'])
            async with self.projects.connection() as conn:
                existing = await row(conn, import_id)
                if existing:
                    project_id = existing['body']['project_id']; link = await binding(conn, self.owner, project_id, target_id)
                else:
                    project_id, ids = await materialize(conn, self.owner, snapshot)
                    link = {'kind': 'sync_link', 'owner_id': self.owner, 'project_id': project_id, 'target_id': target_id,
                        'lineage': lineage, 'canonical_ids': {new: old for old, new in ids.items()}, 'base': snapshot,
                        'remote_hash': cloud['hash'], 'remote_project_id': cloud['project_id'], 'last_sync': stamp(), 'enabled': True, 'pending_receipt': True}
                    await put(conn, stable(self.owner, 'link:' + project_id + ':' + target_id), link)
                    await put(conn, import_id, {'kind': 'sync_import', 'owner_id': self.owner, 'project_id': project_id})
            try:
                await acknowledge(target, lineage, cloud['hash'], cloud['project_id'], project_id, link['canonical_ids'], import_id)
                link['pending_receipt'] = False
                async with self.projects.connection() as conn: await put(conn, stable(self.owner, 'link:' + project_id + ':' + target_id), link)
            except HTTPError: pass  # The committed local copy remains available even offline.
            self.finish({'project_id': project_id, 'pending_receipt': link['pending_receipt']})


class PrepareHandler(PrivateHandler):
    async def post(self, lineage):
        if not self.settings['config'].get('cloud_mode'):
            self.finish({'ok': True}); return
        async with self.settings['sync_lock']:
            async with self.projects.connection() as conn: current = await head(conn, self.owner, lineage)
            if current:
                await upload_resources(self, current['project_id'], {'id': 'cloud-self',
                    'internal_url': 'http://' + self.request.host, 'bridge_secret': self.settings['bridge_secret']})
        self.finish({'ok': True})


async def acknowledge(target, lineage, content_hash, cloud_project_id, local_project_id, mapping, request_id):
    return await remote(target, '/api/sync/ack', {'lineage': lineage, 'hash': content_hash,
        'cloud_project_id': cloud_project_id, 'origin_project_id': local_project_id,
        'canonical_ids': mapping, 'request_id': request_id})


class AcknowledgeHandler(PrivateHandler):
    async def post(self):
        data = self.data()
        for key in ('lineage', 'cloud_project_id', 'origin_project_id', 'request_id'):
            if not isinstance(data.get(key), str) or not protocol.ID.fullmatch(data[key]): raise HTTPError(400)
        import re
        if not isinstance(data.get('hash'), str) or not re.fullmatch('[0-9a-f]{64}', data['hash']): raise HTTPError(400)
        mapping = data.get('canonical_ids')
        if not isinstance(mapping, dict) or len(mapping) > 20000 or any(not protocol.ID.fullmatch(k) or not isinstance(v, str) or not protocol.ID.fullmatch(v) for k, v in mapping.items()): raise HTTPError(400)
        await owned(self.projects, data['cloud_project_id'], self.owner, 'project')
        identifier = stable(self.owner, 'ack:' + data['request_id'])
        async with self.projects.connection() as conn:
            existing = await row(conn, identifier)
            if existing:
                if existing['body']['acknowledgement'] != data: raise HTTPError(409, reason='回执 UUID 与原内容不一致')
                self.finish({'ok': True, 'recorded_at': existing['body']['recorded_at']}); return
            at = stamp()
            await put(conn, identifier, {'kind': 'sync_receipt', 'owner_id': self.owner, 'project_id': data['cloud_project_id'],
                'lineage': data['lineage'], 'acknowledgement': data, 'recorded_at': at})
        self.finish({'ok': True, 'recorded_at': at})


class RetryReceiptHandler(PrivateHandler):
    async def post(self, project_id, target_id):
        await owned(self.projects, project_id, self.owner, 'project'); target = target_for(self, target_id)
        async with self.settings['sync_lock']:
            async with self.projects.connection() as conn: link = await binding(conn, self.owner, project_id, target_id)
            if not link.get('pending_receipt'): self.finish({'ok': True}); return
            import_id = stable(self.owner, 'import:' + target_id + ':' + link['lineage'] + ':' + link['remote_hash'])
            await acknowledge(target, link['lineage'], link['remote_hash'], link['remote_project_id'], project_id, link['canonical_ids'], import_id)
            link['pending_receipt'] = False
            async with self.projects.connection() as conn: await put(conn, stable(self.owner, 'link:' + project_id + ':' + target_id), link)
        self.finish({'ok': True})
