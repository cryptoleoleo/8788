# 8788 / BAW 原程序增强版

在提供的原版 BAW 页面与 Node 服务内增加独立 Binance Agentic Wallet 身份、钱包分组、分组买卖和跟单。保留原交易函数、交易档位及默认服务端口 8787，页面品牌仍为 8788。

**本仓库暂不包含截图中原 Chrome 扩展的入口文件，没有 `manifest.json`，不能直接导入 Chrome。** 原扩展仍需由提供者补齐；这里没有创建替代扩展外壳。

当前分发包：[Mac 1.0.0-rc2 ZIP](releases/BAW-Original-Multiwallet-Mac-1.0.0-rc2.zip)，[SHA256](releases/BAW-Original-Multiwallet-Mac-1.0.0-rc2.zip.sha256)。下载时使用 GitHub 文件页面的 **Download raw file**。

解压后先读 `先读我.txt`，再打开原生安装器。安装目录为 `~/Applications/BAW-Original-Multi`。需要 macOS 13.5+、Node.js 24 和 Binance Agentic Wallet CLI 1.11.0；完整步骤、身份配对方式和验证限制见包内说明。安装器为 arm64/x86_64 双架构，本机验证了 arm64，未在 Intel 实机验证。安装器未经 Apple 公证。

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

`baw-oneclick/` 是程序源码；`packaging/` 是 Mac 启动分发说明与原生安装器构建代码；`tests/` 和 `verification/` 是测试及结果；`reference/` 是所提供跟单参考包中的静态源码材料。

Git 不包含展开的 `node_modules`。推荐使用 ZIP 内的原包依赖。仅从源码启动时，可在 `baw-oneclick` 中安装其声明的 npm 依赖，再使用根目录的 Mac 启动器；身份适配仍要求 CLI 1.11.0。需要逐字节核对原包时，必须使用 ZIP 中随附的原始依赖，重新安装依赖无法保证每个文件的 SHA256 一致。

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

已通过 16 项 Node 自动测试、原文件/交易函数回归检查、模拟 HTTP 服务、原页面交互和原生安装器测试。测试使用虚拟 CLI、模拟交易响应及临时浏览器 profile，没有执行真实交易或读取个人浏览器资料。真实双身份配对、链上交易/跟单及原 Chrome 侧边栏加载仍未验证。

不要提交任何钱包身份目录、会话、私钥、助记词、浏览器用户资料或 `.env`。朋友应在自己的设备上重新配对；发布包只包含静态程序、依赖、安装器和测试材料。
