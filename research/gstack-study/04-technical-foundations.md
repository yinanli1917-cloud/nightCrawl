# 技术基础：Founder 必须理解的全部概念

> 不用类比，不跳步骤，从底层往上逐层构建。
> 每个概念只解释一次，后续直接引用。

---

## 第一层：进程

### 什么是进程

你在电脑上打开一个 app（比如 Arc 浏览器），操作系统就创建了一个**进程**。进程就是"一段正在运行的程序"。它有自己的内存空间、有一个唯一的编号叫 **PID**（Process ID），操作系统负责调度它什么时候用 CPU。

你电脑上同时跑着几百个进程。`活动监视器` 里看到的每一行就是一个进程。

### 前台进程 vs 后台进程

- **前台进程**：有窗口，你能看到它，关窗口它就退出。Arc 浏览器就是前台进程。
- **后台进程**：没有窗口，在后台默默运行。你看不到它，但它一直在。macOS 的蓝牙服务、Wi-Fi 服务都是后台进程。

### 什么是 Daemon

Daemon 就是一个**被设计为后台运行的进程**。它启动后不会弹出任何窗口，安静地等待请求，干完活继续等。没人找它的时候它什么都不做，但它一直活着，随时准备响应。

gstack 的 browse server 就是一个 daemon。它启动后：
- 不弹窗口
- 监听一个端口（下面解释），等别人发请求过来
- 30 分钟没人发请求，自动退出

### 进程间怎么通信

两个进程之间的内存是**完全隔离**的。进程 A 不能直接读进程 B 的变量。如果 A 想让 B 做事，需要通过操作系统提供的通道。常见的通道有：

- **文件**：A 写一个文件，B 读这个文件
- **网络（HTTP）**：A 向 B 发一个 HTTP 请求，B 返回结果
- **管道（stdin/stdout）**：A 把输出接到 B 的输入上

gstack 用的是 **文件 + HTTP** 的组合：
- 文件：`browse.json` 记录 daemon 的 PID、端口、token
- HTTP：CLI 读完文件后，向 daemon 发 HTTP 请求

---

## 第二层：网络基础

### 什么是 HTTP

HTTP 是一个**请求-响应协议**。一方发请求（request），另一方返回响应（response）。每次交互都是独立的——发完请求、拿到响应，这次通信就结束了。

```
请求：POST http://127.0.0.1:34567/command
      Body: {"command": "goto", "args": ["https://x.com"]}

响应：200 OK
      Body: "Navigated to https://x.com (200)"
```

HTTP 最初是为浏览器和网站之间通信设计的。但它足够通用，任何两个程序之间都可以用 HTTP 通信。gstack 的 CLI 和 daemon 之间就是用 HTTP 通信的。

### 什么是 localhost / 127.0.0.1

每台电脑都有一个**本地地址** `127.0.0.1`，也叫 `localhost`。发到这个地址的网络请求**不会离开你的电脑**——它直接在操作系统内部转发给目标进程。外部网络上的其他电脑完全无法访问这个地址。

gstack 的 daemon 只绑定 `127.0.0.1`，所以只有你电脑上的程序能和它通信。这是安全设计。

### 什么是端口

一台电脑上可能同时跑着很多服务（网站服务器、数据库、gstack daemon……）。**端口**就是用来区分"这个请求是发给谁的"。端口是一个数字，范围 0-65535。

- 80 端口：HTTP 网站的默认端口
- 443 端口：HTTPS 网站的默认端口
- 3000 端口：很多开发工具的默认端口
- 10000-60000：gstack 从这个范围里随机选一个

gstack 每次启动 daemon 时随机选端口，避免和其他程序冲突。选好后把端口号写进 `browse.json`，CLI 下次来读这个文件就知道该往哪发请求。

### 什么是 Bearer Token

HTTP 请求里可以带一个 **Authorization header**，告诉服务端"我是谁"。Bearer token 是最简单的形式：

