"""Bounded local media preparation for H3's 24 fps reference inputs."""
from fractions import Fraction
import math

import av


def prepare_reference(source, target, kind, duration, width, height):
    """Use the opening segment; video is visual-only, audio is a separate input."""
    if kind == 'audio':
        with av.open(str(source)) as inp, av.open(str(target), 'w') as out:
            stream = out.add_stream('pcm_s16le', rate=48000)
            stream.layout = 'stereo'
            resampler = av.AudioResampler(format='s16', layout='stereo', rate=48000)
            count = 0
            for frame in inp.decode(audio=0):
                for converted in resampler.resample(frame):
                    converted.pts = count
                    count += converted.samples
                    for packet in stream.encode(converted):
                        out.mux(packet)
                if count >= duration * 48000:
                    break
            for packet in stream.encode(None):
                out.mux(packet)
            if count == 0:
                raise ValueError('音频没有可解码的声音')
        return
    with av.open(str(source)) as inp, av.open(str(target), 'w') as out:
        source_stream = inp.streams.video[0]
        scale = min(1, math.sqrt(width * height / (source_stream.width * source_stream.height)))
        w = max(32, int(source_stream.width * scale / 32) * 32)
        h = max(32, int(source_stream.height * scale / 32) * 32)
        stream = out.add_stream('libx264', rate=24)
        stream.width, stream.height, stream.pix_fmt = w, h, 'yuv420p'
        stream.options = {'crf': '18', 'preset': 'fast'}
        count, first_time, previous = 0, None, None
        limit = math.ceil(duration * 24)

        def emit(frame):
            nonlocal count
            resized = frame.reformat(width=w, height=h, format='yuv420p')
            resized.pts, resized.time_base = count, Fraction(1, 24)
            for packet in stream.encode(resized):
                out.mux(packet)
            count += 1

        for index, frame in enumerate(inp.decode(video=0)):
            timestamp = float(frame.time) if frame.time is not None else index / float(source_stream.average_rate or 24)
            if first_time is None:
                first_time = timestamp
            timestamp -= first_time
            while previous is not None and count / 24 < timestamp and count < limit:
                emit(previous)
            previous = frame
            if count >= limit:
                break
        if previous is not None and count < limit:
            emit(previous)
        for packet in stream.encode(None):
            out.mux(packet)
        if count < 5:
            raise ValueError('参考视频至少需要 5 帧（约 0.2 秒）')
