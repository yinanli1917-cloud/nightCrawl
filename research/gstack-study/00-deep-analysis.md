# Gary Tan 与 gstack：一个 CEO 如何在 10 天内造出软件工厂

> **日期**：2026-03-21
> **性质**：深度调研报告，基于 X 言论、GitHub 数据、源码逆向、公开文章的交叉验证
> **方法**：边搜边想边写，多轮搜索 + 源码阅读 + 文章全文抓取

---

## 一、人物画像：从设计师到 YC 掌门人，再到程序员

Gary Tan 的 X 简介写的是 "President & CEO @ycombinator — Founder @posthaven @posterous — designer/engineer who helps founders accelerate the boom loop."

关键经历节点：

- **1981 年**：出生于加拿大温尼伯，父亲新加坡华裔（机械车间工头），母亲缅甸华裔（护理助理）
- **14 岁**：开始编程。1991 年全家移居加州 Fremont
- **斯坦福 CS（1999-2003）**：Computer Systems Engineering 学士
- **Microsoft**：毕业后第一份工作
- **Palantir 第 10 号员工**：设计了 Palantir 的 logo，斯坦福兄弟会的朋友把他拉进去
- **Posterous（YC S08）**：联合创始人，博客平台，2012 年被 Twitter 以 $20M 收购
- **YC Partner（2011-2015）**：designer-in-residence，造了 Bookface，那年 GitHub 贡献 772 次
- **Initialized Capital（2015-2022）**：创办 VC，投了 Coinbase、Instacart、Flexport，回报超 10x，连续上 Forbes Midas List
- **YC CEO（2023.1 至今）**：接替 Geoff Ralston
- **2026 年**：Claude Code 出现，重返编码

**十年没碰代码的人，60 天内写了 60 万行。**

他在 SXSW 2026 和 Bill Gurley 的对话中说：

> "I was able to re-create my startup that took $10 million in VC capital and 10 people, and I worked on that for two years, and I took anti-narcoleptics. I took modafinil just to stay awake longer to be able to turn the momentary crystalline structures I had in my brain into lines of code before sleep or human distraction turned it to grains of sand."

> "I sleep, like, four hours a night right now. I have cyber psychosis, but I think a third of the CEOs that I know have it as well."

原版 Posterous：$10M VC + 10 个人 + 两年 + 靠药物撑着。重建版：一个人 + 90 小时 + Claude Code。

他自己的话（2026 年 3 月 16 日）：

> "I am coding a lot, GStack is helping me do it, but also I want you to know I was stranded in Austin the last 24 hours due to weather, and also last week my mom was in the hospital and not too lucid for most of it, so I was coding by her bedside too."

> "I did modafinil 15 years ago to work harder because I had to. I don't need that today because it's not all on me anymore. I'm doing it with the collected knowledge of humanity. It is a new day."

这不是一个在车库里全职写代码的人。这是一个**在当 YC CEO 的同时**、在医院陪妈妈的间隙、在出差被困机场时、**用 AI 写代码的人**。

---

## 二、时间线：10 天从 0 到 35K 星

从 GitHub commit 历史重建的完整时间线：

| 日期 | 版本 | 关键事件 |
|------|------|----------|
| 3月12日 | v0.0.1 | 首次提交，开源发布 |
| 3月12日 | — | X 宣布："I've been having such an amazing time with Claude Code I wanted you to be able to have my exact skill setup" |
| 3月13日 | v0.3.3 | SKILL.md 模板系统、三层测试、DX 工具 |
| 3月17日 | v0.6.3-0.6.4 | 设计审查、CEO 调用设计师、100% 覆盖率 |
| 3月18日 | v0.7.1-0.8.4 | 安全钩子、/codex 多 AI 审查、浏览器 handoff、README 重写、文档自动更新 |
| 3月19日 | v0.8.5-0.9.0 | 多 agent 支持（Codex/Gemini/Cursor）、遥测、社区平台 |
| 3月20日 | v0.9.1-0.9.4 | 对抗性审查循环、Gemini CLI E2E 测试、Windows 支持 |
| 3月21日 | v0.9.5-0.9.9 | /office-hours、/land-and-deploy、/canary、/benchmark |

