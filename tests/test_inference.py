import asyncio
import base64
import copy
import json
from contextlib import asynccontextmanager
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from tornado.httpclient import HTTPClientError
from tornado.web import HTTPError

from backend.inference import (BY_ID, InferenceManager, InferenceSettingsHandler, InferenceTestHandler,
    ProviderError, api, load_key, payload_for, public_url, save_key, serve_output, submit)
from backend.generation import CancelGenerationHandler, OutputHandler

IMAGE='si:dola-seedream-5-0-pro-260628'
VIDEO='si:dreamina-seedance-2-0-260128-max'
KEY='fake-test-key-only'
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV3sAAAAASUVORK5CYII=')


@pytest.mark.parametrize('model',list(BY_ID.values()),ids=list(BY_ID))
def test_all_documented_models_send_remote_ids_without_local_sampler_parameters(model):
    payload=payload_for(model,'text',{'prompt':'a film scene','duration':5})
    assert payload['model']==model['remote_model']
    assert not {'seed','steps','width','height','denoise'} & payload.keys()
    if model['type']=='image':
        assert payload['response_format']=='b64_json'
    else:
        assert payload['content']==[{'type':'text','text':'a film scene'}]
        assert payload['ratio']=='16:9'


def test_seedance_order_and_first_last_frame_roles():
    d={'prompt':'@Image1 and @Video1','image_urls':'https://a.example/1.png\nhttps://a.example/2.png',
       'video_urls':'https://a.example/1.mp4','audio_urls':'https://a.example/1.wav'}
    content=payload_for(BY_ID[VIDEO],'reference',d)['content']
    assert [c.get('role') for c in content]==[None,'reference_image','reference_image','reference_video','reference_audio']
    assert content[1]['image_url']['url'].endswith('/1.png')
    content=payload_for(BY_ID[VIDEO],'image',dict(prompt='pan',first_frame='https://a.example/a.png',last_frame='https://a.example/z.png'))['content']
    assert [c.get('role') for c in content]==[None,'first_frame','last_frame']


@pytest.mark.parametrize('model,mode,data',[
    (IMAGE,'image',{'image_urls':''}),
    (IMAGE,'text',{'size':'4K'}),
    (IMAGE,'image',{'image_urls':'\n'.join(['https://a.example/a.png']*11)}),
    (VIDEO,'image',{'last_frame':'https://a.example/a.png'}),
    (VIDEO,'text',{'duration':4.5}),
    (VIDEO,'text',{'duration':True}),
    (VIDEO,'reference',{}),
    ('si:minimax-h3','text',{'ratio':'adaptive'}),
    ('si:minimax-h3','text',{'resolution':'720p'}),
])
def test_invalid_requests_rejected_before_billing(model,mode,data):
    with pytest.raises(ValueError):payload_for(BY_ID[model],mode,{'prompt':'scene',**data})


@pytest.mark.parametrize('url',['file:///tmp/image','data:image/png;base64,a','http://localhost/a','http://127.0.0.1/a',
    'http://192.168.100.100/a','http://[::1]/a','https://user:secret@site.example/a','https://site.example/a b'])
def test_reference_urls_reject_local_and_credential_addresses(url):
    with pytest.raises(ValueError):public_url(url)


class Pool:
    def __init__(self,rows=None):self.rows=rows or {};self.patches=[]
    @asynccontextmanager
    async def connection(self):yield self
    async def scan(self, *args, **kwargs):
        return await self.execute(*args, **kwargs)

    async def execute(self,sql,args=(), **routing):
        if sql.startswith('UPDATE'):
            delta,job=args;delta=delta.obj
            self.patches.append(copy.deepcopy(delta));self.rows[job]['body'].update(delta)
            return SimpleNamespace(fetchone=AsyncMock(return_value=self.rows[job]))
        if sql.startswith('INSERT'):
            job,body=args
            existing=job in self.rows
            if not existing:self.rows[job]={'block_id':job,'body':body.obj}
            return SimpleNamespace(fetchone=AsyncMock(return_value=None if existing else {'block_id':job}))
        active=[r for r in self.rows.values() if r['body']['status'] in ('running','queued','submitting')]
        return SimpleNamespace(fetchone=AsyncMock(return_value=active[0] if active else None),fetchall=AsyncMock(return_value=active))


