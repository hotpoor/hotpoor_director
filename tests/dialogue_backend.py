"""Real isolated database, deterministic provider replies; no paid API calls."""
import os
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
    if os.environ.get('DIRECTOR_README_SCENES') == '1':
        if data.get('tools'):
            return {'id': 'readme-response', 'status': 'completed', 'output': [
                {'type': 'function_call', 'name': 'run_command', 'call_id': 'readme-call',
                 'arguments': json.dumps({'argv': ['python3', 'summarize.py'], 'cwd': '/demo/project',
                                          'reason': '整理项目中的 Markdown 文档并汇总目录。截图使用模拟输出，不执行真实命令。'})}],
                    'usage': {'input_tokens': 120, 'output_tokens': 60}}
        text = """## 从问题到可追溯的研究资料

先明确研究范围，再整理来源，最后输出带出处的结论。对话与文件保存在当前账号下，可以随时回来继续。

### 资料整理流程

| 阶段 | 操作 | 留下的记录 |
| --- | --- | --- |
| 收集 | 添加文件、粘贴图片或提供问题 | 原始附件与提问 |
| 分析 | 选择 AK 与可用语言模型 | Markdown 回答、用量与上下文 |
| 复核 | 展开目录，定位关键结论 | 来源、疑问与后续问题 |

### 阅读与追踪

- 点击左侧标题目录，跳转到对应段落。
- 使用 **Aa** 调整单条回答字号；折叠后可以拖动卡片大小。
- 展开「本次提交」查看历史轮次、消息数量与请求大小。

### 下一步

补充需要比较的资料，再让模型继续分析。这是一份演示回答，不代表真实模型生成效果。
"""
        return {'status': 'completed', 'output': [{'type': 'message', 'role': 'assistant',
                'content': [{'type': 'output_text', 'text': text}]}],
                'usage': {'input_tokens': 386, 'output_tokens': 524}}
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
