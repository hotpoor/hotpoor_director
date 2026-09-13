import heapq
import asyncio
from contextlib import asynccontextmanager
import importlib.util
from pathlib import Path
import threading
from types import SimpleNamespace
from unittest.mock import Mock, AsyncMock, patch

import pytest
from tornado.web import HTTPError
from backend.generation import QueueOrderHandler

spec = importlib.util.spec_from_file_location('director_ordering', Path(__file__).resolve().parents[1] / 'comfy_extensions/director_queue/ordering.py')
ordering = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ordering)


def queue():
    return SimpleNamespace(mutex=threading.RLock(), queue=[(1,'mine-a',{'seed':1}),
        (2,'other-user',{'seed':2}), (3,'mine-b',{'seed':3}), (4,'other-project',{'seed':4})],
        currently_running={'active':(0,'running',{})}, server=SimpleNamespace(queue_updated=Mock()))


def test_swap_preserves_other_slots_and_prompt_contents():
    q=queue()
    ordering.reorder_pending(q, ['mine-a','other-user','mine-b','other-project'], ['mine-b','mine-a'])
    items=[heapq.heappop(q.queue) for _ in range(4)]
    assert items==[(1,'mine-b',{'seed':3}),(2,'other-user',{'seed':2}),
                   (3,'mine-a',{'seed':1}),(4,'other-project',{'seed':4})]
    assert q.currently_running=={'active':(0,'running',{})}


@pytest.mark.parametrize('expected,order', [
    (['mine-a','mine-b'],['mine-b','mine-a']),
    (['mine-a','other-user','mine-b','other-project'],['running']),
    (['mine-a','other-user','mine-b','other-project'],['mine-a','mine-a']),
])
def test_stale_or_invalid_order_leaves_queue_unchanged(expected,order):
    q=queue();before=list(q.queue)
    with pytest.raises(ValueError):
        ordering.reorder_pending(q,expected,order)
    assert q.queue==before
    q.server.queue_updated.assert_not_called()


@pytest.mark.parametrize('foreign,stale',[(True,False),(False,True),(False,False)])
def test_api_ownership_and_snapshot_validation(foreign,stale):
    a,b='a'*32,'b'*32
    rows=[{'block_id':a,'body':{'prompt_id':'p-a'}},{'block_id':b,'body':{'prompt_id':'p-b'}}]
    @asynccontextmanager
    async def connection():
        yield SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(fetchall=AsyncMock(return_value=rows))))
    payload={'order':['c'*32,a] if foreign else [b,a],'previous':[b,a] if stale else [a,b]}
    h=SimpleNamespace(owner='alice',projects=object(),jobs=SimpleNamespace(connection=connection),data=lambda:payload,finish=Mock(),settings={})
    async def remote(path,data=None):
        if path=='/queue':
            return {'queue_pending':[(1,'p-a'),(2,'someone-else'),(3,'p-b')]}
        assert data=={'expected':['p-a','someone-else','p-b'],'order':['p-b','p-a']}
        return {'reordered':True}
    with patch('backend.generation.owned',AsyncMock()) as owned,patch('backend.generation.comfy',AsyncMock(side_effect=remote)) as comfy:
        if foreign or stale:
            with pytest.raises(HTTPError) as error:
                asyncio.run(QueueOrderHandler.post(h,'project'))
            assert error.value.status_code==(404 if foreign else 409)
            assert all(call.args[0]!='/director/queue-order' for call in comfy.await_args_list)
        else:
            asyncio.run(QueueOrderHandler.post(h,'project'))
            assert h.finish.call_args.args[0]=={'reordered':True}
        owned.assert_awaited_once_with(h.projects,'project','alice','project')
