---
name: hotpoor-local-startup
description: 启动、检查和重启本机 Windows 的 ComfyUI 与 hotpoor_director 源码桌面工作台，定位启动日志、端口冲突与连接配置。用于已有环境，不用于安装部署或生成任务。
---

# 本机 ComfyUI 与 Director 启动

本机 ComfyUI 路径为 `J:/codex_projects/ComfyUI`，Director 为 `J:/codex_projects/hotpoor_director`。先读取工作区 AGENTS.md、SHARED_VALUES.md 与项目说明，以当前脚本为准。不自动安装依赖、下载模型、发起生成或修改防火墙。

## 先检查

读取 Director 的 `scripts/start-all.ps1`、`scripts/restart-dev.ps1`、`Start_Dev.bat`，以及 ComfyUI 的 `Start_ComfyUI.bat`。确认嵌入式 Python、Director 虚拟环境、Electron 和所用 PostgreSQL 存在。

以完整 ExecutablePath 和 CommandLine 识别本项目进程，不按 python/electron 名称批量结束进程。检查 8188 监听 PID；短超时请求 `http://127.0.0.1:8188/system_stats` 和 `/queue`。健康的 ComfyUI 应复用；Director 已运行时核对窗口与实际 URL，避免重复启动。普通启动不无故重启健康服务。

## 联合启动或重启

已有联合入口具有重启语义：等待 ComfyUI 运行与排队任务清空（最多 10 分钟），重启匹配的 ComfyUI，等待就绪，再重启 Director。两项均未运行或用户要求联合重启时适用。

先只读预检：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:/codex_projects/hotpoor_director/scripts/start-all.ps1' -DryRun
```

实际执行去掉 `-DryRun`。手动入口为 `J:/codex_projects/hotpoor_director/Start_All.bat`；自动执行优先 PowerShell 脚本，避免 BAT 失败后的 pause。长启动使用可轮询的执行会话，每次等待不超过 60 秒，期间报告进展，不重复发起。

ComfyUI 当前参数为 `--windows-standalone-build --cuda-device 0 --reserve-vram 2 --listen 0.0.0.0 --port 8188`。这会监听所有网卡。用户要求仅本机访问时，使用下述单项启动方式显式绑定 `127.0.0.1`，不能直接套联合脚本。不要自行更改 GPU 与显存预留。

## 只启动缺失的一项

ComfyUI 未运行、Director 已运行时，确认 8188 空闲，用 `Start-Process` 启动 `J:/codex_projects/ComfyUI/python_embeded/python.exe`，工作目录为 ComfyUI，参数为 `-s main.py` 加上述参数。设 `-WindowStyle Hidden`，将 stdout/stderr 重定向到带时间戳的日志。手动入口是 `J:/codex_projects/ComfyUI/Start_ComfyUI.bat`。

ComfyUI 健康、Director 未运行时，沿用 `Start_Dev.bat`：工作目录设为 Director；若 `runtime/node/current/node.exe` 存在，将其目录前置到当前进程 PATH；清除当前进程的 `ELECTRON_RUN_AS_NODE`，用 `node_modules/electron/dist/electron.exe` 加参数 `.`、`--dev` 启动。后台使用 `Start-Process -WindowStyle Hidden` 并重定向日志；手动可双击 `Start_Dev.bat`。Electron 负责数据库、后端、桌面的启动顺序，不额外启动第二套后端。

只重启 Director：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'J:/codex_projects/hotpoor_director/scripts/restart-dev.ps1' -DryRun
```

先预检，再按任务需要去掉 `-DryRun` 执行。脚本优先正常关闭桌面，超时后只结束匹配路径的项目进程；embedded 模式通过 pg_ctl 干净停止对应数据库。不要删除数据库、锁文件或配置强行修复。

## 就绪与排错

- ComfyUI：`/system_stats` 和 `/queue` 返回实际信息；仅端口监听不算就绪。
- Director：以本次日志 `Source development workspace ready: http://127.0.0.1:<端口>` 与桌面窗口为依据，再请求实际 URL 确认页面响应。桌面端口动态分配，8765 仅是单独后端的默认值。
- 日志目录为 `J:/codex_projects/hotpoor_director/.local/restart-logs`；读取本次时间戳 stdout/stderr，只展示必要且脱敏的错误，不输出配置凭证。
- 数据目录优先 `DIRECTOR_DATA_DIR`，否则 `.local`；若 `.local/config.json` 不存在且 `%APPDATA%/hotpoor-director/config.json` 存在则使用后者。不要凭目录名猜测当前数据源。
- Director 项目列表右上角“ComfyUI 配置”可测试 Host `127.0.0.1`、Port `8188`，按用户意图保存。配置位于有效数据目录 `.comfyui.json`；存在未结束生成任务时不能切地址。历史素材依赖生成时的服务及输出文件，须保留。
- 8188 被其他进程占用时报告 PID 与路径并停止启动，不杀无关进程。队列繁忙或启动超时先查状态和日志，不重复启动。
- 缺少环境时说明确切路径，参考 `scripts/setup.ps1`，不将环境安装混入普通启动。ComfyUI 成功、Director 失败时分别报告，并保留可用服务。

完成后报告两项各自状态、实际 URL、日志位置和未解决错误。只做预检须明确未实际启动；创建或校验本技能不代表服务已启动。不以付费生成验证启动。
