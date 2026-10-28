# 8788 / BAW 原程序增强版

在提供的原版 BAW 页面与 Node 服务内增加独立 Binance Agentic Wallet 身份、钱包分组、分组买卖和跟单。保留原交易函数、交易档位及默认服务端口 8787，页面品牌仍为 8788。

## Chrome 侧边栏扩展

**CA 自动跟随修复 1.3.1（Mac / Windows 共用）：** [下载扩展 ZIP](releases/8788-GMGN-Debot-SidePanel-1.3.1.zip)、[SHA256](releases/8788-GMGN-Debot-SidePanel-1.3.1.zip.sha256)。补齐 Debot 网站权限和 URL 识别，支持 GMGN 分享前缀，直接从当前标签页 URL 提取 CA，避免旧标签页延迟响应覆盖新 CA。解压后选择直接含 `manifest.json` 的目录手动加载，停用旧扩展并刷新代币页。已有 Mac / Windows 服务包继续使用。详见 [更新说明与验证范围](chrome-extension/README.md#131-更新与验证)。这是对协作者新增扩展的修复，不是对最初截图原扩展来源的确认。


`chrome-extension/` 是配套的 Chrome Manifest V3 侧边栏扩展源码，不修改原 BAW 页面或交易服务。扩展把现有本机 BAW 页面嵌入侧栏，并针对 GMGN 的 BSC 代币详情识别 CA：优先使用 `/bsc/token/0x…` 路由；页面弹出详情时，定位左上角折叠 CA 控件。只有唯一且可信的 CA 才自动送入本机 BAW 只读解析；无法明确定位时不猜、不显示多地址选择，也不触发买卖。

`chrome-extension/` 目录使用 [MIT License](chrome-extension/LICENSE)，仅覆盖此扩展源码，不改变仓库其他文件的授权状态。

### 安装

1. Chrome 114 或更新版本打开 `chrome://extensions`，启用“开发者模式”。
2. 选择“加载已解压的扩展程序”，选择本仓库的 `chrome-extension/` 目录。
3. 允许扩展访问 `gmgn.ai`，打开 GMGN 的 BSC 代币详情页，再点击工具栏中的 **BAW Multiwallet** 图标打开侧栏。
4. 本机 BAW 服务需在 `127.0.0.1:8787` 运行；扩展只负责把识别到的 CA 交给原 BAW 页面解析。

Windows 也可解压 `releases/8788-GMGN-SidePanel-1.3.0.zip` 后运行其中的 `Open-BAW-Chrome-Extension.cmd`。该启动器会检查/启动本机服务、加载扩展并打开 GMGN。扩展只申请本机服务和 `gmgn.ai` 的权限，不读取其他网站，不自动交易。GMGN 会动态更新页面结构；当前开发环境无法直接读取其页面（HTTP 403），详情弹层识别尚未在 GMGN 实站完成验证。

Mac 分发包：[Mac 1.0.0-rc2 ZIP](releases/BAW-Original-Multiwallet-Mac-1.0.0-rc2.zip)，[SHA256](releases/BAW-Original-Multiwallet-Mac-1.0.0-rc2.zip.sha256)。下载时使用 GitHub 文件页面的 **Download raw file**。

Windows 分发包：[Windows 1.0.0-rc3 ZIP](releases/BAW-Original-Multiwallet-Windows-1.0.0-rc3.zip)，[SHA256](releases/BAW-Original-Multiwallet-Windows-1.0.0-rc3.zip.sha256)。完整解压后双击 `Install-Windows.cmd`，再运行 `%LOCALAPPDATA%\BAW-Original-Multi\program\Start-BAW.cmd`。需要 Windows x64、Node.js 24、Windows 本机安装的 CLI 1.11.0，不需要管理员权限。独立身份数据保存在同级 `data` 目录，程序更新时保留。详见包内 `Windows-先读我.txt` 和 [Windows 自动验证](https://github.com/cryptoleoleo/8788/actions/workflows/windows.yml)。

旧扩展 1.3.0（不支持 Debot，建议使用上方 1.3.1）：[8788-GMGN-SidePanel-1.3.0 ZIP](releases/8788-GMGN-SidePanel-1.3.0.zip)，[SHA256](releases/8788-GMGN-SidePanel-1.3.0.zip.sha256)。源码以 `chrome-extension/` 为准。

Mac 版解压后先读 `先读我.txt`，再打开原生安装器。安装目录为 `~/Applications/BAW-Original-Multi`。需要 macOS 13.5+、Node.js 24 和 Binance Agentic Wallet CLI 1.11.0；完整步骤、身份配对方式和验证限制见包内说明。安装器为 arm64/x86_64 双架构，本机验证了 arm64，未在 Intel 实机验证。安装器未经 Apple 公证。

rc2 支持直接输入或粘贴 Debot BSC 链接，例如：

```text
https://debot.ai/token/bsc/312069_0x0c6302401aa5325c2e36f170f52c00b1d220b405
→ 0x0c6302401aa5325c2e36f170f52c00b1d220b405
```

输入框、“粘贴解析”、解析按钮、剪贴板识别和 `?ca=` 深链参数使用同一套地址规范化规则。支持链接查询参数、片段和末尾斜杠；Debot 非 BSC 路径会被拒绝。只解析字符串，不抓取 Debot 页面，不触发下单。

- 每个新增身份独立配对 Binance App，隔离 CLI 数据目录和钥匙串服务名。
- 可创建/重命名分组、移动钱包、逐钱包或整组勾选。分组买卖经确认后依次调用原版函数。
- 跟单参考用户提供的 `gang-copytrade.zip` 事件格式，只跟买入，默认预演，面板必须保持打开。
- 固定金额适用于已接入的平台信号；金额镜像仅处理能确认 BNB 计价的 Gang Soft 事件。
- 原预设监听仍使用原有身份。原交易路径不支持的代币会报错，不使用另一套交易引擎。

`baw-oneclick/` 是程序源码；`packaging/` 是 Mac / Windows 分发说明与构建代码；`tests/` 和 `verification/` 是测试及结果；`reference/` 是所提供跟单参考包中的静态源码材料。

Git 不包含展开的 `node_modules`。推荐使用 ZIP 内的原包依赖。仅从源码启动时，可在 `baw-oneclick` 中安装其声明的 npm 依赖，再使用根目录对应系统的启动器；身份适配仍要求 CLI 1.11.0。需要逐字节核对原包时，必须使用 ZIP 中随附的原始依赖，重新安装依赖无法保证每个文件的 SHA256 一致。

开发验证命令（Node 24）：

```sh
node --test tests/ca-input.test.mjs
# 完整原包依赖就位后：
node --test tests/*.test.mjs
# 页面测试需另装 Playwright，使用 Mac 上的 Google Chrome：
node tests/debot-browser.mjs
node tests/browser.mjs
node tests/original-page.mjs
```

已通过 21 项本地 Node 自动测试、原文件/交易函数回归检查、模拟 HTTP 服务、原页面交互和原生安装器测试。测试使用虚拟 CLI、模拟交易响应及临时浏览器 profile，没有执行真实交易或读取个人浏览器资料。真实双身份配对、链上交易/跟单及原 Chrome 侧边栏加载仍未验证。

不要提交任何钱包身份目录、会话、私钥、助记词、浏览器用户资料或 `.env`。朋友应在自己的设备上重新配对；发布包只包含静态程序、依赖、安装器和测试材料。

Windows 版保留相同页面、交易逻辑、多钱包分组、跟单和 Debot CA 识别。Windows 专用改动为 `.cmd` 入口、CLI 路径查找、手动 HTTP/HTTPS 代理读取、用户安装/数据目录，以及跨平台的隔离模块 file URL。Windows runner 只用虚拟 CLI 验证安装与服务，不代表真实钱包配对、实盘或 Chrome 侧栏已通过验收。

Windows CI 已通过：[运行记录](https://github.com/cryptoleoleo/8788/actions/runs/40534360538)、[验证清单](verification/windows-results.json)。验证环境为 Windows Server 2025 x64 / Node 24.13.0，包含 21 项回归与 CMD 安装/启动/模拟身份服务检查；分发 ZIP 的 SHA256 与该运行核对一致。用户 Windows 桌面和真实 Binance 配对仍需分别验收。
