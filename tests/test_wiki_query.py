import asyncio
import json
import pytest
from backend import wiki_query, inference


def test_validate_and_tokenize():
    assert wiki_query.parse_plan('```json\n{"keywords":["激浪派","激浪派"],"expanded_keywords":["Fluxus"]}\n```')['keywords']==['激浪派']
    assert 'fluxus' in wiki_query.search_words(['Fluxus'])
    assert not any(x in wiki_query.search_words(['艺术，是什么？']) for x in ['，','？'])
    for value in ['{}','[]','{"keywords":"研究"}','{"keywords":[""]}']:
        with pytest.raises((ValueError,TypeError)):wiki_query.parse_plan(value)


def test_keyword_request_is_durable_and_reused(tmp_path,monkeypatch):
    calls=[]
    async def api(key,path,data):
        calls.append(data)
        state=json.loads(data['messages'][-1]['content'])
        assert state['question']=='请帮我查财政预算'
        return {'choices':[{'message':{'content':'{"keywords":["财政预算"],"expanded_keywords":[]}'}}],'usage':{'completion_tokens':8}}
    monkeypatch.setattr(inference,'api',api)
    args=({'data_dir':tmp_path},'user','conversation','request','请帮我查财政预算',[],'test-secret','fixture','/v1/chat/completions')
    first=asyncio.run(wiki_query.prepare(*args));second=asyncio.run(wiki_query.prepare(*args))
    assert first==second and len(calls)==1
    assert first['semantic_query']=='请帮我查财政预算'
    assert first['status']=='ready' and first['usage']['completion_tokens']==8
    stored=next((tmp_path/'wiki-query-preparations').glob('*.json')).read_text(encoding='utf-8')
    assert 'test-secret' not in stored


def test_failed_preparation_is_visible_and_not_retried(tmp_path,monkeypatch):
    calls=[]
    async def api(*args):
        calls.append(1)
        raise inference.ProviderError('fixture failure',503)
    monkeypatch.setattr(inference,'api',api)
    args=({'data_dir':tmp_path},'user','conversation','request','激浪派',[],'key','fixture','/v1/chat/completions')
    first=asyncio.run(wiki_query.prepare(*args))
    assert first['status']=='fallback' and first['lexical_terms']
    assert '失败' in first['error']
    assert asyncio.run(wiki_query.prepare(*args))==first and len(calls)==1
