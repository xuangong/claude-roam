# Claude Roam - Technical Specification

## 1. 系统架构

### 1.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Ubuntu Server                             │
│                                                             │
│   ┌─────────────┐    ┌─────────────┐    ┌───────────────┐  │
│   │   Web UI    │    │  FastAPI    │    │    SQLite     │  │
│   │   (Vite)    │◄──►│  Server     │◄──►│   roam.db     │  │
│   │   :80       │    │   :3000     │    │               │  │
│   └─────────────┘    └─────────────┘    └───────────────┘  │
│         ▲                   ▲                               │
└─────────┼───────────────────┼───────────────────────────────┘
          │                   │
          │      HTTPS (Nginx/Cloudflare Tunnel)
          │                   │
    ┌─────┴─────────────┬─────┴─────────────┐
    │                   │                   │
┌───┴───┐          ┌────┴────┐         ┌────┴────┐
│ macOS │          │  WSL2   │         │ Windows │
│       │          │         │         │         │
│ Bun   │          │  Bun    │         │  Bun    │
│ CLI   │          │  CLI    │         │  CLI    │
└───────┘          └─────────┘         └─────────┘
```

### 1.2 技术栈

| 组件 | 技术 | 版本 |
|------|------|------|
| Server | Python + FastAPI | Python 3.11+, FastAPI 0.115+ |
| 包管理 | uv | latest |
| 数据库 | SQLite + FTS5 | SQLite 3.35+ |
| CLI | Bun + TypeScript | Bun 1.0+ |
| Web UI | Vite + React | React 18+ |
| 部署 | systemd + Nginx | - |

---

## 2. 数据库设计

### 2.1 ER 图

```
┌──────────────────┐       ┌──────────────────┐
│     sessions     │       │     content      │
├──────────────────┤       ├──────────────────┤
│ session_id (PK)  │───┬──►│ session_id (PK)  │
│ summary          │   │   │ data (TEXT)      │
│ first_message    │   │   └──────────────────┘
│ total_lines      │   │
│ created_at       │   │   ┌──────────────────┐
│ updated_at       │   │   │    segments      │
└──────────────────┘   │   ├──────────────────┤
                       │   │ id (PK)          │
                       └──►│ session_id (FK)  │
                           │ from_line        │
                           │ to_line          │
                           │ machine_id       │
                           │ machine_name     │
                           │ platform         │
                           │ original_path    │
                           │ pushed_at        │
                           └──────────────────┘
