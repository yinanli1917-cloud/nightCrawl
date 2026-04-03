# gstack 架构逆向分析 — 学习笔记

> **日期**：2026-03-21
> **用途**：系统性拆解 gstack 的架构设计、安全模型、工程决策，为自建 MCP 工具提供参考
> **来源**：gstack 的 ARCHITECTURE.md, CLAUDE.md, AGENTS.md, CONTRIBUTING.md

---

## 1. 核心理念

gstack = **持久浏览器** + **一组有观点的工作流 skill**

关键洞察：AI agent 操作浏览器需要两个前提——**亚秒延迟**和**持久状态**。

- 如果每个命令冷启动浏览器，3-5 秒延迟，agent 的思考链条会被打断
- 如果浏览器进程死掉，cookie / tab / session 全丢，之前的登录和导航白费

所以 gstack 的核心不是"又一个浏览器自动化工具"，而是一个**常驻浏览器 daemon**，对外暴露极薄的 CLI + HTTP 接口。

> 💡 **我的评价**
>
> 这个定位非常精准。MCP 协议的 tool call 本质上就是"发一条指令、拿一个结果"，如果底层资源每次都要冷启动，延迟会让 agent 体验崩溃。gstack 把"持久"作为第一公民来设计，而不是事后优化，这个顺序是对的。
>
> **对自建 X MCP 的启示**：任何需要有状态交互的 MCP server（浏览器、数据库连接、SSH session），都应该走 daemon 模型而非按需启动。我们的 Apple Notes MCP 目前是无状态的，但如果未来要做"持续监听笔记变更"之类的功能，daemon 模型值得考虑。
>
> **可改进**：gstack 目前是单用户单实例，如果要支持多个 agent 并发操作同一个浏览器，需要引入 session 隔离。不过他们明确说了"有意不做多用户"，在 CLI 场景下这是合理的取舍。

---

## 2. 架构图

```
Claude Code → CLI (compiled binary, ~1ms) → HTTP Server (Bun.serve, localhost:PORT) → Chromium (headless, 持久)
```

- **第一次调用** ~3s（启动所有组件：Bun server + Chromium）
- **后续每次** ~100-200ms（CLI 只是发一个 HTTP POST）

四层各司其职：

| 层 | 职责 | 延迟贡献 |
|---|---|---|
| CLI binary | 解析参数、读 state file、发 HTTP 请求 | ~1ms |
| HTTP Server | 路由、鉴权、编排 Playwright 操作 | ~50ms |
| Playwright | 浏览器自动化抽象层 | ~50-100ms |
| Chromium | 实际渲染和执行 | 取决于页面 |

> 💡 **我的评价**
>
> 这个分层非常干净。CLI 编译为单一二进制意味着 Claude Code 调用它就像调用 `ls` 一样——没有 runtime 依赖、没有启动开销。HTTP Server 层把"浏览器操作"变成了普通的 REST API，这意味着理论上任何能发 HTTP 的 agent 都能用。
>
> **对自建 X MCP 的启示**：MCP server 的"胖瘦"问题。gstack 选择了"瘦 CLI + 胖 daemon"，CLI 几乎没有逻辑。这比"胖 CLI 直接操作浏览器"好得多——因为 CLI 被 agent 频繁调用，必须极快；而 daemon 只启动一次，可以慢一点。
>
> **可改进**：缺少一个 health check endpoint 的描述。如果 daemon 假死（进程在但 Chromium 卡住），CLI 应该能检测到并重启。

---

## 3. 为什么选 Bun 而不是 Node

四个决定性理由：

1. **`bun build --compile`** 生成单一 ~58MB 二进制，无 `node_modules`
   - 用户不需要装 Node.js、不需要 `npm install`
   - 分发就是一个文件

2. **内置 SQLite**（`new Database()`），无需 `better-sqlite3` / `node-gyp`
   - Cookie 解密需要读 Chrome 的 SQLite 数据库
   - Node 生态的 SQLite binding 是出了名的难装（gyp 编译问题）

3. **原生 TypeScript**，开发时无需编译步骤
   - 改了就能跑，没有 tsc watch 的心智负担

4. **`Bun.serve()`** 足够轻量，不需要 Express / Fastify
   - 整个 HTTP server 可能就几十行

