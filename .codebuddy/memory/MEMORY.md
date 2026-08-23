# 长期记忆

## 项目：我的学习桌面

### 技术决策与约定
- **版本发布策略**：一律三位 semver（MAJOR=阶段/兼容、MINOR=新功能、PATCH=修复），全局唯一、单调递增、永不复用。禁止四位版本号（`0.1.11.1` 被判 null、updater 抛 `ERR_UPDATER_INVALID_VERSION`）。当前 `0.1.x` 初始开发期。
- **应用运行约定**：修改 `js/` 或 `css/` 后**必须完全重启 Electron**（窗口刷新不够，主进程注入脚本不重载）。
- **AI tool_call 参数解析**：`js/ai-tools.js` 的 `parseSingleToolCall` 必须用 `JSON.parse()` 解析 params，勿手动正则提取（不解码 JSON 转义，LaTeX 双反斜杠会渲染失败）。
- **笔记数据模型**：AI 创建的笔记必须含 `type:'note'` + `parentId`（非旧 `folderId`）。`renderItem` 限制递归深度 + `visited Set` 防循环；`resolveNoteFolderPath` 避免 self-parent。
- **AI 记忆画像**：`memory.profileText` 是单段自由文本（AI 每日自动生成），非分段字段；旧分段数据在 `loadAiMemory()` 自动迁移合并。
- **预设→自定义切换**：`js/settings.js` 的 `switchToCustomMode(cfg)` 是唯一切换入口，所有设置 handler 先调用它再改属性再 save，禁止内联 `cfg.preset='custom'`。
- **液态玻璃折射**：三独立控制 `glassCurve`（SVG displacement 0~60px）/`glassDeflect`（edge zone 0~0.4）/`glassGlow`（0~1）。`updateLiquidGlass(scale, edgeRatio)` 支持 undefined 跳过单参数。仅 Chromium 支持 `backdrop-filter: url()`。

### 同步机制（sync.js 方案 B，2026-08-23 定稿）
- **核心原则**：localTs 只写**服务器 updated_at**（与 remoteTs 同源可比），**禁止用设备时钟 `new Date()` 写 localTs**（iPad 时钟偏快 → LWW 判定本地更新 → 永不拉取，这是 2026-08 反复排查的根因）。
- **本地修改用持久化 dirty 标记**（`study_sync_dirty_v1`，`_markLocalDirty`/`_clearLocalDirty`/`_isLocalDirty`）：`onLocalChange` 只标 dirty；上传/拉取成功才清 dirty 并写 localTs。
- **自动同步走修正后的时间戳逻辑** `_pullAll(true,false)`（Realtime `_debouncedPull`/定时轮询/登录后 `_doSyncAfterLogin`/`_init`）；**仅手动同步 `manualSync` 保留 `_pullAll(true,true)` 强制拉取**（云端为权威源）。
- **时钟污染自愈**：`_tsIsFuture(localTs, remoteMaxTs)` 判定本地时间戳比服务器参考（本次拉取最大 updated_at）快超 15 分钟 → 视为旧版污染残留 → 本地时间不可信、以云端覆盖校准。
- 拉取判定顺序：本地空→拉；forceRemote→拉；dirty→保护本地上传；_tsIsFuture→拉取校准；remoteTs>localTs→拉；!localTs&&remoteTs→上传保护。
- `_uploadKey` 超大 key（>800K 字符）不上传，localTs 用 remoteTs 兜底 + 清 dirty，避免每轮重复入队。
- 冲突弹窗 `_conflictQueue` 实际为死代码（从不 push），保留未用。

