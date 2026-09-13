import wave

import av

from backend.reference_media import prepare_reference


def test_video_reference_resamples_and_bounds_input(tmp_path):
    source, target = tmp_path / 'source.mp4', tmp_path / 'reference.mp4'
    with av.open(str(source), 'w') as out:
        stream = out.add_stream('libx264', rate=30)
        stream.width, stream.height, stream.pix_fmt = 640, 480, 'yuv420p'
        for index in range(60):
            frame = av.VideoFrame(640, 480, 'yuv420p')
            for plane in frame.planes:
                plane.update(bytes([index + 64]) * plane.buffer_size)
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    prepare_reference(source, target, 'video', 1, 256, 256)
    with av.open(str(target)) as result:
        stream = result.streams.video[0]
        assert stream.average_rate == 24
        assert stream.width * stream.height <= 256 * 256
        assert stream.width % 32 == stream.height % 32 == 0
        assert len(list(result.decode(video=0))) == 24
        assert not result.streams.audio


def test_audio_reference_resamples_and_trims(tmp_path):
    source, target = tmp_path / 'source.wav', tmp_path / 'reference.wav'
    with wave.open(str(source), 'wb') as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        out.writeframes(b'\x01\x00' * 32000)
    prepare_reference(source, target, 'audio', 1, 256, 256)
    with av.open(str(target)) as result:
        stream = result.streams.audio[0]
        assert stream.rate == 48000
        assert stream.layout.name == '2 channels' or len(stream.layout.channels) == 2
        samples = sum(frame.samples for frame in result.decode(audio=0))
        assert 48000 <= samples < 60000
