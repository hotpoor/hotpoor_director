"""Explicit, opt-in H3 optimizations; old records keep their original graph."""
import tornado.web

H3_MODELS = ('minimax-h3', 'minimax-h3-ref2va')


def validate_h3_draft(data):
    if data.get('h3_sampling', 'turbo') not in ('turbo', 'standard', 'legacy'):
        raise ValueError('H3 采样模式不正确')
    if not isinstance(data.get('h3_sage', False), bool):
        raise ValueError('H3 Sage Attention 参数必须为布尔值')
    scale = data.get('h3_upscale', 1)
    if type(scale) is not int or scale not in (1, 2, 4):
        raise ValueError('H3 超分倍率需为 1、2 或 4')


def validate_h3_options(model, data, steps):
    validate_h3_draft(data)
    if model not in H3_MODELS:
        if data.get('h3_sage') or data.get('h3_upscale', 1) != 1 or data.get('h3_sampling', 'turbo') != 'turbo':
            raise ValueError('当前模型不支持 H3 优化')
        return {}
    options = {k: data[k] for k in ('h3_sampling', 'h3_sage', 'h3_upscale') if k in data}
    # Missing sampling mode belongs to a legacy FL2VA request: preserve its steps.
    if model == 'minimax-h3' and 'h3_sampling' in data and data['h3_sampling'] == 'turbo' and steps not in (6, 8):
        raise tornado.web.HTTPError(400, reason='H3 Turbo 使用 6 或 8 步；建议 8 步，标准模式可自行设置步数')
    return options


def required_h3_nodes(params):
    nodes = []
    if params.get('h3_sage'):
        nodes.append('PathchSageAttentionKJ')  # Upstream node ID includes this spelling.
    if params.get('h3_upscale', 1) > 1:
        nodes.append('RTXVideoSuperResolution')
    return nodes


def apply_h3_options(graph, params):
    if params.get('model') == 'minimax-h3' and params.get('h3_sampling') == 'standard':
        del graph['6']
        graph['7']['inputs']['model'] = ['1', 0]
        graph['10']['inputs']['model'] = ['1', 0]
    if params.get('h3_sage'):
        graph['16'] = {'class_type': 'PathchSageAttentionKJ', 'inputs': {
            'model': graph['7']['inputs']['model'], 'sage_attention': 'auto', 'allow_compile': False}}
        graph['7']['inputs']['model'] = ['16', 0]
    scale = params.get('h3_upscale', 1)
    if scale > 1:
        graph['17'] = {'class_type': 'RTXVideoSuperResolution', 'inputs': {
            'images': ['12', 0], 'resize_type': 'scale by multiplier',
            'resize_type.scale': scale, 'quality': 'ULTRA'}}
        graph['18'] = {'class_type': 'CreateVideo', 'inputs': {
            'images': ['17', 0], 'audio': ['13', 0], 'fps': 24}}
        graph['19'] = {'class_type': 'SaveVideo', 'inputs': {
            **graph['15']['inputs'], 'video': ['18', 0],
            'filename_prefix': graph['15']['inputs']['filename_prefix'] + f'_rtx{scale}x'}}
        # SaveVideo 15 retains the source result if postprocessing fails.
