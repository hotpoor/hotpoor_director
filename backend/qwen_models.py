"""Local Qwen Image 2.1 weight variants shared by drafts and generation."""

QWEN_IMAGE21_GGUF = {
    f'qwen-image-2.1-gguf-{quant.lower()}': f'qwen-image-2.1-{quant}.gguf'
    for quant in ('Q6_K', 'Q8_0', 'Q5_K_M', 'Q4_K_M', 'Q4_0')
}
QWEN_IMAGE21_IDS = {'qwen-image-2.1', *QWEN_IMAGE21_GGUF}
