# Claude Roam Tauri 2 迁移需求文档

## 1. 项目背景

### 1.1 现状分析

Claude Roam 当前采用以下技术栈进行本地 History 管理和渲染：

| 组件 | 当前方案 | 主要问题 |
|------|---------|---------|
| **前端** | 单 HTML + 内联 React 应用 | 资源加载依赖浏览器 |
| **数据解析** | Web Worker 后台线程解析 | 受限于 JS 性能 |
| **数据存储** | IndexedDB + 分块缓存 | 浏览器存储配额限制 |
| **文件监听** | Node.js `fs.watch` (CLI 侧) | 仅 CLI daemon 模式可用 |
| **预览模式** | HTML 文件 + 临时目录 | 无法实时更新 |

#### 核心代码文件一览

```
cli/
├── src/
│   ├── daemon.ts        # 文件监听 (fs.watch + debounce)
│   ├── scanner.ts       # 扫描 ~/.claude/projects/ 目录
│   ├── index.ts         # CLI 主入口，preview 命令
│   └── assets/
│       └── preview.html # 嵌入式预览页面模板

web/
├── src/
│   ├── PreviewApp.tsx           # 预览入口组件
│   ├── pages/
│   │   ├── SessionDetail.tsx    # 会话详情（虚拟滚动）
│   │   └── RoamPreviewCore.tsx  # 核心预览组件
│   ├── utils/
│   │   ├── parserWorker.ts      # Web Worker JSON 解析
│   │   └── messageStore.ts      # IndexedDB 存储层
│   └── components/
│       ├── MiniMap.tsx          # 导航缩略图
│       └── MessageComponents.tsx # 消息渲染组件
```

### 1.2 现有问题

1. **启动延迟高**：预览命令需要先导出数据到临时文件，再打开浏览器
2. **解析性能瓶颈**：Web Worker 虽然不阻塞 UI，但 JS 解析 10000+ 行 JSONL 仍需 5-15 秒
3. **内存限制**：IndexedDB 在部分浏览器有存储配额限制（如 Safari 1GB）
4. **实时性差**：无法实时监听文件变化并更新预览
5. **用户体验割裂**：CLI 和 Web UI 是分离的两个系统

### 1.3 迁移目标

通过 Tauri 2 原生桌面应用替代现有方案，实现：

- **启动时间** < 500ms（当前 > 3s）
- **大文件解析**：10000+ 消息在 < 1s 内完成
- **实时监听**：文件变化后 < 100ms 内更新 UI
- **无存储限制**：使用 SQLite 替代 IndexedDB

---

## 2. 技术方案概述

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri 2 Application                       │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐     IPC (invoke/emit)    ┌───────────┐ │
│  │   WebView UI    │ ←──────────────────────→ │   Rust    │ │
│  │   (React)       │                          │  Backend  │ │
│  │                 │   ┌─────────────────┐    │           │ │
│  │  - 虚拟滚动     │   │  tauri-channel  │    │ - SQLite  │ │
│  │  - MiniMap      │   │  (实时事件流)    │    │ - notify  │ │
│  │  - 搜索/导航    │   └─────────────────┘    │ - serde   │ │
│  └─────────────────┘                          └───────────┘ │
├─────────────────────────────────────────────────────────────┤
│                 ~/.claude/projects/                          │
│                 (文件系统监听)                                │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心思维转变

| 原方案 | Tauri 2 方案 | 优势 |
|--------|-------------|------|
| Web Worker 解析 JSON | Rust `serde_json` 解析 | 10-100x 性能提升 |
| IndexedDB 存储 | SQLite (tauri-plugin-sql) | 无容量限制，支持复杂查询 |
| `setInterval` 轮询 | Rust `notify` 库 | 真正的文件系统事件 |
| HTTP 获取数据 | IPC `invoke` 调用 | 零网络开销 |
| HTML 临时文件预览 | 内置 WebView | 即时渲染 |

---

## 3. 分阶段迁移计划

### 第一阶段：底层引擎替换 (The Engine Swap)

**目标**：搭建 Tauri 骨架，前端代码最小改动

