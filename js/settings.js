// ═══════════ Changelog Modal ═══════════
function initChangelog() {
  const fullChangelog = [
    { id: 25, time: '2026-08-10T22:00', content: '<b>v0.2.8</b> — 📥 新增「收件箱」消息助手：邮箱 / 微信 / QQ / 文件统一接收与 AI 概括：<br><br>📬 <b>邮箱自动接收</b> — IMAP 协议接入（QQ / 163 / Gmail / Outlook 等，需在邮箱开启 IMAP 并填授权码），一键测试连接与拉取最近邮件，展示发件人、主题、时间、正文<br>📸 <b>窗口长截图导入（微信 / QQ）</b> — 打开要导入的聊天窗口，应用自动枚举可见窗口，选择后<b>自动滚动长截图</b>（逐屏截图 + 判定滚动到底 + 纵向拼接），无需逆向协议、零封号风险<br>📋 <b>粘贴文本导入</b> — 直接把微信 / QQ 消息复制粘贴进收件箱，标记来源渠道<br>📁 <b>文件目录自动收集</b> — 配置微信 / QQ 文件保存目录，自动扫描新增文件（图片 / 文本）导入收件箱；QQ 默认 <code>文档\\Tencent Files\\&lt;QQ号&gt;\\FileRecv</code>，微信 <code>文档\\WeChat Files\\&lt;wxid&gt;\\FileStorage</code><br>📎 <b>文件拖入导入</b> — 手动保存的 PDF / Word 等聊天文件可直接拖入收件箱由 AI 概括（文本类直读内容，图片走视觉模型）<br>✨ <b>AI 概括</b> — 每条消息一键 AI 概括要点（一句话核心 + 分点要点 + 待办事项），截图由视觉模型（Kimi 等）直接分析，概括失败可重试<br>🗂️ <b>统一消息流</b> — 全部渠道消息集中卡片式展示，渠道筛选胶囊（全部 / 邮箱 / 微信 / QQ / 文件 / 手动），展开原文、预览截图、删除<br>🔒 <b>隐私安全</b> — 邮箱授权码与消息仅存本地，AI 调用走你自有的 API Key，无任何服务器上传' },
    { id: 23, time: '2026-08-06T12:00', content: '<b>v0.2.6</b> — 任务图滚动缩放与自由平移、计时器浮窗、模式标签中文化、多项修复：<br><br>🗺️ <b>任务图滚动缩放</b> — 任务图支持鼠标滚轮缩放，自由调节视图大小<br>🖐️ <b>任务图自由平移</b> — 按住拖拽即可平移任务图，配合缩放方便查看大型 DAG<br>⏱️ <b>计时器浮窗</b> — 计时器支持浮窗模式，专注时随时可见<br>🏷️ <b>模式标签中文化</b> — AI 编程三模式（Craft / Plan / Ask）标签文案中文化，更直观<br>🔧 <b>多项修复</b> — 若干体验与稳定性修复' },
    { id: 22, time: '2026-08-05T22:00', content: '<b>v0.2.5</b> — 任务线系统（GTNH 式任务书）：<br><br>🗺️ <b>任务图</b> — GTNH 式平面任务图：<b>金色框</b>=主线关键任务、<b>蓝色框</b>=支线任务、<b>箭头连线</b>=前置依赖（完成 A 解锁 B），由 AI 设计任务线的样子，推进感拉满<br>📂 <b>章节目录浮窗</b> — 侧边栏顶部「章节」按钮展开目录（主线章节 / 素质线），徽章收藏与自定义奖励池收纳在浮窗 Tab 内<br>⚔️ <b>任务机制</b> — 任务带<b>三段式描述</b>（目标 / 意义 / 产出）、<b>前置依赖解锁</b>、<b>完成条件</b>（绑定待办完成 / 笔记撰写 / 专注计时达标 / 手动打卡，自动检测 + 手动双轨）<br>🎖️ <b>奖励</b> — 即时反馈（完成任务通知 + 自动结算）+ 徽章收藏墙（章节达成 / 累计完成）+ 自定义奖励池（完成任务计数兑换，自己填欲望清单）<br>🤖 <b>与对话 AI 深度适配</b> — 注册 <code>quest_get / quest_create / quest_create_line / quest_update / quest_link_todo / quest_link_note / quest_link_timer / quest_complete / quest_skip / quest_review</code> 等 12 个工具，AI 对话里说「给我英语线加任务」「我刚完成 XX」即可直接操作；AI 生成任务默认<b>草稿</b>状态待你确认；system prompt 自动注入当前任务线状态（主线章节 / 激活任务 / 进度 / 卡点）<br>☀️ <b>日报联动</b> — 晨间 / 晚间日报新增任务线板块（主线进度 / 激活任务 / 昨日完成任务），回顾与开启今天都带任务线视角' },
    { id: 20, time: '2026-08-05T01:00', content: '<b>v0.2.3</b> — AI 编程三模式 + 插件市场：<br><br>🧭 <b>AI 编程三模式</b> — AI 编程输入区新增模式选择器（类比 CodeBuddy）：<br>&emsp;• <b>Craft（开发）</b> — 全功能模式，可读写扩展目录，直接生成代码<br>&emsp;• <b>Plan（规划）</b> — 只读模式，AI 分析需求并给出详细实现方案和架构设计，不写文件<br>&emsp;• <b>Ask（问答）</b> — 只读模式，回答应用架构、API、扩展开发相关问题<br>&emsp;• 消息流中 plan/ask 模式用户消息带有模式标记<br>🛒 <b>插件市场</b> — 全新「插件市场」页面，基于 Supabase 的免费社区市场：<br>&emsp;• <b>浏览下载</b> — 浏览已上架扩展，支持名称/标签搜索，一键下载安装到本地<br>&emsp;• <b>上传发布</b> — 将本地扩展发布到市场，经审核后供其他用户下载<br>&emsp;• <b>评分系统</b> — 对已安装的扩展打分（1~5 星）<br>&emsp;• <b>ZIP 导入</b> — 支持从本地 ZIP 文件直接安装扩展<br>&emsp;• <b>配置</b> — 设置 → 插件市场：与好友系统共用 Supabase 项目，填入 URL + anon key 即可<br>⚠️ 使用前提：需在 Supabase 控制台执行 <code>supabase/schema.sql</code> 新增的插件市场建表语句，并创建 <code>plugin-store</code> Storage bucket' },
    { id: 19, time: '2026-08-05T10:00', content: '<b>v0.3.0</b> — 好友系统（Supabase 云端）：<br><br>👥 <b>真实联网好友</b> — 全新「好友」页面，基于 Supabase 云端服务，实现跨设备真实好友：<br>&emsp;• <b>账号系统</b> — 邮箱注册 / 登录 / 退出，会话持久化，自动恢复登录<br>&emsp;• <b>好友管理</b> — 按用户名 / 昵称搜索添加、好友请求收发（接受 / 拒绝 / 撤回）、删除好友、好友列表<br>&emsp;• <b>好友分组</b> — 创建 / 重命名 / 删除分组，好友自由归类（彩色标签）<br>&emsp;• <b>好友资料卡</b> — 头像、昵称、简介、在线状态、最近学习统计（7 日打卡 / 专注 / 完成数）<br>&emsp;• <b>学习动态流</b> — 好友的打卡、专注突破、任务完成、连续天数等动态实时推送<br>&emsp;• <b>实时聊天</b> — 与好友实时收发消息、未读红点、最近消息预览<br>🔒 <b>隐私安全</b> — 只同步聚合统计（打卡 / 专注时长 / 完成数量），绝不上传具体待办与笔记内容；所有云表启用行级安全（RLS），仅本人与好友可见<br>⚙️ <b>配置</b> — 设置 → 好友：填入 Supabase 项目 URL 与 anon key 即可启用；建表脚本见 <code>supabase/schema.sql</code>' },
    { id: 18, time: '2026-08-05T01:00', content: '<b>v0.2.1</b> — 扩展管理体验升级：<br><br>🗑️ <b>扩展软件内回收站</b> — 卸载扩展不再直接删除，而是移入软件自带的回收站（回收站页面新增「扩展」分类），可随时恢复 / 彻底删除；清空回收站会一并清空扩展回收站<br>📥 <b>导入扩展</b> — 扩展页新增「导入扩展」按钮（选择文件夹）与全页拖拽导入：把扩展文件夹拖到扩展管理页任意位置即可导入，多文件夹批量支持<br>🔃 <b>刷新修复</b> — 「刷新」现在会强制重扫磁盘，删除 / 拖入扩展目录后点刷新即可立即反映到列表；扩展页列表支持上下滚动<br>🧹 <b>回收站目录不误扫</b> — 修复扩展列表把回收站 trash 文件夹误认成扩展的问题' },
    { id: 17, time: '2026-08-04T22:30', content: '<b>v0.2.0</b> — 扩展生态里程碑 + AI 编程体验全面升级：<br><br>🤖 <b>AI 编程助手升级为 CodeBuddy CLI Agent 模式</b> — 不再直调模型返回代码，而是通过本机 CodeBuddy CLI 运行完整 Agent，自主读取源码、编写扩展文件、多步推理全栈式开发；一键安装 / 权限边界（扩展目录可写、源码只读）/ 自动备份随时回滚<br>💬 <b>多项目标签页 + 消息流</b> — AI 编程页重构为「多项目标签页 + 线性消息流」布局，每个标签页是一个独立开发项目；运行中可切换标签页等待，日志后台持续累积<br>🖥️ <b>Agent 动态流式展示</b> — 日志改为「一次回复 = 一个大气泡」逐条流式插入：AI 文本 Markdown 渲染、工具调用中文名 + 参数撑满可点击展开、CLI 初始化大 JSON 自动折叠；完成后主页面显示最后回复全文 + 插件详情卡片 + 自动折叠对话日志<br>🧩 <b>扩展系统</b> — plugin（安全插件，受限 extAPI 白名单）/ patch（源码补丁，PatchEngine 运行时覆盖）两类扩展，内置快捷访问 / 音乐播放器 / 学习统计三个官方插件；扩展管理独立页面<br>📋 <b>扩展列表卡片</b> — 名称 / 类型 / 版本 / 大小 / 启用开关，支持查看代码 / 回滚 / 卸载 / 打开目录 / 刷新' },
    { id: 16, time: '2026-08-04T20:00', content: '<b>v0.1.15</b> — AI 编程助手升级为 CodeBuddy CLI Agent 模式：<br><br>🤖 <b>仅 CodeBuddy CLI 执行引擎</b> — AI 编程不再直调模型返回代码，而是通过本机 CodeBuddy CLI 运行完整 Agent，自主读取源码、编写扩展文件、多步推理，真正做到全栈式开发；运行过程流式日志实时可见<br>&emsp;• <b>一键安装</b> — 本机无 CLI 时，AI 编程页 / 设置页提供「一键安装」（npm install -g @tencent-ai/codebuddy-code，可勾选国内镜像加速）<br>&emsp;• <b>权限边界</b> — Agent 只读写扩展目录，应用源码目录只读（Read/Edit/Write 白名单工具 + 目录约束）；打包版自动导出源码快照供参考<br>&emsp;• <b>授权</b> — 复用本机 CodeBuddy 登录凭据，或配置 CodeBuddy API Key（设置 → AI 设置 → CodeBuddy CLI）<br>&emsp;• <b>自动备份</b> — 每次运行前自动备份全部扩展，修改可随时回滚' },
    { id: 15, time: '2026-08-04T18:00', content: '<b>v0.1.14</b> — 扩展系统与 AI 编程助手：<br><br>🧩 <b>扩展系统</b> — 应用现在支持外部扩展，可在不修改核心源码的前提下新增或修改功能：<br>&emsp;• <b>plugin（安全插件）</b> — 通过受限 extAPI 白名单接口新增功能：注册侧边栏项 / 独立面板 / 工具栏按钮 / 订阅事件 / 私有数据区<br>&emsp;• <b>patch（源码补丁）</b> — 通过 PatchEngine 运行时函数覆盖修改现有功能，卸载自动恢复原函数，真正可实时装载 / 卸载 / 回滚<br>&emsp;• 扩展存放于 <b>~/.my-study-table/extensions/&lt;id&gt;/</b>（manifest.json + main.js + backup/），应用前自动备份快照<br>&emsp;• <b>内置插件</b> — 快捷访问 / 音乐播放器 / 学习统计 三个官方功能已内置扩展化，可在扩展页启用 / 禁用 / 移除（一键恢复）<br>🤖 <b>AI 编程助手</b> — 侧边栏新增「AI 编程」页面：用自然语言描述需求，AI 自动分析应用代码结构并生成扩展（返回功能说明 + 代码预览），一键「应用」= 自动备份 + 写入 + 即时装载；兼容任意 OpenAI 格式端点（CodeBuddy / Codex / DeepSeek / 自建代理）<br>⚙️ <b>扩展管理</b> — 侧边栏新增「扩展」页面：扩展列表卡片（启用开关 / 查看代码 / 回滚 / 卸载）、打开扩展目录、刷新；设置弹窗加宽、Tab 改为单行横向滑动' },
    { id: 12, time: '2026-08-02T12:00', content: '<b>v0.1.11</b> — 自动更新功能：<br><br>🔄 <b>一键自动更新</b> — 应用接入 electron-updater，发布新版本后会自动检测到更新<br>⏰ <b>多种检查时机</b> — 启动时自动检查 + 每小时定时检查 + 设置页「检查更新」手动按钮<br>📦 <b>下载进度显示</b> — 后台静默下载安装包，弹窗内实时显示下载进度，下载完成后一键「重启并安装」<br>⚠️ <b>版本说明</b> — 仅 NSIS 安装版支持自动更新；便携版/解压版会提示前往发布页手动下载<br>📄 <b>发布准备</b> — package.json 版本号与应用内更新日志对齐为 v0.1.x，配置 GitHub Releases 发布源' },
    { id: 11, time: '2026-08-02T10:00', content: '<b>v0.1.10</b> — AI 聊天内容捕获增强、拖拽添加附件、代码审查批量修复：<br><br>📝 <b>AI 聊天选中文字右键保存为笔记</b> — 在 AI 回复中选中任意文字，右键菜单新增「保存为笔记」，一键生成新笔记；同时提供「复制选中文字」<br>🧾 <b>选区格式化内容还原</b> — 选中内容跨表格/分隔线/代码块/标题时，自动把渲染结果逆向还原为 Markdown 存入笔记（表格保留 | 结构、分隔线还原为 ---、KaTeX 公式还原为 LaTeX、代码块/加粗/斜体保留）；聊天时间戳/按钮等界面元素自动剔除<br>📎 <b>AI 对话标签页拖拽添加附件</b> — 从文件管理器拖拽文件到 AI 对话区域即添加附件，拖动时显示「松开以添加附件」高亮提示；与文件选择按钮共用大小限制与 Kimi 图片处理逻辑<br>🔧 <b>代码审查批量修复</b> — ①编辑目标时变量名错误导致保存崩溃；②回收站/归档恢复文件夹不再丢失嵌套子笔记；③AI 对话勾选待办同步记录完成日期（日历/统计保持一致）；④AI 工具循环重复检测重复计数导致提前终止；⑤自定义状态名含引号时下拉菜单属性/脚本注入修复；⑥统计页 AI 输出转义防 XSS；⑦音频文件读取前先校验扩展名白名单；⑧待办/日历渲染性能优化（消除逐节点重复 JSON 解析与 O(n²) 后代统计）；⑨AI 会话调试日志设上限防止 localStorage 膨胀；⑩记忆系统日期改为本地时区、手动记忆详情查询修复、Ctrl+Z 不再干扰输入框原生撤销' },
    { id: 10, time: '2026-07-23T00:00', content: '<b>v0.1.9</b> — 外观设置交互重构、液态玻璃折射三控件拆分、卡片玻璃效果修复：<br><br>🎨 <b>预设→自定义模式统一切换</b> — 选择预设后修改任何参数自动切换到自定义模式，完整复制预设所有有效值（accent/bgType/bgAngle/bgFrom/bgTo/bgImage/bgVideo/glass/blur/opacity/refract）作为起点；14 个设置 handler 统一使用 switchToCustomMode(cfg) 入口<br>🔓 <b>预设模式下滑条恢复可操作</b> — 选预设后背景类型按钮、背景编辑控件（渐变角度/颜色/图片URL）、玻璃滑块（磨砂/透明度/折射）不再 disabled 或隐藏；始终用 effective 值渲染可编辑控件<br>🔬 <b>折射强度拆分为三项独立控制</b> — 弯曲程度（SVG位移强度 0~60px）、偏折程度（弯曲区域宽度 0~0.4）、顶层辉光（高光亮度 0~1）；旧 glassRefract 自动迁移为 glassCurve + glassGlow<br>✨ <b>顶层辉光优化</b> — 新增 filter: brightness() 动态控制亮度；顶部高光更锐利（三段梯度）；角落高光更集中（源心 15% 3%）；新增底部右侧环境反射；::after 边框四边完整定义；暗色模式同步增强<br>🧩 <b>卡片玻璃效果定位修复</b> — `.card` 缺少 `position: relative` 导致辉光伪元素飘到视口外，新增 `[data-glass="true"] .card { position: relative; }`' },
    { id: 9, time: '2026-07-19T23:30', content: '<b>v0.1.8</b> — 晚间日报、习惯追踪、复习系统升级、日历事件、计时器手动记录、AI 模块拆分：<br><br>🌙 <b>晚间日报</b> — 设置中可开启晚间日报（默认 21:00），到达时间后若当天未生成则自动生成晚间回顾；收集今日打卡/聚焦/完成待办/计时/笔记/逾期/习惯/复习数据；System Prompt 以「温暖、有洞察力」风格总结当天、沉淀收获；晨间/晚间日报共用「📋 每日日报」对话标签页<br>🔄 <b>AI 模块拆分</b> — js/ai.js（3,648 行/165KB）拆分为 8 个模块：ai-utils.js → ai-conv.js → ai-attach.js → ai-render.js → ai-tools.js → ai-search.js → ai-api.js → ai-send.js，按依赖顺序加载<br>📊 <b>习惯追踪系统</b> — 全新打卡系统，支持一天多次打卡 + 每日/每周目标；进度条+热力图可视化；坚持率公式（总次数/(天数×目标)）；打卡按钮 +/- 增减次数<br>🧠 <b>复习系统全面升级</b> — 复习浮窗改为非模态（可点击穿透）；折叠/展开模式；自适应高度（JS 动态测量子元素）；prev/next 导航自动跳转笔记但不关浮窗；日历日期详情面板新增「待复习笔记」区块（逾期红色标记）<br>📅 <b>日历事件功能</b> — 日历格子显示彩色事件圆点（最多4个+N）；支持添加/编辑/删除事件（标题+时间+8色+备注）<br>⏱️ <b>计时器手动记录</b> — 可手动添加/编辑/删除专注时段；支持关联待办/目标；«affectsFocus» 控制是否计入聚焦统计；历史记录显示手动/不计入徽章<br>📋 <b>日报+对话 AI 增强</b> — 晨间日报 Prompt 新增待复习笔记列表+逾期标记+习惯数据；对话 AI 新增 get_review_status / get_habits_status 工具<br>🔧 <b>LaTeX 修复</b> — 支持 $$...$$ 块公式分隔符渲染<br>🐞 <b>修复</b> — 计时器删除按钮无响应（customConfirm Promise 模式适配）；待复习笔记因时间成分比较导致当天不显示（改为日期字符串比对）；复习浮窗高度 6 次迭代修复（绝对定位 scrollHeight 不可靠 → 直接测量子元素方案）' },
    { id: 8, time: '2026-07-17T10:07', content: '<b>v0.1.7</b> — 日报系统重设计、笔记复习、AI 候选回复、长期目标、导航管理、设置增强：<br><br>☀️ <b>每日日报系统重设计</b> — 数据焦点从「今天」改为「昨天」（昨日完成待办、昨日计时、逾期待办、今日截止待办、昨日笔记）；Prompt 从 7 个固定板块改为引导式写作方向（回顾昨天 + 开启今天）；系统提示词改为「学习伙伴」风格；对话标题改为「☀️ 晨间日报」；max_tokens 提升至 2048<br>🧠 <b>笔记复习系统（Ebbinghaus）</b> — 笔记新增 _reviewHistory / _skipReview 字段；按 1/2/4/7/15/30/60/120 天间隔推送复习；复习卡片显式显示在「今天」页面；支持右键跳过单篇笔记的复习推送；编辑笔记后自动重置复习周期<br>💬 <b>AI 候选回复系统</b> — 支持 DeepSeek 风格的多候选回复切换；候选数据结构改为完整交互链 { messages: [...] } 存储；新增 navigateCandidate / adoptCandidate 支持跨候选切换；skipUntilNextUser 机制确保渲染和 API 上下文不产生重复消息；对话日志导出完整支持候选链<br>🎯 <b>长期目标板块</b> — 「今天」页面顶部新增长期目标卡片；支持正文内容、截止日期、计时器；计时器可独立关联待办或目标；目标正文和操作按钮模仿待办样式；编辑/删除按钮右对齐<br>🧭 <b>侧边栏导航管理</b> — 侧边栏左下角新增编辑按钮；支持拖拽排序、隐藏/显示导航项；CTRL+1~8 快捷键快速切换<br>🎨 <b>UI 优化</b> — 主界面最大宽度从 960px 拓宽至 1200px；笔记左侧侧边栏从 200px 加宽至 240px 并支持隐藏；侧边栏收起按钮移至「笔记」标题右侧并放大<br>📋 <b>日报提示词增强</b> — 新增 ydayTimerSessions 数组，包含昨日每条计时会话的起止时间、时长、关联目标/待办标题<br>⚙️ <b>设置增强</b> — AI 设置面板新增「对话标题自动生成」开关和专用 API Key 选择器；新增「今日聚焦设置」区域，聚焦任务最大数量可调（2~5 个），AI 提示词自动同步<br>⏱️ <b>打卡时间记录</b> — 每次打卡精确记录时间（HH:mm），日历和按钮上直观显示<br>🐞 <b>修复</b> — AI 候选系统多项 bug 修复：空候选链导致渲染失败、重复消息渲染、候选控制渲染为独立气泡、系统消息未折叠、buildApiMessages 上下文重复；修复 editModalOpen 重复声明问题；修复对话日志导出候选为 undefined；修复 regenerateAiMessage 未推入最终消息导致候选链为空' },
    { id: 7, time: '2026-07-15T21:58', content: '<b>v0.1.6</b> — AI 网络搜索、工具栏重构、文件备份系统、Lucide 图标体系、晨间日报、复习系统、AI 多候选回复：<br><br>🎨 <b>引入 Lucide 图标库</b> — 侧边栏导航 8 个图标、页面标题、操作按钮、弹窗标题、设置 tabs、设置面板子标题、笔记工具栏、上下文菜单、空状态等全部使用统一线条风格 SVG 图标；JS 动态切换的图标改为 data-lucide 属性 + lucide.createIcons()<br>🌐 <b>新增：AI 网络搜索</b> — web_search 工具支持 Brave / Tavily / Exa / SearchAPI / DuckDuckGo 五种引擎；设置 → 更多设置中可选引擎和填 Key；AI 聊天工具栏新增「智能搜索」胶囊按钮，按对话独立开关<br>🧠 <b>AI 工具栏重构</b> — 输入框上方改为统一工具栏：左侧 API Key 下拉选择、中间深度思考/网络搜索胶囊按钮、右侧快捷操作下拉菜单（填入输入框不自动发送）；设置中移除 API Key 表单的深度思考开关<br>💾 <b>文件系统备份</b> — Electron 下每次自动备份在 ~/.my-study-table/backups/ 创建独立 .json 文件；新增最大备份文件数设置（默认 30）；数据面板新增立即备份/打开备份目录按钮<br>🗂️ <b>快捷访问分类排序</b> — 分类头部新增 ▲/▼ 调换按钮，顺序持久化；输入框布局调整：类型下拉移到第二行和 URL 同行<br>🔄 <b>并行对话支持</b> — 每个对话标签页的加载状态和停止请求完全独立，切换标签页不干扰正在进行的对话<br>📝 <b>AI 标题生成修复</b> — 修复条件检查时序错误导致从未触发；max_tokens 调大、temperature 调高适配 DeepSeek 模型<br>📋 <b>对话设置调试信息</b> — 调试模式下显示对话 ID、消息数、创建时间、AI 自动生成标题状态<br>☀️ <b>晨间日报重构</b> — 日报改为晨间回顾风格：回顾昨天完成 + 开启今天方向；Prompt 从 7 个固定板块改为引导式写作方向；对话标题改为「☀️ 晨间日报」；数据焦点从「今天」改为「昨天」（昨日完成待办、昨日计时、逾期待办、今日截止待办）<br>🧠 <b>新增：笔记复习系统（艾宾浩斯遗忘曲线）</b> — 基于间隔重复算法（1/2/4/7/15/30/60/120 天）自动推送待复习笔记；「今天」页面始终显示复习卡片，支持一键跳转复习/标记完成；笔记列表显示复习状态徽章（到期/即将到期/跳过）；编辑笔记自动重置复习计时；右键菜单可跳过/恢复某笔记的复习<br>💬 <b>AI 多候选回复（DeepSeek 风格）</b> — 每条 AI 回复支持生成多个候选，可翻页切换（&lt; 1/3 &gt;）；「换一条」追加新候选，「采用本条」锁定当前选择作为后续上下文；所有候选保留可随时切换；对话日志导出支持候选记录<br>🖼️ <b>笔记侧边栏优化</b> — 侧边栏宽度 200px → 240px；新增隐藏/显示切换按钮（标题栏右侧）；响应式布局优化<br>🖥️ <b>主界面加宽</b> — 最大宽度 960px → 1200px<br>🐞 <b>修复：<memory> 标签显示到用户界面</b> — renderAiMessages 和 extractToolCalls 中清洗 <memory> 标签；runToolCallLoop 返回原始回复用于 memory 解析<br>🐞 <b>修复：日历气泡计数不一致</b> — renderCalendar() 中 continue 跳过了 completedAt 统计<br>🐞 <b>修复：侧边栏图标点击无响应</b> — Lucide SVG 子元素拦截点击事件，添加 pointer-events: none<br>🐞 <b>修复：icon.png 加载失败报错</b> — 浏览器 Notification API 移除 icon 参数' },
    { id: 6, time: '2026-07-10T12:23', content: '<b>v0.1.5</b> — 日历视图、计时器、UI 增强：<br><br>📅 <b>新增：日历视图</b> — 侧边栏新增「日历」栏目；月视图网格显示待办截止日期和完成日期角标；点击日期查看该日待办详情，支持直接勾选切换状态<br>⏱️ <b>新增：计时器</b> — 侧边栏新增「计时器」栏目；可关联任意待办并记录耗时；时间按待办及所有子孙待办汇总显示在待办列表<br>🗑️ <b>日历完成记录持久化</b> — 删除待办时自动保存其完成日期到独立日志；日历上可手动删除单条完成记录<br>🤖 <b>AI 增强</b> — 对话系统提示词注入昨日/今日待办完成记录；get_today_status / get_stats 工具也输出完成记录；toggle_todo 工具正确记录 completedAt<br>🔄 <b>对话标签页拖拽排序</b> — 按住拖拽即可调整标签页顺序，自动持久化<br>📂 <b>待办全部展开/折叠</b> — 列表头部新增 ⊞ 全部展开 / ⊟ 全部折叠按钮<br>✏️ <b>聊天输入草稿</b> — 每个对话标签页的输入内容独立保存，切换对话/栏目再回来内容还在（像微信）<br>🛠️ <b>重复检测逻辑优化</b> — AI 工具循环的重复检测改为按每个 tool_call 单独比对（action + params），更精准<br>⏹️ <b>AI 停止按钮</b> — 加载中发送按钮变为红色停止按钮，点击可中断 AI 回复<br>🐞 <b>修复：变量名冲突导致 ai.js 加载失败</b> — buildToolsSystemPrompt 中 todayStr 重复声明修复' },
    { id: 5, time: '2026-07-09T22:20', content: '<b>v0.1.4</b> — AI 长期记忆系统：<br><br>🧠 <b>新增：AI 长期记忆系统</b> — 多 AI 协作的记忆架构：<br>&emsp;• 对话 AI 实时通过 &lt;memory&gt; 标签提取 6 类记忆点<br>&emsp;• 离开对话时 AI 异步生成摘要 + 提取事实（500ms 防抖）<br>&emsp;• 记忆 AI 每日整合对话摘要并更新用户画像<br>📌 <b>6 类结构化记忆</b>：事实 / 偏好与习惯 / 目标 / 能力 / 行为模式 / 心理模式，各有独立配色<br>📊 <b>置信度算法</b>（纯 JS，不耗 API）：完全重复 +0.3，模糊相似同向 +0.15 / 矛盾 -0.3，每日衰减 -0.02，低于 0.3 自动清除<br>📐 <b>双层记忆结构</b>：每份记忆含简略信息（prompt/list_memories 显示）+ 详细内容（get_memory_detail 查看）<br>🖥️ <b>设置 → 🧠 记忆面板</b>：用户画像（AI 每日生成的全方位自由文本）、手动记忆（增删改）、自动记忆（筛选/编辑/详情展开）、对话摘要（编辑/删除）<br>🔧 <b>AI 新增工具</b>：list_memories / get_memory_detail<br>🤖 <b>数据流</b>：①对话中 &lt;memory&gt; 实时提取 → ②离开对话时提取摘要 + 事实 → ③每日整合总摘要 + 更新画像 → 全部注入 prompt<br>📐 <b>帮助全面更新</b>：新增音乐标签页、记忆系统说明、更新工具列表；完善笔记/快捷键/设置等帮助<br>🐞 <b>修复：设置标签页切换异常</b> — 记忆面板插入时误删 settingsPanelNotes 包裹 div，已恢复<br>🐞 <b>修复：记忆编辑按钮无响应</b> — genId() 返回数字但模板引号导致字符串比较失败' },
    { id: 4, time: '2026-07-09T17:00', content: '<b>v0.1.3</b> — 全局 UI 优化、笔记工具栏与设置重构：<br><br>📐 <b>新增：KaTeX 数学排版</b> — 替换自定义 CSS 渲染方案，接入专业排版引擎 KaTeX，支持所有 LaTeX 命令；字体文件本地化至 lib/katex/<br>🔧 <b>修复：ID 碰撞风险</b> — 全局 genId() 代替所有 Date.now() 直赋，单调递增、同毫秒内唯一<br>🔒 <b>修复：Note 标题 XSS</b> — renderItem 中文件夹/笔记标题未转义，现已用 escapeHtml() 包裹<br>🐞 <b>修复：KaTeX SVG 路径被 &lt;br&gt; 破坏</b> — \\n→&lt;br&gt; 替换移到保护块恢复之前<br>🧹 <b>清理：死代码与调试日志</b> — 删除未接入的 dimension.js 死代码；DEBUG 日志统一由 isDebugMode() 开关控制<br>🐞 <b>修复：页面空白/卡死</b> — section-header 缺少闭合 &lt;/div&gt; 导致 flex 布局错乱；给待办递归函数添加循环引用保护；safeInit() 包裹初始化<br>📂 <b>新增：笔记文件夹内联重命名</b> — 像 Windows 资源管理器，名称直接变输入框，Enter 确认/Escape 取消<br>🖊️ <b>新增：笔记 Markdown 格式工具栏</b> — B/I/S/H/代码/LaTeX/链接/列表/引用/任务/分割线 14 个按钮；Ctrl+B/I/U/K 快捷键；粗体/斜体等选中可切换解包；仅在编辑模式显示<br>🔢 <b>优化：Markdown 渲染</b> — 修复 hr/列表下方多余空行（正则 \s* 吃换行、&lt;br&gt; 清理）；支持带空格缩进的无序列表<br>↩️ <b>新增：待办撤销/重做</b> — 覆盖新增/删除/拖拽/完成切换；删除确认框移除「不可恢复」文字<br>🧩 <b>优化：设置全局自动保存</b> — 删除「保存全局设置」「保存笔记设置」「保存」按钮，onchange 即时写入 localStorage<br>🎨 <b>设置界面重构</b> — API 设置 → AI 设置；调试 → 更多设置；数据面板备份上移/删除标题/改灰字；笔记面板重命名/精简；API Key 表单内「更多设置」折叠（温度/Token/循环/上下文等）' },
    { id: 2, time: '2026-07-06T22:55', content: '<b>v0.1.1</b> — 修复与优化：<br><br>🐞 <b>修复：AI 工具失败后假装成功</b> — 工具结果格式改为醒目的「【工具执行结果】」，规则 8 明确要求 AI 检查结果是否以 ❌ 或「错误」开头，失败时必须告知用户而非假装成功<br>🔄 <b>修复：AI 对话标签页无法滚轮滚动</b> — 添加 wheel 事件监听，垂直滚轮转为水平滚动标签栏<br>📝 <b>修复：笔记中 \\n 不换行</b> — formatNoteContent 自动将字面 \\n 替换为真实换行；add_note/update_note 工具描述和规则 8 均提醒 AI 使用真实换行而非 \\n' },
    { id: 1, time: '2026-07-06T20:00', content: '<b>v0.1.0</b> — 首个可用版本，已实现以下完整功能体系：<br><br>📋 <b>待办管理</b>：无限层级父子任务、截止日期、正文备注、标签筛选、搜索、进度统计、拖拽排序<br>🎯 <b>今日聚焦</b>：每天最多3个聚焦任务、连续打卡（含遗忘曲线触发机制）<br>📝 <b>笔记管理</b>：多篇笔记、Markdown 编辑/预览双模式、自动保存<br>🔗 <b>快捷访问</b>：链接/应用分类管理<br>🤖 <b>AI 助手</b>：多对话标签页、多 API Key 管理（支持 OpenAI / Kimi / DeepSeek 等多种模型）、工具调用循环（<tool_call> 直接操作数据）、<call_ai> 多 AI 协作、定时自动化任务、对话日志导出、Windows 通知与未读红点标记、Kimi 图片视觉分析<br>⚙️ <b>系统</b>：深色主题、自定义确认对话框、Electron 托盘最小化、更新日志、开发者模式' }
  ];
  // Replace entirely with the latest versioned changelog
  changelog = fullChangelog;
  saveData('study_changelog', changelog);
  renderChangelogModal();
}

