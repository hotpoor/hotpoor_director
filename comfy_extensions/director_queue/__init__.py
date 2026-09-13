from aiohttp import web
from server import PromptServer

from .ordering import reorder_pending

NODE_CLASS_MAPPINGS = {}


@PromptServer.instance.routes.get('/director/queue-capabilities')
async def capabilities(request):
    return web.json_response({'reorder': True, 'version': 1})


@PromptServer.instance.routes.post('/director/queue-order')
async def reorder(request):
    if request.remote not in ('127.0.0.1', '::1'):
        raise web.HTTPForbidden()
    data = await request.json()
    expected, order = data.get('expected'), data.get('order')
    if not all(isinstance(value, list) and all(isinstance(x, str) for x in value) for value in (expected, order)):
        return web.json_response({'error':'队列格式不正确'}, status=400)
    try:
        reorder_pending(PromptServer.instance.prompt_queue, expected, order)
    except ValueError as error:
        return web.json_response({'error':str(error)}, status=409)
    return web.json_response({'reordered': True})

