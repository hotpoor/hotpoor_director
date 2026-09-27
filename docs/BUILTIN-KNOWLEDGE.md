# Director 内置知识库

Wiki 的目录、路径解析、全文/行块读取、Jieba 分词检索、Qdrant + Ollama 混合检索以及 Markdown 导入已归入 `backend/knowledge/`。启动 Director 即启动同一 Python 进程中的知识库模块，无需运行原 `wiki_test/app.py`。

## 从客户端导入文件夹

桌面客户端打开「对话 → 设置 → 知识库」，选择 Director 内置知识库，在目录工具栏点击「导入文件夹…」。选择本机文件夹后递归导入 `.md`、`.markdown`（扩展名不区分大小写），显示扫描及处理篇数；隐藏目录、依赖目录、符号链接和目录联接不会跟随，其他文件跳过。PDF、Word 等格式目前需先转换为 Markdown。

导入完成后刷新为所选文件夹的目录；原有实体及正文历史保留，文献勾选不会自动扩大。没有支持的文件时保留原目录。文件读取或导入中途失败会明确报错，已处理文档可能已经入库，可修复后重试。Codex 独立文献选择页需要点击刷新目录更新其缓存。导入只做本地正文和分词索引；向量索引仍按选定范围另行建立。

文件选择由 Electron 原生对话框提供；网页及外部知识库模式不开放本机路径导入。导入期间阻止重复启动及正常关闭窗口，避免打断写入。命令行 `wiki-import --root` 继续可用。

## 数据与服务

Director 与知识库读取同一个 `config.json` 中的 `postgres` 连接，支持内置或外部 PostgreSQL。保留六个逻辑数据库：

- `hotpoor_director`、`hotpoor_director1`、`hotpoor_director2`：原账号、对话和项目。
- `wiki`、`wiki1`、`wiki2`：原倒排索引和正文实体。

Wiki 使用原生 UUID、正文 MD5 身份和奇偶分片，Director 使用自身的 EntityStore；二者不混写实体表。外部 PostgreSQL 须配置 `max_prepared_transactions >= 2`，建议 32，并使用能够初始化这六个库的管理账号。启动只创建缺失库/表和授予应用角色访问权限，不自动搬迁其他实例数据。

知识库 HTTP 适配器绑定随机回环端口，使用每次启动生成的内部令牌。令牌不写入配置、不返回浏览器；界面通过 Director 登录与 XSRF 保护访问 `/api/wiki/*`。登录用户可以访问本机共享知识库；对话选择仍按对话保存。该实现不提供知识库内逐文档账号隔离。

Qdrant 与 Ollama 仍是独立本机服务，未替换成 PostgreSQL 向量存储。默认 Qdrant 为 `127.0.0.1:6333`，Ollama 为 `127.0.0.1:11434`，模型为 `bge-m3`；支持原 `QDRANT_URL`、`WIKI_OLLAMA_URL`、`WIKI_EMBED_MODEL` 环境变量。已安装的标准本机 Qdrant 可通过 `config.json` 的 `knowledge.qdrant_home` 指定（含 `bin/qdrant` 与 `config.yaml`），Director 启动时检查并按需启动，不终止已有服务。Ollama 与模型需事先准备。

语义清单位于有效数据目录 `knowledge/semantic/manifest.json`，向量位于 Qdrant 的 `wiki_passages_v1` 集合。迁移时二者应一起保留；模型签名不一致或索引不完整会报错，不静默退回单路搜索。

## 使用

1. 打开「对话 → 设置 → 知识库」，选择「Director 内置知识库」。
2. 启用注入、保存设置、刷新目录，勾选当前对话所需资料。
3. 提问时先解析所选路径，再在完整 ID 范围内执行分词与向量并集检索、RRF 排序及完整分页；按字符预算读取片段并记录实际来源。

新安装默认内置。旧配置没有 `provider` 时保持原外部服务，需要切换来源后保存；仍可选择「外部 Wiki 服务」使用兼容 API。`base_url` 仅在外部模式生效。

导入或更新 Markdown：

```bash
.venv/bin/python -m backend wiki-import --root /absolute/path/to/Markdown
```

使用与桌面相同的 `DIRECTOR_DATA_DIR`。导入始终检查文件内容，不再因文件树已有路径而跳过正文更新；相同正文合并路径，正文变更创建新实体，旧实体保留。搜索仍可能返回同路径的历史版本，不保证自动选择最新版本。索引按文档事务刷新，导入失败时可重跑；新增文件需在对话中刷新并重新勾选。当前文件树沿用单知识库根目录的原实现。

登录后的 API 为 `/api/wiki/library/health`、`tree`、`resolve`、`search`、`hybrid/search`、`semantic/index`、`semantic/status`、`blocks/:uuid`。除 `health` 外，接口参数与原 Wiki 保持一致；POST 要求 Director 的 XSRF 令牌。内置私有端口只用于进程内部，不作为第三方固定地址。

## 迁移与回退

迁移前停止源实例的 Director 写入，用 `pg_dump` 导出三个 Director 库，并保存原配置；不要复制运行中的 PostgreSQL 数据目录。目标库若已存在，应先检查冲突，不覆盖。导入后逐表核对记录数和内容摘要，再切换 `config.json` 的连接信息和 `.wiki-server.json` 的 `provider=builtin`。保留源库、SQL 和配置直到新环境确认可用。

