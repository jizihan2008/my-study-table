# 长期记忆

## 项目：我的学习桌面

### 技术决策与约定
- **AI 模块拆分**（2026-07-18）：`js/ai.js` 已拆分为 8 个模块，按依赖顺序在 `index.html` 中加载：`ai-utils.js` → `ai-conv.js` → `ai-attach.js` → `ai-render.js` → `ai-tools.js` → `ai-search.js` → `ai-api.js` → `ai-send.js`。备份在 `js/ai_backup_20260718.js`。
- **AI tool_call 参数解析**：`js/ai-tools.js` 中的 `parseSingleToolCall` 必须使用 `JSON.parse()` 解析 `params` 对象，而不是手动正则提取字段。手动提取不会解码 JSON 转义，会导致 `\\Delta` 等内容保持双反斜杠状态，LaTeX 渲染失败。
- **笔记数据模型**：AI 创建的笔记对象必须包含 `type: 'note'` 和 `parentId`（而非旧的 `folderId`），否则 `js/notes.js` 的渲染/查找函数无法识别。
- **文件夹循环引用保护**：`js/notes.js` 的 `renderItem` 必须限制递归深度并使用 `visited Set` 检测循环；`resolveNoteFolderPath` 需避免 self-parent。
- **AI 记忆系统用户画像**：`memory.profileText` 是单段自由文本，由 AI 每日自动生成全方位总结。不再是独立的分段字段 (nickname/identity/goals/style)。已有旧数据（分段格式）在 `loadAiMemory()` 中自动迁移合并为一段文字。
- **液态玻璃折射**（2026-07-22 r23）：拆分为三个独立控制——`glassCurve`（弯曲程度→SVG displacement scale 0~60px）、`glassDeflect`（偏折程度→edge zone 0~0.4）、`glassGlow`（顶层辉光→`--glass-glow` CSS 变量 0~1）。`js/liquid-glass.js` 的 `updateLiquidGlass(scale, edgeRatio)` 支持仅更新单个参数（undefined 跳过）。`settings.js` 中 `applyGlassCurve/Deflect/Glow` 三个函数替代旧 `applyGlassRefract`。CSS `--glass-glow` 同时控制 opacity + brightness。仅 Chromium 支持 `backdrop-filter: url()`。
- **预设→自定义切换规则**（2026-07-22）：`js/settings.js` 中 `switchToCustomMode(cfg)` 是唯一切换到自定义模式的入口。所有设置修改 handler 必须先调用 `switchToCustomMode(cfg)`（复制预设全部有效值到 cfg），再修改具体属性值，再 save。禁止内联 `cfg.preset = 'custom'`。
- **版本发布策略·方案 B**（2026-08-02 确认）：一律使用三位 semver，**MAJOR 位表示项目阶段**（阶段一=`1.x.y`、阶段二=`2.x.y`…），MINOR=向后兼容新功能，PATCH=bug 修复。版本号全局唯一、单调递增，永不复用。当前 `0.1.x` 属初始开发迭代期，正式进入阶段一以发布 `1.0.0` 为标志。禁止使用四位版本号（如 `0.1.11.1`）——已实测验证 npm semver 解析为 null、`gt` 比较抛 `Invalid Version`，`electron-updater/out/AppUpdater.js` `isUpdateAvailable` 对非法版本抛 `ERR_UPDATER_INVALID_VERSION`，构建阶段 electron-builder 同样校验 package.json version。

### 应用运行约定
- 修改 `js/` 或 `css/` 文件后，**必须完全重启 Electron 应用**才能加载新代码；窗口刷新不足以重新加载主进程注入的脚本。