function openChangelogModal() {
  changelogModalOpen = true;
  document.getElementById('changelogModal').classList.add('open');
  renderChangelogModal();
}

function closeChangelogModal(e) {
  if (e && e.target !== document.getElementById('changelogModal')) return;
  changelogModalOpen = false;
  document.getElementById('changelogModal').classList.remove('open');
}

// ═══════════ Help Modal ═══════════
let helpModalOpen = false;

function openHelpModal() {
  helpModalOpen = true;
  document.getElementById('helpModal').classList.add('open');
  renderHelpModal();
}

function closeHelpModal(e) {
  if (e && e.target !== document.getElementById('helpModal')) return;
  helpModalOpen = false;
  document.getElementById('helpModal').classList.remove('open');
}

function renderHelpModal() {
  const body = document.getElementById('helpModalBody');
  if (!body) return;
  body.innerHTML = `
    <div class="settings-tab-panel active" id="helpPanelTodo">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li>支持<b>无限层级</b>子任务，点击箭头展开/折叠</li>
          <li>点击复选框完成任务，父任务完成时<b>级联完成</b>所有子任务</li>
          <li>可为任务设置<b>截止日期</b>、<b>备注</b>、<b>标签</b>（中英文逗号均可）</li>
          <li><b>批量操作</b>：多选模式支持批量删除和批量编辑（名称/日期/标签/正文）</li>
          <li>顶部搜索框可按关键词过滤待办，结果支持跳转到所在目录</li>
          <li><b>拖拽排序</b>：拖动左侧 grip 手柄重新排序或改变层级关系（三种放置区域）</li>
          <li><b>全部展开/折叠</b>：一键展开或折叠所有层级</li>
          <li>支持 <b>Ctrl+Z / Ctrl+Y</b> 撤销和重做待办操作（最多 50 步）</li>
          <li>删除待办时有确认对话框（可选"不再提示"），删除前自动保存完成记录到历史日志</li>
          <li><b>计时关联</b>：每个待办显示该任务及所有子任务的累计计时时间</li>
        </ul>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelToday">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li><b>🎯 长期目标</b>：管理独立于待办的长期目标，支持截止日期、正文备注、计时关联</li>
          <li><b>今日聚焦</b>：从所有待办中挑选当天重点任务（最多3个），支持展开查看子任务</li>
          <li><b>每日打卡</b>：记录每天的学习状态，连续天数自动统计，附赠名人名言</li>
          <li>打卡后自动生成<b>晨间日报</b>：AI 回顾昨天完成 + 开启今天方向（需 AI key）</li>
          <li><b>笔记复习卡片</b>：基于艾宾浩斯遗忘曲线，自动推送到期笔记，支持一键复习/标记完成</li>
          <li><b>调试面板</b>：调试模式下可手动编辑打卡状态和触发日报生成</li>
        </ul>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelNotes">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li>左侧列表支持<b>创建和切换</b>多个笔记，支持<b>文件夹</b>层级管理</li>
          <li><b>编辑 / 预览 / 摘要</b>三模式，预览支持完整 Markdown + LaTeX 渲染（KaTeX 引擎）</li>
          <li>内容<b>自动保存</b>（500ms 防抖），无需手动操作</li>
          <li>编辑模式下有<b>格式工具栏</b>（14 个按钮）：粗体、斜体、删除线、标题、代码、LaTeX 公式、链接、无序列表、有序列表、引用、任务列表、分割线</li>
          <li>支持 <b>Ctrl+B</b>（粗体）/ <b>Ctrl+I</b>（斜体）/ <b>Ctrl+U</b>（删除线）/ <b>Ctrl+K</b>（代码）快捷键</li>
          <li>支持 <b>Ctrl+Z / Ctrl+Y</b> 撤销和重做笔记编辑（最多 50 步）</li>
          <li><b>AI 摘要</b>：每篇笔记可自动/手动生成 AI 摘要（需 AI key）</li>
          <li>文件夹<b>内联重命名</b>：像 Windows 资源管理器，点击名称直接编辑</li>
          <li><b>拖拽排序</b>：文件夹和笔记均可拖拽移动</li>
          <li><b>侧边栏隐藏</b>：标题栏右侧按钮可隐藏/显示笔记列表</li>
          <li><b>复习系统</b>：右键菜单可跳过/恢复某笔记的艾宾浩斯复习</li>
          <li><b>字数统计</b>：底部实时显示笔记正文字数</li>
        </ul>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelLinks">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li>添加常用<b>网页链接</b>或<b>本地应用</b>路径，支持自动补全 URL</li>
          <li>支持<b>分类管理</b>，按类别分组展示，分类顺序可调</li>
          <li>输入分类时自动建议已有分类</li>
          <li>图标根据名称首字母自动生成</li>
          <li>支持编辑和删除已有链接</li>
        </ul>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelMusic">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li>本地音乐播放器，支持导入本地音乐文件</li>
          <li>支持播放/暂停、上一首/下一首</li>
          <li>进度条拖拽控制播放位置</li>
          <li>音量滑块调节</li>
          <li>播放时右下角显示<b>浮动控制球</b>，可拖拽移动，点击跳转到音乐标签页</li>
        </ul>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelAi">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <div style="margin-bottom:16px;">
          <h4 style="margin:0 0 8px 0;font-size:14px;color:var(--text);">📌 基本功能</h4>
          <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
            <li>支持 <b>OpenAI</b> 及兼容接口（如 DeepSeek、Kimi 等）</li>
            <li><b>多对话</b>标签页，每个对话有独立上下文，可拖拽排序</li>
            <li>可自定义<b>系统提示词</b>（System Prompt）</li>
            <li>支持<b>工具调用</b>：直接通过对话管理待办、笔记、链接、自动化、记忆</li>
            <li><b>多工具并行</b>：AI 可在一条回复中同时调用多个工具</li>
            <li><b>多候选回复</b>：每条回复可生成多个候选版本，翻页切换，可锁定/重新生成</li>
            <li><b>⏰ 定时自动化</b>：可设置定时任务，到达指定时间后自动触发 AI 执行</li>
            <li><b>🧠 长期记忆</b>：AI 自动提取对话中的关键信息，跨对话持久化记忆</li>
            <li><b>🌐 网络搜索</b>：支持 5 种搜索引擎，按对话独立开关</li>
            <li>快捷操作：待办总结、今日状态、推荐聚焦、生成晨间日报、学习建议</li>
            <li>对话中待办 ID 可点击跳转到对应任务</li>
            <li>每个对话标签页支持<b>清空</b>（🗑 按钮）和<b>删除</b>（✕ 按钮），均带确认对话框</li>
            <li><b>🤖 多 AI 协作</b>：AI 可通过 <code>&lt;call_ai&gt;</code> 标签唤起其他 AI 模型，回复独立显示并标注 Key 名称</li>
            <li><b>📸 图片视觉分析</b>：Kimi 模型支持上传图片进行分析</li>
            <li><b>对话日志导出</b>：导出完整日志（含消息、API 配置、原始调用记录、候选记录）</li>
          </ul>
        </div>
        <div style="margin-bottom:16px;">
          <h4 style="margin:0 0 8px 0;font-size:14px;color:var(--text);">🧠 长期记忆系统</h4>
          <div style="background:var(--path-bg);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--text-secondary);line-height:1.7;">
            <p style="margin:0 0 6px 0;">AI 能够在多对话之间保持记忆，记住你的偏好、目标和习惯。记忆分以下类型：</p>
            <ul style="margin:0 0 6px 0;padding-left:18px;">
              <li><b>📌 事实</b>：客观信息，如考试时间、学过的课程</li>
              <li><b>💚 偏好与习惯</b>：你的喜好和行为习惯</li>
              <li><b>🎯 目标</b>：短期或长期目标</li>
              <li><b>🧠 能力</b>：掌握或未掌握的技能</li>
              <li><b>📊 行为模式</b>：AI 总结的稳定行为规律</li>
              <li><b>💭 心理模式</b>：思维和学习特点</li>
            </ul>
            <p style="margin:0 0 4px 0;"><b>记忆获取方式：</b></p>
            <ul style="margin:0 0 4px 0;padding-left:18px;">
              <li><b>对话中实时提取</b>：AI 回复时自动通过 <code>&lt;memory&gt;</code> 标签提交值得记住的信息</li>
              <li><b>离开对话时提取</b>：切换/新建/删除对话时，异步生成摘要并提取关键点</li>
              <li><b>每日整合</b>：每天自动生成对话总摘要并更新用户画像</li>
            </ul>
            <p style="margin:0;"><b>管理入口</b>：设置面板 → <b>🧠 记忆</b> 标签页，可查看/编辑用户画像、手动记忆、自动记忆、对话摘要</p>
          </div>
        </div>
        <div style="margin-bottom:16px;">
          <h4 style="margin:0 0 8px 0;font-size:14px;color:var(--text);">🏠 项目介绍（AI 视角）</h4>
          <div style="background:var(--path-bg);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--text-secondary);line-height:1.7;">
            <p style="margin:0 0 6px 0;">AI 助手被提示为"友好的学习助手，内置于「我的学习桌面」应用"，了解以下系统模块：</p>
            <ol style="margin:0;padding-left:20px;">
              <li><b>📋 待办管理</b>：多层级任务（父子任务），支持截止日期、备注、标签、搜索过滤、批量操作</li>
              <li><b>🎯 今日聚焦</b>：从待办中选最多3个作为当日重点，支持每日打卡与连续天数统计</li>
              <li><b>📝 笔记管理</b>：多篇笔记、Markdown 编辑预览、自动保存、AI 摘要、文件夹管理</li>
              <li><b>🧠 笔记复习系统</b>：基于艾宾浩斯遗忘曲线的间隔重复复习</li>
              <li><b>🔗 快捷访问</b>：常用网站链接或应用，支持分类管理</li>
              <li><b>📅 日历视图</b>：月视图展示待办截止日期、完成记录和计时数据</li>
              <li><b>⏱️ 计时器</b>：支持关联待办和长期目标的计时器，含时段记录和历史</li>
              <li><b>🎵 音乐</b>：本地音乐播放器，含浮动控制球</li>
              <li><b>🗺️ 任务线</b>：GTNH 式任务书系统——主线（人生阶段，顺序推进）+ 素质线（并行成长）双轴章节；任务带前置依赖解锁、完成条件（绑定待办/笔记/计时）、三段式描述；奖励=经验等级 + 徽章收藏 + 自定义奖励池</li>
              <li><b>🤖 AI 学习助手</b>：多对话标签页、多模型支持、深度思考、工具调用、多候选回复、网络搜索、图片/文档附件、多 AI 协作、长期记忆、定时自动化</li>
              <li><b>⏰ 自动化任务</b>：可创建定时任务，到达指定时间后自动触发 AI 执行</li>
              <li><b>⚙️ 设置面板</b>：AI 设置、记忆管理、笔记设置、自动化管理、数据备份、调试</li>
              <li><b>📰 更新日志</b>：版本更新记录</li>
            </ol>
            <p style="margin:6px 0 0 0;font-size:11px;color:var(--text-secondary);">💡 每次对话开始时，AI 会获得实时的上下文数据（待办概览、今日聚焦、打卡状态、笔记/链接数量、自动化任务列表、长期记忆等）。</p>
          </div>
        </div>
        <div style="margin-bottom:16px;">
          <h4 style="margin:0 0 8px 0;font-size:14px;color:var(--text);">⏰ 定时自动化</h4>
          <div style="background:var(--path-bg);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--text-secondary);line-height:1.7;">
            <p style="margin:0 0 4px 0;">你可以对 AI 说以下内容来创建自动化任务：</p>
            <ul style="margin:0;padding-left:18px;">
              <li>"每天早上 8 点提醒我查看今日待办"</li>
              <li>"每天晚上 9 点帮我总结今天完成的任务"</li>
              <li>"每天下午 6 点检查我的学习进度"</li>
            </ul>
            <p style="margin:6px 0 0 0;">自动化任务会在到达指定时间后，自动向 AI 发送系统消息并触发执行。所有自动化任务可在<b>设置面板</b>中查看和管理。</p>
          </div>
        </div>
        <div>
          <h4 style="margin:0 0 8px 0;font-size:14px;color:var(--text);">🔧 可用工具接口</h4>
          <div style="background:var(--path-bg);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--text-secondary);line-height:1.7;">
            <p style="margin:0 0 4px 0;">AI 可通过 <code style="background:var(--border);padding:1px 4px;border-radius:3px;">&lt;tool_call&gt;</code> JSON 格式调用以下工具（单次回复支持多个工具调用）：</p>
            <p style="margin:0 0 2px 0;"><b>📋 待办：</b>add_todo（创建，支持 path 级联路径）、batch_add_todos（批量创建）、update_todo（更新）、delete_todo（删除）、toggle_todo（切换完成）、move_todo（移动）、list_todos（搜索/筛选）、get_todo_detail（详情）、batch_update_todos（批量操作）、get_todo_stats（统计趋势）</p>
            <p style="margin:0 0 2px 0;"><b>🎯 聚焦 & 打卡：</b>get_today_status（今日状态）、get_focus_tasks（查看聚焦）、set_focus_task（设置/移除聚焦）、get_stats（全局统计）</p>
            <p style="margin:0 0 2px 0;"><b>📝 笔记：</b>add_note（创建，支持 path 自动创建文件夹）、update_note（更新）、move_note（移动）、delete_note（删除）、list_notes（列出）、search_notes（搜索）、get_note_detail（详情）、get_note_changes（今日/昨日修改）</p>
            <p style="margin:0 0 2px 0;"><b>🔗 快捷访问：</b>add_link（添加，支持分类/链接/应用类型）、delete_link（删除）、list_links（列出所有）</p>
            <p style="margin:0 0 2px 0;"><b>⏰ 自动化：</b>schedule_automation（创建定时任务，at=HH:MM，prompt=触发指令，repeat=daily/once）、list_automations（查看所有自动化任务）、delete_automation（删除指定自动化）</p>
            <p style="margin:0 0 2px 0;"><b>🧠 记忆：</b>list_memories（列出记忆条目）、get_memory_detail（查看记忆详情）；AI 也可在回复中嵌入 <code>&lt;memory&gt;{"type":"类型","text":"简略信息","detail":"详细内容"}&lt;/memory&gt;</code> 来提交记忆</p>
            <p style="margin:0 0 2px 0;"><b>🌐 网络搜索：</b>web_search（联网搜索，支持 Brave / Tavily / Exa / SearchAPI / DuckDuckGo 五种引擎）</p>
            <p style="margin:0 0 2px 0;"><b>🗺️ 任务线：</b>quest_get（查看任务线）、quest_create_line（创建章节：main主线/quality素质线）、quest_update_line（更新章节）、quest_create（创建任务：kind 分 main主线/side支线，desc 一段文字描述含目标/意义/产出 + 依赖）、quest_update（更新任务）、quest_link_todo / quest_link_note / quest_link_timer（绑定完成条件）、quest_add_manual_cond（手动打卡条件）、quest_complete（完成任务，解锁下游）、quest_skip（跳过）、quest_review（复盘卡点）</p>
            <p style="margin:0;"><b>🤖 多 AI 协作：</b>AI 在回复中嵌入 <code>&lt;call_ai&gt;{"keyId":"目标 Key","prompt":"消息"}&lt;/call_ai&gt;</code> 来唤起其他 AI</p>
          </div>
        </div>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelSettings">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li><b>🤖 AI 设置</b>：配置 API Key、模型、温度、最大 Token、上下文消息条数等参数（每个 Key 独立设置）</li>
          <li><b>🧠 记忆</b>：管理 AI 长期记忆——用户画像（手动/自动）、手动记忆、自动记忆、对话摘要</li>
          <li><b>📦 数据管理</b>：支持导出/导入全部数据，自动备份（可设间隔和最大份数）</li>
          <li><b>📝 笔记</b>：配置笔记摘要 AI 及自动更新开关</li>
          <li><b>⏰ 自动化</b>：查看和管理定时自动化任务（启用/停用/编辑/删除）</li>
          <li><b>🌐 网络搜索</b>：选择搜索引擎和配置 API Key</li>
          <li><b>调试模式</b>：开启后可查看打卡调试信息和待办调试字段</li>
          <li><b>开发者模式</b>：开启后 AI 提示词中注入开发者上下文</li>
        </ul>
      </div>
    </div>
    <div class="settings-tab-panel" id="helpPanelShortcuts">
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <ul style="margin:0;padding-left:18px;color:var(--text-secondary);">
          <li><b>Ctrl + 1~9</b> — 切换到对应栏目（按侧边栏排序顺序）</li>
          <li><b>Esc</b> — 关闭当前弹窗</li>
          <li><b>Ctrl + Z / Ctrl + Y</b> — 笔记编辑器中撤销/重做；待办页面中撤销/重做操作</li>
          <li><b>Ctrl + Shift + Z</b> — 待办重做（替代方案）</li>
          <li><b>Ctrl + B</b> — 粗体（笔记编辑器）</li>
          <li><b>Ctrl + I</b> — 斜体（笔记编辑器）</li>
          <li><b>Ctrl + U</b> — 删除线（笔记编辑器）</li>
          <li><b>Ctrl + K</b> — 行内代码（笔记编辑器）</li>
        </ul>
      </div>
    </div>
    <div style="padding:10px 14px;background:var(--path-bg);border-radius:8px;border-left:3px solid var(--primary);">
      <p style="margin:0;font-size:12px;color:var(--text-secondary);">
        💡 <b>提示</b>：所有数据仅保存在浏览器本地（localStorage），不会上传到任何服务器。建议定期使用数据导出功能进行备份。
      </p>
    </div>
  `;
  // Enable horizontal scroll on help tabs via mouse wheel
  const tabs = document.getElementById('helpTabs');
  if (tabs && !tabs._wheelAttached) {
    tabs._wheelAttached = true;
    tabs.addEventListener('wheel', function(e) {
      if (this.scrollWidth > this.clientWidth) {
        this.scrollLeft += e.deltaY + e.deltaX;
        e.preventDefault();
      }
    }, { passive: false });
    // Arrow key horizontal scrolling
    tabs.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowLeft') { this.scrollLeft -= 80; e.preventDefault(); }
      if (e.key === 'ArrowRight') { this.scrollLeft += 80; e.preventDefault(); }
    });
    // Click inside tabs → focus container so arrow keys work
    tabs.addEventListener('click', () => tabs.focus(), { once: true });
  }
}

function switchHelpTab(tabId) {
  const panels = document.querySelectorAll('#helpModalBody .settings-tab-panel');
  panels.forEach(p => p.classList.remove('active'));
  const target = document.getElementById('helpPanel' + tabId.slice(4));
  if (target) target.classList.add('active');

  const tabs = document.querySelectorAll('#helpTabs .settings-tab');
  tabs.forEach(t => t.classList.remove('active'));
  const activeTab = document.querySelector(`#helpTabs .settings-tab[data-tab="${tabId}"]`);
  if (activeTab) activeTab.classList.add('active');
}

// ═══════════ Settings ═══════════
let settingsModalOpen = false;
let convSettingsModalOpen = false;

// Data structure: array of conversations, each has { id, title, systemPrompt, messages: [{role,content},...] }
let aiConvs = loadData('study_ai_convs');
let activeConvId = localStorage.getItem('study_active_conv') ? Number(localStorage.getItem('study_active_conv')) : null;
let aiLoadingStates = {}; // { [convId]: true/false } — per-conversation loading state
let aiStopRequests = {};  // { [convId]: true/false } — per-conversation stop request
let aiAttachments = []; // [{name, file, size}] — txt files only

// Per-conversation helpers
function isAiLoading(convId) { return !!aiLoadingStates[convId || getActiveConvId()]; }
function setAiLoading(convId, val) { aiLoadingStates[convId || getActiveConvId()] = val; }
function isAiStopRequested(convId) { return !!aiStopRequests[convId || getActiveConvId()]; }
function setAiStopRequested(convId, val) { aiStopRequests[convId || getActiveConvId()] = val; }
function getActiveConvId() { return activeConvId; }

// Global stop flag: set to true to cancel current AI response
window._aiStopRequested = false;
let automations = loadData('study_automations'); // [{id, convId, at, prompt, createdAt}]
let automationTimer = null; // setInterval handle

// Migrate old single-conversation data
if (!aiConvs || aiConvs.length === 0) {
  const oldMessages = loadData('study_ai_messages');
  if (oldMessages && oldMessages.length > 0) {
    aiConvs = [{
      id: genId(),
      title: '默认对话',
      systemPrompt: '',
      messages: oldMessages
    }];
    activeConvId = aiConvs[0].id;
  } else {
    aiConvs = [{
      id: genId(),
      title: '默认对话',
      systemPrompt: '',
      messages: []
    }];
    activeConvId = aiConvs[0].id;
  }
  saveData('study_ai_convs', aiConvs);
  localStorage.setItem('study_active_conv', activeConvId);
}

if (!aiConvs.find(c => c.id === activeConvId)) {
  activeConvId = aiConvs[0] ? aiConvs[0].id : null;
  if (activeConvId) localStorage.setItem('study_active_conv', activeConvId);
}

// ── 树状对话：启动时把每个对话迁移/初始化为树结构 ──
if (Array.isArray(aiConvs)) {
  let migrated = false;
  for (const c of aiConvs) {
    if (typeof ensureTree === 'function' && !isTreeConv(c)) {
      ensureTree(c);
      migrated = true;
    }
  }
  if (migrated) {
    try { saveData('study_ai_convs', aiConvs); } catch (_) {}
  }
}

function getActiveConv() {
  return aiConvs.find(c => c.id === activeConvId) || null;
}

function getSettings() {
  return {
    developerMode: localStorage.getItem('study_developer_mode') === 'true'
  };
}

// ─── Multi Key support ───
function loadApiKeys() {
  try { return JSON.parse(localStorage.getItem('study_api_keys')) || []; } catch { return []; }
}
function saveApiKeys(keys) { localStorage.setItem('study_api_keys', JSON.stringify(keys)); }
function getActiveApiKeyId() {
  return localStorage.getItem('study_active_api_key_id') || '';
}

function getActiveReportKeyId() {
  return localStorage.getItem('study_dayreport_key_id') || '';
}

function setActiveReportKeyId(id) {
  localStorage.setItem('study_dayreport_key_id', id);
}

// Migrate legacy API key to multi-key system (one-time)
(function migrateLegacyApiKey() {
  const keys = loadApiKeys();
  if (keys.length > 0) return; // already has keys
  const legacyKey = (localStorage.getItem('study_ai_api_key') || '').trim();
  if (!legacyKey) return;
  const legacyModel = localStorage.getItem('study_ai_model') || 'gpt-3.5-turbo';
  const legacyBaseUrl = localStorage.getItem('study_ai_base_url') || 'https://api.openai.com/v1';
  const legacyTemp = parseFloat(localStorage.getItem('study_ai_temperature') || '0.7');
  const legacyDeepThink = localStorage.getItem('study_ai_deep_think') === 'true';
    const newKey = {
      id: 'key_' + genId(),
      name: '默认 Key（已迁移）',
    key: legacyKey,
    baseUrl: legacyBaseUrl,
    model: legacyModel,
    temperature: legacyTemp,
    deepThink: legacyDeepThink,
    createdAt: new Date().toISOString()
  };
  saveApiKeys([newKey]);
  localStorage.setItem('study_active_api_key_id', newKey.id);
  // Clean up legacy keys
  ['study_ai_api_key', 'study_ai_model', 'study_ai_temperature',
   'study_ai_deep_think', 'study_ai_provider', 'study_ai_base_url'].forEach(k => {
    try { localStorage.removeItem(k); } catch {}
  });
  console.log('[Migrate] Legacy API key migrated to multi-key system:', newKey.name);
})();

// Get the effective API config for current context (uses active multi-key)
function getEffectiveApiConfig() {
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  const activeKey = activeId ? keys.find(k => k.id === activeId) : null;

  if (activeKey) {
    return {
      name: activeKey.name,
      apiKey: activeKey.key,
      baseUrl: activeKey.baseUrl || 'https://api.openai.com/v1',
      model: activeKey.model || 'gpt-3.5-turbo',
      temperature: activeKey.temperature != null ? activeKey.temperature : 0.7,
      deepThink: activeKey.deepThink === true,
      maxTokens: activeKey.maxTokens || 0,
      contextLimit: activeKey.contextLimit || 20,
      titleContextCount: activeKey.titleContextCount || 4
    };
  }

  // No key configured
  return {
    name: '',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-3.5-turbo',
    temperature: 0.7,
    deepThink: false,
    maxTokens: 0,
    contextLimit: 20,
    titleContextCount: 4
  };
}

// Get API config specifically for daily reports (uses dedicated report key if set, otherwise active key)
function getEffectiveReportApiConfig() {
  const reportKeyId = getActiveReportKeyId();
  if (reportKeyId) {
    const keys = loadApiKeys();
    const reportKey = keys.find(k => k.id === reportKeyId);
    if (reportKey) {
      return {
        name: reportKey.name,
        apiKey: reportKey.key,
        baseUrl: reportKey.baseUrl || 'https://api.openai.com/v1',
        model: reportKey.model || 'gpt-3.5-turbo',
        temperature: reportKey.temperature != null ? reportKey.temperature : 0.7,
        deepThink: reportKey.deepThink === true,
        maxTokens: reportKey.maxTokens || 0,
        contextLimit: reportKey.contextLimit || 20,
        titleContextCount: reportKey.titleContextCount || 4
      };
    }
  }
  // Fallback to active key
  return getEffectiveApiConfig();
}