```

### 2.2 Schema

```sql
-- sessions: 会话元信息
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,           -- UUID
    summary TEXT,                          -- 会话摘要（可选）
    first_message TEXT,                    -- 首条用户消息（用于展示）
    total_lines INTEGER DEFAULT 0,         -- 总行数
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- content: 会话内容（JSONL 整体存储）
CREATE TABLE content (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,                    -- 完整 JSONL 内容
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- segments: 行级来源追踪
CREATE TABLE segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    from_line INTEGER NOT NULL,            -- 起始行（inclusive, 1-based）
    to_line INTEGER NOT NULL,              -- 结束行（inclusive）
    machine_id TEXT NOT NULL,              -- 机器唯一标识
    machine_name TEXT,                     -- 机器可读名称
    platform TEXT,                         -- darwin | linux | wsl | win32
    original_path TEXT,                    -- 云端目录路径（映射后的 path）
    pushed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

-- 全文搜索 (session 元信息)
CREATE VIRTUAL TABLE sessions_fts USING fts5(
    session_id UNINDEXED,
    summary,
    first_message
);

-- 全文搜索 (对话内容)
CREATE VIRTUAL TABLE content_fts USING fts5(
    session_id UNINDEXED,
    data
);

-- 索引
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_segments_session ON segments(session_id);
```

---

## 3. API 设计

### 3.1 Base URL
```
http://<server>:3000/api
```

### 3.2 Endpoints

#### POST /sessions/{session_id}/push
上传会话内容（增量）

**Request:**
```typescript
{
  from_line: number        // 起始行号（1-based）
  append_data: string      // 新增的 JSONL 内容
  source: {
    machine_id: string     // 机器唯一 ID
    machine_name: string   // 机器名称
    platform: string       // darwin | linux | wsl | win32
    original_path: string  // 云端目录路径（映射后使用映射的 path）
  }
}
```

**Response:**
```typescript
{ ok: true }
```

**逻辑:**
```
1. 获取云端当前 total_lines
2. if session 不存在:
     创建新 session + content + segment
3. else if from_line <= total_lines (有冲突):
     截断 content 到 from_line - 1
     删除 from_line 之后的 segments
     追加新内容
4. else:
     直接追加内容（使用实际的 actual_from_line = total_lines + 1）
5. 添加新 segment
6. 更新 total_lines 和 updated_at
```

---

#### GET /sessions/{session_id}/pull
下载会话内容

**Query Params:**
```
from_line: number  // 可选，从第几行开始（用于增量下载）
```

**Response:**
```typescript
{
  data: string           // JSONL 内容
  meta: {
    session_id: string
    summary: string | null
    first_message: string | null
    total_lines: number
    created_at: string
    updated_at: string
  }
  segments: Array<{
    id: number
    from_line: number
    to_line: number
    machine_id: string
    machine_name: string | null
    platform: string | null
    original_path: string | null
    pushed_at: string
  }>
}
```

---

#### GET /sessions
列出会话

**Query Params:**
```
q: string       // 可选，搜索关键词
limit: number   // 可选，默认 50
offset: number  // 可选，默认 0
```

**Response:**
```typescript
{
  sessions: Array<{
    session_id: string
    summary: string | null
    first_message: string | null
    total_lines: number
    created_at: string
    updated_at: string
    machines: string | null      // 逗号分隔的机器名
    last_path: string | null     // 最后上传的路径
  }>
  total: number
  page: number
  limit: number
  has_more: boolean
}
```

---

#### GET /sessions/grouped
按机器和路径分组列出会话

**Response:**
```typescript
{
  sessions: Array<{
    session_id: string
    summary: string | null
    first_message: string | null
    total_lines: number
    created_at: string
    updated_at: string
    machine_name: string | null
    original_path: string | null
  }>
}
```

---

#### GET /sessions/by-dir
按云端目录查询会话（用于 pull 命令）

**Query Params:**
```
machine: string   // 机器名
path: string      // 原始路径
```

**Response:**
```typescript
{
  sessions: Array<{
    session_id: string
    summary: string | null
    first_message: string | null
    total_lines: number
    created_at: string
    updated_at: string
    machines: string | null
    last_path: string | null
  }>
}
```

---

#### GET /sessions/{session_id}
获取会话详情

**Response:**
```typescript
{
  session: {
    session_id: string
    summary: string | null
    first_message: string | null
    total_lines: number
    created_at: string
    updated_at: string
  }
  segments: Array<Segment>
}
```

---

#### DELETE /sessions/{session_id}
删除会话

**Response:**
```typescript
{ ok: true }
```

---

#### GET /search
全文搜索会话内容

**Query Params:**
```
q: string   // 搜索关键词
```

**Response:**
```typescript
{
  results: Array<{
    session_id: string
    summary: string | null
    first_message: string | null
    total_lines: number
    created_at: string
    updated_at: string
    machines: string | null
    last_path: string | null
    snippet: string | null      // 匹配的上下文片段（带高亮）
  }>
  total: number
}
```

---

#### GET /health
健康检查

**Response:**
```typescript
{ status: "ok" }
```

---

## 4. CLI 设计

### 4.1 命令列表

```bash
claude-roam push [options]      # 上传会话
claude-roam pull [options]      # 下载会话（基于目录映射）
claude-roam list [options]      # 列出会话
claude-roam map <subcommand>    # 目录映射管理
claude-roam clean [session-id]  # 删除本地会话
claude-roam daemon [options]    # 后台同步
claude-roam status              # 查看状态
```

### 4.2 命令详情

#### push
```bash
claude-roam push              # 上传当前目录的 session
claude-roam push --all        # 上传所有本地 session
claude-roam push -s <id>      # 上传指定 session
claude-roam push --force      # 强制重新上传当前目录（不能与 --all 同时使用）
claude-roam push -c <n>       # 指定并发数（默认 20）
```

#### pull
```bash
claude-roam pull              # 拉取当前目录映射的云端目录的 session
claude-roam pull --all        # 拉取所有已映射目录的 session
claude-roam pull -y           # 跳过冲突确认
claude-roam pull -c <n>       # 指定并发数（默认 20）
```

**注意**: 不支持 `pull <session-id>`，必须先建立目录映射。

#### list
```bash
claude-roam list              # 列出远程 session
claude-roam list -l           # 列出本地 session
claude-roam list -g           # 按云端目录分组显示
claude-roam list -q "keyword" # 搜索
claude-roam list --json       # JSON 输出
claude-roam list -a           # 显示所有（不分页）
claude-roam list -n <n>       # 每页数量（默认 10）
claude-roam list -p <n>       # 页码（默认 1）
```

#### map
```bash
claude-roam map list          # 列出所有目录映射
claude-roam map add <remote>  # 添加映射（当前目录 -> 云端目录）
claude-roam map remove        # 删除当前目录的映射
claude-roam map show          # 显示当前目录的映射
```

**映射格式**: `machine_name:original_path`
**示例**: `claude-roam map add "alice-mac:/Users/alice/projects/foo"`

#### clean
```bash
claude-roam clean <session-id>  # 删除指定 session
claude-roam clean               # 删除当前目录的 session
claude-roam clean --all         # 删除所有本地 session
claude-roam clean -y            # 跳过确认
```

#### daemon
```bash
claude-roam daemon            # 前台运行
claude-roam daemon --detach   # 后台运行（未实现）
```

#### status
```bash
claude-roam status            # 显示机器信息、同步状态
```

### 4.3 配置

**环境变量:**
```bash
ROAM_API=http://your-server:3000  # API 地址
ROAM_MACHINE_NAME=my-macbook      # 可选，机器名称
```

**状态文件:** `~/.claude-roam/state.json`
```typescript
{
  machine_id: string           // 自动生成的 UUID
  machine_name: string         // 机器名称

  // 目录映射：本地目录 -> 云端目录标识
  dirMappings: {
    [localDir: string]: string  // "machine_name:original_path"
  }

  // Session 同步状态
  sessions: {
    [session_id: string]: {
      lastLine: number         // 已同步到的行号
      localPath: string        // 本地文件路径
    }
  }
}
```

### 4.4 路径处理

**编码函数:**
```typescript
function encodePathForClaude(absPath: string): string {
  // /home/user/code → -home-user-code
  // C:\Users\foo    → -C-Users-foo
  return absPath
    .replace(/^\//, "-")
    .replace(/^([A-Z]):/i, "-$1")
    .replace(/[\\/]/g, "-")
}
```

**解码函数:**
```typescript
function decodeClaudePath(encoded: string): string {
  // -home-user-code → /home/user/code
  // -C-Users-foo    → C:/Users/foo
  const decoded = encoded.replace(/^-/, "/").replace(/-/g, "/")
  // Windows 特殊处理
  if (/^\/[A-Z]\//.test(decoded)) {
    return decoded.replace(/^\/([A-Z])\//, "$1:/")
  }
  return decoded
}
```

**注意**: 路径编码存在歧义问题（如 `claude-roam` 会被解码为 `claude/roam`），因此匹配时使用 `encodedDir` 而不是解码后的路径。

**平台检测:**
```typescript
function detectPlatform(): "darwin" | "linux" | "wsl" | "win32" {
  if (process.platform === "win32") return "win32"
  if (process.platform === "darwin") return "darwin"

  // 检测 WSL
  const release = os.release().toLowerCase()
  if (release.includes("microsoft") || release.includes("wsl")) {
    return "wsl"
  }
  return "linux"
}
```

### 4.5 目录映射逻辑

**Push 时的 original_path 决定:**
```typescript
// 如果当前目录有映射 -> 使用映射的云端目录 path
// 否则使用本地目录
let originalPath: string;
const mapping = getDirMapping(sessionLocalDir);
if (mapping) {
  const parsed = parseRemoteDir(mapping);  // "machine:path" -> { machine, path }
  originalPath = parsed ? parsed.path : sessionLocalDir;
} else {
  originalPath = sessionLocalDir;
}
```

**Pull 时的工作流:**
```typescript
// 1. 获取当前目录的映射
const mapping = getDirMapping(currentDir);
if (!mapping) {
  console.log("No mapping found. Use 'map add' first.");
  return;
}

// 2. 解析映射获取云端目录
const { machine, path } = parseRemoteDir(mapping);

// 3. 调用 API 获取该云端目录的所有 session
const sessions = await listSessionsByDir(machine, path);

// 4. 下载到本地
for (const session of sessions) {
  const response = await pullSession(session.session_id);
  const filePath = getSessionFilePath(session.session_id, currentDir);
  fs.writeFileSync(filePath, response.data);
}
```

---

## 5. Web UI 设计

### 5.1 页面结构

```
/                    # 会话列表页（按目录分组）
/sessions/:id        # 会话详情页
```

### 5.2 会话列表页

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Roam                              [搜索: ________]  │
├─────────────────────────────────────────────────────────────┤
│  125 sessions total                                         │
│                                                             │
│  ▼ Machine: alice-mac (80)                                  │
│    ├─ ▼ projects/foo (3)                    [📋 Copy Map]   │
│    │    ├─ ba2699dc... "调研claude code的对话历史..."        │
│    │    ├─ cd5ed772... "帮我实现用户认证功能"                 │
│    │    └─ ...                                              │
│    ├─ ▶ projects/bar (5)                    [📋 Copy Map]   │
│    └─ ▶ work/demo (2)                       [📋 Copy Map]   │
│                                                             │
│  ▼ Machine: bob-linux (45)                                  │
│    └─ ...                                                   │
└─────────────────────────────────────────────────────────────┘
```

**Copy Map 按钮**: 点击复制 `claude-roam map add "machine:path"` 命令

### 5.3 会话详情页

```
┌─────────────────────────────────────────────────────────────┐
│  ← Back                                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Session: ba2699dc-37bc-4974-a422-7989f0d4fabc             │
│  Lines: 49 | Created: 2026-01-23 10:00                      │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  Source History:                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Lines 1-30  │ macbook  │ /Users/xanzh/code │ 10:00  │   │
│  │ Lines 31-49 │ wsl2     │ /home/xanzh       │ 12:00  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│  Preview:                                                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ User: 调研claude code的对话历史是怎么管理的          │   │
│  │ Assistant: 我来帮你调研 Claude Code...               │   │
│  │ ...                                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**注意**: 详情页不再显示 `pull <session-id>` 命令，因为 pull 必须基于目录映射。

---

## 6. 部署架构

### 6.1 目录结构

```
/home/ubuntu/claude-roam/
├── server/
│   ├── app/
│   ├── roam.db
│   └── pyproject.toml
├── web/
│   └── dist/           # 构建产物
└── nginx.conf
```

### 6.2 Nginx 配置

```nginx
server {
    listen 80;
    server_name roam.example.com;

    # Web UI
    location / {
        root /home/ubuntu/claude-roam/web/dist;
        try_files $uri $uri/ /index.html;
    }

    # API
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 6.3 Systemd Service

```ini
# /etc/systemd/system/claude-roam.service
[Unit]
Description=Claude Roam Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/claude-roam/server
ExecStart=/home/ubuntu/.local/bin/uv run uvicorn app.main:app --host 127.0.0.1 --port 3000
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

---

## 7. 错误处理

### 7.1 API 错误码

| HTTP Status | 场景 |
|-------------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 404 | Session 不存在 |
| 500 | 服务器内部错误 |

### 7.2 CLI 错误处理

```typescript
// 网络错误 - 自动重试
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i === maxRetries - 1) throw e
      await Bun.sleep(1000 * (i + 1))  // 指数退避
    }
  }
  throw new Error("unreachable")
}
```

### 7.3 并行任务处理

```typescript
// 带并发限制的并行执行
async function parallelLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]>
```

---

## 8. 测试计划

### 8.1 单元测试

| 模块 | 测试内容 |
|------|---------|
| db.py | 数据库初始化、CRUD、按目录查询 |
| sync.py | push 逻辑、冲突处理、行号修正 |
| path.ts | 路径编码/解码 |
| api.ts | API 调用 |
| state.ts | 目录映射管理 |

### 8.2 集成测试

| 场景 | 步骤 |
|------|------|
| 正常 push | 本地新建 session → push → 验证云端 |
| 映射 push | 建立映射 → push → 验证 original_path 是云端目录的 path |
| 映射 pull | 建立映射 → pull → 验证下载到正确位置 |
| 冲突 push | A push → B 映射 pull → A push → B push → 验证覆盖 |
| 跨平台 | Mac push → Linux 映射 pull → 验证路径 |

### 8.3 端到端测试

| 场景 | 验证 |
|------|------|
| 完整流程 | daemon 启动 → Claude 使用 → 自动同步 → Web 查看 → Copy Map → 映射 → pull → resume |

---

## 9. 后续优化

### 9.1 计划中
- [ ] 认证机制（API Key / OAuth）
- [ ] 会话压缩存储
- [ ] 移动端 Web 适配

### 9.2 考虑中
- [ ] 会话分享（公开链接）
- [ ] 会话标签/分组
- [ ] 自动摘要生成
- [ ] 多用户支持
