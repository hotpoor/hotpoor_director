import argparse
import asyncio
import getpass
import json
import os
import signal
import sys
import threading

import tornado.httpserver
import tornado.netutil

from backend.auth import create_user
from backend.config import load_config
from backend.database import initialize, make_pool
from backend.postgres import Postgres
from backend.server import application


async def run(args):
    config = load_config()
    config['development'] = args.dev
    postgres = Postgres(config)
    pool = None
    entity_pools = []
    server = None
    app = None
    try:
        await asyncio.to_thread(postgres.start)
        await asyncio.to_thread(initialize, config)
        pool = make_pool(config)
        await pool.open(wait=True)
        if args.command == 'init-db':
            print('Three databases initialized.', flush=True)
            return
        if args.command == 'create-user':
            login = args.login or input('Login: ')
            password = getpass.getpass('Password (12–256 characters): ')
            if password != getpass.getpass('Confirm password: '):
                raise ValueError('Passwords do not match')
            user_id = await create_user(pool, login, password)
            print('User created:', user_id, flush=True)
            return
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stopped.set))
        if args.desktop:
            def read_parent():
                # EOF also stops the owned database if Electron crashes.
                sys.stdin.readline()
                loop.call_soon_threadsafe(stopped.set)
            threading.Thread(target=read_parent, daemon=True).start()
        for database in ('hotpoor_director1', 'hotpoor_director2'):
            entity_pool = make_pool(config, database)
            entity_pools.append(entity_pool)
            await entity_pool.open(wait=True)
        app = application(config, pool, *entity_pools)
        await app.settings['inference_manager'].start()
        server = tornado.httpserver.HTTPServer(app, max_body_size=210 * 1024 * 1024)
        sockets = tornado.netutil.bind_sockets(args.port, '127.0.0.1')
        server.add_sockets(sockets)
        print(json.dumps({'event': 'ready', 'port': sockets[0].getsockname()[1]}), flush=True)
        await stopped.wait()
    finally:
        if server:
            server.stop()
            await server.close_all_connections()
        if app:
            await app.settings['inference_manager'].close()
            await app.settings['progress_tracker'].close()
        if pool:
            await pool.close()
        for entity_pool in entity_pools:
            await entity_pool.close()
        await asyncio.to_thread(postgres.stop)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('serve', 'init-db', 'create-user'), nargs='?', default='serve')
    parser.add_argument('--login')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--desktop', action='store_true')
    parser.add_argument('--dev', action='store_true', help='Disable template and static hash caches for source development')
    args = parser.parse_args()
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(run(args))


if __name__ == '__main__':
    main()
