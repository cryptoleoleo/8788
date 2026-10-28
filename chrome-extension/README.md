# BAW Chrome 扩展 1.4.1：打开即后台启动

这是协作者已提交扩展的按需启动更新，不代表找回了最初截图中的原扩展。
原 BAW 页面、钱包和交易逻辑保持不变。

## 首次安装（Mac / Windows）

1. 安装 Node.js 24、Binance Agentic Wallet CLI 1.11.0。
2. 使用配套完整包：Mac rc5 运行原生安装器；Windows rc5 运行 Install-Windows.cmd。
   安装器只注册当前用户 Chrome 的 Native Messaging 启动组件，不设置开机启动。
3. Chrome 扩展管理页加载安装目录里的 `chrome-extension/`（直接包含 `manifest.json`），停用旧版本：
   - Mac：`~/Applications/BAW-Original-Multi/chrome-extension`
   - Windows：`%LOCALAPPDATA%\BAW-Original-Multi\program\chrome-extension`
4. 允许 GMGN / Debot 站点访问。以后直接打开插件，自动后台启动；无需终端。

固定公钥让不同安装路径的扩展 ID 保持一致；只允许该 ID 调用本地启动组件。
组件只接受“确保 BAW 已启动”，不接受命令、脚本、路径或交易参数。
Node 路径变化后，请重新运行安装器。只下载扩展 ZIP 不会安装本地组件。
旧版 `Open-BAW-Chrome-Extension.cmd` 是手动启动方式，新版日常不使用它。

## 行为

- 8787 服务已就绪则复用；未运行则隐藏启动。不改端口、不结束其他进程。
- 端口被旧版/其他程序占用、组件未安装、依赖缺失时，在侧栏提示错误。
- 关闭侧栏不继续面板跟单。服务可能留在后台，再次打开复用；重启电脑后首次打开插件再启动。
- 不自动登录、授权或交易；会话过期仍需用户重新连接。
- 支持 GMGN `/bsc/token/0x…`、`/bsc/token/分享前缀_0x…`，Debot `/token/bsc/数字_0x…`。
- 切换标签页、站内 URL 改变会跟随。GMGN BSC 列表保留已有详情弹层识别；Debot 仅解析 URL。

## 验证范围

自动测试覆盖 Native Messaging 消息格式、调用来源、并发启动、复用、端口冲突、URL 跟随。
本地服务测试使用虚拟 CLI，未读真实钱包、会话或浏览器资料。真实 Chrome 的加载和两站实页面需单独验收，不能用模拟接口测试替代。

本目录按 [MIT License](LICENSE) 发布，许可证只适用于本目录。
