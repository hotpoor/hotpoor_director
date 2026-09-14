# Hotpoor Director · 导演编辑台

Electron 桌面端，内置 Python/Tornado 后端和 PostgreSQL，提供私有项目列表、无限画布、素材管理，以及通过 ComfyUI 进行图片和视频生成。

开发过程、验证结果和待办见 [开发日志](DEVELOPMENT_LOG.md)。

首次部署、架构原理与维护排查见 [SKILL.md](SKILL.md)。也可以让代码助手先阅读仓库根目录的 `SKILL.md`，再按你的环境执行部署；该文件不包含个人账号或本地数据。

## 日常开发：直接启动源码

双击 `Start_Dev.bat`，或在项目根目录执行 `npm run dev`（`npm start` 也直接运行源码）。Electron 启动 `.venv` 中的 Python 读取 `backend` 源码，无需生成应用 EXE 或重新打包。

- 修改 `backend/web` 下的 HTML、CSS、页面 JS 和图片，保存后窗口自动刷新。
- F12 打开/关闭开发者工具。
- 修改 Python 文件或 `desktop/main.cjs` 后，关闭窗口再启动。
- 如果本项目尚无 `.local/config.json`，但此前桌面版已有账号数据库，会自动使用现有 `userData` 配置。`DIRECTOR_DATA_DIR` 可以显式指定另一套数据。

后面的构建命令只在需要分发安装包时使用，日常修改不需要执行。

## 数据库

同一 PostgreSQL 实例创建三个独立数据库：

| 数据库 | 表 | 字段 |
| --- | --- | --- |
| `hotpoor_director` | `index_login` | `login`, `user_id`, `createtime`, `updatetime` |
| `hotpoor_director1` | `entities`（唯一的用户表） | `block_id`, `body`, `createtime`, `updatetime` |
| `hotpoor_director2` | `entities`（唯一的用户表） | `block_id`, `body`, `createtime`, `updatetime` |

- `block_id` 和 `user_id`：32 个小写十六进制字符的 UUID，无连字符。`block_id` 由数据库默认生成并校验格式。
- `body`：JSONB，默认 `{}`；包含 GIN 索引和 `updatetime` 索引。
- `createtime`、`updatetime`：BIGINT Unix 毫秒时间戳。数据库写入默认值，UPDATE 触发器自动更新 `updatetime` 并保留创建时间。
- `login`：去除两端空格、统一小写、唯一；同一账号映射一个 `user_id`。
- 主库另有 `auth_credentials`（Argon2id 密码哈希）和 `auth_sessions`（随机会话令牌的 SHA-256、用户和有效期）。密码不放入 `index_login` 或实体 JSONB。
- 初始化可重复执行，不清空数据。运行应用使用普通数据库角色，建库使用独立的管理角色。
- 三个库不是主从副本，当前没有实现主从复制或读写路由。后续读写分离需另行部署副本与路由，跨库也不是同一事务。

## macOS 源码启动

准备 Homebrew、Python 3.12 和 Node.js 22.12+ 后，在仓库根目录执行：

```sh
brew install postgresql@18
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
mkdir -p runtime/pgsql
ln -s "$(brew --prefix postgresql@18)/bin" runtime/pgsql/bin
npm run db:init
./Start_Dev.command
```

若 `runtime/pgsql/bin` 已存在，先确认它指向可用的 PostgreSQL，无需重复建立链接。数据库由工作台管理，数据保存在项目 `.local/`；无需运行 `brew services start`。后续可双击 `Start_Dev.command` 启动，首次进入后自行创建账号。ComfyUI 在另一台机器上时，通过界面“ComfyUI 配置”填写其局域网 IP 和端口。

## Windows 开发启动

