# Claude Code 对话树结构与重建原理

## 概述

Claude Code 的会话历史存储在 JSONL 文件中，每行是一个 JSON 对象。与简单的线性聊天记录不同，Claude Code 使用**树形结构**来组织对话，支持对话分支、压缩（compact）等高级功能。

## 存储位置

```
~/.claude/projects/<encoded-path>/<session-id>.jsonl
```

其中 `<encoded-path>` 是项目路径的编码形式（`/` 替换为 `-`）。

## 消息结构

### 基本字段

每条消息都包含以下关键字段：

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "parentUuid": "550e8400-e29b-41d4-a716-446655440001",
  "type": "user" | "assistant" | "summary" | "system" | ...,
  "timestamp": "2026-01-25T10:30:00.000Z",
  "message": { ... }
}
```

| 字段 | 说明 |
|------|------|
| `uuid` | 消息的唯一标识符 |
| `parentUuid` | 父消息的 UUID，构成树形关系 |
| `type` | 消息类型 |
| `timestamp` | ISO 8601 格式的时间戳 |
| `message` | 消息内容（包含 role 和 content） |

### 消息类型

| 类型 | 说明 |
|------|------|
| `user` | 用户输入 |
| `assistant` | Claude 的回复 |
| `summary` | 压缩后的对话摘要 |
| `system` | 系统消息 |
| `file-history-snapshot` | 文件历史快照 |
| `queue-operation` | 队列操作 |

## 树形结构

### 基本概念

```
         [root-1]              [root-2]
            │                     │
         [msg-a]               [msg-x]
           / \                    │
      [msg-b] [msg-c]          [msg-y]
         │       │
      [msg-d] [msg-e]  ← 叶子节点
```

- **根节点（Root）**: `parentUuid` 为 `null` 的消息
- **叶子节点（Leaf）**: 没有子节点的消息（没有其他消息的 `parentUuid` 指向它）
- **对话链（Chain）**: 从根到叶子的一条路径
- **分支（Branch）**: 同一个父节点下的多个子节点

### 多棵独立的树

一个 session 文件可能包含**多棵独立的对话树**：

- 每次用户开始全新对话（不是从历史继续），会创建新的根节点
- 每棵树代表一次独立的对话会话
- 树之间没有父子关系

### Summary（压缩摘要）

当对话过长时，Claude Code 会自动压缩旧的对话分支：

```json
{
  "type": "summary",
  "summary": "讨论了 React 性能优化的几种方案...",
  "leafUuid": "550e8400-e29b-41d4-a716-446655440099"
}
```

| 字段 | 说明 |
|------|------|
| `summary` | 压缩后的文字摘要 |
| `leafUuid` | 被压缩的对话链的叶子节点 UUID |

**注意**：Summary 没有 `uuid` 字段，它不是树的一部分，而是对某个分支的描述。

### 分支（Branch）

分支是指从同一个父消息分叉出的多条对话路径。

**分支产生的方式**：

1. **Esc 选择 checkpoint**：在 Claude Code 中按 Esc 打开历史消息选择器，选择之前的某条消息继续对话
2. **重新生成回复**：让 Claude 重新回答同一个问题

**示例**：

```
用户: "帮我写排序"           [msg-1] parentUuid=null
        ↓
Claude: "这是冒泡排序..."    [msg-2] parentUuid=msg-1
        ↓                       ↘
用户: "改成快排"              用户: "改成归并"     ← 分支！
[msg-3] parentUuid=msg-2      [msg-5] parentUuid=msg-2
        ↓                            ↓
Claude: "快排代码..."         Claude: "归并代码..."
[msg-4]                       [msg-6]
```

`msg-2` 有两个子节点 `msg-3` 和 `msg-5`，形成两个分支。

## Compaction 与数据丢失

### Compaction 触发条件

当上下文窗口达到约 95% 时，Claude Code 会自动触发 compaction：
- 创建 `summary` 消息记录被压缩分支的摘要
- `leafUuid` 指向被压缩分支的叶子节点

### 原始消息的保留与删除

**关键发现**：Compaction 本身**不会立即删除**原始消息。删除发生在**分支切换**时。

| 场景 | 结果 |
|------|------|
| 线性聊天（一直在最新叶子上继续） | ✅ 原始消息**保留** |
| 切换分支（选择历史 checkpoint 继续） | ⚠️ 旧分支消息**可能被删除** |

**验证数据**：
- 当前 session 有 61 个 summary，全部 intact（原始消息都在）—— 因为一直线性聊天
- 分析 122 个问题文件，76% 的文件中 summary 在开头，后面紧跟新 root 消息 —— 说明切换分支后旧消息被删除

### 分支切换导致的数据丢失

当用户通过 Esc 选择历史 checkpoint 继续对话时：

```
压缩前：
[msg-1] → [msg-2] → [msg-3] → ... → [msg-100]  ← 深入的对话
              ↘
               [msg-新]  ← 用户从 msg-2 分叉

