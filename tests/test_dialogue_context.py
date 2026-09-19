"""Long-history recovery with a deterministic provider; no paid requests."""
import asyncio
from contextlib import asynccontextmanager
from copy import deepcopy
import json

import pytest

from backend import dialogue, dialogue_context as context
from backend.inference import ProviderError


class MemoryPool:
    def __init__(self):
        self.rows = {
            'conversation': {'block_id': 'conversation', 'body': {
                'kind': 'dialogue', 'owner_id': 'owner', 'last_id': 'pack',
                'context_turns': 20, 'pending_id': 'new'}},
            'pack': {'block_id': 'pack', 'body': {
                'kind': 'dialogue_pack', 'owner_id': 'owner', 'conversation_id': 'conversation',
                'turns': [{'id': 'old', 'question': 'old', 'answer': 'x' * 150000,
                           'created_at': 1, 'status': 'completed'},
                          {'id': 'new', 'question': 'continue', 'created_at': 2, 'status': 'running'}]}}
        }

    @asynccontextmanager
    async def connection(self):
        yield self

    async def execute(self, query, params, *, block_id):
        if query.startswith('INSERT'):
            assert block_id not in self.rows
            self.rows[block_id] = {'block_id': block_id, 'body': deepcopy(params[1].obj)}
        elif query.startswith('UPDATE'):
            self.rows[block_id]['body'] = deepcopy(params[0].obj)
        row = deepcopy(self.rows.get(block_id))
        if query.startswith('SELECT') and row and len(params) > 1:
            if row['body']['owner_id'] != params[1]:
                row = None
            elif len(params) > 2 and row['body']['conversation_id'] != params[2]:
                row = None
        class Result:
            async def fetchone(self):
                return row
        return Result()


