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
for family, label in [('doubao', '豆包'), ('dreamina', 'Dreamina')]:
    for suffix, name in [('2-0-260128-max', '2.0 Max'), ('2-0-fast-260128-max', '2.0 Fast Max'),
                         ('2-0-mini-260615-max', '2.0 Mini Max'), ('2-5-260628-max', '2.5 Max')]:
        remote=f'{family}-seedance-{suffix}'
        MODELS.append(dict(id='si:'+remote, remote_model=remote, name=f'{label} Seedance {name} · 云端',
            provider=PROVIDER, type='video', modes=['text','image','reference'], resolutions=['480p','720p'],
            default_duration=5, min_duration=4, max_duration=30 if suffix.startswith('2-5-') else 15, ref_limit=12, api_version='v2',
            note='service-inference · 首尾帧或多元素参考；用 @Image1 / @Video1 引用按顺序填写的公网素材。'))
MODELS.append(dict(id='si:minimax-h3', remote_model='minimax-h3', name='MiniMax H3 · 云端', provider=PROVIDER,
    type='video', modes=['text','image'], resolutions=['768P','2K'], default_duration=5,
    ref_limit=5, api_version='v1', note='service-inference · 4–15 秒，768P / 2K；参考图使用公网 URL。'))
BY_ID = {model['id']: model for model in MODELS}
