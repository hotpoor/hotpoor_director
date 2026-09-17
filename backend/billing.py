"""Provider-reported charges only; missing prices never become zero charges."""
from decimal import Decimal, InvalidOperation
import json
import re


def amount(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() and 0 <= result <= Decimal('1e12') else None
    except InvalidOperation:
        return None


def reported_cost(response):
    if not isinstance(response, dict):
        return None
    sources = [response]
    seen = {id(response)}
    for source in sources:
        for name in ('task', 'metadata', 'usage', 'billing'):
            child = source.get(name)
            if isinstance(child, dict) and id(child) not in seen:
                sources.append(child)
                seen.add(id(child))
    for source in sources:
        for field in ('cost_usd', 'costUsd', 'total_cost_usd', 'totalCostUsd'):
            value = amount(source.get(field))
            if value is not None:
                return {'amount': str(value), 'currency': 'USD', 'source': 'provider'}
        currency = source.get('currency')
        if isinstance(currency, str) and re.fullmatch(r'[A-Z]{3}', currency):
            for field in ('cost', 'total_cost'):
                value = amount(source.get(field))
                if value is not None:
                    return {'amount': str(value), 'currency': currency, 'source': 'provider'}
    return None


def job_cost(body):
    cost = body.get('cost')
    if isinstance(cost, dict) and amount(cost.get('amount')) is not None and re.fullmatch(r'[A-Z]{3}', str(cost.get('currency', ''))):
        return cost
    if body.get('provider') == 'service-inference':
        return reported_cost({'usage': body.get('usage'), 'metadata': {'usage': body.get('pending_usage')}})
    return None


def summarize(rows):
    totals = {}
    groups = {}
    known = 0
    cloud = 0
    for row in rows:
        body = row['body']
        is_cloud = body.get('provider') == 'service-inference'
        cloud += int(is_cloud)
        cost = job_cost(body)
        group = groups.setdefault((body.get('provider', 'comfyui'), body.get('model', '')), {'provider': body.get('provider', 'comfyui'), 'model': body.get('model', ''), 'count': 0, 'known_count': 0, 'totals': {}})
        group['count'] += 1
        if cost:
            known += 1
            group['known_count'] += 1
            currency = cost['currency']
            value = amount(cost['amount'])
            totals[currency] = totals.get(currency, Decimal(0)) + value
            group['totals'][currency] = group['totals'].get(currency, Decimal(0)) + value
    for group in groups.values():
        group['totals'] = {k: str(v) for k, v in group['totals'].items()}
    return {'count': len(rows), 'cloud_count': cloud, 'known_count': known,
            'unknown_count': sum(1 for r in rows if r['body'].get('provider') == 'service-inference' and not job_cost(r['body'])),
            'totals': {k: str(v) for k, v in totals.items()}, 'by_model': list(groups.values())}


def log_charges(text):
    """Read the console's NDJSON export, ignoring task polling records."""
    if not isinstance(text, str) or len(text.encode('utf-8')) > 5 * 1024 * 1024:
        raise ValueError('账单文件需小于 5 MB')
    try:
        records = [json.loads(line) for line in text.lstrip('\ufeff').splitlines() if line.strip()]
    except (ValueError, TypeError):
        raise ValueError('请导入控制台「下载 → NDJSON」导出的完整日志文件') from None
    if len(records) > 10000:
        raise ValueError('单次最多导入 10000 条日志，请缩小导出日期范围')
    charges = {}
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('日志文件含有无效记录')
        if record.get('method') != 'POST' or record.get('endpoint') not in ('/v1/video/generate', '/v2/video/generate', '/v1/images/generations'):
            continue
        value = amount(record.get('cost'))
        metadata = record.get('metadata')
        task = metadata.get('taskId') if isinstance(metadata, dict) else None
        request = record.get('requestId')
        model = record.get('model')
        if value is None or not isinstance(model, str):
            continue
        identifier = task if record['endpoint'].endswith('/video/generate') else request
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', identifier):
            continue
        cost = {'amount': str(value), 'currency': 'USD', 'source': 'provider_log'}
        if isinstance(request, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,200}', request):
            cost['request_id'] = request
        bucket = record.get('dimensions', {}).get('bucket') if isinstance(record.get('dimensions'), dict) else None
        if isinstance(bucket, str) and re.fullmatch(r'[a-zA-Z0-9_.-]{1,100}', bucket):
            cost['bucket'] = bucket
        tokens = amount(record.get('usage', {}).get('video_tokens')) if isinstance(record.get('usage'), dict) else None
        if tokens is not None and tokens > 0:
            cost['video_tokens'] = str(tokens)
            cost['effective_per_1m_tokens'] = str(value * 1000000 / tokens)
        key = (identifier, model)
        if key in charges and charges[key] != cost:
            raise ValueError('同一任务存在不同费用记录，请核对导出文件')
        charges[key] = cost
    return charges