#### 3.1.1 项目初始化

```bash
# 在项目根目录创建 Tauri 应用
pnpm create tauri-app@latest --rc tauri-app
cd tauri-app

# 目录结构
tauri-app/
├── src/                    # 前端（可复用现有 web/src）
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json    # 权限配置
│   └── src/
│       └── lib.rs          # Rust 后端入口
```

#### 3.1.2 Tauri 配置

**tauri.conf.json**:
```json
{
  "identifier": "com.claude-roam.app",
  "productName": "Claude Roam",
  "version": "0.1.0",
  "build": {
    "frontendDist": "../web/dist",
    "devUrl": "http://localhost:5173"
  },
  "bundle": {
    "icon": ["icons/icon.png"],
    "macOS": {
      "minimumSystemVersion": "10.15"
    }
  }
}
```

#### 3.1.3 权限配置 (Capabilities)

**src-tauri/capabilities/default.json**:
```json
{
  "identifier": "default",
  "description": "Claude Roam 默认权限",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "fs:default",
    "fs:allow-read-file",
    "fs:allow-read-dir",
    "fs:scope-home",
    "path:default",
    "sql:default"
  ]
}
```

> **重点**：Tauri 2 引入严格权限模型，必须明确授权 `~/.claude/projects` 目录的读取权限。

#### 3.1.4 废弃 Service Worker 缓存逻辑

当前 `web/src/PreviewApp.tsx` 依赖 `<script id="roam-data-base64">` 注入数据。在 Tauri 中：

1. 删除 base64 数据注入逻辑
2. 前端改为通过 `invoke('load_session', { sessionId })` 获取数据
3. Tauri 默认通过 `tauri://localhost` 协议加载资源，无需 SW 缓存

---

### 第二阶段：数据层重构 (Data Layer Offloading)

**目标**：从 IndexedDB 迁移到 SQLite，解决大数据量性能问题

#### 3.2.1 数据库 Schema 设计

```sql
-- sessions: 会话元数据
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    encoded_dir TEXT NOT NULL,
    line_count INTEGER DEFAULT 0,
    message_count INTEGER DEFAULT 0,
    type_string TEXT,           -- 用于 MiniMap 着色
    first_message TEXT,
    last_modified INTEGER,
    parsed_at INTEGER
);

-- messages: 消息分块存储
CREATE TABLE message_chunks (
    session_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    messages TEXT NOT NULL,     -- JSON 数组
    PRIMARY KEY (session_id, chunk_index),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- 全文搜索索引
CREATE VIRTUAL TABLE messages_fts USING fts5(
    session_id,
    content,
    tokenize='unicode61'
);

-- 索引优化
CREATE INDEX idx_sessions_directory ON sessions(encoded_dir);
CREATE INDEX idx_chunks_session ON message_chunks(session_id);
```

#### 3.2.2 前端 API 层改造

**现有代码** (`web/src/utils/messageStore.ts`):
```typescript
// IndexedDB 操作
export async function getMessagesInRange(
  sessionId: string,
  startIndex: number,
  endIndex: number
): Promise<DisplayMessage[]>
```

**迁移后** (`web/src/utils/tauriStore.ts`):
```typescript
import { invoke } from '@tauri-apps/api/core';

export async function getMessagesInRange(
  sessionId: string,
  startIndex: number,
  endIndex: number
): Promise<DisplayMessage[]> {
  return invoke('get_messages_range', {
    sessionId,
    startIndex,
    endIndex
  });
}

export async function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  return invoke('get_session_meta', { sessionId });
}

export async function searchMessages(
  sessionId: string,
  query: string
): Promise<number[]> {
  return invoke('search_messages', { sessionId, query });
}
```

#### 3.2.3 Rust 后端实现

