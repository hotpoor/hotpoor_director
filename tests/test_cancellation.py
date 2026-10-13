import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from tornado.web import HTTPError

from backend.generation import CancelGenerationHandler, HistoryHandler


class Pool:
    def __init__(self, rows):
        self.rows = rows
        self.statements = []

    @asynccontextmanager
    async def connection(self):
        yield self

    async def scan(self, *args, **kwargs):
        return await self.execute(*args, **kwargs)

    async def execute(self, sql, args, **routing):
        self.statements.append((sql, args))
        return SimpleNamespace(fetchall=AsyncMock(return_value=self.rows), fetchone=AsyncMock(return_value=self.rows[0]))


def handler(status='queued'):
    row = dict(block_id='a'*32, createtime=1000, body=dict(kind='generation', owner_id='alice',
        project_id='b'*32, status=status, prompt_id='comfy-a', submitted_at=1000, outputs=[]))
    pool = Pool([row])
    return SimpleNamespace(owner='alice', projects=object(), jobs=pool, finish=Mock(),
        settings={'progress_tracker':SimpleNamespace(ensure=AsyncMock(), values={})}), row


@pytest.mark.parametrize('status', ['queued','running'])
def test_cancel_uses_owned_id_and_native_atomic_endpoint(status):
    h, row = handler(status)
    with patch('backend.generation.owned', AsyncMock(return_value=row)) as owned, patch('backend.generation.comfy', AsyncMock(return_value={'cancelled':True})) as comfy:
        asyncio.run(CancelGenerationHandler.post(h, row['block_id']))
        owned.assert_any_await(h.jobs, row['block_id'], 'alice', 'generation')
        comfy.assert_awaited_once_with('/api/jobs/comfy-a/cancel', {})
    sql, args = h.jobs.statements[0]
    assert 'body=body ||' in sql and "('queued','running')" in sql
    assert args[0].obj['status']=='stopping'


def test_other_owner_is_rejected_before_contacting_comfy():
    h, row = handler()
    with patch('backend.generation.owned', AsyncMock(side_effect=HTTPError(404))), patch('backend.generation.comfy', AsyncMock()) as comfy:
        with pytest.raises(HTTPError) as error:
            asyncio.run(CancelGenerationHandler.post(h, row['block_id']))
        assert error.value.status_code==404
        comfy.assert_not_awaited()


@pytest.mark.parametrize('status', ['completed','cancelled','failed','stopping'])
def test_terminal_and_repeated_stop_are_noops(status):
    h, row = handler(status)
    with patch('backend.generation.owned', AsyncMock(return_value=row)), patch('backend.generation.comfy', AsyncMock()) as comfy:
        asyncio.run(CancelGenerationHandler.post(h, row['block_id']))
        comfy.assert_not_awaited()
        assert not h.jobs.statements


def test_completion_race_does_not_overwrite_completed_result():
    h, row = handler()
    with patch('backend.generation.owned', AsyncMock(return_value=row)), patch('backend.generation.comfy', AsyncMock(return_value={'cancelled':False})):
        asyncio.run(CancelGenerationHandler.post(h, row['block_id']))
        assert not h.jobs.statements


@pytest.mark.parametrize('running,entry,expected', [
    (False,None,'cancelled'),
    (True,None,'stopping'),
    (False,{'status':{'status_str':'error','messages':[['execution_interrupted',{'timestamp':2000}]]}},'cancelled'),
    (False,{'status':{'completed':True,'messages':[]},'outputs':{'10':{'images':[{'filename':'result.png','type':'output'}]}}},'completed'),
])
def test_history_confirms_stop_and_keeps_completion(running, entry, expected):
    h, row = handler('stopping')
    row['body']['cancel_requested']=True
    async def comfy(path, data=None):
        if path=='/queue':
            return {'queue_running':[[0,'comfy-a']] if running else [], 'queue_pending':[]}
        return {'comfy-a':entry} if entry else {}
    with patch('backend.generation.owned', AsyncMock(return_value=row)), patch('backend.generation.comfy', comfy):
        asyncio.run(HistoryHandler.get(h, 'b'*32))
    assert h.finish.call_args.args[0]['history'][0]['body']['status']==expected
    for sql, _ in h.jobs.statements:
        if sql.startswith('UPDATE'):
            assert 'AND body=%s' in sql


def test_missing_history_recovers_saved_image_without_resubmitting():
    h, row = handler()
    row['body']['type'] = 'image'
    async def comfy(path, data=None):
        if path == '/queue': return {'queue_running': [], 'queue_pending': []}
        return {}
    response = SimpleNamespace(headers={'Content-Type': 'image/png', 'Content-Length': '1234'})
    with patch('backend.generation.owned', AsyncMock(return_value=row)), patch('backend.generation.comfy', comfy), patch('backend.generation.AsyncHTTPClient') as client:
        client.return_value.fetch = AsyncMock(return_value=response)
        asyncio.run(HistoryHandler.get(h, 'b'*32))
        request = client.return_value.fetch.call_args.args[0]
        assert request.method == 'HEAD'
        assert 'a'*32 + '_00001_.png' in request.url
    assert row['body']['status'] == 'completed'
    assert row['body']['recovered_from_output'] is True
    assert row['body']['outputs'][0]['subfolder'] == 'director'
    assert any(sql.startswith('UPDATE') and 'AND body=%s' in sql for sql, _ in h.jobs.statements)


@pytest.mark.parametrize('queue,cancelled', [(None,False), ({'queue_running':[[0,'comfy-a']]},False), ({'queue_pending':[[0,'comfy-a']]},False), ({},True)])
def test_missing_history_does_not_recover_active_or_cancelled_prompt(queue, cancelled):
    from backend.generation import recover_image_output
    body = {'type':'image', 'prompt_id':'comfy-a', 'cancel_requested':cancelled}
    with patch('backend.generation.AsyncHTTPClient') as client:
        assert asyncio.run(recover_image_output('a'*32, body, queue)) is None
        client.assert_not_called()


@pytest.mark.parametrize('response', [HTTPError(404), SimpleNamespace(headers={'Content-Type':'text/html','Content-Length':'12'}), SimpleNamespace(headers={'Content-Type':'image/png','Content-Length':'0'})])
def test_missing_history_requires_existing_nonempty_png(response):
    from backend.generation import recover_image_output
    from tornado.httpclient import HTTPClientError
    if isinstance(response, HTTPError): response = HTTPClientError(404)
    with patch('backend.generation.AsyncHTTPClient') as client:
        client.return_value.fetch = AsyncMock(side_effect=response) if isinstance(response, Exception) else AsyncMock(return_value=response)
        assert asyncio.run(recover_image_output('a'*32, {'type':'image'}, {})) is None
