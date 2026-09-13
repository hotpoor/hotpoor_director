# Hotpoor Director · 导演编辑台

Electron 桌面端，内置 Python/Tornado 后端和 PostgreSQL。当前实现账号创建、登录、退出与数据库初始化；导演编辑功能尚未实现。

开发过程、验证结果和待办见 [开发日志](DEVELOPMENT_LOG.md)。

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

先启动 ComfyUI，固定使用本机 `http://127.0.0.1:8188`。模型文件须安装在 ComfyUI 中；Git clone 不会携带模型。界面显示的生成状态来自持久化任务和 ComfyUI 历史，不使用模拟图片或虚构用量。

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