**src-tauri/src/commands/messages.rs**:
```rust
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_sql::{Migration, MigrationKind, Pool};

#[derive(Serialize, Deserialize)]
pub struct DisplayMessage {
    display_type: String,
    blocks: Vec<ContentBlock>,
    tool_name: Option<String>,
    tool_id: Option<String>,
    tree_index: Option<u32>,
}

#[tauri::command]
pub async fn get_messages_range(
    pool: State<'_, Pool>,
    session_id: String,
    start_index: u32,
    end_index: u32,
) -> Result<Vec<DisplayMessage>, String> {
    let chunk_size = 100;
    let start_chunk = start_index / chunk_size;
    let end_chunk = end_index / chunk_size;

    let mut messages = Vec::new();

    for chunk_idx in start_chunk..=end_chunk {
        let row = sqlx::query_as::<_, (String,)>(
            "SELECT messages FROM message_chunks WHERE session_id = ? AND chunk_index = ?"
        )
        .bind(&session_id)
        .bind(chunk_idx)
        .fetch_optional(pool.inner())
        .await
        .map_err(|e| e.to_string())?;

        if let Some((json_str,)) = row {
            let chunk: Vec<DisplayMessage> = serde_json::from_str(&json_str)
                .map_err(|e| e.to_string())?;
            messages.extend(chunk);
        }
    }

    // 截取实际范围
    let local_start = (start_index % chunk_size) as usize;
    let local_end = messages.len().min((end_index - start_chunk * chunk_size + 1) as usize);

    Ok(messages[local_start..local_end].to_vec())
}
```

#### 3.2.4 虚拟滚动优化

当前 `SessionDetail.tsx` 使用 `@tanstack/react-virtual`，可以继续使用，但需要调整数据获取逻辑：

```typescript
// 修改前：从 IndexedDB 缓存获取
const msg = cacheRef.current?.getIfCached(index)

// 修改后：从 Rust 后端按需获取
const loadVisibleMessages = useCallback(async (range: Range) => {
  const start = Math.max(0, range.startIndex - 50);
  const end = Math.min(totalMessages - 1, range.endIndex + 50);

  const messages = await invoke<DisplayMessage[]>('get_messages_range', {
    sessionId,
    startIndex: start,
    endIndex: end
  });

  setVisibleMessages(prev => {
    const next = new Map(prev);
    messages.forEach((msg, i) => next.set(start + i, msg));
    return next;
  });
}, [sessionId, totalMessages]);
```

---

### 第三阶段：监听器革命 (The Observer Revolution)

**目标**：用 Rust 原生文件监听替代 CLI 的 `fs.watch` 轮询

#### 3.3.1 移除旧的监听逻辑

当前 `cli/src/daemon.ts` 使用 Node.js `fs.watch`：
```typescript
// 需要废弃
fs.watch(dirPath, (eventType, filename) => {
  if (!filename?.endsWith(".jsonl")) return;
  handleFileChange(filePath);
});
```

#### 3.3.2 Rust 文件监听器

使用 `notify` crate 实现高性能文件监听：

**Cargo.toml**:
```toml
[dependencies]
notify = "7.0"
tokio = { version = "1", features = ["full"] }
```

**src-tauri/src/watcher.rs**:
```rust
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher, Event, EventKind};
use std::path::Path;
use std::sync::mpsc;
use tauri::{AppHandle, Emitter};
use std::time::Duration;

pub struct SessionWatcher {
    watcher: RecommendedWatcher,
}

impl SessionWatcher {
    pub fn new(app: AppHandle) -> Result<Self, notify::Error> {
        let (tx, rx) = mpsc::channel();

        let watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = tx.send(event);
                }
            },
            Config::default()
                .with_poll_interval(Duration::from_millis(100))
        )?;

        // 启动事件处理线程
        let app_clone = app.clone();
        std::thread::spawn(move || {
            let mut debounce_map: HashMap<PathBuf, Instant> = HashMap::new();

            while let Ok(event) = rx.recv() {
                match event.kind {
                    EventKind::Modify(_) | EventKind::Create(_) => {
                        for path in event.paths {
                            if path.extension().map(|e| e == "jsonl").unwrap_or(false) {
                                let now = Instant::now();
                                // 100ms 防抖
                                if let Some(last) = debounce_map.get(&path) {
                                    if now.duration_since(*last) < Duration::from_millis(100) {
                                        continue;
                                    }
                                }
                                debounce_map.insert(path.clone(), now);

                                // 发送事件到前端
                                let session_id = path.file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("")
                                    .to_string();

                                let _ = app_clone.emit("session-changed", SessionChangeEvent {
                                    session_id,
                                    path: path.to_string_lossy().to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
        });

        Ok(Self { watcher })
    }

    pub fn watch_claude_projects(&mut self) -> Result<(), notify::Error> {
        let home = dirs::home_dir().expect("Could not find home directory");
        let projects_dir = home.join(".claude").join("projects");

        if projects_dir.exists() {
            self.watcher.watch(&projects_dir, RecursiveMode::Recursive)?;
        }

        Ok(())
    }
}

#[derive(Clone, serde::Serialize)]
struct SessionChangeEvent {
    session_id: String,
    path: String,
}
```

