# MST → Apple Calendar（只读订阅）

## 使用

1. 管理员完成下方部署；用户在 MST「好友」登录相同云同步账号，并开启「设置 → 账号与同步」中的云同步、自动同步。
2. 打开「日历 → 订阅到苹果日历」，确认日程时区（默认本机 IANA 时区，例如 `Asia/Shanghai`），生成并复制链接。
3. iPhone：日历 → 日历 → 添加日历 → 添加订阅日历，粘贴 HTTPS 链接，账户可选 iCloud。
4. 修改、新建、删除日程仍在 MST 中进行。同步成功后，订阅服务直接读取云端记录；MST 无须一直运行。苹果端的刷新时间由系统决定，并非即时推送。

「全部日程」和分类订阅分享手工或 AI 创建的日历日程，包括标题、时间、地点和备注。支持全天、多天、跨夜、每周重复，以及单独跳过某次重复。每周重复按过去 365 天至未来 730 天展开，窗口随订阅请求滚动。时区固定为生成链接时选择的值，变更时区需重置链接。

链接是私密访问凭证，持有者可读取日程。数据库只保存 SHA-256 摘要，原始链接只显示在生成窗口中，不写入本地存储、备份、日志或普通数据同步。重新打开窗口后可重置链接。重置/停用会使旧链接的后续请求返回 404；苹果已经缓存的内容应通过取消订阅移除。

## 按分类订阅

在日历页顶部点「管理分类」，添加「课程」或「考试」等自定义选项，再从事件编辑窗口的「分类」下拉菜单选择。自定义选项参与 MST 日历云同步。在订阅窗口的「订阅范围」中选择分类，然后分别生成链接。苹果日历会显示为独立日历，每条分类链接只包含当前归入该分类的事件。调整事件分类后，变更会随云同步和苹果日历刷新生效。全部日程链接继续包含所有事件，且可与分类链接独立重置或停用。

升级已有部署时，在同一个 Supabase 项目执行[分类订阅迁移](supabase/migrations/20261108_calendar_category_subscriptions.sql)，再更新原有 `calendar-feed` 函数。验证 `?health=categories` 返回 `{"service":"mst-calendar-feed","version":1,"categories":true}`。原有全部日程链接无需重建。

## 管理员部署

### 待办截止日期

在「订阅范围」选择「待办截止日期」，生成独立链接。苹果日历会把待办标题和截止日期显示成全天条目。和 MST 日历一致，已完成且截止日期已过的待办会退出订阅。修改日期、清空日期和删除待办会随云同步更新。

启用这个范围时，先执行[待办截止日期订阅迁移](supabase/migrations/20261109_calendar_todo_due_subscriptions.sql)，再更新同一个 `calendar-feed`。访问 `?health=todo-due`，返回 `"todoDue":true` 表示服务可用。原有日程及分类链接可以继续使用。

订阅需要一个公网 HTTPS 接口。内置云服务使用阿里云 AnalyticDB Supabase，优先按下方控制台步骤部署。也支持 Supabase Cloud 或独立 Node 服务。

### 数据库（两种运行方式都需要）

在 MST 使用的同一数据库 SQL 编辑器执行 [迁移](supabase/migrations/20261107_calendar_subscription.sql)。现有 `supabase/schema.sql`（含 `user_data` 和 `set_row_updated_at`）应已执行。迁移可重复执行，新增 `calendar_subscriptions` 表和仅本人可读写的 RLS 策略，不开放 `user_data` 给匿名访问。

### A. 阿里云 AnalyticDB Supabase Edge Function

