"""Portable, immutable project snapshots. UUIDs are identities, never clocks."""
import copy
import hashlib
import json
import re
import uuid
from urllib.parse import urlsplit

VERSION = 1
ID = re.compile(r'^[0-9a-f]{32}$')
KINDS = {'project', 'asset', 'cloud_upload', 'generation', 'chat', 'chat_pack'}
PRIVATE = {'credential_owner', 'created_by', 'imported', 'owner_id', 'filename', 'comfy_url', 'prompt_id', 'provider_task_id', 'key_id',
           'remote_task_id', 'profile_id', 'profile_fingerprint', 'key', 'expires_at', 'cloud_versions', 'revision'}
IDENTITIES = {'id', 'block_id', 'project_id', 'card_id', 'clip_id', 'asset_id', 'chat_id', 'job_id',
              'pack_id', 'prev_block_id', 'next_block_id', 'first_pack_id', 'last_pack_id',
              'head_id', 'tail_id', 'prev_id', 'next_id', 'head_block_id', 'tail_block_id', 'source', 'target', 'selected', 'request_id'}
IDENTITY_LISTS = {'covers', 'refs', 'pins', 'hiddenJobs', 'asset_ids', 'job_ids'}
URL = re.compile(r"""/api/(?:assets|outputs|storage/uploads)/([0-9a-f]{32})(?=/|$|[?#\s"'<>\)])""")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def endpoint(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError('请输入云端 HTTPS 域名和产品路径')
    parsed = urlsplit(value.strip())
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.port not in (None, 443)
            or any(p in ('.', '..') for p in parsed.path.split('/')) or '%' in parsed.path
            or not re.fullmatch(r'/[A-Za-z0-9_/-]*', parsed.path)):
        raise ValueError('云端地址必须为 HTTPS 域名及路径，不含账号、查询参数或跳转路径')
    return 'https://' + parsed.hostname.lower() + parsed.path.rstrip('/')


def remap(value, mapping, key=''):
    """Rewrite only typed references, never UUID-looking prompt/comment text."""
    if isinstance(value, dict):
        result = {(mapping.get(k, k) if key in ('records', 'ref_info') else k): remap(v, mapping, k)
                  for k, v in value.items()}
        if value.get('format') in ('html', 'markdown') and isinstance(value.get('content'), str):
            result['content'] = URL.sub(lambda m: m.group(0).replace(m[1], mapping.get(m[1], m[1])), value['content'])
        return result
    if isinstance(value, list):
        return [remap(v, mapping, key) for v in value]
    if isinstance(value, str):
        if key in IDENTITIES | IDENTITY_LISTS:
            return mapping.get(value, value)
        if key in ('url', 'preview', 'thumbnail', 'src'):
            return URL.sub(lambda m: m.group(0).replace(m[1], mapping.get(m[1], m[1])), value)
    return value


def references(value, key=''):
    if isinstance(value, dict):
        if value.get('format') in ('html', 'markdown') and isinstance(value.get('content'), str):
            yield from URL.findall(value['content'])
        for k, v in value.items():
            if key == 'ref_info' and ID.fullmatch(k):
                yield k
            yield from references(v, k)
    elif isinstance(value, list):
        for v in value:
            yield from references(v, key)
    elif isinstance(value, str):
        if key in IDENTITIES | IDENTITY_LISTS and ID.fullmatch(value):
            yield value
        if key in ('url', 'preview', 'thumbnail', 'src'):
            yield from URL.findall(value)


def portable(body, strict=True):
    # The original body remains in local history; transport omits machine paths/credentials.
    result = copy.deepcopy(body)
    for k in PRIVATE:
        result.pop(k, None)
    if result.get('kind') == 'generation':
        if strict and result.get('status') not in ('completed', 'failed', 'cancelled'):
            raise ValueError('请等待生成任务完成或取消后再同步')
        result['outputs'] = [{k: v for k, v in o.items() if k in ('mime', 'remote_url', 'sha256', 'size')}
                             for o in result.get('outputs', [])]
    return result