> 💡 **我的评价**
>
> 选型非常务实，每个理由都指向一个具体的痛点而非"新技术好玩"。特别是第 1、2 点——单一二进制分发和内置 SQLite——这两个直接决定了安装体验是"下载一个文件"还是"跑一堆命令祈祷不报错"。
>
> **对自建 X MCP 的启示**：如果我们的 MCP server 需要分发给其他人用，Bun compile 是一个极好的选择。目前我们的 Python MCP server 需要用户装 Python + pip install，体验远不如单一二进制。Swift 编译的二进制也能达到类似效果，但 Bun 的优势是同时拥有 npm 生态。
>
> **可改进**：58MB 对于一个 CLI 来说偏大。如果未来 Bun 支持 tree-shaking compile（只打包用到的运行时部分），体积应该能降到 20MB 以下。

---

## 4. Daemon 模型

### 4.1 设计原则

| 特性 | 说明 |
|---|---|
| **持久状态** | 登录一次保持登录，tab 保持打开 |
| **亚秒命令** | 首次后每个命令就是一个 HTTP POST |
| **自动生命周期** | 首次使用自启动，30 分钟空闲自关闭 |
| **版本自动重启** | binary version 不匹配时 CLI 杀旧进程、启新进程 |

### 4.2 State File

路径：`.gstack/browse.json`

```json
{
  "pid": 12345,
  "port": 34567,
  "token": "uuid-v4",
  "startedAt": "...",
  "binaryVersion": "abc123"
}
```

关键细节：
- **原子写入**：先写到 tmp 文件，再 `rename()` 覆盖（防止读到写了一半的文件）
- **权限**：`mode 0o600`（只有当前用户可读写，防止其他用户偷 token）

### 4.3 端口选择

- 范围：10000-60000（避开系统端口和常用端口）
- 最多重试 5 次（随机选端口直到绑定成功）

### 4.4 版本自动重启

CLI 读取 state file 中的 `binaryVersion`，如果和自身版本不匹配，说明用户更新了 gstack 但 daemon 还在跑旧版。此时 CLI 会 kill 旧 daemon、启动新 daemon。

> 💡 **我的评价**
>
> 这个 daemon 模型是整个架构中最精妙的部分。几个设计值得细品：
>
> - **原子写入 state file**：这是系统编程的基本功，但很多 Node/TS 项目会直接 `writeFileSync()`，在 crash 时留下损坏的文件。gstack 用 tmp + rename 是正确做法。
> - **30 分钟自关闭**：优雅地解决了"用完忘关"的问题，不会浪费资源。
> - **版本自动重启**：解决了"更新后忘了重启 daemon"的问题。这个在 MCP server 场景极为重要——用户 `pip install --upgrade` 之后，如果 server 还在跑旧版，bug 修了也没用。
>
> **对自建 X MCP 的启示**：我们的 MCP server 目前没有版本自动重启机制。如果用户更新了 server，需要手动重启 Claude Desktop。可以借鉴 gstack 的 state file + version check 模式。
>
> **可改进**：state file 用 JSON 有个问题——如果文件损坏（虽然原子写入极大降低了概率），JSON parse 会抛异常。可以考虑加一个 checksum 字段做校验，或者干脆用更简单的 `key=value` 格式。

---

## 5. 安全模型

### 5.1 网络隔离

- **localhost only**，绝不绑定 `0.0.0.0`
- 外部网络完全无法访问 daemon

### 5.2 认证

- **Bearer token auth**
- Token 是 UUID v4，写入 `mode 0o600` 的 state file
- CLI 每次请求从 state file 读取 token，放入 `Authorization: Bearer <token>` header

### 5.3 Cookie 安全

- **Keychain 访问需用户批准**（macOS 会弹授权弹窗）
- **内存解密不写磁盘**：cookie 解密后只在内存中，不会写到任何文件
- **数据库只读**：打开 Chrome 的 cookie SQLite 时用只读模式，不修改浏览器数据
- **Key 缓存 per-session**：Keychain 密钥只在当前 daemon session 内缓存，daemon 重启后需重新获取

### 5.4 Shell 注入防护

- **浏览器注册表硬编码**：不从用户输入中取浏览器路径
- **`Bun.spawn()` 显式参数数组**：用 `spawn("cmd", ["arg1", "arg2"])` 而非 `spawn("cmd arg1 arg2")`，从根本上杜绝 shell 注入