def job(model=VIDEO,**fields):
    return dict(provider='service-inference',model=model,type=BY_ID[model]['type'],status='submitting',submitted_at=1,**fields)


def test_key_storage_permissions_and_no_key_in_settings_response(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY)
    assert load_key(config)==KEY
    if os.name!='nt':assert (tmp_path/'.service-inference.json').stat().st_mode & 0o777 == 0o600
    h=SimpleNamespace(settings={'config':config},finish=Mock())
    asyncio.run(InferenceSettingsHandler.get(h))
    view=h.finish.call_args.args[0]
    assert view['configured'] and view['active_key_id']=='legacy' and KEY not in str(view)


def test_key_test_uses_read_only_endpoint_without_saving(tmp_path):
    h=SimpleNamespace(settings={'config':{'data_dir':tmp_path}},data=lambda:{'api_key':KEY},finish=Mock())
    with patch('backend.inference.api',AsyncMock(return_value={'data':[]})) as request:
        asyncio.run(InferenceTestHandler.post(h));request.assert_awaited_once_with(KEY,'/v1/models')
    assert not (tmp_path/'.service-inference.json').exists()


def test_active_jobs_prevent_changing_key(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY)
    pool=Pool({'a':{'body':job()}})
    h=SimpleNamespace(settings={'config':config,'inference_manager':SimpleNamespace(lock=asyncio.Lock())},jobs=pool,
                      data=lambda:{'clear':True},finish=Mock())
    with pytest.raises(HTTPError) as error:asyncio.run(InferenceSettingsHandler.post(h))
    assert error.value.status_code==409 and load_key(config)==KEY


def test_errors_do_not_echo_provider_response_or_credentials():
    response=SimpleNamespace(body=('leaked '+KEY).encode())
    client=SimpleNamespace(fetch=AsyncMock(side_effect=HTTPClientError(401,response=response)))
    with patch('backend.inference.AsyncHTTPClient',return_value=client):
        with pytest.raises(ProviderError) as error:asyncio.run(api(KEY,'/v2/video/tasks'))
    assert KEY not in str(error.value) and error.value.code==401


def test_image_is_persisted_and_usage_reported_without_a_key(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY);body=job(IMAGE)
    pool=Pool({'a':{'body':body}});manager=InferenceManager(config,pool)
    response={'data':[{'b64_json':base64.b64encode(PNG).decode()}],'usage':{'generated_images':1,'output_tokens':4}}
    with patch('backend.inference.api',AsyncMock(return_value=response)) as request:
        asyncio.run(manager.run('a',body,{'prompt':'a'}))
    saved=pool.rows['a']['body'];assert saved['status']=='completed' and saved['usage']['tokens']==4
    assert (tmp_path/'generated'/saved['outputs'][0]['filename']).read_bytes()==PNG
    assert KEY not in str(saved);assert request.await_count==1


def test_video_tolerates_empty_status_and_read_failures_without_resubmission(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY);body=job();pool=Pool({'a':{'body':body}});manager=InferenceManager(config,pool)
    responses=[{'task':{'id':'mvt-1','status':'preparing'}},ProviderError('temporary'),{'task':{'status':''}},
               {'task':{'status':'completed','outputs':['https://cdn.example/video.mp4'],'usage':{'total_tokens':10}}}]
    async def fake_download(url,path):path.write_bytes(b'video-bytes')
    with patch('backend.inference.api',AsyncMock(side_effect=responses)) as request,patch('backend.inference.download',fake_download),patch('backend.inference.asyncio.sleep',AsyncMock()):
        asyncio.run(manager.run('a',body,{'content':[]}))
    assert sum(len(call.args)==3 for call in request.await_args_list)==1
    assert pool.rows['a']['body']['status']=='completed'
    assert pool.rows['a']['body']['remote_task_id']=='mvt-1'


def test_submission_timeout_is_never_retried(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY);body=job();pool=Pool({'a':{'body':body}});manager=InferenceManager(config,pool)
    with patch('backend.inference.api',AsyncMock(side_effect=ProviderError('submission unconfirmed'))) as request:
        asyncio.run(manager.run('a',body,{'content':[]}))
    assert request.await_count==1 and pool.rows['a']['body']['status']=='failed'