#### 3.3.3 前端事件监听

```typescript
import { listen } from '@tauri-apps/api/event';

useEffect(() => {
  const unlisten = listen<{ session_id: string; path: string }>(
    'session-changed',
    async (event) => {
      console.log('Session changed:', event.payload.session_id);

      // 触发增量解析
      await invoke('parse_session_incremental', {
        sessionId: event.payload.session_id
      });

      // 刷新当前视图
      if (event.payload.session_id === currentSessionId) {
        await refreshMessages();
      }
    }
  );

  return () => {
    unlisten.then(f => f());
  };
}, [currentSessionId]);
```

#### 3.3.4 增量解析优化

与其每次全量解析文件，Rust 后端可以记录上次解析位置，只解析新增内容：

```rust
#[tauri::command]
pub async fn parse_session_incremental(
    pool: State<'_, Pool>,
    session_id: String,
) -> Result<ParseResult, String> {
    // 获取上次解析位置
    let meta = get_session_meta(&pool, &session_id).await?;
    let last_line = meta.map(|m| m.line_count).unwrap_or(0);

    // 读取文件并只解析新增行
    let file_path = get_session_file_path(&session_id);
    let file = File::open(&file_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut new_messages = Vec::new();
    for (i, line) in reader.lines().enumerate() {
        if i < last_line as usize {
            continue; // 跳过已解析的行
        }

        if let Ok(line) = line {
            if let Ok(msg) = parse_json_line(&line) {
                new_messages.push(msg);
            }
        }
    }

    // 追加到数据库
    append_messages_to_db(&pool, &session_id, &new_messages, last_line).await?;

    Ok(ParseResult {
        new_messages: new_messages.len(),
        total_messages: last_line as usize + new_messages.len(),
    })
}
```

---

### 第四阶段：Artifact 与 Chatbox 融合 (The AI Powerhouse)

**目标**：赋予应用分析能力，支持上下文管理和智能分析

#### 3.4.1 上下文管理 (Context Manager)

当用户发起分析请求时，前端只发送 `sessionId`，Rust 后端负责：
1. 从 SQLite 读取完整会话文本
2. 在 Rust 内存中进行文本清洗
3. 提取结构化特征（如工具调用统计、成功路径）

```rust
#[derive(Serialize)]
pub struct SessionAnalysis {
    total_messages: u32,
    human_messages: u32,
    assistant_messages: u32,
    tool_calls: Vec<ToolCallStat>,
    success_paths: Vec<SuccessPath>,
    conversation_trees: u32,
    time_span: Option<TimeSpan>,
}

#[derive(Serialize)]
pub struct ToolCallStat {
    tool_name: String,
    call_count: u32,
    success_rate: f32,
}

#[derive(Serialize)]
pub struct SuccessPath {
    description: String,
    steps: Vec<String>,
    timestamp: String,
}

#[tauri::command]
pub async fn analyze_session(
    pool: State<'_, Pool>,
    session_id: String,
) -> Result<SessionAnalysis, String> {
    // 从数据库读取所有消息
    let messages = get_all_messages(&pool, &session_id).await?;

    // 在 Rust 中进行分析
    let analysis = analyze_messages(&messages)?;

    Ok(analysis)
}
```

#### 3.4.2 异步分析流

