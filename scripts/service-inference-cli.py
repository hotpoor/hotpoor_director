#!/usr/bin/env python3
"""Use Director's saved service-inference profiles without exposing their secrets."""
import argparse
import json
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = 'https://model.service-inference.ai'


def data_dir(value):
    if value:
        return Path(value).expanduser().resolve()
    if os.environ.get('DIRECTOR_DATA_DIR'):
        return Path(os.environ['DIRECTOR_DATA_DIR']).expanduser().resolve()
    return Path(__file__).resolve().parent.parent / '.local'


def load(path, fallback):
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f'Director configuration not found: {path}')
    if not isinstance(value, dict):
        raise SystemExit(f'Invalid Director configuration: {path}')
    return value or fallback


def enabled(value):
    ids = value.get('enabled_key_ids')
    return [p for p in value.get('keys', []) if not isinstance(ids, list) or p.get('id') in ids]


def profile(value, selector=None):
    profiles = enabled(value)
    target = selector or value.get('active_key_id')
    match = next((p for p in profiles if p.get('id') == target or p.get('name') == target), None)
    if not match and not selector and len(profiles) == 1:
        match = profiles[0]
    if not match:
        available = ', '.join(str(p.get('name') or p.get('id')) for p in profiles) or 'none'
        raise SystemExit(f'No enabled Director key matched; available profiles: {available}')
    if not isinstance(match.get('api_key'), str) or not match['api_key']:
        raise SystemExit('The selected Director profile has no inference key')
    return match


def request(key, path, body=None):
    headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
               'User-Agent': 'Hotpoor-Director/0.1 service-inference-cli'}
    req = Request(BASE_URL + path, headers=headers,
                  data=None if body is None else json.dumps(body).encode(),
                  method='GET' if body is None else 'POST')
    try:
        with urlopen(req, timeout=300 if body is not None else 45) as response:
            result = json.load(response)
            request_id = response.headers.get('X-Request-Id')
    except HTTPError as error:
        raise SystemExit(f'service-inference HTTP {error.code}; inspect the provider dashboard') from None
    except URLError as error:
        raise SystemExit(f'service-inference connection failed: {error.reason}') from None
    if not isinstance(result, dict) or result.get('error'):
        raise SystemExit('service-inference returned an error or an invalid response')
    if request_id:
        result['_request_id'] = request_id
    return result


def inference_profile(directory, selector):
    return profile(load(directory / '.service-inference.json', {}), selector)


def management_profile(directory, generation):
    binding = generation.get('management_key_id')
    if not binding:
        raise SystemExit('The selected inference profile is not bound to a Director management key')
    value = load(directory / '.service-inference-management.json', {})
    selected = next((p for p in enabled(value) if p.get('id') == binding), None)
    if not selected or not selected.get('api_key'):
        raise SystemExit('The bound Director management key is missing or disabled')
    return selected


def answer(result, endpoint):
    if endpoint == '/v1/responses':
        return ''.join(part.get('text', '') for item in result.get('output', [])
                       if item.get('type') == 'message' and item.get('role') == 'assistant'
                       for part in item.get('content', []) if part.get('type') == 'output_text')
    choices = result.get('choices') or []
    return choices[0].get('message', {}).get('content', '') if choices else ''


def main():
    parser = argparse.ArgumentParser(description='Call service-inference with Hotpoor Director profiles')
    parser.add_argument('--data-dir', help='Director data directory; defaults to DIRECTOR_DATA_DIR or repo .local')
    parser.add_argument('--key', help='enabled inference profile id or name; defaults to Director active profile')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('profiles', help='list enabled Director profiles without revealing keys')
    sub.add_parser('models', help='list models visible to the selected inference profile')
    chat = sub.add_parser('chat', help='send one text prompt and print answer, usage, and request id')
    chat.add_argument('--model', required=True)
    chat.add_argument('--prompt', help='prompt text; reads stdin when omitted')
    chat.add_argument('--system')
    chat.add_argument('--endpoint', choices=('auto', 'chat', 'responses'), default='auto')
    cost = sub.add_parser('cost', help='read provider-reported spend for the bound management profile')
    cost.add_argument('--period', choices=('24h', '7d', '14d', '30d', '90d'), default='30d')
    sub.add_parser('balance', help='read provider-reported billing balance')
    args = parser.parse_args()
    directory = data_dir(args.data_dir)
    inference = load(directory / '.service-inference.json', {})
    if args.command == 'profiles':
        output = {'active_key_id': inference.get('active_key_id'), 'profiles': [
            {'id': p.get('id'), 'name': p.get('name'), 'model_count': len(p.get('models') or []),
             'models_checked_at': p.get('models_checked_at'), 'management_bound': bool(p.get('management_key_id'))}
            for p in enabled(inference)]}
        print(json.dumps(output, ensure_ascii=False, indent=2)); return
    generation = profile(inference, args.key)
    if args.command == 'models':
        result = request(generation['api_key'], '/v1/models')
        output = {'key_id': generation.get('id'), 'key_name': generation.get('name'), 'models': result.get('data', [])}
    elif args.command == 'chat':
        prompt = args.prompt if args.prompt is not None else sys.stdin.read()
        if not prompt.strip():
            raise SystemExit('Prompt is empty')
        endpoint = '/v1/responses' if args.endpoint == 'responses' or args.endpoint == 'auto' and args.model.startswith('gpt-6') else '/v1/chat/completions'
        messages = ([{'role': 'system', 'content': args.system}] if args.system else []) + [{'role': 'user', 'content': prompt}]
        body = {'model': args.model, 'stream': False, 'input' if endpoint == '/v1/responses' else 'messages': messages}
        result = request(generation['api_key'], endpoint, body)
        output = {'model': args.model, 'key_id': generation.get('id'), 'key_name': generation.get('name'),
                  'answer': answer(result, endpoint), 'usage': result.get('usage'), 'request_id': result.get('_request_id')}
    else:
        management = management_profile(directory, generation)
        if args.command == 'balance':
            output = request(management['api_key'], '/manage/billing/balance')
        else:
            query = urlencode({'period': args.period})
            summary = request(management['api_key'], '/manage/cost/summary?' + query)
            breakdown = request(management['api_key'], '/manage/cost/breakdown?' + query)
            by_key = request(management['api_key'], '/manage/cost/by-key?' + query)
            output = {'key_id': generation.get('id'), 'key_name': generation.get('name'),
                      'summary': summary, 'by_model': breakdown.get('breakdown', []),
                      'by_key': by_key.get('rows', []), 'by_key_approximate': by_key.get('approximate', True)}
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
