# gstack Skill 四大范式 — 逆向工程学习笔记

> 日期：2026-03-21
> 来源：gstack skill 逆向分析

---

## 目录

- [范式总览](#范式总览)
- [范式 1: 行为约束型 — /careful](#范式-1-行为约束型--careful)
- [范式 2: 多阶段工作流型 — /review](#范式-2-多阶段工作流型--review)
- [范式 3: 交互对话型 — /office-hours](#范式-3-交互对话型--office-hours)
- [范式 4: CEO 审查型 — /plan-ceo-review](#范式-4-ceo-审查型--plan-ceo-review)
- [Skill 结构通用模式](#skill-结构通用模式跨范式)

---

## 范式总览

| 范式 | 代表 Skill | 核心机制 | 复杂度 |
|------|-----------|---------|--------|
| 行为约束型 | `/careful` | Hook + Shell 脚本拦截危险命令 | ~60 行 |
| 多阶段工作流型 | `/review` | Step 线性推进 + 模板变量注入 | 中等 |
| 交互对话型 | `/office-hours` | 双模式路由 + 逐问推进 | 高 |
| CEO 审查型 | `/plan-ceo-review` | 多模式选择 + 认知框架注入 | ~750 行，最复杂 |

---

## 范式 1: 行为约束型 — /careful

### 核心思想

**改变 Claude 的运行时行为，而非给它新指令。**

不是告诉 Claude "请小心"，而是在工具调用层面物理拦截危险操作。SKILL.md 极短（约 60 行），只做说明文档，真正逻辑全在 shell 脚本里。

### 实现机制

```yaml
hooks:
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "bash ${CLAUDE_SKILL_DIR}/bin/check-careful.sh"
```

关键点：
- **拦截层级**：`PreToolUse` — 在工具执行前触发
- **匹配器**：只拦截 `Bash` 工具调用
- **逻辑载体**：`bin/check-careful.sh` — 纯 shell 模式匹配

### 保护清单

| 类别 | 拦截模式 |
|------|---------|
| 文件删除 | `rm -rf` |
| 数据库 | `DROP TABLE` |
| Git 危险操作 | `git push --force`, `git reset --hard` |

### 安全例外

`rm -rf node_modules` 等构建产物被白名单放行。这体现了一个重要原则：**安全规则必须有合理的逃生通道**，否则用户会绕过整个系统。

### 同族 Skill

- `/freeze` — 锁定编辑目录（只读模式）
- `/guard` — careful + freeze 的组合（最大防护）

### 启示

**适合场景**：任何需要"护栏"的情况 — 保护生产环境、防止误操作、限制 AI 行为边界。

**应用方向**：
- 自己的 skill 可以用这种模式做"安全层"，比如禁止修改某些核心配置文件
- Hook 机制是 Claude Code 最被低估的能力 — 它让 skill 从"建议"变成"强制"
- Shell 脚本做拦截逻辑，比在 SKILL.md 里写自然语言约束可靠得多

**可改进空间**：
- 拦截日志可以持久化，帮助审计"Claude 试图做什么被拦了"
- 可以加一个 `--override` 机制，让用户在确认后绕过特定拦截

---

## 范式 2: 多阶段工作流型 — /review

### 核心结构

```
Step 1:   Check branch
Step 1.5: Scope Drift Detection
Step 2:   Read checklist
Step 2.5: Greptile comments
Step 3:   Get diff
Step 4:   Two-pass review (CRITICAL → INFORMATIONAL)
Step 4.5: Design Review
Step 5:   Fix-First (AUTO-FIX / ASK)
Step 5.5: TODOS cross-reference
Step 5.6: Doc staleness check
```

注意 `.5` 步骤的存在 — 这不是后期打补丁，而是刻意的设计：**主步骤之间插入检查点**，让流程可以在不破坏编号体系的情况下演化。

### 五个关键设计模式

#### 1. 模板变量注入

```
{{PREAMBLE}}
{{BASE_BRANCH_DETECT}}
```

共享逻辑通过模板变量注入 SKILL.md。这意味着多个 skill 可以复用同一段启动逻辑，而不是复制粘贴。

#### 2. Fix-First 模式

传统 code review 是只读的。gstack 的 `/review` 打破了这个假设：

- **AUTO-FIX**：发现问题直接改代码
- **ASK**：询问用户是否修复

这是一个重要的范式转变 — review 不再是"发现问题然后交给人"，而是"发现问题、修复问题、交给人确认"。

#### 3. 外部工具整合

- Greptile 集成（AI code review 服务）
- TODOS.md 交叉引用（检查 review 发现的问题是否已在待办里）

#### 4. 自然语言状态传递

Step 之间没有变量传递机制（每个 bash block 独立运行），状态完全靠自然语言 prose 在上下文中流动。这是 LLM skill 设计的一个核心约束：**你没有持久变量，上下文就是你的内存。**

#### 5. Claims Verification

如果 review 中声称"这是安全的"，**必须引用具体代码行**。这条规则防止了 LLM 最常见的问题 — 自信地胡说。

### 启示

**适合场景**：任何有明确步骤序列的工作流 — CI/CD review、文档生成、代码迁移。

**应用方向**：
- `.5` 步骤编号方案非常实用，让 skill 可以渐进演化而不重编号
- Fix-First 思路值得推广：skill 不应该只是"分析工具"，应该是"分析 + 行动"
- 模板变量注入是跨 skill 复用逻辑的关键机制

**可改进空间**：
- 自然语言状态传递在长 review 中可能丢失上下文，可以考虑中间步骤写入临时文件
- Step 之间的依赖关系是隐式的，可以显式声明

---

## 范式 3: 交互对话型 — /office-hours

### 核心结构

```
Phase 1:  Context Gathering
            → 读 CLAUDE.md + TODOS.md + git log
            → AskUserQuestion 确定模式

Phase 2A: Startup Mode（6 个 Forcing Questions）
            → Q1 Demand Reality
            → Q2 Status Quo
            → Q3 Desperate Specificity
            → Q4 Narrowest Wedge
            → Q5 Observation & Surprise
            → Q6 Future-Fit
            → 按产品阶段智能路由：
              Pre-product → Q1,2,3
              Has users  → Q2,4,5
              Has paying  → Q4,5,6

Phase 2B: Builder Mode（5 个 Generative Questions）
            → 最酷版本？谁会说 whoa？最快路径？
            → 与现有差异？10x 版本？

Phase 3:  Premise Challenge
Phase 4:  Alternatives Generation（强制 2-3 个方案）
Phase 4.5: Founder Signal Synthesis
Phase 5:  Design Doc（持久化到 ~/.gstack/projects/{slug}/）
Phase 6:  Handoff — Garry's Personal Plea（三档信号强度）
```

### 七个关键设计模式

#### 1. 双模式路由

一个 skill 内根据用户类型切换完全不同的行为路径：
- **Startup Mode** — 面向创业者，问题尖锐，逼迫想清楚
- **Builder Mode** — 面向开发者，问题发散，激发创造力

#### 2. ONE AT A TIME

每个问题单独一次 `AskUserQuestion`。不是一口气抛出问题列表，而是**一个一个问，每个问题都基于前一个回答调整**。这是对话质量的关键。

#### 3. 问题三层结构

每个 Forcing Question 都有三层：
- **Ask** — 问什么
- **Push until you hear** — 什么样的回答才算"够了"
- **Red flags** — 什么样的回答说明问题没想清楚

这不是简单的问答，而是**有标准的追问**。

#### 4. 智能路由（Smart-skip）

- 产品阶段不同，问的问题不同（Pre-product / Has users / Has paying）
- 如果前面的回答已覆盖后面的问题，自动跳过

#### 5. Design Doc 持久化

产出物写入 `~/.gstack/projects/{slug}/`，支持 `Supersedes` 修订链。这意味着每次 office-hours 的结果不是一次性的，而是**项目知识的持续积累**。

#### 6. Escape Hatch

用户说 "just do it" 可以跳到方案生成阶段。尊重用户的自主权 — **如果用户已经想清楚了，不要强迫他们走完流程**。

#### 7. 商业目标融入

Phase 6 的 Garry's Personal Plea 本质是 YC 推荐机制，带三档信号强度。这说明 **skill 可以承载商业目标**，只要它自然地出现在工作流末尾，而不是打断用户。

### 启示

**适合场景**：需要深度对话的决策场景 — 产品规划、架构设计、技术选型。

**应用方向**：
- "问题三层结构"（Ask / Push / Red flags）是设计高质量交互 skill 的金标准
- 双模式路由说明一个 skill 可以服务多种用户，不必拆成多个
- Smart-skip 机制让长流程不显得啰嗦
- 持久化到 `~/.gstack/projects/` 的模式值得借鉴 — skill 产出不应该只活在聊天记录里

**可改进空间**：
- Phase 6 的商业推荐如果做得太硬会伤害用户体验，需要精心调校
- 问题路由目前是按阶段硬编码的，可以考虑更动态的路由逻辑

---

## 范式 4: CEO 审查型 — /plan-ceo-review

**750 行，gstack 最复杂的 skill。** 本质是把 CEO 级别的决策思维框架编码成 prompt。

### 核心结构

```
PRE-REVIEW SYSTEM AUDIT（代码扫描 + 设计文档检查）
  ↓
Step 0: Nuclear Scope Challenge + Mode Selection
  → 0A  Premise Challenge（问题对不对？什么都不做会怎样？）
  → 0B  Existing Code Leverage（现有代码能否复用？）
  → 0C  Dream State Mapping（12个月后理想状态）
  → 0C-bis  Implementation Alternatives（强制 2-3 方案）
  → 0D  Mode-Specific Analysis
  → 0E  Temporal Interrogation（实现时各阶段会遇到什么决策）
  → 0F  Mode Selection（4种模式，上下文相关默认值）
  ↓
11 个 Review Sections
  架构 → 错误 → 安全 → 数据流 → 代码 → 测试
  → 性能 → 可观测 → 部署 → 长期 → 设计
  ↓
Required Outputs
  NOT in scope / What already exists / Dream state delta
  Error Registry / Failure Modes / TODOS / Diagrams
```

### 四种审查模式

| 模式 | 姿态 | 仪式 |
|------|------|------|
| **SCOPE EXPANSION** | 推高目标 | Opt-in ceremony（明确同意扩大范围） |
| **SELECTIVE EXPANSION** | 持有基准 + 精选扩展 | Cherry-pick ceremony |
| **HOLD SCOPE** | 纯防守 | 不扩不缩 |
| **SCOPE REDUCTION** | 手术刀裁剪 | 精准削减 |

模式选择不是随意的 — Step 0F 会根据项目上下文推荐默认模式。**Ceremony**（仪式）的概念很关键：范围变更必须经过明确的确认流程，防止 scope creep 悄悄发生。

### 18 条认知模式（精髓）

这是整个 gstack 最有价值的部分 — 把顶级 CEO/投资人的思维模式编码成 LLM 的行为指令：

| # | 模式 | 出处 | 核心思想 |
|---|------|------|---------|
| 1 | Classification instinct | Bezos | 区分一向门/二向门决策 |
| 2 | Paranoid scanning | Grove | 偏执才能生存 |
| 3 | Inversion reflex | Munger | 反过来想，总是反过来想 |
| 4 | Focus as subtraction | Jobs | 从 350 个项目砍到 10 个 |
| 5 | People-first sequencing | Horowitz | 先想人，再想流程 |
| 6 | Speed calibration | — | 70% 信息量就够做决策了 |
| 7 | Proxy skepticism | — | 指标是否变成了自我指涉？ |
| 8 | Narrative coherence | — | 艰难决策需要清晰叙事 |
| 9 | Temporal depth | — | 用 5-10 年弧线看问题 |
| 10 | Founder-mode bias | Chesky/Graham | 创始人模式 vs 职业经理人模式 |
| 11 | Wartime awareness | — | 和平时期 vs 战争时期的不同策略 |
| 12 | Courage accumulation | — | 信心来自做过困难决策 |
| 13 | Willfulness as strategy | Altman | 意志力本身就是战略 |
| 14 | Leverage obsession | — | 小投入大产出 |
| 15 | Hierarchy as service | — | 用户先看什么？ |
| 16 | Edge case paranoia | — | 47 字符名字？零结果？ |
| 17 | Subtraction default | Rams | 最少设计原则 |
| 18 | Design for trust | — | 每个界面决策都影响信任 |

这些认知模式的注入方式值得注意：它们不是作为"提示词"出现的，而是作为**行为标准**出现的。不是说"请像 Bezos 一样思考"，而是说"对每个决策，判断它是一向门还是二向门"。

### 启示

**适合场景**：高风险、高复杂度的技术决策 — 架构重构、新产品立项、技术栈迁移。

**应用方向**：
- "认知模式注入"是一种全新的 prompt 工程技术 — 不是给 LLM 信息，而是给它**思维方式**
- Ceremony 机制（范围变更需要明确仪式）可以应用到任何有 scope creep 风险的 skill
- PRE-REVIEW 阶段先扫描代码再开始审查，确保 LLM 是基于事实而非假设在工作
- Required Outputs 的明确列表防止了"review 了但什么都没产出"

**可改进空间**：
- 750 行的单文件 skill 已经到了可维护性的边界，可以考虑拆分
- 18 条认知模式可能太多，LLM 在单次对话中难以全部运用，可以根据场景动态加载
- 部分认知模式之间有重叠（如 4 Focus as subtraction 和 17 Subtraction default）

---

## Skill 结构通用模式（跨范式）

### 1. Frontmatter — Skill 的"身份证"

每个 skill 都以结构化的 frontmatter 开头：

```yaml
name: skill-name
version: x.y.z
description: 一句话描述
allowed-tools: [Bash, Read, Edit, ...]
hooks: { ... }
benefits-from: [other-skill-1, other-skill-2]
```

`benefits-from` 是一个精妙设计 — skill 之间不是硬依赖，而是"如果有就更好"的软关联。

### 2. `{{PREAMBLE}}` — 共享启动块

所有 skill 共享的启动逻辑通过 `{{PREAMBLE}}` 模板变量注入。这是 DRY 原则在 skill 体系中的体现。

### 3. Phase/Step 线性结构

所有 skill 都遵循清晰的线性执行顺序。没有条件跳转（路由是通过选择不同的 Phase 实现的，不是 goto）。这让 skill 的行为可预测、可调试。

### 4. AskUserQuestion 规范

每次向用户提问遵循固定格式：

```
context  → 为什么问这个
question → 具体问什么
RECOMMENDATION → 推荐答案
lettered options → A/B/C 选项
```

标准化的提问格式降低了用户的认知负担。

### 5. STOP 规则

每个 section 完成后暂停，等待用户确认。**不要一口气跑完整个流程。** 这是对 LLM "急于完成"倾向的刻意约束。

### 6. 持久化产出

所有重要产出物都写入 `~/.gstack/` 目录：
- Design Doc → `~/.gstack/projects/{slug}/`
- CEO Plan → 同上
- Review Log → 同上

**Skill 的价值不只在对话中，更在对话之后。**

### 7. 下游推荐

Skill 之间通过自然语言建议流转，而非硬编码调用。例如 `/review` 完成后可能建议"考虑运行 `/plan-ceo-review` 做更深入的架构审查"。松耦合。

### 8. Completion Status

三种结束状态：
- **DONE** — 完成
- **DONE_WITH_CONCERNS** — 完成但有担忧
- **NEEDS_CONTEXT** — 信息不足，无法完成

这让调用方（人或其他 skill）能快速判断结果。

### 9. Important Rules 尾部

每个 skill 末尾都有一段 "Important Rules"，重申最关键的约束。这不是冗余 — LLM 对 prompt 末尾的内容有更强的注意力（recency bias），所以**把最重要的规则放在最后**是刻意的工程选择。

---

## 总结：四种范式的选择指南

| 你要解决的问题 | 选择范式 | 理由 |
|---------------|---------|------|
| 防止 AI 做危险操作 | 行为约束型 | Hook 拦截比自然语言约束可靠 |
| 标准化的多步骤工作流 | 多阶段工作流型 | Step 结构清晰，可渐进演化 |
| 需要深度对话的决策 | 交互对话型 | 问题三层结构保证对话质量 |
| 高风险复杂决策 | CEO 审查型 | 认知模式注入提升决策质量 |

四种范式不互斥。实际项目中最强大的 skill 往往**组合多种范式**：用 Hook 做安全护栏（范式 1），用 Step 结构组织流程（范式 2），在关键决策点用深度对话（范式 3），注入认知框架提升决策质量（范式 4）。