需要 Python 3.12、Node.js 22.12+ 和新版 Microsoft Visual C++ x64 运行库。PostgreSQL 二进制来自 [EDB 官方下载页](https://www.enterprisedb.com/download-postgresql-binaries)，本版使用 18.6。

```powershell
git clone https://github.com/hotpoor/hotpoor_director.git
cd hotpoor_director
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
npm start
```


如 Python 不在 PATH：`scripts/setup.ps1 -Python '完整路径/python.exe'`。如使用合法的应用本地 VC Runtime 目录，可以加 `-VCRuntimeDir '完整目录'` 将运行库放入 PostgreSQL 的 bin 目录，避免依赖系统旧版 DLL。

首次桌面启动会让你设置自己的账号和密码（12–256 字符），创建后自动登录。没有共享默认账号，创建首个账号的接口需要桌面进程产生的一次性启动凭据，同时使用 XSRF 校验。已有账号后不开放注册。

也可通过交互命令创建账号（密码输入不回显）：

```powershell
npm run user:create
npm run backend
```

单独后端默认在 `http://127.0.0.1:8765`；桌面模式自动分配 HTTP 端口。登录会话有效期 24 小时，退出会删除服务端会话，旧令牌随即失效。接口包括 `/api/login`、`/api/me`、`/api/logout`；POST 请求需要 `_xsrf` Cookie 对应的 `X-XSRFToken` 请求头。

## 配置与数据

开发模式首次运行自动生成 `.local/config.json`；Windows 上目录和文件都设置隐藏属性，并限制为当前用户访问。实际配置、数据库数据、运行组件、构建产物都被 `.gitignore` 排除。仓库仅提交 `config.example.json`，不要在示例里放真实凭据。

安装版本把配置和数据放在 Electron 的 `userData` 目录（Windows 通常为 `%APPDATA%/hotpoor-director`）。数据库目录是其下的 `postgres`，不会放在安装目录中，不会随应用更新覆盖。隐藏文件不是加密；GitHub/Hugging Face token 不会自动复制到本项目。

PostgreSQL 默认绑定 `127.0.0.1:55432`，只允许本机连接，并使用 SCRAM 密码认证。端口占用时在配置中更换端口。`DIRECTOR_DATA_DIR` 可覆盖配置/数据目录，`DIRECTOR_PG_BIN` 可指定 PostgreSQL 二进制目录。

连接已有 PostgreSQL：将配置 `postgres.mode` 改为 `external`，填写地址、管理账号与应用账号。管理账号需有建库、建角色权限；应用不负责启动或停止外部数据库。本版面向本机桌面，不直接暴露 Tornado 到公网。

应用正常退出时关闭它自己启动的数据库；首次写入较多时磁盘刷新可能需要一分钟。若数据库原本已在运行，附加的命令不会将它关闭。

## 构建和验证

```powershell
npm test
npm run pack
npm run dist
```

PyInstaller 将 Python/Tornado 打包为独立后端；Electron Builder 将后端和 PostgreSQL `bin/lib/share` 一起放入 Windows 安装包。构建目录为 `release`。不包含本地配置、账号、数据库数据、pgAdmin 或测试数据库。安装包默认未做代码签名，公开分发前需配置签名及检查第三方运行组件的再分发许可。

集成测试使用 `.test-data` 下的独立临时 PostgreSQL，验证实体字段、时间戳、JSONB、UUID 校验、密码哈希、账号唯一性、XSRF、首次账号保护、登录限流、会话注销和并发写入，不修改开发数据库。

首次版本只验证 Windows x64；macOS/Linux 需准备对应平台的 PostgreSQL 二进制并在目标系统构建。

## 项目 Dashboard 与无限画布

登录后进入自己的项目列表。可创建或编辑主标题、副标题、描述和多张封面（第一张为主封面，最多 20 张）。每个项目由服务端生成 32 位 UUID，创建/更新时间使用数据库毫秒时间戳。

- `hotpoor_director1.entities` 保存项目 JSON 和上传图片元信息；图片文件保存在本地配置目录的 `media/` 中。
- `hotpoor_director2.entities` 保存生成任务及历史。两个库仍各只有一张 `entities` 表，通过 JSON 的 `kind` 区分内容。
- 所有项目、上传图片、生成历史与输出接口都校验当前登录用户；不会接受客户端指定的 owner。
- 画布保存 `viewport` 和 `cards`，卡片有独立 UUID、位置、宽高、类型、各模式参数、选中历史和 pin 列表。编辑后 700ms 自动保存；请求串行，失败保留当前窗口草稿并重试。多窗口修改采用 revision 检查，冲突时停止覆盖，可先导出 JSON 草稿。
- 拖动空白处平移、空白处滚轮缩放；卡片内部滚轮滚动内容，Ctrl+滚轮缩放画布。拖动标题移动卡片，四边及四角均可调整尺寸。底栏可适配全部卡片或恢复 100%。
- 图片与视频卡片先选模型，再显示该模型支持的模式 tab。顶部显示当前结果，pin 数量可调 0–8，历史横向排列，最新在左。点击历史可查看参数/耗时并复用参数。退出或切换项目之前先完成保存。

### 本地生成

先启动 ComfyUI，默认使用本机 `http://127.0.0.1:8188`。项目列表页右上角“ComfyUI 配置”可设置 Host 和 Port、测试连接并保存；配置供本机所有项目共用，保存成功立即生效。有未结束的工作台生成任务时不能切换地址，连接失败保留旧配置。配置保存在工作台数据目录下的隐藏文件 `.comfyui.json`（仅连接配置，不包含账号密码），重启后自动读取。HTTP API 和 WebSocket 进度统一使用该地址。新生成记录保存服务地址，旧记录沿用默认地址，历史媒体始终从生成时的服务读取，因此需保留对应服务及输出文件。模型文件须安装在 ComfyUI 中；Git clone 不会携带模型。界面显示的生成状态来自持久化任务和 ComfyUI 历史，不使用模拟图片或虚构用量。

| 卡片 | 当前可生成 | 暂未配置 |
| --- | --- | --- |
| Z Image Turbo | 文生图；单张原图的 VAE 重绘（图生图） | 独立参考图条件模型/工作流 |
| Z Image 标准版 BF16 | 文生图、单图 VAE 重绘；反向提示词、CFG（默认 40 步 / CFG 4） | 独立参考图条件模型/工作流 |
| MiniMax H3 fl2va | 文生视频；首帧、可选尾帧图生视频，带原生音频，使用已安装的 8-step Turbo LoRA | 多图参考请选择 Ref2VA 模型 |

| H3-Base-Ref2VA FP8 | 图片、视频、音频混合参考共 1–8 项，视频/音频各最多 3 项，默认 20 步；生成带音轨 | 视频参考仅取画面，声音需独立音频输入；默认使用素材开头 |
| LTX-2.5 22B 蒸馏版 INT8 | 文生视频、单首帧图生视频；固定 8＋3 步、2 倍潜空间放大，带音频 | 尾帧/多元素参考暂未接入 |

先选择模型，再显示其支持的模式 tab；未接入的参考模式隐藏，原有草稿保留。Z Image 的图生图是原图重绘，不等同于人物身份保持或多图参考。H3 时长按 24fps 和模型帧数网格向上对齐，实际时长可能略长于输入值。

标准版使用 `diffusion_models/z_image_bf16.safetensors`，与 Turbo 共用 `text_encoders/qwen_3_4b.safetensors` 和 `vae/ae.safetensors`。步数范围 1–60，CFG 范围 1–20；[官方建议](https://blog.comfy.org/p/z-image-day-0-support-in-comfyui)为 30–50 步、CFG 3–5。

LTX 的宽高是最终输出尺寸，须为 64 的倍数，默认 512×320；帧数按 24fps、8k+1 对齐。H3 Ref2VA 默认 512×320、5 秒，建议先用少量参考图；这版不混用 fl2va 的 Turbo LoRA。上游连线的生成图片也可添加到 Ref2VA 的参考列表。

本地 ComfyUI 不返回 token 计费用量，历史中 `usage.tokens` 为 `null`，界面显示“未提供”，并保留模型、提示词、seed、尺寸、步数及实际返回的耗时。输出文件由 ComfyUI 持有，播放/查看时仍需 ComfyUI 运行；工作台通过已认证的接口访问相应任务输出。

素材支持图片 PNG/JPEG/WebP（单张 20MB），视频 MP4/WebM、音频 MP3/WAV/OGG/M4A/WebM（单文件 200MB，播放取决于浏览器对文件编码的支持）。画布顶部“导入素材”按钮、文件拖入和剪贴板文件/图片粘贴均可创建独立素材卡片；卡片可移动、八向缩放，图片可放大，音视频支持分段播放。拖入/粘贴到参考图区域时作为生成输入；项目设置中则添加封面。文件选择器仅由按钮唤起，不显示原生文件 input。普通文字粘贴仍由输入框处理。当前最多 200 张卡片/项目。历史暂未分页，海量记录时需增加分页与缩略图。提交超时不会自动重复入队；先检查 ComfyUI 队列再手动重试。ComfyUI 清空历史或重启后，未回传结果的任务可能需要人工确认。

官方模型说明：[Z Image](https://comfyanonymous.github.io/ComfyUI_examples/z_image/)、[MiniMax H3](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)。

### 开发验证

`npm test` 使用独立临时 PostgreSQL。`scripts/smoke-studio.cjs` 使用 `.test-data/studio-smoke` 数据库（需预先准备测试配置，端口建议 55440），检查项目创建、参数切换、八方向缩放、自动保存、重新打开和窄窗口布局。`scripts/smoke-generation.py` 为可选真实 GPU 测试，会提交一张 256px 图生图，使用上述 UI 测试账号；不自动加入常规测试。

Logo 使用用户提供的透明原图，`scripts/prepare_brand.py` 可使用 Pillow 重建黑色原版、白色反白版和 PNG/ICO。原始透明图不加外圈白边。

### 图片放大预览

点击卡片大图、历史缩略图或 Pin 图片即可进入独立预览。滚轮/加减按钮缩放，拖动平移，100% 查看原尺寸，双击切换原尺寸与适应窗口；可切换同一卡片的历史图片。右上角支持系统全屏，Esc 关闭预览。此操作不会改变画布视角。

设置 `DIRECTOR_MATERIAL_SMOKE=1` 运行 `scripts/smoke-studio.cjs` 可追加素材交互检查，使用本机已生成的 `ComfyUI/output/director/smoke-video_00001_.mp4` 测试文件。

视频模型接口实测可设置 `DIRECTOR_TEST_MODEL=ltx-2.5`、`DIRECTOR_TEST_MODE=image`，或 `DIRECTOR_TEST_MODEL=minimax-h3-ref2va`、`DIRECTOR_TEST_MODE=reference`，运行 `scripts/smoke-generation.py`；使用隔离测试数据库，实际占用 GPU。


### H3 多元素参考

选择 H3-Base-Ref2VA → 多元素参考，用按钮、拖入、粘贴添加素材，或从连线的引入素材库选择（包括上游已生成的视频）。图片、视频、音频分别编号，提示词例如：`保持 <Picture 1> 的人物外观，参考 <Video 1> 的镜头运动，参考 <Audio 1> 的环境声。`

参考视频使用开头片段，按生成时长截取，转换为 24 fps 并按输出像素面积缩小，至少需要 5 帧。视频参考只输入画面；需要声音时请另加音频文件。音频使用开头片段、48kHz 双声道。转换只产生临时副本，原素材不变。参考信息随项目及生成历史保存；不同模型的输入类型由前后端共同校验，封面仍只接受图片。

在上述 H3 GPU 测试环境设置 `DIRECTOR_TEST_MULTIMODAL=1` 可验证图片＋视频＋音频生成（需先有 LTX 测试输出）；`electron scripts/smoke-multimodal.cjs` 检查参考素材 UI、连线引用、自动保存及切换模型。均使用隔离测试数据；不要同时启动使用 `studio-smoke` 数据目录的测试。


### 取消与停止生成

卡片顶部进度条旁提供“取消排队”或“停止生成”。多个任务时展开队列逐个操作，卡片内部滚动不影响顶部按钮。收到停止请求后显示“正在停止”，模型完成当前可中断阶段、队列确认移除后显示“已停止”；模型加载或解码期间可能需要等待。提交阶段取得任务 ID 后才可停止。已完成文件不受重复停止影响，可在历史复用参数重新生成。

需要 ComfyUI 支持按 ID 取消的 `/api/jobs/{id}/cancel` 接口；不支持或服务断开时会报错，不回退为全局停止。可选 `python scripts/smoke-cancel.py` 使用隔离测试账号创建三个 GPU 任务，验证取消排队、运行中断和后继任务正常完成；已有任务时自动退出。`electron scripts/smoke-cancel-ui.cjs` 使用模拟队列验证界面，不中断真实生成。


### 画布汇总队列

画布工具栏“队列”打开右侧列表，汇总当前项目的提交中、生成中、排队中和正在停止任务。可定位对应卡片，或逐项停止。拖动待执行任务、点击 ↑ ↓ 可调整真实执行顺序；其他项目或用户任务占据的槽位保持不变，正在执行的任务不可拖动。列表的“第 N 位”是 ComfyUI 全局待执行位置，可能因其他项目的任务而不连续。队列若已变化会提示刷新重试，不删除重提任务。

安装本地排序扩展：`python scripts/install-queue-extension.py <ComfyUI目录>`，等待 ComfyUI 队列清空后重启。扩展使用当前版本 PromptQueue 的 mutex/heap，升级 ComfyUI 后应运行相关测试；未加载时排序禁用，查看/定位/取消仍可用。队列顺序由运行中的 ComfyUI 持有，不保证跨 ComfyUI 重启保留。

`python scripts/smoke-queue.py` 为可选真实 GPU 测试，只在队列为空时启动；`electron scripts/smoke-queue-ui.cjs` 使用模拟队列检查界面。使用已有隔离测试配置和账号，勿并行启动同一个 studio-smoke 数据目录的测试。

### 模型尺寸与推荐

选择模型后，参数区显示推荐尺寸按钮和当前本机限制：宽高各 256–1536 px；Z Image 以 16 对齐，H3 以 32 对齐，LTX-2.5 最终输出以 64 对齐。图片总像素上限 2,359,296，视频 1,032,192。前后端均校验；范围内的长视频和大量参考仍可能超过显存，应先用低分辨率短片测试。这些限制是当前工作台的配置，不是模型理论最大尺寸。

### 视频 PIN 同时播放

在视频卡片固定至少两段视频后，勾选 PIN 区“同时播放”从开头一起播放；操作任一 PIN 视频的播放/暂停、进度和倍速，会联动其他 PIN 视频。取消勾选恢复独立控制；短片自然播放完毕不停止其余长片。设置自动保存，重新打开项目不自动播放。普通浏览器播放联动不保证逐帧同步，网络解码缓冲可能造成短暂差异。


### 放大预览复制图片

在图片放大/全屏预览区域右键，点击小菜单“复制图片”，即可把完整图片以 PNG 图像写入系统剪贴板；也可使用顶部“复制图片”或 Ctrl+C（选中文字时仍按普通文字复制）。复制保留原始像素尺寸及透明度，不受预览缩放、平移影响。图片未加载成功时不能复制；复制结果或权限错误会显示在预览顶部。

## service-inference 云端图片与视频生成

项目列表右上角的 **service-inference 设置** 提供 API Key 保存、替换、清除和只读连接测试。接口使用一个 `Authorization: Bearer` API Key，不需要额外的 Secret。密钥保存在有效数据目录下的隐藏文件 `.service-inference.json`（源码默认 `.local/.service-inference.json`），文件权限为当前用户读写；接口只返回是否已配置，不回显 Key。此目录已被 Git 忽略。所有生成请求由后端发送，不在画布或历史中保存密钥。有活跃云端任务时不能更换或清除 Key。

在图片或视频卡片中选择带“云端”的模型即可使用；本地 ComfyUI 模型继续保留。

| 类型 | 模型 | 已接入的模式 |
| --- | --- | --- |
| 图片 | Seedream 5 Pro、5 Pro EP、5 Lite、4.5 | 文生图、单张或多张公网参考图编辑；按模型选择分辨率档位 |
| 视频 | 豆包 / Dreamina Seedance 2.0 Max、Fast Max、Mini Max、2.5 Max | 文生视频、首尾帧、多元素参考；480p / 720p、画幅、4–15 秒和音频开关 |
| 视频 | MiniMax H3 | 文生视频、公网参考图生视频；768P / 2K、4–15 秒与画幅 |

参考素材填写公开可访问的 HTTP(S) 文件直链，每行一项；也可点击「选择文件直传」或把文件拖入对应字段，使用已配置的云存储自动获得公网 URL。上游素材库的「用作参考素材」同样使用客户端直传。云端不能直接访问 ComfyUI 内网 URL。Seedance 多元素参考按图片、视频、音频分别编号，提示词使用 `@Image1` / `@Video1`；首尾帧有独立字段。MiniMax 仅接入文档明确给出结构的图片参考。本版 Seedance 参考最多 12 项、视频/音频各 3 项，MiniMax 图片最多 5 项，为工作台输入上限，仍以服务端的模型校验为准。

Seedream 使用同步图片接口（请求在后台执行），请在图片请求完成前保持应用开启。视频提交后保存远端任务 ID，Seedance 每 10 秒、MiniMax 每 15 秒查询一次；应用重启会继续查询已有 ID，不会重新发起生成。生成完成后自动保存图片/视频到数据目录 `generated/`，历史播放、图片预览、PIN 和视频提帧使用带登录验证的本地结果接口，视频支持 Range 拖动播放。每个结果限制 210 MB；返回的用量按服务商原值记录，未返回 token 时不虚构。

云端接口文档没有取消或排序操作，因此这类任务只能查看和定位，不显示可用的取消/排序按钮；ComfyUI 的任务操作保持原有行为。提交超时或应用在提交期间关闭时，不自动重试付费请求：请到服务控制台核对受理状态。视频查询或结果下载的暂时性错误会自动重试；鉴权失效、无权限或任务不存在时会停止查询并显示错误。图片结果保存失败需在服务控制台核对；本版未接入组图、流式响应或精确像素尺寸输入。

接口依据：用户提供的 [Seedream](https://console.service-inference.ai/docs/seedream)、[豆包 Seedance Max](https://console.service-inference.ai/docs/doubao-seedance-max)、[Dreamina Seedance Max](https://console.service-inference.ai/docs/seedance-max)、[MiniMax H3](https://console.service-inference.ai/docs/minimax) 文档。生成按服务商规则计费；设置里的连接测试仅查询任务列表，不触发生成。

验证：`npm test`；`node_modules/.bin/electron scripts/smoke-inference.cjs` 使用独立临时数据库、测试 Key 和模拟云端响应，检查设置、四类模型生成路径、结果保存、视频 Range、自动保存与重开、窄窗口。测试不读取真实 Key，不调用付费生成接口。


### 云存储直传

项目列表 → **云存储直传设置**，按厂商切换表单。配置分别保存，点击「保存并启用」选择后续上传厂商。

| 厂商 | 凭据 | Bucket / 域名 |
| --- | --- | --- |
| 七牛 Kodo | AccessKey / SecretKey | 空间名称；必须填写绑定的公网访问域名 |
| 阿里云 OSS | AccessKeyId / AccessKeySecret | Bucket 名称；域名可选 |
| 腾讯云 COS | SecretId / SecretKey | Bucket 完整名称（包含 APPID 后缀）；域名可选 |

Region 可选择或填写，Endpoint 按地域自动生成，也可填写官方 HTTPS Endpoint。默认服务地址不包含 Bucket；自定义 CDN 域名填在「访问域名」。七牛地域地址依据[官方区域表](https://developer.qiniu.com/kodo/1671/region-endpoint-fq)。

文件字节从 Electron 渲染器直接发往云存储：七牛使用限定单对象的短时上传 Token + 表单 POST；OSS 使用 V4 签名 PUT，COS 使用签名 PUT。后端只接收文件名、类型、大小，签发 10 分钟凭证，并查询对象元信息及公网 HEAD；不代理云上传文件。确认通过才将公网 URL 填入模型参考字段。图片上限 20 MB，视频与音频 200 MB。单次直传，无分片续传；失败可在该参考字段重试，已成功上传但确认失败时仅重新确认。

在空间控制台配置 CORS：允许来源 `*`，方法 `PUT`、`POST`、`HEAD`，请求头 `Content-Type`（或 `*`）。客户端不发送登录 Cookie。需有对象上传和读取权限；「验证空间」额外需要查询空间信息权限。该验证不上传文件，不代表 CORS 或域名已可用。访问域名应允许公网读取、正确绑定 DNS，且防盗链允许云端获取素材。私有空间可使用已配置的公开 CDN；本版不签发下载链接，也不修改空间 ACL。

长期密钥保存在有效数据目录下 `.cloud-storage.json`（源码为 `.local/.cloud-storage.json`，文件权限 0600），不通过设置接口回显、不进入项目参数。清除厂商配置不会删除云端文件。需要实际厂商凭据、权限与 CORS 配好后，才能完成真实上传验证。

路径前缀可按厂商分别填写，例如 `projects/demo/images`，访问 URL 为 `<访问域名>/projects/demo/images/<唯一文件名>`。留空上传至 Bucket 根目录，首尾及重复斜杠自动整理。仅影响新上传对象，不移动已有文件或修改历史 URL。

画布工具栏的「添加到本机 / 直传云存储」选择素材添加方式。直传模式对文件选择、拖入空白画布和粘贴均生效；上传成功生成云素材卡片，支持预览、复制公网 URL、连接云端生成卡片作为参考，重开项目仍保留。云素材无需再上传到本地；ComfyUI 参考仍使用本地素材模式。

新直传对象使用文件内容 MD5 作为文件名（带类型扩展名），例如 `<域名>/<前缀>/<项目 block_id>/<MD5>.png`。同一项目、存储配置下的相同内容再次添加，会复用已完成的上传记录，只添加素材卡片，不重复传输文件。MD5 在客户端分块计算，原始文件名不参与去重；不迁移旧对象。

项目 block_id 同时用于对象目录与项目内去重，前缀留空时为 `<域名>/<项目 block_id>/<MD5>.<后缀>`。公网确认支持最多 4 次重定向并校验每一跳的公网地址，保存最终 URL。网络环境使用 SOCKS 代理时由 PySocks 提供 SDK 支持。

云存储直传时右下角显示文件名、批次序号与阶段进度：MD5 校验百分比 → 重复检查 → 实际传输百分比与字节数 → 公网确认 → 完成或复用。未知耗时阶段显示等待状态，错误原因保留在进度面板，完成或失败后可关闭。

### Seedream 创作模式

- 所有 Seedream：文生图、图片编辑、多图融合（至少两张图，按「图1」「图2」描述）。
- Pro / Pro EP：另有交互编辑，可上传已圈选/标记的参考图或在提示词中输入 `<point>` / `<bbox>` 坐标；目前无内置画笔。可选 standard / fast 提示词优化。
- Lite / 4.5：另有组图生成，设置最多张数 1–15，参考图数量与输出上限之和不能超过 15。实际张数由模型决定，返回的全部图片在组图缩略图中查看并保存本机。
- 输出格式按模型提供（4.5 仅 JPEG），水印可配置。本版组图使用同步响应，未接 SSE 流式输出。能力依据用户提供的 Seedream API 文档。

云素材预览仍直接加载公网图片；复制图片时通过本机鉴权接口读取当前账号已确认的原图，并校验大小与 MD5，避免跨域 Canvas 污染。此读取仅用于复制，不改变客户端直传上传路径。

Seedance 2.5（豆包 / Dreamina）的工作台时长范围为 4–30 秒；2.0 系列及 MiniMax 保留原来的 4–15 秒。2.5 上限依据[官方模型说明](https://seed.bytedance.com/zh/seedance2_5)，实际 service-inference 长视频受理情况以服务端为准。

### 多 service-inference Key

设置中可添加、命名、编辑及删除多个 Key，单选一个用于新任务。保存、切换与「刷新模型」均调用该 Key 的 `/v1/models`，分别显示图片与视频模型；API 可见但尚未接入工作台的模型会注明，不能在生成卡片中选择。图片与视频卡片只提供当前 Key 已列出且工作台已接入的模型；旧卡片的不可用模型保留显示并禁用生成，避免修改已保存的创作参数。

旧单 Key 隐藏配置自动兼容为「原有 Key」，仍使用 `.local/.service-inference.json`、0600 权限，不回显凭据。任务保存 Key 的内部 ID 与名称，后续查询固定使用该 Key。切换 Key 不影响正在执行的任务；被活动任务使用的密钥暂不能替换或删除。模型列表是账号可见性结果，不代表实时余额、服务容量或最终生成成功。
