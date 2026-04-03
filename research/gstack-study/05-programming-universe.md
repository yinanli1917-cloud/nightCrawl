# 编程世界的完整地图

> 从零开始，不跳步骤，不带前置知识。

---

## 第一章：电脑只懂一种东西

电脑的 CPU 只能执行**机器码**——一串 0 和 1 组成的指令。每种 CPU 有自己的机器码格式：

- Apple Silicon（M1/M2/M3/M4）的机器码叫 ARM64
- Intel/AMD 的机器码叫 x86_64

机器码长这样（十六进制表示，本质是二进制）：

```
48 89 e5 48 83 ec 10 c7 45 fc 05 00 00 00
```

没有人直接写机器码。太痛苦了。所以人类发明了编程语言。

---

## 第二章：编程语言是什么

编程语言是**人类写的文字**，通过某种方式**翻译成机器码**让 CPU 执行。

所有编程语言做的事都一样：让你用人能读懂的文字，告诉电脑做什么。区别在于：
- 文字的语法规则不同
- 翻译成机器码的方式不同
- 擅长的领域不同

---

## 第三章：两种翻译方式

### 方式一：编译（Compile）

**写完全部代码 → 一次性翻译成机器码 → 生成一个可执行文件 → 以后直接运行这个文件**

```
源码（人写的）    编译器（翻译官）    二进制文件（机器码）
main.swift    →   swiftc        →    MyApp
main.c        →   gcc           →    myprogram
main.rs       →   rustc         →    mytool
main.go       →   go build      →    myserver
```

编译后的二进制文件可以直接运行，不再需要编译器，也不需要任何额外程序。你双击一个 macOS app，实际上就是在运行里面的编译好的二进制文件。

**优点**：运行速度快，分发简单（给别人一个文件就行）
**缺点**：每次改代码都要重新编译，编译本身需要时间

### 方式二：解释（Interpret）

**写完代码 → 每次运行时，由另一个程序逐行读取、逐行翻译、逐行执行**

```
源码（人写的）    运行时（现场翻译官）
script.py     →   python              → 边读边执行
app.js        →   node 或 bun          → 边读边执行
script.rb     →   ruby                → 边读边执行
```

没有"编译"这个步骤。代码写完直接交给运行时执行。但**每次运行都需要运行时在场**。没有 python 程序，`.py` 文件就是一堆没人能执行的文字。

**优点**：改完代码立即能跑，不用等编译
**缺点**：运行速度稍慢，分发时对方也必须安装运行时

### 运行时（Runtime）是什么

运行时就是上面说的"现场翻译官"。它本身是一个编译好的二进制程序。它的功能是：读取某种语言的源码文件，翻译成机器码并执行。

```
python  = Python 语言的运行时（编译好的二进制程序，用 C 语言写的）
node    = JavaScript 语言的运行时（编译好的二进制程序，用 C++ 写的）
bun     = JavaScript/TypeScript 语言的运行时（编译好的二进制程序，用 Zig 语言写的）
ruby    = Ruby 语言的运行时（编译好的二进制程序，用 C 语言写的）
```

运行时之间的关系：**node 和 bun 都是 JavaScript 的运行时**，功能类似，实现不同。就像两个不同的翻译官都能翻译英语，但翻译速度和风格不同。bun 比 node 新，启动更快，内置功能更多。

---

## 第四章：编程语言家谱

### 编译型语言（写完编译，生成二进制）

| 语言 | 发明年份 | 主要用途 | 谁在用 |
|------|---------|---------|--------|
| **C** | 1972 | 操作系统、硬件驱动、运行时本身 | Linux 内核、Python 运行时 |
| **C++** | 1979 | 游戏引擎、浏览器、数据库 | Chrome、Node.js 运行时 |
| **Swift** | 2014 | macOS / iOS app | 你的 MusicMiniPlayer |
| **Go** | 2009 | 服务器、CLI 工具 | Docker、Kubernetes |
| **Rust** | 2010 | 高性能系统工具 | Firefox 部分组件 |

### 解释型语言（需要运行时执行）

| 语言 | 发明年份 | 运行时 | 主要用途 | 谁在用 |
|------|---------|--------|---------|--------|
| **Python** | 1991 | python | 脚本、数据科学、AI | 你的工具脚本 |
| **JavaScript** | 1995 | node / bun / 浏览器 | 网页、服务器、工具 | gstack |
| **TypeScript** | 2012 | node / bun（先转成 JS） | JavaScript 的增强版 | gstack |
| **Ruby** | 1995 | ruby | 网站后端 | GitHub、Shopify |

### 特殊类别：Shell 脚本语言

| 语言 | 运行时 | 用途 |
|------|--------|------|
| **Bash 脚本** | bash | 编排命令 |
| **Zsh 脚本** | zsh | 编排命令 |

Shell 脚本语言和上面的编程语言**不是同一层的东西**。下一章解释。

---

## 第五章：Shell 是什么

### 终端（Terminal）

终端是一个 **app**。你在 Mac 上打开"终端"或 iTerm 或 Warp，就是打开了一个终端 app。终端 app 做的事很简单：

