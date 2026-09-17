import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest
from tornado.web import HTTPError

from backend.billing import reported_cost, summarize, log_charges
from backend.inference import InferenceCostHandler, InferenceCostImportHandler, InferenceManager, save_key
from test_inference import Pool, job, VIDEO, KEY


@pytest.mark.parametrize('value', [None, True, -1, 'NaN', 'Infinity', {}, 'bad'])
def test_invalid_costs_do_not_become_charges(value):
    assert reported_cost({'task': {'usage': {'cost_usd': value}}}) is None


def test_currency_and_zero_are_explicit():
    assert reported_cost({'task': {'metadata': {'usage': {'cost_usd': 0}}}})['amount'] == '0'
    assert reported_cost({'usage': {'cost': 2}}) is None
    assert reported_cost({'billing': {'cost': '1.25', 'currency': 'CNY'}})['currency'] == 'CNY'


def test_summary_keeps_unknowns_and_currencies_separate():
    rows = [{'body': job(usage={'cost_usd': value})} for value in ('0.1', '0.2', 0, None)]
    rows += [{'body': job(cost={'amount': '2', 'currency': 'CNY'})}, {'body': {'provider': 'comfyui', 'model': 'local'}}]
    result = summarize(rows)
    assert result['totals'] == {'USD': '0.3', 'CNY': '2'}
    assert result['known_count'] == 4 and result['unknown_count'] == 1
    assert result['cloud_count'] == 5 and result['count'] == 6


def record(**fields):
    return dict(method='POST', endpoint='/v2/video/generate', model='dreamina-seedance-2-0-260128-max',
                metadata={'taskId': 'mvt-example'}, requestId='request-example', cost=1.008164,
                usage={'video_tokens': 96475}, dimensions={'bucket': '480p_no_ref'}, **fields)


def test_log_export_ignores_polling_and_duplicate_records():
    original = record()
    polling = dict(original, method='GET', endpoint='/v2/video/tasks/mvt-example', cost=None)
    text = '\n'.join(json.dumps(r) for r in (polling, original, original))
    charges = log_charges(text)
    assert len(charges) == 1
    cost = next(iter(charges.values()))
    assert cost['amount'] == '1.008164' and cost['bucket'] == '480p_no_ref'
    assert float(cost['effective_per_1m_tokens']) == pytest.approx(10.45)


def test_conflicting_export_records_rejected_before_writing():
    original = record()
    with pytest.raises(ValueError):
        log_charges(json.dumps(original) + '\n' + json.dumps(dict(original, cost=3)))
    with pytest.raises(ValueError):
        log_charges('not json')


def test_import_matches_task_and_model_and_is_idempotent(tmp_path):
    body = job(remote_task_id='mvt-example')
    other = job(remote_task_id='mvt-other')
    pool = Pool({'a': {'body': body, 'block_id': 'a'}, 'b': {'body': other, 'block_id': 'b'}})
    manager = InferenceManager({'data_dir': tmp_path}, pool)
    h = SimpleNamespace(projects=None, jobs=pool, owner='owner', settings={'inference_manager': manager},
                        data=lambda: {'text': json.dumps(record())}, finish=Mock())
    with patch('backend.inference.owned', AsyncMock()):
        asyncio.run(InferenceCostImportHandler.post(h, 'project'))
        asyncio.run(InferenceCostImportHandler.post(h, 'project'))
    assert body['cost']['amount'] == '1.008164' and 'cost' not in other
    assert h.finish.call_args.args[0]['matched'] == 1


def test_cost_query_uses_original_key_and_keeps_known_bill_when_not_returned(tmp_path):
    config = {'data_dir': tmp_path}
    save_key(config, KEY)
    body = job(remote_task_id='mvt-example', cost={'amount': '1.25', 'currency': 'USD', 'source': 'provider_log'})
    body['status'] = 'completed'
    row = {'body': body}
    manager = SimpleNamespace(update=AsyncMock())
    h = SimpleNamespace(jobs=None, owner='owner', settings={'config': config, 'inference_manager': manager}, finish=Mock())
    with patch('backend.inference.owned', AsyncMock(return_value=row)), patch('backend.inference.api', AsyncMock(return_value={'task': {'status': 'completed'}})) as api:
        asyncio.run(InferenceCostHandler.post(h, 'a'))
    api.assert_awaited_once_with(KEY, '/v2/video/tasks/mvt-example')
    assert h.finish.call_args.args[0]['cost']['amount'] == '1.25'
    assert not h.finish.call_args.args[0]['reported']
    assert 'cost' not in manager.update.call_args.kwargs


def test_cost_query_does_not_use_another_cloud_owners_key(tmp_path):
    body = job(remote_task_id='mvt-example', credential_owner='other'); body['status'] = 'completed'
    h = SimpleNamespace(jobs=None, owner='owner', settings={'config': {'data_dir': tmp_path, 'cloud_owner': 'owner'}}, finish=Mock())
    with patch('backend.inference.owned', AsyncMock(return_value={'body': body})), patch('backend.inference.api', AsyncMock()) as api, pytest.raises(HTTPError) as error:
        asyncio.run(InferenceCostHandler.post(h, 'a'))
    assert error.value.status_code == 403
    api.assert_not_awaited()


def test_charge_persisted_even_when_video_transfer_fails(tmp_path):
    config = {'data_dir': tmp_path}; save_key(config, KEY)
    body = job(remote_task_id='mvt-example')
    pool = Pool({'a': {'body': body}}); manager = InferenceManager(config, pool)
    response = {'task': {'status': 'completed', 'outputs': ['https://cdn.example/video.mp4'], 'usage': {'cost_usd': '1.25'}}}
    async def fail_then_cancel(*args):
        assert body['cost']['amount'] == '1.25'
        raise asyncio.CancelledError()
    with patch('backend.inference.api', AsyncMock(return_value=response)), patch.object(manager, 'store_outputs', fail_then_cancel), pytest.raises(asyncio.CancelledError):
        asyncio.run(manager.run('a', body, None))
