"""Real isolated PostgreSQL + internal HTTP: import, scope, paging and auth."""
import asyncio
import json
import socket
from pathlib import Path

import pytest
from tornado.httpclient import AsyncHTTPClient
from backend.config import load_config
from backend.database import initialize
from backend.postgres import Postgres
from backend.knowledge.runtime import KnowledgeRuntime
from backend.knowledge.import_kb import import_directory, content_block_id
from backend import wiki


def test_builtin_postgres_and_http(tmp_path, monkeypatch):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    # Use production directory permissions, including explicit Windows user ACLs.
    monkeypatch.setenv('DIRECTOR_DATA_DIR', str(tmp_path))
    config = load_config()
    config['postgres']['port'] = port
    pg = Postgres(config)
    pg.start()
    try:
        initialize(config)
        async def exercise():
            runtime = KnowledgeRuntime(config)
            try:
                await runtime.start()
                wiki.save_config(config, {'provider': 'builtin', 'enabled': True})
                cfg = wiki.load_config(config)
                assert '_knowledge' not in wiki.public_config(cfg)
                base, client = wiki.connection(cfg)
                denied = await AsyncHTTPClient().fetch(base+'/health', raise_error=False)
                assert denied.code == 403
                assert (await wiki._get_json(client, base+'/health'))['ok']
                empty = await wiki._get_json(client, base+'/api/tree')
                assert empty['items'] == [] and empty['pagination']['total'] == 0
                assert empty['imported'] is False
                with pytest.raises(Exception):
                    await client.fetch('http://example.invalid/secret')
                folder = tmp_path/'markdown'; folder.mkdir()
                for i in range(103):
                    (folder/f'{i:03}.md').write_text(f'财政预算研究 {i}。', encoding='utf-8')
                await import_directory(folder, runtime.app.pools)
                tree = await wiki._get_json(client, base+'/api/tree?kind=file&page_size=100')
                assert tree['pagination']['total']==103 and tree['pagination']['has_next']
                assert len((await wiki._get_json(client,base+'/api/tree?kind=file&page_size=100&page=2'))['items'])==3
                ids = await wiki.resolve_scope(client, base, ['102.md'])
                assert ids == [str(content_block_id('财政预算研究 102。'))]
                scoped = await wiki._post_json(client,base+'/api/search',{'q':'研究','block_ids':ids})
                assert [x['block_id'] for x in scoped['items']]==ids
                original_status = runtime.app.semantic.status
                async def processing_status(scope):
                    return {'missing_block_ids': scope, 'job': {'state': 'running', 'current_block_id': ids[0], 'current_completed_chunks': 2, 'current_total_chunks': 5}}
                runtime.app.semantic.status = processing_status
                readiness = await wiki._post_json(client, base+'/api/processing/status', {'block_ids': ids})
                assert len(readiness['items']) == 1 and not readiness['ready']
                assert readiness['items'][0]['lexical']['state'] == 'ready'
                assert readiness['items'][0]['lexical']['terms'] > 0
                assert readiness['items'][0]['semantic']['state'] == 'running'
                assert readiness['items'][0]['semantic']['completed_chunks'] == 2
                async def broken_processing(scope):
                    raise RuntimeError('fixture vector unavailable')
                runtime.app.semantic.status = broken_processing
                unavailable_status = await wiki._post_json(client, base+'/api/processing/status', {'block_ids': ids})
                assert unavailable_status['items'][0]['lexical']['state'] == 'ready'
                assert unavailable_status['items'][0]['semantic']['state'] == 'unavailable'
                assert 'fixture vector unavailable' in unavailable_status['semantic_error']
                runtime.app.semantic.status = original_status
                # Test real SQL lexical branch + deterministic semantic branch, preserving union/scope.
                other = str(content_block_id('财政预算研究 000。'))
                async def search(query, scope, threshold):
                    assert scope == ids
                    return []
                runtime.app.semantic.search = search
                runtime.app.semantic.signature = 'fixture'
                hybrid = await wiki._post_json(client,base+'/api/hybrid/search',{'q':'研究','block_ids':ids})
                assert hybrid['retrieval']['lexical_only']==1
                assert other not in [x['block_id'] for x in hybrid['items']]
                runtime.app.hybrid_cache.clear()
                async def unavailable(*args):
                    raise RuntimeError('fixture semantic service unavailable')
                runtime.app.semantic.search = unavailable
                failed = await client.fetch(base+'/api/hybrid/search', method='POST',
                    headers={'Content-Type':'application/json'},
                    body=json.dumps({'q':'研究','block_ids':ids}), raise_error=False)
                assert failed.code == 503  # Do not return lexical-only success.
                # A file-tree path must not cause an updated document to be skipped.
                (folder/'102.md').write_text('更新后的财政预算。', encoding='utf-8')
                await import_directory(folder, runtime.app.pools)
                updated = str(content_block_id('更新后的财政预算。'))
                resolved = await wiki.resolve_scope(client,base,['102.md'])
                assert updated in resolved and ids[0] in resolved  # history retained
                body = await wiki._get_json(client,base+'/api/blocks/'+updated+'?include=markdown')
                assert body['markdown']=='更新后的财政预算。'
                assert config['postgres']['port']==port
                from knowledge_scope_checks import exercise_scope
                await exercise_scope(runtime)
                # Native folder import must recurse and switch the displayed tree.
                nested = tmp_path / 'second-library' / '中文目录' / 'deeper'
                nested.mkdir(parents=True)
                (nested / 'notes.MD').write_text('Recursive import fixture', encoding='utf-8')
                (nested / 'more.markdown').write_text('Another nested document', encoding='utf-8')
                (nested / 'ignore.pdf').write_bytes(b'not imported')
                updates = []
                result = await import_directory(tmp_path / 'second-library', runtime.app.pools, progress=updates.append)
                assert result['documents'] == 2 and result['skipped'] == 1
                assert updates[-1]['completed'] == updates[-1]['total'] == 2
                imported = await wiki._get_json(client, base+'/api/tree?kind=file')
                assert {item['path'] for item in imported['items']} == {'中文目录/deeper/notes.MD', '中文目录/deeper/more.markdown'}
                assert (await wiki.resolve_scope(client, base, ['中文目录/deeper/notes.MD'])) == [str(content_block_id('Recursive import fixture'))]
                empty_folder = tmp_path / 'empty-import'; empty_folder.mkdir()
                with pytest.raises(ValueError, match='没有'):
                    await import_directory(empty_folder, runtime.app.pools)
                assert (await wiki._get_json(client, base+'/api/tree'))['root'] == imported['root']
                assert (await wiki._get_json(client,base+'/api/blocks/'+updated+'?include=markdown'))['markdown']=='更新后的财政预算。'
                from backend.knowledge.positions import index_document, word_id
                location_text = '## 第 12 页\n\n😀研究，研究。'
                location_id = content_block_id(location_text)
                await index_document(runtime.app.pools['wiki'],location_id,location_text)
                term = await wiki._post_json(client,base+'/api/word',{'word':'研究','block_ids':[str(location_id)]})
                assert term['block_id'] == str(word_id('研究'))
                assert term['book_ids'] == [str(location_id)]
                hit = term['occurrences'][0]
                assert hit['line_number']==3 and hit['page']==12
                assert hit['positions']==[{'start':1,'end':3},{'start':4,'end':6}]
                await index_document(runtime.app.pools['wiki'],location_id,location_text)
                assert await runtime.app.pools['wiki'].fetchval('SELECT count(*) FROM word_occurrences WHERE book_id=$1 AND term_id=$2',location_id,word_id('研究')) == 1
                await index_document(runtime.app.pools['wiki'],location_id,'')
                remaining = await runtime.app.pools['wiki'].fetchval('SELECT book_ids FROM word_entities WHERE word=$1','研究')
                assert location_id not in remaining and len(remaining)>=100
                metadata = {'source_paths':['C:/original/book.md','D:/backup/book.md'],'book_links':['https://example.org/book','https://example.org/mirror']}
                assert await wiki._post_json(client,base+'/api/blocks/'+updated,metadata) == metadata
                full = await wiki._get_json(client,base+'/api/blocks/'+updated+'?include=markdown')
                assert full['source_paths']==metadata['source_paths'] and full['book_links']==metadata['book_links']

            finally:
                await runtime.close()
            assert '_knowledge' not in config
            from urllib.parse import urlparse
            with socket.socket() as check:
                assert check.connect_ex(('127.0.0.1', urlparse(runtime.scope_url).port)) != 0
            restarted = KnowledgeRuntime(config)
            try:
                await restarted.start()
                await restarted.start_scope()
                response = await AsyncHTTPClient().fetch(restarted.scope_url+'/api/scope/thread-b')
                assert json.loads(response.body)['paths'] == ['000.md']
            finally:
                await restarted.close()
        asyncio.run(exercise())
    finally:
        pg.stop()


def test_config_backwards_compatibility(tmp_path):
    config = {'data_dir': tmp_path}
    assert wiki.load_config(config)['provider']=='builtin'
    (tmp_path/'.wiki-server.json').write_text(json.dumps({'enabled':True,'base_url':'http://127.0.0.1:9999'}))
    assert wiki.load_config(config)['provider']=='external'
    wiki.save_config(config,{'provider':'builtin','enabled':True})
    assert wiki.load_config(config)['provider']=='builtin'
