import asyncio
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from tornado.web import HTTPError

from backend import management
from backend.inference import InferenceSettingsHandler, ProviderError, load_keys, save_keys, save_key, valid_key
from test_inference import Pool, KEY

MGMT = 'sk-mgmt-v1-test-management-only-123456'
OTHER = 'sk-mgmt-v1-other-management-only-12345'


def handler(tmp_path, data):
    h=SimpleNamespace(settings={'config': {'data_dir': tmp_path}, 'inference_manager': SimpleNamespace(lock=asyncio.Lock())},
                           data=lambda: data, finish=Mock(), jobs=Pool())
    h.report_profile=lambda profile,suffix: management.ManagementReportHandler.report_profile(h,profile,suffix)
    return h


def add(h, key=MGMT, name='Main'):
    h.data=lambda: {'api_key': key, 'name': name}
    with patch('backend.management.api', AsyncMock(return_value={'organizationId': 'org-main'})) as api:
        asyncio.run(management.ManagementSettingsHandler.post(h))
    api.assert_awaited_once_with(key, '/manage/whoami')
    return h.finish.call_args.args[0]['active_key_id']


def test_multiple_management_keys_are_independent_from_generation_and_redacted(tmp_path):
    config = {'data_dir': tmp_path}; save_key(config, KEY)
    original = (tmp_path/'.service-inference.json').read_bytes()
    h=handler(tmp_path, {})
    first=add(h); second=add(h, OTHER, 'Other')
    h.data=lambda: {'action': 'select', 'id': first}
    with patch('backend.management.api', AsyncMock(return_value={'organizationId': 'org-main'})):
        asyncio.run(management.ManagementSettingsHandler.post(h))
    value=management.load(config)
    assert value['active_key_id']==first and len(value['keys'])==2 and first!=second
    assert (tmp_path/'.service-inference.json').read_bytes()==original
    assert MGMT not in str(h.finish.call_args) and OTHER not in str(h.finish.call_args)
    if os.name!='nt': assert (tmp_path/management.FILE).stat().st_mode & 0o777 == 0o600


def test_failed_update_and_test_do_not_save_keys(tmp_path):
    h=handler(tmp_path, {'api_key': MGMT})
    with patch('backend.management.api', AsyncMock(return_value={'organizationId': 'org-main'})):
        asyncio.run(management.ManagementTestHandler.post(h))
    assert not (tmp_path/management.FILE).exists()
    first=add(h); original=(tmp_path/management.FILE).read_bytes()
    h.data=lambda: {'id': first, 'name': 'replacement', 'api_key': OTHER}
    with patch('backend.management.api', AsyncMock(side_effect=ProviderError('invalid', 401))),pytest.raises(HTTPError):
        asyncio.run(management.ManagementSettingsHandler.post(h))
    assert (tmp_path/management.FILE).read_bytes()==original


def test_binding_persists_and_blocks_deleting_bound_management_key(tmp_path):
    h=handler(tmp_path, {}); first=add(h)
    h.data=lambda: {'api_key': KEY, 'name': 'Generator', 'management_key_id': first}
    with patch('backend.inference.discover_models', AsyncMock(return_value=[])):
        asyncio.run(InferenceSettingsHandler.post(h))
    generation=load_keys(h.settings['config'])['keys'][0]
    assert generation['management_key_id']==first
    assert h.finish.call_args.args[0]['keys'][0]['management_key_id']==first
    h.data=lambda: {'action': 'delete', 'id': first}
    with pytest.raises(HTTPError) as error:asyncio.run(management.ManagementSettingsHandler.post(h))
    assert error.value.status_code==409


def test_bound_report_uses_bound_key_despite_switching_active_management(tmp_path):
    h=handler(tmp_path, {}); first=add(h); add(h, OTHER)
    save_keys(h.settings['config'], {'active_key_id': 'gen', 'keys': [{'id': 'gen', 'name': 'Generator', 'api_key': KEY, 'management_key_id': first}]})
    args={'generation_key_id': 'gen', 'from': '2026-09-01', 'to': '2026-09-17'}
    h.get_argument=lambda name,default='': args.get(name, default)
    async def response(key, path):
        assert key==MGMT and path.endswith('?from=2026-09-01&to=2026-09-17')
        if '/summary' in path:return {'totalCostUsd': 1.25, 'from': args['from'], 'to': args['to'], 'unpricedCount': 1}
        if '/breakdown' in path:return {'breakdown': [{'model': 'video-model', 'totalCostUsd': 1.25}]}
        return {'rows': [{'apiKeyId': 'inference-key-id', 'totalCostUsd': 1.25}], 'approximate': True}
    with patch('backend.management.api', response):asyncio.run(management.ManagementReportHandler.get(h))
    result=h.finish.call_args.args[0]
    assert result['key_id']==first and result['total_cost_usd']=='1.25' and result['by_key_approximate']
    assert MGMT not in str(result) and KEY not in str(result)


