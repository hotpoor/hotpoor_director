import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from tornado.httpclient import HTTPClientError
from tornado.web import HTTPError

from backend.comfy_settings import (ComfySettingsHandler, ComfyTestHandler, DEFAULT,
    connection_url, load_connection, save_connection, validate_connection)
from backend.generation import comfy_at, OutputHandler
from backend.progress import ProgressTracker


@pytest.mark.parametrize('data', [
    {'host':'http://localhost','port':8188}, {'host':'host/path','port':8188},
    {'host':'user@host','port':8188}, {'host':'a..b','port':8188},
    {'host':'localhost','port':0}, {'host':'localhost','port':65536},
    {'host':'localhost','port':8188.5}, {'host':'localhost','port':True},
])
def test_reject_invalid_connection(data):
    with pytest.raises(ValueError):
        validate_connection(data)


def test_connection_persists_without_touching_account_config(tmp_path):
    config={'data_dir':tmp_path}
    (tmp_path/'config.json').write_text('private-account-config')
    assert load_connection(config)==DEFAULT
    for host in ['localhost','192.168.1.10','::1']:
        connection=validate_connection({'host':host,'port':9000})
        save_connection(config,connection)
        assert load_connection(config)==connection
    assert connection_url(connection)=='http://[::1]:9000'
    assert (tmp_path/'config.json').read_text()=='private-account-config'


class Pool:
    def __init__(self, active=False):
        self.active=active

    @asynccontextmanager
    async def connection(self):
        yield self

    async def execute(self, sql):
        return SimpleNamespace(fetchone=AsyncMock(return_value={'active':1} if self.active else None))


def handler(tmp_path, active=False):
    return SimpleNamespace(settings={'comfy_connection':dict(DEFAULT),'comfy_lock':asyncio.Lock(),
        'config':{'data_dir':tmp_path},'progress_tracker':SimpleNamespace(close=AsyncMock(),base_url='old')},
        jobs=Pool(active), data=lambda:{'host':'localhost','port':9000},finish=Mock())


def test_busy_generation_blocks_switch(tmp_path):
    h=handler(tmp_path,True)
    with patch('backend.comfy_settings.probe',AsyncMock()) as probe:
        with pytest.raises(HTTPError) as error:
            asyncio.run(ComfySettingsHandler.post(h))
        assert error.value.status_code==409
        probe.assert_not_awaited()
    assert h.settings['comfy_connection']==DEFAULT


def test_failed_connection_keeps_existing_settings(tmp_path):
    h=handler(tmp_path)
    with patch('backend.comfy_settings.probe',AsyncMock(side_effect=HTTPClientError(599))):
        with pytest.raises(HTTPError):asyncio.run(ComfySettingsHandler.post(h))
    assert h.settings['comfy_connection']==DEFAULT
    assert not (tmp_path/'.comfyui.json').exists()


def test_save_updates_http_and_websocket_after_successful_probe(tmp_path):
    h=handler(tmp_path)
    with patch('backend.comfy_settings.probe',AsyncMock(return_value='test')):
        asyncio.run(ComfySettingsHandler.post(h))
    assert h.settings['comfy_connection']==h.data()
    assert h.settings['progress_tracker'].base_url=='http://localhost:9000'
    h.settings['progress_tracker'].close.assert_awaited_once()
    assert load_connection(h.settings['config'])==h.data()


def test_probe_does_not_save(tmp_path):
    h=handler(tmp_path)
    with patch('backend.comfy_settings.probe',AsyncMock(return_value='test')):
        asyncio.run(ComfyTestHandler.post(h))
    assert h.settings['comfy_connection']==DEFAULT
    assert not (tmp_path/'.comfyui.json').exists()


def test_custom_endpoint_is_used_for_http_requests():
    with patch('backend.generation.comfy',AsyncMock()) as request:
        asyncio.run(comfy_at('http://localhost:9000','/queue'))
        request.assert_awaited_once_with('/queue',None,base_url='http://localhost:9000')


def test_custom_websocket_endpoint():
    async def run():
        tracker=ProgressTracker('http://localhost:9000')
        connection=SimpleNamespace(close=Mock(),read_message=AsyncMock(return_value=None))
        with patch('backend.progress.websocket_connect',AsyncMock(return_value=connection)) as connect:
            await tracker.ensure('alice')
            assert connect.call_args.args[0]=='ws://localhost:9000/ws?clientId=director-alice'
            await tracker.close()
    asyncio.run(run())


@pytest.mark.parametrize('saved_url',['http://localhost:9000',None])
def test_history_output_keeps_original_server(saved_url):
    body={'outputs':[{'filename':'frame.png','subfolder':'','type':'output'}]}
    if saved_url:body['comfy_url']=saved_url
    h=SimpleNamespace(jobs=None,owner='alice',settings={'comfy_connection':{'host':'new-server','port':8000}},
        request=SimpleNamespace(headers={}),set_status=Mock(),set_header=Mock(),finish=Mock())
    response=SimpleNamespace(code=200,headers={'Content-Type':'image/png'},body=b'image')
    with patch('backend.generation.owned',AsyncMock(return_value={'body':body})), patch('backend.generation.AsyncHTTPClient') as client:
        client.return_value.fetch=AsyncMock(return_value=response)
        asyncio.run(OutputHandler.get(h,'a'*32,'0'))
        assert client.return_value.fetch.call_args.args[0].url.startswith((saved_url or 'http://127.0.0.1:8188')+'/view?')
