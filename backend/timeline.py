"""Bounded, portable edit decisions stored with the project canvas."""
import math
import re


def validate_timeline(value):
    def number(n, low=0, high=86400):
        return type(n) in (int, float) and math.isfinite(n) and low <= n <= high

    def uuid(n):
        return isinstance(n, str) and re.fullmatch(r'[0-9a-f]{32}', n)

    if not isinstance(value, dict) or value.get('version') != 1:
        raise ValueError('时间轴版本不正确')
    if not number(value.get('start', 0)) or not number(value.get('zoom', 60), 4, 240) or type(value.get('snap', True)) is not bool:
        raise ValueError('时间轴起点或缩放不正确')
    clips, subtitles = value.get('clips'), value.get('subtitles')
    if not isinstance(clips, list) or len(clips) > 500 or not isinstance(subtitles, list) or len(subtitles) > 2000:
        raise ValueError('时间轴最多 500 个视频片段及 2000 条字幕')
    ids = set()
    for item in clips + subtitles:
        if not isinstance(item, dict) or not uuid(item.get('id')) or item['id'] in ids:
            raise ValueError('时间轴条目 ID 不正确或重复')
        ids.add(item['id'])
        if not number(item.get('start')) or not number(item.get('duration'), .04) or item['start'] + item['duration'] > 86400:
            raise ValueError('时间轴范围须在 24 小时内，片段至少 0.04 秒')
    for clip in clips:
        for field, limit in [('title', 160), ('source_name', 2000)]:
            if not isinstance(clip.get(field, ''), str) or len(clip.get(field, '')) > limit:
                raise ValueError('片段名称或来源名称过长')
        if not number(clip.get('in', 0)) or not number(clip.get('source_duration'), .04) or clip.get('in', 0) + clip['duration'] > clip['source_duration'] + .001:
            raise ValueError('裁剪范围超过原视频时长')
        media = clip.get('media')
        if not isinstance(media, dict) or media.get('source') not in ('asset', 'cloud', 'output', 'url'):
            raise ValueError('视频来源不正确')
        if media['source'] != 'url' and not uuid(media.get('id')):
            raise ValueError('视频素材 ID 不正确')
    by_id = {c['id']: c for c in clips}
    for subtitle in subtitles:
        if not isinstance(subtitle.get('text'), str) or len(subtitle['text']) > 2000 or subtitle.get('mode') not in ('absolute', 'follow'):
            raise ValueError('字幕格式不正确')
        if subtitle['mode'] == 'follow':
            clip = by_id.get(subtitle.get('clip_id'))
            if not clip or subtitle['start'] + subtitle['duration'] > clip['duration'] + .001:
                raise ValueError('跟随字幕须位于绑定片段范围内')
    return value


def timelines(canvas):
    return ([canvas['timeline']] if 'timeline' in canvas else []) + canvas.get('timelines', [])


def validate_timelines(canvas):
    extras = canvas.get('timelines', [])
    if not isinstance(extras, list) or len(extras) > 7:
        raise ValueError('一个项目最多 8 个时间轴')
    seen = set()
    for sequence in timelines(canvas):
        validate_timeline(sequence)
        if not isinstance(sequence.get('name', ''), str) or len(sequence.get('name', '')) > 160:
            raise ValueError('时间轴名称最多 160 字符')
        identifiers = [e['id'] for e in sequence['clips'] + sequence['subtitles']]
        if sequence in extras:
            identifier = sequence.get('id')
            if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{32}', identifier):
                raise ValueError('时间轴 ID 不正确')
            identifiers.append(identifier)
        for identifier in identifiers:
            if identifier in seen:
                raise ValueError('多个时间轴的条目 ID 不能重复')
            seen.add(identifier)
