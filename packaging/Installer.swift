import AppKit
import Foundation

struct InstallFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
let fm = FileManager.default
let requiredFiles = ["native-host.mjs", "native-install.mjs", "chrome-extension/manifest.json", ".baw-original-multi-package", "baw-oneclick/serve.mjs", "baw-oneclick/node_modules/ethers/package.json", "mac-launch.mjs", "mac-network.mjs", "runtime.zsh", "启动原版服务.command", "mac-options.json", "baw-oneclick/wallet-runtime.mjs", "baw-oneclick/wallet-features.js", "baw-oneclick/copy-feed.mjs", "baw-oneclick/profile-bootstrap.mjs", "baw-oneclick/profile-keytar.mjs", "baw-oneclick/multi-service.mjs", "baw-oneclick/multi-store.mjs", "baw-oneclick/wallet-features.css", "baw-oneclick/ca-input.mjs"]

func validatePayload(_ root: URL) throws {
    for name in requiredFiles {
        let file = root.appendingPathComponent(name)
        guard fm.isReadableFile(atPath: file.path) else {
            throw InstallFailure(message: "安装文件缺失或无法读取：\(name)。请重新解压完整 ZIP，并双击「安装 BAW 多钱包增强版.app」。")
        }
    }
}

func portIsBusy(destination: URL) throws -> Bool {
    var port = 8787
    if let data = try? Data(contentsOf: destination.appendingPathComponent("mac-options.json")),
       let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let selected = config["port"] as? Int, selected > 0, selected <= 65535 { port = selected }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
    process.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN"]
    process.currentDirectoryURL = fm.homeDirectoryForCurrentUser
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus == 0
}

func install(payload: URL, destination: URL) throws -> URL? {
    try validatePayload(payload)
    let parent = destination.deletingLastPathComponent()
    guard destination.path != "/", destination.path != fm.homeDirectoryForCurrentUser.path else {
        throw InstallFailure(message: "请选择专用安装目录。")
    }
    if fm.fileExists(atPath: destination.path) {
        let values = try destination.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard values.isSymbolicLink != true, values.isDirectory == true,
              fm.fileExists(atPath: destination.appendingPathComponent(".baw-original-multi-package").path) else {
            throw InstallFailure(message: "目标位置已有其他文件，未覆盖：\(destination.path)")
        }
        if try portIsBusy(destination: destination) {
            throw InstallFailure(message: "请先在 BAW 原启动窗口按 Control+C，停止原服务，再重新安装。")
        }
    }
    try fm.createDirectory(at: parent, withIntermediateDirectories: true)
    let stage = parent.appendingPathComponent(".baw-install-" + UUID().uuidString)
    defer { try? fm.removeItem(at: stage) }
    try fm.copyItem(at: payload, to: stage)
    try validatePayload(stage)
    for command in ["启动原版服务.command"] {
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stage.appendingPathComponent(command).path)
    }
    var backup: URL?
    if fm.fileExists(atPath: destination.path) {
        backup = parent.appendingPathComponent(destination.lastPathComponent + "-backup-" + UUID().uuidString)
        try fm.moveItem(at: destination, to: backup!)
    }
    do {
        try fm.moveItem(at: stage, to: destination)
    } catch {
        if let backup = backup {
            do { try fm.moveItem(at: backup, to: destination) }
            catch { throw InstallFailure(message: "安装失败，旧版保存在 \(backup.path)。恢复失败：\(error.localizedDescription)") }
        }
        throw error
    }
    return backup
}

func registerNative(destination: URL) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-c", "source \"$1/runtime.zsh\"; baw_find_node || { print -u2 '请先安装 Node.js 24，再运行安装器'; exit 1; }; \"$BAW_RUNTIME_NODE\" \"$1/native-install.mjs\"", "baw-install", destination.path]
    process.currentDirectoryURL = fm.homeDirectoryForCurrentUser
    let output = Pipe()
    process.standardOutput = FileHandle.nullDevice
    process.standardError = output
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        let detail = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw InstallFailure(message: "程序已复制，但后台启动组件注册失败。\n" + detail)
    }
}

func payloadURL() throws -> URL {
    guard let resources = Bundle.main.resourceURL else {
        throw InstallFailure(message: "无法定位应用资源，请双击完整的「安装 BAW 多钱包增强版.app」。")
    }
    return resources.appendingPathComponent("program")
}

@MainActor
func showError(_ message: String) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "安装未完成"
    alert.informativeText = message
    alert.addButton(withTitle: "关闭")
    alert.runModal()
}

@MainActor
func runUI() {
    NSApplication.shared.setActivationPolicy(.regular)
    NSApplication.shared.activate(ignoringOtherApps: true)
    let destination = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/BAW-Original-Multi")
    let prompt = NSAlert()
    prompt.messageText = "安装 BAW 原程序多钱包增强版"
    prompt.informativeText = "将安装到你自己的用户目录：\n\(destination.path)\n\n在原版 BAW 页面与服务中增加独立身份、多钱包分组和跟单。未替换原交易函数。附带协作者扩展及按需启动组件；不代表找回最初截图的原扩展。\n\n需要 macOS 13.5+、Node.js 24 和 @binance/agentic-wallet 1.11.0。新增身份在钱包页逐个配对。"
    prompt.addButton(withTitle: "安装")
    prompt.addButton(withTitle: "取消")
    guard prompt.runModal() == .alertFirstButtonReturn else { return }
    do {
        let backup = try install(payload: payloadURL(), destination: destination)
        try registerNative(destination: destination)
        let done = NSAlert()
        done.messageText = "BAW 多钱包增强版安装完成"
        done.informativeText = "安装位置：\n\(destination.path)\n\n已注册 Chrome 按需启动组件。请在 Chrome 扩展管理页选择“加载已解压的扩展程序”，选择安装目录里的 chrome-extension 文件夹，停用旧扩展。\n\n以后打开插件会自动后台启动，无需终端；首次配对及会话过期仍需本人连接钱包。关闭侧栏不会继续运行面板跟单。" + (backup == nil ? "" : "\n\n旧安装已备份到同级目录。")
        done.addButton(withTitle: "查看扩展文件夹")
        done.runModal()
        NSWorkspace.shared.open(destination.appendingPathComponent("chrome-extension"))
    } catch { showError(error.localizedDescription) }
}

@MainActor
class InstallerDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        DispatchQueue.main.async {
            runUI()
            NSApplication.shared.terminate(nil)
        }
    }
}

// Headless QA uses the exact same native copying code, without opening apps or a wallet.
@main
@MainActor
struct InstallerMain {
static func main() {
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--install-only" {
    do {
        let destination = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        let backup = try install(payload: payloadURL(), destination: destination)
        print("Installed: \(destination.path)")
        if let backup = backup { print("Backup: \(backup.path)") }
    } catch {
        FileHandle.standardError.write(Data((error.localizedDescription + "\n").utf8))
        exit(1)
    }
} else if CommandLine.arguments.count == 1 {
    let application = NSApplication.shared
    let delegate = InstallerDelegate()
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    withExtendedLifetime(delegate) { application.run() }
} else {
    FileHandle.standardError.write(Data("Usage: BAWInstaller [--install-only /absolute/destination]\n".utf8))
    exit(2)
}

}
}
