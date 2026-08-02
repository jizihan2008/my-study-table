# My Study Table — 代码原理详解

> 版本 v1.9 | 文档更新日期: 2026-08-02

---

## 目录

1. [项目概述](#1-项目概述)
2. [架构总览](#2-架构总览)
3. [运行环境层（Electron）](#3-运行环境层electron)
4. [HTML 结构层](#4-html-结构层)
5. [CSS 样式层](#5-css-样式层)
6. [核心模块 (core.js)](#6-核心模块-corejs)
7. [待办模块 (todos.js)](#7-待办模块-todosjs)
8. [笔记模块 (notes.js)](#8-笔记模块-notesjs)
9. [快捷访问模块 (links.js)](#9-快捷访问模块-linksjs)
10. [今日模块 (today.js)](#10-今日模块-todayjs)
11. [AI 助手模块（8 模块拆分）](#11-ai-助手模块8-模块拆分)
12. [设置模块 (settings.js)](#12-设置模块-settingsjs)
13. [工具模块 (utils.js)](#13-工具模块-utilsjs)
14. [数据持久化原理](#14-数据持久化原理)
15. [完整执行流程](#15-完整执行流程)
16. [自动更新系统](#16-自动更新系统)

---

## 1. 项目概述

My Study Table 是一个**单页面桌面应用（SPA）**，使用 Electron 框架构建，运行在 Windows 平台上。它的核心功能是帮助用户管理学习任务：

- 📋 **待办管理**：支持无限层级子任务、搜索、标签、截止日期、进度统计
- 📝 **笔记管理**：多笔记、Markdown 编辑/预览、自动保存、撤销/重做、复习系统
- 🔗 **快捷访问**：分类管理常用网站和应用链接
- 📅 **今天**：每日打卡 + 长期目标 + 今日聚焦任务（2~5 个）+ 待复习笔记
- 📅 **日历**：月视图、截止日期/完成角标、日历事件
- ⏱️ **计时器**：专注计时、手动记录、关联待办/目标
- 📊 **习惯追踪**：多目标打卡系统 + 热力图 + 坚持率
- 🤖 **AI 助手**：多对话标签页、工具调用、网络搜索、定时自动化、每日日报、长期记忆
- 🎵 **音乐播放器**：播放列表、悬浮球全局控制
- 🗑️ **回收站 / 归档**：软删除与恢复机制

**所有数据存储在浏览器的 localStorage 中，不上传任何服务器。**

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────┐
│                    index.html                       │
│              (HTML 结构 + 资源引用)                    │
├─────────────────────────────────────────────────────┤
│  css/style.css    ←──  全局样式（主题、布局、动画）       │
├─────────────────────────────────────────────────────┤
│  js/core.js       ←──  数据加载、主题、导航、标签切换     │
│  js/todos.js      ←──  待办树、搜索、编辑弹窗            │
│  js/notes.js      ←──  笔记编辑、Markdown、撤销重做      │
│  js/links.js      ←──  快捷访问分类管理                 │
│  js/today.js      ←──  打卡日历、聚焦任务、通知           │
│  js/calendar.js   ←──  日历月视图、事件、完成记录         │
│  js/timer.js      ←──  专注计时器、手动记录             │
│  js/habits.js     ←──  习惯追踪打卡                    │
│  js/stats.js      ←──  统计页、AI 分析                 │
│  js/music.js      ←──  音乐播放器                      │
│  js/trash.js      ←──  回收站/归档恢复                 │
│  js/memory.js     ←──  AI 长期记忆系统                 │
│  js/liquid-glass.js ←── 液态玻璃 SVG 折射滤镜           │
│  js/updater.js    ←──  自动更新状态机                   │
│  js/ai-*.js       ←──  AI 8 模块（见第 11 章）          │
│  js/settings.js   ←──  设置、外观、日报、数据迁移         │
│  js/utils.js      ←──  工具函数、快捷键、初始化           │
├─────────────────────────────────────────────────────┤
│  main.js          ←──  Electron 主进程（窗口、托盘、IPC、autoUpdater）│
│  preload.js       ←──  安全的 API 桥接层               │
└─────────────────────────────────────────────────────┘
```

**关键设计原则**：
- 所有 JS 文件共享全局作用域，函数和变量可直接跨文件调用
- 文件加载顺序至关重要（见 `index.html` 底部 `<script>` 标签）：
  `liquid-glass.js → core.js → trash.js → todos.js → notes.js → links.js → today.js → ai-utils.js → ai-conv.js → ai-attach.js → ai-render.js → ai-tools.js → ai-search.js → ai-api.js → ai-send.js → music.js → memory.js → settings.js → utils.js → calendar.js → timer.js → habits.js → stats.js → updater.js`
- `utils.js` 接近最后加载，因为它的 `init` 部分需要调用其他模块的函数
- `updater.js` 最后加载（自启动 IIFE，无需手动初始化）

---

## 3. 运行环境层（Electron）

### 3.1 main.js — Electron 主进程

**作用**：应用的生命周期管理、窗口创建、系统托盘、IPC 通信、自动更新。

**核心原理**：

1. **窗口管理**：
   - `createWindow()` 创建 1200×800 的 BrowserWindow，最小尺寸 800×600
   - 使用 `contextIsolation: true` + `preload.js` 确保安全性（渲染进程无法直接访问 Node.js API）
   - 点击关闭按钮时**隐藏到托盘而非退出**：在 `close` 事件中调用 `event.preventDefault()` 并隐藏窗口
   - `userData` 目录被重定向到 `~/.my-study-table`（`app.setPath`），并禁用 GPU 磁盘缓存（解决 cache 权限错误）

2. **系统托盘**：
   - `createTray()` 创建 16×16 的托盘图标（`tray-icon.png`，加载失败时回退到内嵌 base64 图标）
   - 提供右键菜单：「显示窗口」和「退出应用」；双击托盘图标显示窗口

3. **退出逻辑**：
   - `isQuitting` 标志区分「关闭窗口」（隐藏到托盘）和「退出应用」（完全关闭）
   - 只有通过托盘菜单「退出应用」、`quit-app` IPC、或 `before-quit` 事件时才会真正退出

4. **IPC 通信**（主进程↔渲染进程）：
   - `show-notification`：发送 Windows 桌面通知
   - `open-external`：用默认浏览器打开 URL（调用 `shell.openExternal`）
   - `quit-app` / `focus-window`：完全退出 / 聚焦主窗口
   - `open-audio-dialog` / `open-image-dialog` / `open-video-dialog`：文件选择对话框
   - `read-audio-file`：读取音频为 Data URL（**先按扩展名白名单校验再读盘**）
   - `perform-backup` / `list-backups` / `open-backup-dir` / `get-backup-dir`：文件系统备份（写入 `~/.my-study-table/backups/`，超过最大数量自动清理最旧）
   - `get-downloads-path`：获取系统下载目录
   - `update:get-state` / `update:check` / `update:download` / `update:install`：自动更新（见第 16 章）

### 3.2 preload.js — 预加载脚本

**作用**：通过 `contextBridge.exposeInMainWorld` 安全地向渲染进程暴露 API。

**原理**：
- 使用 `ipcRenderer.invoke` 与主进程进行异步通信
- 暴露方法：`showNotification`、`openExternal`、`quitApp`、`focusWindow`、`openAudioDialog`、`readAudioFile`、`openImageDialog`、`openVideoDialog`、`openBackupDir`、`getBackupDir`、`performBackup`、`listBackups`、`getDownloadsPath`，以及更新相关 `getUpdateState` / `checkForUpdate` / `downloadUpdate` / `installUpdate` / `onUpdateEvent`
- 渲染进程通过 `window.electronAPI` 访问，检测 `isElectron` 判断运行环境

---

## 4. HTML 结构层

`index.html` 是整个应用的骨架，定义了所有 UI 元素的 DOM 结构：

### 4.1 布局结构

```
body
├── 侧边栏 (.sidebar)
│   ├── Logo
│   └── 导航容器 (#sidebarNav) — 由 core.js 动态渲染 12 个栏目
│       （待办/笔记/快捷访问/今天/日历/计时器/习惯/音乐/统计/AI助手/回收站/归档）
│       — 支持拖拽排序、隐藏/显示、Ctrl+1~9 快捷切换
├── 主区域 (.app)
│   ├── 头部 (.header) — 标题 + 按钮组
│   ├── #section-todo    — 待办
│   ├── #section-notes   — 笔记
│   ├── #section-links   — 快捷访问
│   ├── #section-today   — 今天（长期目标+打卡+聚焦+待复习）
│   ├── #section-calendar— 日历
│   ├── #section-ai      — AI 聊天（动态渲染）
│   ├── #section-timer   — 计时器
│   ├── #section-music   — 音乐
│   ├── #section-habits  — 习惯
│   ├── #section-trash   — 回收站
│   ├── #section-archive — 归档
│   └── #section-stats   — 统计
├── 模态框族
│   ├── #editModal / #promptModal / #confirmModal
│   ├── #changelogModal / #helpModal / #settingsModal
│   ├── #convSettingsModal / #updateModal
│   └── 复习浮窗 (#reviewFloatOverlay)
└── 脚本引用（约 24 个 JS 文件按顺序加载）
```

### 4.2 标签切换机制

每个功能区域（section）初始 `display: none`，通过 `switchTab(tab)` 函数激活：
- 移除所有 `.sidebar-nav-item.active` 和 `.section.active`
- 给目标导航按钮和区域添加 `.active` 类
- 切换到特定标签时触发对应的渲染函数（`renderTodos` / `renderNotes` / `renderToday` / `renderCalendar` / `renderTimer` / `renderMusic` / `renderAiChat` 等）
- 离开 AI 页时保存草稿、离开笔记页时检查摘要更新

### 4.3 事件绑定

事件通过 `onclick`、`onkeydown`、`oninput` 等内联属性绑定到全局函数。这种方式在 SPA 中简单直接，避免了 DOM 加载顺序问题。

---

## 5. CSS 样式层

### 5.1 CSS 变量（主题系统）

**核心原理**：使用 CSS 自定义属性实现浅色/深色主题切换。

```css
::root, [data-theme="light"] { /* 浅色变量 */ }
[data-theme="dark"] {         /* 深色变量 */ }
```

所有颜色都通过 `var(--变量名)` 引用，切换主题只需修改 `<html>` 元素的 `data-theme` 属性。

**关键变量分类**：
| 类别 | 变量 | 用途 |
|------|------|------|
| 背景 | `--bg`, `--card`, `--todo-bg` | 页面/卡片/待办项背景 |
| 文字 | `--text`, `--text-secondary` | 主文字/次要文字 |
| 品牌 | `--primary`, `--primary-hover` | 主题色/悬停色 |
| 状态 | `--done`, `--danger` | 完成/危险状态色 |
| 边框 | `--border`, `--shadow` | 边框线/阴影 |
| 输入 | `--input-bg`, `--search-bg` | 输入框背景 |
| 玻璃 | `--glass-blur`, `--glass-opacity`, `--glass-glow` | 玻璃效果参数 |

### 5.2 滚动条美化

**原理**：使用 `::-webkit-scrollbar` 伪元素自定义滚动条样式。
- 默认 `background: transparent`（隐藏）
- 添加 `.scrolling` 类时显示半透明滚动条
- 通过监听 `scroll` 和 `wheel` 事件，800ms 后自动隐藏

### 5.3 动画系统

- **淡入滑入** (`fadeSlideIn`)：待办项、链接卡片、搜索结果的新增动画
- **打字动画** (`typingBounce`)：AI 回复中的三点跳动动画
- **模态框**：`translateY(20px) scale(0.96)` → `translateY(0) scale(1)` 的弹出动画
- **输入面板**：`max-height` + `opacity` 过渡实现展开/收起
- **侧边栏**：`translateX(-100%)` → `translateX(0)` 的滑入动画
- **液态玻璃折射**：基于 SVG `feDisplacementMap` 的 `backdrop-filter: url(#filter)` 真实像素弯曲（见 `js/liquid-glass.js`），包含弯曲程度/偏折程度/顶层辉光三个独立控制

### 5.4 响应式设计

`@media (max-width: 700px)` 适配小屏幕：
- 笔记布局从左右分栏变为上下堆叠
- 链接网格列数自适应
- 减小字体和间距

### 5.5 图标体系

全应用使用 **Lucide** 图标库（`<i data-lucide="icon-name">`）。静态图标由 `lucide.createIcons()` 一次性渲染；JS 动态插入的图标需在渲染后再次调用 `lucide.createIcons()` 或 `lucide.replaceElement()`。

---

## 6. 核心模块 (core.js)

### 6.1 数据持久化函数

```javascript
function loadData(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch { return []; }
}
function saveData(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}
```

**原理**：所有数据以 JSON 字符串形式存储在 `localStorage` 中。`loadData` 包含 try-catch 防止解析失败。

### 6.2 全局数据变量

| 变量 | localStorage Key | 类型 | 用途 |
|------|-----------------|------|------|
| `todos` | `study_todos_v2` | Array | 待办事项列表 |
| `links` | `study_links_v3` | Array | 快捷访问链接 |
| `notes` | `study_notes_v2` | Array | 笔记列表 |
| `activeNoteId` | `study_active_note` | Number | 当前活跃笔记ID |
| `changelog` | `study_changelog` | Array | 更新日志 |
| `aiConvs` | `study_ai_convs` | Array | AI 对话列表（settings.js） |
| `activeConvId` | `study_active_conv` | Number | 当前对话ID（settings.js） |

### 6.3 数据迁移机制

**原理**：在加载数据后立即检查是否需要迁移旧格式：

1. **单笔记→多笔记**：如果 `study_notes_v2` 为空但存在旧 `study_notes`，将其包装为一条笔记
2. **链接补充类型**：为旧链接添加 `type: 'link'` 默认值
3. **待办补充字段**：为旧待办添加 `content: ''` 和 `tags: []` 默认值

### 6.4 全局状态变量

| 变量 | 类型 | 用途 |
|------|------|------|
| `expandedTodoIds` | Set | 待办树中展开的节点ID |
| `pickerExpandedIds` | Set | 待办选择器中展开的节点 |
| `focusExpandedIds` | Set | 聚焦列表中展开的节点 |
| `currentTodoRoot` | Number/null | 当前查看的待办目录根节点 |
| `activeSubInputId` | Number/null | 当前展开子任务输入的父节点ID |
| `todoInputOpen` | Boolean | 待办输入面板是否展开 |
| `linkInputOpen` | Boolean | 链接输入面板是否展开 |
| `todoSearchQuery` | String | 待办搜索关键词 |
| `notesUndoStack` | Array | 笔记撤销栈（最多50条） |
| `notesRedoStack` | Array | 笔记重做栈 |
| `sidebarOpen` | Boolean | 侧边栏是否展开 |
| `settingsModalOpen` | Boolean | 设置弹窗是否打开 |

### 6.5 主题切换原理

```javascript
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('themeIcon').dataset.lucide = theme === 'dark' ? 'sun' : 'moon';
  lucide.replaceElement();  // 图标随主题切换
  localStorage.setItem('study_theme', theme);
}
```

修改 `<html>` 的 `data-theme` 属性后，CSS 变量自动切换，所有使用 `var()` 的颜色同步更新。

### 6.6 导航系统

- `ALL_NAV_ITEMS` 定义 12 个内置栏目（含图标名与标签）
- `loadNavConfig()` / `saveNavConfig()`：从 `study_nav_config` 读取/写入排序与隐藏配置
- `renderSidebarNav()`：动态渲染侧边栏，支持 Ctrl+1~9 快捷键
- `openNavSettings()`：编辑界面栏弹窗（拖拽排序、隐藏开关、启动首页）

---

## 7. 待办模块 (todos.js)

### 7.1 树形数据结构

**原理**：待办事项使用**邻接列表（Adjacency List）**模型存储树形结构：

```javascript
{
  id: 1690123456789,    // 时间戳作为唯一ID
  text: "学习数学",
  done: false,
  parentId: null,       // null = 根节点，数字 = 父节点ID
  dueDate: "2026-07-10", // 可选截止日期
  content: "重点复习微积分", // 可选正文/备注
  tags: ["重要", "学习"], // 可选标签
  completedAt: "2026-07-10T12:00"  // 完成时间（日历/统计用）
}
```

**优势**：每条记录独立，通过 `parentId` 关联，支持无限层级嵌套。

### 7.2 核心树操作

| 函数 | 原理 |
|------|------|
| `getChildren(parentId)` | 过滤 `todos` 中 `parentId` 匹配的所有项 |
| `getAllDescendantIds(rootId)` | 递归收集某节点的所有子孙ID（包括自身） |
| `getVisibleTodos()` | 根据 `currentTodoRoot` 返回当前层级可见的待办 |
| `findTodo(id)` | 线性搜索整个 `todos` 数组 |
| `findAllMatchingTodos()` | 模糊匹配搜索关键词 |
| `totalChildCount` | 栈迭代统计后代数（避免 O(n²)） |

### 7.3 目录导航（面包屑）

**原理**：
- `currentTodoRoot` 记录当前查看的目录节点（null = 顶层）
- `buildBreadcrumb()` 从当前节点向上追溯 `parentId`，构建路径链
- 面包屑渲染为可点击的路径，支持回退到任意上级

### 7.4 待办操作

**新增待办** (`addTodo`)：
- 在 `currentTodoRoot` 节点下创建子任务
- 自动将父节点加入 `expandedTodoIds` 以展开显示

**完成/取消** (`toggleTodo`)：
- 标记完成时：**级联完成所有子孙任务**，并记录 `completedAt`
- 取消完成时：只影响自身，不改变子任务状态，清除 `completedAt`

**删除** (`deleteTodo`)：
- 递归收集所有子孙ID → 从 `todos` 数组中过滤掉所有这些ID
- 同时清理 `expandedTodoIds` 和 `activeSubInputId`

**子任务添加** (`toggleSubInput` / `confirmSubTodo`)：
- 每行待办项旁有「＋」按钮
- 点击后在对应行下方展开内联输入框
- 同一时间只能有一个展开（`activeSubInputId` 控制）

### 7.5 待办渲染

`renderTodoNode(t, depth, visited, timerRecords)` 是递归渲染函数：
1. 根据 `depth` 计算缩进（`depth × 20px`）
2. 渲染展开/折叠按钮（有子节点时显示箭头）
3. 渲染复选框、文本、截止日期、标签、子任务计数、累计计时
4. 渲染操作按钮（编辑、添加子任务、删除）
5. 递归渲染子节点

**进度条计算**：收集当前视图内所有可见待办的ID，计算 `doneCount / totalCount × 100%`，100% 时显示完成提示。

**性能优化**：`renderTodos` 只解析一次 `study_timer_records` 传入渲染函数；状态配置使用模块级缓存（`_statusOptionsCache`）。

### 7.6 搜索结果渲染

**原理**：搜索时切换到平铺结果视图（替代树形视图）：
1. 隐藏待办树、面包屑
2. 对每个匹配项显示祖先路径（`getAncestorPath`）
3. 每个结果卡片提供「去目录」按钮，点击跳转到该待办所在层级

### 7.7 编辑弹窗与多选

- `openEditTodoModal(id)`：填充当前待办数据到表单（名称、截止日期、正文、标签）
- 多选模式：批量删除/编辑
- 标签用逗号分隔输入，保存时 `split(',')` 为数组

### 7.8 自定义状态

- 通过 `study_status_options` 定义自定义状态（默认：未开始/进行中/已完成）
- 状态名在 HTML 属性中使用 `escapeAttr()` 转义，防止引号注入
- `invalidateStatusOptionsCache()`：设置变更后使缓存失效

---

## 8. 笔记模块 (notes.js)

### 8.1 多笔记管理

**数据结构**：
```javascript
{
  id: 1690123456789,
  title: "数学笔记",
  content: "今天学了微积分...",
  createdAt: "2026-07-06T...",
  updatedAt: "2026-07-06T...",
  parentId: null,           // 文件夹归属（null = 根）
  folderId: null,           // 兼容旧字段
  type: "note",             // note | folder
  _reviewHistory: [...],    // 复习历史
  _skipReview: false        // 跳过复习
}
```

**原理**：
- 左侧列表显示所有笔记/文件夹（支持无限嵌套、内联重命名、右键菜单）
- 点击切换 `activeNoteId`，右侧编辑器更新内容
- 至少保留一篇笔记（删除最后一篇时会自动清空内容而非删除）

### 8.2 自动保存机制

**防抖（Debounce）原理**：
```
用户输入 → 清除旧计时器 → 设置新计时器(400-500ms)
         → 计时器到期 → 保存到 localStorage → 更新状态为"已保存"
```

- 标题修改：400ms 防抖；正文修改：500ms 防抖
- 通过 `_dirtyContent` / `_dirtyTitle` 标志避免重复推入撤销栈

### 8.3 撤销/重做系统

**原理**：使用两个栈实现：

```
用户编辑 → pushNotesUndo(旧内容) → 清空 redoStack
用户撤销 → pop undoStack → push 当前内容到 redoStack → 恢复旧内容
用户重做 → pop redoStack → push 当前内容到 undoStack → 恢复新内容
```

- `notesUndoStack`：最多保留 50 条快照（`shift()` 移除最旧）

### 8.4 编辑/预览/摘要三模式

**原理**：
- 编辑模式：显示 `<textarea>` + Markdown 格式工具栏（粗体/斜体/标题/代码/链接/列表/引用/任务列表/分割线等，快捷键 Ctrl+B/I/U/K）
- 预览模式：隐藏 `<textarea>`，显示格式化后的 HTML（KaTeX 渲染 LaTeX）
- 摘要模式：AI 生成的笔记摘要（可自动/手动触发）

### 8.5 文件夹系统与防循环

- 支持多级文件夹嵌套，右键菜单新建/重命名/删除
- `renderItem` 使用递归深度限制 + `visited Set` 防止循环引用
- `resolveNoteFolderPath` 避免 self-parent

### 8.6 复习系统（艾宾浩斯）

- 基于 1/2/4/7/15/30/60/120 天间隔重复，编辑后自动重置周期
- 到期笔记在「今天」页面卡片中展示，支持右键跳过

---

## 9. 快捷访问模块 (links.js)

### 9.1 数据结构

```javascript
{
  id: 1690123456789,
  name: "Google",
  url: "https://google.com",
  category: "搜索",
  type: "link"  // "link" | "app"
}
```

### 9.2 分类管理原理

1. `getAllCategories()`：从所有链接中提取不重复的分类名
2. `groupLinksByCategory()`：按分类分组为 `{分类名: [链接数组]}` 的对象
3. 渲染时遍历分类，每个分类显示为一个带标题的分组面板（分类标题支持 ▲/▼ 排序）
4. 链接卡片使用 CSS Grid 自动布局

### 9.3 URL 自动补全

添加网页链接时，如果 URL 不以 `http://` 或 `https://` 开头，自动添加 `https://` 前缀。应用类型链接不添加前缀。

---

## 10. 今日模块 (today.js)

### 10.1 每日打卡系统

**数据结构**：
```javascript
{
  dates: ["2026-07-01", "2026-07-02", ...],  // 已打卡日期列表
  streak: 5,      // 连续打卡天数
  lastDate: "2026-07-02"  // 最后打卡日期
}
```

**连续天数计算原理**：
- 打卡时判断 `lastDate` 是否为昨天 → 是则 `streak + 1`，否则重置为 1
- 撤销打卡时通过 `recalcStreak()` 从 `dates` 数组重新计算

**周历视图**：`getWeekDays()` 计算本周一至周日，已打卡日期绿色渐变，今天蓝色边框高亮。

### 10.2 今日聚焦

**原理**：
- 聚焦任务数量可在设置中调整（默认 3，范围 2~5）
- 聚焦任务与原始待办**双向同步**（完成聚焦→同步完成待办含级联，反之亦然）
- 待办选择器为树形结构，支持搜索过滤

### 10.3 长期目标

- 「今天」页面顶部的目标卡片，支持正文、截止日期、计时器关联
- 编辑弹窗仿照待办样式，操作按钮右对齐

### 10.4 日报系统

- **晨间日报**（打卡后触发）：回顾昨天完成 + 开启今天方向，系统提示词为「学习伙伴」风格
- **晚间日报**（设置中开启，默认 21:00）：温暖风格总结当天、沉淀收获
- 数据焦点是"昨天"：昨日完成待办、昨日计时、逾期待办、今日截止待办、昨日笔记、待复习、习惯数据
- 日报在 AI 助手「每日日报」专用对话标签页中生成

### 10.5 桌面通知系统

**双环境兼容**：
- Electron 环境：调用 `window.electronAPI.showNotification()` → 主进程 IPC → 系统通知
- 浏览器环境：使用 Web Notification API，需要用户授权

---

## 11. AI 助手模块（8 模块拆分）

原 `js/ai.js`（约 3600 行）已拆分为 **8 个独立模块**，按依赖顺序加载：

```
ai-utils.js   — 工具函数：JSON 序列化、数据保存、确认弹窗、计时格式化
ai-conv.js    — 对话管理：设置弹窗、创建/切换/删除/清空对话、导出日志、标签页拖拽、输入草稿
ai-attach.js  — 附件处理：文件上传、预览、Kimi 文件处理、视觉文件识别、拖拽添加附件
ai-render.js  — UI渲染：聊天界面、消息列表、Markdown/LaTeX 格式化、选中文字保存笔记
ai-tools.js   — 工具系统：工具定义、系统提示词构建、工具执行、调用解析
ai-search.js  — 网络搜索 & 通知：多引擎搜索、Windows 通知、侧边栏徽章
ai-api.js     — API通信：API 调用、消息构建、工具调用循环、调试日志
ai-send.js    — 消息发送：发送流程、候选回复管理、工具栏、快速操作
```

> 说明：拆分前备份已随旧架构清理移除；`js/ai.js` 仅保留模块拆分说明占位。

### 11.1 对话管理（ai-conv.js）

**数据结构**：
```javascript
aiConvs = [{
  id: 1690123456789,
  title: "数学问题",
  systemPrompt: "你是一个数学老师...",
  messages: [
    { role: "user", content: "什么是微积分？", time: "2026-07-06 12:00" },
    { role: "assistant", content: "微积分是...", time: "2026-07-06 12:01", reasoning: "..." }
  ],
  autoTitled: true,
  _dailyReport: false,     // 标记为日报专用对话
  _hasUnreadAuto: false    // 标记有未读的自动化结果
}]
```

**功能**：多对话标签页（可拖拽排序）、输入草稿独立保存、自动标题生成（可指定 Key）、对话日志导出。

### 11.2 系统提示词构建（ai-tools.js）

`buildToolsSystemPrompt()` 是 AI 助手的核心：

**原理**：每次发送消息前，动态构建包含以下内容的系统提示词：

1. **角色设定**：告知 AI 它是「我的学习桌面」的内置助手
2. **模块概览**：描述所有系统模块的功能
3. **工具调用说明**：`<tool_call>` JSON 格式、可用工具列表、调用规则
4. **实时数据快照**：待办概览、今日聚焦、打卡连续天数、笔记/链接数量、自动化任务、记忆点等
5. **开发者模式**（可选）

**数据注入策略**：每次对话都注入最新数据，确保 AI 的上下文始终是最新的。

### 11.3 工具调用（Function Calling）机制（ai-tools.js）

这是本应用最核心的 AI 集成设计：

**定义层**：`AI_TOOLS` 对象定义所有可用工具及其参数：

```
📋 待办：add_todo / batch_add_todos / update_todo / delete_todo / toggle_todo / move_todo /
        list_todos / get_todo_detail / batch_update_todos / get_todo_stats
🎯 聚焦：get_today_status / get_focus_tasks / set_focus_task / get_stats
📝 笔记：add_note / update_note / move_note / delete_note / list_notes /
        search_notes / get_note_detail / get_note_changes
🔗 链接：add_link / delete_link / list_links
⏰ 自动化：schedule_automation / list_automations / delete_automation
🧠 记忆：list_memories / get_memory_detail
📚 复习与习惯：get_review_status / get_habits_status
🔎 搜索：web_search（支持 5 种引擎）
```

**解析层** (`extractToolCalls` / `parseSingleToolCall`)：
1. 使用正则匹配 AI 回复中的 `<tool_call>...</tool_call>` 标签
2. `parseSingleToolCall` 使用 `JSON.parse()` 解析 `params` 对象（**不要手动正则提取字段**，否则 JSON 转义不解码，导致 `\\Delta` 等 LaTeX 内容失败）
3. 返回干净的显示文本 + 工具调用列表

**执行层** (`executeToolCall`)：
- 根据 action 名称分发到对应的处理逻辑
- 操作 `todos`/`notes`/`links` 等全局数据，调用 `saveData` 持久化
- 返回中文结果描述

**多工具并行**：一条回复可包含多个 `<tool_call>`，按顺序执行并合并结果。重复检测按每个 tool_call 单独比对（action + params），避免误判。

### 11.4 API 请求流程（ai-api.js / ai-send.js）

`sendAiMessage()`（ai-send.js）的完整流程：

```
1. 检查 API Key → 无则打开设置
2. 处理附件（读取文件内容，txt/PDF/Word/Excel/图片）
3. 构建用户消息 → 推入对话
4. 自动标题（首次对话时用前20字作为标题）
5. 清空输入框 + 显示加载动画
6. 构建 API 消息列表（system + 最近N条历史）
7. 发送 POST 请求到 {baseUrl}/chat/completions
8. 解析响应 → 提取工具调用 → 执行工具 → 合并结果
9. 推入助手消息 → 保存 → 重新渲染
10. 自动标题（异步，不阻塞主流程）
```

**深度思考支持**：DeepSeek/Kimi 模型通过 `extra_body.thinking.type` 参数控制，开启时捕获 `reasoning_content` 并在聊天中可折叠展示。

**多候选回复**：支持 DeepSeek 风格的多候选切换，候选数据结构为完整交互链 `{ messages: [...] }`，可跨候选导航与采纳。

**并行对话**：每个对话标签页独立加载/停止，切换不干扰。

### 11.5 附件处理（ai-attach.js）

- 支持 `.txt`、PDF、Word、Excel、图片等附件（20MB 限制）
- 支持从文件管理器**拖拽文件**到对话区域添加附件
- Kimi 视觉模型可分析图片/视频
- 图片文件限制 6MB（Data URL 会膨胀 ~33%）

### 11.6 Markdown 渲染（ai-render.js）

`formatMarkdownBase(text, extraProcessor)` 是一个通用 Markdown → HTML 渲染器：

**处理步骤**：
1. HTML 转义（防 XSS）
2. 保护代码块（` ``` `）→ 占位符
3. 保护表格 → 占位符
4. 保护行内代码（`` ` ``）→ 占位符
5. 转换分隔线、标题、粗体、斜体
6. 转换无序列表
7. 执行额外处理器（如 AI 消息中的 `[ID:数字]` → 可点击链接）
8. 还原占位符
9. 换行 → `<br>`

**LaTeX 支持**：`latexToHtml` 递归处理 `\frac{}{}` / `\sqrt{}` 内部内容（避免嵌套命令未转换）；支持 `\( \)`、`\[ \]`、`$$...$$` 定界符；裸 LaTeX 命令自动包裹行内定界符。

### 11.7 长期记忆系统（memory.js）

- **6 类记忆**：事实 / 偏好与习惯 / 目标 / 能力 / 行为模式 / 心理模式
- 对话中通过 `<memory>` 标签实时提取 → 离开对话时生成摘要+提取事实（500ms 防抖）→ 每日整合总摘要并更新用户画像
- **置信度算法**（纯 JS）：完全重复 +0.3，模糊相似同向 +0.15 / 矛盾 -0.3，每日衰减 -0.02，低于 0.3 自动清除
- 双层结构：简略信息（prompt 显示）+ 详细内容（展开查看）
- 日期判断使用本地时区（`getLocalDateStr()`），不用 `toISOString()` UTC

### 11.8 网络搜索（ai-search.js）

- 5 种引擎：DuckDuckGo（免费）/ Brave / Tavily / Exa / SearchAPI
- 按对话独立开关，各引擎可填专用 Key

### 11.9 定时自动化

- AI 可通过 `schedule_automation` 工具创建定时任务（时间、描述、重复模式）
- 主进程/渲染层每 30 秒检查一次，到达时间向对话注入触发消息，执行完成后发送桌面通知

---

## 12. 设置模块 (settings.js)

### 12.1 API Key 多密钥管理

**原理**：
- 支持配置多个 API Key，每个包含：名称、密钥、Base URL、模型、温度、深度思考开关
- 通过 `study_active_api_key_id` 记录当前使用的 Key，聊天界面顶部下拉即时切换
- 每条 AI 回复标注使用的 Key 名称
- **旧版数据自动迁移**：首次加载时检测旧格式 → 转换为多 Key 格式

### 12.2 自动化任务引擎

**数据结构**：
```javascript
{
  id: 1690123456789,
  convId: 1690123456788,  // 关联的对话ID
  at: "09:00",            // 触发时间 HH:MM
  prompt: "总结今日待办",   // 任务描述
  repeat: "daily",        // "daily" | "once"
  createdAt: "...",
  lastRun: "2026-07-06 09:00",
  enabled: true
}
```

**定时检测原理**：`setInterval(checkAutomations, 30000)` 每 30 秒检查，匹配 + 今天未运行过 → 触发执行；一次性任务执行后自动禁用。

### 12.3 每日日报生成

**触发时机**：晨间日报在每日打卡后自动触发；晚间日报按设置时间（默认 21:00）触发。

**原理**：
1. 收集数据（昨日待办/计时/笔记/逾期/复习/习惯）
2. 构建引导式日报提示词（回顾昨天 + 开启今天）
3. 发送到专门的「每日日报」对话，AI 生成日报
4. 发送 Windows 通知

### 12.4 数据导入/导出与文件备份

- **导出** (`exportAllData`)：收集 `MIGRATION_KEYS` 中所有 localStorage 键 → JSON → 下载
- **导入** (`importAllData`)：读取 JSON → 逐键写入 → 刷新页面
- **文件系统备份**（Electron）：设置间隔自动备份到 `~/.my-study-table/backups/`，最大备份数可调（默认 30），超限自动清理最旧

### 12.5 更新日志系统

**原理**：
- `initChangelog()` 硬编码完整更新日志列表（当前 v0.1.11），每次启动整体覆盖 localStorage
- 在弹窗中以卡片列表展示，保留用户自定义条目

### 12.6 帮助系统

按栏目展示的详细使用说明 + 快捷键参考。

### 12.7 外观系统

- 6 个内置主题预设 + 自定义预设（可保存/覆盖/删除）
- 背景系统：无/纯色/渐变/图片/视频 5 种类型
- 磨砂玻璃：开关 + 磨砂程度/透明度
- **液态玻璃折射**：`glassCurve`（弯曲强度）/ `glassDeflect`（偏折）/ `glassGlow`（辉光）三独立控制
- **预设→自定义切换规则**：`switchToCustomMode(cfg)` 是唯一切换到自定义模式的入口，所有设置修改 handler 必须先调用它（复制预设全部有效值到 cfg），禁止内联 `cfg.preset = 'custom'`

### 12.8 调试模式与开发者模式

- 开启后在「今天」页面显示打卡调试面板
- `study_developer_mode` / `study_debug_mode` 两个独立开关

---

## 13. 工具模块 (utils.js)

### 13.1 HTML 转义

```javascript
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;  // 浏览器自动转义
  return div.innerHTML;
}
function escapeAttr(str) { /* 额外转义引号，用于 HTML 属性 */ }
```

**原理**：利用浏览器的 DOM API 自动处理 HTML 转义，比正则替换更安全可靠。**属性值必须用 `escapeAttr`**（`escapeHtml` 不转义引号）。

### 13.2 全局快捷键

```javascript
document.addEventListener('keydown', function(e) {
  // Esc: 按优先级关闭弹窗
  // Ctrl+Z: 笔记编辑器撤销（输入框中交还原生撤销）
  // Ctrl+Y: 笔记编辑器重做
  // Ctrl+1~9: 切换侧边栏栏目
  // Ctrl+R / F5: 刷新页面
});
```

### 13.3 滚动条自动显隐

**原理**：监听全局 `scroll` 和 `wheel` 事件，添加 `.scrolling` 类到 `<html>`，800ms 无滚动后移除。

### 13.4 初始化流程

```javascript
applyTheme(getTheme());           // 1. 应用保存的主题
// 恢复侧边栏状态                  // 2. 如果上次打开则展开
initSidebarHover();               // 3. 初始化侧边栏悬停触发
initChangelog();                  // 4. 初始化更新日志
safeInit(renderTodos, ...);       // 5~12. 每个模块独立初始化（单个失败不影响其他）
// checkDailyIntegration()        // AI 记忆每日整合
```

`safeInit(fn, name)` 为每个模块提供 try-catch 保护，避免单个渲染失败导致整页崩溃。

---

## 14. 数据持久化原理

### 14.1 存储方案

**唯一存储介质**：浏览器 `localStorage`

| 存储 Key | 数据 | 格式 |
|----------|------|------|
| `study_todos_v2` | 待办列表 | JSON Array |
| `study_links_v3` | 快捷访问 | JSON Array |
| `study_notes_v2` | 笔记列表 | JSON Array |
| `study_active_note` | 当前笔记ID | Number String |
| `study_changelog` | 更新日志 | JSON Array |
| `study_ai_convs` | AI对话列表 | JSON Array |
| `study_active_conv` | 当前对话ID | Number String |
| `study_api_keys` | API密钥配置 | JSON Array |
| `study_active_api_key_id` | 当前使用的Key ID | String |
| `study_theme` | 主题偏好 | "light"/"dark" |
| `study_sidebar_open` | 侧边栏状态 | "true"/"false" |
| `study_checkin` | 打卡数据 | JSON Object |
| `study_today_focus` | 今日聚焦 | JSON Object |
| `study_automations` | 自动化任务 | JSON Array |
| `study_developer_mode` | 开发者模式 | "true"/"false" |
| `study_debug_mode` | 调试模式 | "true"/"false" |
| `study_nav_config` | 导航排序/隐藏配置 | JSON Object |
| `study_timer_records` | 计时记录 | JSON Array |
| `study_habits` | 习惯数据 | JSON Object |
| `study_calendar_events` | 日历事件 | JSON Array |
| `study_memory_*` | AI 记忆数据 | JSON Object |
| `study_review_settings` | 复习间隔配置 | JSON Array |
| `study_backup_interval` | 备份间隔 | String |
| `study_status_options` | 自定义状态 | JSON Array |
| `study_api_debug_logs` | AI 调试日志 | JSON Array |

### 14.2 写入策略

- **待办/链接/自动化**：操作后立即写入
- **笔记**：防抖写入（400-500ms 延迟），减少频繁 I/O
- **AI 对话**：每条消息后立即写入
- **自动备份**：按设置间隔将全部数据写入文件系统

### 14.3 版本化存储

存储 Key 带版本号（如 `_v2`、`_v3`），支持数据结构升级时平滑迁移。

### 14.4 容错机制

- `loadData` 包含 try-catch，解析失败返回空数组
- 所有读取操作都有防御性默认值
- AI 调试日志设上限，防止 localStorage 膨胀

---

## 15. 完整执行流程

### 15.1 应用启动流程

```
1. Electron 主进程启动
   ├── 重定向 userData 到 ~/.my-study-table
   ├── 创建系统托盘
   ├── 创建 BrowserWindow
   ├── 初始化 autoUpdater（仅打包环境）
   └── 加载 index.html

2. HTML 解析
   ├── 加载 css/style.css → 应用样式
   ├── 加载 lib/katex → LaTeX 渲染引擎
   └── 构建 DOM 树

3. JS 顺序加载执行（约 24 个文件）
   ├── liquid-glass.js → 定义液态玻璃滤镜
   ├── core.js → 数据加载、迁移、主题、导航
   ├── trash.js → 回收站函数
   ├── todos.js → 待办函数
   ├── notes.js → 笔记函数
   ├── links.js → 链接函数
   ├── today.js → 打卡/聚焦/通知
   ├── ai-utils.js → ai-conv.js → ai-attach.js → ai-render.js
   ├── ai-tools.js → ai-search.js → ai-api.js → ai-send.js
   ├── music.js → 音乐播放器
   ├── memory.js → AI 记忆系统
   ├── settings.js → 设置/自动化/日报/外观
   ├── utils.js → 工具函数 + 初始化（渲染所有模块）
   ├── calendar.js → 日历
   ├── timer.js → 计时器
   ├── habits.js → 习惯
   ├── stats.js → 统计
   └── updater.js → 自动更新（自启动）
```

### 15.2 用户操作流程示例

**添加待办**：
```
用户输入 → addTodo() → 创建对象 → todos.unshift() → saveData() → renderTodos()
```

**AI 对话**：
```
用户输入 → sendAiMessage()
  → 构建系统提示词（注入实时数据）
  → fetch API
  → 解析响应 → extractToolCalls()
  → executeToolCall()（如 add_todo 等）
  → 更新全局数据 → 刷新所有视图
```

**每日打卡**：
```
点击打卡 → doDailyCheckin()
  → 更新打卡数据
  → 计算连续天数
  → 随机选择名言 → 弹窗
  → generateDailyReport() → AI 生成晨间日报
```

**自动化触发**：
```
setInterval 检测 → 时间匹配
  → executeAutomation()
  → 注入系统消息到对话
  → AI API 请求
  → 解析工具调用 → 执行
  → 发送通知
```

---

## 16. 自动更新系统

应用通过 `electron-updater` 实现自动更新，发布渠道为 **GitHub Releases**。

### 16.1 主进程（main.js）

- `initAutoUpdater()` 在 `app.whenReady` 中调用，**动态 require** `electron-updater`（仅打包环境加载）
- **支持判断**：`updaterSupported = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && autoUpdater.isUpdaterActive()`——仅 NSIS 安装版支持；开发模式 / portable（`PORTABLE_EXECUTABLE_FILE` 环境变量）/ zip 解压版不支持
- `autoUpdater.autoDownload = false`（下载由渲染层确认后触发）、`autoInstallOnAppQuit = false`
- 事件（`checking-for-update` / `update-available` / `update-not-available` / `error` / `download-progress` / `update-downloaded`）统一转发到渲染层 `update:event` IPC
- IPC：`update:get-state`（查询支持状态）、`update:check`、`update:download`、`update:install`（`quitAndInstall`）

### 16.2 渲染层（js/updater.js）

- 自启动 IIFE 状态机：`idle / checking / available / not-available / downloading / downloaded / error / unsupported`
- **三种检查时机**：启动后 5 秒自动检查 + 每小时定时检查（`setInterval`）+ 设置页手动「检查更新」按钮
- 发现新版本自动弹出更新弹窗，下载时实时显示进度条，下载完成提供「重启并安装」
- 便携版/解压版自动降级为「前往发布页手动下载」提示
- 全局函数：`checkForUpdatesNow` / `updaterStartDownload` / `updaterInstallNow` / `closeUpdateModal`

### 16.3 发布流程

1. 修改 `package.json` 的 `version`（需高于已安装版本），同步更新 `settings.js` 更新日志
2. 配置 `build.publish`（provider: github，owner/repo 指向真实仓库）
3. 设置环境变量 `GH_TOKEN`（GitHub Personal Access Token，`repo` 权限）
4. 执行 `build_app.bat` 选项 4（或 `npm run publish`，即 `electron-builder --win nsis --publish always`）
5. 确认 GitHub Releases 生成对应版本号 Release，包含 Setup exe 与 `latest.yml`

> 未签名应用的安装程序在 Windows 上可能出现 SmartScreen 警告，属正常现象。

---

> **文档结束** — 此文档解释了 My Study Table v1.9 的所有代码原理。应用采用纯前端架构（HTML + CSS + JS），以 localStorage 为唯一数据存储，通过 Electron 实现桌面化运行，并通过 electron-updater 实现自动更新。核心设计亮点包括：树形邻接列表数据结构、AI 8 模块拆分与工具调用机制、防抖自动保存、定时自动化引擎、双向数据同步、液态玻璃折射、长期记忆置信度算法，以及完整的自动更新体系。
