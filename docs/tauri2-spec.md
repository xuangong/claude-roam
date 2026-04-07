# Claude Roam Tauri 2 技术规格说明书

## 1. 概述

### 1.1 文档目的

本文档详细描述 Claude Roam 从现有 HTML + Web Worker 架构迁移至 Tauri 2 桌面应用的技术规格，包含数据结构定义、API 接口规范、模块设计及实现细节。

> **参考项目**: 本规格参考了 [opcode](https://github.com/anthropics/opcode) 项目的成熟实践，opcode 是一个功能完善的 Claude Code GUI 工具，采用 Tauri 2 + React 架构。我们从中借鉴了：
> - 状态管理模式 (`CheckpointState`, `AgentDb`, `ProcessRegistry`)
> - 数据库管理命令 (`storage.rs`)
> - macOS 原生特性 (`window-vibrancy`, `decorations: false`)
> - 权限配置最佳实践 (`capabilities/default.json`)
> - 构建配置 (`tauri.conf.json`, `Cargo.toml`)

### 1.2 现有架构分析

基于代码审查，当前系统核心组件：

| 模块 | 文件位置 | 职责 |
|------|---------|------|
| **CLI 入口** | `cli/src/index.ts` | 命令行工具，支持 preview/export/import/merge 等 |
| **会话扫描** | `cli/src/scanner.ts` | 扫描 `~/.claude/projects/` 目录 |
| **预览页面** | `cli/assets/preview.html` | 嵌入式单文件 React 应用 |
| **预览入口** | `web/src/PreviewApp.tsx` | Base64 解码 + Web Worker 解析 |
| **会话详情** | `web/src/pages/SessionDetail.tsx` | 虚拟滚动渲染消息 |
| **消息存储** | `web/src/utils/messageStore.ts` | IndexedDB 分块缓存 |
| **解析器** | `web/src/utils/parserWorker.ts` | Web Worker JSONL 解析 |

### 1.3 数据流现状

```
┌─────────────────────────────────────────────────────────────────┐
│                      现有数据流                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ~/.claude/projects/{encoded_dir}/{session_id}.jsonl            │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────┐                    │
│  │  CLI: claude-roam preview               │                    │
│  │  1. 读取 JSONL 文件                      │                    │
│  │  2. 打包为 RoamBundle JSON              │                    │
│  │  3. Base64 编码                         │                    │
│  │  4. 注入 preview.html                   │                    │
│  │  5. 写入临时文件                         │                    │
│  │  6. 打开浏览器                           │                    │
│  └─────────────────────────────────────────┘                    │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────┐                    │
│  │  Browser: PreviewApp.tsx                │                    │
│  │  1. 读取 <script id="roam-data-base64"> │                    │
│  │  2. Web Worker 解码 Base64              │                    │
│  │  3. Web Worker 解析 JSON                │                    │
│  │  4. 返回 RoamBundle                     │                    │
│  └─────────────────────────────────────────┘                    │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────┐                    │
│  │  SessionDetail.tsx (虚拟滚动)            │                    │
│  │  1. parserWorker 解析 JSONL 行          │                    │
│  │  2. 构建 DisplayMessage[]               │                    │
│  │  3. 写入 IndexedDB 分块缓存             │                    │
│  │  4. @tanstack/react-virtual 渲染        │                    │
│  └─────────────────────────────────────────┘                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. 目标架构

### 2.1 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Tauri 2 Application                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────┐    IPC     ┌───────────────────────┐ │
│  │      WebView UI       │ ◄────────► │     Rust Backend      │ │
│  │      (React)          │            │                       │ │
│  │                       │            │  ┌─────────────────┐  │ │
│  │  ┌─────────────────┐  │  invoke    │  │   SessionStore  │  │ │
│  │  │  SessionList    │──┼───────────►│  │   (SQLite)      │  │ │
│  │  └─────────────────┘  │            │  └─────────────────┘  │ │
│  │                       │            │                       │ │
│  │  ┌─────────────────┐  │  invoke    │  ┌─────────────────┐  │ │
│  │  │  SessionDetail  │──┼───────────►│  │   Parser        │  │ │
│  │  │  (虚拟滚动)      │  │            │  │   (serde_json)  │  │ │
│  │  └─────────────────┘  │            │  └─────────────────┘  │ │
│  │                       │            │                       │ │
│  │  ┌─────────────────┐  │   emit     │  ┌─────────────────┐  │ │
│  │  │  EventListener  │◄─┼────────────│  │   FileWatcher   │  │ │
│  │  └─────────────────┘  │            │  │   (notify)      │  │ │
│  │                       │            │  └─────────────────┘  │ │
│  └───────────────────────┘            └───────────────────────┘ │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  File System                               │  │
│  │  ~/.claude/projects/{encoded_dir}/{session_id}.jsonl      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 核心改进

| 方面 | 现状 | Tauri 2 方案 | 收益 |
|------|-----|-------------|------|
| **启动** | CLI 导出 → 临时文件 → 浏览器 | 直接启动原生窗口 | 启动 < 500ms |
| **解析** | Web Worker JS 解析 | Rust serde_json | 10-50x 性能提升 |
| **存储** | IndexedDB (浏览器限制) | SQLite (无限制) | 支持 100w+ 消息 |
| **监听** | 无实时监听 | notify crate | < 100ms 延迟 |
| **搜索** | 前端内存搜索 | SQLite FTS5 | 毫秒级全文搜索 |

---

## 3. 数据结构定义

### 3.1 JSONL 消息格式 (现有)

当前 `~/.claude/projects/{encoded_dir}/{session_id}.jsonl` 文件格式：

```typescript
// 消息类型定义 (基于 parserWorker.ts)
interface RawMessage {
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  type: "user" | "assistant" | "system";
  message: {
    role: "user" | "assistant";
    content: ContentBlock[];
  };
  cacheKey?: string;
  isSidechain?: boolean;
}

interface SummaryRecord {
  type: "summary";
  summary: string;
  leafUuid: string;
  timestamp: string;
}

interface FileHistorySnapshot {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    // ... 其他快照数据
  };
}

