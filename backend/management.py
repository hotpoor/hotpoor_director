"""Independent management credentials and documented read-only organization reports."""
import asyncio
from datetime import date, datetime, timezone
import json
import time
import uuid
from urllib.parse import urlencode

import tornado.web

from backend.workspace import PrivateHandler
from backend.inference import api, ProviderError, key_profile, save_keys, load_keys, enabled_ids
from backend.billing import amount

FILE = '.service-inference-management.json'
PERIODS = ('all', '24h', '7d', '14d', '30d', '90d')


def load(config):
    path = config['data_dir'] / FILE
    return json.loads(path.read_text()) if path.exists() else {'active_key_id': None, 'keys': []}


def view(value):
    return {'configured': bool(enabled_ids(value)), 'active_key_id': value['active_key_id'], 'enabled_key_ids': enabled_ids(value),
            'keys': [{k: p.get(k) for k in ('id', 'name', 'organization_id', 'checked_at')} for p in value['keys']]}


def valid_key(value):
    if not isinstance(value, str) or not value.strip().startswith('sk-mgmt-v1-') or not 20 <= len(value.strip()) <= 4096 or any(c.isspace() for c in value.strip()):
        raise tornado.web.HTTPError(400, reason='请输入独立的管理 AK（sk-mgmt-v1-…），生成 AK 不能用于管理 API')
    return value.strip()


async def identity(key):
    result = await api(key, '/manage/whoami')
    org = result.get('organizationId')
    if not isinstance(org, str) or not 1 <= len(org) <= 200:
        raise ProviderError('管理 API 未返回有效组织 ID')
    return org


class ManagementSettingsHandler(PrivateHandler):
    async def get(self):
        self.finish(view(load(self.settings['config'])))

    async def post(self):
        config = self.settings['config']; data = self.data()
        async with self.settings['inference_manager'].lock:
            value = load(config); value['enabled_key_ids'] = enabled_ids(value); action = data.get('action', 'save')
            profile = key_profile(value, data.get('id', ''))
            if action in ('select', 'delete', 'enable') and not profile:
                raise tornado.web.HTTPError(404, reason='管理 AK 配置不存在')
            if action == 'enable':
                if not isinstance(data.get('enabled'), bool):
                    raise tornado.web.HTTPError(400, reason='启用状态需为布尔值')
                if data['enabled']:
                    try: org = await identity(profile['api_key'])
                    except ProviderError as error: raise tornado.web.HTTPError(502, reason=str(error))
                    if org != profile.get('organization_id'):
                        raise tornado.web.HTTPError(409, reason='管理 AK 组织已变化，请重新编辑验证')
                    if profile['id'] not in value['enabled_key_ids']: value['enabled_key_ids'].append(profile['id'])
                else: value['enabled_key_ids'] = [i for i in value['enabled_key_ids'] if i != profile['id']]
                if value['active_key_id'] not in value['enabled_key_ids']: value['active_key_id'] = next(iter(value['enabled_key_ids']), None)
            elif action == 'delete':
                if any(p.get('management_key_id') == profile['id'] for p in load_keys(config)['keys']):
                    raise tornado.web.HTTPError(409, reason='此管理 AK 已绑定生成 AK，请先在生成 AK 配置中改绑其他管理 AK')
                value['keys'].remove(profile)
                value['enabled_key_ids'] = [i for i in value['enabled_key_ids'] if i != profile['id']]
                if value['active_key_id'] == profile['id']:
                    value['active_key_id'] = None
            elif action in ('save', 'select'):
                if action == 'save':
                    name = data.get('name') or (profile['name'] if profile else '新管理 AK')
                    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                        raise tornado.web.HTTPError(400, reason='名称需为 1–80 个字符')
                    key = valid_key(data.get('api_key') or (profile['api_key'] if profile else ''))
                    if any(p['api_key'] == key and p is not profile for p in value['keys']):
                        raise tornado.web.HTTPError(400, reason='此管理 AK 已保存，请选择已有配置')
                    if not profile:
                        if len(value['keys']) >= 30:
                            raise tornado.web.HTTPError(400, reason='最多保存 30 个管理 AK')
                        profile = {'id': uuid.uuid4().hex}; value['keys'].append(profile)
                    profile.update(name=name.strip(), api_key=key)
                try:
                    org = await identity(profile['api_key'])
                except ProviderError as error:
                    raise tornado.web.HTTPError(502, reason=str(error))
                if profile.get('organization_id') and profile['organization_id'] != org and any(p.get('management_key_id') == profile['id'] for p in load_keys(config)['keys']):
                    raise tornado.web.HTTPError(409, reason='绑定中的管理 AK 不能更换组织，请新增管理 AK 后改绑生成 AK')
                profile.update(organization_id=org, checked_at=int(time.time() * 1000))
                value['active_key_id'] = profile['id']
                if profile['id'] not in value['enabled_key_ids']: value['enabled_key_ids'].append(profile['id'])
            else:
                raise tornado.web.HTTPError(400, reason='未知配置操作')
            save_keys(config, value, FILE)
        self.finish(view(value))


