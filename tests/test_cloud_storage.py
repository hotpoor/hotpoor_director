import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import Mock, AsyncMock, patch
from urllib.parse import urlsplit,parse_qs,unquote
import pytest
from tornado.web import HTTPError
from backend import cloud_storage as s


def profile(provider='qiniu'):
    return s.normalize(dict(provider=provider,access_key_id='fake-access-id',access_key_secret='fake-secret-value',bucket_name='fixture-1250000000',region={'qiniu':'z0','aliyun':'cn-hangzhou','tencent':'ap-guangzhou'}[provider],domain='https://cdn.example.com'))


@pytest.mark.parametrize('provider',s.PROVIDERS)
def test_scoped_real_sdk_signatures(provider):
    p=profile(provider);grant=s.sign_upload(p,'director/references/owner/file.png','image/png',16)
    assert p['access_key_secret'] not in json.dumps(grant)
    assert grant['url'].startswith('https://')
    if provider=='qiniu':
        policy=json.loads(base64.urlsafe_b64decode(grant['fields']['token'].split(':')[-1]))
        assert policy['scope']==p['bucket_name']+':director/references/owner/file.png'
        assert policy['insertOnly']==1 and policy['fsizeLimit']==16 and policy['mimeLimit']=='image/png'
    else:
        assert grant['method']=='PUT' and grant['headers']=={'Content-Type':'image/png'}
        assert urlsplit(grant['url']).hostname.startswith(p['bucket_name']+'.')
        assert unquote(urlsplit(grant['url']).path).endswith('/director/references/owner/file.png')
        query=parse_qs(urlsplit(grant['url']).query)
        assert ('x-oss-signature' if provider=='aliyun' else 'q-signature') in query


def test_separate_profiles_permissions_and_no_disclosure(tmp_path):
    config={'data_dir':tmp_path};value={'active_provider':'qiniu','profiles':{p:profile(p) for p in s.PROVIDERS}}
    s.save(config,value);assert s.load(config)==value
    assert (tmp_path/'.cloud-storage.json').stat().st_mode&0o777==0o600
    assert 'fake-access-id' not in json.dumps(s.public_view(value))
    assert 'fake-secret-value' not in json.dumps(s.public_view(value))
    assert s.normalize({**profile(),'access_key_id':'','access_key_secret':''},profile())==profile()
    with pytest.raises(ValueError):s.normalize({**profile(),'access_key_id':'','access_key_secret':''})


@pytest.mark.parametrize('changes',[{'domain':''},{'domain':'http://127.0.0.1'},{'endpoint':'https://evil.example.com'}, {'region':'bad'},{'bucket_name':'BAD'},{'domain':'https://user:password@cdn.example.com'}])
def test_invalid_configuration(changes):
    with pytest.raises(ValueError):s.normalize({**profile(),**changes})


def test_confirmation_checks_ownership_and_public_access(tmp_path):
    p=profile();s.save({'data_dir':tmp_path},{'active_provider':'qiniu','profiles':{'qiniu':p}})
    body=dict(provider='qiniu',profile_fingerprint=s.fingerprint(p),key='file.png',url='https://cdn.example.com/file.png',name='file.png',size=16,mime='image/png',status='pending')
    h=SimpleNamespace(settings={'config':{'data_dir':tmp_path}},owner='owner',projects=Mock(),finish=Mock())
    with patch.object(s,'owned',AsyncMock(side_effect=HTTPError(404))) as owned:
        with pytest.raises(HTTPError):asyncio.run(s.UploadConfirmHandler.post(h,'id'))
        owned.assert_awaited_once_with(h.projects,'id','owner','cloud_upload')
    with patch.object(s,'owned',AsyncMock(return_value={'body':body})),patch.object(s,'verify_object') as verify,patch.object(s,'verify_public',AsyncMock(side_effect=s.StorageError('not public'))):
        with pytest.raises(HTTPError):asyncio.run(s.UploadConfirmHandler.post(h,'id'))
        verify.assert_called_once_with(p,'file.png',16,'image/png');h.finish.assert_not_called()


def test_provider_errors_are_sanitized():
    with patch.object(s,'aliyun',side_effect=RuntimeError('fake-secret-value')):
        with pytest.raises(s.StorageError) as error:s.probe(profile('aliyun'))
        assert 'fake-secret-value' not in str(error.value)


@pytest.mark.parametrize('raw,expected',[('', ''),('/project//images/', 'project/images'),(' 图片/参考图 ', '图片/参考图')])
def test_prefix_normalization_and_object_location(raw,expected):
    p=s.normalize({**profile(),'path_prefix':raw})
    assert p['path_prefix']==expected
    assert s.object_key(p,'owner','unique-id','image/png')==(expected+'/' if expected else '')+'unique-id.png'


@pytest.mark.parametrize('raw',['../images','images/../a','./a','https://cdn.example/a','a?b','a#b','a%2fb','a\\b','a/\n/b'])
def test_invalid_prefix(raw):
    with pytest.raises(ValueError):s.normalize({**profile(),'path_prefix':raw})


def test_existing_profile_paths_remain_compatible():
    p=profile();p.pop('path_prefix')
    assert s.object_key(p,'owner','id','image/png')=='director/references/owner/id.png'


