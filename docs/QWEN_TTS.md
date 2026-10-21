# Qwen3-TTS 独立配音

在项目画布工具栏点「＋ 独立配音」。这是独立 WAV 生成，不需要先生成视频。

- Base：选已有 WAV 音频素材，或在配音窗口导入参考录音；输入新台词。可填写参考原文，留空使用仅提取说话人特征的模式。
- CustomVoice：从权重提供的预设音色中选择，1.7B 可填写说话方式，0.6B 不开放该选项。
- 支持十种语言，每次台词 1–600 字。配音任务串行执行，可取消排队及运行中的任务。失败不切换云端或自动重试。
- 完成后可试听、下载 WAV、添加到当前画布。任务按账号、项目保存，保留模型、语言、台词和参考/风格信息。重复点击「添加到画布」不会创建同一音频的重复卡片。
- 生成结果先保存在工作站本机。不会因素材导入方式选择了云存储而自动上传配音。服务器部署模式不开放本地 Python 配音。

## 本地环境

在配音窗口展开配置，填写已有 Qwen Python、完整的 Base 或 CustomVoice 权重目录及设备。每个账号可覆盖工作站默认配置；不会修改 SayAgain、图片/视频账号或安装依赖。

也可用项目 Python 登记工作站默认值：

```sh
.venv/bin/python scripts/register-tts.py --python /absolute/qwen/python --model-path /absolute/Qwen3-TTS-12Hz-1.7B-CustomVoice --device mps
```

此命令检查权重结构，不下载模型或修改 Python 环境。真正合成时进一步验证依赖、设备和输出。需要 `qwen_tts`、PyTorch、soundfile 和模型依赖。

实现通过独立 Python worker 调用官方 `generate_voice_clone` / `generate_custom_voice`。权重加载在任务进程中，完成或取消后释放；没有论文中的 100ms 首包性能承诺。退出工作站会取消配音进程。重新启动后，未完成记录显示中断。

## 验证

- `tests/test_speech.py`：模型/输入校验，WAV 完整性，任务与音频资产持久化，取消后终止 worker、清理临时文件，账号配置隔离。使用模拟模型 worker。
- `electron scripts/smoke-speech.cjs`：独立临时账号及数据库，配音窗口、参数快照、取消、试听/下载入口、画布音频卡片和窄窗口。语音生成响应模拟，不发起付费请求。
- `scripts/verify-speech-local.cjs`：显式指定 `QWEN_TTS_PYTHON`、`QWEN_TTS_MODEL`、`QWEN_TTS_DEVICE`，用固定公开测试台词运行真实本地 CustomVoice 队列、WAV 保存、画布添加和完整播放。使用隔离数据库，保留输出路径，不读取真实账号密钥。

官方接口：[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)。

2026-10-21 本机真实验证：1.7B CustomVoice / Apple MPS，固定中文测试台词生成 3.12 秒 WAV，合成含启动约 27.12 秒，添加画布并播放至结束的总检查约 30.54 秒。未进行人工音色/情绪评分；不能推广为所有文本的速度或稳定性保证。
