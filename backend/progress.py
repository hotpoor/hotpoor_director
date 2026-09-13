"""Transient ComfyUI progress; never estimate completion from elapsed time."""
import asyncio
import json
from collections import OrderedDict

from tornado.websocket import websocket_connect


class ProgressTracker:
    def __init__(self, base_url='http://127.0.0.1:8188'):
        self.base_url = base_url
        self.connections = {}
        self.tasks = {}
        self.values = OrderedDict()
        self.lock = asyncio.Lock()

    async def ensure(self, owner):
        async with self.lock:
            if owner in self.connections:
                return
            try:
                connection = await websocket_connect(
                    self.base_url.replace('http://', 'ws://', 1) + '/ws?clientId=director-' + owner,
                    connect_timeout=3, ping_interval=20, ping_timeout=20)
            except Exception:
                # Generation remains usable when progress is unavailable.
                return
            self.connections[owner] = connection
            self.tasks[owner] = asyncio.create_task(self.listen(owner, connection))

    def update(self, owner, event):
        data = event.get('data', {})
        prompt = data.get('prompt_id')
        if not prompt:
            return
        kind = event.get('type')
        if kind not in ('execution_start', 'executing', 'progress', 'execution_success', 'execution_error'):
            return
        value = {'phase': 'running', 'node': data.get('node')}
        if kind == 'progress':
            maximum, current = data.get('max'), data.get('value')
            if not isinstance(maximum, (int, float)) or not isinstance(current, (int, float)) or maximum <= 0:
                return
            value.update(phase='sampling', value=max(0, min(current, maximum)), maximum=maximum)
        elif kind == 'execution_success' or (kind == 'executing' and data.get('node') is None):
            value['phase'] = 'finishing'
        elif kind == 'execution_error':
            value['phase'] = 'error'
        self.values[(owner, prompt)] = value
        self.values.move_to_end((owner, prompt))
        while len(self.values) > 1000:
            self.values.popitem(last=False)

    async def listen(self, owner, connection):
        try:
            while True:
                message = await asyncio.wait_for(connection.read_message(), timeout=300)
                if message is None:
                    break
                if isinstance(message, str):
                    try:
                        self.update(owner, json.loads(message))
                    except (ValueError, TypeError, AttributeError):
                        pass
        except (OSError, asyncio.TimeoutError):
            pass
        finally:
            connection.close()
            self.connections.pop(owner, None)
            self.tasks.pop(owner, None)
            for key in list(self.values):
                if key[0] == owner:
                    del self.values[key]

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for connection in self.connections.values():
            connection.close()
        self.connections.clear()
        self.tasks.clear()
        self.values.clear()
