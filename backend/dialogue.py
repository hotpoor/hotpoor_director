"""Private durable text conversations using each account's inference credentials."""
import asyncio
import json
import time
import uuid

from psycopg.types.json import Jsonb
from tornado.web import HTTPError

from backend.workspace import PrivateHandler, owned, ID
from backend import inference
from backend.dialogue_files import attachment_ids, file_for, public_file, prepare_messages

MAX_CONTEXT = 120000
PENDING_TIMEOUT_MS = 330000


def language_models(items):
    return [m for m in items or [] if m.get('type') == 'llm']


def endpoint(model, protocol='auto'):
    if protocol not in ('auto', 'chat', 'responses'):
        raise HTTPError(400, reason='对话接口类型不正确')
    return '/v1/responses' if protocol == 'responses' or protocol == 'auto' and model.startswith('gpt-6') else '/v1/chat/completions'


def request_body(model, messages, path):
    return {'model': model, 'input' if path == '/v1/responses' else 'messages': messages, 'stream': False}


def answer(result, path):
    if path == '/v1/responses':
        if result.get('status') not in (None, 'completed'):
            raise inference.ProviderError('回答未完成，请查看服务控制台；不会自动重发')
        text = ''.join(part.get('text', '') for item in result.get('output', [])
                       if item.get('type') == 'message' and item.get('role') == 'assistant'
                       for part in item.get('content', []) if part.get('type') == 'output_text')
    else:
        choices = result.get('choices') or []
        text = choices[0].get('message', {}).get('content') if choices else None
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_CONTEXT:
        raise inference.ProviderError('模型未返回可显示的文本回答，或回答超过保存上限')
    return text


def history(turns):
    messages = []
    for turn in turns:
        if turn['status'] == 'completed':
            messages.extend([{'role': 'user', 'content': turn['question'], **({'attachments': turn['attachments']} if turn.get('attachments') else {})}, {'role': 'assistant', 'content': turn['answer']}])
    return messages


def validate_question(data):
    question = data.get('question')
    if not isinstance(question, str) or not 1 <= len(question.strip()) <= 20000:
        raise HTTPError(400, reason='问题需为 1–20000 个字符')
    if not isinstance(data.get('request_id'), str) or not ID.fullmatch(data['request_id']):
        raise HTTPError(400, reason='请求 ID 不正确')
    return question.strip()


def dialogue_options(data):
    result = {}
    for name, default, low, high, label in [('context_turns', 20, 0, 100, '历史轮次'), ('pack_size', 25, 1, 100, '每包轮次')]:
        value = data.get(name, default)
        if type(value) is not int or not low <= value <= high:
            raise HTTPError(400, reason=f'{label}需为 {low}–{high} 的整数')
        result[name] = value
    return result


async def row_for(conn, conversation_id, owner):
    row = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'kind'='dialogue' AND body->>'owner_id'=%s", (conversation_id, owner), block_id=conversation_id)).fetchone()
    if not row:
        raise HTTPError(404, reason='对话不存在或无权访问')
    return row


async def store(conn, conversation_id, body):
    return await (await conn.execute('UPDATE entities SET body=%s WHERE block_id=%s RETURNING *', (Jsonb(body), conversation_id), block_id=conversation_id)).fetchone()


async def pack_for(conn, pack_id, owner, conversation_id):
    row = await (await conn.execute("SELECT * FROM entities WHERE block_id=%s AND body->>'kind'='dialogue_pack' AND body->>'owner_id'=%s AND body->>'conversation_id'=%s", (pack_id, owner, conversation_id), block_id=pack_id)).fetchone()
    if not row:
        raise HTTPError(404, reason='聊天记录包不存在或无权访问')
    return row


async def recent_turns(conn, body, owner, conversation_id):
    turns = []
    limit = body.get('context_turns', 20)
    if not limit:
        return []
    pack_id = body.get('last_id')
    while pack_id and len(turns) < limit:
        pack = await pack_for(conn, pack_id, owner, conversation_id)
        turns = [t for t in pack['body']['turns'] if t['status'] == 'completed'] + turns
        pack_id = pack['body'].get('prev_id')
    return turns[-limit:]