### 模块架构
- **任务线系统**（v0.2.7）：localStorage `study_taskline_v1`（version:3，**无经验系统**），`js/taskline.js`。双轴 main/quality；每章独立 DAG（`tlLayoutGraph` 按依赖深度分列 + `tlComputeDepth` DFS），SVG 贝塞尔箭头；状态 draft/locked/active/done/skipped。v0.2.6 跨章节依赖（`.tl-node-ext`/`.tl-edge-ext`）。v0.2.7 手动画布（quest `pos:{x,y}`，手动/自动布局切换 `tlDragMode`，坐标加/减 TL_PAD 偏移）。cond 自动检测（todo/note/timer/manual）。奖励：徽章 `tlCheckAutoBadges` + 奖励池 `tlRewardBalance()=tlDoneCount()-spent`。AI：ai-tools.js 12 个 `quest_*` 工具 + `buildAiSummary()`；待办联动 `tlOnTodosChanged()`。**坑**：(1) quest_update 设 active 走 `tlRefreshQuestStatus`；(2) 无 xp/等级函数；(3) 占位节点不参与条件/解锁；(4) pos 传 null 回退自动布局。
- **好友系统**（v0.3.0）：Supabase（表 `supabase/schema.sql`），`js/friends.js`（key `study_friends_config`、`getSupabaseClient` 单例、`computeDailyStats`+`syncStudyStats`）+ `js/friends-chat.js`（Realtime）。**隐私红线**：只同步聚合统计，绝不上传待办/笔记内容，RLS `is_friend()`。**坑**：订阅回调用 `renderFriendsFeedView` 手动 innerHTML。
- **AI 树状对话**（2026-08-03）：`conv.tree` 节点字典 + `conv.activePath` + `conv.messages`（扁平缓存）。`js/ai-tree.js`：ensureTree/appendMessage/createBranch/switchBranch/recomputeMessages/trimConvMessages 等。**写消息一律 `appendMessage(conv,msg)`，禁止直接 `conv.messages.push`**。候选/重新生成 = user 节点兄弟分支；「换一条」调 `regenerateAiMessage(nodeId)`。加载顺序：ai-utils→ai-tree→ai-conv→ai-attach→ai-render→ai-tools→ai-search→ai-api→ai-send。AI 模块拆分见 `js/ai_backup_20260718.js`。
- **扩展系统**（v0.1.14+0.1.15）：外部扩展存 `~/.my-study-table/extensions/<id>/`。`plugin`（`window.extAPI` 白名单）与 `patch`（`PatchEngine.override/wrap/revertExt`）。主进程 IPC 全 `isPathInside` 校验。**CodeBuddy CLI Agent**：包 `@tencent-ai/codebuddy-code`；`-p --dangerously-skip-permissions --output-format stream-json`；Windows 绕开 cmd.exe：`resolveCliEntry` 解析 .cmd 真实入口 + `spawn(process.execPath,[script],{env:{ELECTRON_RUN_AS_NODE:'1'}})`；输出解码 `createStreamDecoder`（UTF-8 探针失败切 gb18030）；登录检测 `-p hi` 含 `Authentication required` 即未登录。
- **教材图注识别**（books-pdf.js `bkExtractCaptionsFromText`）：**XObject 检测对矢量图教材无效**（《算法导论》是 constructPath+fill）。核心：textContent items 按 `transform[5]` 容差 4px 聚合行 → 按 x gap>40px 拆栏（gap 用「上一 item 右边界-当前 x」之差，非起始 x 之差）→ 行首锚定 `^(?:Figure|Fig|图)\s*编号` → **核心判据「编号后首词必须大写」**（`bkFirstWordLowercase`）+ 动词黑名单。图注跨行不拼接。Node 加载 pdf.min.mjs：`pathToFileURL` + DOMMatrix polyfill + `GlobalWorkerOptions.workerSrc`；用 `loadingTask.destroy()`。
- **教材「学习」tab 内嵌 PDF 阅读器**（books-study.js）：canvas 高清渲染 + pdf.js TextLayer（`new pdfjsLib.TextLayer({textContentSource,container,viewport})`→`render()`；CSS `.textLayer span{color:transparent;position:absolute;white-space:pre}`）。独立状态 `_stPdf*`（勿与全屏 `_bkPdfDoc` 冲突）。AI 板块复用 `bkAskTutorCore(chapter,q)`（共享 `study_bk_explain_logs_v1[chapterId]`）。右键「添加到术语表」写 `study_global_keywords_v1`。加载顺序：books-ai→books-annot→keywords→**books-study**。自然段切分已彻底删除。
- **教材目录页码校准**（books-pdf.js）：目录解析 `page` 是**印刷页码**，章节 `startPage/endPage` 是 **PDF 物理页码**（1 起始含封面）。`calibrateTocPagesByOutline` 按编号匹配 outline 物理页与 toc 印刷页求 offset 众数，整树 `page += offset`。仅对有书签 PDF 生效，旧书需重新导入。
- **日志类独立云存储通道**（v0.4.1，sync-logs.js）：三日志 key（`study_ai_convs`/`study_bk_explain_logs_v1`/`study_bk_qa_logs_v1`）独立串行队列；gzip（原生 CompressionStream）+ hash 幂等 + >700K 二分分片 `_p0/_p1`；TTL（教材 3 个月/AI 最近 20 会话）；配额 `study_sync_logs_cfg.quotaMB` 默认 50MB；云端 `public.user_sync_items`（unique(user_id,kind,item_id)，RLS，Realtime）。**坑**：(1) books-ai.js 与 `safeSaveAiConvs` 直接 setItem，需补丁调 `SyncLogs.onLocalChange(key)`；(2) `_applyToLocal` 的 tree/activePath 仅远端有值才覆盖；(3) `deleteAllRemote` 保留 ts/hash 防立即重传；(4) `study_bk_quiz_state_v1` 仍留 sync.js。
- **QQ 聊天 / 绿群日报**（2026-08-23 完成，js/qq-chats.js + js/inbox.js）：IndexedDB `mst-qqchats`（chats/messages + byChat 索引），连接单例必须 `_closeDb` 重置 `_dbPromise`（否则 "connection is closing"）。JSONL 分块导入（manifest.json+chunks/）、合并去重（`_dedupeMerge` + `_reorderChatByTime` 按 timestamp 重排 order/msgKey）。绿群日报 Map-Reduce：按天分组→`chatMapLimit` 并发池（块 3、天 2）→分块提取 `(m<order>)` 标记→Reduce 汇总；prompt 强制「一条要点只一个 (m) 标记」；`renderDailyReportContent` 解析正文（`(m\d+)` 取第一个 order、标题 `#{1,6}`、普通行）。跳转：`jumpToChatMessage(chatId, order, text)` + `_chatJumpTarget` + `scrollToChatTarget`（无 setTimeout 猜测）。Electron 禁用 `window.prompt()` → 一律自定义 Modal。版本机制：index.html `?v=` + service-worker `mst-vNN` + 完全重启 Electron。

### GitHub 发布经验
- **exe 补传**（无需代理）：取 release id `curl https://api.github.com/repos/jizihan2008/my-study-table/releases/tags/vX.Y.Z` → `POST https://uploads.github.com/repos/jizihan2008/my-study-table/releases/{id}/assets?name=My-Study-Table-Setup-X.Y.Z.exe`（Header `Authorization: Bearer <GH_TOKEN>`+`Content-Type: application/octet-stream`，body `--data-binary @本地exe`）。资产名用连字符版本（与 latest.yml url 一致）。token 每次需用户重新提供；token 明文绝不写入记忆。
- **发布前置**：PowerShell 设 `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7892`（cmd /c 会让 app-builder 的 Go 代理解析失败）；手动下载 winCodeSign-2.6.0/nsis-3.0.4.1/nsis-resources-3.4.1 到 `%LOCALAPPDATA%\electron-builder\Cache\`；electron-builder 24.x 不支持 nsis.signAndEditExecutable（已删）；后端 node 用 `npm.cmd`（PowerShell 禁 npm.ps1）。已装 Git 2.55.0，仓库 main 分支。