```
Authorization: Bearer a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

服务端检查这个 token 是否匹配——匹配就执行命令，不匹配就返回 401（未授权）。

gstack 的 daemon 启动时生成一个随机 UUID 作为 token，写进 `browse.json`（权限设为只有你能读）。CLI 每次请求都从文件里读 token 放进 header。这样即使你电脑上有恶意程序想偷偷操作你的浏览器，它拿不到 token 就发不了命令。

---

## 第三层：编译与二进制

### 什么是源码 vs 二进制

**源码**是人写的文本文件（`.ts`、`.py`、`.swift`）。电脑不能直接执行源码——需要先翻译成机器能理解的指令。

**二进制**（binary）是翻译后的产物。它是一个可以直接执行的文件。你双击一个 `.app`，实际上就是在运行里面的二进制文件。

### 什么是编译

**编译**就是"把源码翻译成二进制"的过程。Swift 代码通过 Xcode 编译成 macOS app。TypeScript 代码通过 Bun 编译成二进制。

编译的好处：
- **用户不需要安装开发环境**。给你一个编译好的文件，直接运行。
- **启动更快**。不需要在运行时做翻译。
- **依赖打包在内**。所有用到的库都打进一个文件里。

### 什么是 Bun

Bun 是一个 JavaScript/TypeScript 运行时（和 Node.js 同类）。它能做三件事：

1. **运行** TypeScript 文件（`bun run server.ts`）
2. **编译** TypeScript 成单一二进制（`bun build --compile`）
3. **提供内置功能**：HTTP server（`Bun.serve()`）、SQLite 数据库（`new Database()`）

### 什么是 Node.js

Node.js 是 JavaScript/TypeScript 运行时的老牌选择。绝大多数 JS 后端项目用 Node.js。但 Node.js 有两个问题让 gstack 放弃了它：

1. **不能编译成单一二进制**。用 Node.js 的项目必须带着 `node_modules` 文件夹（所有依赖库），用户需要先跑 `npm install` 安装这些依赖。这个过程经常出错。
2. **没有内置 SQLite**。需要安装第三方库 `better-sqlite3`，这个库需要 C++ 编译（通过一个叫 `node-gyp` 的工具），在不同系统上经常编译失败。

Bun 解决了这两个问题：编译成一个文件，SQLite 内置。所以 gstack 安装就是下载一个 58MB 的文件。

---

## 第四层：浏览器自动化

### 什么是 Playwright

Playwright 是微软出品的**浏览器自动化库**。它能用代码控制一个真实的 Chromium 浏览器：打开网页、点击按钮、填表单、截图、读取页面内容。

```typescript
// Playwright 的基本用法
const browser = await chromium.launch()     // 启动 Chromium
const page = await browser.newPage()        // 新建标签页
await page.goto('https://x.com')            // 导航到 URL
await page.click('button.follow')           // 点击按钮
const text = await page.textContent('body') // 读取页面文字
await browser.close()                       // 关掉浏览器
```

### 什么是 Headless 浏览器

**Headless** = 没有窗口。Chromium 可以在后台运行，渲染网页、执行 JavaScript，但不显示任何界面。速度更快，占用资源更少。gstack 默认用 headless 模式。

**Headed** = 有窗口。你能看到浏览器界面。gstack 的 `handoff` 命令可以从 headless 切换到 headed——当 AI 搞不定时，弹出浏览器窗口让你手动操作。

### 为什么你之前直接用 Playwright 不行

如果你写一个 Python 脚本直接调 Playwright：

```python
browser = playwright.chromium.launch()
page = browser.new_page()
page.goto("https://x.com")
# 干完活
browser.close()
```

**问题 1：没有登录态。** X.com 需要登录。Playwright 启动的是一个全新的 Chromium，没有任何 cookie，所以你看到的是未登录页面。你需要手动走登录流程（输密码、2FA、可能还有验证码）。

**问题 2：被检测。** X.com 会检查浏览器的 User-Agent 字符串。Playwright 默认的 UA 包含 "HeadlessChrome" 标识，X.com 看到这个直接拒绝服务——返回错误页面。

**问题 3：状态不持久。** 脚本跑完 `browser.close()` 后，所有 cookie、localStorage、打开的标签页全部消失。下次跑脚本又是从零开始。

**问题 4：每次冷启动。** 每次跑脚本都要花 2-3 秒启动 Chromium。如果一个工作流要执行 20 条浏览器操作，冷启动模式就是 20 次启动 = 40-60 秒纯等待。

gstack 怎么解决这四个问题：
- 问题 1 → `cookie-import-browser`：从你已登录的 Arc 浏览器复制 cookie
- 问题 2 → `useragent` 命令：设置正常的 Chrome UA
- 问题 3 → daemon 模型：Chromium 一直活着，状态一直在
- 问题 4 → daemon 模型：只启动一次，后续每条命令 100ms

---

## 第五层：Cookie 与登录

### 什么是 Cookie

Cookie 是网站存在你浏览器里的小段数据。最重要的用途是**记住登录状态**。

当你在 Arc 里登录 X.com 时：
1. 你输入用户名密码
2. X.com 验证通过，返回一个 cookie（包含一个 session token）
3. Arc 保存这个 cookie
4. 以后你每次访问 X.com，Arc 自动带上这个 cookie
5. X.com 看到 cookie 里的 token，知道你已登录，直接显示首页

### Cookie 怎么存储

Chrome/Arc/Brave 等基于 Chromium 的浏览器把 cookie 存在一个 **SQLite 数据库文件**里。但 cookie 的值是**加密的**——防止恶意程序直接读文件偷 cookie。

加密用的密钥存在 macOS 的 **Keychain**（钥匙串）里。Keychain 是操作系统级别的密码管理器，受硬件安全芯片保护。

### gstack 怎么偷 cookie

`cookie-import-browser` 命令的完整流程：

1. 找到 Arc 的 cookie 数据库文件（路径是固定的，硬编码在代码里）
2. **复制**一份到临时目录（不修改原文件，只读）
3. 请求 macOS Keychain 给它解密密钥（此时 macOS 会弹一个授权窗口问你"允许 gstack 访问 Arc 的密钥吗？"）
4. 用密钥通过 PBKDF2 + AES-128-CBC 算法解密 cookie 值（这两个是加密算法的名字，你不需要理解细节，只需知道这是标准做法）
5. 把解密后的 cookie 注入到 Playwright 的浏览器 context 里
6. 解密后的明文 cookie **只在内存里**，不写入任何文件

这样 Playwright 里的 Chromium 就有了和你的 Arc 一模一样的登录态。X.com 看到 cookie，认为你是正常登录用户。

---

## 第六层：CLI vs MCP

### 什么是 CLI

CLI = Command Line Interface。就是在终端里输入命令执行的程序。`git`、`ls`、`brew` 都是 CLI。

gstack 的 `browse` 就是一个 CLI：

```bash
browse goto https://x.com    # 导航
browse text                   # 读取页面文字
browse screenshot /tmp/a.png  # 截图
browse click @e3              # 点击某个元素
```

Claude Code 通过它的 Bash tool 调用这些命令。对 Claude Code 来说，调用 `browse goto` 和调用 `ls` 没有区别——都是"执行一条 bash 命令，拿到文本输出"。

### 什么是 MCP

MCP = Model Context Protocol。Anthropic 设计的一个**标准协议**，让 AI 工具和外部服务通信。

MCP 的工作方式：
1. MCP server 启动，声明自己有哪些"工具"（通过 JSON Schema 描述参数和返回值）
2. AI host（Claude Desktop、Cursor 等）连接 MCP server，拿到工具列表
3. AI 想用某个工具时，发一个 JSON-RPC 请求给 MCP server
4. MCP server 执行操作，返回 JSON 结果

你的 Apple Notes 搜索就是一个 MCP server——Claude Desktop 通过 MCP 协议调用它。

### 为什么 gstack 选 CLI 不选 MCP

**MCP 的开销**：
- 需要保持一个持久连接（进程间通过 stdin/stdout 持续通信）
- 每个请求和响应都包裹在 JSON-RPC 格式里（协议头、方法名、参数 schema、结果 schema）
- 工具描述必须用 JSON Schema 格式定义，结构固定

**CLI 的简单性**：
- 无连接。每次调用是独立的 bash 命令。
- 输入是命令行参数（`browse goto https://x.com`），输出是纯文本
- 工具描述写在 SKILL.md 里，是自然语言，可以包含示例、注意事项、工作流建议——比 JSON Schema 灵活得多

