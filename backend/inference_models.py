"""service-inference model capabilities from the supplied API documents."""
PROVIDER = 'service-inference'
MODELS = []
for remote, name, sizes, limit in [
    ('dola-seedream-5-0-pro-260628', 'Seedream 5 Pro', ['1K', '1.5K', '2K'], 10),
    ('dola-seedream-5-0-pro-260628-ep', 'Seedream 5 Pro EP', ['1K', '1.5K', '2K'], 10),
    ('seedream-5-0-lite-260128', 'Seedream 5 Lite', ['2K', '3K', '4K'], 14),
    ('seedream-4-5-251128', 'Seedream 4.5', ['2K', '4K'], 14),
]:
    MODELS.append(dict(id='si:'+remote, remote_model=remote, name=name+' · 云端', provider=PROVIDER,
        type='image', modes=['text','image','reference','edit'] if 'pro' in remote else ['text','image','reference','series'],
        sizes=sizes, ref_limit=limit, output_formats=['jpeg'] if remote.startswith('seedream-4-5') else ['jpeg','png'],
        optimize_modes=['standard','fast'] if 'pro' in remote else ['standard'],
        note='service-inference · 按张计费；参考图片使用公网 URL，支持多图编辑。'))
# OpenAI Images API aliases and documented snapshots; availability still comes from each AK.
for remote in [
    'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5',
    'gpt-image-2', 'gpt-image-2-2026-04-21',
    'gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08',
    'gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08',
]:
    sizes = ['auto', '1024x1024', '1536x1024', '1024x1536']
    if remote.startswith('gpt-image-2'):
        sizes += ['1536x864', '864x1536', '2560x1440', '1440x2560']
    MODELS.append(dict(id='si:'+remote, remote_model=remote, name=remote+' · 云端', provider=PROVIDER,
        type='image', image_api='openai', modes=['text','image','reference','edit'], sizes=sizes,
        ref_limit=16, output_formats=['png','jpeg','webp'], optimize_modes=[],
        qualities=['auto','low','medium','high'] + (['xhigh','max'] if remote.startswith('gpt-image-2.5-') else []),
        note='service-inference · GPT 生图；支持文字生成、参考图编辑及多图融合，按实际调用计费。'))
for family, label in [('doubao', '豆包'), ('dreamina', 'Dreamina')]:
    for suffix, name in [('2-0-260128-max', '2.0 Max'), ('2-0-fast-260128-max', '2.0 Fast Max'),
                         ('2-0-mini-260615-max', '2.0 Mini Max'), ('2-5-260628-max', '2.5 Max')]:
        remote=f'{family}-seedance-{suffix}'
        MODELS.append(dict(id='si:'+remote, remote_model=remote, name=f'{label} Seedance {name} · 云端',
            provider=PROVIDER, type='video', modes=['text','image','reference'], resolutions=['480p','720p'],
            default_duration=5, min_duration=4, max_duration=30 if suffix.startswith('2-5-') else 15, ref_limit=12, api_version='v2',
            note='service-inference · 首尾帧或多元素参考；用 @Image1 / @Video1 引用按顺序填写的公网素材。'))
MODELS.append(dict(id='si:minimax-h3', remote_model='minimax-h3', name='MiniMax H3 · 云端', provider=PROVIDER,
    type='video', modes=['text','image','reference'], resolutions=['768P','2K'], default_duration=5,
    min_duration=4, max_duration=15, ref_limit=12, image_ref_limit=9, api_version='v1',
    note='service-inference · 4–15 秒，768P / 2K。多元素参考支持图片、视频、音频；用 <Picture 1> / <Video 1> / <Audio 1> 引用。音频须搭配图片或视频。'))
BY_ID = {model['id']: model for model in MODELS}