> 💡 **我的评价**
>
> 安全模型做得很到位，尤其是 cookie 安全这块——因为 gstack 本质上是在读用户的浏览器 cookie，这是非常敏感的数据。"内存解密不写磁盘"和"数据库只读"两条规则，把攻击面降到了最小。
>
> `Bun.spawn()` 用参数数组而非字符串拼接，这是防 shell 注入的标准做法，但很多项目还是会犯错。gstack 把这条写进架构文档，说明他们认真对待安全。
>
> **对自建 X MCP 的启示**：我们的 MCP server 如果需要调用外部命令（比如 AppleScript），一定要用参数数组而非字符串拼接。目前 `osascript -e` 的调用方式需要审计一下。
>
> **可改进**：Bearer token 是静态的（daemon 启动时生成一次）。如果 token 泄露（比如进程列表中暴露），整个 session 都不安全。可以考虑 HMAC-based 的 per-request 签名，或者定期轮换 token。不过考虑到 localhost only + 0o600 权限，实际风险很低。

---

## 6. SKILL.md 模板系统

### 6.1 生成管线

```
.tmpl 模板文件 → 源码解析占位符 → 生成 .md skill 文件 → 提交到 git
```

### 6.2 占位符

| 占位符 | 来源 |
|---|---|
| `{{COMMAND_REFERENCE}}` | 从命令注册表解析所有命令的用法和参数 |
| `{{SNAPSHOT_FLAGS}}` | 快照相关的 flag 文档 |
| `{{PREAMBLE}}` | 通用前言（版本检查、session 跟踪等） |
| `{{BROWSE_SETUP}}` | 浏览器初始化相关指引 |

### 6.3 为什么提交生成产物而非运行时生成

三个理由：

1. **加载时无 build step**：Claude Code 读取 SKILL.md 时不需要跑生成脚本
2. **CI 可验证新鲜度**：CI 跑生成脚本，diff 检查生成产物是否和提交的一致
3. **git blame 有效**：可以追溯每一行 skill 文档的变更历史

### 6.4 Preamble 四功能

1. **更新检查**：提醒 agent 检查是否有新版本
2. **Session 跟踪**：记录 agent 使用次数，**3+ session = ELI16 模式**（减少解释性内容，假设 agent 已经熟悉工具）
3. **Contributor 模式**：如果当前在 gstack 仓库内工作，切换到开发者视角
4. **AskUserQuestion 格式**：规范 agent 向用户提问的格式

> 💡 **我的评价**
>
> 模板系统是工程上的好决策。skill 文档和代码之间的一致性是个大问题——如果命令参数改了但文档没更新，agent 就会用错误的参数调用命令。模板系统从源码生成文档，配合 CI 新鲜度校验，从根本上消除了这个问题。
>
> **Preamble 的 session 跟踪特别有意思**：3+ session 后切换到 ELI16 模式（Explain Like I'm 16），减少冗余解释。这说明 gstack 团队观察到 agent 在多次使用后已经"学会"了工具，此时详细解释反而浪费 token。这是 **prompt 工程中的自适应策略**。
>
> **对自建 X MCP 的启示**：我们的 skill 文档目前是手写的。如果命令接口变了，文档容易忘记更新。可以借鉴 gstack 的 `.tmpl → .md` 管线，至少把命令参考部分自动生成。
>
> **可改进**：模板系统的缺点是增加了构建复杂度。如果模板语法本身出 bug，调试成本不低。不过 gstack 的占位符很简单（就是 `{{NAME}}`），复杂度可控。

---

## 7. 测试三层

| Tier | 内容 | 成本 | 速度 | 适用场景 |
|------|------|------|------|----------|
| **1 — 静态验证** | 解析 `$B` 命令、校验 registry | 免费 | <2s | 每次提交 |
| **2 — E2E** | `claude -p` 子进程执行完整工作流 | ~$3.85 | ~20min | PR 合并前 |
| **3 — LLM-as-judge** | Sonnet 评分输出质量 | ~$0.15 | ~30s | 输出质量验证 |

### Tier 1：静态验证

不需要启动浏览器，纯粹检查代码结构：
- 命令注册表是否完整
- 参数定义是否合法
- 模板生成产物是否新鲜

### Tier 2：E2E

启动 `claude -p`（programmatic 模式）作为子进程，让 Claude 实际使用 gstack 完成任务，验证整个链路。这是最贵的测试（每次跑要花 API 费用），但也是最真实的。

### Tier 3：LLM-as-judge

用 Sonnet 评估 agent 的输出质量——比如"agent 是否正确提取了页面信息"、"格式是否符合要求"。成本极低（$0.15），适合大规模回归测试。

