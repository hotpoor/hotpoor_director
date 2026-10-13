import io
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from backend.knowledge import services


@pytest.mark.parametrize('platform,binary', [('win32', 'qdrant.exe'), ('darwin', 'qdrant')])
def test_qdrant_launch_uses_platform_binary_and_background_options(tmp_path, monkeypatch, platform, binary):
    (tmp_path / 'bin').mkdir()
    (tmp_path / 'bin' / binary).touch()
    (tmp_path / 'config.yaml').write_text('service: {}')
    monkeypatch.setattr(services.sys, 'platform', platform)
    monkeypatch.setattr(services.subprocess, 'CREATE_NO_WINDOW', 0x08000000, raising=False)
    responses = iter([OSError('offline'), io.BytesIO(b'{"title":"qdrant - vector search engine"}')])

    def open_url(*args, **kwargs):
        result = next(responses)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(services.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=open_url))
    launch = Mock(return_value=SimpleNamespace(pid=123, poll=lambda: None))
    monkeypatch.setattr(services.subprocess, 'Popen', launch)
    services.ensure_qdrant(tmp_path)
    args, options = launch.call_args
    assert args[0][0] == str(tmp_path / 'bin' / binary)
    assert options['cwd'] == tmp_path
    if platform == 'win32':
        assert options['creationflags'] == 0x08000000
        assert 'start_new_session' not in options
    else:
        assert options['start_new_session'] is True
        assert 'creationflags' not in options
    assert (tmp_path / 'server.pid').read_text() == '123'


def test_healthy_existing_qdrant_is_not_restarted(tmp_path, monkeypatch):
    monkeypatch.setattr(services.urllib.request, 'build_opener', lambda *args: SimpleNamespace(
        open=lambda *args, **kwargs: io.BytesIO(b'{"title":"qdrant - vector search engine"}')))
    launch = Mock()
    monkeypatch.setattr(services.subprocess, 'Popen', launch)
    services.ensure_qdrant(tmp_path)
    launch.assert_not_called()