切换分支后，Claude Code 可能：
1. 保留 [msg-新] 所在的新分支
2. 删除 [msg-3] 到 [msg-100] 的原始消息
3. 只保留指向 msg-100 的 summary
```

**结果**：用户再也无法回到 msg-3 到 msg-100 那条深入的讨论了。

### Session 清理

除了分支切换，还有一种数据丢失场景：

- `cleanupPeriodDays` 设置（默认 30 天）
- Claude Code 启动时检查，删除超过指定天数未活跃的**整个 session 文件**

### 危险操作总结

| 操作 | 风险 |
|------|------|
| 一直在最新消息后继续聊 | ✅ 安全 |
| Esc 中断 Claude 回复 | ✅ 安全 |
| Esc 选择历史 checkpoint 继续 | ⚠️ 可能丢失旧分支 |
| 30 天不活跃 | ⚠️ 整个 session 被删除 |

### 备份建议

由于分支切换可能导致不可逆的数据丢失，建议：

1. 使用 `claude-roam backup run` 定期备份
2. 设置自动备份（`claude-roam backup setup-cron`）
3. 重要对话主动导出（`claude-roam export`）

## 对话树重建算法

### 目标

从 JSONL 文件重建完整的对话视图：
1. 识别所有独立的对话树
2. 对每棵树，找到当前活跃的对话链
3. 显示被压缩分支的摘要
4. 按时间正序排列（旧的对话在前，符合自然阅读顺序）

### 算法步骤

#### 第一步：解析消息并构建映射

```typescript
const messageMap = new Map<string, Message>()  // uuid -> message
const childrenMap = new Map<string, string[]>() // parentUuid -> [childUuids]
const summaries: Summary[] = []

for (const line of jsonlLines) {
  const obj = JSON.parse(line)

  if (obj.type === 'summary') {
    summaries.push(obj)
    continue
  }

  if (obj.uuid) {
    messageMap.set(obj.uuid, obj)

    const parentId = obj.parentUuid || 'ROOT'
    if (!childrenMap.has(parentId)) {
      childrenMap.set(parentId, [])
    }
    childrenMap.get(parentId).push(obj.uuid)
  }
}
```

#### 第二步：找到所有根节点

```typescript
const rootUuids = childrenMap.get('ROOT') || []
// rootUuids 是所有 parentUuid 为 null 的消息
```

#### 第三步：找到所有叶子节点

```typescript
const allUuids = new Set(messageMap.keys())
const parentUuids = new Set<string>()

for (const msg of messageMap.values()) {
  if (msg.parentUuid) {
    parentUuids.add(msg.parentUuid)
  }
}

// 叶子节点 = 所有节点 - 作为父节点出现过的节点
const leafUuids = new Set<string>()
for (const uuid of allUuids) {
  if (!parentUuids.has(uuid)) {
    leafUuids.add(uuid)
  }
}
```

#### 第四步：按根节点分组

```typescript
// 辅助函数：找到消息的根节点
function getRoot(uuid: string): string | null {
  let current = uuid
  while (current && messageMap.has(current)) {
    const msg = messageMap.get(current)
    if (!msg.parentUuid) return current
    current = msg.parentUuid
  }
  return null
}

// 将叶子节点按根分组
const leavesByRoot = new Map<string, string[]>()
for (const leaf of leafUuids) {
  const root = getRoot(leaf)
  if (root) {
    if (!leavesByRoot.has(root)) {
      leavesByRoot.set(root, [])
    }
    leavesByRoot.get(root).push(leaf)
  }
}

