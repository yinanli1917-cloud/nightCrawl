# gstack 浏览器引擎逆向分析

> 日期：2026-03-21

---

## 1. server.ts — HTTP Daemon 核心

### 路由架构

```
Bun.serve() on 127.0.0.1:random_port
  ├── /cookie-picker  → no auth (localhost-only)
  ├── /health         → no auth (status + uptime + tabs)
  ├── /command POST   → Bearer token auth → handleCommand()
  └── 404 fallback
```

### 关键实现细节

**AUTH_TOKEN** = `crypto.randomUUID()`，每次启动重新生成。Token 只通过 state file 传递给客户端，不走网络。

**端口选择**：`findPort()` 在 10000-60000 随机选端口，最多 5 次重试。支持 `BROWSE_PORT` 环境变量做 debug override。

**空闲超时**：默认 30 分钟。`setInterval` 每 60s 检查 `Date.now() - lastActivity`，超时则 graceful shutdown。

**命令路由**：三个 `Set` 分类——READ_COMMANDS / WRITE_COMMANDS / META_COMMANDS。好处是权限校验和 rate limiting 可以按类别差异化处理。

**wrapError()**：Playwright 错误翻译为 AI 友好的提示：

| Playwright 错误 | 翻译后 |
|-----------------|--------|
| TimeoutError | "Element not found or not interactable..." |
| Multiple elements | "Be more specific or use @refs..." |

这个模式很关键——面向 AI 的错误消息需要包含 **下一步行动建议**，而非堆栈信息。

> 可复用于 X MCP：wrapError() 模式。AI agent 拿到的错误信息应该是 actionable 的，不是 debug 用的。

**原子 state file**：write `.tmp` → `fs.renameSync`，mode `0o600`。保证读端永远读到完整文件，不会读到写了一半的状态。

**三个 CircularBuffer**：console / network / dialog，各 50000 entries，每秒 flush 到磁盘。环形缓冲区避免内存无限增长，同时保留足够的历史上下文。

> 可复用于 X MCP：GraphQL request 拦截。network buffer 里的结构化数据是金矿——不需要解析 DOM，直接拿 API 响应。

**shutdown() 顺序**：

```
clearInterval → flushBuffers → browserManager.close → unlink state file → exit
```

state file 最后删，确保客户端能检测到进程是否还活着。

---

## 2. browser-manager.ts — Chromium 生命周期

### 类结构

```typescript
class BrowserManager {
  // ── 状态 ──
  private browser: Browser | null
  private context: BrowserContext | null
  private pages: Map<number, Page>
  private activeTabId: number
  private refMap: Map<string, RefEntry>
  private lastSnapshot: string | null
  private isHeaded: boolean
  private consecutiveFailures: number

  // ── 生命周期 ──
  launch()              // chromium.launch({ headless: true })
  close()               // 5s 超时保护
  isHealthy()           // page.evaluate('1') with 2s timeout
  recreateContext()     // 保存 → 关旧 → 创新 → 恢复（降级为 clean slate）
  handoff(message)      // headless → headed，先启新再关旧
  resume()              // 清 ref + 重置 failure

  // ── Tab 管理 ──
  newTab(url?)          // 先验证 URL 再分配 page
  closeTab(id?)
  switchTab(id)
  getPage()             // 返回 active page

  // ── Ref 系统 ──
  resolveRef(selector)  // @ref → Locator，含 staleness 检测

  // ── 状态持久化 ──
  saveState()           // cookies + localStorage + sessionStorage + URLs
  restoreState(state)
}
```

### 关键设计决策

**1. Crash = Exit**

```
browser.on('disconnected') → process.exit(1)
```

不尝试自愈。理由：浏览器进程崩溃后，所有 Page/Context handle 全部失效，内存中的 ref map 全部 stale。与其半死不活地苟延残喘，不如干净退出让 supervisor 重启。

**2. Ref Map**

