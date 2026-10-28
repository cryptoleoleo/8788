# BAW Multiwallet Chrome 扩展

这是现有 BAW 本机网页的 Chrome Side Panel 扩展。点击工具栏图标会打开侧边栏，现有 BAW 页面会嵌入侧边栏，不会另开钱包网页标签；钱包签名仍由本机 BAW 服务处理。

在 GMGN / Debot 的 BSC 页面中，扩展直接读取当前活动标签页的 URL：支持 GMGN `/bsc/token/0x…`、`/bsc/token/分享前缀_0x…`，以及 Debot `/token/bsc/数字_0x…`。切换标签页、站内 URL 变化会重新识别。GMGN BSC 列表页仍保留已有的详情弹层识别；Debot 仅根据 URL，不扫描页面地址。只有唯一且可信的 CA 才会自动交给本机 BAW 的 `?ca=…&auto=1` 只读解析流程；识别有歧义时会停止解析，不显示候选列表，也不会猜测。扩展不会自动买入或卖出。

## 一键打开

解压整个 ZIP 后，双击根目录的 `Open-BAW-Chrome-Extension.cmd`。它会检查或启动 BAW 本机服务，在独立 Chrome 配置中加载扩展，并打开 GMGN BSC 页面。点击 Chrome 工具栏里的 BAW 扩展图标打开侧边栏；打开 GMGN 代币详情后，CA 会自动送去解析。

## 加载到现有 Chrome 配置

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开“开发者模式”，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的扩展文件夹（本仓库中是 `chrome-extension/`）。
3. 点击工具栏中的 **BAW Multiwallet** 图标，侧边栏会直接显示钱包面板。

扩展仅申请访问本机 `127.0.0.1` 和 GMGN / Debot（包括 www 子域）。网站权限用于识别这些网站的 BSC 代币；不会读取钱包密钥。初次加载或升级后，请允许这两个网站的访问权限。

## 1.3.1 更新与验证

Mac / Windows 共用这一份扩展：完整解压 `8788-GMGN-Debot-SidePanel-1.3.1.zip`，在 Chrome「加载已解压的扩展程序」中选择解压后的 `8788-GMGN-Debot-SidePanel-1.3.1` 目录，该目录直接包含 `manifest.json`。停用旧版本以免同时打开两个侧栏，刷新 GMGN / Debot 代币页再打开新侧栏。已有的 Mac rc2 / Windows rc3 服务包继续使用，无需重装或重新配对钱包。

本次只修复协作者已提交的扩展，不代表已找到最初截图中的原扩展。自动测试覆盖 URL 跟随、站内变化、旧响应竞争和消息循环，Chrome API 使用模拟接口；尚未在用户实际 Chrome 和两站实页面完成加载验收。未执行真实交易。

本目录源码按 [MIT License](LICENSE) 发布；该许可证只适用于 `chrome-extension/` 目录。
