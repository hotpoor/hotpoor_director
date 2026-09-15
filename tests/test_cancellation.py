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
