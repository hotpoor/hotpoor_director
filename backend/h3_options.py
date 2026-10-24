"""Explicit, opt-in H3 optimizations; old records keep their original graph."""
import copy

import tornado.web

H3_LATENT_MODEL = 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors'

H3_MODELS = ('minimax-h3', 'minimax-h3-ref2va', 'minimax-h3-fast')


def validate_h3_draft(data):
    if data.get('h3_sampling', 'turbo') not in ('turbo', 'standard', 'legacy'):
        raise ValueError('H3 采样模式不正确')
    if not isinstance(data.get('h3_sage', False), bool):
        raise ValueError('H3 Sage Attention 参数必须为布尔值')
    if not isinstance(data.get('h3_sol', False), bool):
        raise ValueError('H3 Sol-Attn 参数必须为布尔值')
    if not isinstance(data.get('h3_two_stage', False), bool):
        raise ValueError('H3 双采参数必须为布尔值')
    ratio = data.get('h3_first_scale', .5)
    if type(ratio) not in (int, float) or ratio not in (.5, .75):
        raise ValueError('一采宽高比例需为 0.5 或 0.75')
    refine = data.get('h3_refine_steps', 3)
    if type(refine) is not int or not 3 <= refine <= 8:
        raise ValueError('二采精修需为 3–8 步')
    scale = data.get('h3_upscale', 1)
    if type(scale) is not int or scale not in (1, 2, 4):
        raise ValueError('H3 超分倍率需为 1、2 或 4')


def validate_h3_options(model, data, steps):
    validate_h3_draft(data)
    if data.get('h3_two_stage') and (model not in ('minimax-h3', 'minimax-h3-ref2va') or data.get('turbo_mode')):
        raise ValueError('双采仅支持本地 H3 首尾帧和标准 Ref2VA，不支持 FastH3 或 Ref2VA Turbo')
    if data.get('h3_two_stage'):
        low = first_stage_size(data['width'], data['height'], data.get('h3_first_scale', .5))
        if min(low) < 128 or any(a >= b for a, b in zip(low, (data['width'], data['height']))):
            raise ValueError('双采的一采尺寸过小或没有缩小，请增大最终尺寸')
    if data.get('h3_sol') and model != 'minimax-h3-fast':
        raise ValueError('Sol-Attn 目前仅支持 FastH3 模型')
    if model not in H3_MODELS:
        if data.get('h3_sage') or data.get('h3_upscale', 1) != 1 or data.get('h3_sampling', 'turbo') != 'turbo':
            raise ValueError('当前模型不支持 H3 优化')
        return {}
    if model == 'minimax-h3-fast':
        if steps != 8:
            raise tornado.web.HTTPError(400, reason='FastH3 固定使用 8 步')
        if data.get('h3_sage') or data.get('h3_sampling', 'turbo') != 'turbo':
            raise ValueError('FastH3 使用独立的 8 步配置，不支持切换标准采样或 Sage')
    options = {k: data[k] for k in ('h3_sampling', 'h3_sage', 'h3_upscale', 'h3_sol', 'h3_two_stage', 'h3_first_scale', 'h3_refine_steps') if k in data}
    # Missing sampling mode belongs to a legacy FL2VA request: preserve its steps.
    if model == 'minimax-h3' and 'h3_sampling' in data and data['h3_sampling'] == 'turbo' and steps not in (6, 8):
        raise tornado.web.HTTPError(400, reason='H3 Turbo 使用 6 或 8 步；建议 8 步，标准模式可自行设置步数')
    return options


def required_h3_nodes(params):
    nodes = ['BlockSparseAttention', 'ModelAttentionBackend', 'MiniMaxH3SigmaShift', 'DenoTextEncoderUnload'] if params.get('model') == 'minimax-h3-fast' else []
    if params.get('model') == 'minimax-h3-fast' and params.get('h3_sol'):
        nodes[0] = 'MiniMaxH3MemoryEfficientSolAttentionPatch'
    if params.get('h3_two_stage'):
        nodes.extend(['MinimaxH3LatentUpscaler3D', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent'])
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
    if params.get('model') == 'minimax-h3-fast' and params.get('h3_sol'):
        graph['40'] = {'class_type': 'MiniMaxH3MemoryEfficientSolAttentionPatch', 'inputs': {
            'model': ['1', 0], 'enabled': True, 'tau': 1.0, 'min_tokens': 4096,
            'strict': True, 'thresh_type': 'diag', 'int8_qk': False, 'int8_pv': False,
            'sink_conditioning': 'exact_kv_and_rows', 'dense_blocks': ''}}
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


def first_stage_size(width, height, scale=.5):
    # Match JS rounding, always use the H3 32px grid.
    return tuple(max(32, int(value * scale / 32 + .5) * 32) for value in (width, height))


def apply_h3_two_stage(graph, params):
    """Learned video-only lift; target-size conditioning and original audio.

    Based on LBH-123-AI's i2v/r2v example graphs. Stock sampler noise is
    generated internally; do not put AddNoise + DisableNoise on AV latents.
    """
    if not params.get('h3_two_stage'):
        return
    width, height = params['width'], params['height']
    target = copy.deepcopy(graph['5'])
    graph['5']['inputs'].update(zip(('width', 'height'), first_stage_size(
        width, height, params.get('h3_first_scale', .5))))
    graph['60'] = target
    def node(kind, **inputs):
        return {'class_type': kind, 'inputs': inputs}
    graph['61'] = node('LTXVSeparateAVLatent', av_latent=['11', 1])
    graph['62'] = node('MinimaxH3LatentUpscaler3D', latent=['61', 0],
        model_name=H3_LATENT_MODEL, mode='target dimensions',
        **{'mode.width': width, 'mode.height': height}, align=32,
        enable_temporal_chunking=True, force_unload=True, device='cuda', precision='bf16')
    graph['63'] = node('LTXVConcatAVLatent', video_latent=['62', 0], audio_latent=['61', 1])
    graph['64'] = node('BasicGuider', model=graph['7']['inputs']['model'], conditioning=['60', 0])
    graph['65'] = node('BasicScheduler', model=graph['10']['inputs']['model'],
        scheduler='simple', steps=params.get('h3_refine_steps', 3), denoise=.35)
    graph['66'] = node('SamplerCustomAdvanced', noise=['8', 0], guider=['64', 0],
        sampler=['9', 0], sigmas=['65', 0], latent_image=['63', 0])
    graph['12']['inputs']['samples'] = ['66', 1]
    # Decode audio from pass one. Upscale/refinement must not replace its voice.
    graph['13']['inputs']['samples'] = ['11', 1]
