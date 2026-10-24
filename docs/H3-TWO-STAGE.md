# H3 潜空间双采（实验功能）

本地视频卡选择 MiniMax H3 或 H3-Base-Ref2VA，在「H3 生成策略」勾选「潜空间双采」。默认关闭，旧草稿、旧历史沿用原工作流。FastH3 不提供此选项；Ref2VA 双采与 Turbo 4 步互斥，切换时界面恢复标准步数。

## 参数与接线

- 尺寸栏是二采目标尺寸，继续遵守本地视频尺寸上限。
- 一采宽高比例：50% 或 75%，每一轴四舍五入到 32 像素网格。例如最终 1344×768、50% 一采为 672×384。比例指宽高，不是总像素比例，也不是 0.2MP。
- 一采步数沿用卡片步数；二采可设 3–8 步，默认 3。二采暂固定 simple scheduler、denoise=0.35，复用当前模型/LoRA、采样器与 seed。这是待 GPU 评估的初始配置，不是视频作者参数的逐项复现。
- 一采 clean/denoised AV latent → LTXVSeparateAVLatent → 仅视频送 MinimaxH3LatentUpscaler3D → 与一采音频 latent 合并 → 二采。目标尺寸重新构建 MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo 条件，继承首尾帧及全部图片/视频/音频引用，不直接插值旧参考条件。
- 二采使用 SamplerCustomAdvanced 的内部加噪，不额外叠加 AddNoise + DisableNoise。最终视频解码二采 clean latent，音轨直接解码一采 clean latent，避免精修替换原始声音。
- 可继续叠加 RTX 成片超分；RTX 输入为双采精修后的画面，输出仍保留双采成片。
- 草稿、生成历史和「复用这次参数」保存双采开关、比例、精修步数；进度区显示阶段 1/2、2/2。

## 依赖

安装 [LBH 节点](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler)，使用含 `enable_temporal_chunking` 与 `force_unload` 输入的当前 3D 节点。权重固定为：

`minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`

从 [作者模型仓库](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/tree/main/minimax_h3_latent_upscaler_3d_conv_v1) 下载到 ComfyUI 的 `models/latent_upscale_models/`。这不是 LTX 潜空间超分权重，也不是 RTX 像素超分模型。启动或重启目标 ComfyUI 后使用。

提交前查询 3D 超分、AV 分离、AV 合并节点，并检查指定权重是否出现在节点选项中。缺失时在上传素材及写入任务之前拒绝提交，不自动下载权重、不回退插值。节点和文件检查不代表 CUDA 推理已验证。

## 验证与限制

- `tests/test_h3_two_stage.py`：参考继承、音视频路由、clean latent 输出、Sage/RTX 组合、默认兼容、非法参数与网格尺寸。
- `scripts/smoke-h3-options-ui.cjs`：真实 Electron 隔离数据测试，检查双采选项、Ref2VA Turbo 互斥及保存重开。不提交 GPU 任务。
- 尚未完成目标 Windows GPU 的实际双采生成、音画质对比及耗时基准。不承诺复现视频中的耗时或画质。
- 未实现一采 latent 的持久化缓存及跨任务单独精修；目前每个任务执行完整两阶段流程。
- 学习型超分主要降低高分辨率采样步数，并不消除高分辨率精修的显存需求。

依据：[作者示例工作流](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/tree/main/workflow_templates)、[3D 节点源码](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/blob/main/nodes/minimax_h3_latent_upscaler_3d.py)。

### 2026-10-24 验证记录

49 项相关 Python 测试通过；JavaScript 语法及 diff 空白检查通过。真实 Electron 隔离界面测试通过双采参数保存重开、Ref2VA Turbo 互斥、缺失节点/缺失权重拒绝提交及既有 FastH3 回归。测试未连接目标 GPU、未安装远端权重、未提交真实生成。
