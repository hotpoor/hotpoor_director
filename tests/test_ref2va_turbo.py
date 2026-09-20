"""Keep accelerated reference generation isolated from the other H3 workflows."""
from backend.generation import workflow


def params(**changes):
    return dict(model='minimax-h3-ref2va', width=256, height=256, seed=42,
                steps=20, duration=1, prompt='Use <Picture 1>.', **changes)


def test_turbo_preserves_all_reference_types_and_uses_one_patched_model():
    refs = [dict(name='ref.png', kind='image'), dict(name='ref.mp4', kind='video'),
            dict(name='ref.wav', kind='audio')]
    base = workflow('video', 'reference', params(), refs, 'standard')
    turbo = workflow('video', 'reference', params(turbo_mode=True), refs, 'turbo')
    # Switching acceleration must not discard or renumber multimodal inputs.
    assert turbo['5'] == base['5']
    assert all(turbo[key] == value for key, value in base.items() if int(key) >= 20)
    assert turbo['6']['inputs']['lora_name'] == 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'
    assert turbo['6']['inputs']['model'] == ['1', 0]
    assert turbo['7']['inputs']['model'] == turbo['10']['inputs']['model'] == ['6', 0]
    assert turbo['10']['inputs']['steps'] == 4
    assert '6' not in base
    assert base['7']['inputs']['model'] == base['10']['inputs']['model'] == ['1', 0]
    assert base['10']['inputs']['steps'] == 20


def test_old_reference_records_stay_standard_and_fl2va_keeps_its_own_lora():
    old = params()
    refs = ['ref.png']
    assert workflow('video', 'reference', old, refs, 'same') == workflow(
        'video', 'reference', {**old, 'turbo_mode': False}, refs, 'same')
    frame = workflow('video', 'image', {**old, 'model': 'minimax-h3', 'steps': 8}, refs, 'frame')
    assert frame['6']['inputs']['lora_name'] == 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'
    assert frame['10']['inputs']['steps'] == 8