// Build deep think request params based on model type
// DeepSeek and Kimi both use thinking.type to control thinking mode
// Both default to ENABLED, so we must explicitly send "disabled" to turn it off
// 注意：本项目用 fetch 直连 REST API，thinking 必须是请求体「顶层字段」。
// extra_body 只是 OpenAI SDK 的客户端包装参数，直连时服务端不识别会返回 400。
// 另外 Kimi K3 / K2.7-code 等新模型不接受 thinking 字段（K3 用 reasoning_effort，K2.7-code 始终思考），需跳过。
function buildDeepThinkParams(apiCfg) {
  const model = (apiCfg.model || '').toLowerCase();
  if (model.includes('kimi') || model.includes('deepseek')) {
    // Kimi K3 / K2.7-code：不支持 thinking 字段，跳过避免 400
    if (model.includes('k3') || model.includes('k2.7')) return {};
    if (apiCfg.deepThink === true) {
      // Explicitly enable deep thinking
      return { thinking: { type: 'enabled' } };
    } else {
      // Explicitly disable deep thinking (required because default is enabled)
      return { thinking: { type: 'disabled' } };
    }
  }
  return {};
}

let _settingsTab = 'api';

function switchSettingsTab(tab) {
  _settingsTab = tab;
  document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.settings-tab-panel').forEach(p => p.classList.remove('active'));
  const tabEl = document.getElementById('settingsTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
  const panelEl = document.getElementById('settingsPanel' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (!tabEl || !panelEl) return;
  tabEl.classList.add('active');
  panelEl.classList.add('active');
  // Clear status messages
  const statusEl = document.getElementById('settingsStatus');
  if (statusEl) { statusEl.className = 'settings-status'; statusEl.textContent = ''; }
  // Render appearance panel on first open
  if (tab === 'appearance' && typeof renderAppearancePanel === 'function') {
    renderAppearancePanel();
  }
  // Render extensions panel
  if (tab === 'extensions') renderExtensionsPanel();
  // Render CodeBuddy CLI config panel
  if (tab === 'api' && typeof renderCodebuddyCliConfig === 'function') {
    renderCodebuddyCliConfig();
  }
  // Load Supabase connection settings
  if (tab === 'supabase' && typeof loadSupabaseSettings === 'function') {
    loadSupabaseSettings();
  }
  // Render sync panel（含日志类数据云存储区块，js/sync-logs.js，与同步共用同一 tab）
  if (tab === 'sync' && typeof renderSyncPanel === 'function') {
    renderSyncPanel();
  }
  if (tab === 'sync' && typeof window.SyncLogs !== 'undefined' && window.SyncLogs.renderPanel) {
    window.SyncLogs.renderPanel();
  }
}

// ═══════════ 跨设备云同步面板（js/sync.js）═══════════
async function renderSyncPanel() {
  const enabledEl = document.getElementById('syncEnabled');
  const statusEl = document.getElementById('syncStatus');
  const infoEl = document.getElementById('syncAccountInfo');
  if (typeof window.Sync === 'undefined') {
    if (statusEl) statusEl.textContent = '同步模块未加载（js/sync.js）';
    return;
  }
  const st = await window.Sync.getStatus();
  if (enabledEl) enabledEl.checked = !!st.enabled;
  const autoEl = document.getElementById('syncAutoEnabled');
  if (autoEl) autoEl.checked = !!st.autoSync;
  if (statusEl) {
    const loggedTxt = st.loggedIn ? '已登录' : '未登录';
    const pendingTxt = st.pendingCount > 0 ? '，待上传 ' + st.pendingCount + ' 项' : '';
    const autoTxt = st.autoSync ? '' : '（仅手动同步）';
    statusEl.textContent = '同步状态：' + (st.enabled ? '已开启 · ' + loggedTxt + pendingTxt + autoTxt : '已关闭');
    statusEl.className = 'settings-status';
  }
  if (infoEl) {
    // 复用 sync 层 getStatus 的登录态（已兼容 Promise 的 getSession）
    const isLoggedIn = st.loggedIn;
    if (isLoggedIn) {
      let email = '';
      try {
        const supabaseClient = typeof getSupabaseClient === 'function' ? getSupabaseClient() : null;
        if (supabaseClient && supabaseClient.auth) {
          const r = supabaseClient.auth.getSession();
          const s = r && typeof r.then === 'function' ? await r : r;
          const sess = s && s.data ? s.data.session : null;
          if (sess && sess.user) email = sess.user.email || sess.user.id || '';
        }
      } catch (e) { /* 忽略 */ }
      infoEl.innerHTML = '<i data-lucide="user-check" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 已登录：<b>' + escapeHtml(email || '已登录用户') + '</b>';
    } else {
      infoEl.textContent = '未检测到登录状态。请到「好友」页面登录，登录后此面板会自动同步。';
    }
    if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
  }
  ensureSyncProgressListener();
}

// ── 同步进度条（上传/拉取）────────────────────────
let _syncProgressBound = false;
function ensureSyncProgressListener() {
  if (typeof window.Sync === 'undefined' || _syncProgressBound) return;
  if (typeof window.Sync.onProgress !== 'function') return;
  _syncProgressBound = true;
  window.Sync.onProgress(_updateSyncProgressUI);
}

function _updateSyncProgressUI(state) {
  const wrap = document.getElementById('syncProgressWrap');
  const bar = document.getElementById('syncProgressBar');
  const label = document.getElementById('syncProgressLabel');
  const pctEl = document.getElementById('syncProgressPct');
  const queueEl = document.getElementById('syncQueueBadge');
  if (!wrap || !bar || !label || !pctEl) return;
  // 队列徽标：显示排队中的上传任务数
  if (queueEl) {
    const q = state && state.queuePending != null ? state.queuePending : 0;
    if (q > 0) { queueEl.style.display = 'inline-flex'; queueEl.textContent = '队列 ' + q; }
    else queueEl.style.display = 'none';
  }
  if (!state || !state.active || !state.total) {
    // 空闲 → 隐藏进度条
    wrap.style.display = 'none';
    return;
  }
  const pct = Math.min(100, Math.round(state.current / state.total * 100));
  wrap.style.display = 'block';
  bar.style.width = pct + '%';
  pctEl.textContent = pct + '%';
  const phase = state.phase === 'upload' ? '上传' : (state.phase === 'first' ? '首次同步' : '拉取');
  const keyName = state.label || state.key || '';
  label.textContent = phase + '中：' + keyName + '（' + state.current + '/' + state.total + '）';
}

function toggleSyncEnabled() {
  const enabledEl = document.getElementById('syncEnabled');
  if (!enabledEl || typeof window.Sync === 'undefined') return;
  window.Sync.setEnabled(enabledEl.checked);
  renderSyncPanel();
}

function toggleSyncAutoEnabled() {
  const autoEl = document.getElementById('syncAutoEnabled');
  if (!autoEl || typeof window.Sync === 'undefined') return;
  window.Sync.setAutoSync(autoEl.checked);
  renderSyncPanel();
}

async function syncManualSync() {
  const stEl = document.getElementById('syncStatus');
  if (typeof window.Sync === 'undefined') { if (stEl) stEl.textContent = '同步模块未加载'; return; }
  if (stEl) { stEl.textContent = '正在同步…'; stEl.className = 'settings-status'; }
  _showSyncProgress('同步', 0);   // 立即显示进度条（防抖闪烁）
  try {
    const res = await window.Sync.manualSync();
    if (stEl) stEl.textContent = '同步完成。';
  } catch (e) {
    if (stEl) stEl.textContent = '同步出错：' + (e && e.message || e);
  } finally {
    _hideSyncProgress();
    renderSyncPanel();
  }
}

async function syncUploadAll() {
  const stEl = document.getElementById('syncStatus');
  if (typeof window.Sync === 'undefined') { if (stEl) stEl.textContent = '同步模块未加载'; return; }
  if (stEl) { stEl.textContent = '正在上传全部数据…'; stEl.className = 'settings-status'; }
  _showSyncProgress('上传', 0);
  try {
    const res = await window.Sync.uploadAll();
    if (stEl) stEl.textContent = '上传完成。';
  } catch (e) {
    if (stEl) stEl.textContent = '上传出错：' + (e && e.message || e);
  } finally {
    _hideSyncProgress();
    renderSyncPanel();
  }
}

function _showSyncProgress(phase, pct) {
  const wrap = document.getElementById('syncProgressWrap');
  const bar = document.getElementById('syncProgressBar');
  const label = document.getElementById('syncProgressLabel');
  const pctEl = document.getElementById('syncProgressPct');
  if (!wrap) return;
  wrap.style.display = 'block';
  if (bar) bar.style.width = (pct || 0) + '%';
  if (pctEl) pctEl.textContent = (pct || 0) + '%';
  if (label) label.textContent = phase + '中…';
}

function _hideSyncProgress() {
  const wrap = document.getElementById('syncProgressWrap');
  if (wrap) wrap.style.display = 'none';
}

// ═══════════ Extension Management ═══════════
function setExtStatus(msg, isError) {
  const el = document.getElementById('extensionsStatus');
  if (!el) return;
  el.className = 'settings-status ' + (isError ? 'error' : '');
  el.textContent = msg || '';
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function renderExtensionsPanel() {
  setupExtDropZone();
  const listEl = document.getElementById('extensionsList');
  if (!listEl) return;
  setExtStatus('加载中…');
  let exts = [];
  try {
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.list) {
      let all = window.ExtManager.list();
      if (all.length === 0 && typeof window.ExtManager.loadAll === 'function') {
        await window.ExtManager.loadAll();
        all = window.ExtManager.list();
      }
      exts = all.map(e => ({
        id: e.id,
        manifest: e.meta,
        hasMain: !!e.mainCode,
        size: e.mainCode ? e.mainCode.length : 0,
        error: e.error,
        builtin: !!e.builtin
      }));
    } else {
      setExtStatus('扩展系统不可用', true);
      listEl.innerHTML = '';
      return;
    }
  } catch (e) {
    setExtStatus('加载失败: ' + e.message, true);
    listEl.innerHTML = '';
    return;
  }

  // 已被移除的内置扩展（可恢复）
  const removedBuiltins = (typeof window.ExtManager !== 'undefined' && window.ExtManager.listBuiltins)
    ? window.ExtManager.listBuiltins().filter(b => !exts.find(e => e.id === b.id))
    : [];

  if (exts.length === 0 && removedBuiltins.length === 0) {
    listEl.innerHTML = `<div class="ext-empty">
      <p>还没有安装任何扩展。</p>
      <p class="hint" style="margin-top:4px;">点「用 AI 生成扩展」让 AI 帮你写第一个扩展，或把扩展目录放到 ~/.my-study-table/extensions/。</p>
    </div>`;
    setExtStatus('');
    return;
  }

  const typeLabels = { plugin: '插件', patch: '补丁' };
  // 查询已发布到市场的扩展 id 集合
  let uploadedIds = new Set();
  try {
    if (typeof window.Store !== 'undefined' && window.Store.fetchUploadedExtIds) {
      uploadedIds = await window.Store.fetchUploadedExtIds();
    }
  } catch (e) { /* 忽略 */ }
  listEl.innerHTML = exts.map(ext => {
    const m = ext.manifest || { name: ext.id, type: 'plugin', version: '?', description: '', enabled: true };
    const enabled = m.enabled !== false;
    const sizeStr = ext.size > 1024 * 1024 ? (ext.size / 1024 / 1024).toFixed(1) + 'MB' : Math.round(ext.size / 1024) + 'KB';
    const builtinBadge = ext.builtin ? '<span class="ext-badge ext-badge-builtin">内置</span>' : '';
    const published = !ext.builtin && uploadedIds.has(ext.id);
    const publishBadge = ext.builtin ? '' : (published
      ? '<span class="ext-badge ext-badge-published" title="已发布到插件市场"><i data-lucide="check" class="lucide-icon" style="width:11px;height:11px;vertical-align:-1px;"></i> 已发布</span>'
      : '<span class="ext-badge ext-badge-unpublished" title="尚未发布到插件市场">未发布</span>');
    const extIdSafe = escapeJs(ext.id);
    const rollbackBtn = ext.builtin ? '' : `<button class="ext-action-btn" onclick="rollbackExt('${extIdSafe}')"><i data-lucide="rotate-ccw" class="lucide-icon" style="width:13px;height:13px;"></i> 回滚</button>`;
    const publishBtn = ext.builtin ? '' : `<button class="ext-action-btn" onclick="window.Store && window.Store.doUpload('${extIdSafe}')"><i data-lucide="upload" class="lucide-icon" style="width:13px;height:13px;"></i> 发布</button>`;
    const removeLabel = ext.builtin ? '移除' : '卸载';
    return `<div class="ext-card">
      <div class="ext-card-header">
        <div class="ext-card-left">
          <span class="ext-card-name"><i data-lucide="${m.type === 'patch' ? 'wrench' : 'puzzle'}" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> ${escapeHtml(m.name || ext.id)}</span>
          <span class="ext-badge ext-badge-${m.type === 'patch' ? 'patch' : 'plugin'}">${escapeHtml(typeLabels[m.type] || m.type)}</span>
          ${builtinBadge}
          ${publishBadge}
          <span class="ext-card-meta">v${escapeHtml(m.version || '?')} · ${sizeStr}</span>
        </div>
        <label class="toggle-switch ext-toggle">
          <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleExtension('${extIdSafe}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="ext-card-desc">${escapeHtml(m.description || '（无描述）')}</div>
      <div class="ext-card-actions">
        <button class="ext-action-btn" onclick="viewExtCode('${extIdSafe}')"><i data-lucide="file-code" class="lucide-icon" style="width:13px;height:13px;"></i> 查看代码</button>
        ${publishBtn}
        ${rollbackBtn}
        <button class="ext-action-btn ext-action-danger" onclick="removeExt('${extIdSafe}')"><i data-lucide="trash-2" class="lucide-icon" style="width:13px;height:13px;"></i> ${removeLabel}</button>
      </div>
      ${ext.error ? `<div class="ext-error">⚠ 上次装载出错: ${escapeHtml(ext.error)}</div>` : ''}
    </div>`;
  }).join('');

  if (removedBuiltins.length > 0) {
    listEl.innerHTML += `<div class="ext-removed-section">
      <div class="settings-section-title" style="margin-top:14px;"><i data-lucide="rotate-ccw" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> 已移除的内置扩展</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
        ${removedBuiltins.map(b => `<button class="ext-action-btn" onclick="restoreBuiltinExt('${escapeJs(b.id)}')"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i> 恢复 ${escapeHtml((b.meta && b.meta.name) || b.id)}</button>`).join('')}
      </div>
    </div>`;
  }

  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  setExtStatus('');
}

// 从回收站恢复扩展（被回收站页面调用；需在全局可用）
async function restoreTrashedExt(trashDir) {
  setExtStatus('正在恢复…');
  try {
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extTrashRestore) {
      const res = await window.electronAPI.extTrashRestore({ trashDir });
      if (res && res.ok) {
        if (typeof window.ExtManager !== 'undefined' && window.ExtManager.reload) {
          await window.ExtManager.reload();
        }
        setExtStatus('已恢复扩展：' + res.id);
      } else {
        setExtStatus('恢复失败：' + ((res && res.reason) || '未知错误'), true);
      }
    } else {
      setExtStatus('当前环境不支持恢复扩展', true);
    }
  } catch (e) {
    setExtStatus('恢复失败: ' + e.message, true);
  }
  refreshActiveExtSections();
}

// 从回收站彻底删除扩展（被回收站页面调用；需在全局可用）
async function purgeTrashedExt(trashDir) {
  const msg = '确定要彻底删除这个扩展吗？此操作不可恢复！';
  if (typeof showCustomConfirm === 'function') {
    const confirmed = await showCustomConfirm(msg);
    if (!confirmed) return;
  } else {
    if (!confirm(msg)) return;
  }
  setExtStatus('正在彻底删除…');
  try {
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extTrashPurge) {
      const res = await window.electronAPI.extTrashPurge({ trashDir });
      if (res && res.ok) setExtStatus('已彻底删除');
      else setExtStatus('删除失败：' + ((res && res.reason) || '未知错误'), true);
    } else {
      setExtStatus('当前环境不支持删除', true);
    }
  } catch (e) {
    setExtStatus('删除失败: ' + e.message, true);
  }
  refreshActiveExtSections();
}

// 回收站操作后刷新当前可见的相关视图（回收站页面 / 扩展页面）
function refreshActiveExtSections() {
  const active = document.querySelector('.section.active');
  if (active && active.id === 'section-trash' && typeof renderTrash === 'function') {
    renderTrash();
  }
  if (typeof renderExtensionsPanel === 'function') renderExtensionsPanel();
}

// 恢复被移除的内置扩展
async function restoreBuiltinExt(id) {
  setExtStatus('正在恢复…');
  try {
    if (typeof window.ExtManager !== 'undefined') {
      window.ExtManager.restoreBuiltin(id);
      await window.ExtManager.loadAll();
      await window.ExtManager.mount(id);
      if (typeof renderSidebarNav === 'function') renderSidebarNav();
      setExtStatus('已恢复并启用内置扩展');
    }
  } catch (e) {
    setExtStatus('恢复失败: ' + e.message, true);
  }
  await renderExtensionsPanel();
}

async function toggleExtension(id, enabled) {
  setExtStatus('正在' + (enabled ? '启用' : '禁用') + '…');
  try {
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.setEnabled) {
      const res = await window.ExtManager.setEnabled(id, enabled);
      if (!res.ok) setExtStatus(res.reason, true);
    } else {
      setExtStatus('扩展管理器未就绪', true);
    }
  } catch (e) {
    setExtStatus('操作失败: ' + e.message, true);
  }
  await renderExtensionsPanel();
}

async function viewExtCode(id) {
  try {
    let code = '';
    // 内置扩展：从 registry 读取；磁盘扩展：走 IPC
    const ext = (typeof window.ExtManager !== 'undefined' && window.ExtManager.get) ? window.ExtManager.get(id) : null;
    if (ext && ext.builtin) {
      code = ext.mainCode || '';
    } else if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extRead) {
      code = await window.electronAPI.extRead({ id, file: 'main.js' });
    }
    const win = window.open('', '_blank');
    if (win) {
      win.document.write('<pre style="padding:16px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(code) + '</pre>');
      win.document.title = '扩展代码: ' + id;
    } else {
      setExtStatus('浏览器拦截了弹窗，请允许弹窗', true);
    }
  } catch (e) {
    setExtStatus('读取失败: ' + e.message, true);
  }
}

async function rollbackExt(id) {
  if (!confirm('将把扩展恢复到最近一次备份。继续？')) return;
  setExtStatus('正在回滚…');
  try {
    if (typeof window.Codegen !== 'undefined' && window.Codegen.rollback) {
      const res = await window.Codegen.rollback(id);
      setExtStatus(res.ok ? '已回滚到最近备份，已重新装载' : '回滚失败: ' + res.reason, !res.ok);
    } else {
      setExtStatus('Codegen 未就绪', true);
    }
  } catch (e) {
    setExtStatus('回滚失败: ' + e.message, true);
  }
  await renderExtensionsPanel();
}

async function removeExt(id) {
  const ext = (typeof window.ExtManager !== 'undefined' && window.ExtManager.get) ? window.ExtManager.get(id) : null;
  const isBuiltin = ext && ext.builtin;
  const msg = isBuiltin
    ? '确定移除内置扩展「' + escapeHtml(id) + '」吗？<br><small>可从页面底部「已移除的内置扩展」恢复。</small>'
    : '确定卸载扩展「' + escapeHtml(id) + '」吗？<br><small>扩展将移入回收站，可随时恢复；扩展数据（study_ext_&lt;id&gt;_ 前缀）会保留。</small>';
  if (typeof showCustomConfirm === 'function') {
    const confirmed = await showCustomConfirm(msg);
    if (!confirmed) return;
  } else {
    if (!confirm(isBuiltin ? '确定移除内置扩展「' + id + '」？' : '确定卸载扩展「' + id + '」？')) return;
  }
  setExtStatus(isBuiltin ? '正在移除…' : '正在卸载…');
  try {
    let trashed = false;
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.remove) {
      const res = await window.ExtManager.remove(id);
      trashed = !!(res && res.trashed);
    }
    setExtStatus(isBuiltin ? '已移除' : (trashed ? '已卸载，扩展已移入回收站' : '已卸载'));
  } catch (e) {
    setExtStatus('卸载失败: ' + e.message, true);
  }
  await renderExtensionsPanel();
}

async function openExtensionsDir() {
  try {
    if (typeof window.electronAPI !== 'undefined' && window.electronAPI.extOpenDir) {
      await window.electronAPI.extOpenDir();
    } else {
      setExtStatus('当前环境不支持打开目录', true);
    }
  } catch (e) {
    setExtStatus('打开失败: ' + e.message, true);
  }
}

// 刷新：强制重扫磁盘（新增/删除的扩展目录会反映到列表）
async function refreshExtensionsList() {
  try {
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.reload) {
      await window.ExtManager.reload();
    } else if (typeof window.ExtManager !== 'undefined' && window.ExtManager.loadAll) {
      await window.ExtManager.loadAll();
    }
  } catch (e) {
    setExtStatus('刷新失败: ' + e.message, true);
  }
  await renderExtensionsPanel();
}

// 导入扩展：弹出文件夹选择框，复制到扩展目录
async function importExtension() {
  try {
    if (typeof window.electronAPI === 'undefined' || !window.electronAPI.extImport) {
      setExtStatus('当前环境不支持导入扩展', true);
      return;
    }
    setExtStatus('正在导入…');
    const res = await window.electronAPI.extImport({ sourcePath: '' });
    if (res && res.canceled) {
      setExtStatus('');
      return;
    }
    if (res && res.ok) {
      if (typeof window.ExtManager !== 'undefined' && window.ExtManager.reload) {
        await window.ExtManager.reload();
      }
      await renderExtensionsPanel();
      setExtStatus('已导入扩展：' + res.id);
    } else {
      setExtStatus('导入失败：' + ((res && res.reason) || '未知错误'), true);
    }
  } catch (e) {
    setExtStatus('导入失败: ' + e.message, true);
  }
}

// 拖拽文件夹导入扩展：整个扩展页面任意位置都可拖放
function setupExtDropZone() {
  const sec = document.getElementById('section-extensions');
  if (!sec || sec.dataset.ready === '1') return;
  sec.dataset.ready = '1';
  sec.addEventListener('dragenter', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sec.classList.add('dragging');
  });
  sec.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    sec.classList.add('dragging');
  });
  sec.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 仅当真正离开整个 section（而非进入子元素）时移除高亮
    if (e.target === sec) sec.classList.remove('dragging');
  });
  sec.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    sec.classList.remove('dragging');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const candidates = [];
    for (const f of Array.from(files)) {
      let p = '';
      try {
        if (typeof window.electronAPI !== 'undefined' && window.electronAPI.getPathForFile) {
          p = window.electronAPI.getPathForFile(f) || '';
        }
      } catch (err) { /* 忽略单文件失败 */ }
      if (p) candidates.push(p);
    }
    if (!candidates.length) {
      setExtStatus('无法读取拖入的文件路径', true);
      return;
    }
    setExtStatus('正在导入 ' + candidates.length + ' 个文件夹…');
    let okCount = 0;
    let errMsg = '';
    for (const p of candidates) {
      try {
        const res = await window.electronAPI.extImport({ sourcePath: p });
        if (res && res.ok) okCount++;
        else if (res && res.reason) errMsg = res.reason;
      } catch (err) {
        errMsg = String(err && err.message || err);
      }
    }
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.reload) {
      await window.ExtManager.reload();
    }
    await renderExtensionsPanel();
    setExtStatus(
      okCount > 0
        ? '已导入 ' + okCount + ' 个扩展' + (errMsg ? '，另有失败：' + errMsg : '')
        : '导入失败：' + (errMsg || '未知错误'),
      okCount === 0
    );
  });
}

function openCodegenSection() {
  // 关闭设置弹窗，跳转到 AI 编程页面
  closeSettingsModal();
  if (typeof switchTab === 'function') switchTab('codegen');
}

function openSettingsModal() {
  settingsModalOpen = true;
  const s = getSettings();
  document.getElementById('settingsModal').classList.add('open');
  document.getElementById('settingsDeveloperMode').checked = s.developerMode;
  document.getElementById('settingsDebug').checked = isDebugMode();
  loadWebSearchSettings();
  loadEveningReportSettings();
  loadDayReportSettings();
  loadMorningReportSettings();
  updateBackupHints();
  // Load max backup files setting
  const maxBackupFiles = localStorage.getItem('study_max_backup_files') || '30';
  const maxBackupInput = document.getElementById('settingsMaxBackupFiles');
  if (maxBackupInput) maxBackupInput.value = maxBackupFiles;
  // Load max tool loops setting
  const maxLoops = parseInt(localStorage.getItem('study_max_tool_loops')) || 3;
  const maxLoopsInput = document.getElementById('settingsMaxToolLoops');
  if (maxLoopsInput) maxLoopsInput.value = maxLoops;
  document.getElementById('settingsStatus').className = 'settings-status';
  document.getElementById('settingsStatus').textContent = '';
  switchSettingsTab('api');
  renderApiKeyList(); // Refresh multi-key list
  populateSummaryAiKeySelect();
  populateAutoTitleAiKeySelect();
  // Load auto-title settings
  const autoTitleEnabled = localStorage.getItem('study_auto_title_enabled') !== 'false';
  const autoTitleCb = document.getElementById('settingsAutoTitle');
  if (autoTitleCb) autoTitleCb.checked = autoTitleEnabled;
  // Trigger daily memory integration check
  if (typeof checkDailyIntegration === 'function') {
    setTimeout(checkDailyIntegration, 2000);
  }
  // Load auto-summary setting
  const autoSummary = localStorage.getItem('study_auto_summary') !== 'false';
  const autoCb = document.getElementById('settingsAutoSummary');
  if (autoCb) autoCb.checked = autoSummary;
  // Load review interval settings
  loadReviewSettings();
  // Load reminder settings
  loadReminderSettings();
  // Load backup setting
  const backupInterval = localStorage.getItem('study_backup_interval') || '0';
  const backupSelect = document.getElementById('settingsBackupInterval');
  if (backupSelect) backupSelect.value = backupInterval;
  updateBackupHints();
  // Load max focus count setting
  const maxFocusCount = parseInt(localStorage.getItem('study_max_focus_count')) || 3;
  const focusInput = document.getElementById('settingsMaxFocusCount');
  if (focusInput) focusInput.value = Math.max(2, Math.min(5, maxFocusCount));
  // Load books KB settings
  loadBooksKbSettings();
}

function closeSettingsModal(e) {
  if (e && e.target !== document.getElementById('settingsModal')) return;
  settingsModalOpen = false;
  document.getElementById('settingsModal').classList.remove('open');
}

// ═══════════ Reminder System ═══════════

// ── Encouragement messages ──
const ENCOURAGEMENTS_CHECKIN = [
  '每一个好习惯，都是通向更好自己的阶梯。加油！', '坚持从每天的第一步开始，你已经走在路上了！',
  '不积跬步，无以至千里。今天的第一步，从打卡开始。', '小小的坚持，汇聚成大大的改变。试试看吧！',
  '种一棵树最好的时间是十年前，其次是现在。现在就去打卡吧！', '别让今天的惰性，成为明天的遗憾。行动起来！'
];
const ENCOURAGEMENTS_FOCUS = [
  '专注 25 分钟，胜过漫无目的的两小时。', '进入心流的那一刻，时间就变得有意义了。',
  '每一次专注，都是对未来的投资。', '深度工作 25 分钟，然后给自己一个奖励吧！',
  '不要等到「想做了」才开始，开始做了才会「想做」。', '关掉干扰，让大脑沉浸到一件事中去。'
];
const ENCOURAGEMENTS_IDLE = [
  '休息好了吗？再花 25 分钟，攻克一个任务如何？', '学习就像跑步——停下来太久，就很难再起跑。',
  '别忘了你的目标还在等你呢！按下开始，继续前进。', '间歇性努力是常态，但持续前进才有结果。',
  '你已经很棒了，再来一个小小的聚焦，就更完美了！', '每天前进一小步，回头看已是万里路。'
];

function _pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Helper: get last focus end time (milliseconds timestamp) ──
function _getLastFocusEndTime() {
  if (typeof loadTimerRecords !== 'function') return 0;
  const records = loadTimerRecords();
  let lastEnd = 0;
  for (const rec of records) {
    if (!rec.sessions || rec.sessions.length === 0) continue;
    for (const s of rec.sessions) {
      if (s.end && s.end > lastEnd) lastEnd = s.end;
    }
  }
  return lastEnd;
}

// ── Helper: get TODAY's last focus end time (0 if no focus today) ──
function _getTodayLastFocusEnd() {
  if (typeof loadTimerRecords !== 'function') return 0;
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const records = loadTimerRecords();
  let lastEnd = 0;
  for (const rec of records) {
    if (!rec.sessions || rec.sessions.length === 0) continue;
    for (const s of rec.sessions) {
      if (s.end && s.end >= dayStart && s.end > lastEnd) lastEnd = s.end;
    }
  }
  return lastEnd;
}

