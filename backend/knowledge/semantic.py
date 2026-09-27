"""Scoped, persistent passage embeddings; no silent lexical-only fallback."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import uuid

from tornado.httpclient import AsyncHTTPClient
from qdrant_client import QdrantClient, models

# Load NumPy-backed Qdrant dependencies on the main thread at startup.
# First importing them inside an executor can stall Windows DLL initialization.

MODEL = os.getenv('WIKI_EMBED_MODEL', 'bge-m3')
OLLAMA = os.getenv('WIKI_OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')
QDRANT_URL = os.getenv('QDRANT_URL', 'http://127.0.0.1:6333')
COLLECTION = 'wiki_passages_v1'
CHUNK_SIZE = 1800
OVERLAP = 240


def passages(lines):
    """Cover every character, including very long lines; preserve source positions."""
    text = '\n'.join(line['text'] for line in lines)
    starts = []
    pos = 0
    for line in lines:
        starts.append(pos)
        pos += len(line['text']) + 1
    import bisect
    for start in range(0, len(text), CHUNK_SIZE - OVERLAP):
        end = min(len(text), start + CHUNK_SIZE)
        if text[start:end].strip():
            yield {'text': text[start:end], 'char_start': start, 'char_end': end,
                   'line_start': bisect.bisect_right(starts, start),
                   'line_end': bisect.bisect_right(starts, end - 1)}
        if end == len(text):
            break


class Semantic:
    def __init__(self, root):
        self.root = Path(root)
        self.client = None
        self.lock = asyncio.Lock()
        self.job = None
        self.progress = {'state': 'idle'}
        self.signature = None
        self.manifest = {}

    async def embed(self, texts):
        r = await AsyncHTTPClient().fetch(OLLAMA + '/api/embed', method='POST',
            headers={'Content-Type': 'application/json'},
            body=json.dumps({'model': MODEL, 'input': texts, 'truncate': False}), request_timeout=180)
        vectors = json.loads(r.body)['embeddings']
        if len(vectors) != len(texts) or any(len(v) != len(vectors[0]) for v in vectors):
            raise ValueError('Embedding response incomplete')
        return vectors

    async def initialize(self):
        if self.client is not None:
            return
        # Pin the local model digest so updated models cannot reuse incompatible vectors.
        response = await AsyncHTTPClient().fetch(OLLAMA + '/api/tags', request_timeout=20)
        models = json.loads(response.body)['models']
        model = next((m for m in models if m['name'] in (MODEL, MODEL + ':latest')), None)
        if model is None:
            raise ValueError('Local embedding model is not installed: ' + MODEL)
        self.signature = MODEL + ':' + model['digest'] + ':1800:240:v1'
        self.root.mkdir(parents=True, exist_ok=True)
        manifest_path = self.root / 'manifest.json'
        saved = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        if saved and saved.get('signature') != self.signature:
            raise ValueError('Embedding model changed; use a new index before searching')
        self.manifest = saved.get('documents', {})
        def open_client():
            client = QdrantClient(url=QDRANT_URL, timeout=60, trust_env=False)
            client.get_collections()
            expected = sum(x['chunks'] for x in self.manifest.values())
            if expected and (not client.collection_exists(COLLECTION) or client.count(COLLECTION, exact=True).count < expected):
                raise ValueError('Qdrant server index incomplete; migrate existing vectors first')
            return client
        self.client = await asyncio.to_thread(open_client)

    def save(self):
        tmp = self.root / 'manifest.tmp'
        tmp.write_text(json.dumps({'signature': self.signature, 'documents': self.manifest}))
        tmp.replace(self.root / 'manifest.json')

    async def status(self, ids):
        async with self.lock:
            await self.initialize()
            missing = [bid for bid in ids if bid not in self.manifest]
            return {'model': MODEL, 'storage': 'qdrant_server', 'qdrant_url': QDRANT_URL, 'selected_documents': len(ids),
                    'indexed_documents': len(ids) - len(missing), 'missing_block_ids': missing,
                    'ready': not missing, 'job': dict(self.progress)}

    async def start(self, ids, pools):
        state = await self.status(ids)
        if state['ready']:
            return state
        if self.job is None or self.job.done():
            self.progress = {'state': 'running', 'total_documents': len(state['missing_block_ids']),
                             'completed_documents': 0, 'completed_chunks': 0}
            self.job = asyncio.create_task(self.build(state['missing_block_ids'], pools))
        return await self.status(ids)

    async def build(self, ids, pools):
        try:
            for bid in ids:
                ident = uuid.UUID(bid)
                row = await pools['wiki1' if ident.int % 2 == 0 else 'wiki2'].fetchrow(
                    "SELECT body FROM entities WHERE block_id=$1 AND body->>'kind'='document'", ident)
                if row is None:
                    raise ValueError('Document missing: ' + bid)
                body = json.loads(row['body']) if isinstance(row['body'], str) else row['body']
                chunks = list(passages(body.get('line_blocks', [])))
                self.progress.update(current_block_id=bid, current_total_chunks=len(chunks), current_completed_chunks=0)
                for offset in range(0, len(chunks), 32):
                    batch = chunks[offset:offset + 32]
                    vectors = await self.embed([x['text'] for x in batch])
                    points = [models.PointStruct(id=str(uuid.uuid5(ident, str(x['char_start']))), vector=v,
                              payload={**x, 'block_id': bid}) for x, v in zip(batch, vectors)]
                    async with self.lock:
                        if not await asyncio.to_thread(self.client.collection_exists, COLLECTION):
                            await asyncio.to_thread(self.client.create_collection, COLLECTION,
                                vectors_config=models.VectorParams(size=len(vectors[0]), distance=models.Distance.COSINE))
                        await asyncio.to_thread(self.client.upsert, COLLECTION, points=points, wait=True)
                    self.progress['completed_chunks'] += len(batch)
                    self.progress['current_completed_chunks'] += len(batch)
                async with self.lock:
                    self.manifest[bid] = {'chunks': len(chunks)}
                    await asyncio.to_thread(self.save)
                self.progress['completed_documents'] += 1
            self.progress['state'] = 'complete'
        except Exception as error:
            self.progress.update(state='failed', error=str(error))

    async def search(self, query, ids, threshold):
        state = await self.status(ids)
        if not state['ready']:
            raise ValueError('Semantic index incomplete; run scope.py index first')
        if not ids or not any(self.manifest[x]['chunks'] for x in ids):
            return []
        vector = (await self.embed([query]))[0]
        query_filter = models.Filter(must=[models.FieldCondition(key='block_id', match=models.MatchAny(any=ids))])
        found = {}
        offset = 0
        async with self.lock:
            while True:
                response = await asyncio.to_thread(self.client.query_points, collection_name=COLLECTION,
                    query=vector, query_filter=query_filter, limit=100, offset=offset,
                    score_threshold=threshold, with_payload=True, search_params=models.SearchParams(exact=True))
                for point in response.points:
                    payload = point.payload
                    bid = payload['block_id']
                    if bid not in found:
                        found[bid] = {'block_id': bid, 'semantic_score': point.score, 'passages': []}
                    if len(found[bid]['passages']) < 3:
                        found[bid]['passages'].append({**payload, 'score': point.score})
                if len(response.points) < 100:
                    break
                offset += len(response.points)
        return sorted(found.values(), key=lambda x: (-x['semantic_score'], x['block_id']))


def fuse(lexical, semantic, k=60):
    """Rank the UNION with RRF; never require a hit in both channels."""
    merged = {}
    for channel, items in [('lexical', lexical), ('semantic', semantic)]:
        seen = set()
        for item in items:
            bid = str(item['block_id'])
            if bid in seen:
                continue
            seen.add(bid)
            target = merged.setdefault(bid, {'block_id': bid, 'score': 0.0, 'channels': []})
            target['channels'].append(channel)
            target[channel + '_rank'] = len(seen)
            target['score'] += 1.0 / (k + len(seen))
            if channel == 'lexical':
                target['lexical_score'] = item['score']
            else:
                target.update(semantic_score=item['semantic_score'], passages=item['passages'])
    return sorted(merged.values(), key=lambda x: (-x['score'], x['block_id']))