def test_start_resumes_only_known_remote_ids(tmp_path):
    pool=Pool({'a':{'block_id':'a','body':job(remote_task_id='mvt-1')},'b':{'block_id':'b','body':job()}})
    manager=InferenceManager({'data_dir':tmp_path},pool);manager.launch=Mock()
    asyncio.run(manager.start())
    assert manager.launch.call_count==1 and manager.launch.call_args.args[0]=='a'
    assert pool.rows['b']['body']['status']=='failed'


def test_submit_is_idempotent_and_does_not_persist_arbitrary_secret_fields(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY);pool=Pool();manager=SimpleNamespace(lock=asyncio.Lock(),launch=Mock())
    h=SimpleNamespace(projects=None,jobs=pool,owner='owner',settings={'config':config,'inference_manager':manager},finish=Mock())
    data={'request_id':'a'*32,'card_id':'b'*32,'model':IMAGE,'mode':'text','prompt':'image','api_key':KEY}
    async def fetch(pool_arg,uid,owner,kind):
        if kind=='project':return {'body':{'canvas':{'cards':[{'id':'b'*32,'type':'image'}]}}}
        return pool.rows[uid]
    async def run():
        with patch('backend.inference.owned',fetch),patch('backend.inference.discover_models',AsyncMock(return_value=[{'id':BY_ID[IMAGE]['remote_model'],'type':'image'}])):await submit(h,'p',data);await submit(h,'p',data)
    asyncio.run(run());assert manager.launch.call_count==1
    assert KEY not in str(pool.rows)


def test_cloud_cancel_never_calls_comfy():
    h=SimpleNamespace(jobs=None,owner='owner',finish=Mock())
    with patch('backend.generation.owned',AsyncMock(return_value={'body':job()})),patch('backend.generation.comfy_at',AsyncMock()) as comfy:
        with pytest.raises(HTTPError) as error:asyncio.run(CancelGenerationHandler.post(h,'id'))
    assert error.value.status_code==409;comfy.assert_not_awaited()


def test_private_output_handler_checks_owner_before_reading_files():
    h=SimpleNamespace(jobs=None,owner='another-user')
    with patch('backend.generation.owned',AsyncMock(side_effect=HTTPError(404))),patch('backend.inference.serve_output',AsyncMock()) as serve:
        with pytest.raises(HTTPError):asyncio.run(OutputHandler.get(h,'a'*32,'0'))
    serve.assert_not_awaited()


@pytest.mark.parametrize('range_header,expected',[('bytes=2-5',b'2345'),('bytes=-3',b'789'),('bytes=5-',b'56789')])
def test_saved_video_supports_seek_ranges(tmp_path,range_header,expected):
    name='a'*32+'-0.mp4';(tmp_path/'generated').mkdir();(tmp_path/'generated'/name).write_bytes(b'0123456789')
    h=SimpleNamespace(settings={'config':{'data_dir':tmp_path}},request=SimpleNamespace(headers={'Range':range_header}),
                      set_header=Mock(),set_status=Mock(),write=Mock(),flush=AsyncMock(),finish=Mock())
    asyncio.run(serve_output(h,{'filename':name,'mime':'video/mp4'}))
    assert b''.join(call.args[0] for call in h.write.call_args_list)==expected
    h.set_status.assert_called_with(206)


def test_seedream_modes_and_group_parameters():
    lite=BY_ID['si:seedream-5-0-lite-260128'];pro=BY_ID[IMAGE]
    assert 'edit' in pro['modes'] and 'series' not in pro['modes']
    assert 'series' in lite['modes'] and 'edit' not in lite['modes']
    payload=payload_for(lite,'series',dict(prompt='三个关联镜头',max_images=3,watermark=False,output_format='png'))
    assert payload['sequential_image_generation']=='auto' and payload['sequential_image_generation_options']=={'max_images':3}
    assert payload['watermark'] is False and payload['output_format']=='png'
    assert 'optimize_prompt_options' not in payload and 'stream' not in payload
    payload=payload_for(pro,'edit',dict(prompt='修改 <bbox>1 2 3 4</bbox> 内的颜色',image_urls='https://cdn.example/a.png',optimize_mode='fast'))
    assert payload['optimize_prompt_options']=={'mode':'fast'} and 'sequential_image_generation' not in payload
    assert payload_for(pro,'reference',dict(prompt='融合图1图2',image_urls='https://cdn.example/a.png\nhttps://cdn.example/b.png'))['image']==['https://cdn.example/a.png','https://cdn.example/b.png']