**107 个 commit，10 天。** commit author 几乎全部是 `garrytanandclaude`——他和 Claude 一起写的。有 6 个 contributors（含社区 PR），88 个 open PR，45 个 issues。

**35,200 星，4,300 fork，226 watchers。** 从零到 GitHub 热门仓库，10 天。

而且他还有其他项目——他提到 "my last /retro across 3 projects: 140,751 lines added, 362 commits, ~115k net LOC"。gstack 只是其中之一。

---

## 三、"Boil the Lake"——核心哲学

Gary Tan 2026年2月7日在 garryslist.org 发表的文章（全文已抓取），核心论点：

> "Our fear of the future is directly proportional to how small our ambitions are."

**"别煮沸海洋"是旧时代的忠告。** 在 AI 时代，该退休了。该煮的不止是海洋，先从几个湖开始。

他引用了两个经济学概念来论证：

1. **Buckminster Fuller 的"渐进非物质化"（1938）**：石桥 → 铁桁架 → 钢缆，每一代更强、更轻、更便宜。不是消灭工作，是文明在进化。

2. **Jevons 悖论**：蒸汽机没有减少煤炭消耗，反而让煤炭变得如此有用以至于需求爆炸。同样的事即将发生在智能、劳动力、每一个产品和服务上。

**但他加了一个关键限定：** "Jevons Paradox doesn't activate on its own. It requires capital and management to actually raise their ambitions." 悖论不会自动激活，需要有人提高野心。

这解释了 gstack 里 "Completeness Principle" 的由来——代码里写着：

> "If Option A is the complete implementation and Option B is a shortcut that saves modest effort — always recommend A. The delta between 80 lines and 150 lines is meaningless with CC+gstack."

**他不是在说"能做就做"。他是在说"AI 让完整实现的边际成本接近零，所以不完整是一种浪费"。**

---

## 四、源码揭示的真相：CEO 写了什么，Claude 写了什么

### 4.1 Gary Tan 写的（判断力层）

通过源码分析，以下决策明显是人做的：

1. **架构选型**：daemon 模型而非按需启动、Bun 而非 Node、CLI 而非 MCP
2. **"有意不做"清单**：无 WebSocket、无 MCP、无多用户、无 iframe、无自愈
3. **安全边界**：cookie 不写磁盘、浏览器注册表硬编码、shell 注入防护
4. **skill 编排顺序**：Think → Plan → Build → Review → Test → Ship → Reflect
5. **Completeness Principle**：永远推荐完整实现，反对走捷径
6. **handoff 机制**：agent 连续失败 3 次就提示让人来

这些是**设计判断力**，不是代码能力。Claude 能写出 `wrapError()` 函数的每一行，但"错误消息应该面向 agent 而非人类"这个决策，是 Gary Tan 做的。

### 4.2 Claude 写的（实现层）

以下部分几乎可以确定是 Claude 生成的：

1. **cookie 解密管线**：PBKDF2 + AES-128-CBC，标准 Chromium 解密流程，网上有大量参考实现
2. **snapshot 解析器**：正则匹配 ARIA tree 格式、ref 分配、locator 构建
3. **CircularBuffer**：标准环形缓冲区实现
4. **HTTP server 路由**：`Bun.serve()` 的标准用法
5. **state file 原子写入**：tmp + rename 模式
6. **CLI 的重试逻辑**：连接失败 → 重启 → 重试

### 4.3 Gary Tan 真正做的事

他不是在"写代码"。他在**做产品决策并让 Claude 实现**。用他自己的框架来看：

