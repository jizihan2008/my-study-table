---
name: ai-memory-system
overview: 为 AI 对话添加跨对话的长期记忆系统，包含用户档案、自动提取、手动编辑、对话摘要四个模块，存储在 localStorage 中，对话结束时自动提取摘要。
design:
  architecture:
    framework: react
    component: shadcn
  styleKeywords:
    - Minimalism
    - Clean
    - Consistent with existing settings UI
  fontSystem:
    fontFamily: system-ui
    heading:
      size: 15px
      weight: 600
    subheading:
      size: 12px
      weight: 500
    body:
      size: 13px
      weight: 400
todos:
  - id: memory-data-layer
    content: 在 js/ai.js 中新增 loadAiMemory/saveAiMemory 函数和 formatMemoryForPrompt 格式化函数
    status: pending
  - id: memory-injection
    content: 修改 buildToolsSystemPrompt() 在末尾注入长期记忆内容
    status: pending
    dependencies:
      - memory-data-layer
  - id: memory-auto-extract
    content: 新增 extractMemoryFromConv() 函数，在 createNewConv/switchConv/deleteConv/clearConvMessages 中调用
    status: pending
    dependencies:
      - memory-data-layer
  - id: memory-settings-ui
    content: 在 index.html 新增「🧠 记忆」设置标签页 HTML，使用 [skill:frontend-design] 设计内存管理面板 UI
    status: pending
    dependencies:
      - memory-data-layer
  - id: memory-settings-logic
    content: 在 js/settings.js 中新增 renderMemoryPanel/saveProfileField/记忆CRUD等逻辑函数
    status: pending
    dependencies:
      - memory-settings-ui
  - id: memory-styles
    content: 在 css/style.css 中新增记忆面板相关样式
    status: pending
    dependencies:
      - memory-settings-ui
---

## 用户需求

为 AI 对话添加长期的、跨对话的记忆功能，让 AI 能记住用户在不同对话中提及的个人信息、偏好、目标和重要事实。

## 核心功能

1. **用户档案**：用户可填写基本信息（称呼、身份背景、学习目标、偏好），每次对话 AI 都能知晓
2. **手动编辑的记忆**：用户在设置面板中自行添加/编辑/删除"AI 需要记住的事项"
3. **自动提取的记忆**：对话结束时自动让 AI 从当前对话中提取值得记住的事实，存入记忆库
4. **对话摘要**：对话结束时自动让 AI 生成一段摘要，后续对话可参考过往摘要
5. **记忆注入 System Prompt**：每次发送消息时，将所有记忆内容注入 system prompt，让 AI 知晓
6. **设置面板记忆标签页**：在设置模态框中新增一个「🧠 记忆」标签页，统一管理以上内容

## 视觉设计

- 设置面板新增「🧠 记忆」标签，图标使用大脑 emoji
- 用户档案使用表单布局（标签 + 输入框 + 提示文字）
- 手动记忆以卡片列表展示（可编辑/删除），底部有添加按钮
- 自动记忆以只读卡片列表展示，有清空按钮
- 对话摘要以精简列表展示，可查看详情或删除

## 技术栈

- **现有技术**：纯前端 HTML + CSS + JavaScript，localStorage 持久化
- **存储 Key**：`study_ai_memory`（JSON 对象）
- **注入机制**：在 `buildToolsSystemPrompt()` 尾部注入格式化的记忆内容
- **自动提取时机**：创建新对话、切换对话、删除对话、清空消息时，对离开的对话进行摘要+事实提取

## 实现方案

### 数据层设计

在 localStorage 中以 `study_ai_memory` 键存储以下结构：

```javascript
{
  profile: {
    nickname: '',        // 称呼
    background: '',      // 身份/背景
    goals: '',           // 学习目标
    preferences: ''      // 偏好
  },
  manualNotes: [         // 用户手动编辑
    { id: number, text: string, createdAt: string, updatedAt: string }
  ],
  autoFacts: [           // AI 自动提取的事实
    { id: number, text: string, sourceConvId: string, sourceConvTitle: string, createdAt: string }
  ],
  convSummaries: [       // 对话摘要（保留最近 20 条）
    { id: number, convId: string, convTitle: string, summary: string, messagesCount: number, createdAt: string }
  ]
}
```

### 关键设计决策

1. **自动提取策略**：

- 触发时机：`createNewConv()`、`switchConv()`、`deleteConv()`、`clearConvMessages()` 中，如果当前对话有 ≥ 3 条有效消息且未被摘要过，触发一次性 AI 请求来提取摘要+事实
- 提取方式：发送专门的「记忆提取」API 请求（不需要用户等待），异步执行
- 提取 prompt：让 AI 分析对话内容，输出结构化的摘要和事实列表
- 使用 `_memoryExtractedVersion` 标记避免重复提取（记录已提取的消息数，只有新消息时才再提取）

2. **记忆注入**：

- 在 `buildToolsSystemPrompt()` 末尾增加一段「═══ 长期记忆 ═══」区域
- 内容顺序：用户档案 → 手动记忆 → 自动事实（最多 20 条） → 近期对话摘要（最多 5 条）
- 自动事实和对话摘要按时间倒序排列（最新的在前）

3. **UI 布局**：

