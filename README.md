# Claude Roam

[English](#english) | [中文](#中文)

---

## English

Session history roaming sync tool for Claude Code - Sync, merge, and manage massive Claude Code conversation histories across multiple machines.

### Why Claude Roam?

Claude Code sessions are bound to specific directories. When you want to:
- **Continue a conversation from another machine** (e.g., started on desktop, continue on laptop)
- **Resume a session in a different directory** (e.g., project moved or renamed)
- **Preserve complete conversation history** for knowledge accumulation and analysis
- **Browse and search through massive session histories** with thousands of messages

Claude Roam solves this by syncing sessions to the cloud and letting you **pull and resume them anywhere**, while providing tools to **manage and analyze large-scale conversation data**.

### Key Feature: Resume Sessions Anywhere

```bash
# On Machine A: working on project
cd ~/projects/my-app
claude  # Start a conversation, Claude learns your codebase

# Later, on Machine B: want to continue the conversation
cd ~/work/my-app              # Different path, same project
claude-roam map add "machine-a:~/projects/my-app"
claude-roam pull
claude --resume <session-id>  # Continue with full context!
```

The magic: `claude --resume` works because Claude Roam pulls the session into the correct local Claude directory. Claude Code sees it as a local session and resumes with full conversation history.

### Live Demo
https://github.com/user-attachments/assets/b5e0bfea-5ceb-4cba-9aba-c159bd6d55c4



### Core Concepts

#### Complete History Preservation

Unlike ephemeral chat interfaces, Claude Roam preserves your **complete conversation history**:

- **Merge, Not Replace**: Sessions from multiple machines are merged, keeping all history intact
- **Line-Level Tracking**: Know which machine contributed each part of the conversation
- **Conversation Trees**: Visualize branching conversations with tree separators
- **No Data Loss**: Every tool call, result, and message is preserved

#### Desktop App & Massive Conversation Management

Claude Roam includes a native **Tauri 2 desktop app** built to handle **extremely large sessions** (10,000+ messages):

- **Native Desktop App**: Lightweight (~6MB) Tauri 2 app with Rust backend and SQLite
- **Virtual Scrolling**: Only visible messages are rendered, enabling smooth navigation
- **MiniMap with Filters**: Visual overview with clickable color filters by message type
- **MiniMap Tooltips**: Hover over color bars for message type and count details
- **Type Navigation**: Jump between same-type messages (human/assistant/tool) with prev/next arrows
- **Token Usage Stats**: Per-session token consumption (input, output, cache read/creation)
- **Session List Filter & Sort**: Filter sessions by keyword, sort by time, size, or message count
- **Responsive Layout**: Header gracefully adapts to narrow widths, prioritizing actions over timestamps
- **Raw JSON Mode**: Inspect original unparsed message structure for debugging
- **Import/Export**: Load and save `.roam` files directly from the app
- **Search & Navigate**: Find any message in massive histories with instant search

#### Knowledge Accumulation

Your conversations with Claude are valuable knowledge assets:

- **Searchable Archive**: Full-text search across all synced sessions
- **Export/Import**: Portable `.roam` files for backup and sharing
- **Offline Preview**: Browse sessions locally without a server
- **Ready for Analysis**: Structured data format for future AI-powered insights

### Features

- **Cross-Machine Sync**: Resume sessions started on any machine
- **History Merging**: Combine sessions from multiple sources
- **Directory Mapping**: Map local paths to cloud directories for seamless sync
- **Auto Sync (Daemon)**: Background process monitors and uploads changes
- **Native Desktop App**: Tauri 2 desktop viewer (~6MB) with Rust backend
- **Large File Support**: Handle sessions with 10,000+ messages smoothly
- **Virtual Scrolling**: Full-screen conversation view with smooth navigation
- **MiniMap with Filters**: Visual overview with message type color filters and hover tooltips
- **Type Navigation**: Jump between same-type messages with prev/next arrows
- **Token Usage Stats**: Per-session token consumption breakdown (input, output, cache)
- **Session List Filter & Sort**: Filter by keyword, sort by time/size/message count
- **Responsive Layout**: Adaptive header that prioritizes actions over timestamps
- **Raw JSON Mode**: Inspect original message structure for debugging
- **Export/Import**: Portable `.roam` files, import/export from desktop app
- **Line-Level Tracking**: Know which machine contributed each part
- **Cross-Platform**: macOS, Linux, WSL2, Windows

### Quick Start

#### 1. Install

```bash
# macOS (Apple Silicon)
curl -L -o claude-roam https://github.com/user/claude-roam/releases/latest/download/claude-roam-darwin-arm64
chmod +x claude-roam && sudo mv claude-roam /usr/local/bin/

# macOS (Intel)
curl -L -o claude-roam https://github.com/user/claude-roam/releases/latest/download/claude-roam-darwin-x64
chmod +x claude-roam && sudo mv claude-roam /usr/local/bin/

# Linux (x64)
curl -L -o claude-roam https://github.com/user/claude-roam/releases/latest/download/claude-roam-linux-x64
chmod +x claude-roam && sudo mv claude-roam /usr/local/bin/

# Windows - download claude-roam-windows-x64.exe
```

#### 2. Configure & Login

```bash
export ROAM_API=https://your-server.com  # Add to your shell profile
claude-roam login                         # Login with GitHub
```

#### 3. Start Syncing

```bash
claude-roam daemon  # Run in background, auto-syncs all sessions
```

#### 4. Resume on Another Machine

```bash
cd /path/to/project
claude-roam list -g                              # View available cloud directories
claude-roam map add "machine-a:/original/path"   # Map to cloud directory
claude-roam pull                                 # Pull all sessions
claude --resume <session-id>                     # Resume conversation!
```

### Common Workflows

#### Workflow 1: Continue Work on Another Machine

```bash
# Machine B wants to continue Machine A's session
claude-roam list -g                              # Find the cloud directory
claude-roam map add "alice-mac:/Users/alice/project"
claude-roam pull
claude --resume abc123                           # Resume with full context
```

#### Workflow 2: Project Directory Changed

```bash
# Project moved from ~/old/path to ~/new/path
cd ~/new/path
claude-roam map add "my-mac:~/old/path"          # Map to original cloud dir
claude-roam pull                                 # Get all old sessions
claude --resume                                  # Continue where you left off
```

#### Workflow 3: Browse & Analyze Sessions with Desktop App

```bash
claude-roam preview              # Launch the Tauri desktop app
# Use MiniMap to navigate, filter by message type, search through thousands of messages
# Import/export .roam files directly from the app
```

### Command Reference

| Command | Description |
|---------|-------------|
| `claude-roam daemon` | Start background sync daemon |
| `claude-roam push` | Upload sessions to cloud |
| `claude-roam pull` | Download sessions from cloud |
| `claude-roam list` | List remote sessions |
| `claude-roam list -g` | List grouped by cloud directory |
| `claude-roam map add <dir>` | Map current directory to cloud directory |
| `claude-roam map list` | Show all directory mappings |
| `claude-roam preview` | Launch desktop app to browse sessions |
| `claude-roam export` | Export to .roam file |
| `claude-roam import` | Import from .roam file |
| `claude-roam status` | Check sync status |
| `claude-roam login` | Login with GitHub |

### How It Works

```
┌─────────────────┐     push      ┌─────────────────┐
│   Machine A     │ ───────────▶  │   Cloud Server  │
│ ~/projects/foo  │               │                 │
└─────────────────┘               │  Sessions DB    │
                                  │  (merged)       │
┌─────────────────┐     pull      │                 │
│   Machine B     │ ◀───────────  │  Complete       │
│ ~/work/foo      │               │  History        │
└─────────────────┘               └─────────────────┘
        │
        ▼
  claude --resume <id>  ✓ Works!
```

1. **Push**: Sessions are uploaded with machine name + path as "cloud directory"
2. **Merge**: Multiple pushes are merged, preserving complete history
3. **Map**: Link your local directory to a cloud directory
4. **Pull**: Download merged sessions into Claude's local storage (`~/.claude/projects/`)
5. **Resume**: `claude --resume` finds the session and continues

### Self-Hosting

#### Docker Compose

```bash
cd docker
cp .env.example .env
# Edit .env: set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET

docker-compose up -d
```

#### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `ROAM_API` | Server API URL | Yes |
| `ROAM_MACHINE_NAME` | Machine name (default: hostname) | No |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID | Server |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | Server |

### Development

```bash
# Backend (Python + FastAPI)
cd server && uv sync && uv run uvicorn app.main:app --reload

# CLI (Bun + TypeScript)
cd cli && bun install && bun run dev <command>

# Frontend (React + Vite)
cd web && pnpm install && pnpm dev
```

### License

MIT

---

## 中文

Claude Code 会话漫游同步工具 - 跨机器同步、合并和管理海量 Claude Code 对话历史。

### 为什么需要 Claude Roam？

Claude Code 的会话与特定目录绑定。当你想要：
- **在另一台机器继续对话**（如：在台式机开始，在笔记本继续）
- **在不同目录恢复会话**（如：项目移动或重命名后）
- **保留完整对话历史**，为知识沉淀和分析做准备
- **浏览和搜索海量会话记录**（数千条消息）

Claude Roam 通过同步会话到云端，让你可以**在任何地方拉取并恢复会话**，同时提供工具来**管理和分析大规模对话数据**。

### 核心功能：随处恢复会话

```bash
# 机器 A：在项目中工作
cd ~/projects/my-app
claude  # 开始对话，Claude 学习你的代码库

# 稍后，在机器 B：想继续这个对话
cd ~/work/my-app              # 不同路径，同一项目
claude-roam map add "machine-a:~/projects/my-app"
claude-roam pull
claude --resume <session-id>  # 带着完整上下文继续！
```

原理：`claude --resume` 能工作是因为 Claude Roam 把会话拉取到了正确的本地 Claude 目录。Claude Code 把它当作本地会话，可以恢复完整的对话历史。

### 核心理念

#### 完整历史保留

不同于临时的聊天界面，Claude Roam 保留你的**完整对话历史**：

- **合并而非替换**：来自多台机器的会话被合并，保留所有历史
- **行级来源追踪**：知道对话的每一部分来自哪台机器
- **对话树可视化**：用分隔符展示分支对话结构
- **零数据丢失**：每个工具调用、结果和消息都被保留

#### 桌面应用 & 海量对话管理

Claude Roam 包含原生 **Tauri 2 桌面应用**，专为处理**超大会话**（10,000+ 条消息）而设计：

- **原生桌面应用**：轻量级（~6MB）Tauri 2 应用，Rust 后端 + SQLite
- **虚拟滚动**：只渲染可见消息，实现丝滑导航
- **MiniMap 筛选**：可视化概览，支持按消息类型颜色筛选
- **MiniMap 悬停提示**：鼠标悬停色块显示消息类型和数量
- **类型导航**：通过上下箭头在同类型消息间快速跳转
- **Token 用量统计**：每会话 Token 消耗分析（输入/输出/缓存读取/缓存创建）
- **会话列表筛选排序**：按关键词筛选，按时间/大小/消息数排序
- **响应式布局**：表头自适应窄宽度，优先显示操作按钮
- **Raw JSON 模式**：查看原始未解析的消息结构，方便调试
- **导入/导出**：直接从桌面应用加载和保存 `.roam` 文件
- **搜索与定位**：在海量历史中即时搜索任意消息

#### 知识沉淀

你与 Claude 的对话是宝贵的知识资产：

- **可搜索档案**：全文搜索所有同步的会话
- **导出/导入**：便携式 `.roam` 文件，用于备份和分享
- **离线预览**：无需服务器，本地浏览会话
- **为分析准备**：结构化数据格式，为未来 AI 驱动的洞察做准备

### 功能特性

- **跨机器同步**：恢复在任何机器上开始的会话
- **历史合并**：合并来自多个来源的会话
- **目录映射**：将本地路径映射到云端目录，实现无缝同步
- **自动同步 (Daemon)**：后台进程监控并上传变更
- **原生桌面应用**：Tauri 2 桌面查看器（~6MB），Rust 后端
- **大文件支持**：流畅处理 10,000+ 条消息的会话
- **虚拟滚动**：全屏对话视图，丝滑导航
- **MiniMap 筛选**：可视化概览，支持消息类型颜色筛选和悬停提示
- **类型导航**：通过箭头在同类型消息间快速跳转
- **Token 用量统计**：每会话 Token 消耗分析（输入/输出/缓存）
- **会话列表筛选排序**：按关键词筛选，按时间/大小/消息数排序
- **响应式布局**：自适应表头，优先显示操作按钮
- **Raw JSON 模式**：查看原始消息结构，方便调试
- **导出/导入**：便携式 `.roam` 文件，支持桌面应用内导入导出
- **行级来源追踪**：知道哪部分来自哪台机器
- **跨平台**：macOS、Linux、WSL2、Windows

### 快速开始

#### 1. 安装

```bash
# macOS (Apple Silicon)
curl -L -o claude-roam https://github.com/user/claude-roam/releases/latest/download/claude-roam-darwin-arm64
chmod +x claude-roam && sudo mv claude-roam /usr/local/bin/

# macOS (Intel)
curl -L -o claude-roam https://github.com/user/claude-roam/releases/latest/download/claude-roam-darwin-x64
chmod +x claude-roam && sudo mv claude-roam /usr/local/bin/

# Linux (x64)
curl -L -o claude-roam https://github.com/user/claude-roam/releases/latest/download/claude-roam-linux-x64
chmod +x claude-roam && sudo mv claude-roam /usr/local/bin/

# Windows - 下载 claude-roam-windows-x64.exe
```

#### 2. 配置和登录

```bash
export ROAM_API=https://your-server.com  # 添加到 shell 配置文件
claude-roam login                         # 使用 GitHub 登录
```

#### 3. 开始同步

```bash
claude-roam daemon  # 后台运行，自动同步所有会话
```

#### 4. 在另一台机器恢复

```bash
cd /path/to/project
claude-roam list -g                              # 查看可用的云端目录
claude-roam map add "machine-a:/original/path"   # 映射到云端目录
claude-roam pull                                 # 拉取所有会话
claude --resume <session-id>                     # 恢复对话！
```

### 常见场景

#### 场景 1：在另一台机器继续工作

```bash
# 机器 B 想继续机器 A 的会话
claude-roam list -g                              # 找到云端目录
claude-roam map add "alice-mac:/Users/alice/project"
claude-roam pull
claude --resume abc123                           # 带着完整上下文恢复
```

#### 场景 2：项目目录变更

```bash
# 项目从 ~/old/path 移动到 ~/new/path
cd ~/new/path
claude-roam map add "my-mac:~/old/path"          # 映射到原来的云端目录
claude-roam pull                                 # 获取所有旧会话
claude --resume                                  # 继续之前的对话
```

#### 场景 3：使用桌面应用浏览和分析会话

```bash
claude-roam preview              # 启动 Tauri 桌面应用
# 使用 MiniMap 导航，按消息类型筛选，在数千条消息中搜索
# 直接在应用内导入/导出 .roam 文件
```

### 命令参考

| 命令 | 描述 |
|------|------|
| `claude-roam daemon` | 启动后台同步守护进程 |
| `claude-roam push` | 上传会话到云端 |
| `claude-roam pull` | 从云端下载会话 |
| `claude-roam list` | 列出远程会话 |
| `claude-roam list -g` | 按云端目录分组列出 |
| `claude-roam map add <dir>` | 将当前目录映射到云端目录 |
| `claude-roam map list` | 显示所有目录映射 |
| `claude-roam preview` | 启动桌面应用浏览会话 |
| `claude-roam export` | 导出为 .roam 文件 |
| `claude-roam import` | 从 .roam 文件导入 |
| `claude-roam status` | 查看同步状态 |
| `claude-roam login` | 使用 GitHub 登录 |

### 工作原理

```
┌─────────────────┐     push      ┌─────────────────┐
│   机器 A        │ ───────────▶  │   云端服务器    │
│ ~/projects/foo  │               │                 │
└─────────────────┘               │  会话数据库     │
                                  │  (已合并)       │
┌─────────────────┐     pull      │                 │
│   机器 B        │ ◀───────────  │  完整历史       │
│ ~/work/foo      │               │                 │
└─────────────────┘               └─────────────────┘
        │
        ▼
  claude --resume <id>  ✓ 可以工作！
```

1. **Push**：会话以"机器名 + 路径"作为"云端目录"上传
2. **Merge**：多次推送被合并，保留完整历史
3. **Map**：将本地目录链接到云端目录
4. **Pull**：将合并后的会话下载到 Claude 本地存储（`~/.claude/projects/`）
5. **Resume**：`claude --resume` 找到会话并继续

### 自托管部署

#### Docker Compose

```bash
cd docker
cp .env.example .env
# 编辑 .env：设置 GITHUB_CLIENT_ID 和 GITHUB_CLIENT_SECRET

docker-compose up -d
```

#### 环境变量

| 变量 | 描述 | 必需 |
|------|------|------|
| `ROAM_API` | 服务器 API 地址 | 是 |
| `ROAM_MACHINE_NAME` | 机器名称（默认 hostname） | 否 |
| `GITHUB_CLIENT_ID` | GitHub OAuth Client ID | 服务端 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Client Secret | 服务端 |

### 开发

```bash
# 后端 (Python + FastAPI)
cd server && uv sync && uv run uvicorn app.main:app --reload

# CLI (Bun + TypeScript)
cd cli && bun install && bun run dev <command>

# 前端 (React + Vite)
cd web && pnpm install && pnpm dev
```

### 开源协议

MIT