async def recent_history(conn, body, owner, conversation_id):
    return history(await recent_turns(conn, body, owner, conversation_id))


def submission_stats(raw_messages, prepared_messages, model, path):
    attachments = [file for message in raw_messages for file in message.get('attachments', [])]
    text_chars = 0
    for message in prepared_messages:
        content = message.get('content')
        if isinstance(content, str):
            text_chars += len(content)
        elif isinstance(content, list):
            text_chars += sum(len(part.get('text', '')) for part in content
                              if part.get('type') in ('text', 'input_text'))
    payload = request_body(model, prepared_messages, path)
    return {'history_turns': max(0, (len(raw_messages) - 1) // 2), 'messages': len(prepared_messages),
            'text_chars': text_chars, 'attachments': len(attachments),
            'attachment_bytes': sum(file.get('size', 0) for file in attachments),
            'request_bytes': len(json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode())}


async def context_for(conn, row, owner, turn_id):
    by_id = {}
    target = None
    pack_id = row['body'].get('last_id')
    while pack_id:
        pack = await pack_for(conn, pack_id, owner, row['block_id'])
        for turn in pack['body']['turns']:
            by_id[turn['id']] = turn
            if turn['id'] == turn_id:
                target = turn
        pack_id = pack['body'].get('prev_id')
    if not target:
        raise HTTPError(404, reason='本次上下文不存在或无权访问')
    return {'turn_id': turn_id, 'submission': target.get('submission'),
            'turns': [{key: turn.get(key) for key in
                       ('id', 'question', 'answer', 'model', 'key_name', 'created_at', 'attachments')}
                      for item in target.get('context_ids', []) if (turn := by_id.get(item))]}


async def view_row(conn, row, owner, cursor=None):
    body = dict(row['body'])
    pack_id = cursor or body.get('last_id')
    pack = await pack_for(conn, pack_id, owner, row['block_id']) if pack_id else None
    body.update(turns=pack['body']['turns'] if pack else [], pack_id=pack_id,
                prev_id=pack['body'].get('prev_id') if pack else None,
                next_id=pack['body'].get('next_id') if pack else None)
    return {**row, 'body': body}


async def complete(pool, owner, conversation_id, pack_id, turn_id, key, model, messages, path):
    patch = {'status': 'completed'}
    try:
        result = await inference.api(key, path, request_body(model, messages, path))
        patch.update(answer=answer(result, path), usage=result.get('usage'), provider_request_id=result.get('_request_id'))
    except inference.ProviderError as error:
        patch = {'status': 'failed', 'error': str(error)}
    except asyncio.CancelledError:
        patch = {'status': 'interrupted', 'error': '服务已停止；请求可能已受理，不会自动重发'}
    except Exception:
        patch = {'status': 'failed', 'error': '回答处理失败；请查看服务控制台，不会自动重发'}
    async with pool.connection() as conn:
        row = await row_for(conn, conversation_id, owner)
        pack = await pack_for(conn, pack_id, owner, conversation_id)
        turn = next(t for t in pack['body']['turns'] if t['id'] == turn_id)
        if turn['status'] == 'running':
            turn.update(patch, finished_at=int(time.time() * 1000))
            await store(conn, pack_id, pack['body'])
            row['body']['pending_id'] = None
            await store(conn, conversation_id, row['body'])


class DialogueModelsHandler(PrivateHandler):
    async def get(self):
        refresh = self.get_query_argument('refresh', '') == '1'
        async with self.settings['inference_manager'].lock:
            value = inference.load_keys(self.settings['config'])
            errors = []
            for profile in value['keys']:
                if profile['id'] not in inference.enabled_ids(value):
                    continue
                if refresh or profile.get('models') is None:
                    try:
                        await inference.refresh_profile(profile)
                    except inference.ProviderError as error:
                        errors.append({'key_id': profile['id'], 'message': str(error)})
                        # A failed live refresh must not advertise stale availability.
                        profile['models'] = None
            inference.save_keys(self.settings['config'], value)
        self.finish({'keys': [{'id': p['id'], 'name': p['name'], 'models': language_models(p.get('models'))}
                              for p in value['keys'] if p['id'] in inference.enabled_ids(value)], 'errors': errors})


class DialoguesHandler(PrivateHandler):
    async def get(self):
        async with self.projects.connection() as conn:
            rows = await (await conn.scan("SELECT block_id, body - 'turns' AS body, createtime, updatetime FROM entities WHERE body->>'kind'='dialogue' AND body->>'owner_id'=%s ORDER BY updatetime DESC", (self.owner,), order_by='updatetime')).fetchall()
        self.finish({'conversations': rows})

    async def post(self):
        conversation_id = uuid.uuid4().hex
        body = {'kind': 'dialogue', 'owner_id': self.owner, 'title': '新对话', 'first_id': None, 'last_id': None, 'turn_count': 0, 'pending_id': None, **dialogue_options(self.data())}
        async with self.projects.connection() as conn:
            row = await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) RETURNING *', (conversation_id, Jsonb(body)), block_id=conversation_id)).fetchone()
        self.finish({**row, 'body': {**row['body'], 'turns': [], 'pack_id': None, 'prev_id': None, 'next_id': None}})


