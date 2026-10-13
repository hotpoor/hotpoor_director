# 本地截图与产品线快捷键

在截图设置中启用/停用、录入组合键并设置当前产品优先级。默认快捷键是 `CommandOrControl+Alt+Shift+S`：Mac 为 ⌘⌥⇧S，Windows 为 Ctrl+Alt+Shift+S。截取鼠标所在显示器的整屏，PNG 写入剪贴板，不保存聊天内容、不上传。设置窗口会临时隐藏，其他窗口保持原样。

Director 从工作空间顶部或「对话设置 → 截图与快捷键」进入；SayAgain 从设置页或「截图」菜单进入。应用启动后在后台也能响应；未运行时不监听。

## 多应用协调

两个产品共用 `app.getPath('appData')/HOTPOOR/screen-capture/settings.json`，仅保存启用状态和快捷键。各自 userData 中的 `screenshot-priority.json` 保存本产品优先级，默认 Director 100、SayAgain 50，范围 0–1000。

同一共享目录的 `instances/` 使用原子写入的本机心跳文件通信（PID、随机实例 ID、产品名、优先级、时间戳）。每两秒选出最高优先级实例，同级按实例 ID 排序；只有获选实例注册快捷键。退出即注销，另一实例在下次检查接管。进程死亡或心跳超过 8 秒的实例不参与。独占 owner.lock 确保原监听者先注销，新监听者才接管，交接期间不会双重监听。活着但暂时卡住的进程不会被强行夺取监听权；进程退出后会自动恢复。冲突显示在截图设置中并自动重试。待命产品的快捷键修改通过本地请求/应答文件交由当前监听者校验，收到成功确认才显示保存成功；发生占用则保留原快捷键。不记录其他按键，不开启网络端口。

## 构建与打包

`npm run build:capture` 在 Mac 上用 Xcode Command Line Tools 构建并临时签名 arm64/x86_64 通用辅助程序。`npm start` / `npm run dev` 自动执行构建；直接调用 Electron 时请先运行该构建命令。其他系统跳过原生构建。

Mac 使用 CoreGraphics 的 `CGDisplayStreamCreateWithDispatchQueue` / `CGDisplayStreamStart`，从 IOSurface 编码 PNG，经 stdout 传入 Electron `clipboard.write([new ClipboardItem(...)])`。当前 SDK 已将此 API 标为不可用，因此通过动态符号解析调用系统兼容实现。已在 macOS 26.5.2 验证可捕获测试中的微信窗口，普通 screencapture 与 ScreenCaptureKit 在相邻时间未捕获同一窗口。不保证未来系统或所有受保护内容同样可用。

原生辅助程序不接受 shell 命令，参数只有显示器 ID，10 秒超时。权限不足、接口缺失、图片无效时明确报错，失败保留原剪贴板；不静默切换到可能漏掉窗口的 Mac 捕获路径。Windows/Linux 使用 Electron desktopCapturer，不声称能解决这些系统上的受保护窗口问题。

发布 Mac 包时将 `desktop/screenshot/bin/capture-macos` 作为 extraResources 放到 `screen-capture/capture-macos`，并随应用签名。Director 的 electron-builder 已配置该资源；SayAgain 当前仓库没有安装包构建配置，未来添加打包器时应遵循此布局，不能只把二进制塞入 app.asar。

测试：`npm run test:capture` 覆盖优先级交接、退出/崩溃、租约过期、快捷键冲突、保存失败回滚及共享设置接收。

桌面实测：`npm run test:capture:desktop`（需要 Playwright；可通过 `PLAYWRIGHT_MODULE` 指定已有安装路径）。启动两个隔离的 Electron 进程，验证真实全局快捷键交接、冲突、共享设置、重启持久化及原生截图到剪贴板。此测试会将真实整屏图像写入本机剪贴板，不上传；不要在不希望被捕获的画面上运行。可用 `CAPTURE_PEER_ROOT` 指向另一产品仓库进行跨版本联测。
