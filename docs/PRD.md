# Claude Roam - Product Requirements Document (PRD)

## 概述

### 项目名称
Claude Roam - Claude Code 会话历史漫游同步工具

### 问题陈述
Claude Code 的会话历史存储在本地 `~/.claude/projects/` 目录下，与特定目录绑定。用户在多台机器（Mac、Windows、WSL2、Linux）之间切换工作时，无法访问其他机器上的会话历史，也无法在不同目录下恢复之前的对话上下文。

### 目标用户
- 使用 Claude Code 的个人开发者
- 在多台设备间切换工作的用户
- 需要跨项目复用对话上下文的用户

### 核心价值
1. **跨机器同步** - 在任意设备访问所有会话历史
2. **目录映射** - 不同机器的不同目录可以映射到同一个云端目录
3. **可搜索** - 通过 Web UI 搜索和浏览所有历史会话
4. **自动化** - 后台自动同步，无需手动操作

---

## 核心概念

### 云端目录 (Cloud Directory)
- 格式：`machine_name:original_path`
- 示例：`alice-mac:/Users/alice/projects/foo`
- 由第一次 push 的机器和路径决定，永久不变
- 是 session 归属的唯一标识

### 目录映射 (Directory Mapping)
- 本地目录与云端目录的对应关系
- 一个本地目录只能映射到一个云端目录
- 映射后，push 会贡献到云端目录，pull 会拉取云端目录的所有 session

### 工作流示例
```
机器 A (alice-mac):
  /Users/alice/projects/foo  →  创建云端目录 "alice-mac:/Users/alice/projects/foo"

机器 B (bob-linux):
  /home/bob/work/foo  →  映射到 "alice-mac:/Users/alice/projects/foo"

两台机器的 session 都归属于同一个云端目录，可以相互同步
```

---

## 功能需求

### F1: 自动上传同步 (Push)

**描述**: CLI 后台监控本地 Claude Code 会话文件变化，自动增量上传到云端服务器。

**用户故事**:
- 作为用户，我希望本地的会话能自动同步到云端，无需手动操作
- 作为用户，我希望只上传增量内容，节省带宽和时间
- 作为用户，我希望映射后的目录 push 能贡献到云端原始目录

**功能细节**:
| 项目 | 说明 |
|------|------|
| 监控目录 | `~/.claude/projects/**/*.jsonl` |
| 触发条件 | 文件新增或修改 |
| 防抖机制 | 文件变化后等待 2 秒稳定再上传 |
| 增量上传 | 记录已同步行数，只上传新增行 |
| 来源追踪 | 记录机器 ID、机器名、平台、原始路径 |
| 目录映射 | 如果本地目录有映射，使用云端目录的 path 作为 original_path |

**命令**:
```bash
claude-roam push              # 上传当前目录的 session
claude-roam push --all        # 上传所有本地 session
claude-roam push -s <id>      # 上传指定 session
claude-roam push --force      # 强制重新上传（当前目录）
claude-roam push -c 20        # 指定并发数（默认 20）
```

**验收标准**:
- [x] daemon 启动后自动监控文件变化
- [x] 新增/修改的 session 在 5 秒内开始上传
- [x] 只上传增量内容，不重复上传
- [x] 上传失败时自动重试（最多 3 次）
- [x] 支持 Mac、Linux、WSL2、Windows 四种平台
- [x] 支持并行上传

---

### F2: 目录映射 (Map)

**描述**: 建立本地目录与云端目录的映射关系，实现跨机器的目录同步。

**用户故事**:
- 作为用户，我希望在机器 B 上映射机器 A 的目录，共享 session
- 作为用户，我希望映射后的 push/pull 自动基于映射关系工作

**功能细节**:
| 项目 | 说明 |
|------|------|
| 映射格式 | `machine_name:original_path` |
| 存储位置 | `~/.claude-roam/state.json` 的 `dirMappings` |
| 约束 | 一个本地目录只能映射一个云端目录 |

**命令**:
```bash
claude-roam map list                                    # 列出所有映射
claude-roam map add "alice-mac:/Users/alice/projects/foo"  # 添加映射
claude-roam map remove                                  # 删除当前目录的映射
claude-roam map show                                    # 显示当前目录的映射
```

**验收标准**:
- [x] 映射信息持久化存储
- [x] 支持添加、删除、查看映射
- [x] 映射后 push 使用云端目录的 path
- [x] 映射后 pull 拉取云端目录的 session

---

### F3: 下载恢复 (Pull)

**描述**: 基于目录映射，从云端拉取 session 到本地。

**用户故事**:
- 作为用户，我希望 pull 基于目录映射工作，自动拉取正确的 session
- 作为用户，我希望 pull 能检测冲突并提示确认

**功能细节**:
| 项目 | 说明 |
|------|------|
| 前提条件 | 当前目录必须有映射（通过 `map add` 建立） |
| 存储位置 | `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` |
| 冲突处理 | 本地已存在的文件会提示确认覆盖 |

**命令**:
```bash
claude-roam pull              # 拉取当前目录映射的云端目录的所有 session
claude-roam pull --all        # 拉取所有已映射目录的 session
claude-roam pull -y           # 跳过冲突确认
claude-roam pull -c 20        # 指定并发数（默认 20）
```

**注意**: 不支持 `pull <session-id>`，必须通过目录映射拉取。

**验收标准**:
- [x] pull 必须基于目录映射
- [x] pull 后文件存储在正确位置
- [x] `claude --resume <session-id>` 能正常恢复会话
- [x] 跨平台路径正确处理
- [x] 支持并行下载

