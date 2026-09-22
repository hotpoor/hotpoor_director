# README 截图来源

画布截图采集日期：2026-09-15；对话截图更新：2026-09-23。界面代码版本：[685e857](https://github.com/hotpoor/hotpoor_director/commit/685e857)；截图脚本与 README 在本次提交中一起更新。

7 张截图覆盖 README 的 8 个特色，并展示 service-inference 多 Key 管理。截图来自当前源码在 macOS Electron 中的实际渲染，由 `webContents.capturePage()` 直接保存为 PNG，保留原始分辨率，未做图像后期合成。脚本在测试项目中配置卡片、连线和视口，实际点击模式、固定结果、播放视频并绘制标注。

测试账号、项目、Bucket 和域名均为演示数据；图片使用仓库 Logo，视频使用测试色块。云生成、对象存储和模型列表响应由测试程序模拟，没有调用付费生成接口或使用真实云服务凭据。截图用于展示操作界面，不能据此判断模型画质或真实云服务的可用性。

## 文件对应关系

| README 文件 | 运行脚本 | 脚本输出文件 | 原始像素 | 展示内容 |
| --- | --- | --- | --- | --- |
| `workspace.png` | `smoke-comments.cjs --readme` | `reference-connections.png` | 3000 × 2000 | 无限画布与素材、评论、生成卡片的参考线 |
| `pins-comparison.png` | `smoke-inference.cjs --readme` | `pins-comparison.png` | 3000 × 2000 | 多图 PIN 与多视频联动对比 |
| `model-guidance.png` | `smoke-inference.cjs --readme` | `model-guidance.png` | 3000 × 2000 | 模型 Tab 指引和本地 / 云端模型混用 |
| `service-inference-keys.png` | `smoke-inference.cjs --readme` | `keys-overview.png` | 3000 × 2300 | 多 Key 与分类模型列表 |
| `cloud-storage-profiles.png` | `smoke-inference.cjs --readme` | `storage-profiles.png` | 3000 × 2300 | 多厂商及同厂商多套存储配置 |
| `video-clip.png` | `smoke-comments.cjs --readme` | `video-clip.png` | 2360 × 1576 | 指定开始秒数和结束秒数 |
| `image-review.png` | `smoke-comments.cjs --readme` | `image-review.png` | 2360 × 1576 | 保留原图的独立框选和涂鸦标注 |

文件大小与 SHA-256 见 [manifest.json](manifest.json)。

## 更新截图

完成仓库依赖安装后，在仓库根目录运行：

```sh
node_modules/.bin/electron scripts/smoke-inference.cjs --readme
node_modules/.bin/electron scripts/smoke-comments.cjs --readme
```

Windows 对应入口为 `node_modules/.bin/electron.cmd`。两个脚本各自创建 `.test-data/` 下的临时配置和 PostgreSQL，并在结束时输出截图目录；无需指定个人数据目录或填写真实密钥。`--readme` 会额外组织用于说明文档的测试场景；云端脚本使用 `scripts/capture-readme-scenes.cjs` 生成额外截图。

等待脚本验证通过后，按上表复制对应 PNG 到本目录，逐张检查截图是否清晰、表单是否回显凭据、说明是否与画面一致，再更新采集日期、界面代码版本和文件清单。图片在 README 中使用仓库相对路径，不链接个人测试目录。

## 本次验证范围

两个 Electron 界面脚本均通过。新增场景检查了多图 PIN、两个视频的播放 / 暂停 / 进度 / 倍速联动、按模型展示不同 Tab，以及本地和云端卡片在同一画布中保存与重开。评论脚本检查指定时间段播放到终点暂停、引用连线、标注与片段保存、原素材复用及标注期间未重新上传媒体。

图片标注只增加评论中的坐标和笔迹，视频片段只增加时间边界，二者继续引用原文件。静态截图只展示可见状态，播放联动和数据持久化以脚本断言为验证依据；后端事务、权限和分片一致性仍应依据对应自动化测试核验。

## 双向同步截图

`cloud-sync-diff.png` 由 `electron scripts/smoke-sync.cjs --readme` 采集，展示多目标配置、AK 不回显、三方差异、冲突提示和拉回副本入口。使用独立数据库，云端差异为界面测试样例；完整双端流程另由 `tests/test_cloud_gateway.py` 验证。

## 分享与成员截图

`collaboration.png` 来自 `electron scripts/smoke-collaboration.cjs`，使用独立数据库和模拟成员接口，展示角色 / 生成许可、成员自己的 AK 入口和可选期限只读链接。账号授权、成员独立凭据、到期 / 撤销和跨项目隔离由 `tests/test_cloud_gateway.py` 验证。

## 自定义确认遮罩

`dialog-confirmation.png` 由 `electron scripts/smoke-card-removal.cjs` 在隔离数据库采集（2026-09-15，基于 `2e26ad1` 的本次弹窗改动），展示卡片移除确认。该脚本验证取消、确认后保存与项目切换保护；`electron scripts/smoke-dialogs.cjs` 另外验证嵌套弹窗层级、Esc、焦点、输入、排队及桌面离线错误界面。

- `timeline.png`：2026-09-18，`scripts/smoke-timeline.cjs` 在独立测试数据库中的真实 Electron 截图。展示双视频重叠、金色开始线/红色播放线与绝对字幕；绿色画面为程序生成的 6 秒测试视频。覆盖实际拖动、磁吸、裁剪、缩放横滚与保存重开，无生产账号或生成费用。

- `timeline-pin-quad.png`：2026-09-18，真实 Electron 独立测试项目，展示多轴重叠错层与 PIN 四宫格、声音选择。四路均使用 6 秒程序生成测试视频，非生产媒体；复现脚本 `scripts/smoke-timeline.cjs`。

## 对话与代理截图（2026-09-23）

基于本次对话布局改造后的工作区源码，运行 `node_modules/.bin/electron scripts/capture-dialogue-readme.cjs` 生成：

| 文件 | 内容 |
| --- | --- |
| `dialogue-wiki.png` | 合并远端知识库后，统一设置中的知识库服务与选取范围 |
| `dialogue-model-picker.png` | 搜索模型、当前选中标记和 AK 来源 |
| `dialogue-workspace.png` | 收起目录的默认阅读布局、底部上传与模型选择、左下角设置 |
| `dialogue-connection.png` | 设置页中的模型与连接配置 |
| `dialogue-overview.png` | 分类、自动保存标题、Markdown 目录和表格 |
| `dialogue-settings.png` | 设置页中的运行模式、字号、历史轮次及卡片尺寸 |
| `dialogue-agent-approval.png` | 执行前命令、目录、原因与确认按钮 |
| `dialogue-agent-output.png` | 执行中输出、耗时与停止按钮 |

独立测试数据库使用 `tests/dialogue_backend.py` 的 `DIRECTOR_README_SCENES=1` 演示响应；`scripts/readme-preload.cjs` 模拟命令输出和凭据名称。截图为真实 Electron 页面直接采集的 PNG，没有图像合成。演示脚本不执行所展示的命令，不调用付费模型，不访问实际凭据和私人对话。它不验证真实命令中断；真实 SIGINT 与流输出行为分别由 `test-command-stop.cjs` 和 `test-command-output.cjs` 验证。截图脚本退出时关闭自己的测试后端，不影响正在使用的客户端。