**对 token 的影响**：
- MCP 的 JSON 包装会消耗更多 token。`{"jsonrpc":"2.0","method":"browse","params":{"command":"goto","url":"https://x.com"}}` 比 `browse goto https://x.com` 长得多。
- 返回值同理。MCP 返回 `{"result":{"content":[{"type":"text","text":"Navigated to..."}]}}`，CLI 直接返回 `Navigated to...`

**适用场景差异**：
- MCP 的价值在**跨平台**。同一个 MCP server 能被 Claude Desktop、Cursor、Windsurf、任何支持 MCP 的 AI 工具调用。
- CLI 只能被**有 bash 能力**的 AI 工具调用（Claude Code、Codex）。但如果你只用 Claude Code，这不是限制。

**gstack 的判断**：它只服务 Claude Code 用户（和少量 Codex 用户）。对这个群体，CLI 更快、更省 token、更容易调试。如果未来要支持更多平台，可以在 CLI 外面包一层 MCP adapter——但他们有意没做这件事。

---

## 第七层：gstack 完整工作流

把以上所有层串起来。以下是当你对 Claude Code 说"去看一下 x.com 首页"时，从头到尾发生的**每一件事**。

---

### 阶段 A：AI 决策（Claude Code 内部，你看不到）

```
你的指令: "去看一下 x.com 首页"
         ↓
Claude Code 的 AI 在它的"大脑"里思考：
  - 用户要我访问一个网页
  - 我有一个 Bash tool 可以执行命令
  - 我知道 gstack browse 可以操作浏览器（因为我读过 SKILL.md）
  - SKILL.md 告诉我导航命令是 "browse goto <url>"
  - 我需要先设置 PATH 让系统找到 bun
         ↓
AI 生成一条 bash 命令：
  export PATH="$HOME/.bun/bin:$PATH" && ~/.gstack/browse/dist/browse goto https://x.com
```

