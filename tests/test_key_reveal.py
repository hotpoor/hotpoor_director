import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from tornado.web import HTTPError

from backend.inference import InferenceSettingsHandler, save_keys
from backend.management import ManagementSettingsHandler, FILE


@pytest.mark.parametrize('handler,filename', [(InferenceSettingsHandler, '.service-inference.json'), (ManagementSettingsHandler, FILE)])
def test_reveal_requires_exact_id_and_does_not_change_settings(tmp_path, handler, filename):
    config = {'data_dir': tmp_path}
    save_keys(config, {'active_key_id': 'first', 'keys': [
        {'id': 'first', 'name': 'First', 'api_key': 'fixture-first'},
        {'id': 'second', 'name': 'Second', 'api_key': 'fixture-second'},
    ]}, filename)
    original = (tmp_path / filename).read_bytes()
    data = {'action': 'reveal', 'id': 'second'}
    h = SimpleNamespace(settings={'config': config, 'inference_manager': SimpleNamespace(lock=asyncio.Lock())},
                        data=lambda: data, finish=Mock(), set_header=Mock())
    asyncio.run(handler.post(h))
    assert h.finish.call_args.args[0] == {'api_key': 'fixture-second'}
    h.set_header.assert_called_with('Cache-Control', 'no-store')
    assert (tmp_path / filename).read_bytes() == original
    for missing in ('', 'unknown'):
        data['id'] = missing
        with pytest.raises(HTTPError) as error:
            asyncio.run(handler.post(h))
        assert error.value.status_code == 404
