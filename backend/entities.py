"""UUID-routed entities; the main database coordinates cross-shard commits."""
from contextlib import AsyncExitStack, asynccontextmanager
from contextvars import ContextVar

actor_context = ContextVar("director_actor", default=None)
import re
import uuid
import time
from psycopg.types.json import Jsonb

from psycopg import sql

LOCK = 804512321
PREFIX = 'director_entities_'


def shard_index(block_id):
    if not isinstance(block_id, str) or not re.fullmatch('[0-9a-f]{32}', block_id):
        raise ValueError('Entity ID must be a lowercase 32-character UUID')
    return int(block_id, 16) % 2


class EntityStore:
    def __init__(self, index_pool, shard_pools):
        self.index_pool = index_pool
        self.shard_pools = tuple(shard_pools)
        if len(self.shard_pools) != 2:
            raise ValueError('Exactly two entity shards are required')

    @asynccontextmanager
    async def connection(self):
        # Serialize entity transactions across processes. This also prevents a
        # recovery pass from rolling back another process's prepared transaction.
        async with self.index_pool.connection() as index:
            await index.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
            await index.commit()
            try:
                async with AsyncExitStack() as stack:
                    connections = [await stack.enter_async_context(p.connection()) for p in self.shard_pools]
                    await self.recover(index, connections)
                    tx = EntityTransaction(connections)
                    try:
                        yield tx
                    except BaseException:
                        for number in tx.used:
                            await connections[number].tpc_rollback()
                        raise
                    else:
                        if len(tx.used) == 1 or not tx.writes:
                            for number in tx.used:
                                await connections[number].tpc_commit()
                        elif tx.used:
                            # Persist the commit decision only after both shards
                            # are prepared. Recovery handles interrupted commits.
                            try:
                                for number in tx.used:
                                    await connections[number].tpc_prepare()
                                await index.execute('INSERT INTO index_entity_commits(transaction_id) VALUES (%s)', (tx.identifier,))
                                await index.commit()
                            except BaseException:
                                # An uncertain index commit must be resolved by
                                # recovery, never by blindly rolling back shards.
                                for conn in connections:
                                    await conn.close()
                                raise
                            try:
                                for number in tx.used:
                                    await connections[number].tpc_commit()
                                await index.execute('DELETE FROM index_entity_commits WHERE transaction_id=%s', (tx.identifier,))
                                await index.commit()
                            except BaseException:
                                for conn in connections:
                                    await conn.close()
                                raise
            finally:
                await index.rollback()
                await index.execute('SELECT pg_advisory_unlock(%s)', (LOCK,))
                await index.commit()

    @staticmethod
    async def recover(index, connections):
        decisions = {r['transaction_id'] for r in await (await index.execute('SELECT transaction_id FROM index_entity_commits')).fetchall()}
        await index.commit()
        for conn in connections:
            pending = await (await conn.execute("SELECT gid FROM pg_prepared_xacts WHERE database=current_database() AND left(gid,%s)=%s", (len(PREFIX), PREFIX))).fetchall()
            await conn.commit()
            await conn.set_autocommit(True)
            try:
                for row in pending:
                    gid = row['gid']
                    command = 'COMMIT PREPARED {}' if gid.rsplit('_', 1)[0] in decisions else 'ROLLBACK PREPARED {}'
                    await conn.execute(sql.SQL(command).format(sql.Literal(gid)))
            finally:
                await conn.set_autocommit(False)
        await index.execute('DELETE FROM index_entity_commits')
        await index.commit()


class EntityTransaction:
    def __init__(self, connections):
        self.connections = connections
        self.used = set()
        self.writes = False
        self.identifier = PREFIX + uuid.uuid4().hex

    async def _connection(self, number):
        if number not in self.used:
            await self.connections[number].tpc_begin(self.identifier + '_' + str(number))
            self.used.add(number)
        return self.connections[number]

    async def execute(self, query, params=None, *, block_id):
        writing = not query.lstrip().upper().startswith('SELECT ')
        if writing:
            self.writes = True
        conn = await self._connection(shard_index(block_id))
        before = None
        if writing:
            before = await (await conn.execute('SELECT body FROM entities WHERE block_id=%s', (block_id,))).fetchone()
        result = await conn.execute(query, params)
        if writing:
            after = await (await conn.execute('SELECT body FROM entities WHERE block_id=%s', (block_id,))).fetchone()
            old, new = (before or {}).get('body'), (after or {}).get('body')
            body = new or old or {}
            if old != new and body.get('kind') in ('project', 'chat', 'chat_pack', 'generation', 'asset', 'cloud_upload'):
                event_id = uuid.uuid4().hex
                # Audit and entity are always written to the same shard/transaction.
                event_id = event_id[:-1] + block_id[-1]
                await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s)', (event_id, Jsonb({
                    'kind': 'change_event', 'owner_id': body['owner_id'], 'entity_id': block_id,
                    'project_id': block_id if body['kind'] == 'project' else body.get('project_id'),
                    'recorded_at': time.time_ns() // 1_000_000, 'actor': actor_context.get() or body.get('created_by'),
                    'operation': 'create' if old is None else 'delete' if new is None else 'update',
                    'before': old, 'after': new})))
        return result

    async def scan(self, query, params=None, *, order_by=None):
        if not query.lstrip().upper().startswith('SELECT '):
            raise ValueError('Cross-shard scans must be SELECT queries')
        rows = []
        for number in range(2):
            conn = await self._connection(number)
            rows.extend(await (await conn.execute(query, params)).fetchall())
        if order_by:
            rows.sort(key=lambda r: (r[order_by], r.get('block_id', '')), reverse=True)
        return EntityRows(rows)


class EntityRows:
    def __init__(self, rows):
        self.rows = iter(rows)

    async def fetchone(self):
        return next(self.rows, None)

    async def fetchall(self):
        return list(self.rows)
