"""Real FastAPI -> Tornado -> PostgreSQL account isolation checks."""
import json
from test_cloud_gateway import gateway, login
from test_integration import service


def test_wechat_gateway_account_isolation_and_sync_key_denial(gateway):
    c,app,users=gateway
    prefix='/hotpoor/director';path=prefix+'/api/wechat/conversations'
    c.cookies.clear();c.headers.clear()
    assert c.get(path).status_code==401
    login(c,users[0])
    page=c.get(prefix)
    assert page.status_code==200 and b'id="open-wechat"' in page.content
    assert c.get(prefix+'/static/wechat.js').status_code==200
    payload={'name':'fixture.json','content':json.dumps({'title':'微信隔离测试','messages':[{'sender':'张三','time':'2026-10-29 09:30:00','text':'只属于当前账号'}]}),'storage':'database'}
    result=c.post(path,json=payload);assert result.status_code==200,result.text
    identifier=result.json()['id'];detail=path+'/'+identifier
    assert c.get(detail).json()['messages'][0]['text']=='只属于当前账号'
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