@pytest.mark.parametrize('model,mode,extra',[
    (IMAGE,'series',{}),('si:seedream-5-0-lite-260128','edit',{}),
    (IMAGE,'reference',{'image_urls':'https://cdn.example/a.png'}),
    ('si:seedream-5-0-lite-260128','series',{'max_images':15,'image_urls':'https://cdn.example/a.png'}),
    ('si:seedream-5-0-lite-260128','series',{'max_images':True}),
    ('si:seedream-4-5-251128','text',{'output_format':'png'}),
    ('si:seedream-5-0-lite-260128','text',{'optimize_mode':'fast'}),
])
def test_seedream_rejects_unsupported_capabilities(model,mode,extra):
    with pytest.raises(ValueError):payload_for(BY_ID[model],mode,{'prompt':'scene',**extra})


@pytest.mark.parametrize('family',['doubao','dreamina'])
def test_seedance_25_thirty_second_limit(family):
    model=BY_ID[f'si:{family}-seedance-2-5-260628-max']
    for mode,data in [('text',{}),('image',{'first_frame':'https://cdn.example/a.png'}),('reference',{'image_urls':'https://cdn.example/a.png'})]:
        assert payload_for(model,mode,dict(prompt='长镜头',duration=30,**data))['duration']==30
    for duration in (31,30.5,True):
        with pytest.raises(ValueError):payload_for(model,'text',dict(prompt='scene',duration=duration))
    old=BY_ID[f'si:{family}-seedance-2-0-260128-max']
    with pytest.raises(ValueError):payload_for(old,'text',dict(prompt='scene',duration=30))


def test_multi_keys_migrate_switch_and_keep_job_key(tmp_path):
    from backend.inference import load_keys,save_keys,key_profile
    config={'data_dir':tmp_path};(tmp_path/'.service-inference.json').write_text(json.dumps({'api_key':KEY}))
    assert load_keys(config)['keys'][0]['id']=='legacy'
    save_keys(config,{'active_key_id':'other','keys':[{'id':'legacy','name':'First','api_key':KEY,'models':[]},{'id':'other','name':'Second','api_key':'another-fake-key','models':[]}]})
    pool=Pool({'job':{'body':job(IMAGE,credential_id='legacy')}})
    manager=InferenceManager(config,pool)
    with patch('backend.inference.api',AsyncMock(return_value={'data':[{'b64_json':base64.b64encode(PNG).decode(),'output_format':'png'}]})) as request:
        asyncio.run(manager.run('job',pool.rows['job']['body'],{'prompt':'test'}))
        assert request.call_args.args[0]==KEY
    assert load_key(config)=='another-fake-key'


def test_key_selection_refresh_and_failed_selection_preserve_config(tmp_path):
    from backend.inference import load_keys,save_keys
    config={'data_dir':tmp_path}
    save_keys(config,{'active_key_id':'first','keys':[{'id':'first','name':'One','api_key':KEY,'models':[]},{'id':'second','name':'Two','api_key':'second-fake-key','models':[]}]})
    h=SimpleNamespace(settings={'config':config,'inference_manager':SimpleNamespace(lock=asyncio.Lock())},jobs=Pool({'busy':{'body':job(credential_id='first')}}),data=lambda:{'action':'select','id':'second'},finish=Mock())
    with patch('backend.inference.discover_models',AsyncMock(return_value=[{'id':BY_ID[VIDEO]['remote_model'],'type':'video'}])):
        asyncio.run(InferenceSettingsHandler.post(h))
    assert load_keys(config)['active_key_id']=='second' and KEY not in str(h.finish.call_args)
    h.data=lambda:{'action':'select','id':'first'}
    with patch('backend.inference.discover_models',AsyncMock(side_effect=ProviderError('unavailable'))),pytest.raises(HTTPError):asyncio.run(InferenceSettingsHandler.post(h))
    assert load_keys(config)['active_key_id']=='second'


