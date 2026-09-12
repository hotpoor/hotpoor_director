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
| MiniMax H3 fl2va | 文生视频；首帧、可选尾帧图生视频，带原生音频，使用已安装的 8-step Turbo LoRA | 多元素 ref2va 权重及工作流 |

先选择模型，再显示其支持的模式 tab；未接入的参考模式隐藏，原有草稿保留。Z Image 的图生图是原图重绘，不等同于人物身份保持或多图参考。H3 时长按 24fps 和模型帧数网格向上对齐，实际时长可能略长于输入值。

标准版使用 `diffusion_models/z_image_bf16.safetensors`，与 Turbo 共用 `text_encoders/qwen_3_4b.safetensors` 和 `vae/ae.safetensors`。步数范围 1–60，CFG 范围 1–20；[官方建议](https://blog.comfy.org/p/z-image-day-0-support-in-comfyui)为 30–50 步、CFG 3–5。

本地 ComfyUI 不返回 token 计费用量，历史中 `usage.tokens` 为 `null`，界面显示“未提供”，并保留模型、提示词、seed、尺寸、步数及实际返回的耗时。输出文件由 ComfyUI 持有，播放/查看时仍需 ComfyUI 运行；工作台通过已认证的接口访问相应任务输出。

素材支持图片 PNG/JPEG/WebP（单张 20MB），视频 MP4/WebM、音频 MP3/WAV/OGG/M4A/WebM（单文件 200MB，播放取决于浏览器对文件编码的支持）。画布顶部“导入素材”按钮、文件拖入和剪贴板文件/图片粘贴均可创建独立素材卡片；卡片可移动、八向缩放，图片可放大，音视频支持分段播放。拖入/粘贴到参考图区域时作为生成输入；项目设置中则添加封面。文件选择器仅由按钮唤起，不显示原生文件 input。普通文字粘贴仍由输入框处理。当前最多 200 张卡片/项目。历史暂未分页，海量记录时需增加分页与缩略图。提交超时不会自动重复入队；先检查 ComfyUI 队列再手动重试。ComfyUI 清空历史或重启后，未回传结果的任务可能需要人工确认。

官方模型说明：[Z Image](https://comfyanonymous.github.io/ComfyUI_examples/z_image/)、[MiniMax H3](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)。

### 开发验证

`npm test` 使用独立临时 PostgreSQL。`scripts/smoke-studio.cjs` 使用 `.test-data/studio-smoke` 数据库（需预先准备测试配置，端口建议 55440），检查项目创建、参数切换、八方向缩放、自动保存、重新打开和窄窗口布局。`scripts/smoke-generation.py` 为可选真实 GPU 测试，会提交一张 256px 图生图，使用上述 UI 测试账号；不自动加入常规测试。

Logo 使用用户提供的透明原图，`scripts/prepare_brand.py` 可使用 Pillow 重建黑色原版、白色反白版和 PNG/ICO。原始透明图不加外圈白边。

### 图片放大预览

点击卡片大图、历史缩略图或 Pin 图片即可进入独立预览。滚轮/加减按钮缩放，拖动平移，100% 查看原尺寸，双击切换原尺寸与适应窗口；可切换同一卡片的历史图片。右上角支持系统全屏，Esc 关闭预览。此操作不会改变画布视角。

设置 `DIRECTOR_MATERIAL_SMOKE=1` 运行 `scripts/smoke-studio.cjs` 可追加素材交互检查，使用本机已生成的 `ComfyUI/output/director/smoke-video_00001_.mp4` 测试文件。