**这一步的职责**：AI 根据 SKILL.md 中的自然语言文档，选择正确的命令和参数。如果 SKILL.md 写错了（比如命令名打错），AI 就会调用一个不存在的命令。这就是为什么模板系统那么重要——SKILL.md 必须和代码保持一致。

---

### 阶段 B：操作系统启动 CLI 进程

```
操作系统收到指令：执行 ~/.gstack/browse/dist/browse 这个文件
         ↓
操作系统做了什么：
  1. 在内存中分配一块空间给新进程
  2. 把 browse 二进制文件的内容加载到这块内存
  3. 给这个进程分配一个 PID（比如 88001）
  4. 开始执行 browse 二进制的入口函数 main()
         ↓
耗时：~1ms（因为是编译好的二进制，不需要解释执行）
```

**这一步的职责**：操作系统创建进程。这里体现了"Bun 编译成单一二进制"的价值——如果是 Node.js，这一步需要先启动 Node 运行时（~100ms），再加载 JS 文件，再解析依赖。编译好的二进制跳过了这些步骤。

**对比**：如果用 Python 写 CLI，这一步是 `python browse.py goto https://x.com`。Python 解释器启动要 ~50-100ms，加载库可能再要几百 ms。一条命令还没开始干活就花了半秒。

---

### 阶段 C：CLI 寻找 daemon

```
CLI 的 main() 函数开始执行
         ↓
第一件事：调用 ensureServer()
         ↓
ensureServer() 调用 readState()：
  → 打开文件 .gstack/browse.json
  → 读取内容：{"pid": 12345, "port": 34567, "token": "a1b2c3d4...", "binaryVersion": "v1"}
  → 解析 JSON，拿到 ServerState 对象
         ↓
检查 daemon 进程是否还活着：
  → 调用 process.kill(12345, 0)
    （发送信号 0 不会杀进程，只是检查进程是否存在）
  → 返回 true → PID 12345 的进程还在跑
         ↓
检查版本是否匹配：
  → 读取本地 browse/dist/.version 文件（当前二进制的版本）
  → 比较：CLI 版本 "v1" === daemon 版本 "v1" → 匹配，不需要重启
         ↓
做一次健康检查：
  → 发 HTTP GET http://127.0.0.1:34567/health
  → daemon 返回 {"status": "healthy", "uptime": 1200, "tabs": 1}
  → healthy → daemon 正常工作
         ↓
返回 ServerState {pid: 12345, port: 34567, token: "a1b2c3d4..."}
```

**这一步的职责**：确保 daemon 存在且健康。这里有三层检查：

1. **文件存在？** → browse.json 是否存在。不存在说明 daemon 从未启动过。
2. **进程活着？** → PID 对应的进程是否还在。可能 daemon 已经被杀掉了但文件没清理。
3. **能响应？** → HTTP 健康检查。进程可能在但已经卡死（比如 Chromium 假死）。

三层都通过才认为 daemon 可用。任何一层失败，CLI 都会启动新 daemon。

**如果 daemon 不存在**（第一次调用），会走 `startServer()` 路径：

```
startServer()：
  → 删除旧的 browse.json（如果有的话）
  → 调用 Bun.spawn(["bun", "run", "server.ts"])
    → 这会在后台启动一个新进程（daemon）
    → daemon 启动 Chromium、绑定随机端口、写 browse.json
  → proc.unref()
    → 告诉操作系统"CLI 退出后不要杀掉这个子进程"
    → daemon 变成独立进程，和 CLI 脱钩
  → 循环等待 browse.json 出现（每 100ms 检查一次，最多等 8 秒）
  → browse.json 出现 → 读取 → 返回 ServerState
         ↓
首次启动耗时：~3 秒（Chromium 冷启动）
```

---

### 阶段 D：CLI 发送命令