---

### F4: Web UI 搜索和浏览

**描述**: 提供 Web 界面，用户可以搜索、浏览所有同步的会话历史。

**用户故事**:
- 作为用户，我希望通过关键词搜索找到特定会话
- 作为用户，我希望查看会话来自哪台机器、哪个目录
- 作为用户，我希望预览会话内容
- 作为用户，我希望一键复制目录映射命令

**功能细节**:

**会话列表页**:
- 按机器和目录分组显示
- 支持展开/折叠
- 每个目录显示 "Copy Map" 按钮，复制映射命令
- 支持全文搜索

**会话详情页**:
- 显示完整元信息
- 显示来源追踪（哪些行来自哪台机器）
- 对话预览

**验收标准**:
- [x] 搜索响应时间 < 500ms
- [x] 列表按目录分组显示
- [x] 详情页显示完整 segment 信息
- [x] 提供一键复制映射命令

---

### F5: 本地清理 (Clean)

**描述**: 删除本地的 session 文件。

**命令**:
```bash
claude-roam clean <session-id>   # 删除指定 session
claude-roam clean                # 删除当前目录的所有 session
claude-roam clean --all          # 删除所有本地 session
claude-roam clean -y             # 跳过确认
```

**验收标准**:
- [x] 删除前显示确认提示
- [x] 同时清理 state 中的同步记录

---

### F6: 行级来源追踪

**描述**: 记录每一段内容来自哪台机器，支持多机器协作场景。

**用户故事**:
- 作为用户，我希望知道会话的哪部分来自哪台机器
- 作为用户，我希望冲突时后上传的内容覆盖之前的

**功能细节**:
| 项目 | 说明 |
|------|------|
| 追踪粒度 | 行范围 (segments) |
| 冲突策略 | Last Write Wins - 后上传覆盖重叠部分 |
| 记录信息 | machine_id, machine_name, platform, original_path, pushed_at |

**场景示例**:
```
T1: 机器 A push lines 1-10   → segments: [{1-10, A}]
T2: 机器 B pull (建立映射)
T3: 机器 A push lines 11-20  → segments: [{1-10, A}, {11-20, A}]
T4: 机器 B push lines 11-25  → segments: [{1-10, A}, {11-25, B}]
                                (A 的 11-20 被 B 覆盖)
```

**验收标准**:
- [x] segments 正确记录每段来源
- [x] 冲突时正确截断并覆盖
- [x] Web UI 正确显示来源信息

---

### F7: 跨平台支持

**描述**: CLI 工具支持 macOS、Linux、WSL2、Windows 四种平台。

**平台差异处理**:
| 平台 | Claude 目录 | 路径编码示例 |
|------|------------|-------------|
| macOS | `~/.claude/projects/` | `-Users-alice-code` |
| Linux | `~/.claude/projects/` | `-home-alice-code` |
| WSL2 | `~/.claude/projects/` | `-home-alice-code` |
| Windows | `%USERPROFILE%\.claude\projects\` | `-C-Users-alice-code` |

**验收标准**:
- [x] 各平台正确识别 Claude 目录
- [x] 路径编码/解码正确
- [x] daemon 在各平台正常运行

---

## 非功能需求

### 性能
- 单次 push 请求 < 2s（100KB 以内）
- 搜索响应 < 500ms
- 支持 10,000+ 会话存储
- 支持并行上传/下载（默认 20 并发）

### 可靠性
- 上传失败自动重试
- daemon 异常退出自动重启
- 数据持久化（SQLite）

### 安全性
- 个人使用，暂不考虑认证（后续可加）
- 数据仅存储在用户自己的服务器

---

## 用户流程

### 流程 1: 首次设置
```
1. 用户在服务器部署 server
2. 用户在各机器安装 CLI
3. 配置 ROAM_API 环境变量
4. 启动 daemon 开始同步
```

### 流程 2: 日常使用 (自动)
```
1. 用户正常使用 Claude Code
2. daemon 自动检测文件变化
3. 增量上传到服务器
4. 用户无感知
```

### 流程 3: 跨机器恢复 (目录映射)
```
# 机器 B 想同步机器 A 的 session

1. 在机器 B 上查看云端目录
   claude-roam list -g

2. 建立目录映射
   cd /home/bob/work/foo
   claude-roam map add "alice-mac:/Users/alice/projects/foo"

3. 拉取 session
   claude-roam pull

4. 恢复会话
   claude --resume <session-id>

5. 后续 push 会贡献到 alice-mac 的目录
   claude-roam push
```

---

## 里程碑

| 阶段 | 内容 | 状态 |
|------|------|------|
| M1 | Server API + 数据库 | 完成 |
| M2 | CLI push/pull/list | 完成 |
| M3 | CLI daemon 自动同步 | 完成 |
| M4 | Web UI 基础版 | 完成 |
| M5 | 跨平台测试 | 完成 |
| M6 | 目录映射系统 | 完成 |
| M7 | 并行上传/下载 | 完成 |
| M8 | 本地清理命令 | 完成 |

---

## 附录

### 术语表
| 术语 | 定义 |
|------|------|
| Session | Claude Code 的一次会话，对应一个 `.jsonl` 文件 |
| Segment | 会话内容的一个片段，记录来源信息 |
| Push | 上传本地会话到云端 |
| Pull | 从云端下载会话到本地 |
| Daemon | 后台常驻进程，自动监控和同步 |
| Cloud Directory | 云端目录，格式为 `machine_name:original_path` |
| Directory Mapping | 本地目录到云端目录的映射关系 |