def test_add_key_does_not_replace_existing_and_filters_model_access(tmp_path):
    from backend.inference import load_keys,model_access
    config={'data_dir':tmp_path};save_key(config,KEY)
    manager=SimpleNamespace(lock=asyncio.Lock())
    h=SimpleNamespace(settings={'config':config,'inference_manager':manager},jobs=Pool(),data=lambda:{'id':'','name':'Video account','api_key':'new-fake-key-123'},finish=Mock())
    with patch('backend.inference.discover_models',AsyncMock(return_value=[{'id':BY_ID[VIDEO]['remote_model'],'type':'video'}])):
        asyncio.run(InferenceSettingsHandler.post(h))
    value=load_keys(config)
    assert len(value['keys'])==2 and load_key(config,'legacy')==KEY
    assert asyncio.run(model_access(config,manager))[0]=={BY_ID[VIDEO]['remote_model']}
    assert all('api_key' not in p for p in h.finish.call_args.args[0]['keys'])


def test_unlisted_model_rejected_before_paid_submission(tmp_path):
    from backend.inference import save_keys
    config={'data_dir':tmp_path};save_keys(config,{'active_key_id':'a','keys':[{'id':'a','name':'No image access','api_key':KEY,'models':[]}]})
    manager=SimpleNamespace(lock=asyncio.Lock(),launch=Mock())
    h=SimpleNamespace(settings={'config':config,'inference_manager':manager},projects=None,jobs=Pool(),owner='owner',finish=Mock())
    project={'body':{'canvas':{'cards':[{'id':'b'*32,'type':'image'}]}}}
    with patch('backend.inference.owned',AsyncMock(return_value=project)),pytest.raises(HTTPError) as error:
        asyncio.run(submit(h,'p',{'model':IMAGE,'mode':'text','prompt':'scene','card_id':'b'*32,'request_id':'a'*32}))
    assert error.value.status_code==403;manager.launch.assert_not_called()


def test_preparation_progress_is_returned_incrementally_and_sanitized(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY)
    body=job(remote_task_id='known');pool=Pool({'a':{'body':body}});manager=InferenceManager(config,pool)
    responses=[{'task':{'status':'preparing','progress':{'completed':n,'total':5,'stage':'validating','secret':KEY}}} for n in (1,3,5)]
    responses.append({'task':{'status':'completed','outputs':['https://cdn.example/out.mp4']}})
    async def downloaded(url,path):path.write_bytes(b'video')
    with patch('backend.inference.api',AsyncMock(side_effect=responses)) as request, patch('backend.inference.download',downloaded), patch('backend.inference.asyncio.sleep',AsyncMock()):
        asyncio.run(manager.run('a',body,None))
    stages=[p['progress']['value'] for p in pool.patches if p.get('progress',{}).get('phase')=='remote']
    assert stages==[1,3,5]
    assert KEY not in str(pool.patches)
    assert all(len(call.args)==2 for call in request.await_args_list)


def test_cloud_submission_pins_profile_without_credentials(tmp_path):
    from backend import cloud_storage as storage
    from test_cloud_storage import profile
    config={'data_dir':tmp_path};save_key(config,KEY)
    p=profile();storage.save(config,{'active_profile_id':'selected','profiles':{'selected':p}})
    pool=Pool();manager=SimpleNamespace(lock=asyncio.Lock(),launch=Mock())
    h=SimpleNamespace(projects=None,jobs=pool,owner='owner',settings={'config':config,'inference_manager':manager},finish=Mock())
    async def fetch(pool_arg,uid,owner,kind):
        if kind=='project':return {'body':{'canvas':{'cards':[{'id':'b'*32,'type':'video'}]}}}
        return pool.rows[uid]
    with patch('backend.inference.owned',fetch),patch('backend.inference.discover_models',AsyncMock(return_value=[{'id':BY_ID[VIDEO]['remote_model']}])):
        asyncio.run(submit(h,'c'*32,{'request_id':'a'*32,'card_id':'b'*32,'model':VIDEO,'mode':'text','prompt':'film','output_storage':'cloud'}))
    saved=pool.rows['a'*32]['body']
    assert saved['output_storage']=='cloud' and saved['storage_profile_id']=='selected'
    assert saved['storage_profile_fingerprint']==storage.fingerprint(p)
    assert p['access_key_secret'] not in str(saved)