// 将 summary 按根分组
const summariesByRoot = new Map<string, Summary[]>()
for (const summary of summaries) {
  if (summary.leafUuid) {
    const root = getRoot(summary.leafUuid)
    if (root) {
      if (!summariesByRoot.has(root)) {
        summariesByRoot.set(root, [])
      }
      summariesByRoot.get(root).push(summary)
    }
  }
}
```

#### 第五步：按时间排序树

```typescript
// 每棵树的"时间"是其最新叶子节点的时间戳
const rootsWithTime: [string, string][] = []

for (const root of rootUuids) {
  const leaves = leavesByRoot.get(root) || []
  let latestTime = ''

  for (const leaf of leaves) {
    const msg = messageMap.get(leaf)
    if (msg?.timestamp && msg.timestamp > latestTime) {
      latestTime = msg.timestamp
    }
  }

  rootsWithTime.push([root, latestTime])
}

// 按时间正序排列（旧的在前，符合自然阅读顺序）
rootsWithTime.sort((a, b) => a[1].localeCompare(b[1]))
```

#### 第六步：重建对话链

```typescript
// 从叶子节点回溯到根节点，构建对话链
function buildChain(leafUuid: string): Message[] {
  const chain: Message[] = []
  let current = leafUuid

  while (current) {
    const msg = messageMap.get(current)
    if (msg) {
      chain.unshift(msg)  // 添加到开头
      current = msg.parentUuid
    } else {
      break
    }
  }

  return chain
}
```

#### 第七步：组装最终结果

```typescript
const result: Message[] = []

for (const [root, _] of rootsWithTime) {
  const leaves = leavesByRoot.get(root) || []
  const treeSummaries = summariesByRoot.get(root) || []

  // 找到最新的叶子节点（当前活跃分支）
  let currentLeaf = null
  let latestTimestamp = ''

  for (const leaf of leaves) {
    const msg = messageMap.get(leaf)
    if (msg?.timestamp && msg.timestamp > latestTimestamp) {
      latestTimestamp = msg.timestamp
      currentLeaf = leaf
    }
  }

  if (!currentLeaf) continue

  // 构建主对话链
  const chain = buildChain(currentLeaf)
  const chainUuids = new Set(chain.map(m => m.uuid))

  // 添加树分隔符
  result.push({ type: 'tree-separator', timestamp: latestTimestamp })

  // 添加不在主链上的分支的摘要
  for (const summary of treeSummaries) {
    if (summary.leafUuid && !chainUuids.has(summary.leafUuid)) {
      result.push(summary)
    }
  }

  // 添加主对话链
  result.push(...chain)
}

return result
```

## 可视化示例

### 原始 JSONL（简化）

```
{"uuid":"a1","parentUuid":null,"type":"user","message":"你好"}
{"uuid":"a2","parentUuid":"a1","type":"assistant","message":"你好！"}
{"uuid":"a3","parentUuid":"a2","type":"user","message":"帮我写代码"}
{"uuid":"a4","parentUuid":"a3","type":"assistant","message":"好的..."}
{"uuid":"b1","parentUuid":null,"type":"user","message":"新问题"}
{"uuid":"b2","parentUuid":"b1","type":"assistant","message":"新回答"}
{"type":"summary","summary":"之前讨论了问候","leafUuid":"a2"}
```

### 树结构

```
树 1（旧）:          树 2（新）:
   [a1]                [b1]
    │                   │
   [a2] ← summary      [b2] ← 当前活跃
    │
   [a3]
    │
   [a4] ← 叶子
```

### 重建后的显示顺序

```
--- Conversation 1 (树 2，最新) ---
[b1] 用户: 新问题
[b2] Claude: 新回答

--- Conversation 2 (树 1，较旧) ---
[Compacted] 之前讨论了问候
[a3] 用户: 帮我写代码
[a4] Claude: 好的...
```

**说明**：
- 树 2 更新，排在前面
- 树 1 的 a1→a2 分支被压缩为 summary
- 只显示 a3→a4 这条活跃链

## 实现文件

- `web/src/pages/RoamPreviewCore.tsx` - `buildConversationTree()` 函数
- `web/src/App.css` - MiniMap ruler 和 tree-separator 样式

## 参考

- Claude Code 官方文档
- JSONL 格式规范：https://jsonlines.org/