```
CLI 拿到 ServerState 后，调用 sendCommand()
         ↓
构造 HTTP 请求：
  URL:    http://127.0.0.1:34567/command
  方法:    POST
  Header: Content-Type: application/json
          Authorization: Bearer a1b2c3d4-e5f6-7890-abcd-ef1234567890
  Body:   {"command": "goto", "args": ["https://x.com"]}
         ↓
通过操作系统的网络栈发送：
  → 因为目标是 127.0.0.1，数据不经过网卡
  → 直接在内核内部从 CLI 进程的 socket 拷贝到 daemon 进程的 socket
  → 耗时：< 1ms
```

**这一步的职责**：把用户的命令从 CLI 进程传递到 daemon 进程。Bearer token 确保只有持有 token 的程序才能发命令。

**如果 token 不匹配**（比如 daemon 重启过、生成了新 token）：

```
daemon 返回 HTTP 401 Unauthorized
         ↓
CLI 重新读取 browse.json（可能 daemon 重启后写了新文件）
         ↓
如果新 token 和旧 token 不同 → 用新 token 重试
如果 token 一样 → 报错 "Authentication failed"
```

**如果 daemon 已经崩溃**（连接被拒绝）：

```
fetch() 抛出 ECONNREFUSED 错误
         ↓
CLI 调用 startServer() 启动新 daemon
         ↓
用新 daemon 的信息重试命令（最多重试 1 次）
```

---

### 阶段 E：Daemon 接收并路由

```
daemon 的 Bun.serve() 收到 HTTP 请求
         ↓
第一件事：重置空闲计时器
  → lastActivity = Date.now()
  → 这意味着 30 分钟倒计时重新开始
  → 只要有命令进来，daemon 就不会自动关闭
         ↓
检查 URL 路径：
  → /cookie-picker → cookie 选择器页面（不需要 token）
  → /health → 健康检查（不需要 token）
  → /command → 命令执行（需要 token）
  这个请求是 /command
         ↓
验证 token：
  → 读取请求头 Authorization: Bearer a1b2c3d4...
  → 和 daemon 启动时生成的 AUTH_TOKEN 比较
  → 匹配 → 继续处理
         ↓
解析请求体：
  → JSON.parse(body) → {command: "goto", args: ["https://x.com"]}
         ↓
路由到处理函数：
  → "goto" 在 WRITE_COMMANDS 集合中
  → 调用 handleWriteCommand("goto", ["https://x.com"], browserManager)
```

**这一步的职责**：请求分发。daemon 把命令分成三类：

- **READ 命令**（text、html、links、cookies……）：只读取页面状态，不改变任何东西。安全，可以重试。
- **WRITE 命令**（goto、click、fill、press……）：改变页面状态。点了按钮就回不去了。
- **META 命令**（snapshot、screenshot、tabs、stop……）：服务器级别操作，不是针对页面的。

这个分类不是装饰——它决定了错误处理策略。READ 命令失败可以安全重试，WRITE 命令失败不能盲目重试（可能重复提交表单）。

---

### 阶段 F：Playwright 执行浏览器操作

```
handleWriteCommand("goto", ["https://x.com"], browserManager)
         ↓
从 browserManager 获取当前活动页面：
  → browserManager.getPage()
  → 返回 Playwright 的 Page 对象（代表 Chromium 里的一个标签页）
         ↓
调用 Playwright API：
  → page.goto("https://x.com", { waitUntil: "domcontentloaded", timeout: 15000 })
         ↓
Playwright 做了什么（这部分在 Chromium 内部）：
  1. 告诉 Chromium "导航到 https://x.com"
  2. Chromium 的网络层发起 DNS 查询：x.com → 104.244.42.193
  3. 建立 TCP 连接 → TLS 握手（HTTPS 加密）
  4. 发送 HTTP GET 请求到 x.com 服务器
  5. x.com 服务器检查 cookie：
     → 发现 cookie 里有有效的 session token（之前用 cookie-import-browser 导入的）
     → 返回登录用户的首页 HTML
  6. Chromium 接收 HTML
  7. 解析 HTML → 构建 DOM 树
  8. 加载 CSS → 计算布局
  9. 加载 JavaScript → 执行（React/Next.js 渲染页面）
  10. DOM 构建完成 → 触发 "domcontentloaded" 事件
  11. Playwright 检测到这个事件 → goto() 返回
         ↓
goto() 返回 HTTP Response 对象：
  → response.status() = 200（成功）
  → response.url() = "https://x.com/home"（可能发生了重定向）
         ↓
handleWriteCommand 构造返回文本：
  → "Navigated to https://x.com/home (200)"
```

**这一步的职责**：实际操作浏览器。这是整个链路中最慢的部分（~50-200ms），因为涉及真实的网络请求和页面渲染。

