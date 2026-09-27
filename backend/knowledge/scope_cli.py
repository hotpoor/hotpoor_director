"""Codex local CLI: always read current per-task scope before Wiki retrieval."""
import argparse
import json
import os
from pathlib import Path
import re
import urllib.request
import http.cookiejar
from urllib.parse import urlencode, urlparse, unquote

SCOPE_URL=os.environ.get('DIRECTOR_SCOPE_URL', 'http://127.0.0.1:8890').rstrip('/')
parsed=urlparse(SCOPE_URL)
if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.path or parsed.username:
    raise ValueError('DIRECTOR_SCOPE_URL 必须是本机 Director 文献服务地址')
WIKI=SCOPE_URL+'/wiki'
COOKIES=http.cookiejar.CookieJar()
CLIENT=urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(COOKIES))

def get(route,**params):
    with CLIENT.open(WIKI+route+('?' + urlencode(params) if params else ''),timeout=180) as r:
        return json.load(r)

def post(route, **body):
    if not any(c.name == '_xsrf' for c in COOKIES):
        with CLIENT.open(SCOPE_URL+'/', timeout=30) as response:
            response.read()
    token=next(unquote(c.value) for c in COOKIES if c.name == '_xsrf')
    request = urllib.request.Request(WIKI + route, data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json', 'X-XSRFToken': token}, method='POST')
    with CLIENT.open(request, timeout=180) as response:
        return json.load(response)


def resolve_paths(allowed):
    ids = set()
    paths = sorted(allowed)
    for start in range(0, len(paths), 1000):
        result = post('/api/resolve', paths=paths[start:start + 1000])
        if result['missing_paths']:
            raise ValueError('所选文章尚未导入或已移除，请刷新目录；不扩大检索范围。')
        ids.update(result['block_ids'])
    if not ids:
        raise ValueError('所选范围未解析出正文 ID；不回退全库。')
    return sorted(ids)


def scope(thread):
    if not thread or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}',thread):
        raise ValueError('请指定当前 Codex 任务 --thread；不使用其他任务的范围。')
    with CLIENT.open(SCOPE_URL+'/api/scope/'+thread, timeout=30) as response:
        return json.load(response)


def check_revision(thread, revision):
    if scope(thread)['revision'] != revision:
        raise ValueError('检索期间勾选范围发生变化，请按最新范围重新检索。')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--thread',default=os.environ.get('CODEX_THREAD_ID'))
    sub=p.add_subparsers(dest='action',required=True)
    sub.add_parser('status')
    sub.add_parser('index')
    s=sub.add_parser('search');s.add_argument('--query',required=True);s.add_argument('--page',type=int,default=1);s.add_argument('--page-size',type=int,default=10)
    r=sub.add_parser('read');r.add_argument('--block',required=True);r.add_argument('--page',type=int,default=1);r.add_argument('--page-size',type=int,default=100)
    a=p.parse_args();state=scope(a.thread);allowed=set(state['paths'])
    common={'thread_id':a.thread,'scope_revision':state['revision'],'configured':state['configured'],'selected_count':len(allowed),'updated_at':state.get('updated_at')}
    if a.action=='status':
        counts={}
        for path in allowed:
            group=path.split('/')[0] if '/' in path else '(根目录文章)'
            counts[group]=counts.get(group,0)+1
        print(json.dumps({**common,'groups':counts,'selection_file':state['selection_file'],'provider':'director'},ensure_ascii=False,indent=2));return
    if not state['configured'] or not allowed:raise ValueError('当前任务尚未选择文献或已清空范围。不能回退到全库；请先在选择页应用范围。')
    if a.action=='index':
        import time
        ids = resolve_paths(allowed)
        check_revision(a.thread, state['revision'])
        result = post('/api/semantic/index', block_ids=ids)
        while not result['ready']:
            if result['job'].get('state') == 'failed':
                raise ValueError(result['job'].get('error', 'Semantic indexing failed'))
            if scope(a.thread)['revision'] != state['revision']:
                raise ValueError('勾选范围已改变，请重新运行 index')
            print(json.dumps(result['job'], ensure_ascii=False), flush=True)
            time.sleep(5)
            result = post('/api/semantic/status', block_ids=ids)
            if not result['ready'] and result['job'].get('state') in ('idle', 'complete'):
                result = post('/api/semantic/index', block_ids=ids)
        check_revision(a.thread, state['revision'])
        print(json.dumps(result, ensure_ascii=False, indent=2));return
    if a.page<1 or not 1<=a.page_size<=100:raise ValueError('分页超出范围')
    if a.action=='read':
        if not re.fullmatch(r'[0-9a-fA-F-]{32,36}',a.block):raise ValueError('文档 ID 无效')
        summary=get('/api/blocks/'+a.block,include='summary')
        if summary.get('kind')!='document':raise ValueError('该 ID 不是文章正文。')
        selected_paths=[x for x in summary.get('paths',[]) if x in allowed]
        if not selected_paths:raise ValueError('该文献不在当前勾选范围内，未读取正文。')
        check_revision(a.thread, state['revision'])
        result=get('/api/blocks/'+a.block,include='lines',page=a.page,page_size=a.page_size)
        result['paths']=selected_paths;result['path']=selected_paths[0]
        output={**common,'document':result}
    else:
        if not a.query.strip():raise ValueError('请输入检索词')
        block_ids = resolve_paths(allowed)
        check_revision(a.thread, state['revision'])
        hits = {}
        page = 1
        while True:
            check_revision(a.thread, state['revision'])
            data = post('/api/hybrid/search', q=a.query, block_ids=block_ids, include='summary', page=page, page_size=100)
            for item in data['items']:
                paths = [x for x in item.get('paths', []) if x in allowed]
                if item['block_id'] not in block_ids or not paths:
                    raise ValueError('Wiki 返回了范围外文献，已停止检索。')
                hits[item['block_id']] = {**item, 'paths': paths, 'path': paths[0]}
            if not data['pagination']['has_next']:
                break
            if not data['items']:
                raise ValueError('搜索分页不完整，请重试')
            page += 1
        if len(hits) != data['retrieval']['union_count']:
            raise ValueError('混合检索并集数量与完整分页不一致，请重新检索。')
        ordered=sorted(hits.values(),key=lambda x:(-x.get('score',0),x['block_id']))
        offset=(a.page-1)*a.page_size
        output={**common,'query':a.query,'resolved_block_count':len(block_ids),'strategy':'hybrid_union_rrf','retrieval':data['retrieval'],'total':len(ordered),'page':a.page,'has_next':offset+a.page_size<len(ordered),'items':ordered[offset:offset+a.page_size],
                'note':'分词与语义召回取并集，按 block_id 去重并用 RRF 融合；仅返回语义分数达到阈值的片段，每文档展示最多3个语义片段，不代表全文已读。'}
    if scope(a.thread)['revision']!=state['revision']:raise ValueError('检索期间勾选范围发生变化，请按最新范围重新检索。')
    print(json.dumps(output,ensure_ascii=False,indent=2))
def entrypoint():
    try:main()
    except urllib.error.URLError as error:
        raise SystemExit('Director 文献服务请求失败，请确认 Director 已启动。' + str(error))
    except Exception as error:raise SystemExit(str(error))

if __name__=='__main__':
    entrypoint()
