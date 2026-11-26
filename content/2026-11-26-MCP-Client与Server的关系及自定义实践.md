---
title: MCP Client 与 Server 是什么关系？从零写一个自己的 Server
date: 2026-11-26
category: 技术调研
summary: 一个 Host 为一个 Server 配一个 Client，两者靠 JSON-RPC 2.0 说话；再用官方 SDK 走一遍从建环境到接入客户端的完整流程。
tags: MCP, Client, Server, SDK, 技术调研
embed: embed/mcp-client-server.html
embed-title: Client 与 Server 关系及构建流程图解
embed-label: 图 1 · 五张图看懂关系与构建（可缩放 / 可拖拽）
embed-height: 820
---

上一篇用 KuroCat 讲了 MCP 能干什么。这篇往下钻一层，回答两个更具体的问题：Client 和 Server 到底怎么分工、什么关系；以及如果想自己写一个 Server，从零开始要做哪些事。

## 先把三个角色分开

很多人把 Client 和 Server 理解成「两个程序对聊」，其实中间还隔着一个角色。官方的定义是三个：

- **Host**：你实际使用的 AI 应用，比如 WorkBuddy、Claude Desktop、VS Code。它负责协调一个或多个 Client。
- **Client**：Host 内部的一个组件，专门维护与某个 Server 的连接，从 Server 拿到上下文交给 Host 用。
- **Server**：提供能力和数据的程序。它可以在本机，也可以在远程——MCP 看的是「谁提供 context」，不看它跑在哪里。

所以严格说，**Client 不是一个你能单独打开的软件**，它是 Host 的一部分。你在客户端配置里写的那个 `kurocat`，是 Host 为这个 Server 创建出来的 Client 实例的名字。

这个区分很实用：排查问题时，如果 Server 状态灯是红的，问题在 Server 或连接配置；如果 Host 根本不认识这个工具，问题在 Client 侧有没有正确加载。

## Client 和 Server 是什么关系

一句话：**Host 每接一个 Server，就创建一个 Client；每个 Client 和对应 Server 之间是一条专属连接（dedicated connection）。**

从连接的角度看是 1:1，但别把它理解成「一个 Server 只能服务一个人」：

- 用 **stdio** 的本地 Server，通常只服务一个 Client——它是一个子进程，跟启动它的 Host 绑在一起；
- 用 **Streamable HTTP** 的远程 Server，通常可以同时服务很多 Client——本质就是一个能被多方访问的服务。

打个比方：Host 像手机，Client 像手机上的 App，Server 像提供服务的服务器。一个 App 连一个服务，但同一台服务器可以被很多 App 访问。「一对一」说的是那条连接，不是 Server 的容量。

## 它们之间怎么说话

MCP 分成两层，这个分层是理解它的关键：

**Data layer（内层）** 定义「说什么」。它用 JSON-RPC 2.0 规定消息结构，包括能力发现、版本协商，以及三类核心能力：Tools、Resources、Prompts。

**Transport layer（外层）** 定义「怎么送」。它管连接建立、消息分帧、鉴权，目前主要是两种传输：

| 传输 | 怎么通信 | 典型场景 |
|---|---|---|
| stdio | 标准输入输出，本机进程间直连 | 本地 Server，无网络开销，最通用 |
| Streamable HTTP | HTTP POST + 可选 SSE 流式返回 | 远程 Server，支持鉴权、多客户端 |

换传输方式，JSON-RPC 消息内容不变。这正是同一份 Server 代码既能本地跑、又能挂到网上的原因。

一次典型的工具调用是四个动作：

1. Client 发 `tools/list`，问「你有哪些工具」；
2. Server 返回工具清单，包括名字、说明和入参规范；
3. Host 把清单交给模型，模型选中一个，Client 发 `tools/call` 带参数调用；
4. Server 执行、返回结果。

注意第 2 步是先问再做。模型不是靠猜参数名调用工具的，这也解释了为什么写一个好工具时 `description` 和类型注解很重要——它们是模型判断「该不该用、参数怎么填」的唯一依据。

## 从 0 到 1：自己写一个 Server