- 在设置面板 tabs 中，在「AI 设置」和「数据」之间插入「🧠 记忆」tab
- 面板内部使用上下分块结构，每块有独立标题
- 用户档案：4 个输入框（称呼、背景、目标、偏好）
- 手动记忆：卡片列表 + 内联添加/编辑表单
- 自动提取的记忆：只读卡片列表 +「清空所有自动记忆」按钮
- 对话摘要：精简列表 + 展开查看详情 + 删除

### 注入 system prompt 的格式

```
═══ 长期记忆 ═══

【用户档案】
称呼：小明
身份背景：大三计算机系学生
学习目标：准备考研，重点复习数学和数据结构
偏好：回复简洁，不要太多废话

【手动记录的事实】
• 用户的工作日是周一到周五
• 用户不喜欢太长回复

【AI 从过往对话中了解到的】
• 用户提到数据结构期末考试在7月15日（来源：对话"数据结构复习"）
• 用户说周末一般不学习（来源：对话"学习计划"）

【近期对话摘要】
• 2026-07-09 「数据结构复习」：讨论了二叉树遍历算法，用户对递归理解有困难，建议了可视化学习工具
• 2026-07-08 「学习计划」：制定了7月复习计划，重点推荐了LeetCode刷题策略
```

### 文件修改清单

**index.html**

- 在设置 tabs 中新增「🧠 记忆」按钮（`settingsTabMemory`），放在 AI 设置和自动化之间
- 新增 `settingsPanelMemory` 面板 HTML，包含用户档案、手动记忆、自动记忆、对话摘要四个区块

**js/ai.js**

- 新增 `extractMemoryFromConv(conv)` 函数：异步调用 AI API 提取对话摘要和事实
- 修改 `createNewConv()`：切换到新对话前触发 `extractMemoryFromConv`
- 修改 `switchConv(id)`：切换到其他对话前触发 `extractMemoryFromConv`
- 修改 `deleteConv(id, e)`：删除对话前触发 `extractMemoryFromConv`
- 修改 `clearConvMessages(e)`：清空前触发 `extractMemoryFromConv`
- 修改 `buildToolsSystemPrompt()`：在开发者模式之前注入长期记忆内容
- 新增 `loadAiMemory()` / `saveAiMemory()` 辅助函数
- 新增 `formatMemoryForPrompt()` 函数：将记忆数据格式化为 system prompt 文本

**js/settings.js**

- 修改 `switchSettingsTab(tab)`：支持 'memory' 标签
- 修改 `openSettingsModal()`：加载记忆数据到表单
- 新增 `renderMemoryPanel()`：渲染记忆面板的内容
- 新增 `saveProfileField(key)`：自动保存档案字段
- 新增 `addManualNote()` / `editManualNote()` / `deleteManualNote()`
- 新增 `clearAutoFacts()` / `deleteConvSummary(id)`

**css/style.css**

- 新增 `.memory-section` / `.memory-card` / `.memory-card-list` 等样式

### 注意事项

- 自动提取时如果 API Key 未配置，静默跳过（不阻塞用户操作）
- 自动提取采用 `async` 方式，不阻塞 UI
- 用 `conv._memoryExtractedVersion` 标记已处理的消息数量，避免重复提取
- 对话摘要最多保留 20 条，超出时自动删除最旧的

### 数据流

```
用户操作（新建/切换/删除对话）
  → extractMemoryFromConv(旧对话)
    → 检查是否有新消息需要提取
    → 调用 AI API 获取摘要+事实
    → 保存到 localStorage
  → 用户进入新对话
  → buildToolsSystemPrompt()
    → 加载 study_ai_memory
    → 格式化注入 system prompt
  → AI 知晓长期记忆
```

## Design Style

采用与现有设置面板一致的极简风格，以简洁清晰的层级区分不同记忆区块。使用卡片分组展示不同类型的记忆，输入框采用与现有设置字段一致的样式。每个区块用轻分割线分隔，区块标题使用与设置面板一致的 `settings-section-title` 样式。

## Design Content

### 页面规划

- 设置模态框中新增一个「🧠 记忆」标签页，作为单独的面板

### 布局结构

1. **用户档案**：4 行表单，每行标签 + 输入框 + 灰色提示文字
2. **手动记忆**：卡片列表（每条一个带边框卡片，含文本+操作按钮）+ 底部的添加按钮/内联表单
3. **自动提取的记忆**：只读卡片列表 +「清空所有自动记忆」按钮
4. **对话摘要**：精简列表（显示时间+标题+前30字摘要），点击展开详情，可删除

### 交互设计

- 档案字段 blur/change 自动保存（与现有设置一致）
- 手动记忆点击「编辑」原地展开编辑框，点击「删除」弹出确认框
- 自动记忆卡片不可编辑，提供全局清除按钮
- 对话摘要点击展开/收起详情，hover 显示删除按钮

## Agent Extensions

### SubAgent

- **code-explorer**
- 用途：在实施阶段用于探索多个文件的交叉引用（如确认所有 extractMemoryFromConv 的调用点、确认 buildToolsSystemPrompt 中注入位置、确认 settings.js 中 switchSettingsTab 的所有依赖）
- 预期产出：精确的代码位置和上下文，确保改动不遗漏调用点且与现有模式一致

### Skills

- **frontend-design**
- 用途：为设置面板的「🧠 记忆」标签页设计美观、与现有风格一致的 UI（用户档案表单、记忆卡片列表、对话摘要列表等）
- 预期产出：符合项目现有 CSS 变量体系的、视觉上干净现代的 UI 代码