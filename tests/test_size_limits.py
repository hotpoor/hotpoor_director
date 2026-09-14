import pytest

from backend.generation import MODELS, size_error


def test_all_recommended_sizes_are_accepted_by_their_model():
    for model in MODELS:
        if model.get('provider') == 'service-inference':
            continue  # Cloud models expose resolution tiers instead of local pixel limits.
        for width, height in model['size_limits']['presets']:
            assert not size_error(model['id'], width, height)


@pytest.mark.parametrize('model,width,height,reason', [
    ('z-image',2048,1024,'宽度'),
    ('z-image-turbo',1024,128,'高度'),
    ('ltx-2.5',832,480,'64'),
    ('minimax-h3',513,320,'32'),
    ('minimax-h3-ref2va',1536,1536,'总像素'),
    ('z-image',512.5,512,'整数'),
])
def test_invalid_dimensions_have_actionable_errors(model,width,height,reason):
    assert reason in size_error(model,width,height)


def test_image_and_video_pixel_budgets_differ():
    assert not size_error('z-image',1536,1536)
    assert size_error('minimax-h3',1536,1536)
    assert not size_error('ltx-2.5',1344,768)