1. 登录 MST 对应项目的 Supabase Dashboard，在 **SQL Editor** 执行上方迁移。若执行成功后 Data API 仍报告 `PGRST205`，在同一 SQL Editor 执行 `notify pgrst, 'reload schema';`，然后重试。
2. 进入 **Edge Function → Functions → Deploy a new function → Via Editor**。将 `supabase/functions/calendar-feed/index.ts` 和 `supabase/functions/calendar-feed/feed.mjs` 放在同一函数目录，按 `calendar-feed` 部署。如果在线编辑器只接受 `.ts` 文件，可把 `feed.mjs` 的内容保存为 `feed.ts`，同时在入口中将导入路径改为 `./feed.ts`。
3. 为 `calendar-feed` 关闭 **Verify JWT**。苹果日历会带上链接里的专用令牌，函数会自行验证它。运行环境使用阿里云预置的 `SUPABASE_LOCAL_URL`（或 `SUPABASE_URL`）与 `SUPABASE_SERVICE_ROLE_KEY`。
4. 匿名访问 `https://项目地址/functions/v1/calendar-feed?health=1` 验证部署。`401 Missing authorization header` 表示网关仍要求 JWT。`503 FC deployment is not ready` 表示阿里云函数运行环境尚未就绪，需要在控制台检查部署状态和日志。

也可使用阿里云 `functions-cli deploy calendar-feed --no-verify-jwt`。具体配置见[阿里云 Edge Functions 文档](https://www.alibabacloud.com/help/en/analyticdb/analyticdb-for-postgresql/using-edge-functions-in-analyticdb-supabase)。

### B. Supabase Cloud Edge Function

部署仓库 `supabase/functions/calendar-feed` 目录，函数名为 `calendar-feed`：

```sh
supabase functions deploy calendar-feed --project-ref YOUR_PROJECT_REF --no-verify-jwt
```

`supabase/config.toml` 也已设置 `verify_jwt = false`。苹果不能发送 MST 登录 JWT，身份校验由处理函数中的高强度订阅令牌完成。运行环境需配置同一实例的 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`（Supabase 托管环境通常自动提供）。仅在服务端保存 service role 密钥。

默认服务地址：`https://YOUR_PROJECT_HOST/functions/v1/calendar-feed`。

### C. 独立 Node 服务

在服务器部署 `scripts/calendar-feed-server.mjs` 和 `supabase/functions/calendar-feed/feed.mjs`，使用 Node 22 或更新版本。在服务器环境中配置 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 后运行：

```sh
node scripts/calendar-feed-server.mjs
```

默认监听 `127.0.0.1:8787`，可用 `MST_CALENDAR_HOST` / `MST_CALENDAR_PORT` 覆盖。使用 HTTPS 反向代理暴露 `/calendar-feed`，将该完整 HTTPS 地址填入 MST 订阅窗口的「订阅服务设置」。前端仅保存这个公开服务地址，绝不能填入服务端密钥。此地址只负责读取，令牌管理仍在用户已配置的云数据库中进行。

### 上线检查

- 无需登录访问 `服务地址?health=1`，应返回 `{"service":"mst-calendar-feed","version":1}`；这也检查订阅表是否存在。前端在生成链接前自动检查。
- 生成链接后 GET 应返回 `text/calendar; charset=utf-8`，没有令牌、令牌错误或撤销后的链接应返回 404，POST 应返回 405。
- 不要在反向代理、CDN、监控或访问日志记录请求查询参数（令牌位于 URL）。禁用此接口的缓存；响应本身已设置 `Cache-Control: no-store` 和 `Referrer-Policy: no-referrer`。
- 读取使用仅服务端的 service role，先根据令牌摘要定位用户，再限定该用户和日历 key；逐项同步记录覆盖旧版数组，删除墓碑不会恢复为旧事件。查询分页覆盖服务器返回上限，不截断为“成功”的不完整日历。错误统一返回 503，不返回错误的空日历。
- 停用/重置只能限制后续获取，无法收回别人已经保存的数据。

本仓库验证：`node --test tests/calendar-subscription.test.js`；Electron 流程：`npx playwright test tests/e2e/calendar-subscription.spec.js`。这些测试使用模拟云端；真实服务部署及 Apple 设备订阅仍需单独验证。

参考：[Apple 日历订阅](https://support.apple.com/zh-cn/102301)、[Supabase 函数配置](https://supabase.com/docs/guides/functions/function-configuration)、[iCalendar RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html)。