> 💡 **我的评价**
>
> 测试分层策略非常成熟。特别是 **Tier 2 用 `claude -p` 做 E2E 测试**——这意味着他们测试的不是"代码是否正确"，而是"agent 使用这个工具时是否能完成任务"。这是 agent tool 测试的正确姿势。
>
> **LLM-as-judge（Tier 3）** 是我第一次在工具项目中看到的测试方式。传统测试用 assert 检查精确值，但 agent 输出是自然语言，无法精确匹配。用另一个 LLM 来评分是目前最实用的方案。
>
> **对自建 X MCP 的启示**：我们的 MCP server 目前只有手动测试。至少应该建立 Tier 1（静态验证），比如检查 tool schema 是否合法、参数类型是否正确。Tier 2 可以用 Claude Code 的 `--print` 模式来做。
>
> **可改进**：Tier 2 的 $3.85/次 成本不低，跑 10 个 E2E case 就是 $38.5。可以考虑用更便宜的模型（Haiku）做冒烟测试，只在 release 前用 Opus 做完整 E2E。

---

## 8. 错误哲学

### 核心原则：错误消息面向 AI agent 而非人类

传统工具的错误消息：
```
Error: Navigation timeout of 30000ms exceeded
```

gstack 的错误消息（推测）：
```
Page did not load within 30s. Try: (1) check if the URL is correct, (2) use `browse snapshot` to see current page state, (3) the site may be down.
```

### 三条铁律

1. **每个错误必须 actionable**：告诉 agent 下一步该做什么，而不只是说"出错了"
2. **`wrapError()` 重写 Playwright 原生错误**：Playwright 的错误消息是给人看的，gstack 包一层变成给 agent 看的
3. **Crash = Exit，不自愈**：daemon 遇到致命错误直接退出，CLI 下次调用时会自动重启新 daemon

> 💡 **我的评价**
>
> **"错误消息面向 AI agent"** 是整个架构文档中最有洞察力的一条。大多数工具的错误消息是给人读的——人可以看上下文、Google 搜索、举一反三。但 agent 只能看到错误消息本身，如果消息不 actionable，agent 就会陷入重试循环。
>
> **Crash = Exit 不自愈** 也是好决策。自愈逻辑（重试、回退、降级）会极大增加代码复杂度，而且 agent 场景下 CLI 本身就有重试能力。让 daemon crash、让 CLI 重启，职责划分清晰。
>
> **对自建 X MCP 的启示**：我们的 MCP server 返回的错误消息需要全面审查。目前很多错误是直接透传底层异常，agent 看了一头雾水。应该效仿 gstack 的 `wrapError()` 模式，把每个错误都包装成 actionable 的格式。
>
> **可改进**：可以建立一个错误消息的 lint 规则——每个 throw/reject 的消息必须包含"Try:"或"Next step:"关键词，CI 自动检查。

---

## 9. 有意不做的事

| 不做 | 原因（推测） |
|------|------|
| **无 WebSocket streaming** | 复杂度高，HTTP request-response 足够 agent 使用 |
| **无 MCP 协议** | 直接用 CLI + SKILL.md，比 MCP 更简单且性能更好 |
| **无多用户支持** | CLI 工具就是单用户的，多用户是服务端场景 |
| **无 Windows/Linux cookie 解密** | macOS 优先，其他平台 cookie 存储机制完全不同 |
| **无 iframe 支持** | iframe 跨域问题极其复杂，ROI 太低 |

> 💡 **我的评价**
>
> **"有意不做"清单是架构文档中最有价值的部分之一。** 知道一个项目选择不做什么，比知道它做了什么更能揭示设计哲学。
>
> **无 MCP 协议** 最值得讨论：gstack 选择 CLI + SKILL.md 而非 MCP，是因为 Claude Code 原生支持 bash tool call，CLI 的调用路径比 MCP 更短、更快。SKILL.md 提供了 MCP 的 tool schema 所做的事（告诉 agent 有哪些能力、怎么调用），但以自然语言的形式，给了 agent 更多上下文。
>
> 这揭示了一个有趣的张力：**MCP 是标准化的，但标准化带来了开销**（协议解析、连接管理、schema 校验）。对于"和 Claude Code 深度集成"这个特定场景，CLI + SKILL.md 确实比 MCP 更优。但如果要支持多个 agent host（Claude Desktop、Cursor、Windsurf），MCP 的标准化优势就体现出来了。
>
> **对自建 X MCP 的启示**：不必执着于 MCP 协议。如果工具只用于 Claude Code，CLI + SKILL.md 可能是更好的选择。MCP 的价值在跨平台兼容，如果不需要跨平台，它就是 overhead。
>
> **可改进**：iframe 不支持可以理解，但应该在错误消息中明确告知 agent "当前页面包含 iframe，gstack 无法操作 iframe 内的元素，请尝试直接导航到 iframe 的 src URL"。

---