def validate(snapshot):
    if not isinstance(snapshot, dict) or snapshot.get('version') != VERSION:
        raise ValueError('不支持的同步协议版本')
    if set(snapshot) != {'version', 'project_id', 'records'}:
        raise ValueError('快照只能包含协议版本、项目 ID 和实体记录')
    records = snapshot.get('records')
    if not isinstance(records, dict) or not 1 <= len(records) <= 10000:
        raise ValueError('同步记录数必须在 1 到 10000 之间')
    root = snapshot.get('project_id')
    if root not in records or records[root].get('kind') != 'project':
        raise ValueError('缺少项目根记录')
    for identifier, body in records.items():
        if not ID.fullmatch(identifier) or not isinstance(body, dict) or body.get('kind') not in KINDS:
            raise ValueError('同步实体格式不正确')
        if any(k in body for k in PRIVATE):
            raise ValueError('同步数据包含本机私有字段')
        if body.get('kind') == 'project':
            if identifier != root: raise ValueError('一次只能同步一个项目')
            from backend.workspace import validate_project
            validate_project(body)
        if body.get('kind') == 'cloud_upload' and body.get('status') != 'completed':
            raise ValueError('云存储素材必须已确认完成')
        if body.get('kind') in ('asset', 'cloud_upload'):
            url = body.get('remote_url') if body['kind'] == 'asset' else body.get('url')
            if not isinstance(url, str) or urlsplit(url).scheme != 'https':
                raise ValueError('本地素材必须先完成云存储上传')
        if body.get('kind') == 'generation':
            if body.get('status') not in ('completed', 'failed', 'cancelled'):
                raise ValueError('不能导入执行中的生成任务')
            for output in body.get('outputs', []):
                if urlsplit(output.get('remote_url', '')).scheme != 'https':
                    raise ValueError('生成结果必须先完成云存储上传')
    if len(json.dumps(snapshot)) > 16 * 1024 * 1024:
        raise ValueError('项目快照超过 16 MB，请拆分项目')
    # Reference integrity: card/edge/message IDs are inline, entity refs are external.
    inline = {c['id'] for c in records[root]['canvas']['cards']}
    inline.update(e['id'] for e in records[root]['canvas'].get('connections', []))
    from backend.timeline import timelines
    for timeline in timelines(records[root]['canvas']):
        if 'id' in timeline: inline.add(timeline['id'])
        inline.update(e['id'] for e in timeline['clips'] + timeline['subtitles'])
    for body in records.values():
        if body['kind'] == 'chat_pack':
            inline.update(m['id'] for m in body.get('messages', []) if isinstance(m, dict) and isinstance(m.get('id'), str))
    for ref in references(records):
        if ref not in records and ref not in inline:
            raise ValueError('同步快照缺少关联实体：' + ref)
    return snapshot


def fresh_copy(snapshot, owner):
    """Every incoming branch receives fresh entity, card, edge and message UUIDs."""
    validate(snapshot)
    identifiers = set(snapshot['records']) | set(references(snapshot['records']))
    mapping = {old: uuid.uuid4().hex for old in identifiers}
    result = remap(snapshot, mapping)
    for body in result['records'].values():
        body['owner_id'] = owner
        if body['kind'] == 'project': body['revision'] = 1
        if body['kind'] == 'asset': body['filename'] = ''
        if body['kind'] == 'generation': body['imported'] = True
    return result, mapping


def diff(before, after, path=''):
    """Stable JSON-pointer diff, arrays of identified objects compared by identity."""
    if before == after:
        return []
    if isinstance(before, list) and isinstance(after, list) and all(isinstance(x, dict) and 'id' in x for x in before + after):
        changes = diff({x['id']: x for x in before}, {x['id']: x for x in after}, path)
        if path.endswith('/clips') and [x['id'] for x in before] != [x['id'] for x in after]:
            changes.append({'path': path + '/order', 'operation': 'replace', 'before': [x['id'] for x in before], 'after': [x['id'] for x in after]})
        return changes
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for key in sorted(before.keys() | after.keys()):
            p = path + '/' + str(key).replace('~', '~0').replace('/', '~1')
            if key not in before: result.append({'path': p, 'operation': 'add', 'after': after[key]})
            elif key not in after: result.append({'path': p, 'operation': 'remove', 'before': before[key]})
            else: result.extend(diff(before[key], after[key], p))
        return result
    return [{'path': path or '/', 'operation': 'replace', 'before': before, 'after': after}]


def compare(base, local, remote):
    left, right = diff(base or {}, local), diff(base or {}, remote)
    conflicts = []
    for a in left:
        for b in right:
            if (a['path'] == b['path'] or a['path'].startswith(b['path'] + '/') or b['path'].startswith(a['path'] + '/')) and a != b:
                conflicts.append({'path': a['path'], 'local': a, 'remote': b})
    return {'local_changes': left, 'remote_changes': right, 'conflicts': conflicts,
            'identical': local == remote}
