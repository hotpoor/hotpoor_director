import pytest
import tornado.web

from backend.generation import workflow
from backend.h3_options import validate_h3_options, required_h3_nodes


def params(**changes):
    return dict(model='minimax-h3', width=832, height=480, seed=42,
                steps=8, duration=2, prompt='A bird flies.', **changes)


def test_standard_removes_lora_from_both_guider_and_scheduler():
    graph = workflow('video', 'image', params(h3_sampling='standard'), ['first.png', 'last.png'], 'job')
    assert '6' not in graph
    assert graph['7']['inputs']['model'] == graph['10']['inputs']['model'] == ['1', 0]
    assert graph['5']['inputs']['first_frame'] == ['20', 0]
    assert graph['5']['inputs']['last_frame'] == ['23', 0]


@pytest.mark.parametrize('reference', [False, True])
@pytest.mark.parametrize('scale', [2, 4])
def test_acceleration_and_upscale_keep_source_audio_fps_and_references(reference, scale):
    p = params(h3_sage=True, h3_upscale=scale, h3_sampling='turbo')
    if reference:
        p.update(model='minimax-h3-ref2va', steps=4, turbo_mode=True)
    graph = workflow('video', 'reference' if reference else 'image', p, ['ref.png'], 'job')
    assert graph['16']['inputs']['model'] == ['6', 0]
    assert graph['7']['inputs']['model'] == ['16', 0]
    assert graph['10']['inputs']['model'] == ['6', 0]
    assert graph['17']['inputs']['resize_type.scale'] == scale
    assert graph['17']['inputs']['images'] == graph['14']['inputs']['images'] == ['12', 0]
    assert graph['18']['inputs']['audio'] == graph['14']['inputs']['audio'] == ['13', 0]
    assert graph['18']['inputs']['fps'] == graph['14']['inputs']['fps'] == 24
    assert graph['15']['inputs']['video'] == ['14', 0]
    assert graph['19']['inputs']['filename_prefix'] == f'director/job_rtx{scale}x'
    assert required_h3_nodes(p) == ['PathchSageAttentionKJ', 'RTXVideoSuperResolution']


def test_legacy_requests_and_disabled_options_keep_the_same_graph():
    p = {**params(), 'steps': 12}
    assert workflow('video', 'text', p, [], 'job') == workflow(
        'video', 'text', {**p, 'h3_sampling': 'legacy', 'h3_sage': False, 'h3_upscale': 1}, [], 'job')
    assert validate_h3_options('minimax-h3', {}, 12) == {}


@pytest.mark.parametrize('options', [dict(h3_sampling='bad'), dict(h3_sage='false'),
    dict(h3_upscale=True), dict(h3_upscale=2.5), dict(h3_upscale=8)])
def test_invalid_options_are_rejected(options):
    with pytest.raises(ValueError):
        validate_h3_options('minimax-h3', options, 8)


def test_new_turbo_requests_allow_six_or_eight_steps_only():
    for steps in (6, 8):
        assert validate_h3_options('minimax-h3', {'h3_sampling': 'turbo'}, steps)
    with pytest.raises(tornado.web.HTTPError):
        validate_h3_options('minimax-h3', {'h3_sampling': 'turbo'}, 20)
    with pytest.raises(ValueError):
        validate_h3_options('z-image', {'h3_upscale': 2}, 20)
