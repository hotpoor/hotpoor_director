"""Word entities and exact, Unicode-aware Markdown occurrences."""
import asyncio
import hashlib
import json
import re
import uuid
import jieba

VERSION = 1
NAMESPACE = uuid.UUID('f582a4ad-39e9-414d-a970-802c8aa89a26')


def word_id(word):
    return uuid.uuid5(NAMESPACE, word)


def source_lines(book_id, text):
    offset = 0
    page = None
    paragraph = None
    used = set()
    for number, raw in enumerate(text.splitlines(keepends=True), 1):
        line = raw.rstrip('\r\n')
        seed = f'{book_id}:{number}:{line}'
        short = hashlib.md5(seed.encode()).hexdigest()[:6]
        attempt = 0
        while short in used:
            attempt += 1
            short = hashlib.md5(f'{seed}:{attempt}'.encode()).hexdigest()[:6]
        used.add(short)
        ident = f'{book_id}_{short}'
        match = re.fullmatch(r'\s*##\s+第\s*(\d+)\s*页\s*', line)
        anchor = re.search(r'<a\s+id=["\']page-(\d+)["\']', line)
        if match or anchor:
            page = int((match or anchor).group(1))
            paragraph = None
        if line.strip() and paragraph is None:
            paragraph = ident
        yield {'line_id': ident, 'line_number': number, 'text': line,
               'char_start': offset, 'char_end': offset + len(line),
               'page': page, 'paragraph_id': paragraph,
               'kind': 'image' if re.search(r'!\[[^]]*\]\([^)]+\)', line) else 'text'}
        if not line.strip():
            paragraph = None
        offset += len(raw)


def document_positions(book_id, text):
    records = []
    for line in source_lines(book_id, text):
        # Tokenize original text so lowercasing cannot shift Unicode offsets.
        found = {}
        for token, start, end in jieba.tokenize(line['text']):
            if not token.strip():
                continue
            word = token.lower()
            found.setdefault(word, []).append({'start': start, 'end': end})
        for word, positions in found.items():
            records.append((word_id(word), word, uuid.UUID(str(book_id)), line['line_id'],
                            line['line_number'], line['page'], line['paragraph_id'],
                            line['char_start'], json.dumps(positions), line['kind']))
    return records


async def index_document(pool, book_id, text):
    book_id = uuid.UUID(str(book_id))
    records = await asyncio.to_thread(document_positions, book_id, text)
    words = {r[1]: r[0] for r in records}
    async with pool.acquire() as db, db.transaction():
        # Serializes import/backfill and keeps book_ids consistent with occurrences.
        await db.execute('SELECT pg_advisory_xact_lock(804512321)')
        old = set(await db.fetchval('SELECT array_agg(DISTINCT term_id) FROM word_occurrences WHERE book_id=$1', book_id) or [])
        await db.executemany('INSERT INTO word_entities(block_id,word) VALUES($1,$2) ON CONFLICT(word) DO NOTHING', [(v,k) for k,v in words.items()])
        await db.execute('DELETE FROM word_occurrences WHERE book_id=$1', book_id)
        if records:
            await db.copy_records_to_table('word_occurrences', records=[(r[0], *r[2:]) for r in records],
                columns=['term_id','book_id','line_id','line_number','page','paragraph_id','char_start','positions','kind'])
        affected = list(old | set(words.values()))
        await db.execute("""UPDATE word_entities t SET book_ids=COALESCE(
            (SELECT array_agg(DISTINCT o.book_id ORDER BY o.book_id) FROM word_occurrences o WHERE o.term_id=t.block_id), ARRAY[]::uuid[])
            WHERE t.block_id=ANY($1::uuid[])""", affected)
        await db.execute('DELETE FROM index_search WHERE block_id=$1', book_id)
        await db.executemany('INSERT INTO index_search(word,block_id) VALUES($1,$2)', [(w,book_id) for w in words])
        await db.execute('INSERT INTO positional_documents(book_id,version) VALUES($1,$2) ON CONFLICT(book_id) DO UPDATE SET version=EXCLUDED.version',book_id,VERSION)


async def backfill(pools):
    done = set(await pools['wiki'].fetchval('SELECT array_agg(book_id) FROM positional_documents WHERE version=$1',VERSION) or [])
    roots = []
    for name in ('wiki1','wiki2'):
        trees = await pools[name].fetch("SELECT body FROM entities WHERE body->>'kind'='file_tree'")
        for row in trees:
            body = json.loads(row['body']) if isinstance(row['body'],str) else row['body']
            if body.get('root'):
                roots.append((body['root'],set(body.get('paths',[]))))
    for name in ('wiki1','wiki2'):
        rows = await pools[name].fetch("SELECT block_id,body FROM entities WHERE body->>'kind'='document'")
        for row in rows:
            if row['block_id'] not in done:
                from pathlib import Path
                body = json.loads(row['body']) if isinstance(row['body'],str) else row['body']
                text = body.get('markdown','')
                sources = set(body.get('source_paths',[]))
                for root, paths in roots:
                    for path in set(body.get('paths',[])) & paths:
                        candidate = (Path(root)/path).resolve()
                        if candidate.is_relative_to(Path(root).resolve()):
                            sources.add(str(candidate))
                metadata = {'source_paths':sorted(sources),'book_links':body.get('book_links',[]),
                            'line_blocks':list(source_lines(row['block_id'],text))}
                await pools[name].execute('UPDATE entities SET body=body || $2::jsonb WHERE block_id=$1',row['block_id'],json.dumps(metadata,ensure_ascii=False))
                await index_document(pools['wiki'],row['block_id'],text)


async def matches(pool, book_id, words, offset=0, limit=100):
    args = (uuid.UUID(str(book_id)), list(words))
    total = await pool.fetchval('SELECT count(*) FROM word_occurrences o JOIN word_entities t ON t.block_id=o.term_id WHERE o.book_id=$1 AND t.word=ANY($2::text[])',*args)
    rows = await pool.fetch("""SELECT t.block_id AS term_id,t.word,o.* FROM word_occurrences o
        JOIN word_entities t ON t.block_id=o.term_id WHERE o.book_id=$1 AND t.word=ANY($2::text[])
        ORDER BY o.line_number,t.word LIMIT $3 OFFSET $4""",*args,limit,offset)
    items=[]
    for row in rows:
        item=dict(row)
        item['positions']=json.loads(item['positions']) if isinstance(item['positions'],str) else item['positions']
        item['content_block_id']=item['book_id']
        items.append(item)
    return {'items':items,'total':total,'offset':offset,'has_next':offset+len(items)<total}