**页面事件监听**（和 goto 同时在后台发生）：

```
browserManager 在页面创建时注册了事件监听器：

page.on('console') → 页面的 console.log 输出 → 存入 consoleBuffer（环形缓冲区）
page.on('request')  → 页面发出的每个网络请求 → 存入 networkBuffer
page.on('response') → 每个请求的响应 → 更新 networkBuffer 中对应条目
page.on('dialog')   → alert/confirm 弹窗 → 自动点确定 + 存入 dialogBuffer
page.on('framenavigated') → 页面导航 → 清空 refMap（旧的元素引用失效了）

这些监听器一直在后台运行，不管你执行什么命令。
所以当你后续跑 "browse console" 时，能看到页面之前输出的所有 console.log。

缓冲区每秒异步刷写到磁盘日志文件（非阻塞，不影响命令执行速度）。
```

---

### 阶段 G：错误包装（如果出错的话）

```
如果阶段 F 中 Playwright 抛出异常：

例如：TimeoutError: page.goto: Timeout 15000ms exceeded

         ↓
进入 catch 块，调用 wrapError(err)：
  → 检查错误类型
  → 匹配到 "page.goto" + "Timeout" 模式
  → 重写为："Page navigation timed out. The URL may be unreachable or the page may be loading slowly."
         ↓
递增连续失败计数：
  → browserManager.incrementFailures()
  → consecutiveFailures: 0 → 1
         ↓
检查是否需要提示 handoff：
  → consecutiveFailures < 3 → 不提示
  → 如果 >= 3，会附加："HINT: 3 consecutive failures. Consider using 'handoff' to let the user help."
    （handoff = 弹出浏览器窗口让你手动操作）
         ↓
返回 HTTP 500 + JSON：
  {"error": "Page navigation timed out. The URL may be unreachable or the page may be loading slowly."}
```

**这一步的职责**：把 Playwright 的技术错误翻译成 AI 能理解并行动的指示。AI 看到"The URL may be unreachable"就知道该检查 URL 是否正确，而不是盲目重试。

---

### 阶段 H：结果返回链路

```
假设一切正常，handleWriteCommand 返回字符串：
  "Navigated to https://x.com/home (200)"
         ↓
handleCommand() 把结果包在 HTTP Response 里：
  → new Response("Navigated to https://x.com/home (200)", {status: 200})
  → 重置连续失败计数：consecutiveFailures = 0
         ↓
Bun.serve() 把 HTTP Response 发回给 CLI
  → 通过 localhost socket，< 1ms
         ↓
CLI 的 sendCommand() 收到 response：
  → resp.ok === true（状态码 200）
  → 读取 response body："Navigated to https://x.com/home (200)"
  → process.stdout.write("Navigated to https://x.com/home (200)\n")
    （打印到标准输出，加换行符）
         ↓
CLI 进程正常退出（exit code 0）
         ↓
Claude Code 的 Bash tool 捕获了 CLI 的标准输出
  → AI 看到文本："Navigated to https://x.com/home (200)"
  → AI 解读：导航成功，HTTP 状态码 200，当前在 x.com/home
  → AI 决定下一步（比如执行 "browse text" 读取页面内容）
```

**这一步的职责**：结果传递。注意数据格式的变化：

```
Playwright 返回的：JavaScript Response 对象（包含 headers、body、status 等大量属性）
      ↓ handleWriteCommand 压缩
Daemon 返回给 CLI 的：一行纯文本 "Navigated to https://x.com/home (200)"
      ↓ CLI 原样输出
AI 看到的：同一行纯文本

信息被大幅压缩。AI 不需要知道 HTTP headers、渲染时间、重定向链——它只需要知道"去了哪里，成功没有"。
这就是 CLI 路线比 MCP 省 token 的地方。MCP 会返回一个结构化 JSON，里面包含很多 AI 用不到的元数据。
```

---

### 阶段 I：Daemon 继续存活

```
CLI 进程已退出。但 daemon 进程还在：
  - Chromium 还在运行，x.com 页面还开着
  - cookie 还在内存里
  - console/network/dialog 缓冲区还在记录
  - 空闲计时器开始倒计时（30 分钟后自动关闭）
         ↓
等待下一个命令到来
  → 如果 Claude Code 接下来执行 "browse text"
  → 新的 CLI 进程启动 → 读 browse.json → 发 HTTP 请求 → daemon 执行 → 返回结果
  → 整个过程 ~100ms，因为 Chromium 和页面都已经在了
         ↓
如果 30 分钟内没有任何命令：
  → 空闲检查定时器触发（每 60 秒检查一次）
  → Date.now() - lastActivity > 1800000
  → 调用 shutdown()
  → 刷写缓冲区到磁盘日志
  → 关闭 Chromium
  → 删除 browse.json
  → 进程退出
         ↓
下次需要浏览器时，CLI 发现 daemon 不在了 → 重新走阶段 C 的 startServer()
```