// ── Idle timer accumulation ──
// 空闲计时器：仅累计「应用运行时 + 未在专注」的时长，每天重置，专注时归零。
// 存储：study_reminder_idle_accum（今日累计毫秒）+ study_reminder_idle_day（日期）
function _resetIdleAccum() {
  localStorage.setItem('study_reminder_idle_accum', '0');
  localStorage.setItem('study_reminder_idle_day', _getReminderTodayStr());
}
// 供 timer.js 在专注开始时调用：空闲计时器归零
function resetIdleTimerOnFocus() {
  if (typeof _resetIdleAccum === 'function') _resetIdleAccum();
}

// ── Helper: check if any habit is checked in today ──
function _hasCheckedInToday() {
  if (typeof loadHabits !== 'function') return false;
  const habits = loadHabits();
  if (!habits || habits.length === 0) return false;
  const todayStr = _getReminderTodayStr();
  return habits.some(h => (h.checkins && h.checkins[todayStr] && h.checkins[todayStr] > 0));
}

// ── Helper: get first checkin time today ──
function _getFirstCheckinTimeToday() {
  if (typeof loadHabits !== 'function') return 0;
  const habits = loadHabits();
  if (!habits || habits.length === 0) return 0;
  const todayStr = _getReminderTodayStr();
  let earliest = Infinity;
  for (const h of habits) {
    if (h.checkins && h.checkins[todayStr] && h.checkins[todayStr] > 0) {
      // We can't know the exact time from checkin data alone (it only stores date + count).
      // Use lastModified or fallback: we track this separately when first checkin happens.
      // For now, use the first checkin time stored in localStorage
    }
  }
  return earliest === Infinity ? 0 : earliest;
}

function _getReminderTodayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ── 1. Check-in Reminder ──
function _checkCheckinReminder() {
  const enabled = localStorage.getItem('study_reminder_checkin_enabled') === 'true';
  if (!enabled) return;

  // Already sent today
  const lastSent = localStorage.getItem('study_reminder_checkin_last');
  const today = _getReminderTodayStr();
  if (lastSent === today) return;

  const timeStr = localStorage.getItem('study_reminder_checkin_time') || '09:00';
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (hm < timeStr) return; // not yet time

  // Check if user has checked in today
  if (_hasCheckedInToday()) return; // already checked in

  const msg = '你还没有完成今天的打卡哦！' + _pick(ENCOURAGEMENTS_CHECKIN);
  localStorage.setItem('study_reminder_checkin_last', today);
  if (typeof sendNotification === 'function') {
    sendNotification('打卡提醒', msg);
  }
}

// ── 2. Focus-after-checkin Reminder ──
function _checkFocusAfterCheckinReminder() {
  const enabled = localStorage.getItem('study_reminder_focus_enabled') === 'true';
  if (!enabled) return;

  // Already sent today
  const lastSent = localStorage.getItem('study_reminder_focus_after_last');
  const today = _getReminderTodayStr();
  if (lastSent === today) return;

  // Must have checked in today first
  if (!_hasCheckedInToday()) return;

  // Check if user has already started a focus timer today (any session today)
  const records = (typeof loadTimerRecords === 'function') ? loadTimerRecords() : [];
  const hasFocusToday = records.some(rec => {
    if (!rec.sessions || rec.sessions.length === 0) return false;
    const recDate = new Date(rec.sessions[0].start).toISOString().slice(0, 10);
    return recDate === today;
  });
  if (hasFocusToday) return;

  // Check if enough time has passed since first checkin
  // Since we can't know exact first checkin time from data, use the time elapsed since the
  // reminder time window opened. Alternative: track first checkin time in localStorage.
  const firstCkTime = localStorage.getItem('study_reminder_first_checkin_today');
  if (!firstCkTime) return; // can't determine, skip

  const afterMin = parseInt(localStorage.getItem('study_reminder_focus_after_min')) || 30;
  const elapsed = (Date.now() - parseInt(firstCkTime)) / 60000;
  if (elapsed < afterMin) return;

  const msg = '你已经完成了打卡，别忘了开始今天的第一次聚焦计时哦！' + _pick(ENCOURAGEMENTS_FOCUS);
  localStorage.setItem('study_reminder_focus_after_last', today);
  if (typeof sendNotification === 'function') {
    sendNotification('聚焦提醒', msg);
  }
}

// ── 3. Idle Reminder ──
function _checkIdleReminder() {
  const enabled = localStorage.getItem('study_reminder_idle_enabled') === 'true';
  if (!enabled) return;

  // 每日重置空闲计时器（跨天时归零）
  const today = _getReminderTodayStr();
  let accumDay = localStorage.getItem('study_reminder_idle_day');
  let accum = parseInt(localStorage.getItem('study_reminder_idle_accum') || '0');
  if (accumDay !== today) {
    accum = 0;
    localStorage.setItem('study_reminder_idle_accum', '0');
    localStorage.setItem('study_reminder_idle_day', today);
  }

  // 正在专注：空闲计时器归零并保持为零（不累加、不提醒）
  const isFocusing = (typeof timerRunning !== 'undefined' && timerRunning);
  if (isFocusing) {
    if (accum !== 0) _resetIdleAccum();
    return;
  }

  // 今天没有专注记录 → 不累加空闲、不提醒（空闲计时器基于今日专注结束开始）
  const todayLastFocus = _getTodayLastFocusEnd();
  if (todayLastFocus === 0) return;

  // 累加本次轮询间隔（约 30 秒）到空闲计时器，仅应用运行时才有此累加
  accum += 30000;
  localStorage.setItem('study_reminder_idle_accum', String(accum));

  const idleMin = parseInt(localStorage.getItem('study_reminder_idle_after_min')) || 60;
  if (accum < idleMin * 60000) return; // 空闲计时器未达阈值

  // 每天最多提醒次数（unlimited = 不限）
  const sentCount = parseInt(localStorage.getItem('study_reminder_idle_count_today') || '0');
  const sentDay = localStorage.getItem('study_reminder_idle_count_day');
  if (sentDay !== today) {
    localStorage.setItem('study_reminder_idle_count_day', today);
    localStorage.setItem('study_reminder_idle_count_today', '0');
  }
  const isUnlimited = localStorage.getItem('study_reminder_idle_unlimited') === 'true';
  if (!isUnlimited) {
    const maxCount = parseInt(localStorage.getItem('study_reminder_idle_max_count') || '3');
    if (sentCount >= maxCount) return;
  }

  // 冷却：距上次提醒至少 30 分钟
  const lastSentTs = parseInt(localStorage.getItem('study_reminder_idle_last_ts') || '0');
  if (lastSentTs && (Date.now() - lastSentTs) < 30 * 60 * 1000) return;

  // 豁免时间段
  if (_isInIdleExemptRange()) return;

  const msg = '你已经有一段时间没有进行聚焦计时了。' + _pick(ENCOURAGEMENTS_IDLE);
  localStorage.setItem('study_reminder_idle_count_today', String(sentCount + 1));
  localStorage.setItem('study_reminder_idle_last_ts', String(Date.now()));
  if (typeof sendNotification === 'function') {
    sendNotification('空闲提醒', msg);
  }
}

// ── Helper: check if current time is within idle exempt range ──
function _isInIdleExemptRange() {
  const exemptEnabled = localStorage.getItem('study_reminder_idle_exempt_enabled') === 'true';
  if (!exemptEnabled) return false;
  const ranges = loadIdleExemptRanges();
  if (!ranges.length) return false;
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  for (const r of ranges) {
    if (!r.start || !r.end) continue;
    if (r.start <= r.end) {
      if (hm >= r.start && hm < r.end) return true;
    } else {
      if (hm >= r.start || hm < r.end) return true;
    }
  }
  return false;
}

// ── Multi-range exempt CRUD ──
function loadIdleExemptRanges() {
  try {
    const raw = localStorage.getItem('study_reminder_idle_exempt_ranges');
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function saveIdleExemptRanges(ranges) {
  localStorage.setItem('study_reminder_idle_exempt_ranges', JSON.stringify(ranges));
}
function renderIdleExemptRanges() {
  const container = document.getElementById('idleExemptList');
  if (!container) return;
  const ranges = loadIdleExemptRanges();
  container.innerHTML = '';
  ranges.forEach(r => {
    const item = document.createElement('div');
    item.className = 'exempt-row';
    item.innerHTML =
      '<input type="time" value="' + (r.start || '') + '" data-id="' + r.id + '" data-field="start" onchange="updateIdleExemptRange(this)" class="exempt-time-input">' +
      '<span class="exempt-sep">至</span>' +
      '<input type="time" value="' + (r.end || '') + '" data-id="' + r.id + '" data-field="end" onchange="updateIdleExemptRange(this)" class="exempt-time-input">' +
      '<button class="exempt-del-btn" onclick="deleteIdleExemptRange(\'' + r.id + '\')" title="删除此段">' +
        '<i data-lucide="x" class="lucide-icon" style="width:14px;height:14px;"></i>' +
      '</button>';
    container.appendChild(item);
  });
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
function addIdleExemptRange() {
  const ranges = loadIdleExemptRanges();
  ranges.push({ id: 'ex' + Date.now(), start: '', end: '' });
  saveIdleExemptRanges(ranges);
  renderIdleExemptRanges();
  saveReminderSettings();
}
function deleteIdleExemptRange(id) {
  let ranges = loadIdleExemptRanges();
  ranges = ranges.filter(r => r.id !== id);
  saveIdleExemptRanges(ranges);
  renderIdleExemptRanges();
  saveReminderSettings();
}
function updateIdleExemptRange(inputEl) {
  const id = inputEl.dataset.id;
  const field = inputEl.dataset.field;
  const ranges = loadIdleExemptRanges();
  const r = ranges.find(r => r.id === id);
  if (r) r[field] = inputEl.value;
  saveIdleExemptRanges(ranges);
}

// ── Main Reminder Check (called from automation timer) ──
function checkReminders() {
  _checkCheckinReminder();
  _checkFocusAfterCheckinReminder();
  _checkIdleReminder();
}

// ── Track first checkin of the day (called from habits.js when checkin happens) ──
function trackFirstCheckinToday() {
  const today = _getReminderTodayStr();
  if (!localStorage.getItem('study_reminder_first_checkin_today') ||
      localStorage.getItem('study_reminder_first_checkin_day') !== today) {
    localStorage.setItem('study_reminder_first_checkin_today', String(Date.now()));
    localStorage.setItem('study_reminder_first_checkin_day', today);
  }
}

// ── Settings load/save ──
function loadReminderSettings() {
  const ckEnabled = localStorage.getItem('study_reminder_checkin_enabled') === 'true';
  const focusEnabled = localStorage.getItem('study_reminder_focus_enabled') === 'true';
  const idleEnabled = localStorage.getItem('study_reminder_idle_enabled') === 'true';

  const ckCb = document.getElementById('reminderCheckinEnabled');
  const focusCb = document.getElementById('reminderFocusEnabled');
  const idleCb = document.getElementById('reminderIdleEnabled');
  if (ckCb) ckCb.checked = ckEnabled;
  if (focusCb) focusCb.checked = focusEnabled;
  if (idleCb) idleCb.checked = idleEnabled;

  const ckTime = document.getElementById('reminderCheckinTime');
  const focusMin = document.getElementById('reminderFocusAfterMin');
  const idleMin = document.getElementById('reminderIdleAfterMin');
  if (ckTime) ckTime.value = localStorage.getItem('study_reminder_checkin_time') || '09:00';
  if (focusMin) focusMin.value = localStorage.getItem('study_reminder_focus_after_min') || '30';
  if (idleMin) idleMin.value = localStorage.getItem('study_reminder_idle_after_min') || '60';

  const idleMaxCount = document.getElementById('reminderIdleMaxCount');
  const idleUnlimited = document.getElementById('reminderIdleUnlimited');
  if (idleMaxCount) idleMaxCount.value = localStorage.getItem('study_reminder_idle_max_count') || '3';
  if (idleUnlimited) idleUnlimited.checked = localStorage.getItem('study_reminder_idle_unlimited') === 'true';
  if (idleMaxCount) idleMaxCount.disabled = (idleUnlimited && idleUnlimited.checked) || false;

  // Sync body visibility
  if (document.getElementById('reminderCheckinBody')) {
    document.getElementById('reminderCheckinBody').style.opacity = ckEnabled ? '1' : '0.5';
  }
  if (document.getElementById('reminderFocusBody')) {
    document.getElementById('reminderFocusBody').style.opacity = focusEnabled ? '1' : '0.5';
  }
  if (document.getElementById('reminderIdleBody')) {
    document.getElementById('reminderIdleBody').style.opacity = idleEnabled ? '1' : '0.5';
  }

  const exemptCb = document.getElementById('reminderIdleExemptEnabled');
  if (exemptCb) exemptCb.checked = localStorage.getItem('study_reminder_idle_exempt_enabled') === 'true';
  renderIdleExemptRanges();
}

function saveReminderSettings() {
  const ckCb = document.getElementById('reminderCheckinEnabled');
  const focusCb = document.getElementById('reminderFocusEnabled');
  const idleCb = document.getElementById('reminderIdleEnabled');

  const ckEnabled = ckCb ? ckCb.checked : false;
  const focusEnabled = focusCb ? focusCb.checked : false;
  const idleEnabled = idleCb ? idleCb.checked : false;

  localStorage.setItem('study_reminder_checkin_enabled', String(ckEnabled));
  localStorage.setItem('study_reminder_focus_enabled', String(focusEnabled));
  localStorage.setItem('study_reminder_idle_enabled', String(idleEnabled));

  const ckTime = document.getElementById('reminderCheckinTime');
  const focusMin = document.getElementById('reminderFocusAfterMin');
  const idleMin = document.getElementById('reminderIdleAfterMin');
  if (ckTime) localStorage.setItem('study_reminder_checkin_time', ckTime.value);
  if (focusMin) localStorage.setItem('study_reminder_focus_after_min', focusMin.value);
  if (idleMin) localStorage.setItem('study_reminder_idle_after_min', idleMin.value);

  const exemptCb = document.getElementById('reminderIdleExemptEnabled');
  if (exemptCb) localStorage.setItem('study_reminder_idle_exempt_enabled', String(exemptCb.checked));

  const maxCountEl = document.getElementById('reminderIdleMaxCount');
  const unlimitedCb = document.getElementById('reminderIdleUnlimited');
  if (maxCountEl) {
    if (unlimitedCb) maxCountEl.disabled = unlimitedCb.checked;
    localStorage.setItem('study_reminder_idle_max_count', maxCountEl.value);
  }
  if (unlimitedCb) localStorage.setItem('study_reminder_idle_unlimited', String(unlimitedCb.checked));

  // Sync body visibility
  if (document.getElementById('reminderCheckinBody')) {
    document.getElementById('reminderCheckinBody').style.opacity = ckEnabled ? '1' : '0.5';
  }
  if (document.getElementById('reminderFocusBody')) {
    document.getElementById('reminderFocusBody').style.opacity = focusEnabled ? '1' : '0.5';
  }
  if (document.getElementById('reminderIdleBody')) {
    document.getElementById('reminderIdleBody').style.opacity = idleEnabled ? '1' : '0.5';
  }

  // Restart automation timer to apply reminder changes
  stopAutomationTimer();
  if (shouldTimerRun()) startAutomationTimer();
}
// ═══════════ End Reminder System ═══════════

// Removed: deep think toggle is now in the AI chat toolbar

// Populate the summary AI key dropdown
function populateSummaryAiKeySelect() {
  const select = document.getElementById('settingsSummaryAiKey');
  if (!select) return;
  const keys = loadApiKeys();
  const savedId = localStorage.getItem('study_summary_ai_key_id') || '';
  select.innerHTML = '<option value="">（未设置）</option>';
  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.name + ' (' + (k.model || '未知') + ')';
    if (k.id === savedId) opt.selected = true;
    select.appendChild(opt);
  });
}

// Save summary AI key setting
function saveSummaryAiKeySetting() {
  const select = document.getElementById('settingsSummaryAiKey');
  if (!select) return;
  localStorage.setItem('study_summary_ai_key_id', select.value);
}

// ── Auto Title Settings ──
function populateAutoTitleAiKeySelect() {
  const select = document.getElementById('settingsAutoTitleAiKey');
  if (!select) return;
  const keys = loadApiKeys();
  const savedId = localStorage.getItem('study_auto_title_ai_key_id') || '';
  select.innerHTML = '<option value="">（使用当前对话的 Key）</option>';
  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.name + ' (' + (k.model || '未知') + ')';
    if (k.id === savedId) opt.selected = true;
    select.appendChild(opt);
  });
}

function saveAutoTitleSetting() {
  const enabled = document.getElementById('settingsAutoTitle')?.checked;
  const keyId = document.getElementById('settingsAutoTitleAiKey')?.value;
  if (enabled !== undefined) localStorage.setItem('study_auto_title_enabled', enabled);
  if (keyId !== undefined) localStorage.setItem('study_auto_title_ai_key_id', keyId);
}

function isAutoTitleEnabled() {
  return localStorage.getItem('study_auto_title_enabled') !== 'false';
}

function getAutoTitleAiKey() {
  const keyId = localStorage.getItem('study_auto_title_ai_key_id');
  if (!keyId) return null; // use current conversation key
  const keys = loadApiKeys();
  return keys.find(k => k.id === keyId) || null;
}

// Save notes settings (auto-saved via onchange)
function saveNotesSettings() {
  const autoCb = document.getElementById('settingsAutoSummary');
  if (autoCb) localStorage.setItem('study_auto_summary', autoCb.checked);
}

// ═══════════ Review Interval Settings ═══════════
function loadReviewSettings() {
  const mode = localStorage.getItem('study_review_mode') || 'standard';
  const modeSelect = document.getElementById('settingsReviewMode');
  if (modeSelect) modeSelect.value = mode;
  const customInput = document.getElementById('settingsReviewCustomIntervals');
  if (customInput) {
    const raw = localStorage.getItem('study_review_custom_intervals');
    customInput.value = raw || '';
  }
  const customField = document.getElementById('reviewCustomField');
  if (customField) customField.style.display = mode === 'custom' ? '' : 'none';
  updateReviewPreview();
}

function saveReviewSettings() {
  const modeSelect = document.getElementById('settingsReviewMode');
  const mode = modeSelect ? modeSelect.value : 'standard';
  localStorage.setItem('study_review_mode', mode);
  if (mode === 'custom') {
    const customInput = document.getElementById('settingsReviewCustomIntervals');
    const val = customInput ? customInput.value.trim() : '';
    localStorage.setItem('study_review_custom_intervals', val);
  }
  updateReviewPreview();
}

function onReviewModeChange() {
  saveReviewSettings();
  const modeSelect = document.getElementById('settingsReviewMode');
  const mode = modeSelect ? modeSelect.value : 'standard';
  const customField = document.getElementById('reviewCustomField');
  if (customField) customField.style.display = mode === 'custom' ? '' : 'none';
}

function updateReviewPreview() {
  const preview = document.getElementById('reviewPreview');
  if (!preview) return;
  const mode = document.getElementById('settingsReviewMode');
  if (!mode) return;
  const modeVal = mode.value;
  let intervals;
  if (modeVal === 'custom') {
    const input = document.getElementById('settingsReviewCustomIntervals');
    const raw = input ? input.value.trim() : '';
    intervals = raw ? raw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0) : null;
  } else {
    const preset = modeVal === 'relaxed' ? [2,4,8,15,30,60,120,240] : [1,2,4,7,15,30,60,120];
    intervals = preset;
  }
  if (!intervals || intervals.length === 0) {
    preview.textContent = '第 N 次复习后：无有效间隔';
  } else {
    const labels = intervals.map(d => {
      if (d >= 365) return Math.round(d / 365) + '年';
      if (d >= 30 && d % 30 === 0) return (d / 30) + '月';
      if (d >= 7 && d % 7 === 0) return (d / 7) + '周';
      return d + '天';
    });
    preview.textContent = '第 1〜' + intervals.length + ' 次复习后，间隔：' + labels.join(' → ');
  }
}
// ═══════════ End Review Interval Settings ═══════════

function saveSettings() {
  const developerMode = document.getElementById('settingsDeveloperMode').checked;
  const debugMode = document.getElementById('settingsDebug').checked;

  localStorage.setItem('study_developer_mode', developerMode);
  localStorage.setItem('study_debug_mode', debugMode);

  // Save max tool loops setting
  const maxLoopsInput = document.getElementById('settingsMaxToolLoops');
  if (maxLoopsInput) {
    const val = parseInt(maxLoopsInput.value) || 5;
    localStorage.setItem('study_max_tool_loops', Math.max(3, val));
  }

  // Refresh today to show/hide debug panel immediately
  if (typeof renderToday === 'function') renderToday();
}

// ─── Multi Key Management ───
function renderApiKeyList() {
  const el = document.getElementById('apiKeyList');
  if (!el) return;
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();

  if (keys.length === 0) {
    el.innerHTML = '<div class="hint" style="text-align:center;padding:8px;">暂无配置的 Key</div>';
    return;
  }

  el.innerHTML = keys.map(k => {
    const isActive = k.id === activeId;
    const modelName = k.model || 'gpt-3.5-turbo';
    return `
    <div style="display:flex;align-items:center;padding:8px 10px;margin:4px 0;background:var(--todo-bg);border-radius:8px;font-size:12px;gap:8px;${isActive ? 'border:2px solid var(--primary);' : ''}">
      <div style="flex:1;min-width:0;">
        <div style="color:var(--text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🔑 ${escapeHtml(k.name)} ${isActive ? '<span style="color:var(--primary);font-size:10px;">(当前使用)</span>' : ''}</div>
        <div style="color:var(--text-secondary);font-size:11px;">${escapeHtml(k.key.slice(0,12))}… | ${escapeHtml(modelName)} | ${k.baseUrl ? escapeHtml(k.baseUrl.replace(/\/+$/,'').replace(/https?:\/\//,'')) : 'openai'}</div>
      </div>
      <button onclick="setActiveApiKey('${k.id}')" style="background:${isActive ? 'var(--done)' : 'var(--border)'};color:${isActive ? '#fff' : 'var(--text)'};border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:10px;white-space:nowrap;" title="设为当前使用">${isActive ? '✅ 使用中' : '启用'}</button>
      <button onclick="editApiKey('${k.id}')" style="background:var(--primary);color:#fff;border:none;border-radius:4px;padding:3px 6px;cursor:pointer;font-size:10px;" title="编辑">✏️</button>
      <button onclick="deleteApiKey('${k.id}')" style="background:var(--danger);color:#fff;border:none;border-radius:4px;padding:3px 6px;cursor:pointer;font-size:10px;" title="删除">🗑️</button>
    </div>`;
  }).join('');
}

function showApiKeyForm(editId) {
  const form = document.getElementById('apiKeyForm');
  if (!form) return;
  if (editId) {
    const keys = loadApiKeys();
    const k = keys.find(k => k.id === editId);
    if (!k) return;
    document.getElementById('apiKeyFormName').value = k.name;
    document.getElementById('apiKeyFormKey').value = k.key;
    document.getElementById('apiKeyFormBaseUrl').value = k.baseUrl || '';
    document.getElementById('apiKeyFormModel').value = k.model || '';
    document.getElementById('apiKeyFormTemp').value = k.temperature != null ? k.temperature : 0.7;
    document.getElementById('apiKeyFormMaxTokens').value = k.maxTokens || '';
    document.getElementById('apiKeyFormContextLimit').value = k.contextLimit || 20;
    document.getElementById('apiKeyFormTitleContext').value = k.titleContextCount || 4;
    document.getElementById('apiKeyFormEditId').value = editId;
  } else {
    document.getElementById('apiKeyFormName').value = '';
    document.getElementById('apiKeyFormKey').value = '';
    document.getElementById('apiKeyFormBaseUrl').value = '';
    document.getElementById('apiKeyFormModel').value = '';
    document.getElementById('apiKeyFormTemp').value = '0.7';
    document.getElementById('apiKeyFormMaxTokens').value = '';
    document.getElementById('apiKeyFormContextLimit').value = 20;
    document.getElementById('apiKeyFormTitleContext').value = 4;
    document.getElementById('apiKeyFormEditId').value = '';
  }
  form.style.display = 'block';
  document.getElementById('apiKeyFormName').focus();
}

function cancelApiKeyForm() {
  document.getElementById('apiKeyForm').style.display = 'none';
}

function toggleApiFormMore() {
  const body = document.getElementById('apiFormMoreBody');
  const icon = document.getElementById('apiFormMoreIcon');
  if (!body || !icon) return;
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  icon.textContent = isOpen ? '▸' : '▾';
}

function submitApiKeyForm() {
  const editId = document.getElementById('apiKeyFormEditId').value;
  const name = document.getElementById('apiKeyFormName').value.trim();
  const key = document.getElementById('apiKeyFormKey').value.trim();
  const baseUrl = document.getElementById('apiKeyFormBaseUrl').value.trim();
  const model = document.getElementById('apiKeyFormModel').value.trim();
  const temperature = parseFloat(document.getElementById('apiKeyFormTemp').value) || 0.7;
  // Deep think is now toggled in the AI chat toolbar：编辑已有 Key 时保留原值，避免静默重置
  const deepThink = editId
    ? (loadApiKeys().find(k => k.id === editId)?.deepThink === true)
    : false;
  const maxTokensInput = document.getElementById('apiKeyFormMaxTokens').value.trim();
  const maxTokens = maxTokensInput ? parseInt(maxTokensInput) : 0;
  const contextLimit = parseInt(document.getElementById('apiKeyFormContextLimit').value) || 20;
  const titleContextCount = parseInt(document.getElementById('apiKeyFormTitleContext').value) || 4;

  if (!name) { showSettingsStatus('请输入 Key 名称', true); return; }
  if (!key) { showSettingsStatus('请输入 API Key', true); return; }

  const keys = loadApiKeys();

  if (editId) {
    const k = keys.find(k => k.id === editId);
    if (!k) return;
    k.name = name;
    k.key = key;
    k.baseUrl = baseUrl || 'https://api.openai.com/v1';
    k.model = model || 'gpt-3.5-turbo';
    k.temperature = temperature;
    k.deepThink = deepThink;
    k.maxTokens = maxTokens || undefined;
    k.contextLimit = Math.max(5, contextLimit);
    k.titleContextCount = Math.max(2, titleContextCount);
    showSettingsStatus('✅ Key 已更新');
  } else {
    keys.push({
      id: 'key_' + genId(),
      name, key,
      baseUrl: baseUrl || 'https://api.openai.com/v1',
      model: model || 'gpt-3.5-turbo',
      temperature, deepThink, maxTokens: maxTokens || undefined,
      contextLimit: Math.max(5, contextLimit),
      titleContextCount: Math.max(2, titleContextCount),
      createdAt: new Date().toISOString()
    });
    showSettingsStatus('✅ 已添加 Key：' + name);
  }

  saveApiKeys(keys);
  document.getElementById('apiKeyForm').style.display = 'none';
  renderApiKeyList();
}

function setActiveApiKey(id) {
  localStorage.setItem('study_active_api_key_id', id);
  renderApiKeyList();
  showSettingsStatus('✅ 已切换当前 Key');
}

function editApiKey(id) {
  showApiKeyForm(id);
}

function deleteApiKey(id) {
  showCustomConfirm('确定要删除这个 Key 配置吗？', { dontAskKey: 'study_dontask_delete_key' }).then(confirmed => {
    if (!confirmed) return;
    const keys = loadApiKeys();
    const idx = keys.findIndex(k => k.id === id);
    if (idx === -1) return;
    keys.splice(idx, 1);
    saveApiKeys(keys);
    if (getActiveApiKeyId() === id) {
      localStorage.setItem('study_active_api_key_id', keys.length > 0 ? keys[0].id : '');
    }
    renderApiKeyList();
    showSettingsStatus('✅ 已删除 Key');
  });
}