class ManagementTestHandler(PrivateHandler):
    async def post(self):
        data = self.data(); value = load(self.settings['config'])
        profile = key_profile(value, data.get('id', ''))
        key = valid_key(data.get('api_key') or (profile['api_key'] if profile else ''))
        try:
            org = await identity(key)
        except ProviderError as error:
            raise tornado.web.HTTPError(502, reason=str(error))
        self.finish({'ok': True, 'organization_id': org})


class ManagementReportHandler(PrivateHandler):
    async def get(self):
        config = self.settings['config']; value = load(config)
        generation_id = self.get_argument('generation_key_id', '')
        if generation_id:
            generation = key_profile(load_keys(config), generation_id)
            if not generation:
                raise tornado.web.HTTPError(404, reason='生成 AK 配置不存在')
            binding = generation.get('management_key_id')
            if not binding:
                raise tornado.web.HTTPError(400, reason='此生成 AK 尚未绑定管理 AK，请编辑配置并选择管理 AK')
            profile = key_profile(value, binding)
        else:
            profile = next((p for p in value['keys'] if p['id'] in enabled_ids(value)), None)
        if profile and profile['id'] not in enabled_ids(value):
            raise tornado.web.HTTPError(400, reason='绑定的管理 AK 未启用，请在设置中勾选启用')
        if not profile:
            raise tornado.web.HTTPError(400, reason='请先配置并启用管理 AK')
        period = self.get_argument('period', 'all')
        if period not in PERIODS:
            raise tornado.web.HTTPError(400, reason='不支持的汇总周期')
        query = {'from': '1970-01-01', 'to': datetime.now(timezone.utc).date().isoformat()} if period == 'all' else {'period': period}
        start = self.get_argument('from', ''); end = self.get_argument('to', '')
        if start or end:
            try:
                if len(start) != 10 or len(end) != 10 or date.fromisoformat(start) > date.fromisoformat(end):
                    raise ValueError()
            except ValueError:
                raise tornado.web.HTTPError(400, reason='请提供有效的开始、结束日期（UTC）')
            query = {'from': start, 'to': end}
        suffix = '?' + urlencode(query)
        if generation_id:
            self.finish(await self.report_profile(profile, suffix)); return
        organizations={}
        for p in value['keys']:
            if p['id'] in enabled_ids(value): organizations.setdefault(p['organization_id'],p)
        reports=await asyncio.gather(*(self.report_profile(p,suffix) for p in organizations.values()),return_exceptions=True)
        for r in reports:
            if isinstance(r,BaseException): raise r
        result=dict(reports[0]) if len(reports)==1 else {}
        result.update(reports=reports, organization_count=len(reports), total_cost_usd=str(sum(amount(r['total_cost_usd']) for r in reports)))
        self.finish(result)

    async def report_profile(self, profile, suffix):
        results = await asyncio.gather(*(api(profile['api_key'], path + suffix) for path in
            ('/manage/cost/summary', '/manage/cost/breakdown', '/manage/cost/by-key')), return_exceptions=True)
        for result in results:
            if isinstance(result, ProviderError):
                raise tornado.web.HTTPError(502, reason=str(result))
            if isinstance(result, BaseException):
                raise result
        summary, models, keys = results
        total = amount(summary.get('totalCostUsd'))
        if total is None:
            raise tornado.web.HTTPError(502, reason='管理 API 未返回有效费用汇总')
        def rows(source, identifier):
            if not isinstance(source, list):
                raise tornado.web.HTTPError(502, reason='管理 API 费用明细格式不正确')
            return [{identifier: str(r.get(identifier, ''))[:200], 'total_cost_usd': str(amount(r['totalCostUsd']))}
                    for r in source if isinstance(r, dict) and amount(r.get('totalCostUsd')) is not None]
        return {'key_id': profile['id'], 'key_name': profile['name'], 'organization_id': profile['organization_id'],
                     'total_cost_usd': str(total), 'unpriced_count': summary.get('unpricedCount'),
                     'from': summary.get('from'), 'to': summary.get('to'), 'timezone': 'UTC',
                     'by_model': rows(models.get('breakdown'), 'model'),
                     'by_key': rows(keys.get('rows'), 'apiKeyId'), 'by_key_approximate': True}