**这一步的职责**：daemon 持久存活，保持状态。这就是"daemon 模型 vs 按需启动"的核心区别：

- **按需启动**：每条命令都走"启动 Chromium → 导入 cookie → 导航 → 操作 → 关闭 Chromium"。20 条命令 = 20 次冷启动。
- **daemon 模型**：第 1 条命令启动 Chromium，第 2-20 条命令直接用已有的 Chromium。20 条命令只有 1 次冷启动。

---

### 完整耗时分解

| 阶段 | 首次调用 | 后续调用 | 干了什么 |
|------|---------|---------|---------|
| A. AI 决策 | ~500ms | ~500ms | Claude 思考用什么命令 |
| B. 启动 CLI | ~1ms | ~1ms | 加载二进制到内存 |
| C. 寻找 daemon | ~3000ms | ~5ms | 首次：启动 daemon + Chromium。后续：读文件 + 健康检查 |
| D. 发送命令 | ~1ms | ~1ms | HTTP POST 到 localhost |
| E. 路由分发 | ~1ms | ~1ms | 解析 JSON + token 校验 |
| F. 浏览器操作 | ~500ms | ~100ms | 首次：页面冷加载。后续：取决于操作复杂度 |
| G. 错误包装 | 0ms | 0ms | 只在出错时触发 |
| H. 结果返回 | ~1ms | ~1ms | 文本通过 HTTP → stdout → AI |
| I. Daemon 存活 | 持续 | 持续 | 等待下一条命令 |
| **总计** | **~4 秒** | **~100-200ms** | |

---

## 第八层：State File 设计

`browse.json` 是整个架构的关键接口。它解决了一个核心问题：**CLI 进程和 daemon 进程的生命周期完全不同**。

CLI 是短命的——执行一条命令就退出。Daemon 是长命的——可能跑几个小时。CLI 怎么知道 daemon 在哪？靠 browse.json。

```json
{
  "pid": 12345,           // daemon 的进程号
  "port": 34567,          // daemon 监听的端口
  "token": "uuid-v4",     // 访问令牌
  "startedAt": "...",     // 启动时间
  "binaryVersion": "abc"  // 二进制版本号
}
```

### 原子写入

daemon 写这个文件时用的是 **write tmp → rename** 模式：
1. 先写到 `browse.json.tmp`
2. 然后 `rename("browse.json.tmp", "browse.json")`

为什么不直接写 `browse.json`？因为写文件不是瞬间完成的。如果 CLI 在 daemon 写到一半的时候来读文件，会读到不完整的 JSON，解析失败。`rename` 操作在文件系统层面是**原子的**——要么完成，要么没发生，不存在"一半"状态。

### 权限

文件权限设为 `0o600` = 只有文件所有者（你）可以读写。其他用户即使在同一台电脑上也无法读取这个文件，拿不到 token。

### 版本自动重启

`binaryVersion` 字段记录 daemon 启动时的代码版本。当你更新了 gstack（`git pull` + `bun run build`），新编译的 CLI 版本号变了。CLI 发现 "我的版本是 xyz，但 daemon 的版本是 abc"，自动杀掉旧 daemon 并启动新 daemon。

这解决了一个普遍问题：用户更新了软件但忘了重启后台服务，结果新代码没生效。gstack 让重启自动发生。

---

## 第九层：错误处理哲学

### 传统工具的错误

```
TimeoutError: locator.click: Timeout 30000ms exceeded.
  at Page.click (/node_modules/playwright/lib/page.js:123:45)
  at Object.<anonymous> (/src/test.ts:42:10)
```

这个错误信息是给**人类开发者**看的。人看到它会去查 Playwright 文档、检查选择器、调试页面。

### gstack 的错误

```
Element not found or not interactable within timeout. Check your selector or run 'snapshot' for fresh refs.
```

这个错误信息是给 **AI agent** 看的。AI 不会查文档、不会调试——它只能根据错误消息里的文字决定下一步。所以每个错误必须包含"接下来该做什么"。

gstack 的 `wrapError()` 函数把 Playwright 的原生错误拦截下来，重写成 agent 能直接行动的格式。

### Crash 不自愈

如果 Chromium 进程崩溃了，daemon 不会尝试重启 Chromium——而是**自己也退出**。下次 CLI 来的时候发现 daemon 没了，会自动启动一个全新的 daemon。

