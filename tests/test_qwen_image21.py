import pytest
from backend.generation import workflow, size_error
from backend.qwen_models import QWEN_IMAGE21_GGUF


def graph(mode, refs):
    return workflow('image', mode, dict(model='qwen-image-2.1', prompt='Edit <image1>.',
                    width=512, height=512, seed=42, steps=40, denoise=.1), refs, 'test')


def test_edit_keeps_ten_numbered_references_and_alpha_without_img2img_noise():
    result = graph('reference', [f'{i}.png' for i in range(1, 11)])
    for i in range(1, 11):
        alpha_key = result['4']['inputs'][f'images.image_{i}'][0]
        alpha = result[alpha_key]
        assert alpha['class_type'] == 'JoinImageWithAlpha'
        assert alpha['inputs']['alpha'][1] == 1
        load = result[alpha['inputs']['image'][0]]
        assert load['inputs']['image'] == f'{i}.png'
    assert result['8']['inputs']['denoise'] == 1
    assert not any(n['class_type'] == 'VAEEncode' for n in result.values())
    assert result['3']['inputs']['vae_name'] == 'qwen_image_2.1_vae_bf16.safetensors'


def test_text_does_not_load_stale_references():
    result = graph('text', ['old.png'])
    assert not any(n['class_type'] == 'LoadImage' for n in result.values())
    assert result['8']['inputs']['cfg'] == 1


@pytest.mark.parametrize('size,valid', [((512,512),True),((1280,768),True),((1280,720),False)])
def test_qwen_size_alignment(size, valid):
    assert bool(size_error('qwen-image-2.1', *size)) is not valid


@pytest.mark.parametrize('model,filename', QWEN_IMAGE21_GGUF.items())
def test_gguf_variants_use_correct_loader_and_keep_reference_conditioning(model, filename):
    result = workflow('image', 'reference', dict(model=model, prompt='Edit <image1>.',
        width=512, height=512, seed=42, steps=40), ['reference.png'], 'test')
    assert result['1'] == {'class_type': 'UnetLoaderGGUF', 'inputs': {'unet_name': filename}}
    assert result['6']['inputs']['model'] == ['1', 0]
    assert 'images.image_1' in result['4']['inputs']
    assert result['8']['inputs']['cfg'] == 1
    assert size_error(model, 1280, 720)
    assert size_error(model, 512, 512) == ''