1. 显示一个文本窗口
2. 把你输入的文字发给 shell 程序
3. 把 shell 程序的输出显示在窗口里

终端本身不理解任何命令。它只是一个"文字窗口"。

### Shell

Shell 是终端背后**实际处理你输入的程序**。当你打开终端，操作系统自动启动一个 shell 进程。shell 做三件事：

1. 等待你输入一行文字
2. 解析这行文字，找到对应的程序，启动它
3. 显示结果，回到第 1 步

```
你在终端输入：ls -la
         ↓
终端 app 把这串文字发给 shell
         ↓
Shell 解析：
  命令名 = "ls"
  参数 = "-la"
         ↓
Shell 在 PATH 目录列表中查找 "ls" 程序
  → 在 /bin/ 目录下找到了
         ↓
Shell 启动 /bin/ls 进程，传入参数 "-la"
         ↓
ls 执行完毕，输出文件列表
         ↓
Shell 把输出显示在终端
         ↓
Shell 等待你的下一条输入
```

### Shell 的种类

Shell 有很多种，都是独立的程序：

| Shell | 文件位置 | 历史 |
|-------|---------|------|
| **sh** | /bin/sh | 1979，最原始的 shell |
| **bash** | /bin/bash | 1989，sh 的增强版，Linux 默认 |
| **zsh** | /bin/zsh | 1990，bash 的再增强版，macOS 默认（2019 年起）|
| **fish** | /usr/local/bin/fish | 2005，语法更友好 |

你的 Mac 用的是 **zsh**。但人们习惯性地把"在终端里输入命令"这件事叫做"用 bash"或"跑 bash 命令"，即使实际跑的是 zsh。Claude Code 的 Bash tool 也是这种习惯命名——实际上它可能在用你的 zsh。

### Shell 脚本

Shell 不只能一条一条输入命令，还能把多条命令写在一个文件里，一次性执行。这个文件就叫 **shell 脚本**：

```bash
#!/bin/bash
echo "开始备份"
cp -r ~/Documents ~/backup/
echo "备份完成"
```

Shell 脚本能做的事：
- 按顺序执行多个命令
- 简单的判断（如果文件存在就……）
- 简单的循环（对每个文件做……）
- 调用其他程序

Shell 脚本**不能**做的事：
- 写 HTTP 服务器
- 操作数据库
- 做复杂的数据处理
- 构建用户界面
- 控制浏览器

这些"不能做的事"需要真正的编程语言（Python、JavaScript、Swift 等）。

---

## 第六章：JavaScript 的故事

### 起源：浏览器里的语言

1995 年，Netscape（第一个主流浏览器公司）需要一种语言让网页能动起来——按钮能点击、表单能验证、页面能变化。Brendan Eich 用 10 天写出了 JavaScript。

**最初 JavaScript 只能在浏览器里运行。** 每个浏览器内置了一个 JavaScript 运行时（也叫引擎）：

| 浏览器 | JS 引擎名称 |
|--------|-----------|
| Chrome | V8 |
| Safari | JavaScriptCore |
| Firefox | SpiderMonkey |

当你打开一个网页，浏览器做两件事：
1. 渲染 HTML/CSS（页面的结构和样式）
2. 执行 JavaScript（页面的行为和交互）

### 2009：JavaScript 逃出浏览器

Ryan Dahl 把 Chrome 的 V8 引擎**单独拿出来**，包了一层文件系统和网络功能，做成了 **Node.js**。

这意味着 JavaScript 不再需要浏览器就能运行。你可以在终端里执行：

```
node server.js
```

Node.js 让 JavaScript 能做以前只有 Python、Ruby、Java 能做的事：写服务器、操作文件、连接数据库。

### 2012：TypeScript 出现

JavaScript 有一个问题：变量没有类型。你可以把一个数字赋给一个变量，下一行又把一个字符串赋给它，不会报错。代码写多了以后，bug 很难找。

微软发明了 **TypeScript**，在 JavaScript 基础上加了类型系统：

```javascript
// JavaScript — 不会报错，但运行时可能出问题
let x = 5;
x = "hello";  // 合法但危险

// TypeScript — 写代码时就报错
let x: number = 5;
x = "hello";  // 编辑器立刻标红：不能把字符串赋给数字
```

TypeScript 不能直接运行——需要先**转译**成 JavaScript，再由运行时执行。Node.js 需要一个额外步骤来做这个转译。Bun 内置了这个功能，可以直接运行 TypeScript 文件。

### 2021：Bun 出现

Jarred Sumner 觉得 Node.js 太慢了，从头写了一个新的 JavaScript/TypeScript 运行时，叫 **Bun**。

Node.js 和 Bun 的关系：

```
Python 只有一个运行时：python
Ruby 只有一个运行时：ruby
JavaScript/TypeScript 有多个运行时：
  → Node.js（2009，老牌，生态最大）
  → Bun（2021，新锐，速度更快）
  → Deno（2018，Node.js 作者的重做版）
```

gstack 选 Bun 不选 Node.js 的原因（前面解释过）：能编译成单一二进制、内置 SQLite、能直接跑 TypeScript。

---