@pytest.mark.parametrize('cloud_mode',[False,True])
def test_cloud_storage_outputs_never_fall_back_to_disk(tmp_path,cloud_mode):
    body=job(IMAGE,output_storage='cloud',storage_profile_id='p',storage_profile_fingerprint='fingerprint')
    pool=Pool({'a':{'body':body}});manager=InferenceManager({'data_dir':tmp_path,'cloud_mode':cloud_mode},pool)
    async def store(config,pool,job,raw,mime,name,phase):
        assert raw==PNG
        await phase('uploading_output',bytes=len(raw),total_bytes=len(raw))
        await phase('verifying_output')
        return {'url':'https://cdn.example/saved.png','sha256':'digest'}
    with patch('backend.cloud_storage.store_generated',store):
        asyncio.run(manager.complete('a',body,[{'b64_json':base64.b64encode(PNG).decode()}],{}))
    assert pool.rows['a']['body']['outputs'][0]['remote_url']=='https://cdn.example/saved.png'
    assert not (tmp_path/'generated').exists()
    assert [p['remote_status'] for p in pool.patches if 'remote_status' in p]==['reading_output','uploading_output','verifying_output']


def test_transfer_failure_retries_save_without_resubmitting_generation(tmp_path):
    config={'data_dir':tmp_path};save_key(config,KEY)
    body=job(output_storage='cloud',storage_profile_id='p',remote_task_id='known')
    pool=Pool({'a':{'body':body}});manager=InferenceManager(config,pool)
    from backend.cloud_storage import StorageError
    with patch('backend.inference.api',AsyncMock(return_value={'task':{'status':'completed','outputs':['https://cdn.example/out.mp4']}})) as request, \
         patch('backend.inference.download_memory',AsyncMock(return_value=b'video')), \
         patch('backend.cloud_storage.fetch_generated_video',AsyncMock(return_value=None)), \
         patch('backend.cloud_storage.store_generated',AsyncMock(side_effect=[StorageError('verification failed'),{'url':'https://cdn.example/saved.mp4','sha256':'digest'}])), \
         patch('backend.inference.asyncio.sleep',AsyncMock()):
        asyncio.run(manager.run('a',body,None))
    assert pool.rows['a']['body']['status']=='completed'
    assert request.await_count==1 and all(len(c.args)==2 for c in request.await_args_list)
    assert not (tmp_path/'generated').exists()


@pytest.mark.parametrize('selected,expected', [('second','second'), ('missing',None), ('first',None)])
def test_card_submission_uses_selected_ak_without_default_fallback(tmp_path,selected,expected):
    from backend.inference import save_keys
    config={'data_dir':tmp_path}
    save_keys(config,{'active_key_id':'first','enabled_key_ids':['second'],'keys':[{'id':key,'name':key,'api_key':KEY+key,'models':[{'id':BY_ID[IMAGE]['remote_model']}]} for key in ('first','second')]})
    pool=Pool();manager=SimpleNamespace(lock=asyncio.Lock(),launch=Mock())
    h=SimpleNamespace(projects=None,jobs=pool,owner='owner',settings={'config':config,'inference_manager':manager},finish=Mock())
    async def fetch(pool_arg,uid,owner,kind):
        if kind=='project':return {'body':{'canvas':{'cards':[{'id':'b'*32,'type':'image'}]}}}
        return pool.rows[uid]
    data={'request_id':'a'*32,'card_id':'b'*32,'model':IMAGE,'mode':'text','prompt':'image','credential_id':selected}
    with patch('backend.inference.owned',fetch):
        if expected:asyncio.run(submit(h,'p',data))
        else:
            with pytest.raises(HTTPError):asyncio.run(submit(h,'p',data))
    if expected:assert pool.rows['a'*32]['body']['credential_id']==expected
    else:manager.launch.assert_not_called()