- `/office-hours`：先想清楚要什么（daemon 模型）
- `/plan-ceo-review`：审查架构（CLI vs MCP、crash vs 自愈）
- `/plan-eng-review`：锁定技术选型（Bun、Playwright）
- 然后让 Claude 写代码
- `/review`：审查 Claude 的输出
- `/qa`：让 Claude 的浏览器测试 Claude 写的代码
- `/ship`：发布

**他在用 gstack 来开发 gstack。** 这是 bootstrapping——用自己的工具来造自己。

---

## 五、社区反响：震惊、困惑、膜拜

### CTO "God Mode" 评价

一位 CTO 朋友发短信给他：

> "Your gstack is crazy. This is like god mode. Your eng review discovered a subtle cross site scripting attack that I don't even think my team is aware of. I will make a bet that over 90% of new repos from today forward will use gstack."

### 外部文章

| 来源 | 标题 | 核心观点 |
|------|------|----------|
| **TechCrunch** | "Why Garry Tan's Claude Code setup has gotten so much love, and hate" | 正反两面分析 |
| **Medium (Luong Nguyen)** | "gstack is not a dev tool. It's Garry Tan's brain on AI" | gstack 是思维模型的编码化 |
| **Medium (ML Artist)** | "GStack vs AI Sycophancy: Why 'God Mode' Has a Dark Side" | 质疑 AI 奉承问题 |
| **SitePoint** | "GStack Tutorial" | 实操教程 |
| **DEV Community** | "A CTO Called It 'God Mode'" | 社区传播分析 |

Luong Nguyen 的核心洞察："/plan-ceo-review 实质上是把 Tan 的评估框架跑在一个能实时研究市场的 AI agent 上。Combined with an AI that has the internet and unlimited patience, the result can be more thorough than a 30-minute conversation with Tan himself."

### 批评声音

- Vlogger Mo Bitar 做了视频 **"AI is making CEOs delusional"**，指出本质上就是 "a bunch of prompts in a text file"
- 开发者质疑：很多人早就有自己的 prompt 集合，Tan 的 YC CEO 身份让这些内容获得了不相称的关注
- 核心分歧不在于 prompt 是否有用，而在于 "role-based AI development" 是否算创新

### 中文社区

**@gkxspace（余温）**：
> "Garry Tan (YC 的 CEO) 把 YC office hours 的方法论写成了 Claude Code 的 skill 开源了。你有一个想法，跑 /office-hours，它模拟一个 YC partner 和你对话。"

**@dontbesilent**：
> "这是我用过的最好的 skill。不管怎么推广，大多数人只会围观，顶多装一下，但不会真的在自己的 context 下把它推进下去。"

**@GoJun315（高军）**：
> "YC 的 CEO 开源了他的个人 AI 作弊码。gstack 直接把 Claude Code 变成一个完整的工程部门。"

### 英文社区

有人在 Maven 上开课教 gstack 使用方法（4 小时，收费）。Gary Tan 自己看到后的反应：

> "OMG someone is charging money to teach people how to use GStack on Maven" （没有反对，语气是惊讶+好笑）

---

## 六、gstack 真正创新了什么

撇开那些"Claude Code 本身就有的功能"，gstack 真正独特的贡献是：

### 6.1 Skill 编排——Sprint 模型

把 AI agent 的能力组织成一个**软件开发流程**，而不是一堆工具的集合。每个 skill 知道上一步做了什么、下一步要做什么。

```
/office-hours → 写设计文档 → /plan-ceo-review 读它 → /plan-eng-review 写测试计划 → /qa 执行
```

这不是技术创新，是**管理创新**。他把 YC 评审创业项目的方法论编码了。

### 6.2 Agent 有眼睛——浏览器作为 QA 工具

> "I SEE THE ISSUE" — Claude Code + gstack browse

让 agent 打开真实浏览器、点真实按钮、看真实截图、找真实 bug。这是从"agent 只能读代码"到"agent 能看产品"的跨越。他说这让他从 6 个并行 worker 提升到 12 个。