为什么不在 daemon 内部重启 Chromium？因为 Chromium crash 后的状态是不确定的——内存可能损坏、连接可能半开半关。与其写复杂的恢复逻辑（可能引入更多 bug），不如干净退出、从头来过。

---

## 第十层：SKILL.md 模板系统

### 问题

SKILL.md 告诉 AI "你有哪些命令可以用，怎么用"。如果代码里加了一个新命令但忘了更新 SKILL.md，AI 就不知道有这个命令。反过来，如果 SKILL.md 写了一个已经删除的命令，AI 会调用一个不存在的命令然后报错。

**文档和代码不同步**是软件开发中最常见的问题之一。

### 解决方案

gstack 不手写 SKILL.md。它有一个**模板文件** `SKILL.md.tmpl`，里面有占位符：

```markdown
# Browse 命令参考

{{COMMAND_REFERENCE}}

# 快照参数

{{SNAPSHOT_FLAGS}}
```

一个叫 `gen-skill-docs.ts` 的脚本：
1. 读取源码中的命令注册表（`commands.ts` 里所有命令的名字、参数、描述）
2. 读取源码中的快照参数定义（`snapshot.ts` 里的 `SNAPSHOT_FLAGS` 数组）
3. 把提取出的信息填入占位符
4. 输出最终的 `SKILL.md`

**这意味着：如果一个命令存在于代码里，它一定出现在文档里。如果它不存在于代码里，它不可能出现在文档里。** 文档和代码的同步是自动的、强制的。

### CI 校验

在代码合并之前，CI 系统会重新跑生成脚本，然后检查生成结果是否和已提交的 SKILL.md 一致。如果不一致，CI 报错，合并被阻止。这逼迫开发者在改代码的同时更新文档。

### 和你的 L3 文档协议的关系

你的 CLAUDE.md 里规定了 L3 文件头部注释要列出依赖和导出。这和 gstack 的模板系统解决的是**同一个问题**——保持文档和代码同步。

区别在于：
- 你的 L3 是**人工维护**的。你告诉 Claude Code "改完代码记得更新 L3 注释"，它大部分时候会照做，偶尔会忘。
- gstack 的模板是**自动生成**的。代码是唯一的信息源，文档是代码的衍生物。不可能忘记更新，因为更新是自动的。

---

## 第十一层：为什么这些选择是一个整体

gstack 的每个技术选择不是孤立的，它们环环相扣：

```
Bun compile → 单一二进制 → 安装零依赖 → 用户不需要 npm install
                                        ↓
Bun.serve() → 内置 HTTP server → daemon 只需一个文件实现
                                   ↓
Daemon → Chromium 持久运行 → cookie 持久 → 登录一次就够
                             ↓
State file → CLI 知道怎么找 daemon → 版本自动重启 → 更新无感知
               ↓
Bearer token → 本地安全 → cookie 数据不泄露
                            ↓
CLI 纯文本输出 → token 开销最小 → AI 能直接理解
                                   ↓
SKILL.md 模板 → 文档自动同步 → AI 永远知道正确的命令
                                  ↓
wrapError() → 错误消息 actionable → AI 不会陷入重试循环
```

去掉任何一环，其他环节的效果都会打折扣。这不是"选了几个好技术"，而是一个**围绕 AI agent 使用场景做的系统设计**。

---

## 第十二层：作为 Founder 你需要记住什么

1. **Daemon 模型是有状态 AI 工具的正确架构。** 任何需要持久连接/登录态/长期状态的 AI 工具，都应该考虑 daemon 而非按需启动。

2. **分发方式决定用户体验。** 单一二进制 > pip install > npm install > Docker。安装步骤每多一步，流失率就高一截。

3. **CLI + 自然语言文档 > MCP，前提是只服务 Claude Code。** 如果你的工具要跨平台，MCP 仍然是正确选择。

4. **错误信息面向 agent 设计。** 每个错误必须告诉 agent 下一步该做什么，不能只说"出错了"。

5. **文档和代码的同步不能靠人。** 要么自动生成，要么 CI 强制校验。人会忘，机器不会。

6. **不做的事和做的事一样重要。** gstack 明确列出了不做的事（不做 MCP、不做多用户、不做 Windows cookie）。每一项"不做"都节省了巨大的工程量，让团队集中精力在核心价值上。

7. **Gary Tan 的真正创新不是写了更好的 prompt。** 是他把一整套工程实践（daemon 架构、二进制分发、模板文档系统、三层测试、错误重写）打包成了一个对 AI agent 友好的产品。prompt 只是最表面的一层。