`Map<string, RefEntry>`，其中 `RefEntry = { locator, role, name }`。key 是 `@e1` 这样的字符串。

**3. Staleness Detection**

`resolveRef()` 先调 `entry.locator.count()`：
- 返回 0 → 元素已不存在，报错并建议重新 snapshot
- 返回 ≥1 → 正常使用

这解决了 SPA 路由切换不触发 `framenavigated` 的问题。

**4. Handoff（headless → headed）**

三步容错设计：

```
Step 1: saveState()
Step 2: launch new headed browser + restoreState()
Step 3: close old headless browser
```

容错逻辑：
- Step 2 失败 → headless 不受影响，继续使用
- Step 3 失败 → 也不影响新 browser

核心原则：**先建新再拆旧**，保证任意步骤失败后系统仍可用。

> 可复用于 X MCP：daemon 模式（持久 Chromium + HTTP server）。保持一个长期运行的浏览器实例，避免每次操作都冷启动。

**5. Tab 管理**

`Map<number, Page>`，关闭 active tab 自动切到最后一个。简单直觉。

**6. wirePageEvents()**

| 事件 | 处理 |
|------|------|
| `framenavigated` | clearRefs（lastSnapshot 不清） |
| `dialog` | auto-accept（防浏览器锁死） |
| `console` | addConsoleEntry |
| `request/response/requestfinished` | addNetworkEntry（backward scan 匹配） |

`dialog` auto-accept 是个重要细节——`alert()/confirm()/prompt()` 会阻塞所有 JS 执行，如果不自动处理，整个浏览器实例都会锁死。

---

## 3. cookie-import-browser.ts — Arc Cookie 导入

### 支持的浏览器注册表

| 浏览器 | dataDir | keychainService |
|--------|---------|-----------------|
| Comet | `Comet/` | Comet Safe Storage |
| Chrome | `Google/Chrome/` | Chrome Safe Storage |
| **Arc** | **`Arc/User Data/`** | **Arc Safe Storage** |
| Brave | `BraveSoftware/Brave-Browser/` | Brave Safe Storage |
| Edge | `Microsoft Edge/` | Microsoft Edge Safe Storage |

全部硬编码，不接受用户输入路径。

### Chromium macOS "v10" Cookie 解密管线

```
1. Keychain 取密码
   security find-generic-password -s "Arc Safe Storage" -w
   → base64 password string

2. 密钥派生
   PBKDF2(password, salt="saltysalt", iter=1003, len=16, hash=sha1)
   → 16-byte AES key

3. 逐条解密
   - 识别 encrypted_value 前缀 "v10"
   - ciphertext = encrypted_value[3:]
   - IV = 16 bytes of 0x20 (space character)
   - plaintext = AES-128-CBC-decrypt(key, iv, ciphertext)
   - 去除 PKCS7 padding
   - 跳过前 32 bytes（HMAC-SHA256 authentication tag）
   - 剩余 bytes = cookie value (UTF-8)
```

注意几个"magic number"：
- `"saltysalt"` — Chromium 硬编码的 salt，所有基于 Chromium 的浏览器共用
- `1003` 次迭代 — Chromium 的 PBKDF2 迭代次数，极低（对比 macOS Keychain 自身用的 10万+），但这是 Chromium 的历史选择
- `0x20` 作为 IV — 不是零，是空格字符，也是 Chromium 硬编码

> 可复用于 X MCP：cookie-import-browser.ts 的整套逻辑。导入 Arc 的 X.com cookie 就能直接以登录身份操作，省去 OAuth 流程。

### API

```typescript
findInstalledBrowsers(): BrowserInfo[]
listDomains(browser, profile): DomainEntry[]
importCookies(browser, domains, profile): ImportResult
```

### 安全设计

