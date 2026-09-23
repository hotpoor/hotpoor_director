"""Wiki retrieval uses the complete selection, without paid model requests."""
import asyncio
from urllib.parse import parse_qs, urlparse

import pytest
from tornado.web import HTTPError
from backend import wiki


CFG = {**wiki.DEFAULTS, 'enabled': True, 'max_total_chars': 16000}


def run(value):
    return asyncio.run(value)


def selected(count):
    return [{'path': f'folder/{i}.md', 'title': f'Document {i}'} for i in range(count)]


def result(items, page=1, pages=1):
    return {'items': items, 'pagination': {'pages': pages, 'has_next': page < pages}}


def test_selection_is_complete_deduplicated_and_invalid_items_fail():
    items = selected(6000)
    assert len(wiki.clean_selections(items + items[:1])) == 6000
    with pytest.raises(HTTPError):
        wiki.clean_selections(items + [{'path': ''}])


def test_search_includes_late_selection_and_late_page_without_scope_leak(monkeypatch):
    calls = []
    async def get(client, url, **kwargs):
        calls.append(url)
        parsed = urlparse(url)
        if parsed.path == '/api/search':
            page = int(parse_qs(parsed.query)['page'][0])
            items = [{'block_id': 'outside', 'paths': ['outside/private.md'], 'score': 99}]
            if page == 51:
                items.append({'block_id': 'wanted', 'paths': ['folder/79.md'], 'score': 1})
            return result(items, page, 51)
        assert '/wanted?' in url
        return {'markdown': '有用的财政资料'}
    monkeypatch.setattr(wiki, '_get_json', get)
    text, report = run(wiki.retrieve(CFG, selected(80), '财政'))
    assert report['selected_count'] == 80
    assert report['matched_count'] == 1
    assert report['used'][0]['path'] == 'folder/79.md'
    assert 'outside/private' not in text
    assert len(calls) == 52


def test_more_than_fifty_documents_can_be_submitted(monkeypatch):
    async def get(client, url, **kwargs):
        if '/api/search?' in url:
            return result([{'block_id': str(i), 'paths': [f'folder/{i}.md'], 'score': 1} for i in range(75)])
        return {'markdown': '正文'}
    monkeypatch.setattr(wiki, '_get_json', get)
    text, report = run(wiki.retrieve({**CFG, 'max_total_chars': 80000}, selected(75), '正文'))
    assert len(report['used']) == 75
    assert report['chars'] == len(text)


def test_fallback_resolves_exact_path_beyond_first_page(monkeypatch):
    async def get(client, url, **kwargs):
        if '/api/blocks/' in url:
            return {'markdown': '完整正文'}
        args = parse_qs(urlparse(url).query)
        if args['q'][0] == 'summarize':
            return result([])
        page = int(args['page'][0])
        item = {'block_id': 'old', 'paths': ['folder/0.md'], 'updatetime': 1}
        if page == 2:
            item = {**item, 'block_id': 'new', 'updatetime': 2}
        return result([item], page, 2)
    monkeypatch.setattr(wiki, '_get_json', get)
    text, report = run(wiki.retrieve(CFG, selected(1), 'summarize'))
    assert report['mode'] == 'scope_fallback'
    assert report['used'][0]['block_id'] == 'new'


def test_strict_total_budget_and_relevant_passage_at_document_end(monkeypatch):
    body = '无关前言。' * 3000 + '财政预算专项。' * 100
    async def get(client, url, **kwargs):
        if '/api/search?' in url:
            return result([{'block_id': 'doc', 'paths': ['folder/0.md']}])
        return {'markdown': body}
    monkeypatch.setattr(wiki, '_get_json', get)
    text, report = run(wiki.retrieve({**CFG, 'max_total_chars': 700, 'max_chars_per_doc': 300}, selected(1), '财政预算'))
    assert len(text) <= 700
    assert '财政预算' in text
    assert report['used'][0]['start'] > 1000
    assert report['used'][0]['partial'] is True


@pytest.mark.parametrize('where', ['search', 'body'])
def test_failure_never_silently_returns_partial_material(monkeypatch, where):
    async def get(client, url, **kwargs):
        if '/api/search?' in url:
            if where == 'search' and 'page=2' in url:
                raise HTTPError(502, reason='page failed')
            return result([{'block_id': 'doc', 'paths': ['folder/0.md']}], 1, 2 if where == 'search' else 1)
        raise HTTPError(502, reason='body failed')
    monkeypatch.setattr(wiki, '_get_json', get)
    with pytest.raises(HTTPError):
        run(wiki.retrieve(CFG, selected(1), 'query'))


def test_disabled_budget_does_not_make_requests(monkeypatch):
    async def get(*args, **kwargs):
        pytest.fail('Must not request Wiki')
    monkeypatch.setattr(wiki, '_get_json', get)
    text, report = run(wiki.retrieve({**CFG, 'max_total_chars': 0}, selected(100), 'query'))
    assert text == ''
    assert report['mode'] == 'disabled_budget'


def test_missing_documents_are_reported(monkeypatch):
    async def get(*args, **kwargs):
        return result([])
    monkeypatch.setattr(wiki, '_get_json', get)
    text, report = run(wiki.retrieve(CFG, selected(2), 'query'))
    assert report['missing_paths'] == ['folder/0.md', 'folder/1.md']
    assert report['used'] == []
    assert '本轮检索命中：0' in text


def test_large_fallback_scans_index_once_instead_of_once_per_selected_file(monkeypatch):
    queries = []
    async def get(client, url, **kwargs):
        if '/api/blocks/' in url:
            return {'markdown': 'late document'}
        query = parse_qs(urlparse(url).query)['q'][0]
        queries.append(query)
        return result([{'block_id': 'late', 'paths': ['folder/5999.md']}]) if query == 'md' else result([])
    monkeypatch.setattr(wiki, '_get_json', get)
    _, report = run(wiki.retrieve(CFG, selected(6000), 'overview'))
    assert queries == ['overview', 'md']
    assert report['used'][0]['path'] == 'folder/5999.md'
    assert len(report['missing_paths']) == 5999