对于耗时分析任务，使用 Tauri Channel 实现流式进度反馈：

```rust
use tauri::ipc::Channel;

#[tauri::command]
pub async fn analyze_session_async(
    pool: State<'_, Pool>,
    session_id: String,
    progress: Channel<AnalysisProgress>,
) -> Result<SessionAnalysis, String> {
    progress.send(AnalysisProgress {
        stage: "loading".into(),
        percentage: 0,
        message: "Loading messages...".into(),
    }).ok();

    let messages = get_all_messages(&pool, &session_id).await?;

    progress.send(AnalysisProgress {
        stage: "analyzing".into(),
        percentage: 50,
        message: format!("Analyzing {} messages...", messages.len()),
    }).ok();

    let analysis = analyze_messages(&messages)?;

    progress.send(AnalysisProgress {
        stage: "complete".into(),
        percentage: 100,
        message: "Analysis complete".into(),
    }).ok();

    Ok(analysis)
}

#[derive(Clone, Serialize)]
pub struct AnalysisProgress {
    stage: String,
    percentage: u8,
    message: String,
}
```

前端调用：
```typescript
import { invoke, Channel } from '@tauri-apps/api/core';

const onProgress = new Channel<AnalysisProgress>();
onProgress.onmessage = (progress) => {
  setProgress(progress);
};

const analysis = await invoke('analyze_session_async', {
  sessionId,
  progress: onProgress,
});
```

---

## 4. 迁移步骤详解

### 4.1 第一阶段详细步骤

| 步骤 | 任务 | 预计改动 |
|------|-----|---------|
| 1.1 | 创建 Tauri 项目骨架 | 新增 `tauri-app/` 目录 |
| 1.2 | 配置 capabilities 权限 | 新增 `capabilities/default.json` |
| 1.3 | 移植前端代码 | 复用 `web/src`，修改入口 |
| 1.4 | 移除 Service Worker 逻辑 | 修改 `PreviewApp.tsx` |
| 1.5 | 添加基础 IPC 命令 | 新增 Rust commands |
| 1.6 | 测试基础功能 | 确保能打开并显示空白页面 |

### 4.2 第二阶段详细步骤

| 步骤 | 任务 | 预计改动 |
|------|-----|---------|
| 2.1 | 集成 tauri-plugin-sql | 修改 `Cargo.toml` |
| 2.2 | 设计并创建 SQLite Schema | 新增 migration 文件 |
| 2.3 | 实现 Rust 解析器 | 替代 `parserWorker.ts` |
| 2.4 | 创建数据 API | 新增 `messageStore` commands |
| 2.5 | 前端适配 invoke 调用 | 修改 `messageStore.ts` |
| 2.6 | 保留虚拟滚动逻辑 | `SessionDetail.tsx` 小改 |

### 4.3 第三阶段详细步骤

| 步骤 | 任务 | 预计改动 |
|------|-----|---------|
| 3.1 | 集成 notify crate | 修改 `Cargo.toml` |
| 3.2 | 实现文件监听器 | 新增 `watcher.rs` |
| 3.3 | 在应用启动时初始化监听 | 修改 `lib.rs` |
| 3.4 | 前端监听文件变化事件 | 新增 event listener |
| 3.5 | 实现增量解析 | 新增 `parse_session_incremental` |
| 3.6 | 移除旧 CLI daemon 依赖 | 可选，保留 CLI 兼容 |

### 4.4 第四阶段详细步骤

| 步骤 | 任务 | 预计改动 |
|------|-----|---------|
| 4.1 | 设计分析 API | 定义 `SessionAnalysis` 结构 |
| 4.2 | 实现基础统计 | 消息计数、工具调用统计 |
| 4.3 | 实现成功路径提取 | 分析对话树结构 |
| 4.4 | 添加异步进度反馈 | 使用 Tauri Channel |
| 4.5 | 前端展示分析结果 | 新增分析结果组件 |

---

## 5. 风险与缓解策略

