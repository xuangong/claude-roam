# CLAUDE.md

Claude Roam - Claude Code 会话历史查看器的 Tauri 2 桌面应用

## 项目结构

```
claude-roam/
├── src-tauri/          # Tauri 2 Rust 后端
│   ├── src/
│   │   ├── main.rs     # 应用入口
│   │   ├── commands.rs # IPC 命令
│   │   ├── database.rs # SQLite 数据库
│   │   ├── parser.rs   # JSONL 解析器
│   │   └── watcher.rs  # 文件监听
│   └── tauri.conf.json # Tauri 配置
├── web/                # React 前端
│   ├── src/
│   │   ├── App.tsx     # 主应用（浏览器模式）
│   │   └── TauriApp.tsx # Tauri 模式入口
│   └── dist/           # 构建输出
└── cli/                # CLI 工具（旧版）
```

## AI 辅助开发流程

本项目采用 AI 辅助开发（Vibe Coding）模式，开发流程针对此场景优化。

### 推荐开发流程

```
1. 前端开发（快速迭代）
   └── npm run dev（浏览器模式，秒级热重载）
   └── 调整 UI、样式、交互逻辑
   └── 浏览器 DevTools 查看效果

2. Rust 后端开发（批量改动）
   └── 一次性完成功能模块
   └── cargo tauri build（1-2 分钟）
   └── 运行 .app 验证功能
   └── 有问题让 AI 分析报错修复

3. 集成测试
   └── cargo tauri build
   └── 运行完整应用测试
```

### 为什么不需要 Debug 模式？

传统开发需要 debug 模式进行断点调试、单步执行来追踪问题。AI 辅助开发时：
- **AI 分析报错** - 编译错误、运行时错误直接让 AI 看日志修复
- **批量改动** - 每次改动是完整功能，不是改一行试一行
- **前端迭代快** - 大部分 UI 调整在浏览器模式秒级反馈
- **编译等待** - 1-2 分钟正好思考下一步或处理其他事

### 开发命令

```bash
# 前端开发（浏览器模式，推荐日常使用）
cd web && npm run dev

# 构建 Release 版本
cd src-tauri
export PATH="/Users/zhangxian/.nvm/versions/node/v22.17.0/bin:/Users/zhangxian/.cargo/bin:/usr/bin:/bin:$PATH"
export CC=/usr/bin/clang
cargo tauri build

# 运行构建好的应用
open "/Users/zhangxian/projects/claude-roam/src-tauri/target/release/bundle/macos/Claude Roam.app"
```

## MDM 限制注意事项

由于 macOS MDM 策略限制，Rust 编译的 build script 二进制文件可能被阻止执行。

### 影响范围

| 命令 | 状态 | 说明 |
|------|------|------|
| `cargo tauri build` | 可用 | 利用 release 缓存 |
| `cargo tauri dev` | 不可用 | debug 模式无缓存 |
| `cargo check` | 不可用 | debug 模式 |
| `cargo clean` | 危险 | 会清除缓存导致无法编译 |

### 开发注意事项

1. **绝对不要运行 `cargo clean`** - 会清除所有缓存，之后无法重新编译
2. **添加新 Cargo 依赖要谨慎** - 新依赖可能需要执行 build script，导致编译失败
3. **更新依赖版本要谨慎** - 同上
4. **保留 `target/release/` 目录备份** - 以防意外清除
5. **前端开发用浏览器模式** - `cd web && npm run dev` 完全不受影响
6. **测试 Tauri 功能** - 直接 `cargo tauri build` 后运行 .app

### 为什么 Release 缓存能跳过问题？

Build script 的输出已经缓存在 `target/release/build/` 目录中，Cargo 检测到依赖没变化就直接使用缓存结果，不需要重新执行 build script。

### 如果需要添加新依赖

1. 先在本地终端（非 Claude Code）尝试添加
2. 或者在 CI/CD 环境（GitHub Actions）中构建
3. 然后把构建好的缓存同步回来

## 技术栈

- **后端**: Rust + Tauri 2
- **前端**: React + TypeScript + Vite
- **数据库**: SQLite (rusqlite)
- **文件监听**: notify crate
- **UI**: CSS + 虚拟滚动 (@tanstack/react-virtual)

## 构建产物

- **应用**: `src-tauri/target/release/bundle/macos/Claude Roam.app` (~6.1 MB)
- **安装包**: `src-tauri/target/release/bundle/dmg/Claude Roam_1.0.0_aarch64.dmg` (~3.3 MB)