type JsonlLine = RawMessage | SummaryRecord | FileHistorySnapshot;
```

### 3.2 内容块类型

```typescript
// ContentBlock 类型 (基于现有实现)
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | ContentBlock[] }
  | { type: "thinking"; thinking: string }
  | { type: "code_execution_tool_result"; stdout?: string; stderr?: string; return_code?: number }
  | { type: "server_tool_use"; name: string; serverToolUseId: string; input: unknown };
```

### 3.3 显示消息结构 (前端)

```typescript
// DisplayMessage - 用于 UI 渲染的扁平化结构
interface DisplayMessage {
  displayType: "human" | "assistant" | "tool_use" | "tool_result" | "thinking" | "code_result";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  treeIndex: number;        // 对话树索引 (用于 MiniMap)
  blocks: ContentBlock[];   // 原始内容块

  // 工具相关字段
  toolName?: string;
  toolId?: string;
  toolInput?: unknown;
  toolContent?: string | ContentBlock[];

  // 代码执行结果
  stdout?: string;
  stderr?: string;
  returnCode?: number;

  // 思考过程
  thinkingContent?: string;
}
```

### 3.4 SQLite Schema

```sql
-- 会话元数据表
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                    -- session UUID
    encoded_dir TEXT NOT NULL,              -- 编码后的目录名
    directory TEXT NOT NULL,                -- 原始目录路径
    line_count INTEGER DEFAULT 0,           -- JSONL 行数
    message_count INTEGER DEFAULT 0,        -- 消息数量 (有 uuid 的行)
    first_human_message TEXT,               -- 第一条用户消息 (预览用)
    last_modified INTEGER NOT NULL,         -- 文件最后修改时间戳
    parsed_at INTEGER,                      -- 最后解析时间戳
    file_size INTEGER DEFAULT 0,            -- 文件大小 (字节)
    tree_count INTEGER DEFAULT 1,           -- 对话树数量
    type_string TEXT                        -- 消息类型分布串 (用于 MiniMap)
);