### 6.3 handoff——人机协作的接口

agent 连续失败 3 次 → 自动提示 "要不让人来" → 打开有头浏览器给用户操作 → 用户搞定后 `resume` → agent 继续。

这承认了 agent 的能力边界，而不是假装 agent 万能。

### 6.4 /codex——多 AI 交叉审查

让 Claude 写的代码被 OpenAI Codex 审查。反过来也可以。**同一个 diff，两个不同的 AI 看**，然后比较发现哪些一致、哪些只有一方发现了。

### 6.5 Boil the Lake 作为工程原则

不只是一篇文章，而是嵌入到每个 skill 的决策逻辑中：

```
Every AskUserQuestion must include:
- Completeness: X/10 for each option
- RECOMMENDATION: Choose [X] because [reason]
- Always prefer complete option over shortcuts
```

---

## 七、YC 数据：不只是 Gary Tan 一个人

他不只是自己在用 AI 编码——他看到了整个 YC batch 的数据：

> "For 25% of the Winter 2025 batch, 95% of lines of code are LLM generated. That's not a typo. The age of vibe coding is here."

这意味着 YC W25 batch 中，**四分之一的创业公司几乎全部代码是 AI 写的**。Gary Tan 不是个例，他是趋势的放大器——作为 YC CEO，他既看到了趋势，又在身体力行地推动它。

---

## 八、对我们的启示

### 我们和 Gary Tan 的差异

| 维度 | Gary Tan | 我们 |
|------|----------|------|
| 编码经验 | 十年前是 PM/设计师/工程经理 | 正在学习中 |
| 管理经验 | YC CEO，投过上千家公司 | Founder，第一次 |
| AI 使用强度 | 10-15 并行 Claude 窗口 | 1 个 |
| 核心优势 | 知道软件应该怎么被开发（流程） | 知道自己想要什么（需求） |

### 可以直接复用的

1. **gstack 本身**——已经装了，直接用
2. **/office-hours**——在动手前先想清楚要什么
3. **Sprint 模型**——Think → Plan → Build → Review → Test → Ship
4. **CLAUDE.md 触发器模式**——文件名匹配时加载特定文档，节省 token

### 不要盲目复制的

1. **10-15 并行窗口**——需要极强的 context 管理能力，先从 2-3 个开始
2. **60 万行代码**——行数不是目标，他自己也说 "35% tests"，真正的产出可能是 20 万行业务代码
3. **社交媒体叙事**——"20,000 lines per day" 是包含测试、文档、生成代码的总量，不是手写代码量

### 应该学的本质

**Gary Tan 的核心能力不是编码，是产品判断力。**

他知道"错误消息应该给 agent 看"，他知道"agent 失败 3 次应该让人来"，他知道"设计审查应该在工程审查之前"，他知道"完整实现的边际成本已经接近零"。

这些判断力来自于**管理过真实的工程团队**、**评审过上千个创业项目**、**看过无数产品成功和失败**。

AI 放大的是你已有的判断力。如果你的判断力是 10 分，AI 让你产出 100x。如果判断力是 1 分，AI 让你产出 100x 的垃圾。

---

## 九、一句话总结

Gary Tan 不是一个"重新学会编程的 CEO"。

他是一个**一直没忘记什么是好产品的人，等到了一个不需要自己写代码就能造好产品的时代**。

gstack 的 2300 行核心代码不重要。重要的是那些代码背后的 300 个产品决策。

---

> *本报告基于：X 多轮关键词搜索（garrytan × gstack/claude code/boil the lake/coding/software factory）、GitHub commit 历史逐条扫描（107 commits）、garryslist.org "Boil the Ocean" 全文抓取、gstack 源码逆向（6 核心文件 ~2300 行）、TechCrunch/Medium/DEV Community 等外部文章、SXSW 2026 对话引用、中英文社区评论交叉验证。Wikipedia 提供背景时间线校准。部分推断标注为推测。*
