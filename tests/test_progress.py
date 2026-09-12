from backend.progress import ProgressTracker


def test_progress_is_scoped_and_resets_between_nodes():
    tracker = ProgressTracker()
    tracker.update('alice', {'type':'progress','data':{'prompt_id':'p','node':'8','value':3,'max':8}})
    assert tracker.values[('alice','p')]['value'] == 3
    assert ('bob','p') not in tracker.values
    tracker.update('alice', {'type':'executing','data':{'prompt_id':'p','node':'9'}})
    assert tracker.values[('alice','p')] == {'phase':'running','node':'9'}
    tracker.update('alice', {'type':'execution_success','data':{'prompt_id':'p'}})
    assert tracker.values[('alice','p')]['phase'] == 'finishing'


def test_invalid_progress_and_bounded_cache():
    tracker = ProgressTracker()
    tracker.update('a', {'type':'progress','data':{'prompt_id':'p','value':1,'max':0}})
    assert not tracker.values
    for i in range(1005):
        tracker.update('a', {'type':'execution_start','data':{'prompt_id':str(i)}})
    assert len(tracker.values) == 1000
    assert ('a','0') not in tracker.values


def test_standard_workflow_uses_negative_conditioning_and_cfg():
    from backend.generation import workflow
    p = dict(model='z-image', prompt='a cup', negative_prompt='blur', cfg=4, width=512, height=512, seed=42, steps=40, denoise=.5)
    text = workflow('image', 'text', p, [], 'test')
    assert text['1']['inputs']['unet_name'] == 'z_image_bf16.safetensors'
    assert text['5']['class_type'] == 'CLIPTextEncode'
    assert text['5']['inputs']['text'] == 'blur'
    assert text['8']['inputs']['cfg'] == 4
    assert text['8']['inputs']['denoise'] == 1
    image = workflow('image', 'image', p, ['reference.png'], 'test')
    assert image['7']['class_type'] == 'VAEEncode'
    assert image['8']['inputs']['denoise'] == .5
    turbo = workflow('image', 'text', {**p, 'model':'z-image-turbo'}, [], 'test')
    assert turbo['5']['class_type'] == 'ConditioningZeroOut'
    assert turbo['8']['inputs']['cfg'] == 1