-- 消息分块存储表 (每块 100 条消息)
CREATE TABLE message_chunks (
    session_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,           -- 块索引 (0, 1, 2, ...)
    start_line INTEGER NOT NULL,            -- 起始行号
    end_line INTEGER NOT NULL,              -- 结束行号
    messages TEXT NOT NULL,                 -- JSON 数组: DisplayMessage[]
    PRIMARY KEY (session_id, chunk_index),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 消息索引表 (用于快速定位)
CREATE TABLE message_index (
    session_id TEXT NOT NULL,
    uuid TEXT NOT NULL,
    parent_uuid TEXT,
    tree_index INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    offset_in_chunk INTEGER NOT NULL,       -- 在块内的偏移
    display_type TEXT NOT NULL,
    timestamp TEXT,
    PRIMARY KEY (session_id, uuid),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- 全文搜索虚拟表
CREATE VIRTUAL TABLE messages_fts USING fts5(
    session_id,
    uuid,
    content,                                -- 文本内容
    tool_name,                              -- 工具名称
    tokenize='unicode61'
);

-- 索引
CREATE INDEX idx_sessions_encoded_dir ON sessions(encoded_dir);
CREATE INDEX idx_sessions_last_modified ON sessions(last_modified DESC);
CREATE INDEX idx_message_index_tree ON message_index(session_id, tree_index);
CREATE INDEX idx_message_index_parent ON message_index(session_id, parent_uuid);
```

---

## 4. Rust 后端模块设计

> **参考**: 本节设计参考了 [opcode](https://github.com/anthropics/opcode) 项目的成熟架构实践。

### 4.1 模块结构

```
src-tauri/
├── Cargo.toml
├── build.rs                   # 构建脚本
├── tauri.conf.json
├── capabilities/
│   └── default.json
├── icons/                     # 应用图标
└── src/
    ├── main.rs                # 主入口，初始化应用
    ├── lib.rs                 # 库入口 (供测试使用)
    ├── commands/              # IPC 命令模块
    │   ├── mod.rs             # 模块导出
    │   ├── projects.rs        # 项目列表命令 (参考 opcode claude.rs)
    │   ├── sessions.rs        # 会话列表/元数据命令
    │   ├── messages.rs        # 消息查询命令
    │   ├── search.rs          # 搜索命令
    │   ├── analysis.rs        # 分析命令
    │   ├── storage.rs         # 数据库管理命令 (参考 opcode storage.rs)
    │   └── settings.rs        # 应用设置命令
    ├── parser/
    │   ├── mod.rs
    │   ├── jsonl.rs           # JSONL 解析器
    │   └── display.rs         # DisplayMessage 转换
    ├── state/                 # 状态管理模块 (参考 opcode checkpoint/state.rs)
    │   ├── mod.rs
    │   ├── app_state.rs       # 全局应用状态
    │   └── watcher_state.rs   # 文件监听状态
    ├── storage/
    │   ├── mod.rs
    │   ├── database.rs        # SQLite 连接管理
    │   ├── migrations.rs      # 数据库迁移
    │   ├── sessions.rs        # 会话 CRUD
    │   └── messages.rs        # 消息分块存储
    ├── watcher/
    │   ├── mod.rs
    │   └── file_watcher.rs    # 文件系统监听
    └── utils/
        ├── mod.rs
        └── path.rs            # 路径编码工具
```

### 4.2 状态管理 (参考 opcode 最佳实践)

opcode 项目采用了优雅的状态管理模式，使用 `tauri::State` 和 `Arc<Mutex<T>>` 管理全局资源。

#### 4.2.1 数据库状态 (参考 opcode `AgentDb`)

```rust
// src-tauri/src/state/app_state.rs

use rusqlite::Connection;
use std::sync::Mutex;

/// 数据库连接状态
/// 参考 opcode 的 AgentDb 模式
pub struct AppDb(pub Mutex<Connection>);

impl AppDb {
    pub fn new(conn: Connection) -> Self {
        Self(Mutex::new(conn))
    }
}

/// 应用配置状态
pub struct AppSettings {
    pub claude_dir: std::path::PathBuf,
    pub db_path: std::path::PathBuf,
}
```

#### 4.2.2 文件监听状态 (参考 opcode `CheckpointState`)

```rust
// src-tauri/src/state/watcher_state.rs

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 文件监听状态管理器
/// 参考 opcode checkpoint/state.rs 的设计模式
#[derive(Default, Clone)]
pub struct WatcherState {
    /// 活跃的会话监听器
    active_watchers: Arc<RwLock<HashMap<String, PathBuf>>>,
    /// Claude 目录路径
    claude_dir: Arc<RwLock<Option<PathBuf>>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn set_claude_dir(&self, claude_dir: PathBuf) {
        let mut dir = self.claude_dir.write().await;
        *dir = Some(claude_dir);
    }

    pub async fn get_claude_dir(&self) -> Option<PathBuf> {
        let dir = self.claude_dir.read().await;
        dir.clone()
    }

    pub async fn register_watcher(&self, session_id: String, path: PathBuf) {
        let mut watchers = self.active_watchers.write().await;
        watchers.insert(session_id, path);
    }

    pub async fn unregister_watcher(&self, session_id: &str) {
        let mut watchers = self.active_watchers.write().await;
        watchers.remove(session_id);
    }

    pub async fn active_count(&self) -> usize {
        let watchers = self.active_watchers.read().await;
        watchers.len()
    }
}
```

#### 4.2.3 主入口初始化 (参考 opcode `main.rs`)

```rust
// src-tauri/src/main.rs

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod parser;
mod state;
mod storage;
mod watcher;

use state::{AppDb, WatcherState};
use storage::init_database;
use tauri::Manager;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化数据库
            let conn = init_database(&app.handle())
                .expect("Failed to initialize database");
            app.manage(AppDb::new(conn));

            // 初始化文件监听状态
            let watcher_state = WatcherState::new();

            // 设置 Claude 目录
            if let Some(home) = dirs::home_dir() {
                let claude_dir = home.join(".claude");
                if claude_dir.exists() {
                    let state_clone = watcher_state.clone();
                    tauri::async_runtime::spawn(async move {
                        state_clone.set_claude_dir(claude_dir).await;
                    });
                }
            }

            app.manage(watcher_state);

            // macOS 窗口毛玻璃效果 (参考 opcode)
            #[cfg(target_os = "macos")]
            {
                let window = app.get_webview_window("main").unwrap();
                let materials = [
                    NSVisualEffectMaterial::UnderWindowBackground,
                    NSVisualEffectMaterial::Sidebar,
                ];
                for material in materials.iter() {
                    if apply_vibrancy(&window, *material, None, Some(12.0)).is_ok() {
                        break;
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Projects & Sessions
            commands::projects::list_projects,
            commands::projects::get_project_sessions,
            commands::sessions::list_sessions,
            commands::sessions::get_session,
            commands::sessions::scan_sessions,
            // Messages
            commands::messages::get_messages_range,
            commands::messages::get_message_by_uuid,
            // Search
            commands::search::search_messages,
            commands::search::search_tool_calls,
            // Analysis
            commands::analysis::analyze_session,
            // Storage Admin (参考 opcode)
            commands::storage::storage_list_tables,
            commands::storage::storage_read_table,
            commands::storage::storage_execute_sql,
            // Settings
            commands::settings::get_settings,
            commands::settings::save_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 4.2 核心类型定义 (Rust)

```rust
// src-tauri/src/parser/display.rs

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        content: ToolResultContent,
    },

    #[serde(rename = "thinking")]
    Thinking { thinking: String },

    #[serde(rename = "code_execution_tool_result")]
    CodeExecutionResult {
        stdout: Option<String>,
        stderr: Option<String>,
        return_code: Option<i32>,
    },

    #[serde(rename = "server_tool_use")]
    ServerToolUse {
        name: String,
        #[serde(rename = "serverToolUseId")]
        server_tool_use_id: String,
        input: serde_json::Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ToolResultContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayMessage {
    #[serde(rename = "displayType")]
    pub display_type: DisplayType,
    pub uuid: String,
    #[serde(rename = "parentUuid")]
    pub parent_uuid: Option<String>,
    pub timestamp: Option<String>,
    #[serde(rename = "treeIndex")]
    pub tree_index: u32,
    pub blocks: Vec<ContentBlock>,

    // 工具相关
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(rename = "toolId", skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(rename = "toolInput", skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    #[serde(rename = "toolContent", skip_serializing_if = "Option::is_none")]
    pub tool_content: Option<ToolResultContent>,

    // 代码执行
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(rename = "returnCode", skip_serializing_if = "Option::is_none")]
    pub return_code: Option<i32>,

    // 思考过程
    #[serde(rename = "thinkingContent", skip_serializing_if = "Option::is_none")]
    pub thinking_content: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DisplayType {
    Human,
    Assistant,
    ToolUse,
    ToolResult,
    Thinking,
    CodeResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    #[serde(rename = "encodedDir")]
    pub encoded_dir: String,
    pub directory: String,
    #[serde(rename = "lineCount")]
    pub line_count: u32,
    #[serde(rename = "messageCount")]
    pub message_count: u32,
    #[serde(rename = "firstHumanMessage")]
    pub first_human_message: Option<String>,
    #[serde(rename = "lastModified")]
    pub last_modified: i64,
    #[serde(rename = "parsedAt")]
    pub parsed_at: Option<i64>,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    #[serde(rename = "treeCount")]
    pub tree_count: u32,
    #[serde(rename = "typeString")]
    pub type_string: Option<String>,
}
```

---

## 5. IPC 命令规范

### 5.1 会话命令

#### `list_sessions`

列出所有会话或指定目录的会话。

```typescript
// 前端调用
const sessions = await invoke<SessionMeta[]>('list_sessions', {
  encodedDir?: string,  // 可选：按目录过滤
  limit?: number,       // 可选：限制数量
  offset?: number,      // 可选：分页偏移
});

// Rust 实现
#[tauri::command]
async fn list_sessions(
    state: State<'_, AppState>,
    encoded_dir: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<SessionMeta>, String>;
```

#### `get_session`

获取单个会话的详细信息。

```typescript
// 前端调用
const session = await invoke<SessionMeta | null>('get_session', {
  sessionId: string,
});

// Rust 实现
#[tauri::command]
async fn get_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<SessionMeta>, String>;
```

#### `scan_sessions`

扫描文件系统并更新数据库。

```typescript
// 前端调用
const result = await invoke<ScanResult>('scan_sessions', {
  forceReparse?: boolean,  // 是否强制重新解析
});

interface ScanResult {
  totalSessions: number;
  newSessions: number;
  updatedSessions: number;
  deletedSessions: number;
  duration_ms: number;
}

// Rust 实现
#[tauri::command]
async fn scan_sessions(
    state: State<'_, AppState>,
    force_reparse: Option<bool>,
) -> Result<ScanResult, String>;
```

### 5.2 消息命令

#### `get_messages_range`

获取指定范围的消息（虚拟滚动核心）。

```typescript
// 前端调用
const messages = await invoke<DisplayMessage[]>('get_messages_range', {
  sessionId: string,
  startIndex: number,
  endIndex: number,
});

// Rust 实现
#[tauri::command]
async fn get_messages_range(
    state: State<'_, AppState>,
    session_id: String,
    start_index: u32,
    end_index: u32,
) -> Result<Vec<DisplayMessage>, String>;
```

#### `get_message_by_uuid`

根据 UUID 获取单条消息。

```typescript
// 前端调用
const message = await invoke<DisplayMessage | null>('get_message_by_uuid', {
  sessionId: string,
  uuid: string,
});
```

#### `get_tree_path`

获取从根到指定消息的路径（对话树导航）。

```typescript
// 前端调用
const path = await invoke<DisplayMessage[]>('get_tree_path', {
  sessionId: string,
  uuid: string,
});
```

### 5.3 搜索命令

#### `search_messages`

全文搜索消息内容。

```typescript
// 前端调用
const results = await invoke<SearchResult[]>('search_messages', {
  sessionId: string,
  query: string,
  limit?: number,
});

interface SearchResult {
  uuid: string;
  treeIndex: number;
  displayType: string;
  snippet: string;      // 高亮片段
  score: number;        // 相关度评分
}
```

#### `search_tool_calls`

搜索工具调用。

```typescript
// 前端调用
const results = await invoke<ToolCallResult[]>('search_tool_calls', {
  sessionId: string,
  toolName?: string,    // 可选：按工具名过滤
});

interface ToolCallResult {
  uuid: string;
  treeIndex: number;
  toolName: string;
  toolId: string;
  input: unknown;
}
```

### 5.4 分析命令

#### `analyze_session`

分析会话统计信息。

```typescript
// 前端调用
const analysis = await invoke<SessionAnalysis>('analyze_session', {
  sessionId: string,
});

interface SessionAnalysis {
  totalMessages: number;
  humanMessages: number;
  assistantMessages: number;
  toolCalls: ToolCallStat[];
  treeCount: number;
  timeSpan: {
    start: string;
    end: string;
    durationMinutes: number;
  } | null;
  topToolsByUsage: { name: string; count: number }[];
}

interface ToolCallStat {
  toolName: string;
  callCount: number;
  successCount: number;
  errorCount: number;
}
```

#### `analyze_session_async`

异步分析（带进度回调）。

```typescript
// 前端调用
import { Channel } from '@tauri-apps/api/core';

const progress = new Channel<AnalysisProgress>();
progress.onmessage = (msg) => {
  console.log(`${msg.stage}: ${msg.percentage}%`);
};

const analysis = await invoke<SessionAnalysis>('analyze_session_async', {
  sessionId: string,
  progress: progress,
});

interface AnalysisProgress {
  stage: 'loading' | 'parsing' | 'analyzing' | 'complete';
  percentage: number;
  message: string;
}
```

### 5.5 存储管理命令 (参考 opcode storage.rs)

提供数据库管理接口，便于调试和数据检查。

#### `storage_list_tables`

列出数据库中所有表。

```typescript
// 前端调用
const tables = await invoke<TableInfo[]>('storage_list_tables');

interface TableInfo {
  name: string;
  row_count: number;
  columns: ColumnInfo[];
}

interface ColumnInfo {
  cid: number;
  name: string;
  type_name: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}
```

#### `storage_read_table`

分页读取表数据。

```typescript
// 前端调用
const data = await invoke<TableData>('storage_read_table', {
  tableName: string,
  page: number,
  pageSize: number,
  searchQuery?: string,
});

interface TableData {
  table_name: string;
  columns: ColumnInfo[];
  rows: Record<string, unknown>[];
  total_rows: number;
  page: number;
  page_size: number;
  total_pages: number;
}
```

#### `storage_execute_sql`

执行原始 SQL 查询（仅限开发模式）。

```typescript
// 前端调用
const result = await invoke<QueryResult>('storage_execute_sql', {
  query: string,
});

interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rows_affected: number | null;
  last_insert_rowid: number | null;
}
```

### 5.6 文件监听事件

#### `session-changed`

文件变化时发出的事件。

```typescript
// 前端监听
import { listen } from '@tauri-apps/api/event';

const unlisten = await listen<SessionChangeEvent>('session-changed', (event) => {
  console.log('Session changed:', event.payload);
});

interface SessionChangeEvent {
  sessionId: string;
  encodedDir: string;
  changeType: 'created' | 'modified' | 'deleted';
  newLineCount?: number;
}
```

---

## 6. 前端适配指南

### 6.1 数据获取层改造

**现有代码** (`web/src/utils/messageStore.ts`):

```typescript
// 当前：使用 IndexedDB
export async function getMessagesInRange(
  sessionId: string,
  startIndex: number,
  endIndex: number
): Promise<DisplayMessage[]> {
  // IndexedDB 查询逻辑
}
```

**迁移后** (`web/src/utils/tauriStore.ts`):

```typescript
import { invoke } from '@tauri-apps/api/core';
import type { DisplayMessage, SessionMeta } from '../types';

// 检测是否在 Tauri 环境中运行
export const isTauri = () => '__TAURI__' in window;

// 获取消息范围
export async function getMessagesInRange(
  sessionId: string,
  startIndex: number,
  endIndex: number
): Promise<DisplayMessage[]> {
  if (!isTauri()) {
    // 降级到 IndexedDB (保持兼容性)
    return legacyGetMessagesInRange(sessionId, startIndex, endIndex);
  }

  return invoke<DisplayMessage[]>('get_messages_range', {
    sessionId,
    startIndex,
    endIndex,
  });
}

// 获取会话元数据
export async function getSessionMeta(
  sessionId: string
): Promise<SessionMeta | null> {
  if (!isTauri()) {
    return legacyGetSessionMeta(sessionId);
  }

  return invoke<SessionMeta | null>('get_session', { sessionId });
}

// 搜索消息
export async function searchMessages(
  sessionId: string,
  query: string,
  limit?: number
): Promise<SearchResult[]> {
  if (!isTauri()) {
    return legacySearchMessages(sessionId, query, limit);
  }

  return invoke<SearchResult[]>('search_messages', {
    sessionId,
    query,
    limit,
  });
}
```

### 6.2 SessionDetail 组件改造

**关键修改点**：

```typescript
// web/src/pages/SessionDetail.tsx

import { useEffect, useCallback, useState, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { listen } from '@tauri-apps/api/event';
import { getMessagesInRange, getSessionMeta, isTauri } from '../utils/tauriStore';

export function SessionDetail({ sessionId }: { sessionId: string }) {
  const [totalMessages, setTotalMessages] = useState(0);
  const [visibleMessages, setVisibleMessages] = useState<Map<number, DisplayMessage>>(new Map());
  const parentRef = useRef<HTMLDivElement>(null);

  // 初始化会话元数据
  useEffect(() => {
    getSessionMeta(sessionId).then((meta) => {
      if (meta) {
        setTotalMessages(meta.messageCount);
      }
    });
  }, [sessionId]);

  // 文件变化监听 (仅 Tauri 环境)
  useEffect(() => {
    if (!isTauri()) return;

    const setupListener = async () => {
      const unlisten = await listen<SessionChangeEvent>('session-changed', (event) => {
        if (event.payload.sessionId === sessionId) {
          // 刷新消息
          refreshVisibleMessages();
          // 更新总数
          if (event.payload.newLineCount) {
            setTotalMessages(event.payload.newLineCount);
          }
        }
      });

      return unlisten;
    };

    const unlistenPromise = setupListener();
    return () => {
      unlistenPromise.then(fn => fn());
    };
  }, [sessionId]);

  // 虚拟滚动配置
  const virtualizer = useVirtualizer({
    count: totalMessages,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 100,
    overscan: 20,
  });

  // 加载可见消息
  const loadVisibleMessages = useCallback(async () => {
    const range = virtualizer.range;
    if (!range) return;

    const start = Math.max(0, range.startIndex - 50);
    const end = Math.min(totalMessages - 1, range.endIndex + 50);

    const messages = await getMessagesInRange(sessionId, start, end);

    setVisibleMessages(prev => {
      const next = new Map(prev);
      messages.forEach((msg, i) => {
        next.set(start + i, msg);
      });
      return next;
    });
  }, [sessionId, totalMessages, virtualizer.range]);

  useEffect(() => {
    loadVisibleMessages();
  }, [loadVisibleMessages]);

  // 渲染...
}
```

### 6.3 PreviewApp 入口改造

```typescript
// web/src/TauriApp.tsx - Tauri 专用入口

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import SessionList from './components/SessionList';
import SessionDetail from './pages/SessionDetail';

export function TauriApp() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 初始扫描
  useEffect(() => {
    const init = async () => {
      setLoading(true);

      // 扫描文件系统
      await invoke('scan_sessions', { forceReparse: false });

      // 加载会话列表
      const list = await invoke<SessionMeta[]>('list_sessions', {});
      setSessions(list);

      setLoading(false);
    };

    init();
  }, []);

  // 监听会话变化
  useEffect(() => {
    const setupListeners = async () => {
      const unlisten = await listen<SessionChangeEvent>('session-changed', async () => {
        // 重新加载会话列表
        const list = await invoke<SessionMeta[]>('list_sessions', {});
        setSessions(list);
      });

      return unlisten;
    };

    const unlistenPromise = setupListeners();
    return () => {
      unlistenPromise.then(fn => fn());
    };
  }, []);

  if (loading) {
    return <LoadingScreen />;
  }

  return (
    <div className="app">
      <SessionList
        sessions={sessions}
        selected={selectedSession}
        onSelect={setSelectedSession}
      />
      {selectedSession && (
        <SessionDetail sessionId={selectedSession} />
      )}
    </div>
  );
}
```

---

## 7. 文件监听实现

### 7.1 Rust FileWatcher 模块

```rust
// src-tauri/src/watcher/file_watcher.rs

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub struct FileWatcher {
    watcher: RecommendedWatcher,
    debounce_map: Arc<Mutex<HashMap<PathBuf, Instant>>>,
}

#[derive(Clone, serde::Serialize)]
pub struct SessionChangeEvent {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "encodedDir")]
    pub encoded_dir: String,
    #[serde(rename = "changeType")]
    pub change_type: String, // "created" | "modified" | "deleted"
    #[serde(rename = "newLineCount")]
    pub new_line_count: Option<u32>,
}

impl FileWatcher {
    pub fn new(app: AppHandle) -> Result<Self, notify::Error> {
        let debounce_map = Arc::new(Mutex::new(HashMap::new()));
        let debounce_map_clone = debounce_map.clone();

        let (tx, mut rx) = mpsc::unbounded_channel::<Event>();

        // 创建 watcher
        let watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = tx.send(event);
                }
            },
            Config::default().with_poll_interval(Duration::from_millis(200)),
        )?;

        // 启动事件处理任务
        let app_clone = app.clone();
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                Self::handle_event(
                    event,
                    &app_clone,
                    &debounce_map_clone,
                ).await;
            }
        });

        Ok(Self {
            watcher,
            debounce_map,
        })
    }

    pub fn watch_claude_dir(&mut self) -> Result<(), notify::Error> {
        let home = dirs::home_dir().expect("Could not find home directory");
        let projects_dir = home.join(".claude").join("projects");

        if projects_dir.exists() {
            self.watcher.watch(&projects_dir, RecursiveMode::Recursive)?;
            log::info!("Watching directory: {:?}", projects_dir);
        } else {
            log::warn!("Claude projects directory does not exist: {:?}", projects_dir);
        }

        Ok(())
    }

    async fn handle_event(
        event: Event,
        app: &AppHandle,
        debounce_map: &Arc<Mutex<HashMap<PathBuf, Instant>>>,
    ) {
        let change_type = match event.kind {
            EventKind::Create(_) => "created",
            EventKind::Modify(_) => "modified",
            EventKind::Remove(_) => "deleted",
            _ => return,
        };

        for path in event.paths {
            // 只处理 .jsonl 文件
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }

            // 防抖：100ms 内的重复事件合并
            {
                let mut map = debounce_map.lock().unwrap();
                let now = Instant::now();

                if let Some(last) = map.get(&path) {
                    if now.duration_since(*last) < Duration::from_millis(100) {
                        continue;
                    }
                }

                map.insert(path.clone(), now);
            }

            // 提取 session_id 和 encoded_dir
            let session_id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let encoded_dir = path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // 获取新的行数 (如果文件存在)
            let new_line_count = if change_type != "deleted" {
                std::fs::read_to_string(&path)
                    .map(|content| content.lines().count() as u32)
                    .ok()
            } else {
                None
            };

            // 发送事件到前端
            let event = SessionChangeEvent {
                session_id,
                encoded_dir,
                change_type: change_type.to_string(),
                new_line_count,
            };

            if let Err(e) = app.emit("session-changed", event) {
                log::error!("Failed to emit session-changed event: {}", e);
            }
        }
    }
}
```

### 7.2 在 Tauri 启动时初始化

```rust
// src-tauri/src/lib.rs

use tauri::Manager;

mod commands;
mod parser;
mod storage;
mod watcher;

pub struct AppState {
    pub db: storage::Database,
    pub watcher: std::sync::Mutex<Option<watcher::FileWatcher>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            // 初始化数据库
            let db = storage::Database::new(app.handle())?;

            // 初始化文件监听
            let mut watcher = watcher::FileWatcher::new(app.handle().clone())?;
            watcher.watch_claude_dir()?;

            // 存储状态
            app.manage(AppState {
                db,
                watcher: std::sync::Mutex::new(Some(watcher)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sessions::list_sessions,
            commands::sessions::get_session,
            commands::sessions::scan_sessions,
            commands::messages::get_messages_range,
            commands::messages::get_message_by_uuid,
            commands::messages::get_tree_path,
            commands::search::search_messages,
            commands::search::search_tool_calls,
            commands::analysis::analyze_session,
            commands::analysis::analyze_session_async,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## 8. 权限配置

### 8.1 Tauri Capabilities (参考 opcode capabilities/default.json)

```json
// src-tauri/capabilities/default.json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Claude Roam 默认权限配置",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:event:allow-emit",
    "core:event:allow-listen",

    "dialog:default",
    "dialog:allow-open",

    "shell:allow-open",

    "fs:default",
    "fs:allow-read",
    "fs:allow-exists",
    "fs:read-all",
    "fs:scope-home-recursive",

    "process:default",
    "notification:default",

    "core:window:allow-minimize",
    "core:window:allow-maximize",
    "core:window:allow-unmaximize",
    "core:window:allow-close",
    "core:window:allow-is-maximized",
    "core:window:allow-start-dragging"
  ]
}
```

### 8.2 Tauri 配置 (参考 opcode tauri.conf.json)

```json
// src-tauri/tauri.conf.json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Claude Roam",
  "version": "1.0.0",
  "identifier": "com.claude-roam.app",
  "build": {
    "beforeDevCommand": "",
    "beforeBuildCommand": "npm run build --prefix ../web",
    "frontendDist": "../web/dist",
    "devUrl": "http://localhost:5173"
  },
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "title": "Claude Roam",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "decorations": false,
        "transparent": true,
        "shadow": true,
        "center": true,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: https://asset.localhost blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
      "assetProtocol": {
        "enable": true,
        "scope": ["**"]
      }
    }
  },
  "plugins": {
    "fs": {
      "scope": ["$HOME/**"],
      "allow": [
        "readFile",
        "readDir",
        "exists"
      ]
    },
    "shell": {
      "open": true
    }
  },
  "bundle": {
    "active": true,
    "targets": ["deb", "rpm", "appimage", "app", "dmg"],
    "icon": [
      "icons/32x32.png",
      "icons/64x64.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.png",
      "icons/icon.ico",
      "icons/icon.icns"
    ],
    "category": "DeveloperTool",
    "shortDescription": "Session history viewer for Claude Code",
    "longDescription": "Claude Roam is a comprehensive session history viewer for Claude Code, providing an intuitive interface for browsing and analyzing AI conversation logs.",
    "linux": {
      "appimage": {
        "bundleMediaFramework": true
      },
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0"]
      }
    },
    "macOS": {
      "minimumSystemVersion": "10.15",
      "dmg": {
        "windowSize": { "width": 540, "height": 380 },
        "appPosition": { "x": 140, "y": 200 },
        "applicationFolderPosition": { "x": 400, "y": 200 }
      }
    }
  }
}
```

---

## 9. 性能指标

### 9.1 目标指标

| 指标 | 现状 | 目标 | 测量方法 |
|------|-----|------|---------|
| **冷启动时间** | > 3s | < 500ms | 从点击图标到首屏渲染 |
| **会话列表加载** | 1-2s | < 100ms | 显示 100 个会话的时间 |
| **大文件解析** (10k 行) | 5-15s | < 1s | JSONL 解析为 DisplayMessage[] |
| **虚拟滚动帧率** | 30-40fps | 60fps | 快速滚动时的 FPS |
| **文件变化响应** | 2s+ | < 100ms | 文件修改到 UI 更新 |
| **全文搜索** (10k 消息) | 2-5s | < 500ms | SQLite FTS5 查询 |
| **内存占用** (10k 消息) | 200-500MB | < 100MB | 虚拟滚动 + 分块加载 |

### 9.2 基准测试用例

```typescript
// tests/performance.test.ts