function showSettingsStatus(msg, isError) {
  const el = document.getElementById('settingsStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'settings-status' + (isError ? ' error' : ' success');
  setTimeout(() => { el.textContent = ''; el.className = 'settings-status'; }, 3000);
}

// Get display name of currently active key
function getActiveKeyDisplayName() {
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  const active = keys.find(k => k.id === activeId);
  if (active) return active.name;
  return keys.length > 0 ? keys[0].name : '';
}

// Build the key switcher bar HTML for the chat UI bottom area
function buildKeyBarHTML(activeName) {
  const keys = loadApiKeys();
  const activeId = getActiveApiKeyId();
  if (keys.length === 0) {
    return `<div class="ai-key-bar-inner">
      <span class="ai-key-label">🔑 当前 Key</span>
      <button class="ai-key-chip ai-key-chip-empty" onclick="openSettingsModal()">未配置，点击设置 →</button>
    </div>`;
  }
  const chips = keys.map(k => {
    const isActive = k.id === activeId;
    const modelShort = (k.model || 'gpt-3.5-turbo').replace(/-.*/, '');
    return `<button class="ai-key-chip${isActive ? ' active' : ''}"
      onclick="switchActiveKey('${k.id}')"
      title="${escapeHtml(k.name)} · ${escapeHtml(k.model || 'gpt-3.5-turbo')}">
      ${escapeHtml(k.name)}
      <span class="ai-key-chip-model">${escapeHtml(modelShort)}</span>
    </button>`;
  }).join('');
  return `<div class="ai-key-bar-inner">
    <span class="ai-key-label">🔑</span>
    <div class="ai-key-chips">${chips}</div>
    <button class="ai-key-bar-add" onclick="openSettingsModal()" title="管理 API Key">＋</button>
  </div>`;
}

// Switch active key and refresh the key bar
function switchActiveKey(id) {
  localStorage.setItem('study_active_api_key_id', id);
  refreshKeyBar();
  // Update file input accept based on the new model
  if (typeof updateAiFileInput === 'function') updateAiFileInput();
}

// Refresh just the key bar without full re-render
function refreshKeyBar() {
  const bar = document.getElementById('aiKeyBar');
  if (!bar) return;
  const activeName = getActiveKeyDisplayName();
  bar.innerHTML = buildKeyBarHTML(activeName);
}

// Legacy: kept for backward compatibility, no longer used by new UI
function buildKeySelectorOptions() {
  return '';
}
function onAiKeySwitch() {}

// ═══════════ App Quit ═══════════
function quitApp() {
  if (window.electronAPI && window.electronAPI.quitApp) {
    window.electronAPI.quitApp();
  }
}

// ═══════════ Automation List UI ═══════════
function renderAutomationList() {
  const el = document.getElementById('automationList');
  if (!el) return;
  if (automations.length === 0) {
    el.innerHTML = '<div class="hint" style="text-align:center;padding:20px;">暂无自动化任务，让 AI 帮你创建一个吧！</div>';
    return;
  }
  el.innerHTML = automations.map(a => {
    const conv = aiConvs.find(c => c.id === a.convId);
    const convTitle = conv ? escapeHtml(conv.title || '对话#' + a.convId) : '（对话已删除）';
    const isOnce = a.repeat === 'once';
    const repeatLabel = isOnce ? '1️⃣ 一次性' : '🔄 每天';
    const timeLabel = isOnce ? `触发时间 ${escapeHtml(a.at)}` : `每天 ${escapeHtml(a.at)}`;
    return `
    <div style="display:flex;align-items:flex-start;padding:10px 12px;margin:4px 0;background:var(--todo-bg);border-radius:8px;font-size:13px;gap:8px;${a.enabled === false ? 'opacity:0.5;' : ''}">
      <input type="checkbox" ${a.enabled !== false ? 'checked' : ''} onchange="toggleAutomationEnabled(${a.id}, this.checked)" style="flex-shrink:0;margin-top:3px;cursor:pointer;width:16px;height:16px;accent-color:var(--primary);" title="${a.enabled !== false ? '已启用，点击停用' : '已停用，点击启用'}">
      <div style="flex:1;min-width:0;">
        <div style="color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
          ⏰ <b>${timeLabel}</b>
          <span style="color:var(--text-secondary);font-size:11px;margin-left:2px;">${repeatLabel}</span>
          <span style="color:var(--text-secondary);font-size:11px;margin-left:4px;">→ ${convTitle}</span>
        </div>
        <div style="color:var(--text-secondary);font-size:12px;margin-top:2px;">${escapeHtml(a.prompt)}</div>
        ${a.lastRun ? `<div style="color:var(--done);font-size:10px;margin-top:2px;">✅ 上次运行：${escapeHtml(a.lastRun)}</div>` : '<div style="color:var(--text-secondary);font-size:10px;margin-top:2px;">⏳ 尚未运行</div>'}
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button onclick="editAutomationById(${a.id})" style="background:var(--primary);color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;" title="编辑">✏️</button>
        <button onclick="deleteAutomationById(${a.id})" style="background:var(--danger);color:#fff;border:none;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;" title="删除">🗑️</button>
      </div>
    </div>
  `}).join('');
}

function toggleAutomationEnabled(id, enabled) {
  const a = automations.find(a => a.id === id);
  if (!a) return;
  a.enabled = enabled;
  saveData('study_automations', automations);
  // Restart timer to apply changes
  stopAutomationTimer();
  if (shouldTimerRun()) startAutomationTimer();
  renderAutomationList();
}

// Show the inline add/edit form
function showAutomationForm(editId) {
  const form = document.getElementById('automationForm');
  const editIdInput = document.getElementById('autoFormEditId');
  if (!form) return;

  if (editId) {
    // Edit mode: pre-fill with existing data
    const a = automations.find(a => a.id === editId);
    if (!a) return;
    document.getElementById('autoFormAt').value = a.at;
    document.getElementById('autoFormPrompt').value = a.prompt;
    document.getElementById('autoFormRepeat').value = a.repeat || 'daily';
    editIdInput.value = editId;
  } else {
    // Add mode: clear form
    document.getElementById('autoFormAt').value = '';
    document.getElementById('autoFormPrompt').value = '';
    document.getElementById('autoFormRepeat').value = 'daily';
    editIdInput.value = '';
  }
  form.style.display = 'block';
  document.getElementById('autoFormAt').focus();
}

function cancelAutomationForm() {
  const form = document.getElementById('automationForm');
  if (form) form.style.display = 'none';
}

function submitAutomationForm() {
  const editId = document.getElementById('autoFormEditId').value;
  const at = document.getElementById('autoFormAt').value.trim();
  const promptText = document.getElementById('autoFormPrompt').value.trim();
  const repeat = document.getElementById('autoFormRepeat').value;

  if (!at || !/^\d{2}:\d{2}$/.test(at)) {
    showAutomationStatus('❌ 请输入有效的时间格式 HH:MM（如 09:30）');
    return;
  }
  if (!promptText) {
    showAutomationStatus('❌ 请输入任务描述');
    return;
  }

  if (editId) {
    // Update existing
    const a = automations.find(a => a.id === parseInt(editId));
    if (!a) return;
    a.at = at;
    a.prompt = promptText;
    a.repeat = repeat;
    saveData('study_automations', automations);
    stopAutomationTimer();
    if (shouldTimerRun()) startAutomationTimer();
    renderAutomationList();
    showAutomationStatus('✅ 已更新自动化任务');
  } else {
    // Add new
    const convId = activeConvId;
    if (!convId) { showAutomationStatus('❌ 请先选择一个对话'); return; }
    const newAuto = {
      id: genId(),
      convId,
      at,
      prompt: promptText,
      repeat,
      createdAt: new Date().toISOString(),
      lastRun: null,
      enabled: true
    };
    automations.push(newAuto);
    saveData('study_automations', automations);
    stopAutomationTimer();
    startAutomationTimer();
    renderAutomationList();
    showAutomationStatus('✅ 已创建自动化任务：' + (repeat === 'once' ? '一次性 ' : '每天 ') + at);
  }

  // Hide form
  document.getElementById('automationForm').style.display = 'none';
}

function editAutomationById(id) {
  showAutomationForm(id);
}

function showAutomationStatus(msg) {
  const el = document.getElementById('automationStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'settings-status';
  setTimeout(() => { el.textContent = ''; }, 3000);
}

function deleteAutomationById(id) {
  showCustomConfirm('确定要删除这个自动化任务吗？', { dontAskKey: 'study_dontask_delete_auto' }).then(confirmed => {
    if (!confirmed) return;
    const idx = automations.findIndex(a => a.id === id);
    if (idx === -1) return;
    automations.splice(idx, 1);
    saveData('study_automations', automations);
    if (automations.length === 0 || automations.every(a => a.enabled === false)) stopAutomationTimer();
    renderAutomationList();
    showAutomationStatus('✅ 已删除自动化任务');
  });
}

// Initialize automation list when settings modal opens
const origOpenSettings = openSettingsModal;
openSettingsModal = function() {
  origOpenSettings();
  setTimeout(renderAutomationList, 100);
};

// ═══════════ Automation Engine ═══════════
function getNowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function startAutomationTimer() {
  if (automationTimer) return; // already running
  automationTimer = setInterval(() => {
    checkAutomations();
    checkEveningReport();
    checkReminders();
  }, 30000); // check every 30 seconds
}

function shouldTimerRun() {
  const hasAuto = automations.some(a => a.enabled !== false);
  const hasEvening = loadEveningReportCfg().enabled;
  const hasReminder = localStorage.getItem('study_reminder_checkin_enabled') === 'true'
    || localStorage.getItem('study_reminder_focus_enabled') === 'true'
    || localStorage.getItem('study_reminder_idle_enabled') === 'true';
  return hasAuto || hasEvening || hasReminder;
}

function stopAutomationTimer() {
  if (automationTimer) { clearInterval(automationTimer); automationTimer = null; }
}

async function checkAutomations() {
  const now = getNowHHMM();
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) return;

  for (const auto of automations) {
    // Skip disabled automations
    if (auto.enabled === false) continue;
    if (auto.at !== now) continue;

    // Prevent double-trigger within the same minute (only for daily tasks; once tasks always trigger)
    if (auto.repeat !== 'once') {
      const lastRunDate = auto.lastRun ? auto.lastRun.split(' ')[0] : null;
      const today = getTodayStr();
      if (lastRunDate === today) continue;
    }

    auto.lastRun = getTodayStr() + ' ' + now;
    saveData('study_automations', automations);

    // For one-time tasks, disable after triggering
    if (auto.repeat === 'once') {
      auto.enabled = false;
      saveData('study_automations', automations);
      // Stop timer if no more active tasks
      if (automations.every(a => a.enabled === false)) {
        stopAutomationTimer();
      }
    }

    // Find the conversation
    const conv = aiConvs.find(c => c.id === auto.convId);
    if (!conv) continue;

    // Execute automation asynchronously
    executeAutomation(conv, auto);
  }
}

async function executeAutomation(conv, auto) {
  const apiCfg = getEffectiveApiConfig();

  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  // Build a user-style message for the automation trigger (so AI treats it as an actionable request)
  const triggerMsg = `[🤖 系统自动触发] 这是一条由定时自动化任务自动发送的消息。当前时间：${timeStr}。\n任务内容：${auto.prompt}\n\n请根据上述任务内容执行操作。`;

  // Push as a user message into the conversation so AI responds naturally
  appendMessage(conv, { role: 'user', content: triggerMsg, time: timeStr });
  saveData('study_ai_convs', aiConvs);

  try {
    console.log('[Auto API] model:', apiCfg.model, 'deepThink:', apiCfg.deepThink);

    // Use the shared tool call loop — tools execute invisibly, only final reply is shown
    const { finalCleanText, finalReasoning } = await runToolCallLoop(
      apiCfg, conv,
      // Intermediate callback: refresh UI after each tool execution round
      () => {
        saveData('study_ai_convs', aiConvs);
        if (activeConvId === conv.id) renderAiMessages();
      }
    );

    // Push only the final visible reply
    const keyName = getActiveKeyDisplayName();
    const messageObj = { role: 'assistant', content: finalCleanText, time: timeStr, keyName };
    if (finalReasoning) messageObj.reasoning = finalReasoning;
    appendMessage(conv, messageObj);

    saveData('study_ai_convs', aiConvs);

    // Refresh UI if user is viewing this conversation
    if (activeConvId === conv.id) {
      renderAiMessages();
    } else {
      // Mark conversation as having unread automation response
      conv._hasUnreadAuto = true;
      // Send Windows notification if user is not looking
      if (typeof sendAiNotification === 'function') {
        sendAiNotification(conv, finalCleanText, keyName);
      }
      saveData('study_ai_convs', aiConvs);
    }
    renderTodos(); renderLinks(); renderNotes(); renderToday();

    // Send system notification about completed automation
    const taskPreview = auto.prompt.length > 30 ? auto.prompt.slice(0, 30) + '…' : auto.prompt;
    sendNotification(
      '🤖 自动化任务已执行',
      '「' + taskPreview + '」\n点击切换到对应对话查看结果',
      'auto-' + auto.id
    );

  } catch (err) {
    appendMessage(conv, { role: 'assistant', content: '❌ 自动化执行出错：' + err.message, time: timeStr, keyName: getActiveKeyDisplayName() });
    saveData('study_ai_convs', aiConvs);
    if (activeConvId === conv.id) renderAiMessages();
  }
}

// Start automation timer on load if needed
if (shouldTimerRun()) {
  startAutomationTimer();
}

// Auto-generate conversation title using AI
// Uses the latest N messages (configurable via apiCfg.titleContextCount)
async function generateConvTitle(conv) {
  // Check if auto-title is enabled
  if (!isAutoTitleEnabled()) {
    console.log('[TitleGen] Auto-title disabled, skipping');
    return;
  }
  // Use dedicated auto-title key if set, otherwise fall back to active key
  const dedicatedKey = getAutoTitleAiKey();
  const apiCfg = dedicatedKey ? {
    apiKey: dedicatedKey.key,
    baseUrl: dedicatedKey.baseUrl || 'https://api.openai.com/v1',
    model: dedicatedKey.model || 'gpt-3.5-turbo',
    temperature: dedicatedKey.temperature != null ? dedicatedKey.temperature : 0.7,
    titleContextCount: dedicatedKey.titleContextCount || 4,
    contextLimit: dedicatedKey.contextLimit || 20
  } : getEffectiveApiConfig();
  if (!apiCfg.apiKey) {
    console.warn('[TitleGen] No API key configured, skipping');
    return;
  }
  const msgCount = apiCfg.titleContextCount || 4;

  // Take the last N messages (skip system msgs)
  const recentMsgs = conv.messages.filter(m => m.role !== 'system').slice(-msgCount);
  if (recentMsgs.length < 1) {
    console.warn('[TitleGen] Not enough messages, skipping');
    return;
  }

  const charLimit = (apiCfg.contextLimit || 20) * 5;
  const convContext = recentMsgs.map(m => {
    const roleLabel = m.role === 'user' ? '用户' : 'AI';
    return `${roleLabel}：${String(m.content || '').slice(0, charLimit)}`;
  }).join('\n');

  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  console.log('[TitleGen] Generating title for conv', conv.id, 'model:', apiCfg.model, 'msgs:', recentMsgs.length);
  try {
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiCfg.apiKey
      },
      body: JSON.stringify({
        model: apiCfg.model,
        messages: [
          { role: 'system', content: '你是一个标题生成助手。根据以下对话内容，生成一个简短的对话标题（不超过15个字）。只输出标题文本，不要加引号、标点或任何额外说明。' },
          { role: 'user', content: convContext + '\n\n请为这段对话生成一个简短标题。' }
        ],
        temperature: (apiCfg.model || '').toLowerCase().includes('kimi') ? 1 : 0.7,
        max_tokens: 100,
        stream: false
      })
    });
    if (resp.ok) {
      const data = await resp.json();
      const title = (data.choices?.[0]?.message?.content || '').trim().replace(/["""'']/g, '').slice(0, 20);
      console.log('[TitleGen] Got title:', title);
      if (title && title.length >= 2) {
        conv.title = title;
        conv.autoTitled = true;
        saveData('study_ai_convs', aiConvs);
        renderAiChat();
      } else {
        console.warn('[TitleGen] Title too short or empty:', JSON.stringify(title));
      }
    } else {
      const errText = await resp.text().catch(() => '');
      console.warn('[TitleGen] HTTP ' + resp.status + ' for model ' + apiCfg.model + ': ' + errText.slice(0, 200));
    }
  } catch (e) {
    console.warn('[TitleGen] Fetch error:', e.message);
  }
}

// ═══════════ Debug Mode ═══════════
function isDebugMode() {
  return localStorage.getItem('study_debug_mode') === 'true';
}

function onDebugToggle() {
  const debug = document.getElementById('settingsDebug').checked;
  localStorage.setItem('study_debug_mode', debug);
  renderToday();
}

// ═══════════ Web Search Settings ═══════════
function saveWebSearchSettings() {
  const engine = document.getElementById('settingsWebSearchEngine').value;
  const key = document.getElementById('settingsWebSearchKey').value.trim();
  localStorage.setItem('study_web_search_engine', engine);
  localStorage.setItem('study_web_search_key', key);
}
function loadWebSearchSettings() {
  const engine = localStorage.getItem('study_web_search_engine') || 'duckduckgo';
  const key = localStorage.getItem('study_web_search_key') || '';
  const engineEl = document.getElementById('settingsWebSearchEngine');
  const keyEl = document.getElementById('settingsWebSearchKey');
  if (engineEl) engineEl.value = engine;
  if (keyEl) keyEl.value = key;
  updateWebSearchKeyFieldVisibility();
}

// ═══════════ Books KB Settings ═══════════
function saveBooksKbSettings() {
  const el = document.getElementById('settingsBooksKbTruncate');
  if (el) {
    let v = parseInt(el.value, 10);
    if (!Number.isFinite(v)) v = 9000;
    v = Math.max(1000, Math.min(100000, v));
    el.value = v;
    localStorage.setItem('study_books_kb_truncate', String(v));
  }
  // 章节讲解上下文轮数（0~30）
  const rEl = document.getElementById('settingsBooksCtxRounds');
  if (rEl) {
    let r = parseInt(rEl.value, 10);
    if (!Number.isFinite(r)) r = 6;
    r = Math.max(0, Math.min(30, r));
    rEl.value = r;
    localStorage.setItem('study_bk_explain_ctx_rounds', String(r));
  }
}
function loadBooksKbSettings() {
  const el = document.getElementById('settingsBooksKbTruncate');
  if (el) {
    let v = parseInt(localStorage.getItem('study_books_kb_truncate') || '9000', 10);
    if (!Number.isFinite(v)) v = 9000;
    el.value = Math.max(1000, Math.min(100000, v));
  }
  const rEl = document.getElementById('settingsBooksCtxRounds');
  if (rEl) {
    let r = parseInt(localStorage.getItem('study_bk_explain_ctx_rounds') || '6', 10);
    if (!Number.isFinite(r)) r = 6;
    rEl.value = Math.max(0, Math.min(30, r));
  }
}

// ═══════════ Evening Report Settings ═══════════
function loadEveningReportSettings() {
  const cfg = loadEveningReportCfg();
  const enabledEl = document.getElementById('eveningReportEnabled');
  const timeEl = document.getElementById('eveningReportTime');
  if (enabledEl) enabledEl.checked = cfg.enabled;
  if (timeEl) timeEl.value = cfg.time || '21:00';
}

function saveEveningReportSettings() {
  const enabledEl = document.getElementById('eveningReportEnabled');
  const timeEl = document.getElementById('eveningReportTime');
  const cfg = {
    enabled: enabledEl ? enabledEl.checked : false,
    time: timeEl ? timeEl.value : '21:00'
  };
  saveEveningReportCfg(cfg);
  // Start or stop timer based on new state
  stopAutomationTimer();
  if (shouldTimerRun()) startAutomationTimer();
}

async function debugTriggerEveningReport() {
  if (eveningReportInProgress) return;
  const apiCfg = getEffectiveReportApiConfig();
  if (!apiCfg.apiKey) { alert('请先设置日报 API Key（设置 → 更多设置 → 日报 Key）'); return; }
  const dbgEl = document.getElementById('debugStatus');
  if (dbgEl) { dbgEl.textContent = '正在生成晚间日报...'; dbgEl.className = 'settings-status'; }
  eveningReportInProgress = true;
  try {
    const r = await generateEveningReport();
    if (r && r.ok) alert('🌙 晚间日报已生成，请在「☀️ 晨间日报」对话中查看');
    else alert('晚间日报生成失败：' + (r && r.error ? r.error : '未知错误'));
  } finally {
    eveningReportInProgress = false;
  }
}

// ═══════════ Day Report Key + Morning Report Settings ═══════════
function loadDayReportSettings() {
  const keys = loadApiKeys();
  const activeReportKeyId = getActiveReportKeyId();
  const sel = document.getElementById('settingsDayReportAiKey');
  if (!sel) return;
  // Build options: default + all keys
  sel.innerHTML = '<option value="">（使用当前激活的 Key）</option>';
  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k.id;
    opt.textContent = k.name || k.id.slice(0, 8);
    if (k.id === activeReportKeyId) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.value = activeReportKeyId;
}

function saveDayReportSettings() {
  const sel = document.getElementById('settingsDayReportAiKey');
  if (sel) setActiveReportKeyId(sel.value);
}

// ═══════════ Todo Statuses Management ═══════════
function renderStatusList() {
  const container = document.getElementById('settingsTodoStatuses');
  if (!container) return;
  const options = loadStatusOptions();
  let html = '';
  options.forEach((o, i) => {
    html += `<div class="status-mgmt-item" draggable="true" data-index="${i}" ondragstart="statusDragStart(event,${i})" ondragover="statusDragOver(event)" ondrop="statusDrop(event,${i})" ondragend="statusDragEnd(event)">
      <span class="status-mgmt-grip"><i data-lucide="grip-vertical" class="lucide-icon" style="width:14px;height:14px"></i></span>
      <span class="status-mgmt-dot" style="background:${o.color}"></span>
      <span class="status-mgmt-label">${escapeHtml(o.name)}</span>
      <button class="status-mgmt-btn status-mgmt-edit" onclick="openStatusEditor(${i})" title="编辑名称与颜色">
        <i data-lucide="pencil" class="lucide-icon" style="width:14px;height:14px"></i>
      </button>
      <button class="status-mgmt-btn status-mgmt-delete" onclick="deleteStatusItem(${i})" title="删除">
        <i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px"></i>
      </button>
    </div>`;
  });
  // Add new row
  html += `<div class="status-mgmt-item status-mgmt-add">
    <span class="status-mgmt-dot status-mgmt-add-dot">+</span>
    <input type="text" class="status-mgmt-input" id="newStatusInput" placeholder="添加新状态..." onkeydown="if(event.key==='Enter')addStatusItem()">
    <button class="status-mgmt-btn status-mgmt-add-btn" onclick="addStatusItem()" title="添加">
      <i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px"></i>
    </button>
  </div>`;
  // Edit popover (hidden by default)
  html += `<div class="status-edit-popover" id="statusEditPopover" style="display:none">
    <div class="status-edit-row">
      <label class="status-edit-label">名称</label>
      <input type="text" id="statusEditName" class="status-edit-input" placeholder="状态名称">
    </div>
    <div class="status-edit-row">
      <label class="status-edit-label">颜色</label>
      <div class="status-color-grid" id="statusColorGrid">${STATUS_COLORS.map(c => `<span class="status-color-swatch" style="background:${c}" data-color="${c}" onclick="pickStatusColor('${c}')"></span>`).join('')}</div>
    </div>
    <div class="status-edit-actions">
      <button class="btn-save-settings" onclick="saveStatusEdit()" style="padding:5px 14px;width:auto;">保存</button>
      <button class="debug-btn" onclick="closeStatusEditor()" style="padding:5px 14px;width:auto;">取消</button>
    </div>
  </div>`;
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

let _editingStatusIndex = -1;
function openStatusEditor(index) {
  _editingStatusIndex = index;
  const options = loadStatusOptions();
  const o = options[index];
  if (!o) return;
  const popover = document.getElementById('statusEditPopover');
  const nameInput = document.getElementById('statusEditName');
  if (popover) popover.style.display = 'block';
  if (nameInput) nameInput.value = o.name;
  // Highlight current color
  document.querySelectorAll('.status-color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === o.color);
  });
  // 确保 popover 在设置弹窗的滚动区域内可见（否则会显示在容器外，用户看不到）
  if (popover) {
    const modalBody = popover.closest('.modal-body');
    const ensureVisible = () => {
      const pr = popover.getBoundingClientRect();
      const cr = modalBody ? modalBody.getBoundingClientRect() : null;
      if (!cr) return;
      if (pr.bottom > cr.bottom) {
        modalBody.scrollTop += pr.bottom - cr.bottom + 12;
      } else if (pr.top < cr.top) {
        modalBody.scrollTop += pr.top - cr.top - 12;
      }
    };
    setTimeout(ensureVisible, 30);
  }
}

function closeStatusEditor() {
  const popover = document.getElementById('statusEditPopover');
  if (popover) popover.style.display = 'none';
  _editingStatusIndex = -1;
}

function pickStatusColor(color) {
  document.querySelectorAll('.status-color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
}

function saveStatusEdit() {
  if (_editingStatusIndex < 0) return;
  const nameInput = document.getElementById('statusEditName');
  const activeSwatch = document.querySelector('.status-color-swatch.active');
  if (!nameInput) return;
  const newName = nameInput.value.trim();
  if (!newName) return;
  const options = loadStatusOptions();
  if (options.some((o, i) => i !== _editingStatusIndex && o.name === newName)) {
    showStatusMsg('状态名称已存在', true);
    return;
  }
  options[_editingStatusIndex].name = newName;
  if (activeSwatch) options[_editingStatusIndex].color = activeSwatch.dataset.color;
  saveStatusOptions(options);
  closeStatusEditor();
  renderStatusList();
  showStatusMsg('已更新');
}

function addStatusItem() {
  const input = document.getElementById('newStatusInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  const options = loadStatusOptions();
  if (options.some(o => o.name === name)) {
    showStatusMsg('状态名称已存在', true);
    return;
  }
  options.push({ name, color: STATUS_COLORS[options.length % STATUS_COLORS.length] });
  saveStatusOptions(options);
  input.value = '';
  renderStatusList();
  showStatusMsg('已添加');
}

function deleteStatusItem(index) {
  const options = loadStatusOptions();
  if (options.length <= 1) {
    showStatusMsg('至少需要保留一个状态', true);
    return;
  }
  options.splice(index, 1);
  saveStatusOptions(options);
  renderStatusList();
  showStatusMsg('已删除');
}

// ── Drag & Drop ──
let _dragSrcIndex = -1;
function statusDragStart(e, index) {
  _dragSrcIndex = index;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(index));
  e.target.classList.add('dragging');
}
function statusDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}
function statusDrop(e, index) {
  e.preventDefault();
  if (_dragSrcIndex < 0 || _dragSrcIndex === index) return;
  const options = loadStatusOptions();
  const moved = options.splice(_dragSrcIndex, 1)[0];
  options.splice(index, 0, moved);
  saveStatusOptions(options);
  renderStatusList();
  showStatusMsg('排序已保存');
}
function statusDragEnd(e) {
  e.target.classList.remove('dragging');
  _dragSrcIndex = -1;
}

function saveStatusOptions(options) {
  localStorage.setItem('study_todo_statuses', JSON.stringify(options));
  if (typeof invalidateStatusOptionsCache === 'function') invalidateStatusOptionsCache();
}

function showStatusMsg(msg, isError) {
  const st = document.getElementById('todoStatusesStatus');
  if (!st) return;
  st.textContent = msg;
  st.className = 'settings-status ' + (isError ? 'error' : 'success');
  setTimeout(function() { st.textContent = ''; }, 2000);
}

function loadTodoStatusesToSettings() {
  renderStatusList();
}

function loadMorningReportSettings() {
  const cfg = JSON.parse(localStorage.getItem('study_morning_cfg') || '{"enabled":true}');
  const el = document.getElementById('morningReportEnabled');
  if (el) el.checked = cfg.enabled;
}

function saveMorningReportSettings() {
  const el = document.getElementById('morningReportEnabled');
  localStorage.setItem('study_morning_cfg', JSON.stringify({
    enabled: el ? el.checked : true
  }));
}
function updateWebSearchKeyFieldVisibility() {
  const engine = document.getElementById('settingsWebSearchEngine').value;
  const field = document.getElementById('settingsWebSearchKeyField');
  if (field) field.style.display = engine === 'duckduckgo' ? 'none' : '';
}

// ── Data migration ──
// 备份/导出/导入共用此列表。v2 补全：纳入所有核心业务数据（与云同步 SYNC_KEYS 对齐），
// 此前缺失了计时、任务线、习惯、教材、日历、统计、长期目标、快捷访问、AI 长期记忆、
// 教材日志/测验、待办完成日志、旧版数据，导致备份不完整（AI 记忆甚至从未被备份）。
const MIGRATION_KEYS = [
  // 待办 / 笔记
  'study_todos_v2', 'study_todos', 'study_notes_v2', 'study_notes', 'study_notes_folders',
  'study_todo_completed_log',
  // 计时 / 习惯 / 任务线
  'study_timer_records', 'study_habits', 'study_habits_v1', 'study_taskline_v1',
  // 教材
  'study_books_v1', 'study_books_meta', 'study_bk_explain_logs_v1', 'study_bk_quiz_state_v1',
  // 日历 / 统计 / 目标
  'study_calendar_events', 'study_stats', 'study_longterm_goals', 'study_quick_access',
  // 打卡 / 今日 / 链接 / AI
  'study_checkin', 'study_today_focus', 'study_links_v3', 'study_ai_convs', 'study_ai_memory',
  // UI/状态/敏感（仅本地备份，不同步）
  'study_changelog', 'study_active_note', 'study_sidebar_open', 'study_theme', 'study_active_conv',
  'study_api_keys', 'study_active_api_key_id', 'study_developer_mode', 'study_debug_mode',
  'study_automations'
];

function exportAllData() {
  const data = {};
  for (const key of MIGRATION_KEYS) {
    const val = localStorage.getItem(key);
    if (val !== null) data[key] = val;
  }
  downloadJsonFile(data, 'study-table-backup-' + new Date().toISOString().slice(0, 10) + '.json');
  showMigrateMsg('✅ 数据已导出', '#10b981');
}

function downloadJsonFile(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ═══════════ Backup Export & Directory ═══════════
// Export all backup records as a single JSON file and download it
function exportAllBackups() {
  const backupsStr = localStorage.getItem('study_backups');
  if (!backupsStr) {
    showMigrateMsg('❌ 没有备份记录', '#ef4444');
    return;
  }
  const data = { exportedAt: new Date().toISOString(), backups: JSON.parse(backupsStr) };
  const filename = 'study-table-all-backups-' + new Date().toISOString().slice(0, 10) + '.json';
  downloadJsonFile(data, filename);
  showMigrateMsg('✅ 已导出 ' + data.backups.length + ' 份备份', '#10b981');
}

// Open the directory where backups are saved (downloads folder)
// In Electron, opens the downloads directory in file explorer.
// In browser, shows a hint about where files are downloaded.
async function openBackupDirectory() {
  if (window.electronAPI && window.electronAPI.openBackupDir) {
    await window.electronAPI.openBackupDir();
    showMigrateMsg('📂 已打开下载目录', '#6366f1');
  } else {
    // Browser fallback: show a hint
    showMigrateMsg('💡 备份文件已下载到浏览器的默认下载目录', '#f59e0b');
  }
}

function importAllData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      const data = JSON.parse(ev.target.result);
      let count = 0;
      for (const key of MIGRATION_KEYS) {
        if (key in data) {
          localStorage.setItem(key, data[key]);
          count++;
        }
      }
      showMigrateMsg('✅ 已导入 ' + count + ' 项数据，请刷新页面', '#6366f1');
    } catch {
      showMigrateMsg('❌ 文件格式错误', '#ef4444');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function showMigrateMsg(msg, color) {
  const el = document.getElementById('migrateStatus');
  if (el) { el.textContent = msg; el.style.color = color; }
  setTimeout(() => { if (el) el.textContent = ''; }, 4000);
}

// ═══════════ Auto Backup (file-based) ═══════════
let backupTimer = null;
const MIGRATION_KEYS_BACKUP = MIGRATION_KEYS; // reuse from global scope

// Collect all app data for backup
function collectAllBackupData() {
  const data = {};
  for (const key of MIGRATION_KEYS_BACKUP) {
    const val = localStorage.getItem(key);
    if (val !== null) data[key] = val;
  }
  return data;
}

function saveBackupSettings() {
  const select = document.getElementById('settingsBackupInterval');
  if (!select) return;
  const minutes = parseInt(select.value) || 0;
  localStorage.setItem('study_backup_interval', minutes);
  // Save max backup files
  const maxInput = document.getElementById('settingsMaxBackupFiles');
  if (maxInput) {
    const max = parseInt(maxInput.value) || 30;
    localStorage.setItem('study_max_backup_files', Math.max(max, 1));
  }
  restartBackupTimer(minutes);
  updateBackupHints();
}

async function performAutoBackup() {
  const data = collectAllBackupData();
  const maxFiles = parseInt(localStorage.getItem('study_max_backup_files')) || 30;

  // Try Electron file-based backup first
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
  if (isElectron) {
    try {
      const result = await window.electronAPI.performBackup({ data, maxFiles });
      localStorage.setItem('study_last_backup_time', Date.now().toString());
      updateBackupHints();
      return;
    } catch (e) {
      console.warn('[Backup] Electron backup failed, falling back to localStorage:', e);
    }
  }

  // 手机端（浏览器/PWA）：优先存 IndexedDB（容量大，可存含大 AI 对话/记忆的完整备份，
  // 类似电脑文件备份）；IndexedDB 不可用时降级到 localStorage。
  if (typeof BackupIDB !== 'undefined' && BackupIDB.save) {
    try {
      await BackupIDB.save(data);
      await BackupIDB.cleanup(maxFiles);
      localStorage.setItem('study_last_backup_time', Date.now().toString());
      updateBackupHints();
      return;
    } catch (e) {
      console.warn('[Backup] IndexedDB backup failed, falling back to localStorage:', e);
    }
  }

  // Fallback: store in localStorage (browser mode)
  const backups = JSON.parse(localStorage.getItem('study_backups') || '[]');
  backups.push({ time: new Date().toISOString(), data: data });
  if (backups.length > maxFiles) backups.splice(0, backups.length - maxFiles);
  localStorage.setItem('study_backups', JSON.stringify(backups));
  localStorage.setItem('study_last_backup_time', Date.now().toString());
  updateBackupHints();
}

function restartBackupTimer(minutes) {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
  if (minutes > 0) {
    backupTimer = setInterval(performAutoBackup, minutes * 60 * 1000);
    // Also do a backup immediately if never done
    if (!localStorage.getItem('study_last_backup_time')) {
      setTimeout(performAutoBackup, 5000);
    }
  }
}

async function updateBackupHints() {
  const lastTime = localStorage.getItem('study_last_backup_time');
  const hint = document.getElementById('backupTimeHint');
  if (!hint) return;

  let fileCount = 0;
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
  if (isElectron) {
    try {
      const files = await window.electronAPI.listBackups();
      fileCount = files.length;
    } catch (e) {}
  } else {
    // 手机端优先统计 IndexedDB 完整备份，其次 localStorage 降级备份
    if (typeof BackupIDB !== 'undefined' && BackupIDB.count) {
      try { fileCount = await BackupIDB.count(); }
      catch (e) { fileCount = 0; }
    }
    if (fileCount === 0) {
      const localBackups = JSON.parse(localStorage.getItem('study_backups') || '[]');
      fileCount = localBackups.length;
    }
  }

  if (lastTime) {
    const d = new Date(parseInt(lastTime));
    hint.textContent = '上次备份：' + d.toLocaleString('zh-CN') + '（共 ' + fileCount + ' 份）';
  } else {
    hint.textContent = '上次备份：—';
  }
}

// ═══════════ Backup Export & Directory ═══════════
async function exportAllBackups() {
  // In Electron: use file-based backups
  if (window.electronAPI && window.electronAPI.listBackups) {
    // Just trigger a manual backup now and show the directory
    performAutoBackup().then(() => {
      showMigrateMsg('✅ 备份已保存到备份目录', '#10b981');
      updateBackupHints();
    });
    return;
  }

  // Browser/PWA fallback：优先导出 IndexedDB 完整备份（含大 AI 对话/记忆），
  // 无 IndexedDB 备份时降级导出 localStorage 备份
  if (typeof BackupIDB !== 'undefined' && BackupIDB.list) {
    try {
      const idbList = await BackupIDB.list();
      if (idbList.length > 0) {
        const backups = [];
        for (const item of idbList) {
          const dataItem = await BackupIDB.read(item.time);
          backups.push({ time: item.time, data: dataItem });
        }
        const out = { exportedAt: new Date().toISOString(), backups, source: 'idb' };
        const fname = 'study-table-all-backups-' + new Date().toISOString().slice(0, 10) + '.json';
        downloadJsonFile(out, fname);
        showMigrateMsg('✅ 已导出 ' + backups.length + ' 份本地备份', '#10b981');
        return;
      }
    } catch (e) { console.warn('[Backup] IDB export failed:', e); }
  }
  const backupsStr = localStorage.getItem('study_backups');
  if (!backupsStr) {
    showMigrateMsg('❌ 没有备份记录', '#ef4444');
    return;
  }
  const data = { exportedAt: new Date().toISOString(), backups: JSON.parse(backupsStr) };
  const filename = 'study-table-all-backups-' + new Date().toISOString().slice(0, 10) + '.json';
  downloadJsonFile(data, filename);
  showMigrateMsg('✅ 已导出 ' + data.backups.length + ' 份备份', '#10b981');
}

async function openBackupDirectory() {
  const isElectron = !!(window.electronAPI && window.electronAPI.isElectron);
  if (isElectron) {
    try {
      await window.electronAPI.openBackupDir();
      showMigrateMsg('📂 已打开备份目录', '#6366f1');
    } catch (e) {
      showMigrateMsg('❌ 无法打开备份目录：' + e.message, '#ef4444');
    }
    return;
  }
  // 手机端（PWA）：列出并管理 IndexedDB 本地完整备份（类似电脑备份目录）
  try {
    if (typeof BackupIDB === 'undefined' || !BackupIDB.list) {
      showMigrateMsg('💡 当前环境不支持本地备份', '#f59e0b');
      return;
    }
    const list = await BackupIDB.list();
    if (!list.length) {
      showMigrateMsg('📭 还没有本地备份，点「立即备份」创建第一份', '#f59e0b');
      return;
    }
    const fmtTime = (t) => { const d = new Date(t); return d.toLocaleString('zh-CN'); };
    const fmtSize = (s) => s > 1048576 ? (s / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(s / 1024)) + ' KB';
    const rows = list.map((item) => `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 10px;border:1px solid var(--border);border-radius:9px;margin-bottom:6px;background:var(--input-bg);">
        <i data-lucide="archive" class="lucide-icon" style="width:15px;height:15px;color:var(--primary);flex-shrink:0;"></i>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;color:var(--text);">${fmtTime(item.time)}</div>
          <div style="font-size:11px;color:var(--text-secondary);">${fmtSize(item.size)}</div>
        </div>
        <button onclick="restoreIdbBackup('${item.time}')" style="border:none;background:var(--primary);color:#fff;border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;flex-shrink:0;">恢复</button>
        <button onclick="deleteIdbBackup('${item.time}')" style="border:none;background:transparent;color:var(--text-secondary);border-radius:7px;padding:5px;font-size:12px;cursor:pointer;flex-shrink:0;opacity:.7;">删除</button>
      </div>`).join('');
    const overlay = document.createElement('div');
    overlay.id = 'bkLocalBackupsOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:14px;max-width:460px;width:100%;max-height:70vh;display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border);">
          <span style="font-weight:600;color:var(--text);"><i data-lucide="archive" class="lucide-icon" style="width:15px;height:15px;vertical-align:middle;"></i> 本地备份（${list.length} 份）</span>
          <button onclick="document.getElementById('bkLocalBackupsOverlay').remove()" style="border:none;background:transparent;color:var(--text-secondary);font-size:18px;cursor:pointer;">×</button>
        </div>
        <div style="padding:12px 16px;overflow-y:auto;flex:1;">${rows}
          <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;">恢复会覆盖当前同名数据，请谨慎操作。</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined') setTimeout(() => { try { lucide.createIcons(); } catch (e) {} }, 0);
  } catch (e) {
    showMigrateMsg('❌ 无法读取本地备份：' + e.message, '#ef4444');
  }
}

// 手机端：恢复某份 IndexedDB 本地备份
async function restoreIdbBackup(time) {
  if (!confirm('确定用这份备份覆盖当前数据吗？此操作会覆盖本地同名数据。')) return;
  try {
    if (typeof BackupIDB === 'undefined' || !BackupIDB.read) return;
    const data = await BackupIDB.read(time);
    if (!data) { showMigrateMsg('❌ 备份读取失败', '#ef4444'); return; }
    let restored = 0;
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (val !== undefined && val !== null) { localStorage.setItem(key, val); restored++; }
    }
    showMigrateMsg('✅ 已恢复备份（' + restored + ' 项），刷新页面生效', '#10b981');
  } catch (e) {
    showMigrateMsg('❌ 恢复失败：' + e.message, '#ef4444');
  }
}

// 手机端：删除某份 IndexedDB 本地备份
async function deleteIdbBackup(time) {
  if (!confirm('删除这份备份？')) return;
  try {
    if (typeof BackupIDB !== 'undefined' && BackupIDB.remove) await BackupIDB.remove(time);
    showMigrateMsg('🗑 已删除', '#f59e0b');
    openBackupDirectory(); // 刷新列表
  } catch (e) {}
}

// Initialize backup on page load
(function initBackup() {
  const minutes = parseInt(localStorage.getItem('study_backup_interval')) || 0;
  if (minutes > 0) restartBackupTimer(minutes);
  updateBackupHints();
})();

function updateDebugPanel() {
  const panel = document.getElementById('debugCheckinPanel');
  const info = document.getElementById('debugCheckinInfo');
  const textarea = document.getElementById('debugCheckinDates');
  if (!panel || !info) return;
  if (isDebugMode()) {
    panel.style.display = 'block';
    const data = loadCheckinData();
    const today = getTodayStr();
    const todayTime = data.checkinTimes && data.checkinTimes[today] ? '（' + data.checkinTimes[today] + '）' : '';
    info.textContent =
      '📅 今日：' + today + '\n' +
      '🔥 连续天数：' + data.streak + '\n' +
      '📌 最近打卡：' + (data.lastDate || '无') + '\n' +
      '🔍 今日状态：' + (data.dates.includes(today) ? '已打卡 ✅' + todayTime : '未打卡 ❌') + '\n' +
      '📊 总打卡天数：' + data.dates.length;
    // Populate date textarea
    if (textarea) {
      textarea.value = data.dates.length > 0 ? [...data.dates].sort().join('\n') : '';
    }
  } else {
    panel.style.display = 'none';
  }
}

function debugSaveCheckinDates() {
  const textarea = document.getElementById('debugCheckinDates');
  if (!textarea) return;
  const raw = textarea.value.trim();
  let dates;
  if (raw === '') {
    dates = [];
  } else {
    // Support both newline and comma separators
    dates = raw.split(/[\n,]+/).map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
    dates = [...new Set(dates)].sort(); // deduplicate + sort
  }
  const data = loadCheckinData();
  data.dates = dates;
  data.streak = recalcStreak(dates);
  data.lastDate = dates.length > 0 ? dates[dates.length - 1] : null;
  saveCheckinData(data);
  // Refresh textarea with cleaned dates
  textarea.value = dates.join('\n');
  updateDebugPanel();
  renderToday();
}

function debugAddDateRange() {
  showCustomPrompt('输入日期范围（格式：开始日期,结束日期，如 2026-07-01,2026-07-10）：').then(rangeStr => {
    if (!rangeStr) return;
    const parts = rangeStr.split(',').map(s => s.trim());
    if (parts.length !== 2) { alert('请输入正确格式：开始日期,结束日期'); return; }
    const start = new Date(parts[0]);
    const end = new Date(parts[1]);
    if (isNaN(start) || isNaN(end)) { alert('日期格式无效'); return; }
    const textarea = document.getElementById('debugCheckinDates');
    if (!textarea) return;
    const existing = new Set(textarea.value.split(/[\n,]+/).map(s => s.trim()).filter(Boolean));
    const cur = new Date(start);
    while (cur <= end) {
      existing.add(cur.toISOString().slice(0, 10));
      cur.setDate(cur.getDate() + 1);
    }
    textarea.value = [...existing].sort().join('\n');
  });
}

function debugToggleCheckin() {
  const today = getTodayStr();
  const data = loadCheckinData();
  if (data.dates.includes(today)) {
    // Uncheck today
    data.dates = data.dates.filter(d => d !== today);
    // Recalculate streak
    data.streak = recalcStreak(data.dates);
    data.lastDate = data.dates.length > 0 ? data.dates[data.dates.length - 1] : null;
    saveCheckinData(data);
  } else {
    // Check today
    data.dates.push(today);
    data.dates.sort();
    data.streak = recalcStreak(data.dates);
    data.lastDate = today;
    saveCheckinData(data);
  }
  renderToday();
}

function recalcStreak(dates) {
  if (!dates || dates.length === 0) return 0;
  const sorted = [...dates].sort();
  let streak = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const curr = new Date(sorted[i]);
    const prev = new Date(sorted[i - 1]);
    const diff = (curr - prev) / (1000 * 60 * 60 * 24);
    if (Math.round(diff) === 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

function debugEditStreak() {
  const data = loadCheckinData();
  showCustomPrompt('输入新的连续打卡天数（数字）：', String(data.streak)).then(newStreak => {
  if (newStreak === null || newStreak === '') return;
  const num = parseInt(newStreak, 10);
  if (isNaN(num) || num < 0) { alert('请输入有效的数字'); return; }
  data.streak = num;
  // If streak is 0, clear dates
  if (num === 0) {
    data.dates = [];
    data.lastDate = null;
  }
  saveCheckinData(data);
  renderToday();
  });
}

function debugResetCheckin() {
  showCustomConfirm('确定要重置本周打卡数据吗？此操作不可撤销。', { dontAskKey: 'study_dontask_reset_checkin' }).then(confirmed => {
    if (!confirmed) return;
    localStorage.setItem('study_checkin', JSON.stringify({ dates: [], streak: 0, lastDate: null }));
    renderToday();
  });
}

async function debugTriggerReport() {
  const apiCfg = getEffectiveReportApiConfig();
  if (!apiCfg.apiKey) { alert('请先设置日报 API Key（设置 → 更多设置 → 日报 Key）'); return; }
  // Ensure today is checked in before generating report
  const today = getTodayStr();
  const data = loadCheckinData();
  if (!data.dates.includes(today)) {
    data.dates.push(today);
    data.dates.sort();
    data.streak = recalcStreak(data.dates);
    data.lastDate = today;
    saveCheckinData(data);
    renderToday();
  }
  // force=true：手动生成不受晨间日报开关影响
  const r = await generateDailyReport(true);
  if (r && r.ok) alert('☀️ 晨间日报已生成，请在「☀️ 晨间日报」对话中查看');
  else alert('晨间日报生成失败：' + (r && r.error ? r.error : '未知错误'));
}


function doDailyCheckin() {
  const today = getTodayStr();
  const data = loadCheckinData();
  if (data.dates.includes(today)) return;

  // Record checkin time
  const now = new Date();
  const timeStr = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  if (!data.checkinTimes) data.checkinTimes = {};
  data.checkinTimes[today] = timeStr;

  data.dates.push(today);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');
  if (data.lastDate === yesterdayStr) {
    data.streak += 1;
  } else if (data.lastDate !== today) {
    data.streak = 1;
  }
  data.lastDate = today;
  saveCheckinData(data);

  const quote = MOTIVATIONAL_QUOTES[Math.floor(Math.random() * MOTIVATIONAL_QUOTES.length)];
  document.getElementById('checkinQuoteEmoji').textContent = quote.emoji;
  document.getElementById('checkinQuoteStreak').textContent = '🔥 已连续打卡 ' + data.streak + ' 天';
  document.getElementById('checkinQuoteText').textContent = quote.text;
  document.getElementById('checkinQuoteOverlay').classList.add('open');

  renderToday();

  // Auto-generate daily report via AI (respect morning report toggle)
  const morningCfg = JSON.parse(localStorage.getItem('study_morning_cfg') || '{"enabled":true}');
  if (morningCfg.enabled !== false) {
    generateDailyReport();
  }
}

// Get or create the daily report conversation
function getDailyReportConv() {
  // 优先按标记查找；若标记因历史保存降级清理而丢失，再按标题兜底（日报对话唯一，防止重复新建）
  let conv = aiConvs.find(c => c._dailyReport)
    || aiConvs.find(c => c.title === '📋 每日日报' || c.title === '☀️ 晨间日报');
  if (!conv) {
    conv = {
      id: genId(),
      title: '📋 每日日报',
      systemPrompt: '',
      messages: [],
      autoTitled: true,
      _dailyReport: true
    };
    if (typeof initTreeOnConv === 'function') initTreeOnConv(conv);
    aiConvs.push(conv);
    saveData('study_ai_convs', aiConvs);
  } else {
    // 回填标记 + 统一标题（防止后续标记丢失或标题被自动生成覆盖），仅在确实有变化时保存
    let changed = false;
    if (!conv._dailyReport) { conv._dailyReport = true; changed = true; }
    if (conv.title !== '📋 每日日报') {
      conv.title = '📋 每日日报';
      conv.autoTitled = true;
      changed = true;
    }
    if (changed) saveData('study_ai_convs', aiConvs);
  }
  return conv;
}

// ── Helper: get date string for N days ago ──
function getPastDateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ── Helper: collect yesterday's data for the daily report ──
function collectDailyReportData() {
  const todayStr = getTodayStr();
  const yesterdayStr = getPastDateStr(1);

  // Checkin data
  const checkinData = loadCheckinData();

  // Focus data — when user checks in, the focus items are likely still from yesterday
  const focusData = getTodayFocusItems();
  const focusItems = focusData.items || [];

  // Todos: yesterday's completions vs today's due items vs overdue
  const yesterdayDone = todos.filter(t => t.completedAt === yesterdayStr);
  const todayDue = todos.filter(t => t.dueDate === todayStr && !t.done);
  const overdue = todos.filter(t => t.dueDate && t.dueDate < todayStr && !t.done);

  // All undone todos (for today's planning)
  const undoneTodos = todos.filter(t => !t.done);

  // Yesterday's notes
  const ydayNotes = notes.filter(n => {
    if (!n.updatedAt) return false;
    const d = new Date(n.updatedAt);
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return ds === yesterdayStr;
  });

  // Timer records for yesterday — with session details
  let ydayTimerMs = 0;
  const ydayTimerSessions = []; // [{ timeRange, duration, targetName }]
  function formatTimeOnly(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  }
  function fmtTimer(ms) {
    if (ms < 60000) return '< 1 分钟';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h} 小时 ${m} 分钟`;
    return `${m} 分钟`;
  }
  try {
    const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    for (const r of records) {
      if (r.date === yesterdayStr) {
        ydayTimerMs += r.totalMs || 0;
        // Collect session details
        if (r.sessions && r.sessions.length > 0) {
          const targetId = r.targetId || r.todoId;
          const targetType = r.targetType || 'todo';
          let targetName = '(已删除)';
          if (targetType === 'goal') {
            const g = loadGoals().find(g => g.id === targetId);
            if (g) targetName = '🎯 ' + g.text;
          } else {
            const t = todos.find(t => t.id === targetId);
            if (t) targetName = '📋 ' + t.text;
          }
          for (const s of r.sessions) {
            const startStr = formatTimeOnly(s.start);
            const endStr = formatTimeOnly(s.end);
            const dur = s.end - s.start;
            ydayTimerSessions.push({ timeRange: `${startStr} — ${endStr}`, duration: fmtTimer(dur), targetName });
          }
        } else {
          // Record without session breakdown (e.g. debug mode)
          const targetId = r.targetId || r.todoId;
          const targetType = r.targetType || 'todo';
          let targetName = '(已删除)';
          if (targetType === 'goal') {
            const g = loadGoals().find(g => g.id === targetId);
            if (g) targetName = '🎯 ' + g.text;
          } else {
            const t = todos.find(t => t.id === targetId);
            if (t) targetName = '📋 ' + t.text;
          }
          ydayTimerSessions.push({ timeRange: '全天', duration: fmtTimer(r.totalMs || 0), targetName });
        }
      }
    }
    // Sort sessions by start time
    ydayTimerSessions.sort((a, b) => a.timeRange.localeCompare(b.timeRange));
  } catch {}

  // 任务线数据（GTNH 式任务书）
  let taskline = null;
  if (typeof loadTaskLineStore === 'function' && typeof tlMainLineUnlocked === 'function') {
    try {
      const tlStore = loadTaskLineStore();
      if (tlStore.lines.length > 0) {
        const mains = tlStore.lines.filter(l => l.type === 'main').sort((a, b) => (a.sort || 0) - (b.sort || 0));
        const cur = mains.find(l => {
          if (!tlMainLineUnlocked(tlStore, l)) return false;
          const lqs = tlStore.quests.filter(q => q.lineId === l.id);
          if (lqs.length === 0) return true;
          return !lqs.every(q => q.status === 'done');
        }) || mains[mains.length - 1] || null;
        const active = tlStore.quests.filter(q => q.status === 'active');
        const ydayDoneQuests = tlStore.quests.filter(q => q.status === 'done' && q.completedAt === yesterdayStr);
        taskline = {
          initialized: true,
          currentMain: cur ? cur.name : (mains.length ? mains[mains.length - 1].name : null),
          mainProgress: cur ? (() => {
            const qs = tlStore.quests.filter(q => q.lineId === cur.id);
            if (qs.length === 0) return null;
            const done = qs.filter(q => q.status === 'done' || q.status === 'skipped').length;
            return Math.round(done / qs.length * 100);
          })() : null,
          activeCount: active.length,
          activeNames: active.slice(0, 5).map(q => q.title),
          ydayDone: ydayDoneQuests.map(q => q.title),
          doneCount: tlStore.quests.filter(q => q.status === 'done').length
        };
      }
    } catch (e) { taskline = null; }
  }

  // Previous daily report for context continuity
  const prevConv = getDailyReportConv();
  const prevReport = prevConv && prevConv.messages.length >= 2
    ? prevConv.messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || null
    : null;

  return {
    todayStr,
    yesterdayStr,
    streak: checkinData.streak || 0,
    todayCheckinTime: checkinData.checkinTimes && checkinData.checkinTimes[todayStr] || null,
    focusItems,
    focusDone: focusItems.filter(i => i.done).length,
    focusTotal: focusItems.length,
    yesterdayDoneTodos: yesterdayDone.map(t => ({ text: t.text, id: t.id })),
    todayDueTodos: todayDue.map(t => ({ text: t.text, id: t.id })),
    overdueTodos: overdue.map(t => ({ text: t.text, dueDate: t.dueDate, id: t.id })),
    undoneTodos: undoneTodos.map(t => ({ text: t.text, id: t.id, dueDate: t.dueDate, tags: t.tags })),
    totalTodos: todos.length,
    totalDone: todos.filter(t => t.done).length,
    taskline,
    ydayNotes: ydayNotes.map(n => ({ title: n.title || '未命名', id: n.id })),
    ydayTimerStr: ydayTimerMs > 0 ? fmtTimer(ydayTimerMs) : '无',
    ydayTimerSessions,
    prevReport,
    isCheckedInToday: checkinData.dates.includes(todayStr),
    // Review data（getNotesDueForReview 返回 {note, reviewCount, nextReviewDate} 包装对象，须解包 .note）
    reviewDueCount: typeof getNotesDueForReview === 'function' ? getNotesDueForReview().length : 0,
    reviewDueNotes: typeof getNotesDueForReview === 'function'
      ? getNotesDueForReview().map(d => {
          const n = d.note;
          const nextStr = (typeof toLocalDateStr === 'function' && d.nextReviewDate) ? toLocalDateStr(d.nextReviewDate) : '';
          const overdueDays = (nextStr && nextStr < todayStr)
            ? Math.max(0, Math.round((new Date(todayStr).getTime() - new Date(nextStr).getTime()) / 86400000))
            : 0;
          return {
            id: n.id, title: n.title || '未命名',
            reviewCount: d.reviewCount, // 已完成复习轮数
            overdueDays
          };
        })
      : [],
    overdueReviewCount: typeof getNotesDueForReview === 'function'
      ? getNotesDueForReview().filter(d => {
          const nextStr = (typeof toLocalDateStr === 'function' && d.nextReviewDate) ? toLocalDateStr(d.nextReviewDate) : '';
          return nextStr && nextStr < todayStr;
        }).length
      : 0,
    notesWithReviewHistory: typeof getNotesDueForReview === 'function'
      ? (() => {
          try {
            const allNotes = loadNotes();
            return allNotes.filter(n => n.type === 'note' && n._reviewHistory && n._reviewHistory.length > 0).length;
          } catch { return 0; }
        })()
      : 0,
    totalNotes: typeof getNotesDueForReview === 'function' ? (() => {
      try { return (typeof notes !== 'undefined' && Array.isArray(notes) ? notes : []).filter(n => n.type === 'note' && n.content && n.content.trim()).length; }
      catch { return 0; }
    })() : 0,

    // Habits data（早间日报回顾的是昨天：用 yesterdayStr，并标注昨日）
    habitsOverview: typeof loadHabits === 'function' ? (() => {
      try {
        const h = loadHabits();
        return h.map(habit => {
          const dayCount = (habit.checkins && habit.checkins[yesterdayStr]) ? habit.checkins[yesterdayStr] : 0;
          const dayMet = dayCount >= (habit.dailyTarget || 1);
          // calcStreak 返回 { streak, bestStreak, todayCount, todayMet, target }
          const streak = (typeof calcStreak === 'function') ? (calcStreak(habit).streak || 0) : 0;
          return {
            name: habit.name,
            emoji: habit.emoji || '',
            dayCount,
            dailyTarget: habit.dailyTarget || 1,
            dayMet,
            streak
          };
        });
      } catch { return []; }
    })() : [],
    habitsCount: typeof loadHabits === 'function' ? (() => {
      try { return loadHabits().length; } catch { return 0; }
    })() : 0,
    habitsDoneYesterday: typeof loadHabits === 'function' ? (() => {
      try {
        return loadHabits().filter(h => {
          const c = (h.checkins && h.checkins[yesterdayStr]) ? h.checkins[yesterdayStr] : 0;
          return c >= (h.dailyTarget || 1);
        }).length;
      } catch { return 0; }
    })() : 0
  };
}

// ═══════════ 全局轻提示（自消失 toast）═══════════
let _miniToastTimer = null;
function showMiniToast(msg, type, persist) {
  let el = document.getElementById('appMiniToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'appMiniToast';
    el.className = 'mini-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'mini-toast show' + (type === 'error' ? ' error' : type === 'info' ? ' info' : '');
  if (persist) {
    // 保持常驻（如"正在生成日报…"），直到下次 showMiniToast 覆盖才切换/消失
    clearTimeout(_miniToastTimer);
    _miniToastTimer = null;
    return;
  }
  clearTimeout(_miniToastTimer);
  _miniToastTimer = setTimeout(() => { el.className = 'mini-toast'; }, 2600);
}

// Auto-generate daily report after check-in (morning review style)
// 返回 { ok, error }：手动触发（debugTriggerReport）可 force=true 绕过晨间开关
async function generateDailyReport(force) {
  const apiCfg = getEffectiveReportApiConfig();
  if (!apiCfg.apiKey) return { ok: false, error: '未配置日报 API Key（设置 → 更多设置 → 日报 Key）' };

  // 自动触发受开关控制；手动触发（force=true）始终生成
  const morningCfg = JSON.parse(localStorage.getItem('study_morning_cfg') || '{"enabled":true}');
  if (!morningCfg.enabled && !force) return { ok: false, error: '晨间日报已关闭（可在 设置 → 更多设置 中开启）' };

  const conv = getDailyReportConv();
  const data = collectDailyReportData();

  // ── Build a guided, flexible prompt ──
  // Focus on YESTERDAY's review + TODAY's direction
  const focusLines = data.focusItems.length > 0
    ? data.focusItems.map(f => `  - ${f.done ? '✅' : '⬜'} ${f.text}`).join('\n')
    : '  （昨日未设置聚焦任务）';

  const doneTodoLines = data.yesterdayDoneTodos.length > 0
    ? data.yesterdayDoneTodos.map(t => `  - ✅ ${t.text}`).join('\n')
    : '  （昨日没有完成的待办）';

  const overdueLines = data.overdueTodos.length > 0
    ? data.overdueTodos.map(t => `  - ⏰ ${t.text}（原定 ${t.dueDate}）`).join('\n')
    : '  无';

  const todayDueLines = data.todayDueTodos.length > 0
    ? data.todayDueTodos.map(t => `  - 📅 ${t.text}`).join('\n')
    : '  无';

  const undoneLines = data.undoneTodos.length > 0
    ? data.undoneTodos.slice(0, 15).map(t => {
        const info = [t.dueDate ? `📅${t.dueDate}` : '', t.tags?.length ? t.tags.join(',') : ''].filter(Boolean).join(' ');
        return `  - ${t.text}${info ? '（' + info + '）' : ''}`;
      }).join('\n')
    : '  无';

  const noteLines = data.ydayNotes.length > 0
    ? data.ydayNotes.map(n => `  - 📝 ${n.title}`).join('\n')
    : '  无';

  const prevReportBlock = data.prevReport
    ? `\n📋 昨日日报回顾（上次日报的结尾部分供参考）：\n\`\`\`\n${data.prevReport.slice(0, 500)}\n\`\`\``
    : '';

  const reportPrompt = `☀️ 晨间回顾 — ${data.todayStr}

新的一天开始了！基于以下数据，请帮我生成一份轻松、有洞察力的晨间日报，帮助我回顾昨天、开启今天。

---

📊 **数据一览**

【连续打卡】${data.streak} 天
【昨日聚焦】${data.focusDone}/${data.focusTotal} 完成
${focusLines}
【昨日完成待办】${data.yesterdayDoneTodos.length} 项
${doneTodoLines}
【昨日计时】${data.ydayTimerStr}
${data.ydayTimerSessions.length > 0 ? data.ydayTimerSessions.map(s => `  - ${s.timeRange}  ${s.duration}  ${s.targetName}`).join('\n') : ''}
【逾期未完成】${data.overdueTodos.length} 项
${overdueLines}
【今日截止】${data.todayDueTodos.length} 项
${todayDueLines}
【全局待办】${data.totalDone}/${data.totalTodos} 已完成
【昨日笔记】${data.ydayNotes.length} 篇
${noteLines}
【复习状态】${data.notesWithReviewHistory}/${data.totalNotes} 篇笔记参与间隔复习
${data.reviewDueNotes.length > 0
  ? data.reviewDueNotes.map(n => {
      const stage = n.reviewCount === 0 ? '📌 首次待复习' : `第${n.reviewCount + 1}轮`;
      const overdue = n.overdueDays > 0 ? ` ⚠️逾期${n.overdueDays}天` : '';
      return `  - 📖 ${n.title}（${stage}${overdue}）`;
    }).join('\n')
  : '  （暂无待复习笔记）'}
${data.overdueReviewCount > 0 ? `⚠️ 其中 ${data.overdueReviewCount} 篇已逾期` : ''}
【昨日习惯】（昨日完成情况）${data.habitsDoneYesterday}/${data.habitsCount} 已完成
${data.habitsOverview.length > 0
  ? data.habitsOverview.map(h => {
      const status = h.dayMet ? '✓' : '○';
      const detail = h.dayMet ? `昨日已完成(${h.dayCount}/${h.dailyTarget})` : `昨日未完成(${h.dayCount}/${h.dailyTarget})`;
      return `  - ${status} ${h.emoji} ${h.name} — ${detail}，连续 ${h.streak} 天`;
    }).join('\n')
  : '  （暂无习惯）'}
${data.taskline ? `【任务线】已完成 ${data.taskline.doneCount} 个任务｜主线「${data.taskline.currentMain || '未创建'}」${data.taskline.mainProgress !== null ? '进度 ' + data.taskline.mainProgress + '%' : '（暂无任务）'}
  - 激活任务 ${data.taskline.activeCount} 个${data.taskline.activeNames.length > 0 ? '：' + data.taskline.activeNames.join('、') : ''}
  ${data.taskline.ydayDone.length > 0 ? '- 昨日完成任务：' + data.taskline.ydayDone.join('、') : ''}` : ''}${prevReportBlock}

---

💡 **你可以自由发挥，但建议包含以下方向（不必全部覆盖，选择你觉得有启发的）：**

1. **📅 昨日回顾** — 昨天整体怎么样？聚焦完成情况如何？有什么亮点或值得注意的模式？
2. **✅ 昨日完成清单** — 列出昨天完成的待办（如有），给个简单的小总结
3. **⚠️ 逾期提醒** — 有哪些任务逾期了？是否还在乎它们？建议优先处理还是重新规划？
4. **📝 笔记回顾** — 昨天写的笔记有什么值得今天延续的思路？
5. **🎯 今日方向** — 今天截止的任务有哪些？基于昨日状态，今天最值得优先做什么？
6. **🧠 复习习惯** — 待复习笔记的状态如何？是否有逾期未复习的？复习频率和节奏是否健康？是否需要调整复习策略？
7. **💡 日常习惯** — 昨天哪些习惯完成了？哪些习惯掉链子了？有没有连续坚持很棒的？是否注意到什么模式？
8. **🗺️ 任务线推进** — 当前主线章节与激活任务进展如何？昨日完成了任务线里的哪些任务？今天建议优先推进哪个任务线目标（可生成对应待办）？
9. **💪 一句话鼓励** — 给我一句适合今天状态的鼓励

格式自由，语气自然、清醒、有方向感。用 Markdown 但不要太刻板。`;

  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  showMiniToast('☀️ 正在生成晨间日报…', 'info', true);
  try {
    if (typeof callAiApi !== 'function') {
      showMiniToast('晨间日报生成失败：AI 模块未就绪', 'error');
      return { ok: false, error: 'AI 模块未就绪，请重启应用' };
    }
    // 复用手动发送同款 API 调用（callAiApi）：自动带上 deepThink 参数（Kimi/DeepSeek 默认思考开启，
    // 裸 fetch 未显式禁用会把 max_tokens 全部耗在 reasoning 上 → content 为空）；并处理
    // Kimi 的 max_tokens 命名 / temperature 跳过 / reasoning_content 提取。
    const apiMessages = [
      { role: 'system', content: '你是用户的学习伙伴，在每天早上打卡后生成一份晨间日报。你的角色是：清醒、温暖、有洞察力。\n\n当前时间：' + new Date().toLocaleString('zh-CN') + '\n\n═══ 系统模块概览 ═══\n1. 📋 待办管理：多层级父子任务、截止日期、标签\n2. 🎯 今日聚焦：每天最多3个聚焦任务\n3. 📝 笔记管理：Markdown 编辑、文件夹分类、间隔复习\n4. ⏱️ 计时器：专注计时、关联待办/目标\n5. 📅 日历视图：当月日程、截止日期、完成记录\n6. 🎯 习惯追踪：每日/每周打卡、进度条、热力图\n7. 📊 统计仪表盘：待办趋势、专注时长、习惯完成率图表\n8. 🤖 AI 助手：多对话、工具调用、长期记忆、网络搜索\n9. 🗺️ 任务线：人生主线（阶段推进）+ 素质线（并行成长）双轴章节，AI 生成任务、前置依赖解锁、条件绑定待办/笔记/计时、徽章+自定义奖励池\n\n═══ 你的任务 ═══\n帮助用户回顾昨天（完成/未完成/模式发现），并开启今天（优先级/方向/心态）。你也关注用户的复习习惯（笔记的间隔重复复习是知识内化的关键，逾期复习会降低记忆效果）和日常习惯（坚持频率、有无掉链子、模式洞察）。不要罗列所有数据，而是挑最有意义的说。用 Markdown 但语气自然，像朋友聊天一样有温度。' + (typeof formatMemoryForPrompt === 'function' ? formatMemoryForPrompt() : '') },
      ...conv.messages.slice(-20),
      { role: 'user', content: reportPrompt }
    ];
    const { cleanText, reasoning, finishReason } = await callAiApi(apiMessages, apiCfg, null);
    const report = (cleanText || '').trim();
    if (report) {
      appendMessage(conv, { role: 'user', content: '生成 ' + data.todayStr + ' 晨间日报' });
      appendMessage(conv, { role: 'assistant', content: report, keyName: getActiveKeyDisplayName() });
      // Keep only last 30 messages to avoid bloating
      trimConvMessages(conv, 30);
      saveData('study_ai_convs', aiConvs);
      // Refresh AI chat if user is viewing the report conversation
      if (activeConvId === conv.id) {
        renderAiChat();
      }
      // Send Windows notification
      sendNotification('📋 晨间日报已生成', '你的 ' + data.todayStr + ' 晨间回顾已就绪 ☀️', 'daily-report');
      showMiniToast('☀️ 晨间日报已生成');
      return { ok: true };
    }
    if (finishReason === 'length') {
      showMiniToast('晨间日报生成失败：回复被截断（max_tokens 不足），请重试或调大 max_tokens', 'error');
      return { ok: false, error: '回复被截断（max_tokens 不足），请重试或调大 max_tokens' };
    }
    if (reasoning) {
      showMiniToast('晨间日报生成失败：模型仅返回思考内容，请关闭深度思考后重试', 'error');
      return { ok: false, error: '模型仅返回了思考内容（无正文），请关闭深度思考后重试' };
    }
    showMiniToast('晨间日报生成失败：AI 返回了空内容', 'error');
    return { ok: false, error: 'AI 返回了空内容，请重试' };
  } catch (e) {
    console.error('[日报] 生成失败:', e);
    // Show a non-intrusive status update if possible
    try {
      const debugEl = document.getElementById('debugStatus');
      if (debugEl) { debugEl.textContent = '日报生成失败: ' + (e.message || e); debugEl.className = 'settings-status'; }
    } catch {}
    showMiniToast('晨间日报生成失败：' + ((e && e.message) || String(e)), 'error');
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

// ═══════════ Evening Daily Report ═══════════

let eveningReportInProgress = false;

function loadEveningReportCfg() {
  try {
    return JSON.parse(localStorage.getItem('study_evening_report_cfg') || '{"enabled":false,"time":"21:00"}');
  } catch { return { enabled: false, time: '21:00' }; }
}

function saveEveningReportCfg(cfg) {
  localStorage.setItem('study_evening_report_cfg', JSON.stringify(cfg));
}

function loadEveningReportLog() {
  try {
    return JSON.parse(localStorage.getItem('study_evening_report_log') || '{"lastDate":null}');
  } catch { return { lastDate: null }; }
}

function markEveningReportDone(dateStr) {
  localStorage.setItem('study_evening_report_log', JSON.stringify({ lastDate: dateStr }));
}

async function checkEveningReport() {
  if (eveningReportInProgress) return; // prevent concurrent API calls
  const cfg = loadEveningReportCfg();
  if (!cfg.enabled) return;

  const now = getNowHHMM();
  if (now < cfg.time) return;

  const today = getTodayStr();
  const log = loadEveningReportLog();
  if (log.lastDate === today) return; // already generated today

  const apiCfg = getEffectiveReportApiConfig();
  if (!apiCfg.apiKey) return;

  eveningReportInProgress = true;
  try {
    await generateEveningReport();
  } finally {
    eveningReportInProgress = false;
  }
}

// Collect TODAY's data for the evening report
function collectEveningReportData() {
  const todayStr = getTodayStr();
  const tomorrowStr = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  })();

  // Checkin data
  const checkinData = loadCheckinData();
  const todayCheckinTime = checkinData.checkinTimes && checkinData.checkinTimes[todayStr] || null;

  // Focus items
  const focusData = getTodayFocusItems();
  const focusItems = focusData.items || [];

  // Todos: today's completions, today's due, overdue, tomorrow's due
  const todayDone = todos.filter(t => t.completedAt === todayStr);
  const todayDue = todos.filter(t => t.dueDate === todayStr && !t.done);
  const overdue = todos.filter(t => t.dueDate && t.dueDate < todayStr && !t.done);
  const tomorrowDue = todos.filter(t => t.dueDate === tomorrowStr && !t.done);
  const undoneTodos = todos.filter(t => !t.done);
  const totalTodos = todos.length;
  const totalDone = todos.filter(t => t.done).length;

  // Today's notes
  const todayNotes = notes.filter(n => {
    if (!n.updatedAt) return false;
    const d = new Date(n.updatedAt);
    const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return ds === todayStr;
  });

  // Timer records for today
  let todayTimerMs = 0;
  const todayTimerSessions = [];
  function fmtTimeOnly(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function fmtDuration(ms) {
    if (ms < 60000) return '< 1 分钟';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    if (h > 0) return `${h} 小时 ${m} 分钟`;
    return `${m} 分钟`;
  }
  try {
    const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    for (const r of records) {
      if (r.date === todayStr) {
        todayTimerMs += r.totalMs || 0;
        if (r.sessions && r.sessions.length > 0) {
          const targetId = r.targetId || r.todoId;
          const targetType = r.targetType || 'todo';
          let targetName = '(已删除)';
          if (targetType === 'goal') {
            const g = loadGoals().find(g => g.id === targetId);
            if (g) targetName = '🎯 ' + g.text;
          } else {
            const t = todos.find(t => t.id === targetId);
            if (t) targetName = '📋 ' + t.text;
          }
          for (const s of r.sessions) {
            const startStr = fmtTimeOnly(s.start);
            const endStr = fmtTimeOnly(s.end);
            const dur = s.end - s.start;
            todayTimerSessions.push({ timeRange: `${startStr} — ${endStr}`, duration: fmtDuration(dur), targetName });
          }
        } else {
          const targetId = r.targetId || r.todoId;
          const targetType = r.targetType || 'todo';
          let targetName = '(已删除)';
          if (targetType === 'goal') {
            const g = loadGoals().find(g => g.id === targetId);
            if (g) targetName = '🎯 ' + g.text;
          } else {
            const t = todos.find(t => t.id === targetId);
            if (t) targetName = '📋 ' + t.text;
          }
          todayTimerSessions.push({ timeRange: '全天', duration: fmtDuration(r.totalMs || 0), targetName });
        }
      }
    }
    todayTimerSessions.sort((a, b) => a.timeRange.localeCompare(b.timeRange));
  } catch {}

  // Morning report for context
  const prevConv = getDailyReportConv();
  const prevReport = prevConv && prevConv.messages.length >= 2
    ? prevConv.messages.filter(m => m.role === 'assistant').slice(-1)[0]?.content || null
    : null;

  return {
    todayStr,
    tomorrowStr,
    streak: checkinData.streak || 0,
    isCheckedIn: checkinData.dates.includes(todayStr),
    todayCheckinTime,
    focusItems,
    focusDone: focusItems.filter(i => i.done).length,
    focusTotal: focusItems.length,
    todayDoneTodos: todayDone.map(t => ({ text: t.text, id: t.id })),
    todayDueTodos: todayDue.map(t => ({ text: t.text, id: t.id })),
    overdueTodos: overdue.map(t => ({ text: t.text, dueDate: t.dueDate, id: t.id })),
    tomorrowDueTodos: tomorrowDue.map(t => ({ text: t.text, id: t.id })),
    undoneTodos: undoneTodos.map(t => ({ text: t.text, id: t.id, dueDate: t.dueDate, tags: t.tags })),
    totalTodos,
    totalDone,
    todayNotes: todayNotes.map(n => ({ title: n.title || '未命名', id: n.id })),
    todayTimerStr: todayTimerMs > 0 ? fmtDuration(todayTimerMs) : '无',
    todayTimerSessions,
    prevReport,
    // Review data（getNotesDueForReview 返回 {note, reviewCount, nextReviewDate} 包装对象，须解包 .note）
    reviewDueCount: typeof getNotesDueForReview === 'function' ? getNotesDueForReview().length : 0,
    reviewDueNotes: typeof getNotesDueForReview === 'function'
      ? getNotesDueForReview().map(d => {
          const n = d.note;
          const nextStr = (typeof toLocalDateStr === 'function' && d.nextReviewDate) ? toLocalDateStr(d.nextReviewDate) : '';
          const overdueDays = (nextStr && nextStr < todayStr)
            ? Math.max(0, Math.round((new Date(todayStr).getTime() - new Date(nextStr).getTime()) / 86400000))
            : 0;
          return {
            id: n.id, title: n.title || '未命名',
            reviewCount: d.reviewCount,
            overdueDays
          };
        })
      : [],
    overrideReviewCount: typeof getNotesDueForReview === 'function'
      ? getNotesDueForReview().filter(d => {
          const nextStr = (typeof toLocalDateStr === 'function' && d.nextReviewDate) ? toLocalDateStr(d.nextReviewDate) : '';
          return nextStr && nextStr < todayStr;
        }).length
      : 0,
    // Habits data
    habitsOverview: typeof loadHabits === 'function' ? (() => {
      try {
        const h = loadHabits();
        return h.map(habit => {
          const todayCount = (habit.checkins && habit.checkins[todayStr]) ? habit.checkins[todayStr] : 0;
          const todayMet = todayCount >= (habit.dailyTarget || 1);
          const streak = (typeof calcStreak === 'function') ? (calcStreak(habit).streak || 0) : 0;
          return { name: habit.name, emoji: habit.emoji || '', todayCount, dailyTarget: habit.dailyTarget || 1, todayMet, streak };
        });
      } catch { return []; }
    })() : [],
    habitsCount: typeof loadHabits === 'function' ? (() => {
      try { return loadHabits().length; } catch { return 0; }
    })() : 0,
    habitsDoneToday: typeof loadHabits === 'function' ? (() => {
      try {
        const todayStr = getTodayStr();
        return loadHabits().filter(h => {
          const c = (h.checkins && h.checkins[todayStr]) ? h.checkins[todayStr] : 0;
          return c >= (h.dailyTarget || 1);
        }).length;
      } catch { return 0; }
    })() : 0
  };
}

async function generateEveningReport() {
  const apiCfg = getEffectiveReportApiConfig();
  if (!apiCfg.apiKey) return { ok: false, error: '未配置日报 API Key（设置 → 更多设置 → 日报 Key）' };

  const conv = getDailyReportConv();
  const data = collectEveningReportData();

  // Build prompt lines
  const focusLines = data.focusItems.length > 0
    ? data.focusItems.map(f => `  - ${f.done ? '✅' : '⬜'} ${f.text}`).join('\n')
    : '  （今日未设置聚焦任务）';

  const doneTodoLines = data.todayDoneTodos.length > 0
    ? data.todayDoneTodos.map(t => `  - ✅ ${t.text}`).join('\n')
    : '  （今天还没有完成待办）';

  const dueLines = data.todayDueTodos.length > 0
    ? data.todayDueTodos.map(t => `  - 📅 ${t.text}`).join('\n')
    : '  无';

  const overdueLines = data.overdueTodos.length > 0
    ? data.overdueTodos.map(t => `  - ⚠️ ${t.text}（原定 ${t.dueDate}）`).join('\n')
    : '  无';

  const tomorrowLines = data.tomorrowDueTodos.length > 0
    ? data.tomorrowDueTodos.map(t => `  - 📅 ${t.text}`).join('\n')
    : '  无';

  const undoneLines = data.undoneTodos.length > 0
    ? data.undoneTodos.slice(0, 12).map(t => {
        const info = [t.dueDate ? `📅${t.dueDate}` : '', t.tags?.length ? t.tags.join(',') : ''].filter(Boolean).join(' ');
        return `  - ${t.text}${info ? '（' + info + '）' : ''}`;
      }).join('\n')
    : '  无';

  const noteLines = data.todayNotes.length > 0
    ? data.todayNotes.map(n => `  - 📝 ${n.title}`).join('\n')
    : '  无';

  const prevReportBlock = data.prevReport
    ? `\n📋 今早晨间回顾（供上下文参考）：\n\`\`\`\n${data.prevReport.slice(0, 300)}\n\`\`\``
    : '';

  const reportPrompt = `🌙 晚间回顾 — ${data.todayStr}

一天结束了！基于以下数据，请帮我生成一份温暖、有洞察力的晚间日报，帮我总结今天、沉淀收获。

---

📊 **今日数据一览**

【连续打卡】${data.streak} 天${data.todayCheckinTime ? '（今日打卡 ' + data.todayCheckinTime + '）' : ''}
【今日聚焦】${data.focusDone}/${data.focusTotal} 完成
${focusLines}
【今日完成待办】${data.todayDoneTodos.length} 项
${doneTodoLines}
【今日截止】${data.todayDueTodos.length} 项
${dueLines}
【今日计时】${data.todayTimerStr}
${data.todayTimerSessions.length > 0 ? data.todayTimerSessions.map(s => `  - ${s.timeRange}  ${s.duration}  ${s.targetName}`).join('\n') : ''}
【逾期未完成】${data.overdueTodos.length} 项
${overdueLines}
【明天截止】${data.tomorrowDueTodos.length} 项
${tomorrowLines}
【全局待办】${data.totalDone}/${data.totalTodos} 已完成，剩余 ${data.undoneTodos.length} 项
【今日笔记】${data.todayNotes.length} 篇
${noteLines}
【复习状态】${data.reviewDueNotes.length > 0 ? '有 ' + data.reviewDueNotes.length + ' 篇待复习' : '无待复习笔记'}
${data.reviewDueNotes.length > 0
  ? data.reviewDueNotes.map(n => {
      const stage = n.reviewCount === 0 ? '📌 首次待复习' : `第${n.reviewCount + 1}轮`;
      const overdue = n.overdueDays > 0 ? ` ⚠️逾期${n.overdueDays}天` : '';
      return `  - 📖 ${n.title}（${stage}${overdue}）`;
    }).join('\n')
  : ''}
【今日习惯】${data.habitsDoneToday}/${data.habitsCount} 已完成
${data.habitsOverview.length > 0
  ? data.habitsOverview.map(h => {
      const status = h.todayMet ? '✓' : '○';
      const detail = h.todayMet ? `已完成(${h.todayCount}/${h.dailyTarget})` : `未完成(${h.todayCount}/${h.dailyTarget})`;
      return `  - ${status} ${h.emoji} ${h.name} — ${detail}，连续 ${h.streak} 天`;
    }).join('\n')
  : '  （暂无习惯）'}
${data.taskline ? `【任务线】已完成 ${data.taskline.doneCount} 个任务｜主线「${data.taskline.currentMain || '未创建'}」${data.taskline.mainProgress !== null ? '进度 ' + data.taskline.mainProgress + '%' : '（暂无任务）'}
  - 激活任务 ${data.taskline.activeCount} 个${data.taskline.activeNames.length > 0 ? '：' + data.taskline.activeNames.join('、') : ''}
  ${data.taskline.ydayDone.length > 0 ? '- 今日完成任务：' + data.taskline.ydayDone.join('、') : ''}` : ''}${prevReportBlock}

---

💡 **你可以自由发挥，但建议包含以下方向（不必全部覆盖，选择你觉得有启发的）：**

1. **📊 今日总览** — 今天整体状态怎么样？目标推进了多少？有没有意料之外的收获？
2. **✅ 完成事项** — 今天完成了哪些待办？聚焦任务达成如何？给个简单的小总结
3. **⏱️ 时间回顾** — 今天的计时记录反映了什么学习/工作模式？时间利用是否合理？
4. **📝 笔记产出** — 今天写了哪些笔记？有没有值得标记的思路或洞察？
5. **⚠️ 遗留事项** — 哪些事情今天没做完？是否仍然重要？需要调整截止日期还是明天优先？
6. **🧠 复习习惯** — 今天复习了吗？剩余待复习笔记的状态如何？
7. **💡 日常习惯** — 今天的习惯打卡情况，有什么模式值得注意？
8. **🗺️ 任务线推进** — 今天的任务线有哪些进展（完成任务/条件推进）？当前主线章节和激活任务的状态如何？
9. **🔮 明天预告** — 结合明天截止、全局待办和任务线激活任务，明天最值得关注的 1-3 件事是什么？
10. **💪 晚安寄语** — 一句温暖的结束语

格式自由，语气自然、温暖、有沉淀感。用 Markdown 但不要太刻板。内容长度适中就好。`;

  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  const todayStr = data.todayStr;
  showMiniToast('🌙 正在生成晚间日报…', 'info', true);
  try {
    if (typeof callAiApi !== 'function') {
      showMiniToast('晚间日报生成失败：AI 模块未就绪', 'error');
      return { ok: false, error: 'AI 模块未就绪，请重启应用' };
    }
    // 复用手动发送同款 API 调用（callAiApi）：自动带上 deepThink 参数（Kimi/DeepSeek 默认思考开启，
    // 裸 fetch 未显式禁用会把 max_tokens 全部耗在 reasoning 上 → content 为空）；并处理
    // Kimi 的 max_tokens 命名 / temperature 跳过 / reasoning_content 提取。
    const apiMessages = [
      { role: 'system', content: '你是用户的学习伙伴，在每天晚上生成一份晚间日报。你的角色是：温暖、有洞察力、善于总结。\n\n当前时间：' + new Date().toLocaleString('zh-CN') + '\n\n═══ 系统模块概览 ═══\n1. 📋 待办管理：多层级父子任务、截止日期、标签\n2. 🎯 今日聚焦：每天最多3个聚焦任务\n3. 📝 笔记管理：Markdown 编辑、文件夹分类、间隔复习\n4. ⏱️ 计时器：专注计时、关联待办/目标\n5. 📅 日历视图：当月日程、截止日期、完成记录\n6. 🎯 习惯追踪：每日/每周打卡、进度条、热力图\n7. 📊 统计仪表盘：待办趋势、专注时长、习惯完成率图表\n8. 🤖 AI 助手：多对话、工具调用、长期记忆、网络搜索\n9. 🗺️ 任务线：人生主线（阶段推进）+ 素质线（并行成长）双轴章节，AI 生成任务、前置依赖解锁、条件绑定待办/笔记/计时、徽章+自定义奖励池\n\n═══ 你的任务 ═══\n帮助用户回顾今天（完成了什么/有什么收获/时间花在哪里），并帮助用户沉淀心得、放松心态。你也关注复习习惯和日常习惯的状态。不要罗列所有数据，而是挑最有意义的说。用 Markdown 但语气自然，像朋友聊天一样有温度。' + (typeof formatMemoryForPrompt === 'function' ? formatMemoryForPrompt() : '') },
      ...conv.messages.slice(-20),
      { role: 'user', content: reportPrompt }
    ];
    const { cleanText, reasoning, finishReason } = await callAiApi(apiMessages, apiCfg, null);
    const report = (cleanText || '').trim();
    if (report) {
      appendMessage(conv, { role: 'user', content: '生成 ' + todayStr + ' 晚间日报' });
      appendMessage(conv, { role: 'assistant', content: report, keyName: getActiveKeyDisplayName() });
      trimConvMessages(conv, 30);
      saveData('study_ai_convs', aiConvs);
      // Send Windows notification (before render/mark to ensure delivery)
      try {
        sendNotification('🌙 晚间日报已生成', '你的 ' + todayStr + ' 晚间回顾已就绪', 'evening-report');
      } catch { /* notification best-effort, don't block report flow */ }
      showMiniToast('🌙 晚间日报已生成');
      if (activeConvId === conv.id) {
        renderAiChat();
      }
      markEveningReportDone(todayStr);
      return { ok: true };
    }
    if (finishReason === 'length') {
      showMiniToast('晚间日报生成失败：回复被截断（max_tokens 不足），请重试或调大 max_tokens', 'error');
      return { ok: false, error: '回复被截断（max_tokens 不足），请重试或调大 max_tokens' };
    }
    if (reasoning) {
      showMiniToast('晚间日报生成失败：模型仅返回思考内容，请关闭深度思考后重试', 'error');
      return { ok: false, error: '模型仅返回了思考内容（无正文），请关闭深度思考后重试' };
    }
    showMiniToast('晚间日报生成失败：AI 返回了空内容', 'error');
    return { ok: false, error: 'AI 返回了空内容，请重试' };
  } catch (e) {
    console.error('[日报] 晚间报告生成失败:', e);
    showMiniToast('晚间日报生成失败：' + ((e && e.message) || String(e)), 'error');
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function closeCheckinQuote(e) {
  if (e && e.target !== document.getElementById('checkinQuoteOverlay')) return;
  document.getElementById('checkinQuoteOverlay').classList.remove('open');
}

function goToTodoFromFocus(todoId) {
  const t = findTodo(todoId);
  if (!t) return;
  currentTodoRoot = t.parentId;
  activeSubInputId = null;
  switchTab('todo');
  renderTodos();
}

function renderCheckinCalendar() {
  const calendar = document.getElementById('todayCalendar');
  if (!calendar) return;
  const data = loadCheckinData();
  const weekDays = getWeekDays();
  calendar.innerHTML = weekDays.map(d => {
    const isChecked = data.dates.includes(d.dateStr);
    const timeStr = isChecked && data.checkinTimes && data.checkinTimes[d.dateStr]
      ? data.checkinTimes[d.dateStr] : '';
    return `
    <div class="today-checkin-day${d.isToday ? ' today' : ''}${isChecked ? ' checked' : ''}"${timeStr ? ' title="打卡时间 ' + timeStr + '"' : ''}>
      <span class="day-num">${d.dayNum}</span>
      <span class="day-label">${d.dayLabel}</span>
      ${timeStr ? '<span class="checkin-time">' + timeStr + '</span>' : ''}
    </div>`;
  }).join('');

  const streakEl = document.getElementById('todayStreak');
  if (streakEl) streakEl.textContent = '连续 ' + data.streak + ' 天';

  const btn = document.getElementById('todayCheckinBtn');
  if (btn) {
    const today = getTodayStr();
    if (data.dates.includes(today)) {
      btn.classList.add('done');
      const timeStr = data.checkinTimes && data.checkinTimes[today] ? ' ' + data.checkinTimes[today] : '';
      btn.innerHTML = '✅ 今日已打卡' + timeStr;
    } else {
      btn.classList.remove('done');
      btn.innerHTML = '<i data-lucide="plus" class="lucide-icon" style="width:20px;height:20px;"></i>今日打卡';
    }
  }
}

// ═══════════ Memory Panel Rendering ═══════════

function renderMemoryPanel() {
  if (typeof loadAiMemory !== 'function') return;
  const memory = loadAiMemory();

  // ── Profile ──
  const profileText = document.getElementById('memoryProfileText');
  if (profileText) profileText.value = memory.profileText || '';

  // ── Manual Notes ──
  const manualList = document.getElementById('memoryManualList');
  if (manualList) {
    if (memory.manualNotes.length === 0) {
      manualList.innerHTML = '<div class="hint" style="text-align:center;padding:8px;">暂无手动记忆</div>';
    } else {
      manualList.innerHTML = memory.manualNotes.map(n => {
        const date = new Date(n.updatedAt).toLocaleDateString('zh-CN');
        const hasDetail = n.detail && n.detail.trim();
        const detailId = 'memManDetail_' + n.id;
        return `
        <div class="memory-card">
          <div class="memory-card-body">
            <div class="memory-card-text">${escapeHtml(n.content)}</div>
            ${hasDetail ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;cursor:pointer;" onclick="toggleDetail('${detailId}')">📖 查看详情 ▸</div>
            <div id="${detailId}" style="display:none;margin-top:4px;padding:6px 8px;background:var(--hover-bg);border-radius:6px;font-size:12px;color:var(--text);line-height:1.6;">${escapeHtml(n.detail)}</div>` : ''}
            <div class="memory-card-meta">${date}</div>
          </div>
          <div class="memory-card-actions">
            <button onclick="memoryEditManual(${n.id})" title="编辑">✏️</button>
            <button onclick="memoryDeleteManual(${n.id})" title="删除" style="color:var(--danger);">🗑️</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── Auto Facts ──
  const autoList = document.getElementById('memoryAutoList');
  if (autoList) {
    // ── Dedup controls: restore saved values ──
    const dedupSel = document.getElementById('memoryDedupMode');
    if (dedupSel && typeof getDedupMode === 'function') dedupSel.value = getDedupMode();
    const thresholdInput = document.getElementById('memoryDedupThreshold');
    if (thresholdInput && typeof getDedupThreshold === 'function') thresholdInput.value = getDedupThreshold();

    const filter = document.getElementById('memoryAutoFilter');
    const filterType = filter ? filter.value : '';
    let entries = [...memory.autoFacts];
    if (filterType) entries = entries.filter(e => e.type === filterType);
    entries.sort((a, b) => b.confidence - a.confidence);

    if (entries.length === 0) {
      autoList.innerHTML = '<div class="hint" style="text-align:center;padding:8px;">暂无自动记忆</div>';
    } else {
      autoList.innerHTML = entries.map(e => {
        const cat = typeof MEMORY_CATEGORIES !== 'undefined' ? MEMORY_CATEGORIES[e.type] : null;
        const catLabel = cat ? `${cat.icon} ${cat.label}` : e.type;
        const catColor = cat ? cat.color : '#888';
        const pct = Math.round(e.confidence * 100);
        const date = new Date(e.updatedAt).toLocaleDateString('zh-CN');
        const sourceInfo = e.sourceConvTitle ? ` | 来源：${escapeHtml(e.sourceConvTitle)}` : '';
        const mergeBadge = (e.mergeCount > 0) ? ` | <span style="color:var(--primary);font-weight:600;">已合并 ${e.mergeCount} 条</span>` : '';
        const hasDetail = e.detail && e.detail.trim();
        const detailId = 'memAutoDetail_' + e.id;
        return `
        <div class="memory-card">
          <div class="memory-card-body">
            <div class="memory-card-type" style="color:${catColor};">${catLabel}</div>
            <div class="memory-card-text">${escapeHtml(e.text)}</div>
            ${hasDetail ? `<div style="font-size:11px;color:var(--text-secondary);margin-top:2px;cursor:pointer;" onclick="toggleDetail('${detailId}')">📖 查看详情 ▸</div>
            <div id="${detailId}" style="display:none;margin-top:4px;padding:6px 8px;background:var(--hover-bg);border-radius:6px;font-size:12px;color:var(--text);line-height:1.6;">${escapeHtml(e.detail)}</div>` : ''}
            <div class="memory-confidence-row">
              <div class="memory-confidence-bar">
                <div class="memory-confidence-fill" style="width:${pct}%;background:${pct >= 70 ? 'var(--done)' : pct >= 40 ? 'var(--primary)' : '#f59e0b'};"></div>
              </div>
              <span class="memory-confidence-pct">${pct}%</span>
              <button class="mem-conf-btn" onclick="memoryAdjustConfidence(${e.id}, 0.05)" title="置信度 +5%">+</button>
              <button class="mem-conf-btn" onclick="memoryAdjustConfidence(${e.id}, -0.05)" title="置信度 -5%">−</button>
            </div>
            <div class="memory-card-meta">${date}${sourceInfo}${mergeBadge}</div>
          </div>
          <div class="memory-card-actions">
            <button onclick="memoryConvertToManual(${e.id})" title="转为手动记忆">📌</button>
            <button onclick="memoryEditAuto(${e.id})" title="编辑">✏️</button>
            <button onclick="memoryDeleteAuto(${e.id})" title="删除" style="color:var(--danger);">🗑️</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── Conv Summaries ──
  const summaryList = document.getElementById('memorySummaryList');
  if (summaryList) {
    const summaries = [...memory.convSummaries].sort((a, b) => b.extractedAt - a.extractedAt);
    if (summaries.length === 0) {
      summaryList.innerHTML = '<div class="hint" style="text-align:center;padding:8px;">暂无对话摘要</div>';
    } else {
      summaryList.innerHTML = summaries.map(s => {
        const date = new Date(s.extractedAt).toLocaleDateString('zh-CN');
        const shortSummary = s.summary.length > 60 ? s.summary.slice(0, 60) + '…' : s.summary;
        return `
        <div class="memory-card memory-summary-card">
          <div class="memory-card-body">
            <div class="memory-card-text">
              <span class="memory-summary-date">${date}</span>
              <span class="memory-summary-title">「${escapeHtml(s.convTitle)}」</span>
              ${escapeHtml(shortSummary)}
            </div>
            <div class="memory-card-meta">${s.messageCount} 条消息</div>
          </div>
          <div class="memory-card-actions">
            <button onclick="memoryEditSummary(${s.convId})" title="编辑">✏️</button>
            <button onclick="memoryDeleteSummary(${s.convId})" title="删除" style="color:var(--danger);">🗑️</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── Daily Summary ──
  const dailySummary = document.getElementById('memoryDailySummary');
  if (dailySummary && memory.dailySummary) {
    dailySummary.innerHTML = `
    <div class="memory-daily-summary">
      <div class="memory-daily-summary-title">📅 近期对话总摘要（${memory.dailySummaryDate || ''}）</div>
      <div class="memory-daily-summary-text">${escapeHtml(memory.dailySummary)}</div>
    </div>`;
  } else if (dailySummary) {
    dailySummary.innerHTML = '';
  }
}

// ── Profile Save ──
function saveMemoryProfile() {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  const memory = loadAiMemory();
  memory.profileText = (document.getElementById('memoryProfileText')?.value || '').trim();
  saveAiMemory(memory);
}

// ── Manual Notes CRUD ──
function memoryAddManual() {
  const form = document.getElementById('memoryManualForm');
  document.getElementById('memoryManualInput').value = '';
  document.getElementById('memoryManualEditId').value = '';
  if (form) form.style.display = 'block';
  setTimeout(() => document.getElementById('memoryManualInput')?.focus(), 50);
}

function memoryEditManual(id) {
  if (typeof loadAiMemory !== 'function') return;
  const memory = loadAiMemory();
  const note = memory.manualNotes.find(n => n.id === id);
  if (!note) return;
  const form = document.getElementById('memoryManualForm');
  document.getElementById('memoryManualInput').value = note.content;
  document.getElementById('memoryManualDetail').value = note.detail || '';
  document.getElementById('memoryManualEditId').value = id;
  if (form) form.style.display = 'block';
  setTimeout(() => document.getElementById('memoryManualInput')?.focus(), 50);
}

function memoryCancelManual() {
  const form = document.getElementById('memoryManualForm');
  if (form) form.style.display = 'none';
}

function memorySaveManual() {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  const content = document.getElementById('memoryManualInput')?.value.trim();
  const detail = document.getElementById('memoryManualDetail')?.value.trim() || '';
  if (!content) return;
  const editId = document.getElementById('memoryManualEditId')?.value;
  const memory = loadAiMemory();

  if (editId) {
    if (typeof updateManualNote === 'function') {
      updateManualNote(memory, parseInt(editId), content, detail);
    }
  } else {
    if (typeof addManualNote === 'function') {
      addManualNote(memory, content, detail);
    }
  }
  saveAiMemory(memory);
  memoryCancelManual();
  renderMemoryPanel();
  showMemoryStatus('✅ 已保存');
}

function memoryDeleteManual(id) {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  if (typeof showCustomConfirm !== 'function') {
    const memory = loadAiMemory();
    if (typeof deleteManualNote === 'function') deleteManualNote(memory, id);
    saveAiMemory(memory);
    renderMemoryPanel();
    return;
  }
  showCustomConfirm('确定要删除这条手动记忆吗？').then(confirmed => {
    if (!confirmed) return;
    const memory = loadAiMemory();
    if (typeof deleteManualNote === 'function') deleteManualNote(memory, id);
    saveAiMemory(memory);
    renderMemoryPanel();
    showMemoryStatus('✅ 已删除');
  });
}

// ── Auto Facts Edit ──
function memoryEditAuto(id) {
  if (typeof loadAiMemory !== 'function') return;
  const memory = loadAiMemory();
  const entry = memory.autoFacts.find(e => e.id === id);
  if (!entry) return;
  document.getElementById('memoryAutoEditId').value = id;
  document.getElementById('memoryAutoEditInput').value = entry.text;
  document.getElementById('memoryAutoEditDetail').value = entry.detail || '';
  document.getElementById('memoryAutoEditType').value = entry.type;
  const confPct = Math.round(entry.confidence * 100);
  const confSlider = document.getElementById('memoryAutoEditConfidence');
  const confVal = document.getElementById('memoryAutoEditConfidenceVal');
  if (confSlider) { confSlider.value = confPct; }
  if (confVal) { confVal.textContent = confPct + '%'; }
  document.getElementById('memoryAutoEditForm').style.display = 'block';
  document.getElementById('memoryAutoEditInput').focus();
}
function memoryCancelAutoEdit() {
  document.getElementById('memoryAutoEditForm').style.display = 'none';
}
function memorySaveAutoEdit() {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function' || typeof updateAutoFact !== 'function') return;
  const id = parseInt(document.getElementById('memoryAutoEditId').value);
  const type = document.getElementById('memoryAutoEditType').value;
  const text = document.getElementById('memoryAutoEditInput').value.trim();
  const detail = document.getElementById('memoryAutoEditDetail')?.value.trim() || '';
  if (!text || !id) return;
  const memory = loadAiMemory();
  updateAutoFact(memory, id, type, text, detail);
  // Save confidence from slider
  const confSlider = document.getElementById('memoryAutoEditConfidence');
  if (confSlider) {
    const confPct = parseInt(confSlider.value);
    const entry = memory.autoFacts.find(e => e.id === id);
    if (entry) { entry.confidence = Math.max(0, Math.min(1, confPct / 100)); entry.updatedAt = Date.now(); }
  }
  saveAiMemory(memory);
  memoryCancelAutoEdit();
  renderMemoryPanel();
  showMemoryStatus('✅ 已更新');
}

// ── Auto Facts Actions ──
function memoryAdjustConfidence(id, delta) {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  const memory = loadAiMemory();
  const entry = memory.autoFacts.find(e => e.id === id);
  if (!entry) return;
  entry.confidence = Math.max(0, Math.min(1, entry.confidence + delta));
  entry.updatedAt = Date.now();
  saveAiMemory(memory);
  renderMemoryPanel();
  showMemoryStatus(`✅ 置信度已调整为 ${Math.round(entry.confidence * 100)}%`);
}

function memoryDeleteAuto(id) {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  const memory = loadAiMemory();
  memory.autoFacts = memory.autoFacts.filter(e => e.id !== id);
  saveAiMemory(memory);
  renderMemoryPanel();
  showMemoryStatus('✅ 已删除');
}

// 将自动记忆条目转为手动记忆（用户主动固定，AI 更重视）
function memoryConvertToManual(id) {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  const memory = loadAiMemory();
  const idx = memory.autoFacts.findIndex(e => e.id === id);
  if (idx === -1) return;
  const e = memory.autoFacts[idx];
  // 手动记忆上限保护（与 addManualNote 一致）
  if (typeof addManualNote === 'function') {
    addManualNote(memory, e.text, e.detail);
  } else {
    memory.manualNotes.push({
      id: genId(),
      content: e.text,
      detail: e.detail || '',
      createdAt: e.createdAt || Date.now(),
      updatedAt: Date.now()
    });
    if (memory.manualNotes.length > 50) memory.manualNotes = memory.manualNotes.slice(-50);
  }
  // 从自动记忆中移除
  memory.autoFacts.splice(idx, 1);
  saveAiMemory(memory);
  renderMemoryPanel();
  showMemoryStatus('✅ 已转为手动记忆');
}

function memoryClearAuto() {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  if (typeof showCustomConfirm !== 'function') {
    const memory = loadAiMemory();
    memory.autoFacts = [];
    saveAiMemory(memory);
    renderMemoryPanel();
    return;
  }
  showCustomConfirm('确定要清空所有自动记忆吗？此操作不可撤销。').then(confirmed => {
    if (!confirmed) return;
    const memory = loadAiMemory();
    memory.autoFacts = [];
    saveAiMemory(memory);
    renderMemoryPanel();
    showMemoryStatus('✅ 已清空所有自动记忆');
  });
}

// ── Conv Summary Edit ──
function memoryEditSummary(convId) {
  if (typeof loadAiMemory !== 'function') return;
  const memory = loadAiMemory();
  const s = memory.convSummaries.find(s => s.convId === convId);
  if (!s) return;
  document.getElementById('memorySummaryEditId').value = convId;
  document.getElementById('memorySummaryEditInput').value = s.summary || '';
  document.getElementById('memorySummaryEditForm').style.display = 'block';
  document.getElementById('memorySummaryEditInput').focus();
}
function memoryCancelSummaryEdit() {
  document.getElementById('memorySummaryEditForm').style.display = 'none';
}
function memorySaveSummaryEdit() {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function' || typeof updateConvSummary !== 'function') return;
  const convId = document.getElementById('memorySummaryEditId').value;
  const summary = document.getElementById('memorySummaryEditInput').value.trim();
  if (!convId) return;
  const memory = loadAiMemory();
  updateConvSummary(memory, convId, summary);
  saveAiMemory(memory);
  memoryCancelSummaryEdit();
  renderMemoryPanel();
  showMemoryStatus('✅ 已更新');
}

// ── Conv Summary Actions ──
function memoryDeleteSummary(convId) {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  const memory = loadAiMemory();
  if (typeof deleteConvSummary === 'function') deleteConvSummary(memory, convId);
  saveAiMemory(memory);
  renderMemoryPanel();
  showMemoryStatus('✅ 已删除');
}

function memoryClearSummaries() {
  if (typeof loadAiMemory !== 'function' || typeof saveAiMemory !== 'function') return;
  if (typeof showCustomConfirm !== 'function') {
    const memory = loadAiMemory();
    memory.convSummaries = [];
    saveAiMemory(memory);
    renderMemoryPanel();
    return;
  }
  showCustomConfirm('确定要清空所有对话摘要吗？').then(confirmed => {
    if (!confirmed) return;
    const memory = loadAiMemory();
    memory.convSummaries = [];
    saveAiMemory(memory);
    renderMemoryPanel();
    showMemoryStatus('✅ 已清空所有摘要');
  });
}

function toggleDetail(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'block' : 'none';
}

function showMemoryStatus(msg) {
  const el = document.getElementById('memoryStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'memory-status success';
  setTimeout(() => { el.textContent = ''; el.className = 'memory-status'; }, 3000);
}

// ── Dedup Settings Handlers ──
function saveMemoryDedupMode() {
  const sel = document.getElementById('memoryDedupMode');
  if (!sel) return;
  localStorage.setItem('study_memory_dedup_mode', sel.value);
  const label = sel.value === 'A' ? '完全AI（写入不做本地合并）' : sel.value === 'B' ? 'JS本地合并 + AI每日兜底' : '纯JS本地合并（无AI兜底）';
  showMemoryStatus(`✅ 去重方案已切换：${label}`);
}

function saveMemoryDedupThreshold() {
  const input = document.getElementById('memoryDedupThreshold');
  if (!input) return;
  let v = parseInt(input.value, 10);
  if (isNaN(v)) v = 30;
  v = Math.max(10, Math.min(50, v));
  input.value = v;
  localStorage.setItem('study_memory_dedup_threshold', String(v));
  showMemoryStatus(`✅ 每日 AI 兜底阈值已设为 ${v} 条`);
}

async function runManualDedupBtn() {
  const btn = document.getElementById('memoryDedupRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 去重中...'; }
  try {
    if (typeof runManualDedup === 'function') await runManualDedup();
    else showMemoryStatus('❌ 去重模块未加载');
  } catch (err) {
    console.warn('[Memory] Manual dedup error:', err);
    showMemoryStatus('❌ 去重失败：' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ 立即去重'; }
  }
}

// Hook into openSettingsModal to render memory panel when tab is shown
const _origOpenSettingsModal = openSettingsModal;
openSettingsModal = function() {
  _origOpenSettingsModal();
  // Render memory panel on open
  setTimeout(() => {
    if (typeof renderMemoryPanel === 'function' && _settingsTab === 'memory') {
      renderMemoryPanel();
    }
    if (_settingsTab === 'supabase' && typeof loadSupabaseSettings === 'function') {
      loadSupabaseSettings();
    }
  }, 150);
};

// Hook switchSettingsTab to render memory panel when switching to it
const _origSwitchSettingsTab = switchSettingsTab;
switchSettingsTab = function(tab) {
  _origSwitchSettingsTab(tab);
  if (tab === 'memory' && typeof renderMemoryPanel === 'function') {
    renderMemoryPanel();
  }
  if (tab === 'data' && typeof loadTodoStatusesToSettings === 'function') {
    loadTodoStatusesToSettings();
  }
  if (tab === 'api' && typeof renderCodebuddyCliConfig === 'function') {
    renderCodebuddyCliConfig();
  }
  if (tab === 'supabase' && typeof loadSupabaseSettings === 'function') {
    loadSupabaseSettings();
  }
};

// ═══════════ Supabase 连接配置（好友 & 插件市场共享） ═══════════
function loadSupabaseSettings() {
  const urlEl = document.getElementById('supabaseUrl');
  const keyEl = document.getElementById('supabaseAnonKey');
  if (!urlEl || !keyEl) return;
  const cfg = getFriendsConfig();
  urlEl.value = cfg.url || '';
  keyEl.value = cfg.anonKey || '';
}

// 保存 Supabase 配置并测试连接
async function saveSupabaseSettings(reconnect) {
  const urlEl = document.getElementById('supabaseUrl');
  const keyEl = document.getElementById('supabaseAnonKey');
  const btn = document.getElementById('supabaseSaveBtn');
  const st = document.getElementById('supabaseStatus');
  if (!urlEl || !keyEl) return;
  const url = urlEl.value.trim();
  const anonKey = keyEl.value.trim();

  const showStatus = (cls, msg) => {
    if (!st) return;
    st.className = 'settings-status ' + cls;
    st.textContent = msg;
    st.style.display = 'block';
  };

  if (!url || !anonKey) {
    showStatus('error', '⚠️ 请先填写 Project URL 和 Anon Public Key');
    return;
  }
  if (!/^https:\/\/.+/.test(url)) {
    showStatus('error', '⚠️ Project URL 需以 https:// 开头，且不要带 /rest/v1/ 路径');
    return;
  }

  const btnHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ 正在连接…'; }
  showStatus('info', '正在保存配置并测试连接…');

  saveFriendsConfig({ url, anonKey });
  // 重置两端客户端
  if (typeof resetSupabaseClient === 'function') resetSupabaseClient();
  if (typeof window.Store !== 'undefined' && window.Store.saveStoreConfig) {
    window.Store.saveStoreConfig({ url, anonKey });
  }

  // 测试连接：探测 profiles 表是否可访问
  let test = { ok: false, error: '未知错误' };
  try {
    const client = getSupabaseClient();
    if (!client) {
      test = { ok: false, error: '客户端初始化失败，请检查 URL 是否正确' };
    } else {
      const { error } = await client.from('profiles').select('id', { count: 'exact', head: true });
      if (!error) {
        test = { ok: true };
      } else if (error.code === '42P01' || /relation.*does not exist/i.test(error.message || '')) {
        test = { ok: false, error: '⚠️ 数据库中找不到表：请先在 Supabase SQL Editor 执行 supabase/schema.sql 建表脚本' };
      } else if (error.code === '42501' || /permission denied/i.test(error.message || '')) {
        test = { ok: false, error: '⚠️ 无表访问权限：请确认已执行 schema.sql（含 GRANT 授权段），或打开 "Automatically expose new tables"' };
      } else if (error.code === 'PGRST301' || /JWT/i.test(error.message || '')) {
        test = { ok: false, error: '⚠️ Anon Key 无效：请确认复制的是 anon public key 而非 service_role key' };
      } else {
        test = { ok: false, error: '连接失败：' + (error.message || '未知错误') };
      }
    }
  } catch (e) {
    test = { ok: false, error: '网络异常：' + e.message };
  }

  if (test.ok) {
    showStatus('success', '✅ 连接成功！已正确读写 profiles 表');
    if (reconnect && typeof renderFriends === 'function') {
      if (document.getElementById('section-friends')?.classList.contains('active')) renderFriends();
    }
  } else {
    showStatus('error', test.error);
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = btnHtml;
    setTimeout(() => { if (typeof lucide !== 'undefined') lucide.createIcons(); }, 0);
  }
  // 3.5s 后自动隐藏成功信息，错误信息保留
  if (test.ok) setTimeout(() => { if (st) st.style.display = 'none'; }, 3500);
}

// ═══════════ CodeBuddy CLI 配置区 ═══════════
function getCliPath() {
  try { return localStorage.getItem('study_codebuddy_cli_path') || ''; } catch (e) { return ''; }
}
function saveCliPath(p) {
  try { localStorage.setItem('study_codebuddy_cli_path', p); } catch (e) {}
}

async function renderCodebuddyCliConfig() {
  const el = document.getElementById('codebuddyCliConfig');
  if (!el) return;
  el.innerHTML = '<div class="hint" style="text-align:center;padding:12px;">正在检测 CodeBuddy CLI…</div>';
  let cli = { found: false, path: '' };
  try {
    if (window.electronAPI && window.electronAPI.codebuddyLocate) {
      const res = await window.electronAPI.codebuddyLocate({ userPath: getCliPath() });
      cli = res || { found: false, path: '' };
    }
  } catch (e) {
    cli = { found: false, path: '', reason: e.message };
  }

  const apiKey = (typeof window.Codegen !== 'undefined' && window.Codegen.getCodebuddyApiKey)
    ? window.Codegen.getCodebuddyApiKey() : '';

  el.innerHTML = `
    <div style="background:var(--todo-bg);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:10px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span class="cg-key-status ${cli.found ? 'ok' : 'warn'}">
          <i data-lucide="${cli.found ? 'check-circle-2' : 'alert-circle'}" class="lucide-icon" style="width:14px;height:14px;"></i>
          ${cli.found ? 'CLI 已就绪' : '未检测到 CLI'}
        </span>
        ${cli.path ? `<span style="font-size:11px;color:var(--text-secondary);word-break:break-all;">${escapeHtml(cli.path)}</span>` : ''}
      </div>
      <div class="settings-field" style="margin-bottom:6px;">
        <label>CLI 路径（留空自动探测）</label>
        <input type="text" id="codebuddyCliPathInput" value="${escapeHtml(getCliPath())}" placeholder="如 C:\\Users\\you\\AppData\\Roaming\\npm\\codebuddy.cmd">
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
        <button class="btn-save-settings" onclick="saveCodebuddyCliPath()" style="width:auto;padding:5px 12px;font-size:12px;background:var(--primary);">保存路径</button>
        <button class="btn-save-settings" onclick="reprobeCodebuddyCli()" style="width:auto;padding:5px 12px;font-size:12px;background:var(--border);color:var(--text);">重新探测</button>
        <button class="btn-save-settings" onclick="installCodebuddyCli()" style="width:auto;padding:5px 12px;font-size:12px;background:#8b5cf6;">${cli.found ? '重新安装' : '一键安装'}</button>
      </div>
      ${!cli.found ? `
      <div style="background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-secondary);line-height:1.6;">
        <b>安装指引：</b>需 Node.js ≥ 18.20，然后执行：<br>
        <code style="background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;">npm install -g @tencent-ai/codebuddy-code</code><br>
        或在终端运行 <code style="background:rgba(0,0,0,0.2);padding:2px 6px;border-radius:4px;">codebuddy</code> 完成微信/QQ 登录。
      </div>` : ''}
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:8px;font-size:12px;color:var(--text-secondary);">
        <input type="checkbox" id="codebuddyUseMirror" style="width:14px;height:14px;accent-color:var(--primary);"> 使用国内镜像安装（npmmirror）
      </label>
    </div>
    <div class="settings-field" style="margin-bottom:8px;">
      <label>CodeBuddy API Key（可选，用于无需扫码登录的授权）</label>
      <input type="password" id="codebuddyApiKeyInput" value="${escapeHtml(apiKey)}" placeholder="留空则使用本机已登录凭据">
      <span class="hint">从 CodeBuddy 控制台获取；中国版环境自动设为 internal。留空时使用 CLI 已登录的 OAuth 凭据。</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
      <button class="btn-save-settings" onclick="saveCodebuddyApiKey()" style="width:auto;padding:5px 12px;font-size:12px;background:var(--primary);">保存 API Key</button>
      <button class="btn-save-settings" onclick="clearCodebuddyApiKey()" style="width:auto;padding:5px 12px;font-size:12px;background:var(--border);color:var(--text);">清除</button>
    </div>
    <div class="settings-status" id="codebuddyCliStatus"></div>
    <div class="cg-agent-log-wrap" id="codebuddyInstallLogWrap" style="display:none;">
      <div class="cg-col-title"><i data-lucide="terminal" class="lucide-icon" style="width:13px;height:13px;"></i> 安装日志</div>
      <pre class="cg-agent-log" id="codebuddyInstallLog"></pre>
    </div>
  `;
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}

function codebuddyCliStatus(msg, isError) {
  const el = document.getElementById('codebuddyCliStatus');
  if (!el) return;
  el.className = 'settings-status' + (isError ? ' error' : '');
  el.textContent = msg || '';
}

function saveCodebuddyCliPath() {
  const input = document.getElementById('codebuddyCliPathInput');
  if (!input) return;
  saveCliPath(input.value.trim());
  codebuddyCliStatus('路径已保存');
  setTimeout(renderCodebuddyCliConfig, 500);
  if (typeof window.refreshCliBar === 'function') window.refreshCliBar();
}

async function reprobeCodebuddyCli() {
  codebuddyCliStatus('正在重新探测…');
  try {
    const res = await window.electronAPI.codebuddyLocate({ userPath: getCliPath() });
    codebuddyCliStatus(res && res.found ? '✅ 已找到 CLI: ' + res.path : '❌ 仍未检测到 CLI');
  } catch (e) {
    codebuddyCliStatus('探测失败: ' + e.message, true);
  }
  await renderCodebuddyCliConfig();
  if (typeof window.refreshCliBar === 'function') window.refreshCliBar();
}

async function installCodebuddyCli() {
  const logWrap = document.getElementById('codebuddyInstallLogWrap');
  const logEl = document.getElementById('codebuddyInstallLog');
  if (logWrap) logWrap.style.display = 'block';
  if (logEl) logEl.textContent = '';
  const useMirror = !!(document.getElementById('codebuddyUseMirror') && document.getElementById('codebuddyUseMirror').checked);
  const append = (text) => {
    if (logEl) { logEl.textContent += text; logEl.scrollTop = logEl.scrollHeight; }
  };
  codebuddyCliStatus('正在安装 CodeBuddy CLI…');
  const off = window.electronAPI.onCodebuddyInstallOutput((payload) => {
    if (payload && payload.text) append(payload.text);
  });
  try {
    const res = await window.electronAPI.codebuddyInstall({ useMirror });
    codebuddyCliStatus(res && res.ok ? '✅ 安装完成，CLI 已就绪' : '❌ 安装失败：' + ((res && res.reason) || '未知错误'), !(res && res.ok));
  } catch (e) {
    codebuddyCliStatus('安装出错: ' + e.message, true);
  } finally {
    if (off) off();
    setTimeout(renderCodebuddyCliConfig, 500);
    if (typeof window.refreshCliBar === 'function') window.refreshCliBar();
  }
}

function saveCodebuddyApiKey() {
  const input = document.getElementById('codebuddyApiKeyInput');
  if (!input) return;
  if (typeof window.Codegen !== 'undefined' && window.Codegen.setCodebuddyApiKey) {
    window.Codegen.setCodebuddyApiKey(input.value.trim());
  }
  codebuddyCliStatus('✅ API Key 已保存');
}

function clearCodebuddyApiKey() {
  if (typeof window.Codegen !== 'undefined' && window.Codegen.setCodebuddyApiKey) {
    window.Codegen.setCodebuddyApiKey('');
  }
  const input = document.getElementById('codebuddyApiKeyInput');
  if (input) input.value = '';
  codebuddyCliStatus('✅ API Key 已清除');
}
