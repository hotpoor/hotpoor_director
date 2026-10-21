"""One local job per process. JSON input and JSON-line audio/completion output; no remote fallback."""
import contextlib
import json
import os
import sys
import re
import base64

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

def split_text(text, limit=120):
    parts = re.findall(r'.+?(?:[。！？!?;；\n]+|[.](?=\s|$)|$)', text, re.S)
    result = []
    for part in parts:
        while len(part) > limit:
            cut = max(part.rfind(mark, 0, limit + 1) for mark in (' ', '，', '、', ','))
            cut = cut + 1 if cut > limit // 3 else limit
            result.append(part[:cut]); part = part[cut:]
        if part.strip(): result.append(part)
    return result or [text]


def main():
    request = json.load(sys.stdin)
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
        device = request.get('device', 'cpu')
        if device not in ('cpu', 'mps', 'cuda:0'):
            raise ValueError('Unsupported device')
        torch.set_grad_enabled(False)
        # CPU is the portable default; accelerate backends are explicitly selected.
        dtype = torch.float32 if device in ('cpu', 'mps') else torch.bfloat16
        model = Qwen3TTSModel.from_pretrained(request['model_path'], device_map=device,
                                             dtype=dtype, attn_implementation='sdpa' if device.startswith('cuda') else 'eager', local_files_only=True)
        mode = request.get('mode', 'clone')
        kwargs = dict(language=request['language'], non_streaming_mode=True, max_new_tokens=2048)
        if mode == 'design':
            generate = model.generate_voice_design
            kwargs['instruct'] = request['description']
        elif mode == 'custom':
            generate = model.generate_custom_voice
            kwargs['speaker'] = request['speaker']
            kwargs['instruct'] = request.get('instruction', '')
        elif mode == 'clone':
            ref_audio, sr = sf.read(request['reference_path'], dtype='float32')
            if ref_audio.ndim > 1:
                ref_audio = ref_audio.mean(axis=1)
            transcript = request.get('reference_text', '').strip()
            prompt = model.create_voice_clone_prompt(ref_audio=(ref_audio, sr), ref_text=transcript or None,
                                                     x_vector_only_mode=not bool(transcript))
            generate = model.generate_voice_clone
            kwargs['voice_clone_prompt'] = prompt
        else:
            raise ValueError('Unsupported synthesis mode')
        # Sentence streaming is intentional: the public upstream wrapper returns complete
        # utterances. Load weights once, reuse the clone prompt and emit each sentence.
        chunks = split_text(request['text']) if request.get('stream') and mode != 'design' else [request['text']]
        pieces = []
        expected_rate = None
        for text in chunks:
            with torch.inference_mode():
                wavs, sample_rate = generate(text=text, **kwargs)
            samples = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            if not samples.size or not np.isfinite(samples).all():
                raise ValueError('Model returned invalid audio')
            if expected_rate is not None and sample_rate != expected_rate:
                raise ValueError('Inconsistent audio sample rate')
            expected_rate = sample_rate
            pcm = (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes()
            if request.get('stream'):
                # stdout is a bounded line protocol; never mix model logs with PCM.
                for offset in range(0, len(pcm), 24000):
                    print(json.dumps({'event':'audio', 'sample_rate':sample_rate,
                                      'pcm':base64.b64encode(pcm[offset:offset+24000]).decode('ascii')}),
                          file=sys.__stdout__, flush=True)
            pieces.append(samples)
        sf.write(request['output_path'], np.concatenate(pieces), expected_rate, subtype='PCM_16')
    print(json.dumps({'ok': True, 'sample_rate': sample_rate}))

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)[:1500]}))
        sys.exit(1)