def test_md5_grant_reuses_completed_project_upload(tmp_path):
    from contextlib import asynccontextmanager
    class Pool:
        def __init__(self):self.rows={}
        @asynccontextmanager
        async def connection(self):yield self
        async def execute(self,sql,args):
            if sql.startswith('INSERT'):self.rows.setdefault(args[0],{'body':args[1].obj})
            return SimpleNamespace(fetchone=AsyncMock(return_value=self.rows.get(args[0])))
    pool=Pool();p=profile();s.save({'data_dir':tmp_path},{'active_provider':'qiniu','profiles':{'qiniu':p}})
    data=dict(name='one.png',mime='image/png',size=4,md5='098f6bcd4621d373cade4e832627b4f6',project_id='a'*32)
    h=SimpleNamespace(settings={'config':{'data_dir':tmp_path}},owner='owner',projects=pool,data=lambda:data,finish=Mock())
    with patch.object(s,'owned',AsyncMock()) as own,patch.object(s,'sign_upload',return_value={'method':'POST'}) as sign:
        asyncio.run(s.UploadGrantHandler.post(h))
        own.assert_awaited_once_with(pool,'a'*32,'owner','project')
        upload_id=h.finish.call_args.args[0]['upload_id'];body=pool.rows[upload_id]['body']
        assert body['key']=='director/references/'+data['project_id']+'/'+data['md5']+'.png'
        assert 'fake-secret-value' not in json.dumps(body)
        body['status']='completed';data['name']='renamed.png'
        asyncio.run(s.UploadGrantHandler.post(h))
        assert h.finish.call_args.args[0]['reused'] is True
        assert h.finish.call_args.args[0]['asset']['id']==upload_id
        assert sign.call_count==1 and len(pool.rows)==1


def test_project_directory_is_between_prefix_and_md5():
    p={**profile(),'path_prefix':'media/images'}
    assert s.object_key(p,'owner','b'*32,'image/jpeg','a'*32)=='media/images/'+'a'*32+'/'+'b'*32+'.jpg'
    p['path_prefix']=''
    assert s.object_key(p,'owner','b'*32,'image/png','a'*32)=='a'*32+'/'+'b'*32+'.png'


def test_public_confirmation_follows_https_redirect_and_rejects_private_targets():
    replies=[SimpleNamespace(code=301,headers={'Location':'https://cdn.example.com/a.png'}),SimpleNamespace(code=200,headers={'Content-Length':'4'})]
    client=SimpleNamespace(fetch=AsyncMock(side_effect=replies))
    async def run():
        with patch.object(asyncio.get_running_loop(),'getaddrinfo',AsyncMock(return_value=[(2,1,6,'',('8.8.8.8',443))])):
            return await s.verify_public('http://cdn.example.com/a.png',4)
    with patch.object(s,'AsyncHTTPClient',return_value=client):
        assert asyncio.run(run())=='https://cdn.example.com/a.png'
    assert client.fetch.await_count==2
    client.fetch=AsyncMock(return_value=SimpleNamespace(code=301,headers={'Location':'http://127.0.0.1/a'}))
    async def rejected():
        with patch.object(asyncio.get_running_loop(),'getaddrinfo',AsyncMock(side_effect=[[(2,1,6,'',('8.8.8.8',443))],[(2,1,6,'',('127.0.0.1',80))]])):
            await s.verify_public('https://cdn.example.com/a.png',4)
    with patch.object(s,'AsyncHTTPClient',return_value=client),pytest.raises(s.StorageError):asyncio.run(rejected())
    assert client.fetch.await_count==1


def test_cloud_copy_requires_ownership_and_completed_image():
    h=SimpleNamespace(projects=Mock(),owner='owner',finish=Mock(),set_header=Mock())
    with patch.object(s,'owned',AsyncMock(side_effect=HTTPError(404))) as own,patch.object(s,'read_cloud_image',AsyncMock()) as read:
        with pytest.raises(HTTPError):asyncio.run(s.CloudImageHandler.get(h,'id'))
        own.assert_awaited_once_with(h.projects,'id','owner','cloud_upload');read.assert_not_awaited()
    for body in [{'status':'pending','mime':'image/png'},{'status':'completed','mime':'video/mp4'}]:
        with patch.object(s,'owned',AsyncMock(return_value={'body':body})),pytest.raises(HTTPError):asyncio.run(s.CloudImageHandler.get(h,'id'))
    with patch.object(s,'owned',AsyncMock(return_value={'body':{'status':'completed','mime':'image/png'}})),patch.object(s,'read_cloud_image',AsyncMock(return_value=b'png')):
        asyncio.run(s.CloudImageHandler.get(h,'id'));h.finish.assert_called_once_with(b'png')


def test_cloud_image_download_validates_hash_size_and_redirects():
    import hashlib
    body={'url':'https://cdn.example/a.png','size':4,'md5':hashlib.md5(b'test').hexdigest()}
    async def fetch(request,**kwargs):
        request.streaming_callback(b'test')
        return SimpleNamespace(code=200,headers={})
    client=SimpleNamespace(fetch=AsyncMock(side_effect=fetch))
    async def run():
        with patch.object(asyncio.get_running_loop(),'getaddrinfo',AsyncMock(return_value=[(2,1,6,'',('8.8.8.8',443))])):
            return await s.read_cloud_image(body)
    with patch.object(s,'AsyncHTTPClient',return_value=client):
        assert asyncio.run(run())==b'test'
        body['md5']='0'*32
        with pytest.raises(s.StorageError):asyncio.run(run())
        body.pop('md5');body['size']=5
        with pytest.raises(s.StorageError):asyncio.run(run())
