"""Exercise the real Director scope server and CLI without touching user selections."""
import asyncio
from http.cookies import SimpleCookie
import json
import os
import sys
from pathlib import Path

from tornado.httpclient import AsyncHTTPClient
from backend.config import ROOT


async def exercise_scope(runtime):
    runtime.config.setdefault('knowledge', {})['codex_scope'] = {'enabled': True, 'port': 0}
    await runtime.start_scope()
    origin = runtime.scope_url
    client = AsyncHTTPClient()
    page = await client.fetch(origin+'/')
    cookie = SimpleCookie()
    for header in page.headers.get_list('Set-Cookie'):
        cookie.load(header)
    token = cookie['_xsrf'].value
    headers = {'Cookie': '_xsrf='+token, 'X-XSRFToken': token, 'Content-Type':'application/json'}

    async def request(path, body=None, expected=200, extra=None):
        result = await client.fetch(origin+path, method='POST' if body is not None else 'GET',
            headers={**headers, **(extra or {})}, body=json.dumps(body) if body is not None else None,
            raise_error=False)
        assert result.code == expected, (path, result.code, result.body[:300])
        if expected == 200:
            assert runtime.app.token.encode() not in result.body
            return json.loads(result.body)

    async def cli(*args):
        process = await asyncio.create_subprocess_exec(sys.executable, '-m', 'backend.knowledge.scope_cli',
            *args, cwd=ROOT, env={**os.environ, 'DIRECTOR_SCOPE_URL':origin},
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
        return process.returncode, stdout.decode(), stderr.decode()

    assert (await request('/health'))['pid'] == os.getpid()
    await request('/health', extra={'Host':'evil.invalid'}, expected=403)
    await request('/health', extra={'Origin':'https://evil.invalid'}, expected=403)
    denied = await client.fetch(origin+'/wiki/api/resolve',method='POST',body='{}',raise_error=False)
    assert denied.code == 403
    await request('/wiki/api/resolve', {'paths':[]}, extra={'Origin':'https://evil.invalid'}, expected=403)
    await request('/wiki/api/inference', expected=404)
    catalog = await request('/api/catalog')
    paths = [x['path'] for x in catalog['items'] if x['kind']=='file']
    assert len(paths)==103
    assert (await request('/api/scope/thread-a'))['configured'] is False
    saved = await request('/api/scope/thread-a', {'revision':None,'paths':paths})
    await request('/api/scope/thread-a', {'revision':None,'paths':[]}, expected=409)
    await request('/api/scope/thread-a', {'revision':saved['revision'],'paths':['../not-in-library']}, expected=400)
    assert (await request('/api/scope/thread-a'))['revision']==saved['revision']
    second = await request('/api/scope/thread-b', {'revision':None, 'paths':[paths[0]]})
    assert len((await request('/api/scope/thread-a'))['paths']) == 103
    assert len((await request('/api/scope/thread-b'))['paths']) == 1
    code, stdout, stderr = await cli('--thread','thread-a','status')
    assert code==0, stderr
    assert json.loads(stdout)['selected_count']==103

    # A deterministic semantic branch exercises real SQL, bridge, scope and full CLI pagination.
    async def status(ids):
        return {'ready':True,'selected_documents':len(ids),'indexed_documents':len(ids),'job':{'state':'idle'}}
    async def search(query, ids, threshold):
        return [{'block_id':bid,'semantic_score':.8,'passages':[]} for bid in ids]
    runtime.app.semantic.status = status
    runtime.app.semantic.search = search
    runtime.app.semantic.signature = 'fixture'
    runtime.app.hybrid_cache.clear()
    code, stdout, stderr = await cli('--thread','thread-a','index')
    assert code == 0 and json.loads(stdout)['ready'], stderr
    code, stdout, stderr = await cli('--thread','thread-a','search','--query','研究','--page-size','100')
    assert code==0, stderr
    result=json.loads(stdout)
    assert result['total']==104 and result['has_next']
    assert result['retrieval']['union_count']==result['total']
    code, stdout, stderr = await cli('--thread','thread-a','search','--query','研究','--page-size','100','--page','2')
    assert code==0 and len(json.loads(stdout)['items'])==4, stderr
    code, stdout, stderr = await cli('--thread','thread-a','read','--block',result['items'][0]['block_id'],'--page-size','1')
    assert code==0 and len(json.loads(stdout)['document']['lines'])==1, stderr
    outside=next(item['block_id'] for item in result['items'] if paths[0] not in item['paths'])
    code, stdout, stderr = await cli('--thread','thread-b','read','--block',outside)
    assert code!=0 and '不在当前勾选范围' in stderr
    await request('/api/scope/thread-a',{'revision':saved['revision'],'paths':[]})
    code, stdout, stderr = await cli('--thread','thread-a','search','--query','研究')
    assert code!=0 and '不能回退到全库' in stderr
    assert (await request('/api/scope/thread-b'))['revision']==second['revision']
    return second
