import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from contextlib import asynccontextmanager

import httpx
import pytest
from cryptography.exceptions import InvalidTag
from tornado.web import HTTPError
from backend import wechat as w
from test_integration import service


def example(count=1):
    return {'title': '真实格式测试', 'messages': [{'sender':'张三', 'time':'2026-10-29 09:30:00', 'text':f'正文 {i} <script>alert(1)</script>', 'is_self':False} for i in range(count)]}


def test_parsers_and_source_order():
    value=example(2)
    assert len(w.parse_export('a.json','\ufeff'+json.dumps(value))['messages'])==2
    csv='sender,time,text,is_self\n我,2026-10-29 09:30:00,"你好\n下一行",true\n'
    result=w.parse_export('a.csv',csv)
    assert result['messages'][0]['is_self'] is True
    assert result['messages'][0]['text']=='你好\n下一行'
    txt='2026-10-29 09:30:00 张三\n你好\n第二行\n[2026-10-29 09:31:00] 我\n收到'
    assert len(w.parse_export('a.txt',txt)['messages'])==2
    assert w.parse_export('a.json',json.dumps(value))['messages'][1]['id']=='1'


@pytest.mark.parametrize('name,raw', [('a.db','secret'),('a.json','{}'),('a.json','[]'),('a.json','['),('a.txt','无结构文字'),('a.csv','sender,time,text\n张三,,你好'),('a.json',json.dumps([{'sender':'a','time':'b','text':'c','is_self':[]}]))])
def test_bad_imports_fail_without_silent_data_loss(name,raw):
    with pytest.raises(ValueError):w.parse_export(name,raw)


def test_authenticated_encryption_and_key_persistence(tmp_path):
    config={'data_dir':tmp_path};key=w.archive_key(config,True)
    assert w.archive_key(config,True)==key
    raw=json.dumps(example()).encode();sealed=w.seal(raw,key,'owner:archive')
    assert b'sender' not in sealed and raw not in sealed
    assert w.unseal(sealed,key,'owner:archive')==raw
    with pytest.raises(InvalidTag):w.unseal(sealed,key,'other:archive')
    with pytest.raises(InvalidTag):w.unseal(sealed[:-1]+bytes([sealed[-1]^1]),key,'owner:archive')
    assert (tmp_path/'.wechat-archive.key').stat().st_mode&0o777==0o600


def test_cloud_import_only_publishes_verified_ciphertext(tmp_path):
    class Pool:
        @asynccontextmanager
        async def connection(self):yield self
        async def execute(self,*args,**kw):
            if args[0].startswith('SELECT'):return SimpleNamespace(fetchone=AsyncMock(return_value=None))
            self.body=args[1][1].obj
    pool=Pool();p={'provider':'qiniu','bucket_name':'fixture','domain':'https://cdn.example.com','path_prefix':'private','name':'测试七牛'}
    data={'name':'a.json','content':json.dumps(example()),'storage':'cloud','profile_id':'chosen'}
    h=SimpleNamespace(settings={'config':{'data_dir':tmp_path}},owner='owner',projects=pool,data=lambda:data,finish=Mock())
    uploaded={}
    def upload(profile,key,raw):uploaded.update(profile=profile,key=key,raw=raw)
    async def download(profile,cloud):
        assert cloud['key']==uploaded['key'];return uploaded['raw']
    with patch.object(w,'selected_profile',return_value=p) as selected,patch.object(w,'upload',side_effect=upload),patch.object(w,'download',side_effect=download):
        asyncio.run(w.WechatConversationsHandler.post(h))
        assert selected.call_args.args[1]=='chosen'
        assert 'messages' not in pool.body
        assert '正文' not in json.dumps(pool.body,ensure_ascii=False)
        assert pool.body['profile_id']=='chosen'
        row={'block_id':h.finish.call_args.args[0]['id'],'body':pool.body}
        assert asyncio.run(w.contents(h,row))[0]['sender']=='张三'
    h.finish.reset_mock()
    with patch.object(w,'selected_profile',return_value=p),patch.object(w,'upload',side_effect=ValueError('secret-error')):
        with pytest.raises(HTTPError) as error:asyncio.run(w.WechatConversationsHandler.post(h))
        assert error.value.status_code==502 and 'secret-error' not in error.value.reason
        h.finish.assert_not_called()


def test_real_http_preview_rejects_database_body_storage(service):
    _,url=service
    with httpx.Client(base_url=url,trust_env=False) as c:
        assert c.get('/api/wechat/conversations').status_code==401
        c.get('/');c.headers['X-XSRFToken']=c.cookies['_xsrf']
        assert c.post('/api/login',json={'login':'director','password':'a-local-test-password-123'}).status_code==200
        payload={'name':'real-format.json','content':json.dumps(example(205)),'storage':'database'}
        preview=c.post('/api/wechat/preview',json=payload);assert preview.status_code==200,preview.text
        assert preview.json()['count']==205 and len(preview.json()['sample'])==5
        assert c.post('/api/wechat/conversations',json=payload).status_code==400
        assert c.get('/api/wechat/conversations').json()['conversations']==[]
        assert c.post('/api/wechat/conversations',json={**payload,'storage':'cloud','profile_id':'missing'}).status_code==400


@pytest.mark.parametrize('provider',['qiniu','aliyun','tencent'])
def test_cloud_upload_uses_selected_provider_and_binary_payload(provider):
    profile={'provider':provider,'bucket_name':'fixture-bucket','access_key_id':'fixture-ak','access_key_secret':'fixture-sk'}
    with patch('qiniu.Auth') as auth,patch('qiniu.put_data',return_value=({},SimpleNamespace(status_code=200))) as qiniu_put,patch.object(w.storage,'aliyun') as oss,patch.object(w.storage,'tencent') as cos:
        auth.return_value.upload_token.return_value='fixture-scoped-token'
        w.upload(profile,'wechat/archive.enc',b'ciphertext')
        if provider=='qiniu':
            qiniu_put.assert_called_once_with('fixture-scoped-token','wechat/archive.enc',b'ciphertext',mime_type='application/octet-stream')
            assert auth.return_value.upload_token.call_args.kwargs['policy']['insertOnly']==1
        elif provider=='aliyun':oss.return_value.put_object.assert_called_once_with('wechat/archive.enc',b'ciphertext',headers={'Content-Type':'application/octet-stream'})
        else:cos.return_value.put_object.assert_called_once_with(Bucket='fixture-bucket',Key='wechat/archive.enc',Body=b'ciphertext',ContentType='application/octet-stream')