def response(text, path):
    if path == '/v1/responses':
        return {'status': 'completed', 'output': [{'type': 'message', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': text}]}], 'usage': {'input_tokens': 10}}
    return {'choices': [{'message': {'content': text}}], 'usage': {'input_tokens': 10}}


@pytest.mark.parametrize('path', ['/v1/responses', '/v1/chat/completions'])
def test_over_limit_history_maps_reduces_and_persists_checkpoint(monkeypatch, path):
    async def run():
        pool = MemoryPool()
        requests = []
        async def api(key, actual_path, payload):
            messages = payload.get('input', payload.get('messages'))
            requests.append(messages)
            assert context.text_size(messages) < 40000
            assert 'tools' not in payload
            return response('已完成文件扫描；下一步整理索引。' if messages[0].get('role') == 'system' else '继续完成', actual_path)
        monkeypatch.setattr(dialogue.inference, 'api', api)
        before = deepcopy(pool.rows['pack']['body']['turns'][0])
        messages = [{'role': 'user', 'content': '整理文档'},
                    {'role': 'assistant', 'content': 'x' * 150000},
                    {'role': 'user', 'content': '继续'}]
        await dialogue.complete(pool, 'owner', 'conversation', 'pack', 'new', 'secret', 'model',
                                messages, path, summary_through='old')
        turn = pool.rows['pack']['body']['turns'][-1]
        assert turn['status'] == 'completed'
        assert pool.rows['pack']['body']['turns'][0] == before
        assert pool.rows['conversation']['body']['pending_id'] is None
        entities = [r for r in pool.rows.values() if r['body']['kind'] == 'dialogue_summary']
        assert len(turn['context_summary']['segment_ids']) >= 7  # Five segments, two merges; identical segments reuse an entity.
        assert any(r['body']['parent_ids'] for r in entities)
        assert 'secret' not in json.dumps(entities)
        checkpoint = pool.rows['conversation']['body']['context_summary']
        assert checkpoint['entity_id'] in pool.rows
        assert requests[-1][-1] == messages[-1]
        assert checkpoint['text'] in requests[-1][0]['content']
        # A reload carries only the newer turn; the old giant answer is replaced.
        recent = await dialogue.recent_turns(pool, pool.rows['conversation']['body'], 'owner', 'conversation')
        assert [t['id'] for t in recent] == ['new']
        result = await dialogue.context_for(pool, pool.rows['conversation'], 'owner', 'new')
        assert result['summary']['entity_id'] == checkpoint['entity_id']
        assert result['turns'] == []
    asyncio.run(run())


def test_failed_segment_reuses_completed_entities_after_restart(monkeypatch):
    async def run():
        pool = MemoryPool()
        calls = 0
        async def api(key, path, payload):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise ProviderError('temporary failure')
            return response('保留的任务进度', path)
        monkeypatch.setattr(dialogue.inference, 'api', api)
        messages = [{'role': 'assistant', 'content': 'a' * 40000 + 'b' * 40000},
                    {'role': 'user', 'content': 'next'}]
        store = context.SummaryStore(pool, 'owner', 'conversation', 'pack', 'new')
        with pytest.raises(ProviderError, match='temporary'):
            await context.compact(messages, 'key', 'model', '/v1/responses', summary_store=store)
        assert len([r for r in pool.rows.values() if r['body']['kind'] == 'dialogue_summary']) == 1
        # New instance simulates process restart; completed first segment isn't billed again.
        store = context.SummaryStore(pool, 'owner', 'conversation', 'pack', 'new')
        output, summary = await context.compact(messages, 'key', 'model', '/v1/responses', summary_store=store)
        assert calls == 5  # success + failure + two remaining segments + merge
        assert len(summary['segment_ids']) == 4
        assert output[-1] == messages[-1]
        before = calls
        await context.compact(messages, 'key', 'model', '/v1/responses', summary_store=store)
        assert calls == before
    asyncio.run(run())


def test_agent_compaction_closes_tool_pairs_and_keeps_result(monkeypatch):
    async def run():
        pool = MemoryPool()
        seen = []
        async def api(key, path, payload):
            seen.append(payload)
            assert 'tools' not in payload
            return response('命令已经执行，exit_code=0；不可重复执行。', path)
        monkeypatch.setattr(dialogue.inference, 'api', api)
        messages = [{'role': 'system', 'content': 'credential names only'},
                    {'role': 'user', 'content': '处理资料'},
                    {'type': 'reasoning', 'encrypted_content': 'opaque-secret'},
                    {'type': 'function_call', 'call_id': 'c1', 'name': 'run_command', 'arguments': '{}'},
                    {'type': 'function_call_output', 'call_id': 'c1', 'output': 'x'*81000 + 'exit_code=0'}]
        output, summary = await context.compact(messages, 'key', 'model', '/v1/responses', True,
                context.SummaryStore(pool, 'owner', 'conversation', 'pack', 'new'))
        assert output[0] == messages[0]
        assert all(m.get('type') not in ('function_call', 'function_call_output') for m in output)
        assert 'exit_code=0' in json.dumps(seen)
        assert 'opaque-secret' not in json.dumps(seen)
        assert '不可重复执行' in summary['text']
    asyncio.run(run())


def test_small_context_avoids_summary_and_media_is_not_base64_text():
    messages = [{'role': 'user', 'content': 'hi'}]
    assert asyncio.run(context.compact(messages, 'key', 'model', '/v1/responses')) == (messages, None)
    media = {'type': 'input_image', 'image_url': 'data:image/png;base64,xxx'}
    chunks = list(context.summary_chunks([{'role': 'user', 'content': [
        {'type': 'input_text', 'text': 'x'*90000}, media]}], '/v1/responses'))
    assert all(len(c) <= context.CHUNK for c in chunks if isinstance(c, str))
    assert chunks[-1][-1] == media


def test_failed_summary_keeps_history_and_unlocks_conversation(monkeypatch):
    async def run():
        pool = MemoryPool()
        async def api(*args):
            raise ProviderError('summary unavailable')
        monkeypatch.setattr(dialogue.inference, 'api', api)
        await dialogue.complete(pool, 'owner', 'conversation', 'pack', 'new', 'key', 'model',
                                [{'role': 'assistant', 'content': 'x'*150000},
                                 {'role': 'user', 'content': 'continue'}], '/v1/responses', summary_through='old')
        assert pool.rows['pack']['body']['turns'][-1]['status'] == 'failed'
        assert pool.rows['conversation']['body']['pending_id'] is None
        assert 'context_summary' not in pool.rows['conversation']['body']
        assert len(pool.rows['pack']['body']['turns'][0]['answer']) == 150000
    asyncio.run(run())


def test_old_text_and_attachments_can_exceed_legacy_guard_but_new_input_cannot(monkeypatch):
    from backend import dialogue_files
    from tornado.web import HTTPError
    async def run():
        async def file_for(*args):
            return {'body': {'size': 70000, 'format': 'text', 'name': 'notes.md', 'text': 'x'*70000}}
        monkeypatch.setattr(dialogue_files, 'file_for', file_for)
        messages = [{'role': 'user', 'content': 'question', 'attachments': [{'id': 'file'}]},
                    {'role': 'assistant', 'content': 'a'*70000}]
        with pytest.raises(HTTPError):
            await dialogue_files.prepare_messages(None, messages, {}, 'owner', 'conversation', '/v1/responses')
        prepared = await dialogue_files.prepare_messages(None, messages, {}, 'owner', 'conversation',
                                                        '/v1/responses', enforce_limits=False)
        assert context.text_size(prepared) > 120000
        assert context.needs_summary(prepared)
        with pytest.raises(HTTPError):
            await dialogue_files.prepare_messages(None, [{'role': 'user', 'content': 'x'*120001}],
                                                  {}, 'owner', 'conversation', '/v1/responses')
    asyncio.run(run())


def test_repeated_compaction_includes_old_summary_and_new_records(monkeypatch):
    async def run():
        pool = MemoryPool()
        seen = []
        async def api(key, path, payload):
            seen.append(json.dumps(payload, ensure_ascii=False))
            return response('目标不变；新增工作已完成，继续下一步', path)
        monkeypatch.setattr(dialogue.inference, 'api', api)
        messages = [context.memory_message('最初目标：建立文档索引'),
                    {'role': 'user', 'content': '新增工作'},
                    {'role': 'assistant', 'content': '新记录'*30000},
                    {'role': 'user', 'content': '下一步'}]
        output, _ = await context.compact(messages, 'key', 'model', '/v1/responses', summary_store=
                                         context.SummaryStore(pool, 'owner', 'conversation', 'pack', 'new'))
        assert '最初目标：建立文档索引' in ''.join(seen)
        assert '新增工作' in ''.join(seen)
        assert output[-1] == messages[-1]
        pool.rows['conversation']['body']['context_turns'] = 0
        pool.rows['conversation']['body']['context_summary'] = {'text': 'ignored', 'through_id': 'old'}
        assert await dialogue.recent_turns(pool, pool.rows['conversation']['body'], 'owner', 'conversation') == []
    asyncio.run(run())