| 措施 | 原因 |
|------|------|
| 浏览器注册表硬编码 | 防止路径遍历读取任意 SQLite |
| profile 名严格校验（禁 `../`、控制字符） | 防止目录穿越 |
| DB 只读打开，锁时复制到 `/tmp`（含 WAL + SHM） | 不干扰正在运行的浏览器 |
| Keychain 异步读取 + 10s 超时 | macOS 可能弹 Allow/Deny 对话框 |
| Key cache per-session，server 关闭时清除 | 最小化密钥驻留时间 |
| Cookie 值不写日志 | 防止凭据泄露到日志文件 |

---

## 4. snapshot.ts — @ref 系统

### 工作流程

```
1. page.locator('body').ariaSnapshot()
   → YAML-like accessibility tree 文本

2. 双遍扫描
   第一遍：统计 role+name 出现次数（为 nth() 消歧做准备）
   第二遍：
     - 分配 @e1, @e2... ref
     - 构建 Locator: page.getByRole(role, { name }).nth(index)
     - 存入 RefEntry { locator, role, name }

3. 可选扩展
   -C flag：扫描 cursor:pointer / onclick / tabindex 的非 ARIA 元素 → @c1, @c2...
   -D flag：与上次 snapshot 做 unified diff
   -a flag：截图 + 红色 overlay box 标注
```

### SNAPSHOT_FLAGS

| Flag | 功能 |
|------|------|
| `-i` / `--interactive` | 只显示交互元素 |
| `-c` / `--compact` | 去掉空结构节点 |
| `-d N` / `--depth N` | 限制树深度 |
| `-s SEL` / `--selector SEL` | CSS 选择器限定范围 |
| `-D` / `--diff` | 与上次 snapshot 做 unified diff |
| `-a` / `--annotate` | 红色 overlay 标注截图 |
| `-o PATH` / `--output PATH` | 标注截图输出路径 |
| `-C` / `--cursor-interactive` | 扫描 cursor:pointer 等非 ARIA 元素 |

### 为什么用 Locator 而非 DOM 注入

| DOM 注入的问题 | Locator 的优势 |
|---------------|---------------|
| CSP 可能阻止 DOM 修改 | 不修改页面 |
| React/Vue 水合清除注入属性 | 基于 accessibility tree |
| Shadow DOM 无法从外部触达 | Playwright 原生支持 |
| 与页面 JS 耦合 | 完全外部操作 |

> 可复用于 X MCP：snapshot + ref 系统。如果需要与 X 页面 DOM 交互（点赞、转发、展开评论），这套 ref 系统比 CSS selector 稳定得多。

### Ref 生命周期

```
navigation (framenavigated)
  → 清空所有 ref
  → lastSnapshot 保留（用于 diff baseline）

SPA 路由切换
  → 不触发 framenavigated
  → resolveRef() 的 count() 检查兜底
  → count() == 0 时报错 + 建议重新 snapshot
```

两层防护：事件驱动清理 + 惰性 staleness 检测。

---

## 5. 对自建 X MCP 的直接启示

按优先级排序：

| 模块 | 可复用点 | 优先级 |
|------|---------|--------|
| cookie-import-browser.ts | Arc cookie 解密导入，直接获得 X.com 登录态 | **P0** |
| server.ts (network buffer) | 拦截 GraphQL request/response，从 network 层提取结构化数据 | **P0** |
| server.ts (daemon 模式) | 持久 Chromium + HTTP server，避免冷启动 | P1 |
| server.ts (state file) | 原子写入 + PID 检测，多进程安全 | P1 |
| server.ts (wrapError) | 面向 AI 的错误翻译，包含行动建议 | P1 |
| snapshot.ts (ref 系统) | 稳定的页面元素定位，用于点赞/转发等交互 | P2 |

**核心洞察**：gstack 最有价值的不是"浏览器自动化"本身，而是三个基础设施：
1. **Cookie 解密** — 零成本获得登录态
2. **Network 拦截** — 绕过 DOM 直接拿结构化数据
3. **Ref 系统** — 比 CSS selector 更稳定的元素定位