def test_missing_binding_never_falls_back_to_active_management(tmp_path):
    h=handler(tmp_path, {}); add(h)
    save_keys(h.settings['config'], {'active_key_id': 'gen', 'keys': [{'id': 'gen', 'api_key': KEY}]})
    h.get_argument=lambda name,default='': 'gen' if name=='generation_key_id' else default
    with patch('backend.management.api', AsyncMock()) as api,pytest.raises(HTTPError):asyncio.run(management.ManagementReportHandler.get(h))
    api.assert_not_awaited()


def test_key_types_cannot_be_swapped():
    with pytest.raises(HTTPError):valid_key(MGMT)
    with pytest.raises(HTTPError):management.valid_key(KEY)


def test_unknown_binding_is_rejected_without_saving_generation(tmp_path):
    h=handler(tmp_path, {'api_key': KEY, 'management_key_id': 'missing'})
    with patch('backend.inference.discover_models', AsyncMock()) as discover,pytest.raises(HTTPError):asyncio.run(InferenceSettingsHandler.post(h))
    discover.assert_not_awaited()
    assert not (tmp_path/'.service-inference.json').exists()


def test_report_defaults_to_all_history(tmp_path):
    h=handler(tmp_path, {}); add(h)
    h.get_argument=lambda name,default='': default
    async def response(key,path):
        from datetime import datetime, timezone
        assert path.endswith('?from=1970-01-01&to='+datetime.now(timezone.utc).date().isoformat())
        if '/summary' in path:return {'totalCostUsd': 0}
        if '/breakdown' in path:return {'breakdown': []}
        return {'rows': []}
    with patch('backend.management.api',response):asyncio.run(management.ManagementReportHandler.get(h))
    assert h.finish.call_args.args[0]['total_cost_usd']=='0'


def test_multiple_generation_keys_enable_independently(tmp_path):
    h=handler(tmp_path,{})
    save_keys(h.settings['config'],{'active_key_id':'first','keys':[{'id':x,'name':x,'api_key':KEY+x,'models':[]} for x in ('first','second')]})
    h.data=lambda:{'action':'enable','id':'second','enabled':True}
    with patch('backend.inference.discover_models',AsyncMock(return_value=[])):
        asyncio.run(InferenceSettingsHandler.post(h))
    assert set(load_keys(h.settings['config'])['enabled_key_ids'])=={'first','second'}
    h.data=lambda:{'action':'enable','id':'first','enabled':False}
    asyncio.run(InferenceSettingsHandler.post(h))
    value=load_keys(h.settings['config'])
    assert value['enabled_key_ids']==['second'] and value['active_key_id']=='second'
    assert len(value['keys'])==2


def test_management_multi_enable_and_report_deduplicates_organization(tmp_path):
    h=handler(tmp_path,{});first=add(h);second=add(h,OTHER)
    h.data=lambda:{'action':'enable','id':first,'enabled':False}
    asyncio.run(management.ManagementSettingsHandler.post(h))
    assert management.load(h.settings['config'])['enabled_key_ids']==[second]
    h.data=lambda:{'action':'enable','id':first,'enabled':True}
    with patch('backend.management.api',AsyncMock(return_value={'organizationId':'org-main'})):
        asyncio.run(management.ManagementSettingsHandler.post(h))
    assert set(management.load(h.settings['config'])['enabled_key_ids'])=={first,second}
    h.get_argument=lambda name,default='':default
    async def response(key,path):
        if '/summary' in path:return {'totalCostUsd':1.25}
        if '/breakdown' in path:return {'breakdown':[]}
        return {'rows':[]}
    with patch('backend.management.api',side_effect=response) as api:
        asyncio.run(management.ManagementReportHandler.get(h))
    result=h.finish.call_args.args[0]
    assert result['organization_count']==1 and result['total_cost_usd']=='1.25'
    assert api.await_count==3


def test_management_report_sums_distinct_organizations(tmp_path):
    h=handler(tmp_path,{});add(h);second=add(h,OTHER)
    value=management.load(h.settings['config']);next(p for p in value['keys'] if p['id']==second)['organization_id']='org-other'
    save_keys(h.settings['config'],value,management.FILE)
    h.get_argument=lambda name,default='':default
    async def response(key,path):
        if '/summary' in path:return {'totalCostUsd':1.25 if key==MGMT else 2}
        if '/breakdown' in path:return {'breakdown':[]}
        return {'rows':[]}
    with patch('backend.management.api',side_effect=response) as api:
        asyncio.run(management.ManagementReportHandler.get(h))
    result=h.finish.call_args.args[0]
    assert result['organization_count']==2 and result['total_cost_usd']=='3.25'
    assert len(result['reports'])==2 and api.await_count==6
