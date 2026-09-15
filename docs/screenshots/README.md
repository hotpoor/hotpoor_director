# README 截图来源

采集日期：2026-09-15。界面代码版本：[685e857](https://github.com/hotpoor/hotpoor_director/commit/685e857)；截图脚本与 README 在本次提交中一起更新。

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
