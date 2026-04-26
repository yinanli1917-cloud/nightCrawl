import AppKit

@main
struct NightCrawlNotify {
    static func main() {
        let args = CommandLine.arguments
        let title = flag("--title", args) ?? "nightCrawl needs a hand"
        let msg = flag("--body", args) ?? ""
        let approveLabel = flag("--approve", args) ?? "Let's go!"
        let rejectLabel = flag("--reject", args) ?? "Not now"
        let onApproveCmd = flag("--on-approve", args)

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        if let snd = NSSound(named: NSSound.Name("Tink")) { snd.play() }

        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = msg
        alert.alertStyle = .informational

        // 64x64 icon — standard macOS alert icon size
        if let symbol = NSImage(systemSymbolName: "moon.stars.fill", accessibilityDescription: "nightCrawl") {
            let config = NSImage.SymbolConfiguration(pointSize: 32, weight: .medium)
            let configured = symbol.withSymbolConfiguration(config) ?? symbol
            let sized = NSImage(size: NSSize(width: 64, height: 64), flipped: false) { rect in
                NSColor.systemBlue.setFill()
                configured.draw(in: rect)
                return true
            }
            alert.icon = sized
        }

        alert.addButton(withTitle: approveLabel)
        alert.addButton(withTitle: rejectLabel)

        alert.window.level = .modalPanel
        NSApp.activate(ignoringOtherApps: true)

        let response = alert.runModal()

        if response == .alertFirstButtonReturn {
            if let cmd = onApproveCmd {
                let p = Process()
                p.launchPath = "/bin/sh"
                p.arguments = ["-c", cmd]
                try? p.run()
            }
            print("approved")
            exit(0)
        } else {
            print("rejected")
            exit(1)
        }
    }

    static func flag(_ name: String, _ args: [String]) -> String? {
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
}
