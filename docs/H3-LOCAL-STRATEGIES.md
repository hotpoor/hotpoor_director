# 本地 H3 视频卡生成策略

根据用户提供的 `downloads/minimaxh3小红书.mp4`（9:46）的本机转写与关键画面核对，并对照当前 ComfyUI 官方文档实施。

## 视频建议与本机适用范围

| 视频位置 | 策略 | Director 的处理 |
| --- | --- | --- |
| 1:30–2:00 | 大显存 Blackwell、NVFP4 | 本机为 RTX 3090 24GB，不能照搬 Blackwell 的计算优势；保持已装 FP8 权重，不自动下载替换大模型。 |
| 5:25–6:30 | Sage Attention + Turbo，6 步试片、8 步较稳 | FL2VA 卡新增采样模式；Turbo 默认 8 步，可改 6 步；标准模式恢复独立保存的步数，初始 20。Ref2VA 保留自己的 4 步 LoRA。Sage 按任务选用 KJNodes 的补丁。 |
| 6:40–7:55 | 较低分辨率生成，再用 RTX 超分 2×/4× | 两种本地 H3 都支持选择倍率；输入分辨率和最终输出尺寸分开展示。超分保持 24fps 和原音轨，同时保存原片。 |
| 7:55–8:45 | API 批量排队 | Director 原有 ComfyUI API 与队列继续使用。本次不新增自动批量提交，也不替用户批量消耗 GPU。 |

视频中的耗时、云主机价格和每秒成本属于作者的环境和口径，未作为本机性能承诺。没有把超分后尺寸描述为原生生成画质。

## 在卡片中使用

1. 选择 MiniMax H3 · 本地或 H3-Base-Ref2VA。
2. 在「H3 生成策略」选择采样模式、Sage 和超分倍率。首尾帧模型推荐 Turbo 8 步试片；Ref2VA 使用原有 Turbo 4 步开关。
3. 先用短片和较低尺寸确认动作、人物与声音。横屏试片预设 832×480，竖屏 480×832，精细横屏 1120×640；原有 512×320 小尺寸仍可用。每个预设只改尺寸，不替换提示词、素材、seed 或时长。
4. 超分 2×/4×分别代表宽高同时乘以倍率。例如 832×480 的 4×输出是 3328×1920。超分额外消耗显存和时间。
5. 完成后优先展示超分版本，结果区同时提供原始视频。若超分失败，历史保留已返回的原片，任务仍明确标记失败；不自动重新生成。

Ref2VA 参考按钮按素材类型插入 `<Picture 1>`、`<Video 1>`、`<Audio 1>`；图片不会影响音频/视频的编号。FL2VA 使用「首帧」「尾帧」描述。不会自动改写旧提示词或上传参考素材到外部服务。

## 依赖与兼容

- Turbo 使用既有 LoRA，不添加依赖。FL2VA 的标准模式移除 LoRA，并让 guider/scheduler 使用同一个原始模型。
- Sage 需要 KJNodes 的 `PathchSageAttentionKJ`（上游节点 ID 拼写如此）和与目标 ComfyUI Python、PyTorch、CUDA 兼容的 `sageattention`。按任务只补丁 guider，遵循官方示例；不会修改全局启动参数。仅安装节点不代表运行库可用。
- RTX 需要 `RTXVideoSuperResolution`，来自 Comfy-Org/Nvidia_RTX_Nodes_ComfyUI，使用 NVIDIA `nvidia-vfx`。设定 `resize_type=scale by multiplier`、倍率和 ULTRA 质量。保存原片与超分结果为两个输出。
- 提交前查询当前连接的 ComfyUI 是否存在所需节点；缺失或检查失败时，在上传参考素材和写入生成任务前返回错误，不静默降级。节点存在后的驱动/动态库运行错误由 ComfyUI 返回，不能用节点存在冒充 GPU 可用。
- 新字段随草稿、生成参数和历史保存，可复用。旧 FL2VA 没有模式字段时继续使用原 Turbo LoRA；非 6/8 步的旧草稿显示「沿用旧 Turbo 步数」。旧 Ref2VA 默认标准模式。

## 验证入口

- `tests/test_h3_options.py`：标准/Turbo/Sage 接线、超分原片及音轨保留、兼容和参数校验。
- `scripts/smoke-h3-options-ui.cjs`：隔离数据库和真实 Electron 页面，检查切换、尺寸、保存重开、引用编号与缺失节点预检。节点检查使用桩，不提交 GPU 任务。
- 同时运行既有 `test_ref2va_turbo.py`、`test_size_limits.py`、`test_reference_media.py`。

参考：[ComfyUI H3](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)、[原生工作流](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)、[提示词规范](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-prompt-guide)、[RTX 节点源码](https://github.com/Comfy-Org/Nvidia_RTX_Nodes_ComfyUI)。

## 本次验证记录（2026-09-28）

47 项后端测试通过（包含项目保存/生成接口集成回归）；真实 Electron 隔离界面测试通过采样切换、超分尺寸、保存重开、缺失节点拒绝和混合素材标记插入。界面测试不提交 GPU 生成。

本机已安装 NVIDIA `nvidia-vfx 0.1.0.1` 与官方 RTX 节点（提交 `892515e3eb9a4920a131a502a047e47adca9eb0d`）。Sage 未安装：当前环境是 Python 3.12、PyTorch 2.13.0+cu126，PyPI 通用轮子为旧版 1.0.6，未擅自替换 PyTorch 或假定其支持当前 KJNodes 的接口。Sage 默认关闭。
