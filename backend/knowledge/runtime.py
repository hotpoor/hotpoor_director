"""Own the Wiki pools and private HTTP adapter inside the Director process."""
import asyncio
from pathlib import Path
import secrets

import asyncpg
import psycopg
from psycopg import sql
from tornado.httpserver import HTTPServer
from tornado.netutil import bind_sockets

from backend.config import connection_kwargs
from .app import Application

DATABASES = ('wiki', 'wiki1', 'wiki2')


def initialize(config):
    # Separate logical databases preserve native UUIDs and historical references.
    with psycopg.connect(**connection_kwargs(config, 'postgres', admin=True), autocommit=True) as admin:
        admin.execute('SELECT pg_advisory_lock(804512320)')
        try:
            for name in DATABASES:
                if not admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone():
                    admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
                with psycopg.connect(**connection_kwargs(config, name, admin=True)) as db:
                    schema = 'schema.sql' if name == 'wiki' else 'entities.sql'
                    db.execute((Path(__file__).parent / schema).read_text())
                    role = sql.Identifier(config['postgres']['user'])
                    db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(name), role))
                    db.execute(sql.SQL('GRANT USAGE ON SCHEMA public TO {}').format(role))
                    table = 'index_search' if name == 'wiki' else 'entities'
                    db.execute(sql.SQL('GRANT SELECT, INSERT, UPDATE, DELETE ON {} TO {}').format(sql.Identifier(table), role))
                    if name == 'wiki':
                        for extra in ('word_entities', 'word_occurrences', 'positional_documents'):
                            db.execute(sql.SQL('GRANT SELECT, INSERT, UPDATE, DELETE ON {} TO {}').format(sql.Identifier(extra), role))
        finally:
            admin.execute('SELECT pg_advisory_unlock(804512320)')


class KnowledgeRuntime:
    def __init__(self, config):
        self.config = config
        self.app = Application(secrets.token_urlsafe(32), config['data_dir'] / 'knowledge' / 'semantic')
        self.server = None
        self.scope_server = None
        self.scope_url = None

    async def start(self):
        qdrant_home = self.config.get('knowledge', {}).get('qdrant_home')
        if qdrant_home:
            from .services import ensure_qdrant
            await asyncio.to_thread(ensure_qdrant, qdrant_home)
        await asyncio.to_thread(initialize, self.config)
        for name in DATABASES:
            params = connection_kwargs(self.config, name)
            params['database'] = params.pop('dbname')
            params['timeout'] = params.pop('connect_timeout')
            self.app.pools[name] = await asyncpg.create_pool(**params, min_size=1, max_size=4)
        from .positions import backfill
        await backfill(self.app.pools)
        self.server = HTTPServer(self.app, max_body_size=32 * 1024 * 1024)
        sockets = bind_sockets(0, '127.0.0.1')
        self.server.add_sockets(sockets)
        self.config['_knowledge'] = {
            'base_url': f'http://127.0.0.1:{sockets[0].getsockname()[1]}',
            'token': self.app.token,
        }

    async def start_scope(self):
        settings = self.config.get('knowledge', {}).get('codex_scope', {})
        if not settings.get('enabled', False):
            return
        from .scope_server import ScopeApplication
        directory = self.config['data_dir'] / 'knowledge' / 'codex-scopes'
        port = int(settings.get('port', 8890))
        try:
            sockets = bind_sockets(port, '127.0.0.1')
        except OSError as error:
            raise RuntimeError(f'Codex 文献勾选页端口 {port} 被占用；请关闭旧范围服务后重启 Director。') from error
        actual_port = sockets[0].getsockname()[1]
        app = ScopeApplication(self.config['_knowledge'], directory, port=actual_port)
        self.scope_server = HTTPServer(app, max_body_size=32 * 1024 * 1024)
        self.scope_server.add_sockets(sockets)
        self.scope_url = f'http://127.0.0.1:{actual_port}'

    async def close(self):
        if self.scope_server:
            self.scope_server.stop()
            await self.scope_server.close_all_connections()
        if self.server:
            self.server.stop()
            await self.server.close_all_connections()
        job = self.app.semantic.job
        if job and not job.done():
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)
        if self.app.semantic.client:
            await asyncio.to_thread(self.app.semantic.client.close)
        for pool in self.app.pools.values():
            await pool.close()
        self.config.pop('_knowledge', None)