describe('Performance Benchmarks', () => {
  it('should parse 10k line session in < 1s', async () => {
    const start = performance.now();
    await invoke('scan_sessions', { forceReparse: true });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(1000);
  });

  it('should load message range in < 50ms', async () => {
    const start = performance.now();
    await invoke('get_messages_range', {
      sessionId: 'test-session',
      startIndex: 5000,
      endIndex: 5100,
    });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
  });

  it('should search 10k messages in < 500ms', async () => {
    const start = performance.now();
    await invoke('search_messages', {
      sessionId: 'test-session',
      query: 'function',
      limit: 100,
    });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(500);
  });
});
```

---

## 10. 实现优先级

### 10.1 Phase 1: 最小可用产品 (MVP)

**目标**：替代现有 preview 命令功能

| 任务 | 优先级 | 依赖 |
|------|-------|------|
| Tauri 项目初始化 | P0 | - |
| SQLite 数据库集成 | P0 | - |
| JSONL 解析器 (Rust) | P0 | - |
| `list_sessions` 命令 | P0 | SQLite |
| `get_messages_range` 命令 | P0 | 解析器, SQLite |
| 前端 TauriApp 入口 | P0 | 所有后端命令 |
| SessionDetail 虚拟滚动适配 | P0 | get_messages_range |

### 10.2 Phase 2: 实时监听

| 任务 | 优先级 | 依赖 |
|------|-------|------|
| FileWatcher 模块 | P1 | - |
| `session-changed` 事件 | P1 | FileWatcher |
| 前端事件监听集成 | P1 | session-changed |
| 增量解析优化 | P1 | FileWatcher |

### 10.3 Phase 3: 高级功能

| 任务 | 优先级 | 依赖 |
|------|-------|------|
| FTS5 全文搜索 | P2 | SQLite |
| `search_messages` 命令 | P2 | FTS5 |
| `analyze_session` 命令 | P2 | 解析器 |
| 异步分析 + 进度反馈 | P2 | analyze_session |
| CLI 兼容层 | P3 | 所有功能 |

---

## 11. 附录

### 11.1 依赖版本 (参考 opcode Cargo.toml)

```toml
# src-tauri/Cargo.toml
[package]
name = "claude-roam"
version = "1.0.0"
description = "Session history viewer for Claude Code"
edition = "2021"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
# Tauri 核心 (参考 opcode)
tauri = { version = "2", features = ["macos-private-api", "protocol-asset", "tray-icon", "image-png"] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-process = "2"
tauri-plugin-notification = "2"

# 序列化
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 异步运行时
tokio = { version = "1", features = ["full"] }

# 数据库 (opcode 使用 rusqlite，我们也采用以保持一致性)
rusqlite = { version = "0.32", features = ["bundled"] }

# 文件监听
notify = "7.0"

# 工具库
dirs = "5"
chrono = { version = "0.4", features = ["serde"] }
anyhow = "1"
log = "0.4"
env_logger = "0.11"
regex = "1"
glob = "0.3"
uuid = { version = "1.6", features = ["v4", "serde"] }
walkdir = "2"

# macOS 特定 (参考 opcode)
[target.'cfg(target_os = "macos")'.dependencies]
window-vibrancy = "0.5"
cocoa = "0.26"
objc = "0.2"

[features]
custom-protocol = ["tauri/custom-protocol"]

[profile.release]
strip = true
opt-level = "z"
lto = true
codegen-units = 1
```

```json
// package.json
{
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "@tauri-apps/plugin-fs": "^2.0.0",
    "@tauri-apps/plugin-shell": "^2.0.0",
    "@tanstack/react-virtual": "^3.10.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
```

### 11.2 文件路径约定

| 路径 | 用途 |
|------|-----|
| `~/.claude/projects/{encoded_dir}/{session_id}.jsonl` | 原始会话文件 |
| `~/.claude-roam/claude-roam.db` | SQLite 数据库 |
| `~/.claude-roam/state.json` | CLI 状态文件 (保持兼容) |
| `~/.claude-roam/backups/` | 备份目录 |

### 11.3 错误码定义

| 错误码 | 描述 |
|-------|------|
| `SESSION_NOT_FOUND` | 会话不存在 |
| `PARSE_ERROR` | JSONL 解析失败 |
| `DATABASE_ERROR` | 数据库操作失败 |
| `FILE_READ_ERROR` | 文件读取失败 |
| `WATCHER_ERROR` | 文件监听初始化失败 |

---

**文档版本**: 1.0
**创建日期**: 2026-01-29
**作者**: Claude (via Happy)