下面用官方 **Python SDK** 走一遍。版本要求是当前值：**Python 3.11+，MCP SDK 2.0+**。网上很多老教程用的是旧版 `FastMCP` 写法，照抄容易踩坑，建议以官方文档为准。

**第一步，建环境。**

```bash
uv add "mcp[cli]"
```

`[cli]` 会额外装上 `mcp` 命令行工具，后面调试要用。不用 uv 的话 `pip install "mcp[cli]"` 也行。

**第二步到第三步，写实例和工具。**

新建 `server.py`：

```python
from mcp.server import MCPServer

mcp = MCPServer("Demo")


@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers."""
    return a + b


@mcp.resource("greeting://{name}")
def greeting(name: str) -> str:
    """Greet someone by name."""
    return f"Hello, {name}!"
```

这就是一个完整的 Server：一个工具、一个带参数的资源。你会发现没写 JSON Schema、没写请求解析、没写协议处理——**类型注解 `a: int, b: int` 就是入参规范，docstring 就是给模型看的工具说明**，这些 SDK 会自动生成。

**第四步，跑起来。**

```python
if __name__ == "__main__":
    mcp.run(transport="stdio")
```

想用 HTTP，把传输换成 `streamable-http`，或者直接用命令行：

```bash
uv run mcp run server.py --transport streamable-http
```

**这里有一个必须记住的坑**：stdio 模式下，**绝对不要 `print` 到标准输出**。stdout 是 JSON-RPC 消息走的通道，一个 `print` 就把协议打乱了，症状是客户端连得上但调用全失败。日志要用 `logging` 写 stderr；TypeScript 版同理，用 `console.error()` 而不是 `console.log()`。

**第五步，先调试再接入。**

```bash
uv run mcp dev server.py
```

这会打开官方的 MCP Inspector，能直接看到工具清单、手动填参数调用、看返回结果。别跳过这一步——在 Inspector 里能跑通，接进客户端才不会两头排查。

**第六步，接进 AI 客户端。**

在 WorkBuddy 的「插件 → MCP 服务器 → 配置 MCP」里加：

```json
{
  "mcpServers": {
    "demo": {
      "command": "uv",
      "args": ["--directory", "/绝对路径/到/项目目录", "run", "server.py"]
    }
  }
}
```

如果 Server 已经以 HTTP 方式跑起来了，就换成：

```json
{
  "mcpServers": {
    "demo": {
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

保存后看状态灯：绿色就能用了。到这里，Host 会为这个 Server 创建一个 Client，走完发现流程，把 `add` 这个工具交给模型——你问「3 加 5 等于几」，模型就可能自己决定去调它。

## 一个 Server 该暴露什么

MCP 定义了三类能力，各有一对「发现 + 使用」的方法：

| 能力 | 是什么 | 方法 | 谁触发 |
|---|---|---|---|
| Tools | 可调用的函数，会产生副作用 | `tools/list` → `tools/call` | 模型决定调用 |
| Resources | 可读的上下文数据，用 URI 标识 | `resources/list` → `resources/read` | 客户端按需读取 |
| Prompts | 可复用的交互模板 | `prompts/list` → `prompts/get` | 通常由用户选择 |

写一个 Server 不必三种全做。官方那个天气教程就只做了两个 tools，照样是完整可用的 Server。先从工具做起，需要给模型喂背景数据时再加 Resources。

**能力清单同时也是权限清单。** 接入别人的 Server 之前先看它暴露了什么，你立刻知道 AI 最多能做什么、改动范围有多大；自己写的时候也只暴露必要的工具——这不是功能多少的问题，是安全边界。

## 小结

回到开头两个问题：

**Client 和 Server 什么关系？** Host 为每个 Server 建一个 Client，二者之间是专属连接，用 JSON-RPC 2.0 通信；换传输方式不影响消息格式。本地通常一对一，远程可以一对多。

**怎么从零写 Server？** 建环境 → 建实例 → 用类型注解和 docstring 写工具 → 选 stdio 或 HTTP 跑起来 → 用 Inspector 调试 → 写进客户端配置。真正需要你写的只有「做什么」，协议那部分交给 SDK。

如果只想记住一条实践建议：**先写工具、先跑 Inspector**。把「能被调用」这件事验证清楚，再考虑接进哪个客户端。
