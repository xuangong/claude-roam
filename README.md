# Claude Roam

Claude Code 会话历史漫游同步工具 - 让你在多台机器间同步和恢复 Claude Code 会话历史。

## 功能特性

- **自动上传同步 (Push)**: CLI 后台监控本地会话文件变化，自动增量上传到云端
- **下载恢复 (Pull)**: 在任意机器的任意目录下恢复会话
- **Web UI 搜索浏览**: 通过 Web 界面搜索、浏览所有同步的会话历史
- **行级来源追踪**: 记录每段内容来自哪台机器
- **跨平台支持**: macOS、Linux、WSL2、Windows

## 项目结构

```
claude-roam/
├── server/          # FastAPI 后端服务器
│   ├── app/         # 应用代码
│   └── tests/       # 后端测试
├── cli/             # Bun + TypeScript CLI 工具
│   └── src/         # CLI 源代码
├── web/             # Vite + React 前端
│   └── src/         # 前端源代码
└── e2e/             # 端到端测试
```

## 快速开始

### 服务器部署

```bash
cd server
uv sync
uv run uvicorn app.main:app --host 0.0.0.0 --port 3000
```

### CLI 安装

```bash
cd cli
bun install
bun build src/index.ts --outdir dist --target bun

# 设置环境变量
export ROAM_API=http://your-server:3000
```

### CLI 使用

```bash
# 启动后台同步守护进程
claude-roam daemon

# 手动推送会话
claude-roam push

# 拉取会话到当前目录
claude-roam pull <session-id>

# 列出远程会话
claude-roam list

# 查看同步状态
claude-roam status
```

### Web UI 开发

```bash
cd web
pnpm install
pnpm dev
```

访问 http://localhost:5173

### Web UI 构建

```bash
cd web
pnpm build
# 构建产物在 dist/ 目录
```

## API 端点

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | /api/health | 健康检查 |
| POST | /api/sessions/{id}/push | 上传会话内容 |
| GET | /api/sessions/{id}/pull | 下载会话内容 |
| GET | /api/sessions | 列出会话 |
| GET | /api/sessions/{id} | 获取会话详情 |
| DELETE | /api/sessions/{id} | 删除会话 |

## 测试

### 后端测试

```bash
cd server
uv run pytest --cov=app
```

### CLI 测试

```bash
cd cli
bun test --coverage
```

### 前端测试

```bash
cd web
pnpm test
```

## 测试覆盖率

- 后端: 95%
- CLI: 93%
- 前端: 87%

## 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| ROAM_API | 服务器 API 地址 | - |
| ROAM_MACHINE_NAME | 机器名称 | hostname |

## 技术栈

- **后端**: Python 3.11+, FastAPI, SQLite, aiosqlite
- **CLI**: Bun, TypeScript, Commander.js
- **前端**: React 18, Vite, React Router
- **测试**: pytest, vitest, bun:test

## License

MIT
