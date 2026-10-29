# 8788 / BAW 原程序增强版

在提供的原版 BAW 页面与 Node 服务内增加独立 Binance Agentic Wallet 身份、钱包分组、分组买卖和跟单。保留原交易函数、交易档位及默认服务端口 8787，页面品牌仍为 8788。

## 打开插件时按需启动（1.4.1）

首次运行配套安装器，注册 Chrome 本地启动组件，然后加载安装目录里的 `chrome-extension/`。
以后打开侧栏自动后台启动 BAW，不需要手动打开终端。服务已运行时复用；端口冲突时提示，不强杀或改端口。

- [Mac 完整安装包 rc5](releases/BAW-Original-Multiwallet-Mac-1.0.0-rc5.zip)：运行原生安装器，Chrome 加载 `~/Applications/BAW-Original-Multi/chrome-extension`。
- [Windows 完整安装包 rc5](releases/BAW-Original-Multiwallet-Windows-1.0.0-rc5.zip)：运行 Install-Windows.cmd，Chrome 加载 `%LOCALAPPDATA%\BAW-Original-Multi\program\chrome-extension`。
- [仅扩展 1.4.1](releases/8788-GMGN-Debot-SidePanel-1.4.1.zip)：需先安装上述本地组件；仅加载扩展无法唤起服务。

这些目录直接包含 manifest.json。停用旧扩展，允许 GMGN / Debot 网站访问。Node 升级导致路径变化后重新运行安装器。
依赖仍为 Node.js 24、CLI 1.11.0；不复制钱包数据。首次配对、过期重连仍由本人完成。
关闭侧栏不继续运行面板跟单；服务可能留在后台供再次打开时复用。没有设置登录系统自启动。

验证：35 项本地回归、Mac 原服务后台启动/复用、原生安装器检查通过。[Windows CI](https://github.com/cryptoleoleo/8788/actions/runs/40656882835) 已验证中文路径、HKCU 注册、原生消息、隐藏启动及宿主退出后的服务存活。使用虚拟 CLI，未访问真实钱包；真实 Chrome 加载仍待手动验收。请使用 rc5 / 扩展 1.4.1，rc4 的 Windows 原生启动有中文路径问题。
扩展来源是协作者提交的现有版本，不代表找回了最初截图中的原插件。详见 [扩展说明](chrome-extension/README.md)。

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

### 与其他本机程序共用原有钱包登录（Mac，可选）

在安装目录的 `mac-options.json` 配置 `cliPath` 为另一个程序实际使用的 CLI JS 入口绝对路径，`sharedOriginalLogin: true`。原有身份只检查现有登录，拒绝从插件发起 signin/verify；需要恢复登录时使用原程序。可用 `isolatedCliPath` 指定经验证的 CLI 1.11.0，继续隔离新增独立身份。

本模式不复制会话或钥匙串，也不协调两个程序的交易队列。此次只验证共用登录和地址一致，没有执行同时下单测试。此功能已更新源码和本机安装，旧 rc5 ZIP 尚未包含这些后续修复。
