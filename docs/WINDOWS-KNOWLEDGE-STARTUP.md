# Windows 本地知识库启动

Windows 源码版继续使用 `Start_Dev.bat` / `Restart_Dev.bat`，保留现有账号、配置和 PostgreSQL 数据。升级前备份有效数据目录和未提交源码；数据库冷备份必须确认实例已经停止。

## 运行组件

- 使用项目 `.venv` 安装 `requirements.txt`，内置 Wiki 新增 asyncpg、jieba 与 qdrant-client。
- 项目要求 Node.js 22.12+。可将官方 Windows x64 ZIP 解压到 `runtime/node/`，并让 `runtime/node/current` 指向选定版本目录。两个启动入口检测到其中的 `node.exe` 后仅为本次进程优先加入 PATH，不修改系统 Node。命令行 npm 也应使用该目录中的 npm.cmd。
- Qdrant 的 Windows 可执行文件位于安装目录 `bin/qdrant.exe`，macOS/Linux 仍是 `bin/qdrant`。同目录的 `config.yaml` 应将服务限制在 127.0.0.1，并把数据保存到固定位置。配置 `knowledge.qdrant_home` 后，Director 在需要时后台启动服务；已有健康服务直接复用，不随 Director 退出而结束。
- Ollama 单独运行，安装 `bge-m3` 后可提供本地向量化。检查实际 OLLAMA 模型目录和 Wiki/Ollama/Qdrant 地址覆盖；不要把嵌入模型当成回答模型。
- `knowledge.codex_scope.enabled=true` 可启用本机 8890 文献选择入口。端口必须空闲；仅用于本机，不是公网多用户服务。

下载应使用 [Node 官方发行目录](https://nodejs.org/dist/)、[Qdrant 官方发行](https://github.com/qdrant/qdrant/releases)、[Ollama bge-m3](https://ollama.com/library/bge-m3)。二进制对照官方 SHA-256 校验。运行组件、模型、凭据及数据库不提交 Git。

## 首次空库

代码更新不会带来其他电脑上的文献、向量或对话选择。尚未导入的知识库返回空目录、零条分页和 `imported:false`，不创建假资料，也不把空目录当成服务错误。文献范围未设置或为空时，依旧禁止回退全库检索。

实际文献迁移、索引清单与向量的配套迁移见 [内置知识库](BUILTIN-KNOWLEDGE.md)。已有语义清单不可与另一套空向量库混用。

## 验证

`tests/test_knowledge_services.py` 检查 Windows 隐藏启动、跨平台二进制选择和复用已有服务。`tests/test_knowledge.py` 使用生产目录权限初始化隔离库，并显式以 UTF-8 写入中文 Markdown 样本，验证空库、导入、分页、来源范围和重启保留。文献 CLI 的标准输出和错误输出固定为 UTF-8，避免 Windows 管道默认编码使 JSON 或中文错误无法被调用方读取。

桌面就绪、六个数据库存在、Qdrant 健康、Ollama 嵌入成功属于不同层次的检查；在没有迁入真实文献前，不声称用户知识库检索已验收。
