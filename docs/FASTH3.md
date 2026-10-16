# FastH3 · 本地 8 步视频

在视频卡选择 **FastH3 · 8步 · 本地**。这是 MiniMax H3 的蒸馏加速权重，独立于 FL2VA Turbo LoRA、Ref2VA Turbo 和双采工作流。可选文生视频、首帧图生视频及可选尾帧；当前完整场景实测为单首帧。图片/视频/音频混合参考仍选 Ref2VA。

默认 448×800、5秒、固定8步，原生音频与24fps。H3帧数向上对齐17k+5，输入5秒对应124帧，约5.167秒。支持已有RTX超分并保留原片；FastH3不提供Sage或标准/Turbo切换，避免混用配置。旧任务和其他模型不自动转换。

## 已验证配置

- diffusion_models：`fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors`，22,128,378,696字节，SHA256 `0922785978dc9bfe1adf27d8b291b0ca763f9f165f882e6cb297c72fbb6deda8`。
- text_encoders：`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`。
- vae：`minimax_h3_video_vae_fp16.safetensors`、`minimax_h3_audio_vae_fp32.safetensors`。
- res_multistep / simple，8步，SigmaShift 视频10、音频3，Kitchen attention，无Turbo LoRA。
- `DenoTextEncoderUnload` 释放文本编码器，来自实测安装的 `h3_fast_helpers`；其余使用目标 ComfyUI 提供的 `BlockSparseAttention`、`ModelAttentionBackend`、`MiniMaxH3SigmaShift` 等节点。

提交前检查上述4个额外节点，缺失则在上传素材和创建任务前报错。节点存在不等于权重或GPU内核就绪；缺少权重由ComfyUI校验返回。需要支持当前INT8 convrot格式及相关节点的ComfyUI环境，不自动替换PyTorch或全局启动参数。本机模型实际位于 `I:/AI/ComfyUI/models`。

## 稀疏加速的真实状态

图中请求VSA：keep_percent=10、start=.2、end=1、min_tokens=12288、extra_tokens=256、sink_conditioning=exact_kv_and_rows。小于阈值或在起始窗口外可能使用普通计算。

2026-10-17 的 Windows RTX3090实测，14379 tokens达到阈值，但日志明确为 `no compiled sol_attn kernel for this GPU`，因此自动回退dense attention。模型仍在GPU上正常生成，只是该项加速未生效。不能把节点存在、勾选或成功出片描述为稀疏加速已生效；也不能据此认定3090硬件永远不支持。未安装/编译新的稀疏内核。

## 三版实测：雕塑复活

同一图片、逐字相同提示词、448×800、124帧、24fps、种子2026101701，输出均约5.167秒并有AAC音轨。

| 版本 | 采样 | 完整执行耗时 |
|---|---|---:|
| Ref2VA双采 | 6步低分辨率+3步全分辨率 | 173.25秒 |
| FastH3 INT8 | 8步全分辨率，VSA回退 | 175.40秒 |
| 原版Ref2VA FP8标准 | 20步全分辨率 | 372.21秒 |

FastH3与双采基本持平，比原版约2.12倍速度。抽帧观察，FastH3黑上衣、短裙和腰带更接近原版；双采粉尘和变身光效更明显，服装偏连衣裙。均存在背景文字失真。无正式感知质量评分、无音效优劣评分。

只测一次，采用ComfyUI execution_start到execution_success，包含执行期间的加载、初始化、采样与解码，排除排队。FastH3前有短片测试，部分加载与模型设置节点命中缓存，采样/输出未缓存；前两版图节点未命中。不同权重、量化、采样及缓存状态，不是同等冷启动或单变量基准，2秒差距不代表稳定优势。双采是单独实验工作流，本次模型入口接入FastH3。

实验视频、逐字提示词、API图、执行历史和同步预览归档于设备私有仓库 `research/h3-fast/misato-revival/`：`comparison-three.html`、`COMPARISON-THREE.md`、`misato-fasth3-api.json`。

## 回归验证

`tests/test_fasth3.py`：固定步数与不兼容参数、首尾帧/无参考分支、模型接线、音轨、节点预检列表及超分保留原片。`scripts/smoke-h3-options-ui.cjs`：真实Electron页面的模型切换、固定步数、保存重开、缺失节点拒绝，测试不提交GPU任务。实测API与本次应用图使用相同参数链，节点编号及输出前缀按应用约定调整。
