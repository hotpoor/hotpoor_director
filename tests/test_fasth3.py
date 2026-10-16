"""FastH3 is an independent model: no accidental Ref2VA/FL2VA LoRA mixing."""
import pytest
import tornado.web
from backend.generation import MODELS, workflow, size_error
from backend.h3_options import validate_h3_options, required_h3_nodes


def params(**changes):
    return dict(model='minimax-h3-fast', width=448, height=800, seed=2026101701,
                steps=8, duration=5, prompt='A statue awakens.', **changes)


@pytest.mark.parametrize('refs', [[], ['first.png'], ['first.png', 'last.png']])
def test_fast_uses_distilled_weights_and_preserves_frames_audio_and_inputs(refs):
    p = params()
    g = workflow('video', 'image' if refs else 'text', p, refs, 'fast-job')
    assert g['1']['inputs']['unet_name'] == 'fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors'
    assert not any(n['class_type'] == 'LoraLoaderModelOnly' for n in g.values())
    assert g['5']['class_type'] == 'MiniMaxH3ImageToVideo'
    assert g['5']['inputs']['length'] == 124
    assert g['5']['inputs']['prompt'] == p['prompt']
    assert g['8']['inputs']['noise_seed'] == p['seed']
    assert g['7']['inputs']['model'] == g['10']['inputs']['model'] == ['42', 0]
    assert g['7']['inputs']['conditioning'] == ['43', 0]
    assert g['43']['inputs']['positive_conditioning'] == ['5', 0]
    assert g['42']['inputs'] == dict(model=['41', 0], shift_video=10., shift_audio=3.)
    assert g['40']['inputs']['selection'] == 'vsa'
    assert g['40']['inputs']['selection.keep_percent'] == 10.
    assert g['14']['inputs']['audio'] == ['13', 0]
    assert g['14']['inputs']['fps'] == 24
    assert g['15']['inputs']['filename_prefix'] == 'director/fast-job'
    assert ('first_frame' in g['5']['inputs']) == bool(refs)
    assert ('last_frame' in g['5']['inputs']) == (len(refs) == 2)
    if refs:
        assert g['5']['inputs']['first_frame'] == ['20', 0]
    if len(refs) == 2:
        assert g['5']['inputs']['last_frame'] == ['23', 0]


def test_fast_fixed_steps_and_unsupported_overrides_are_rejected():
    assert validate_h3_options('minimax-h3-fast', {}, 8) == {}
    for steps in (4, 6, 20):
        with pytest.raises(tornado.web.HTTPError):
            validate_h3_options('minimax-h3-fast', {}, steps)
    for options in ({'h3_sage': True}, {'h3_sampling': 'standard'}, {'h3_sampling': 'legacy'}):
        with pytest.raises(ValueError):
            validate_h3_options('minimax-h3-fast', options, 8)


def test_fast_node_preflight_and_optional_upscale_keep_original_output():
    p = params(h3_upscale=2)
    assert set(required_h3_nodes(p)) == {'BlockSparseAttention', 'ModelAttentionBackend',
        'MiniMaxH3SigmaShift', 'DenoTextEncoderUnload', 'RTXVideoSuperResolution'}
    g = workflow('video', 'image', p, ['first.png'], 'job')
    assert g['19']['inputs']['video'] == ['18', 0]
    assert g['18']['inputs']['audio'] == g['14']['inputs']['audio']
    assert g['15']['class_type'] == 'SaveVideo'
    spec = next(m for m in MODELS if m['id'] == p['model'])
    assert spec['fixed_steps'] and spec['default_steps'] == 8
    assert spec['modes'] == ['text', 'image'] and spec['ref_limit'] == 2
    assert not size_error(p['model'], 448, 800)


def test_sol_is_opt_in_uses_validated_settings_and_keeps_model_chain():
    p = params(h3_sol=True)
    g = workflow('video', 'image', p, ['first.png'], 'sol')
    base = workflow('video', 'image', params(), ['first.png'], 'sol')
    assert all(g[k] == v for k, v in base.items() if k != '40')
    assert g['40']['class_type'] == 'MiniMaxH3MemoryEfficientSolAttentionPatch'
    assert g['40']['inputs']['strict'] is True
    assert g['40']['inputs']['tau'] == 1.0
    assert g['40']['inputs']['int8_qk'] is g['40']['inputs']['int8_pv'] is False
    assert g['40']['inputs']['sink_conditioning'] == 'exact_kv_and_rows'
    assert required_h3_nodes(p)[0] == g['40']['class_type']
    assert validate_h3_options(p['model'], {'h3_sol': True}, 8) == {'h3_sol': True}
    assert workflow('video', 'text', params(), [], 'legacy') == workflow(
        'video', 'text', params(h3_sol=False), [], 'legacy')
    for model, option in [('minimax-h3', True), ('z-image', True), ('minimax-h3-fast', 'true')]:
        with pytest.raises(ValueError):
            validate_h3_options(model, {'h3_sol': option}, 8)
