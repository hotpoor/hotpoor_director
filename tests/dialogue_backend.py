"""Real isolated database, deterministic provider replies; no paid API calls."""
import asyncio
import json
from pathlib import Path
import socket
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.config import load_config
from backend import inference
from backend.__main__ import main
# Force different pack shard parity to exercise the real cross-shard commit path.
from backend import dialogue
from types import SimpleNamespace
import itertools, uuid
ids = itertools.chain(iter([200, 201, 204, 202]), itertools.count(205))
dialogue.uuid = SimpleNamespace(uuid4=lambda: uuid.UUID(int=next(ids)))

config = load_config()
if not (config['data_dir'] / 'postgres').exists():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); config['postgres']['port'] = sock.getsockname()[1]
    (config['data_dir'] / 'config.json').write_text(json.dumps({k: v for k, v in config.items() if k not in ('data_dir', 'pg_bin')}))
inference.save_keys(config, {'active_key_id': 'first', 'enabled_key_ids': ['first', 'second'], 'keys': [
    {'id': 'first', 'name': '创作 AK', 'api_key': 'fixture-first'},
    {'id': 'second', 'name': '讨论 AK', 'api_key': 'fixture-second'},
]})

async def fake_api(key, path, data=None):
    assert key in ('fixture-first', 'fixture-second')
    if path == '/v1/models':
        return {'data': [{'id': 'gpt-6-astra' if key == 'fixture-first' else 'fixture-chat', 'type': 'llm'},
                         {'id': 'fixture-image', 'type': 'image'}]}
    assert path in ('/v1/responses', '/v1/chat/completions')
    assert not {'tools', 'reasoning_effort', 'reasoning'} & data.keys()
    assert data['model'] == ('gpt-6-astra' if key == 'fixture-first' else 'fixture-chat')
    messages = data['input' if path == '/v1/responses' else 'messages']
    assert len(messages) <= 41
    history_kinds = [part['type'] for m in messages if isinstance(m['content'], list) for part in m['content']]
    await asyncio.sleep(.1)
    content = messages[-1]['content']
    kinds = []
    if isinstance(content, list):
        kinds = [part['type'] for part in content]
        content = '\n'.join(part['text'] for part in content if part['type'] in ('text', 'input_text'))
    if content == 'FAIL':
        raise inference.ProviderError('service-inference：余额不足（402）', 402)
    text = f"回答：{content} · 模型 {data['model']} · 上下文 {len(messages)}\n\n<script>alert('unsafe')</script> **已保存**\n\n## 回答摘要\n\n| 项目 | 内容 |\n| --- | --- |\n| 上下文 | 可追溯 |\n\n附件类型 {','.join(kinds)} · 历史附件类型 {','.join(history_kinds)}"
    if path == '/v1/responses':
        return {'status': 'completed', 'output': [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]}], 'usage': {'input_tokens': 10, 'output_tokens': 20}}
    return {'choices': [{'message': {'content': text}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 10, 'completion_tokens': 20}}

inference.api = fake_api
main()
