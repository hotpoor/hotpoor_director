from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from backend.config import DATABASES, connection_kwargs

SCHEMA = Path(__file__).parent / 'schema'


def initialize(config):
    pg = config['postgres']
    with psycopg.connect(**connection_kwargs(config, 'postgres', admin=True), autocommit=True) as conn:
        # Session advisory lock serializes first launch / migrations across app instances.
        conn.execute('SELECT pg_advisory_lock(804512319)')
        try:
            if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (pg['user'],)).fetchone():
                conn.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(
                    sql.Identifier(pg['user']), sql.Literal(pg['password'])))
            for database in DATABASES:
                if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (database,)).fetchone():
                    conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(database)))
                with psycopg.connect(**connection_kwargs(config, database, admin=True)) as db:
                    db.execute((SCHEMA / 'common.sql').read_text())
                    db.execute((SCHEMA / ('auth.sql' if database == DATABASES[0] else 'entities.sql')).read_text())
                    db.execute('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
                    db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(database), sql.Identifier(pg['user'])))
                    db.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(sql.Identifier(pg['user'])))
                    db.execute(sql.SQL('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}').format(sql.Identifier(pg['user'])))
        finally:
            conn.execute('SELECT pg_advisory_unlock(804512319)')


def make_pool(config, database=DATABASES[0]):
    return AsyncConnectionPool(kwargs={**connection_kwargs(config, database), 'row_factory': dict_row},
                               min_size=1, max_size=8, timeout=10, open=False)
