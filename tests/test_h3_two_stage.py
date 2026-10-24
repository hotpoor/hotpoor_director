"""Check AV routing, target conditions, opt-in compatibility and request validation."""
import pytest
from backend.generation import workflow
from backend.h3_options import validate_h3_options, first_stage_size, required_h3_nodes, H3_LATENT_MODEL


def params(**changes):
    return dict(dict(model='minimax-h3', width=1344, height=768, seed=42,
        steps=8, duration=5, prompt='A bird flies.', h3_two_stage=True,
        h3_first_scale=.5, h3_refine_steps=3), **changes)


@pytest.mark.parametrize('model,mode,refs', [
    ('minimax-h3', 'text', []),
    ('minimax-h3', 'image', ['first.png', 'last.png']),
    ('minimax-h3-ref2va', 'reference', [dict(name='face.png', kind='image'),
        dict(name='motion.mp4', kind='video'), dict(name='voice.wav', kind='audio')])])
def test_learned_lift_rebuilds_conditions_and_preserves_audio(model, mode, refs):
    graph = workflow('video', mode, params(model=model), refs, 'job')
    assert (graph['5']['inputs']['width'], graph['5']['inputs']['height']) == (672, 384)
    target = graph['60']['inputs']
    assert (target['width'], target['height']) == (1344, 768)
    assert {k:v for k,v in target.items() if k not in ('width','height')} == {
        k:v for k,v in graph['5']['inputs'].items() if k not in ('width','height')}
    assert graph['61']['inputs']['av_latent'] == ['11', 1]  # clean endpoint
    assert graph['62']['inputs']['latent'] == ['61', 0]  # video only
    assert graph['62']['inputs']['model_name'] == H3_LATENT_MODEL
    assert graph['63']['inputs']['audio_latent'] == ['61', 1]
    assert graph['64']['inputs']['conditioning'] == ['60', 0]
    assert graph['12']['inputs']['samples'] == ['66', 1]
    assert graph['13']['inputs']['samples'] == ['11', 1]  # original sound
    # Every graph link must refer to an existing node, including mixed references.
    for n in graph.values():
        for value in n['inputs'].values():
            if isinstance(value, list):
                assert value[0] in graph


def test_disabled_keeps_legacy_graph_and_post_upscale_uses_refined_video():
    p=params();p.pop('h3_two_stage')
    assert workflow('video','text',p,[],'job') == workflow('video','text',{**p,'h3_two_stage':False},[],'job')
    g=workflow('video','text',params(h3_upscale=2,h3_sage=True),[],'job')
    assert g['17']['inputs']['images'] == ['12',0]
    assert g['64']['inputs']['model'] == g['7']['inputs']['model'] == ['16',0]
    assert g['18']['inputs']['audio'] == ['13',0]


@pytest.mark.parametrize('options', [dict(h3_two_stage='true'),dict(h3_first_scale=True),
    dict(h3_first_scale=.2),dict(h3_first_scale=float('nan')),dict(h3_refine_steps=2),
    dict(h3_refine_steps=9),dict(h3_refine_steps=True),dict(h3_refine_steps=3.5),
    dict(model='minimax-h3-fast'),dict(model='ltx-2.5'),dict(model='minimax-h3-ref2va',turbo_mode=True)])
def test_invalid_strategy_cannot_submit(options):
    p=params(**options)
    with pytest.raises(ValueError):
        validate_h3_options(p['model'],p,p['steps'])


def test_dimensions_and_required_nodes():
    assert first_stage_size(832,480,.5) == (416,256)
    p=params(); assert validate_h3_options(p['model'],p,p['steps'])['h3_two_stage']
    assert required_h3_nodes(p) == ['MinimaxH3LatentUpscaler3D','LTXVSeparateAVLatent','LTXVConcatAVLatent']
