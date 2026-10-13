---
name: service-inference-video
description: 使用 service-inference（TokenMart）生成视频，配置应用 AK 与管理 AK，按 Hotpoor Director 的方式直传参考文件到七牛、OSS 或 COS，并编写 Seedance 和 MiniMax H3 多模态视频提示词。适用于复用视频 API 或排查上传、任务查询和费用绑定；不用于本地 ComfyUI 推理。
---

# service-inference 视频生成

本 Skill 可以整目录复制给其他人使用。面向两种需求：在 Hotpoor Director 中操作，或在自己的应用中复用同样的 API 流程。接口以 **2026-10-12 检查的 Director 实现**为依据，不保证服务商之后的模型、配额和字段保持不变。

## 先解释三类凭据

| 凭据 | 作用 | 是否为生成视频所必需 |
| --- | --- | --- |
| 应用 AK（也称生成 AK） | `Authorization: Bearer …` 调用 `/v1/models`、生成和任务查询 | 是 |
| 管理 AK（`sk-mgmt-v1-…`） | 同样使用 Bearer，但调用 `/manage/*` 查询组织身份、费用等 | 推理协议不需要；Director 当前设置表单保存应用 AK 时要求绑定已保存的管理 AK |
| 云存储凭据 | 七牛 AK/SK、OSS AK ID/Secret 或 COS SecretId/SecretKey，用于签发上传凭证与校验对象 | 自己直传参考文件时需要；已有可用公网素材 URL 或纯文生视频不需要 |

**不是把两种 service-inference AK 一起放进生成请求。** 每个请求只传其接口所需的那一种。管理 AK 不用来上传素材，也不代替生成 AK。独立集成若只生成视频，可以仅配置应用 AK。

Director 的绑定是组织费用归属配置：多个应用 AK 可绑定一个管理 AK。旧的未绑定应用 AK 仍可生成，但查绑定费用需补齐绑定；当前 UI 新建或编辑保存会发送 `management_key_id`，后端拒绝空值。不要把这个产品约束说成服务商所有推理调用的必需条件。

## 执行流程

1. 明确模型、时长、画幅、是否声音、参考文件各自用途和输出位置。需要细节时读 [配置与直传](references/configuration-upload.md)。
2. 只读查询应用 AK 的 `/v1/models`，确认账户可见模型；Director 还要求模型在自己的注册表中。远端请求的模型名不带工作台内部 `si:` 前缀。
3. 如果需要上传，先取得用户对这些文件用于该生成任务的授权，再走「本机 MD5 → 后端签发 → 客户端直传 → 后端确认 → 公网 URL」。不要为了讲解或测试上传用户文件。
4. 按模型选择文生、首尾帧或多元素参考，参考编号与实际数组顺序一致。读 [提示词写法](references/prompts.md)，把人物、运动、镜头、声音和限制写成可执行的片段。
5. 按 [视频 API](references/video-api.md) 组装请求。只有用户授权生成时才提交付费 POST；讲解、配置检查和样例验证不需要生成。
6. 提交成功立刻保存 `task.id`、模型、接口版本和应用 AK 的内部标识；用同一 AK 轮询该任务。提交超时或缺少任务 ID 时先核对控制台，不能盲目重复提交。
7. 完成后保存 `task.outputs` 的地址及原始 usage；转存失败重试保存同一结果，不重新生成。说明验证层级：结构检查、模拟测试、真实请求受理、生成完成和用户认可效果是不同结论。

## 凭据与故障处理

长期 AK 保留在后端或私有配置中，不能写进提示词、项目文件、截图、日志或 Skill 示例。读取现有配置只输出名称、配置状态和模型，不打印隐藏配置文件。浏览器直传只拿到短期单对象凭证；不要把 service-inference Bearer 发给对象存储或输出下载域名。

401 检查密钥，403 检查权限，402 检查额度，429 等待后查询。上传成功但确认失败时检查公网域名、HEAD、Content-Length、对象类型与防盗链；模型获取素材失败时检查 URL 是否是文件直链，而不是分享页面、内网地址或登录后才能访问的资源。不要自动更换模型、AK 或降低用户已确定的创作参数。

## 依据与边界

Director 仓库：<https://github.com/hotpoor/hotpoor_director>。定位实现：`backend/inference.py`（请求构造、提交与轮询）、`backend/inference_models.py`（能力）、`backend/management.py`（管理 AK）、`backend/cloud_storage.py`（直传签名与确认）、`backend/web/storage.js`（文件字节上传）、`backend/web/inference-settings.js`（绑定表单）。

服务商文档入口：[豆包 Seedance](https://console.service-inference.ai/docs/doubao-seedance-max)、[Dreamina Seedance](https://console.service-inference.ai/docs/seedance-max)、[MiniMax](https://console.service-inference.ai/docs/minimax)。本次工具无法读取前两个网页正文，以下请求是已核对的仓库适配协议，不冒充本次已验证的线上文档或真实生成结果。调用前按账户实际模型列表与最新服务文档复核；厂商原生 API 与此网关不能直接混用。
