"""Real FastAPI -> Tornado -> PostgreSQL account isolation checks."""
import json
from test_cloud_gateway import gateway, login
from test_integration import service


def test_wechat_gateway_account_isolation_and_sync_key_denial(gateway, monkeypatch):
    c,app,users=gateway
    from backend import wechat as w
    objects={};reads=[]
    profile={'provider':'qiniu','bucket_name':'fixture-bucket','domain':'https://cdn.example.com','name':'测试七牛'}
    monkeypatch.setattr(w,'selected_profile',lambda *a,**k:profile)
    def upload(p,key,raw):objects[key]=raw
    async def download(p,part):reads.append(part['index']);return objects[part['key']]
    monkeypatch.setattr(w,'upload',upload);monkeypatch.setattr(w,'download',download)
    prefix='/hotpoor/director';path=prefix+'/api/wechat/conversations'
    c.cookies.clear();c.headers.clear()
    assert c.get(path).status_code==401
    login(c,users[0])
    page=c.get(prefix)
    assert page.status_code==200 and b'id="open-wechat"' in page.content
    assert c.get(prefix+'/static/wechat.js').status_code==200
    payload={'name':'fixture.json','content':json.dumps({'title':'微信隔离测试','messages':[{'sender':'张三','time':'2026-10-29 09:30:00','text':'私有消息 '+str(i)} for i in range(1005)]}),'storage':'cloud','profile_id':'chosen','request_id':'a'*32}
    result=c.post(path,json=payload);assert result.status_code==200,result.text
    identifier=result.json()['id'];detail=path+'/'+identifier
    assert len(objects)==3
    assert all(b'sender' not in blob for blob in objects.values())
    assert c.post(path,json=payload).json()['id']==identifier and len(objects)==3
    reads.clear()
    page=c.get(detail).json()
    assert page['messages'][0]['text']=='私有消息 0' and len(page['messages'])==100
    assert reads==[0]
    reads.clear()
    assert c.get(detail+'?offset=1000').json()['messages'][0]['text']=='私有消息 1000'
    assert reads==[2]
    assert c.get(detail,params={'q':'私有消息 1004'}).json()['total']==1
    assert len(c.get(detail+'/export').json()['messages'])==1005
    assert 'messages' not in c.get(path).json()['conversations'][0]['body']

    assert c.get(detail+'/export').json()['title']=='微信隔离测试'
    login(c,users[1])
    assert c.get(path).json()['conversations']==[]
    assert c.get(detail).status_code==404
    assert c.get(detail+'/export').status_code==404
    login(c,users[0])
    key=c.post(prefix+'/auth/keys',json={'name':'微信拒绝同步 AK 验证','expires_at':None}).json()['access_key']
    c.cookies.clear();c.headers.clear();c.headers['Authorization']='Bearer '+key
    assert c.get(path).status_code==403
    assert c.get(detail).status_code==403
    assert c.get(detail+'/export').status_code==403
    assert c.post(path,json=payload).status_code==403
