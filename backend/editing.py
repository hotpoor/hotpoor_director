"""Database-backed per-project editing leases, shared across workers and clients."""
import time
import uuid
import re
import tornado.web
from psycopg.types.json import Jsonb

TTL = 15

def presence_id(project_id):
    return uuid.uuid5(uuid.NAMESPACE_URL, 'director:editing:' + project_id).hex

async def read_leases(conn, project_id):
    identifier = presence_id(project_id)
    row = await (await conn.execute('SELECT body FROM entities WHERE block_id=%s FOR UPDATE', (identifier,), block_id=identifier)).fetchone()
    return {k: v for k, v in (row or {}).get('body', {}).get('leases', {}).items() if v['expires'] > time.time()}

def resources(body):
    canvas = body.get('canvas', {})
    result = {'card:' + c['id']: c for c in canvas.get('cards', [])}
    result['timeline:main'] = canvas.get('timeline')
    result.update({'timeline:' + t['id']: t for t in canvas.get('timelines', [])})
    return result

async def check_locks(conn, handler, project_id, before, after):
    leases = await read_leases(conn, project_id)
    old, new = resources(before), resources(after)
    for key in old.keys() | new.keys():
        lease = leases.get(key)
        if old.get(key) != new.get(key) and lease and (lease['user_id'] != handler.user['user_id'] or lease['client'] != handler.request.headers.get('X-Director-Client')):
            raise tornado.web.HTTPError(423, reason=lease['login'] + ' 正在编辑，请稍后再试')

# Imported after PrivateHandler is defined, from workspace_routes.
def handler_class():
    from backend.workspace import PrivateHandler, owned
    class EditingHandler(PrivateHandler):
        async def get(self, project_id):
            project = await owned(self.projects, project_id, self.owner, 'project')
            async with self.projects.connection() as conn:
                leases = await read_leases(conn, project_id)
            self.finish({'leases': leases, 'ttl': TTL, 'revision': project['body'].get('revision', 1)})

        async def post(self, project_id):
            project = await owned(self.projects, project_id, self.owner, 'project')
            data = self.data()
            client = self.request.headers.get('X-Director-Client', '')
            key, action = data.get('resource'), data.get('action')
            if not re.fullmatch('[0-9a-f]{32}', client) or action not in ('claim', 'release') or not isinstance(key, str) or not re.fullmatch(r'(?:card:[0-9a-f]{32}|timeline:(?:main|[0-9a-f]{32}))', key) or (action == 'claim' and key not in resources(project['body'])):
                raise tornado.web.HTTPError(400, reason='编辑锁参数不正确')
            async with self.projects.connection() as conn:
                leases = await read_leases(conn, project_id)
                lease = leases.get(key)
                mine = lease and lease['client'] == client and lease['user_id'] == self.user['user_id']
                if action == 'claim':
                    if lease and not mine:
                        self.set_status(423)
                        self.finish({'error': lease['login'] + ' 正在编辑', 'leases': leases})
                        return
                    leases[key] = {'client': client, 'user_id': self.user['user_id'], 'login': self.user['login'], 'expires': time.time() + TTL}
                elif mine:
                    del leases[key]
                identifier = presence_id(project_id)
                body = {'kind': 'edit_presence', 'owner_id': self.owner, 'project_id': project_id, 'leases': leases}
                await conn.execute('INSERT INTO entities(block_id,body) VALUES (%s,%s) ON CONFLICT (block_id) DO UPDATE SET body=EXCLUDED.body', (identifier, Jsonb(body)), block_id=identifier)
            self.finish({'leases': leases, 'ttl': TTL, 'revision': project['body'].get('revision', 1)})
    return EditingHandler