| 风险 | 影响 | 缓解策略 |
|------|-----|---------|
| **Tauri 2 仍在 RC 阶段** | 可能有 API 变动 | 锁定版本，关注 release notes |
| **SQLite 并发写入** | 多窗口可能冲突 | 使用 WAL 模式 + 单写入线程 |
| **大文件解析内存占用** | 100MB+ 文件可能 OOM | 流式解析 + 分块存储 |
| **跨平台兼容性** | macOS/Windows/Linux 差异 | 使用 Tauri 内置抽象层 |
| **前端代码大量改动** | 可能引入 bug | 保持虚拟滚动等核心逻辑不变 |

---

## 6. 测试策略

### 6.1 单元测试

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_json_line() {
        let line = r#"{"uuid":"abc","type":"user","message":{"content":"hello"}}"#;
        let msg = parse_json_line(line).unwrap();
        assert_eq!(msg.display_type, "human");
    }

    #[test]
    fn test_incremental_parse() {
        // 测试增量解析逻辑
    }
}
```

### 6.2 集成测试

```typescript
// tests/tauri.test.ts
import { invoke } from '@tauri-apps/api/core';

describe('Tauri Commands', () => {
  it('should load session meta', async () => {
    const meta = await invoke('get_session_meta', {
      sessionId: 'test-session'
    });
    expect(meta).toBeDefined();
  });

  it('should handle large sessions', async () => {
    const messages = await invoke('get_messages_range', {
      sessionId: 'large-session',
      startIndex: 0,
      endIndex: 10000
    });
    expect(messages.length).toBeLessThanOrEqual(10001);
  });
});
```

### 6.3 性能基准测试

| 场景 | 当前方案 | 目标 |
|------|---------|------|
| 启动到首屏 | > 3s | < 500ms |
| 10000 消息解析 | 5-15s | < 1s |
| 文件变化到 UI 更新 | 2s+ (daemon debounce) | < 100ms |
| 全文搜索 10000 消息 | 2-5s | < 500ms |

---

## 7. 部署与分发

### 7.1 构建产物

```bash
# 开发环境
pnpm tauri dev

# 生产构建
pnpm tauri build

# 产物位置
tauri-app/src-tauri/target/release/bundle/
├── dmg/Claude Roam.dmg       # macOS
├── deb/claude-roam.deb       # Linux (Debian)
├── msi/Claude Roam.msi       # Windows
```

### 7.2 自动更新

使用 `tauri-plugin-updater`：

```json
// tauri.conf.json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://releases.claude-roam.com/{{target}}/{{arch}}/{{current_version}}"
      ],
      "pubkey": "..."
    }
  }
}
```

---

## 8. 附录

### 8.1 关键依赖版本

```toml
# Cargo.toml
[dependencies]
tauri = { version = "2.0.0-rc", features = ["protocol-asset"] }
tauri-plugin-sql = "2.0.0-rc"
notify = "7.0"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
sqlx = { version = "0.8", features = ["runtime-tokio", "sqlite"] }
```

### 8.2 参考资源

- [Tauri 2.0 Documentation](https://v2.tauri.app/)
- [tauri-plugin-sql](https://v2.tauri.app/plugin/sql/)
- [notify crate](https://docs.rs/notify/latest/notify/)
- [Tauri IPC](https://v2.tauri.app/develop/calling-rust/)

### 8.3 现有代码文件清单

需要迁移/修改的核心文件：

| 文件 | 作用 | 迁移策略 |
|------|-----|---------|
| `web/src/utils/parserWorker.ts` | Web Worker 解析 | 替换为 Rust 解析器 |
| `web/src/utils/messageStore.ts` | IndexedDB 存储 | 替换为 Tauri invoke |
| `web/src/pages/SessionDetail.tsx` | 会话详情页 | 保留虚拟滚动，改数据源 |
| `web/src/PreviewApp.tsx` | 预览入口 | 移除 base64 解码逻辑 |
| `cli/src/daemon.ts` | 文件监听 | 可选保留 CLI 模式 |
| `cli/src/scanner.ts` | 目录扫描 | Rust 实现替代 |

---

**文档版本**: 1.0
**创建日期**: 2026-01-29
**作者**: Claude (via Happy)
