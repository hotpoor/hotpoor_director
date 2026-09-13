# 本机模型 SSD 迁移（2026-09-13）

已将 16 个完整 safetensors 权重及 11 个 YAML 配置复制到 `I:/AI/ComfyUI/models`，共 138,083,237,766 字节（约 138.08 GB）。逐文件在复制源数据时计算 SHA256，再完整读取目标数据对比，27 个文件全部一致。下载分块未复制，迁移时保留了 `J:/codex_projects/ComfyUI/models` 原件；随后按用户要求清理，见下方记录。

`J:/codex_projects/ComfyUI/extra_model_paths.yaml` 原先不存在，本次新增 `director_ssd` 配置，使用 `is_default: true` 优先读取 I 盘同名模型。ComfyUI 没有重装；工作台、数据库、上传素材和生成输出的位置未修改。

等待用户任务结束、确认 running/pending 均为零后，检查工作台未完成记录并备份 4 条 ComfyUI 内存历史到工作台忽略目录 `.local/comfy-history-before-ssd-migration.json`。随后按原参数 `-s main.py --cuda-device 0 --reserve-vram 2 --disable-auto-launch` 重启。

验证：启动日志确认载入 I 盘七类模型目录；原生 folder_paths 对 16 个权重均优先解析到 I 盘；object_info 包含 15 个可选权重（embedding 通过文件路径单独验证）；system_stats、队列排序扩展、导演工作台 HTTP 均正常。本次未重新执行每个模型的 GPU 生成，也未测量加速比例。

本机校验清单：`J:/codex_projects/ComfyUI/setup/ssd-migration-status.json`，包含每个文件的字节数及 SHA256。切换验证：同目录 `ssd-path-verification.json`。

## 2026-09-13 · 按用户要求释放 J 盘空间

已删除 J 盘 16 个旧模型及 16 个对应下载分块目录，共清理 275,579,832,960 字节（约 275.58 GB）。保留原有小型 YAML 配置、目录占位文件及 ComfyUI 程序。删除前核对迁移校验清单、I 盘文件大小、原生优先路径和空闲队列；删除后确认旧文件与分块不存在，16 个模型仍解析至 I 盘，服务模型列表正常。

清理结果位于 `J:/codex_projects/ComfyUI/setup/ssd-cleanup-result.json`。J 盘现在没有模型备份；若要回退到 J 盘，必须先从 I 盘复制模型回来，再调整 extra_model_paths.yaml。
