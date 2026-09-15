from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from backend.config import DATABASES, connection_kwargs

SCHEMA = Path(__file__).parent / 'schema'


def initialize(config):
    from backend.entities import LOCK
    pg = config['postgres']
    with psycopg.connect(**connection_kwargs(config, 'postgres', admin=True), autocommit=True) as conn:
        conn.execute('SELECT pg_advisory_lock(804512319)')
        try:
            if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (pg['user'],)).fetchone():
                conn.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(
                    sql.Identifier(pg['user']), sql.Literal(pg['password'])))
            for database in DATABASES:
                if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (database,)).fetchone():
                    conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
            with psycopg.connect(**connection_kwargs(config, DATABASES[0], admin=True), autocommit=True) as index:
                index.execute('SELECT pg_advisory_lock(%s)', (LOCK,))
                try:
                    if int(index.execute('SHOW max_prepared_transactions').fetchone()[0]) < 2:
                        raise RuntimeError('UUID sharding requires max_prepared_transactions >= 2 (recommended: 32). Stop the app and restart PostgreSQL with this setting.')
                    # Prepared transactions retain table locks. Recover BEFORE
                    # any shard DDL, otherwise startup can wait on them forever.
                    if index.execute("SELECT to_regclass('index_entity_commits')").fetchone()[0]:
                        recover_entity_transactions(config, index)
                    for database in DATABASES:
                        with psycopg.connect(**connection_kwargs(config, database, admin=True)) as db:
                            db.execute((SCHEMA / 'common.sql').read_text())
                            db.execute((SCHEMA / ('auth.sql' if database == DATABASES[0] else 'entities.sql')).read_text())
                            db.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
                            db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(database), sql.Identifier(pg['user'])))
                            db.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(pg['user'])))
                            db.execute(sql.SQL('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}').format(sql.Identifier(pg['user'])))
                    migrate_entity_shards(config, index)
                finally:
                    index.execute('SELECT pg_advisory_unlock(%s)', (LOCK,))
        finally:
            conn.execute('SELECT pg_advisory_unlock(804512319)')


def recover_entity_transactions(config, index):
    from backend.entities import PREFIX
    decisions = {r[0] for r in index.execute('SELECT transaction_id FROM index_entity_commits').fetchall()}
    for database in DATABASES[1:]:
        with psycopg.connect(**connection_kwargs(config, database, admin=True), autocommit=True) as shard:
            for (gid,) in shard.execute("SELECT gid FROM pg_prepared_xacts WHERE database=current_database() AND left(gid,%s)=%s", (len(PREFIX), PREFIX)).fetchall():
                command = 'COMMIT PREPARED {}' if gid.rsplit('_', 1)[0] in decisions else 'ROLLBACK PREPARED {}'
                shard.execute(sql.SQL(command).format(sql.Literal(gid)))
    index.execute('DELETE FROM index_entity_commits')


def make_pool(config, database=DATABASES[0]):
    return AsyncConnectionPool(kwargs={**connection_kwargs(config, database), 'row_factory': dict_row},
                               min_size=1, max_size=8, timeout=10, open=False)


def migrate_entity_shards(config, index):
    """Run under the entity advisory lock, before serving any requests.

    Copy and verify each misplaced record before removing its old copy. An
    interrupted move leaves identical copies which the next run can finish.
    Conflicting IDs stop migration without overwriting either record.
    """
    import json
    import time
    from contextlib import ExitStack
    from psycopg.types.json import Jsonb
    from backend.entities import shard_index

    with ExitStack() as stack:
        shards = [stack.enter_context(psycopg.connect(**connection_kwargs(config, name, admin=True), autocommit=True, row_factory=dict_row)) for name in DATABASES[1:]]
        misplaced = []
        for number, shard in enumerate(shards):
            # UUID parity is completely determined by the last hexadecimal digit.
            digits = '13579bdf' if number == 0 else '02468ace'
            for row in shard.execute('SELECT * FROM entities WHERE strpos(%s,right(block_id,1))>0', (digits,)).fetchall():
                target = shards[shard_index(row['block_id'])]
                existing = target.execute('SELECT * FROM entities WHERE block_id=%s', (row['block_id'],)).fetchone()
                if existing and existing != row:
                    raise RuntimeError(f"Conflicting entity {row['block_id']} in both shards; migration stopped without overwriting it")
                misplaced.append((number, row))
        if misplaced:
            backup_dir = config['data_dir'] / 'backups'
            backup_dir.mkdir(mode=0o700, exist_ok=True)
            backup = backup_dir / f'uuid-shards-{time.time_ns()}.jsonl'
            with backup.open('x', encoding='utf-8') as stream:
                backup.chmod(0o600)
                for number, row in misplaced:
                    stream.write(json.dumps({'database': DATABASES[number + 1], **row}, ensure_ascii=False) + '\n')
                stream.flush()
                import os
                os.fsync(stream.fileno())
            for number, row in misplaced:
                source, target = shards[number], shards[shard_index(row['block_id'])]
                with source.transaction():
                    current = source.execute('SELECT * FROM entities WHERE block_id=%s FOR UPDATE', (row['block_id'],)).fetchone()
                    if current != row:
                        raise RuntimeError('Entity changed during migration; stop other app instances before retrying')
                    with target.transaction():
                        target.execute('INSERT INTO entities(block_id,body,createtime,updatetime) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING', (row['block_id'], Jsonb(row['body']), row['createtime'], row['updatetime']))
                        copied = target.execute('SELECT * FROM entities WHERE block_id=%s FOR UPDATE', (row['block_id'],)).fetchone()
                        if copied != row:
                            raise RuntimeError(f"Conflicting entity {row['block_id']}; source retained")
                    source.execute('DELETE FROM entities WHERE block_id=%s', (row['block_id'],))
        for number, shard in enumerate(shards):
            with shard.transaction():
                shard.execute(sql.SQL('ALTER TABLE entities ALTER COLUMN block_id SET DEFAULT director_entity_uuid({})').format(sql.Literal(number)))
                if not shard.execute("SELECT 1 FROM pg_constraint WHERE conrelid='entities'::regclass AND conname='entities_uuid_shard'").fetchone():
                    digits = '02468ace' if number == 0 else '13579bdf'
                    shard.execute(sql.SQL('ALTER TABLE entities ADD CONSTRAINT entities_uuid_shard CHECK (strpos({},right(block_id,1))>0)').format(sql.Literal(digits)))
