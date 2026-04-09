/**
 * [INPUT]: Receives bun binary path and server script path
 * [OUTPUT]: Exports generateLaunchAgentPlist
 * [POS]: macOS LaunchAgent plist generator within browser engine
 */

// ─── LaunchAgent: macOS daemon auto-start ────────────────────
/**
 * Generate a macOS LaunchAgent plist for auto-starting the nightCrawl daemon.
 * Opt-in only via `nightcrawl daemon install`.
 */
export function generateLaunchAgentPlist(bunPath: string, serverPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nightcrawl.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>${serverPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>LowPriorityIO</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BROWSE_EXTENSIONS</key>
    <string>none</string>
    <key>BROWSE_IDLE_TIMEOUT</key>
    <string>3600000</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/nightcrawl-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/nightcrawl-daemon.log</string>
</dict>
</plist>`;
}