class DialogueHandler(PrivateHandler):
    async def get(self, conversation_id):
        tasks = self.application.settings.setdefault('dialogue_tasks', {})
        cursor = self.get_query_argument('cursor', None)
        context_id = self.get_query_argument('context', None)
        if cursor is not None and not ID.fullmatch(cursor):
            raise HTTPError(400, reason='聊天记录包 ID 不正确')
        if context_id is not None and not ID.fullmatch(context_id):
            raise HTTPError(400, reason='上下文记录 ID 不正确')
        async with self.projects.connection() as conn:
            row = await row_for(conn, conversation_id, self.owner)
            if context_id is not None:
                self.finish(await context_for(conn, row, self.owner, context_id))
                return
            result = await view_row(conn, row, self.owner, cursor)
        result['body']['interrupted'] = bool(row['body'].get('pending_id') and conversation_id not in tasks
                                          and int(time.time() * 1000) - row['body'].get('pending_started_at', 0) > PENDING_TIMEOUT_MS)
        self.finish(result)

    async def post(self, conversation_id):
        data = self.data()
        tasks = self.application.settings.setdefault('dialogue_tasks', {})
        if data.get('action') == 'acknowledge':
            async with self.projects.connection() as conn:
                row = await row_for(conn, conversation_id, self.owner)
                if conversation_id in tasks or row['body'].get('pending_id') and int(time.time() * 1000) - row['body'].get('pending_started_at', 0) <= PENDING_TIMEOUT_MS:
                    raise HTTPError(409, reason='回答仍在处理中，请稍后核对请求状态')
                if row['body'].get('pending_id'):
                    pack = await pack_for(conn, row['body']['last_id'], self.owner, conversation_id)
                    for turn in pack['body']['turns']:
                        if turn['status'] == 'running':
                            turn.update(status='interrupted', error='连接中断，请核对服务控制台；此问题不会自动重发')
                    await store(conn, pack['block_id'], pack['body'])
                    row['body']['pending_id'] = None
                    await store(conn, conversation_id, row['body'])
                result = await view_row(conn, row, self.owner)
            self.finish(result)
            return
        if data.get('action') == 'configure':
            options = dialogue_options(data)
            async with self.projects.connection() as conn:
                row = await row_for(conn, conversation_id, self.owner)
                if row['body'].get('pending_id'):
                    raise HTTPError(409, reason='请等待当前回答完成后修改配置')
                row['body'].update(options)
                row = await store(conn, conversation_id, row['body'])
                result = await view_row(conn, row, self.owner)
            self.finish(result)
            return
        question = validate_question(data)
        file_ids = attachment_ids(data)
        async with self.projects.connection() as conn:
            row = await row_for(conn, conversation_id, self.owner)
            duplicates = await (await conn.scan("SELECT block_id FROM entities WHERE body->>'kind'='dialogue_pack' AND body->>'conversation_id'=%s AND body->>'owner_id'=%s AND body->'turns' @> %s", (conversation_id, self.owner, Jsonb([{'id': data['request_id']}])))).fetchall()
            if duplicates:
                self.finish(await view_row(conn, row, self.owner))
                return
        async with self.settings['inference_manager'].lock:
            value = inference.load_keys(self.settings['config'])
            profile = inference.key_profile(value, data.get('credential_id', ''))
            if not profile or profile['id'] not in inference.enabled_ids(value):
                raise HTTPError(400, reason='请选择已启用的 AK')
            try:
                await inference.refresh_profile(profile)
            except inference.ProviderError as error:
                raise HTTPError(502, reason=str(error)) from None
            inference.save_keys(self.settings['config'], value)
            model = data.get('model')
            if not isinstance(model, str) or model not in {m['id'] for m in language_models(profile['models'])}:
                raise HTTPError(400, reason='此 AK 当前无法使用所选语言模型，请刷新列表')
            key = profile['api_key']
        path = endpoint(model, data.get('protocol', 'auto'))
        async with self.projects.connection() as conn:
            row = await row_for(conn, conversation_id, self.owner)
            body = row['body']
            if body.get('pending_id'):
                if body['pending_id'] == data['request_id']:
                    self.finish(await view_row(conn, row, self.owner))
                    return
                raise HTTPError(409, reason='请等待当前回答完成；中断后需先核对请求状态')
            # Re-check duplicates inside the atomic append transaction.
            duplicates = await (await conn.scan("SELECT block_id FROM entities WHERE body->>'kind'='dialogue_pack' AND body->>'conversation_id'=%s AND body->>'owner_id'=%s AND body->'turns' @> %s", (conversation_id, self.owner, Jsonb([{'id': data['request_id']}])))).fetchall()
            if duplicates:
                self.finish(await view_row(conn, row, self.owner))
                return
            context_turns = await recent_turns(conn, body, self.owner, conversation_id)
            messages = history(context_turns)
            attachments = [public_file(await file_for(conn, file_id, self.owner, conversation_id)) for file_id in file_ids]
            messages.append({'role': 'user', 'content': question, 'attachments': attachments})
            raw_messages = messages
            messages = await prepare_messages(conn, messages, self.settings['config'], self.owner, conversation_id, path)
            submission = submission_stats(raw_messages, messages, model, path)
            if sum(len(m['content']) for m in messages if isinstance(m['content'], str)) > MAX_CONTEXT:
                raise HTTPError(400, reason='上下文超过 120000 字符，请减少历史轮次或新建对话')
            pack = await pack_for(conn, body['last_id'], self.owner, conversation_id) if body.get('last_id') else None
            if not pack or len(pack['body']['turns']) >= body['pack_size']:
                pack_id = uuid.uuid4().hex
                pack_body = {'kind': 'dialogue_pack', 'owner_id': self.owner, 'conversation_id': conversation_id,
                             'prev_id': body.get('last_id'), 'next_id': None, 'turns': []}
                if pack:
                    pack['body']['next_id'] = pack_id
                    await store(conn, pack['block_id'], pack['body'])
                pack = await (await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) RETURNING *', (pack_id, Jsonb(pack_body)), block_id=pack_id)).fetchone()
                body['last_id'] = pack_id
                body['first_id'] = body.get('first_id') or pack_id
            turn = {'id': data['request_id'], 'question': question, 'model': model, 'credential_id': profile['id'],
                    'key_name': profile['name'], 'attachments': attachments,
                    'context_ids': [item['id'] for item in context_turns], 'submission': submission,
                    'protocol': path, 'status': 'running', 'created_at': int(time.time() * 1000)}
            pack['body']['turns'].append(turn)
            await store(conn, pack['block_id'], pack['body'])
            body['turn_count'] += 1
            body['pending_id'] = turn['id']
            body['pending_started_at'] = turn['created_at']
            if body['turn_count'] == 1:
                body['title'] = question[:60]
            row = await store(conn, conversation_id, body)
            result = await view_row(conn, row, self.owner)
        task = asyncio.create_task(complete(self.projects, self.owner, conversation_id, pack['block_id'], turn['id'], key, model, messages, path))
        tasks[conversation_id] = task
        def done(finished):
            if tasks.get(conversation_id) is finished:
                tasks.pop(conversation_id, None)
            if not finished.cancelled():
                finished.exception()
        task.add_done_callback(done)
        self.finish(result)


async def close_dialogues(application):
    tasks = list(application.settings.get('dialogue_tasks', {}).values())
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