回退必须先正常退出 Director，然后恢复旧配置并启动原 PostgreSQL。切换后如有新对话或项目写入，应先把这些新增内容导出/迁回，不能只恢复旧配置导致它们不可见。

## 验证

- `python -m pytest -q tests/test_knowledge.py tests/test_knowledge_semantic.py tests/test_wiki.py tests/test_dialogue.py`：隔离 PostgreSQL 的导入、更新、范围、分页与鉴权，以及混合排序/全文分段。
- `node scripts/test-wiki-selection.cjs`：5100 篇、51 页与失败回退。
- `node_modules/.bin/electron scripts/smoke-wiki.cjs`：独立数据库中的内置健康检查、外部兼容模式、120 篇勾选保存、确认与来源展示；向量和模型回答使用模拟响应，不产生付费请求。

## Codex 独立文献勾选

启用 `config.json` 的 `knowledge.codex_scope: {"enabled": true, "port": 8890}` 后，Director 的 `serve` 命令同时启动独立勾选页；退出时关闭。默认不替其他项目占用固定端口，端口冲突会明确报错，不连接未知旧服务。该服务不需要桌面登录，仅绑定 127.0.0.1，检查 Host、Origin 和写入的 XSRF，适合同机 Codex；不要把它作为多用户或公网服务。

- 页面：`http://127.0.0.1:8890/?thread=<Codex任务ID>`，保持原任务 ID 与路径清单协议。
- 存储：有效数据目录 `knowledge/codex-scopes/<任务ID>.json`；各任务独立、原子保存并检查 revision。迁移前备份选择文件，可用原目录的符号链接保持已有工作区指令兼容。
- CLI：`python -m backend.knowledge.scope_cli --thread <任务ID> status/search/read/index`（search/read 仍需相应参数）；只用 Python 标准库，无需旧 Wiki 环境。本机 `Sites/wiki-scope/scope.py` 保留为兼容入口。
- API 桥接：`8890/wiki/health` 和 `8890/wiki/api/...` 仅允许固定知识库接口，内部令牌始终在 Director 进程内。CLI 自动取得页面 Cookie 和 XSRF，未启动服务时直接报错，不回退旧 Wiki 或全库。
- 本机原选择目录已原样迁入 Director，原路径改为兼容链接。旧 `server.py` 仅检查 Director 健康状态；无需后台独立页面进程。页面代码位于 `backend/knowledge/scope_web/`。

验证：`tests/test_knowledge.py` 经真实隔离 PostgreSQL 检查多个任务、冲突、XSRF/Origin、103 篇/104 个历史实体完整分页、范围外拒读、空范围不检索及关闭/重启后选择保留；`scripts/smoke-codex-scope.cjs` 使用临时任务，在已运行 Director 上验证真实界面与索引检索，不改用户选择或调用付费模型。

## 本地计算与模型用量

工具与模型的强制说明见 [SKILL：本地优先](../SKILL.md#本地优先工具模型与调用边界)：Jieba/PostgreSQL 分词、Ollama `bge-m3` 向量化、Qdrant 检索均在本机；回答模型另行选择。环境变量可能覆盖地址，必须核对实际配置。只把本题所需的证据与引用提供给回答模型，复用已建索引，不默认上传整库或重建全库。

当前本机 CLI/API 已互通；项目云同步尚不包含 Wiki，线上授权回连本地检索仍待实现。本次文档约定不代表已部署云端知识库或新增本地生成模型。


## 常驻资料栏与首次索引

对话列表和正文之间默认显示「知识库资料」栏，可直接勾选文档或整个目录、清空当前对话范围、导入文件夹及刷新。收起对话列表后，资料栏继续保留。窄窗口下资料栏位于正文上方，独立滚动。进入知识库设置时复用同一组选择控件，返回对话后恢复到侧栏，选择仍按对话保存。

文件夹导入会写入 Jieba 分词索引；语义索引使用本机 Ollama `bge-m3` 和 Qdrant，在首次检索已选资料时启动，已建文档会复用。导入成功不等于向量已就绪。分词数据存在但 Qdrant 集合为空时，需要检查语义初始化和建库进度。

Windows 上已观察到首次在线程池加载 Qdrant/NumPy 时 DLL 初始化停滞。依赖现在在启动主线程加载，再将 Qdrant 的阻塞网络调用交给线程池，避免首次提问时才触发这条加载路径。


资料树会逐篇显示分词词条数、向量片段数、缺失/运行中/失败状态；文件夹汇总分词和向量完成篇数。状态来自数据库词条与语义索引清单，每 5 秒刷新。服务异常与未整理分开显示；外部兼容服务缺少该接口时明确标记“未提供”，不推测已就绪。

“整理已选资料”和发送前检查只处理当前选中的路径；已有向量复用，失败不无限自动重试。检查阶段不调用回答模型。范围解析、索引检查、双路分页检索、片段读取、提交回答模型分别显示进度；检索阶段的短期进度按登录用户和请求编号隔离，保存 15 分钟，正式来源记录仍随对话保存。
