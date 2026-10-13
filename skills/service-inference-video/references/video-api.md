# 视频 API 请求与任务生命周期

以下 JSON 是 **service-inference 网关请求**，不要混成 Director 卡片的内部参数。基址 `https://model.service-inference.ai`。所有生成/查询使用同一应用 AK：

```http
Authorization: Bearer <APPLICATION_AK>
Content-Type: application/json
```

首先 `GET /v1/models`，从返回的 `data[].id` 确认权限。示例模型不保证每个账号可用；Director 内部 ID 如 `si:doubao-seedance-2-0-260128-max`，远端 `model` 必须去掉 `si:`。

## Seedance

提交 `POST /v2/video/generate`，查询 `GET /v2/video/tasks/<task.id>`。

文生视频示例：

```json
{
  "model":"doubao-seedance-2-0-260128-max",
  "content":[{"type":"text","text":"5秒单镜头。清晨窗边，一只白色陶瓷杯置于木桌中央，热气缓缓升起。镜头从中景平稳推进至近景，柔和侧逆光，杯体形状保持一致，无文字与水印，不出现人物。"}],
  "duration":5,
  "resolution":"720p",
  "ratio":"16:9",
  "generate_audio":false
}
```

多元素参考替换 `content` 为（URL 占位符必须换成已确认的真实文件直链）：

```json
[
  {"type":"text","text":"以 @Image1 的人物外观为准，采用 @Image2 的场景布局，参考 @Video1 的缓慢横移镜头，不复制其中人物。5秒内人物从画面左侧走到桌边停下，服装与面部保持一致。"},
  {"type":"image_url","image_url":{"url":"https://assets.example.com/person.png"},"role":"reference_image"},
  {"type":"image_url","image_url":{"url":"https://assets.example.com/room.png"},"role":"reference_image"},
  {"type":"video_url","video_url":{"url":"https://assets.example.com/camera.mp4"},"role":"reference_video"}
]
```

音频项结构 `{"type":"audio_url","audio_url":{"url":"<URL>"},"role":"reference_audio"}`。不要只在文字中提声音却漏传音频项；文本指代的具体音频标记须按该模型最新提示词约定核对，Director 已明确提供的 Seedance 标记是 `@Image1`、`@Video1`。

首尾帧模式使用 text + `role: first_frame` 的 image_url，尾帧可加 `role: last_frame` 的 image_url；首帧必填。这与 `reference_image` 的身份/风格参考不同，不要无意混合。

Director 当前接入豆包和 Dreamina 的 2.0 Max、Fast Max、Mini Max、2.5 Max，具体 ID 见仓库注册表。2.0 为 4–15 秒，2.5 工作台允许 4–30 秒；分辨率 480p/720p，比例 16:9、4:3、1:1、3:4、9:16、21:9。参考合计最多 12，视频和音频分别最多 3。上限是工作台适配值，服务端受理为准。

## MiniMax H3

提交 `POST /v1/video/generate`，查询 `GET /v1/video/tasks/<task.id>`。这个网关的接口不能直接替换成 MiniMax 官方原生接口。

```json
{
  "model":"minimax-h3",
  "content":[
    {"type":"text","text":"以 <Picture 1> 为主持人的人物与服装参考，<Audio 1> 只提供音色参考，不照读原音频。8秒固定中景，主持人看向镜头，轻轻举起手中的杯子并说：‘早上好，今天我们一起做一杯咖啡。’动作自然，背景安静，无背景音乐。"},
    {"type":"image_url","image_url":{"url":"https://assets.example.com/presenter.png"},"role":"reference_image"},
    {"type":"audio_url","audio_url":{"url":"https://assets.example.com/voice.wav"},"role":"reference_audio"}
  ],
  "duration":8,
  "resolution":"768P",
  "ratio":"16:9"
}
```

工作台接入时长 4–15 秒、768P/2K；图片最多 9、视频最多 3、音频最多 3、混合最多 12。音频必须伴随图片或视频，并选择多元素参考模式。H3 使用 `<Picture 1>` / `<Video 1>` / `<Audio 1>`，不要沿用 Seedance 的 `@Image1`。Director 不给 H3 发送 Seedance 专用的 `generate_audio`。视频/音频时长、编码和文件大小还需按上游限制检查。

## 响应、轮询和恢复

Director 期望提交返回 `{"task":{"id":"...","status":"pending"}}`；此时只是受理，并未生成完成。保存 task.id 后用同一模型对应版本 GET 查询，Seedance 通常每 10 秒、H3 每 15 秒；Director 准备阶段可缩短到每 2 秒。自己实现时设置整体等待期限，到期返回任务 ID 供续查，不重新提交。

- `pending` / `preparing`：等待；其他非终态保留服务商状态。
- `completed`：读取 `task.outputs`，每项可为 URL 字符串或含 `url` 的对象；读取 `task.usage` 或 `task.metadata.usage`。
- `failed`、`cancelled`、`canceled` 或 task.error：终止并保留任务 ID。
- 查询 401/403/404：停止并排查；网络错误、429 和暂时故障可退避重查 GET。
- POST 超时、断网、响应没有合法 ID：受理结果不确定，去控制台核对。不要把通用 HTTP 自动重试套在付费生成 POST 上。

收到 `X-Request-Id` 时保存用于排查。不要把所有 provider 原始错误体不加筛选地打印到日志，部分网关可能回显请求内容或凭据。下载输出时不附带生成 Bearer；下载/保存失败只重试输出阶段。Director 当前未接云端取消，不能将本地停止查询说成远端任务已取消或停止计费。
