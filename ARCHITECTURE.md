# My Study Table 架构说明

## 运行时边界

- `main.js`：Electron 生命周期、窗口与仍需主进程协调的功能。
- `electron/`：按领域注册 IPC 服务；文件系统、更新器和安全策略不再散落在入口文件中。
- `preload.js`：唯一的渲染进程到主进程桥接层，页面不直接获得 Node.js 能力。
- `js/platform.js`：浏览器侧公共基础设施，提供容错存储、有序初始化和事件总线。
- `js/data-store.js`：IndexedDB 版本化主副本；localStorage 作为同步兼容缓存，旧数据会自动迁移。
- `js/secrets.js`：同步内存凭据接口；Electron 环境下由系统 `safeStorage` 加密落盘。
- `js/ai-client.js`：AI 请求超时、退避重试、取消、敏感信息提醒和 Token/费用统计。
- `js/ext-sandbox.js`：第三方插件的 opaque-origin iframe 运行时和权限桥。
- `js/bootstrap.js`：页面启动编排；新增模块应注册初始化任务，不应再创建独立的 `DOMContentLoaded` 链。
- `js/core.js`：应用核心状态，通过 `StudyPlatform.storage` 持久化，并发布 `storage:changed` 事件。

## 安全约束

- BrowserWindow 使用上下文隔离、沙箱，并拒绝页面创建新窗口、任意导航和权限申请。
- 外部链接和阅读器 URL 统一校验；本机、局域网、`file:`、`javascript:` 等目标会被拒绝。
- 扩展只能读写 `manifest.json` 与 `main.js`，扩展 ID、路径、文件大小和 manifest ID 必须一致。
- 外部 plugin 在无同源权限的 iframe 中运行；外部 patch 默认拒绝，不能直接修改应用全局对象。
- 插件权限分为 `ui`、`storage`、`events`、`log`、`notifications` 和 `external`，后两项必须显式声明。
- 本地及商店扩展安装后默认禁用，需由用户确认启用；商店包需通过 SHA-256 校验。
- API Key、搜索 Key、邮箱授权码和 CodeBuddy Key 由系统加密存储；设置导出和备份默认排除这些值。

## 数据与服务端迁移

业务数据会写入带 revision、内容哈希、更新时间和删除墓碑的 IndexedDB 记录，同时保留原 localStorage 键以兼容尚未模块化的界面。云同步继续使用离线 outbox，并记录最近 100 次冲突选择用于诊断。`supabase/schema.sql` 包含收紧后的行级策略、插件审核流程、下载计数和存储路径规则；发布服务端变更前，需要在 Supabase 项目中审阅并执行该脚本。

## 验证

```powershell
npm run verify
npm run test:e2e
npm run build
```

`npm run verify` 会语法检查项目 JavaScript 并运行 Node 回归测试。`npm run test:e2e` 会启动临时 Electron 实例验证界面、数据、凭据和插件沙箱。CI 会在 Windows 上执行上述测试并构建目录版产物。

## 后续开发原则

1. 新增需要系统权限的功能时，在 `electron/` 创建领域服务并只暴露最小 IPC 接口。
2. 新增页面初始化时，通过 `StudyPlatform.initializers` 注册并声明顺序。
3. 跨模块通信优先使用 `StudyPlatform.events`，避免新增隐式全局调用链。
4. 新的凭据类存储键必须同步加入 `electron/backup-policy.js` 和设置导出排除清单。
5. 修改插件发布模型时，同时更新客户端校验、数据库 RLS 和 Storage policy，并增加回归测试。
