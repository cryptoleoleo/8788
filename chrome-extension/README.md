# BAW Multiwallet Chrome 扩展

这是现有 BAW 本机网页的 Chrome Side Panel 扩展。点击工具栏图标会打开侧边栏，现有 BAW 页面会嵌入侧边栏，不会另开钱包网页标签；钱包签名仍由本机 BAW 服务处理。

在 GMGN 的 BSC 页面中，扩展会优先识别 `/bsc/token/0x…` 详情链接，也会监听详情弹层/页面更新，并定位左上角折叠 CA 控件的完整地址。只有唯一且可信的 CA 才会自动交给本机 BAW 的 `?ca=…&auto=1` 只读解析流程；识别有歧义时会停止解析，不显示候选列表，也不会猜测。扩展不会自动买入或卖出。

## 一键打开

解压整个 ZIP 后，双击根目录的 `Open-BAW-Chrome-Extension.cmd`。它会检查或启动 BAW 本机服务，在独立 Chrome 配置中加载扩展，并打开 GMGN BSC 页面。点击 Chrome 工具栏里的 BAW 扩展图标打开侧边栏；打开 GMGN 代币详情后，CA 会自动送去解析。

## 加载到现有 Chrome 配置

1. 在 Chrome 地址栏打开 `chrome://extensions`。
2. 打开“开发者模式”，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的扩展文件夹（本仓库中是 `chrome-extension/`）。
3. 点击工具栏中的 **BAW Multiwallet** 图标，侧边栏会直接显示钱包面板。

扩展仅申请访问本机 `127.0.0.1` 和 `https://gmgn.ai`。GMGN 权限用于读取该站页面中的合约地址；不会读取其他网站、密码、输入框内容或钱包密钥。初次加载或升级后，如 Chrome 要求批准 GMGN 网站访问权限，请允许该站权限以启用自动识别。

本目录源码按 [MIT License](LICENSE) 发布；该许可证只适用于 `chrome-extension/` 目录。
