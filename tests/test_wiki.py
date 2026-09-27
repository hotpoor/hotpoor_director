"""Scoped union retrieval; neither branch may silently disappear."""
import asyncio
import pytest
from tornado.web import HTTPError
from backend import wiki

CFG = {**wiki.DEFAULTS, 'provider': 'external', 'enabled': True, 'max_total_chars': 16000}

def run(value): return asyncio.run(value)
def selected(n): return [{'path': f'folder/{i}.md', 'title': f'Document {i}'} for i in range(n)]
def item(i, channels=None): return {'block_id': str(i), 'paths': [f'folder/{i}.md'], 'score': 1/(i+1), 'channels': channels or ['lexical', 'semantic']}

def mock_api(monkeypatch, items, body='正文', page_size=100, missing=False, ready=True):
    calls=[]
    async def post(client,url,data,**kwargs):
        calls.append((url,data))
        if url.endswith('/api/resolve'):
            return {'block_ids':[p.split('/')[-1].split('.')[0] for p in data['paths']], 'missing_paths':data['paths'] if missing else []}
        if url.endswith('/api/semantic/index'):return {'ready':ready}
        assert url.endswith('/api/hybrid/search')
        page=data['page'];start=(page-1)*page_size
        return {'items':items[start:start+page_size], 'pagination':{'has_next':start+page_size<len(items)}, 'retrieval':{'strategy':'hybrid_union_rrf'}}
    async def get(client,url,**kwargs):return {'markdown':body}
    monkeypatch.setattr(wiki,'_post_json',post);monkeypatch.setattr(wiki,'_get_json',get)
    return calls

def test_selection_complete():
    assert len(wiki.clean_selections(selected(6000)+selected(1)))==6000
    with pytest.raises(HTTPError):wiki.clean_selections([{'path':''}])

def test_union_retains_single_channel_hits_and_all_pages(monkeypatch):
    hits=[item(0,['lexical']),item(1,['semantic']),item(79)]
    calls=mock_api(monkeypatch,hits,page_size=1)
    text,report=run(wiki.retrieve(CFG,selected(80),'财政'))
    assert report['matched_count']==3 and report['mode']=='hybrid_union_rrf'
    assert [x['channels'] for x in report['used']]==[['lexical'],['semantic'],['lexical','semantic']]
    assert len([1 for u,d in calls if u.endswith('/api/hybrid/search')])==3
    assert all(len(d['block_ids'])==80 for u,d in calls if u.endswith('/api/hybrid/search'))

def test_outside_scope_is_error(monkeypatch):
    mock_api(monkeypatch,[item(999)])
    with pytest.raises(HTTPError):run(wiki.retrieve(CFG,selected(80),'财政'))

def test_no_fifty_limit(monkeypatch):
    mock_api(monkeypatch,[item(i) for i in range(75)])
    text,report=run(wiki.retrieve({**CFG,'max_total_chars':80000},selected(75),'正文'))
    assert len(report['used'])==75 and report['chars']==len(text)

def test_no_whole_library_fallback(monkeypatch):
    calls=mock_api(monkeypatch,[])
    _,report=run(wiki.retrieve(CFG,selected(2),'query'))
    assert report['used']==[] and report['candidate_count']==0
    assert not any(d.get('q')=='md' for _,d in calls)

@pytest.mark.parametrize('missing,ready',[(True,True),(False,False)])
def test_missing_path_or_incomplete_vectors_fail(monkeypatch,missing,ready):
    mock_api(monkeypatch,[],missing=missing,ready=ready)
    with pytest.raises(HTTPError):run(wiki.retrieve(CFG,selected(2),'query'))

def test_semantic_excerpt_can_reach_document_end(monkeypatch):
    hit=item(0,['semantic']);hit['passages']=[{'char_start':10000}]
    mock_api(monkeypatch,[hit],body='无'*10000+'制度问责。'*100)
    text,r=run(wiki.retrieve({**CFG,'max_total_chars':700,'max_chars_per_doc':300},selected(1),'不同词'))
    assert len(text)<=700 and '制度问责' in text and r['used'][0]['start']>9000

def test_six_thousand_selections_resolve_in_batches(monkeypatch):
    calls=mock_api(monkeypatch,[item(5999)])
    _,r=run(wiki.retrieve(CFG,selected(6000),'概括'))
    assert len([1 for u,d in calls if u.endswith('/api/resolve')])==6
    assert r['used'][0]['block_id']=='5999'

def test_failure_aborts(monkeypatch):
    mock_api(monkeypatch,[item(0)])
    async def fail(*args,**kwargs):raise HTTPError(502)
    monkeypatch.setattr(wiki,'_get_json',fail)
    with pytest.raises(HTTPError):run(wiki.retrieve(CFG,selected(1),'query'))

def test_disabled_budget_does_not_request(monkeypatch):
    async def fail(*args,**kwargs):pytest.fail('unexpected request')
    monkeypatch.setattr(wiki,'_post_json',fail)
    _,r=run(wiki.retrieve({**CFG,'max_total_chars':0},selected(10),'query'))
    assert r['mode']=='disabled_budget'