## 10. Skill 编写规范（来自 CLAUDE.md）

### 四条核心规则

1. **用自然语言传递状态，不用 shell 变量**
   - ❌ `export RESULT=$(gstack browse ...) && echo $RESULT`
   - ✅ 让 agent 在对话中记住上一步的结果，下一步直接用

2. **不硬编码分支名**
   - ❌ `git checkout main`
   - ✅ 让 agent 自己判断当前分支和目标分支

3. **bash block 相互独立**
   - 每个 bash 代码块应该能独立执行，不依赖前一个块设置的环境变量
   - 因为 Claude Code 的 bash tool 每次调用都是新 shell

4. **用英文表达条件**
   - ❌ `if [ $? -eq 0 ]; then ...`
   - ✅ "If the previous command succeeded, then ..."
   - 让 agent 用自然语言理解条件，而非解析 shell 语法

> 💡 **我的评价**
>
> 这四条规则深刻理解了 **agent 执行 bash 的心智模型**。agent 不是 shell 脚本——它在对话上下文中维护状态，而非在 shell 环境变量中。gstack 的 skill 设计完全贴合这个心智模型。
>
> 特别是第 3 条"bash block 相互独立"——这是 Claude Code 的一个实际限制（每次 bash 调用是新 shell），gstack 把这个限制变成了设计约束，而不是试图用 workaround 绕过它。
>
> **对自建 X MCP 的启示**：我们写 skill 文档时，应该把这四条作为 checklist。特别是第 1 条——不要试图让 agent 写 shell 脚本，而是让 agent 用自然语言编排多个工具调用。
>
> **可改进**：可以加一条"每个 bash block 应该有明确的成功/失败输出"——让 agent 能清楚判断这一步是否成功。

---

## 11. 安装机制（来自 dev-setup）

### 双 symlink 策略

```
.claude/skills/gstack  →  repo root    # Claude Code
.agents/skills/gstack  →  repo root    # Codex / Gemini / Cursor
```

### 关键设计

| 特性 | 说明 |
|---|---|
| **Symlink 而非复制** | 修改源码立即生效，无需重新安装 |
| **Dev mode** | 开发时改了 SKILL.md，Claude Code 下次读取就是新版 |
| **双 host 生成** | 同时为 Claude（`.claude/`）和 Codex/Gemini（`.agents/`）生成 skill 入口 |

### 安装流程（推测）

```bash
# dev-setup 脚本做的事
mkdir -p .claude/skills .agents/skills
ln -sf $(pwd) .claude/skills/gstack
ln -sf $(pwd) .agents/skills/gstack
```

> 💡 **我的评价**
>
> **Symlink 是开发体验的关键**。如果每次改了代码都要"重新安装"，开发循环会慢得让人发疯。gstack 用 symlink 让修改即时生效，这是"开发者体验优先"的体现。
>
> **双 host 生成** 说明 gstack 团队在认真考虑多 agent 平台兼容。虽然 SKILL.md 的格式可能不完全适配所有平台，但至少目录结构是通用的。
>
> **对自建 X MCP 的启示**：我们的 skill 安装目前也是 symlink 模式（`~/.claude/skills/` 指向 iCloud），这是正确的做法。但我们还没有考虑 `.agents/` 目录——如果未来要支持 Cursor 或 Codex，应该提前规划。
>
> **可改进**：symlink 有个坑——如果用户在不同目录下 clone 了多份 repo，symlink 会指向最后一次运行 dev-setup 的那份。可以加一个检查，如果 symlink 已存在且指向不同位置，提醒用户。

---

## 12. 总结：gstack 的设计哲学

从以上分析中提炼出 gstack 的核心设计哲学：

| 原则 | 体现 |
|---|---|
| **Daemon 优于按需启动** | 持久浏览器、亚秒响应、状态保持 |
| **单一二进制优于依赖链** | Bun compile、无 node_modules |
| **Crash 优于自愈** | 退出 + CLI 重启，简单可靠 |
| **Agent 优先于人类** | 错误消息 actionable、SKILL.md 自适应 |
| **显式优于隐式** | 不做的事写出来、安全边界明确 |
| **Symlink 优于复制** | 开发即时生效、单一 source of truth |

这些原则对我们自建工具的核心启示：**为 agent 设计工具和为人类设计工具，思路是根本不同的。** agent 需要更快的响应、更 actionable 的错误、更简单的安装、更持久的状态。gstack 把这些需求提升为第一优先级，而不是在传统工具上打补丁。

---

> *本笔记基于 gstack 公开的架构文档逆向分析，部分实现细节为合理推测。*