## 第七章：所有"script"后缀的区别

你困惑的核心：JavaScript、TypeScript、Shell Script 名字里都有 "script"，但它们是完全不同的东西。

"Script"这个词的本意是**脚本**——一组按顺序执行的指令。早期编程语言分两派：

- **"正经"语言**（C、Java）：需要编译，写起来繁琐，用于大型项目
- **"脚本"语言**（Shell、Perl、Python、JavaScript）：不需要编译，写起来快，用于小任务

后来脚本语言越来越强大，Python 和 JavaScript 早就能写大型项目了，但名字里的 "script" 沿用至今。

| 名称 | 文件后缀 | 运行时 | 能力级别 |
|------|---------|--------|---------|
| **Shell script** | `.sh` | bash / zsh | 低——只能编排命令和做简单文本处理 |
| **JavaScript** | `.js` | node / bun / 浏览器 | 高——完整的编程语言 |
| **TypeScript** | `.ts` | node / bun | 高——JavaScript 加类型 |
| **Python** | `.py` | python | 高——完整的编程语言 |
| **AppleScript** | `.scpt` | osascript | 低——只能控制 macOS app |

Shell script 和 JavaScript 的关系，就像计算器和 Excel 的关系——都能算数，但能力差了几个量级。名字里都有"算"不代表是同一个东西。

---

## 第八章：完整的层次关系

从底到顶：

```
┌─────────────────────────────────────────────────────┐
│  硬件层：CPU（Apple Silicon M4）                       │
│  只懂 ARM64 机器码（0 和 1）                           │
└─────────────────────────┬───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│  操作系统层：macOS（基于 Darwin，Darwin 基于 Unix）      │
│  管理进程、内存、文件系统、网络、权限                      │
│  提供系统调用（程序通过系统调用请求操作系统做事）            │
└─────────────────────────┬───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│  Shell 层：zsh                                        │
│  接收文字命令，启动程序                                  │
│  Shell 脚本 = 用 zsh 语法写的简单命令编排                │
└─────────────────────────┬───────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ 编译好的程序   │  │ 运行时        │  │ 运行时        │
│ ls, git,     │  │ python       │  │ bun / node   │
│ browse(CLI), │  │              │  │              │
│ swift 编译产物 │  │ 执行 .py 文件 │  │ 执行 .ts/.js │
└──────────────┘  └──────┬───────┘  └──────┬───────┘
                         │                 │
                  ┌──────▼───────┐  ┌──────▼───────┐
                  │ Python 代码   │  │ TypeScript   │
                  │ scan.py      │  │ server.ts    │
                  │ 你的工具脚本  │  │ gstack 的    │
                  │              │  │ daemon 服务器 │
                  └──────────────┘  └──────────────┘
```

所有程序——无论是编译好的二进制、Python 脚本、TypeScript 服务器——最终都通过操作系统的系统调用变成 CPU 能执行的机器码。区别只在于翻译发生在什么时候（编译时 vs 运行时）和由谁来翻译（编译器 vs 运行时）。

---

## 第九章：gstack 在这张地图上的位置

```
你说 "去看一下 x.com"
      ↓
Claude Code AI（运行在 Anthropic 服务器上的大模型）
      ↓ 生成 bash 命令
Shell (zsh) 解析命令
      ↓ 启动
browse CLI（Bun 编译的二进制，不需要运行时）
      ↓ 需要启动 daemon 时
Bun 运行时（执行 TypeScript 源码 server.ts）
      ↓ server.ts 调用 Playwright 库
Playwright（Node.js/Bun 库，用 TypeScript 写的）
      ↓ 通过 CDP 协议控制
Chromium（浏览器，C++ 写的编译好的二进制）
      ↓ 发起网络请求
x.com 服务器返回网页
      ↓ Chromium 渲染
页面内容通过反方向传回 → AI 看到结果
```

涉及的编程语言：
- **TypeScript**：gstack 的 CLI 和 daemon 源码
- **C++**：Chromium 浏览器本身
- **Python**：你的 naTure 项目里的扫描脚本
- **Shell 脚本**：Claude Code 发出的命令、你的一些自动化脚本
- **Swift**：你的其他项目（MusicMiniPlayer）

---

## 第十章：你需要记住的

1. **编程语言**是人写的文字，最终都变成 CPU 能执行的 0 和 1。区别只在于翻译的时机和方式。

2. **Shell**（bash/zsh）是命令调度员，不是编程语言。Shell 脚本能编排命令，但做不了复杂的事。

3. **运行时**（python/node/bun）是"现场翻译官"，让解释型语言的代码能执行。运行时本身是编译好的二进制程序。

4. **JavaScript 和 Shell 没有任何关系。** 名字里都有 "script" 是历史原因。JavaScript 是完整的编程语言，Shell script 只是命令编排。

5. **Node.js 和 Bun 是同一个东西的两个版本**——都是 JavaScript/TypeScript 的运行时，能力相同，实现不同。

6. 你写 **Swift**（编译型）和 **Python**（解释型），这两种你已经会了。JavaScript/TypeScript 你不需要写——gstack 已经帮你写好了，你只需要知道它是什么就行。
