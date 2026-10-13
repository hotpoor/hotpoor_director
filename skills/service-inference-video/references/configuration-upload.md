# 配置与文件直传

## Director 配置顺序

1. 打开项目列表右上角「service-inference 设置」。在「管理 AK」中添加名称及管理密钥，保存会只读请求 `https://model.service-inference.ai/manage/whoami`，记录 `organizationId`。
2. 在「应用 AK」中添加名称和生成密钥，选择「绑定管理 AK」，保存并启用；保存/刷新模型查询 `/v1/models`，不发起生成。管理 AK 的组织应与该应用 AK 的账务归属对应，不能随意绑定一个组织来代替真实账单。
3. 在视频卡片选择已启用的应用 AK 和可用的云端模型。每卡片可选不同 AK，查询任务固定使用提交时的 AK，不因全局切换而换 Key。
4. 若需要直传文件，另开「云存储直传设置」，填写厂商、名称、长期凭据、Bucket、Region、上传 Endpoint、访问域名和路径前缀，保存并启用。
5. 将文件拖入卡片对应图片/视频/音频字段，或点击「选择文件直传」。等确认成功、URL 写回字段后再生成。

管理密钥与生成密钥分别存于有效数据目录的 `.service-inference-management.json`、`.service-inference.json`；云存储存于 `.cloud-storage.json`。源码通常使用 `.local`，桌面运行时以实际数据目录为准。文件权限为 0600，普通设置读取不回显秘密。不要复制这些文件到分享的 Skill。

管理接口用同一个 `https://model.service-inference.ai` 基址：`GET /manage/whoami`、`/manage/cost/summary`、`/manage/cost/breakdown`、`/manage/cost/by-key`，CLI 余额查询另用 `/manage/billing/balance`。Director 的费用页支持周期或 UTC 日期范围。费用是组织汇总，按 Key 分摊为近似值，不能冒充某段视频的准确价格。`unpricedCount > 0` 表示汇总不完整。精确项目账单可按 Director 已有的控制台 NDJSON 导入流程匹配任务 ID；不按相近时间猜。

## 三条连接分开

- 客户端 → Director 后端：登录态、XSRF 校验，申请直传凭证/确认结果。
- 客户端 → 对象存储：短期签名，无 Director Cookie，传文件字节。
- Director 后端 → service-inference：应用 AK Bearer，JSON 内只放公网素材 URL。

**文件没有直传到 service-inference，也不经过 Director 后端代理上传。** 这里说的是输入素材；生成结果转存是另外的后端流程。

## 上传协议（Director 自己的 API，不是 service-inference API）

登录 Director 后请求其部署地址下的接口。网页部署若有路径前缀应沿用实际站点路由。POST 携带会话及 `X-XSRFToken`；不要用应用 AK 替代 Director 登录。

客户端按 2 MiB 块计算文件 MD5，申请：

```http
POST /api/storage/uploads
Content-Type: application/json
X-XSRFToken: <当前登录会话的 XSRF token>
```

```json
{"name":"character.png","mime":"image/png","size":123456,"md5":"<文件实际32位小写MD5>","project_id":"<实际项目32位ID>"}
```

`project_id` 可为 null；传值时校验项目权限。后端按当前存储配置签发 600 秒单对象凭证。对象路径通常为 `<prefix>/<project_id>/<MD5>.<后缀>`；无项目时省略项目路径段；旧配置未设 prefix 时使用带 owner 的默认前缀。上传记录权限另按 owner 校验，不应把 MD5 对象命名当作访问控制。重复项若已完成，可返回 `{"reused":true,"asset":{...}}`，直接使用 `asset.url`。

非复用的响应结构：

```json
{
  "upload_id":"<上传记录ID>",
  "provider":"qiniu",
  "expires_in":600,
  "upload":{
    "method":"POST",
    "url":"<厂商上传地址>",
    "headers":{},
    "fields":{"token":"<短期单对象token>","key":"<对象路径>"}
  }
}
```

- 七牛：构造 `FormData`，原样追加 `upload.fields`，最后追加 `file`。不要手写 multipart Content-Type，浏览器需生成 boundary。限定对象、大小和 MIME 的 Token 签名在后端完成。
- OSS：后端使用 V4 签名 PUT URL；COS：后端使用签名 PUT URL。以文件二进制作为 body，原样应用 `upload.headers`，尤其 Content-Type；不要换成 FormData。
- 使用响应中的 URL/方法，不根据公网 CDN 地址猜上传地址。`withCredentials=false`，不附带应用 AK、管理 AK 或长期存储 Secret。

2xx 后请求 `POST /api/storage/uploads/<upload_id>/confirm`，JSON `{}`。七牛 614（对象已存在）也进入确认，不直接视为成功。后端：

1. 校验该上传记录归属及原配置指纹。
2. 通过存储 API 校验对象字节大小和 MIME。
3. 检查公网地址 DNS 指向公网、HEAD 返回 200 和匹配的 Content-Length。
4. 标为 completed，返回 `id,url,name,mime,size,storage,provider`，此时才可填入模型参考。

这里的 MD5 用于客户端命名和去重；确认流程不重新下载整文件核对 MD5，不能宣称做了服务器全文件内容校验。确认失败重试相同 upload_id；签名过期但文件已上传仍可确认。当前无分片断点续传。

## 存储设置

| 厂商 | 长期凭据 | 备注 |
| --- | --- | --- |
| 七牛 Kodo | AccessKey / SecretKey | 必填空间和绑定的公网访问域名 |
| 阿里云 OSS | AccessKeyId / AccessKeySecret | Bucket + Region；可配置 CDN 域名 |
| 腾讯云 COS | SecretId / SecretKey | Bucket 完整名称含 APPID 后缀 |

上传 Endpoint 与公网访问域名用途不同，前者使用厂商对应地域地址，后者负责模型下载文件。服务端模式及云端结果保存要求 HTTPS 访问域名。公网可读 URL 会让持有链接者访问素材，选择可用于该任务的文件，不把凭据当素材上传。

Director 现有 CORS 示例允许 Origin `*`，方法 PUT/POST/HEAD，请求头 Content-Type（或 `*`）。自建部署可按已知客户端 Origin 收窄；需要覆盖实际桌面本地端口或网页域名。验证空间仅查权限/空间信息，不证明浏览器 CORS、上传或 CDN 读取成功。防盗链不能阻止上游模型读取。

当前上传上限图片 20 MiB、视频/音频 200 MiB；模型限制可能更小，例如 Director 的 H3 提示要求音频单文件不超过 15 MB。取两层限制中更严格者，上传成功不等于模型受理。

## 输出保存不是输入直传

Director 桌面可保存本机或云存储，在线版固定云存储；提交时固定输出配置 ID 和指纹。七牛视频优先让对象存储抓取结果，失败回退转传；其他厂商/图片走后端转传。转存失败继续保存同一任务结果，不能重新发起付费生成。原配置被修改时应恢复原配置再处理，不静默换目的地。

## 腾讯云服务器上的 COS 解析差异

2026-10-12 修复：云主机本地 DNS 可把标准 COS 域名解析到 `169.254.*`，此前公网检查会误拒绝。当前仅对标准 HTTPS COS 域名在此情况下使用 DNSPod HTTPS DNS 取得公网 IPv4，并固定连接该公网地址，保留原域名证书校验；公共解析仍非公网或失败时拒绝访问。无需为此放开桶权限或修改 CORS。
