// ═══════════════════════════════════════════════
//  AI 工具系统：工具定义、系统提示词构建、工具执行、工具调用解析
// ═══════════════════════════════════════════════

// ═══════════ AI Chat: Tools (Function Calling) ═══════════
const AI_TOOLS = {
  add_todo: {
    description: '创建一个新的待办事项',
    params: { text: '待办内容（string，必填）', parentId: '父任务ID（number，可选，与path二选一）', path: '父路径层级数组（不含自身），按顺序自动查找/创建（array of strings，可选，如["高数","18.01"], 与parentId二选一）', dueDate: '截止日期，格式YYYY-MM-DD（string，可选）', content: '待办正文/备注（string，可选）', tags: '标签，逗号分隔（string，可选，如"重要,学习"）', repeat: '重复刷新：daily/weekly/monthly（string，可选，不填则不重复）', status: '进度状态（string，可选，如"还未开始"、"进行中"等）', estMinutes: '预计完成时间，单位分钟（number，可选，如 30 表示30分钟）' }
  },
  batch_add_todos: {
    description: '批量创建待办事项，每个待办可指定父级位置（parentId 或 path，path不含自身）。特别适合一次性导入整个大纲/课程结构',
    params: { todos: '待办数组（array of objects），每个对象包含 text（必填）、parentId/path（可选）、dueDate（可选）、content（可选）、tags（可选）、repeat（可选）、status（可选）、estMinutes（可选）' }
  },
  update_todo: {
    description: '更新待办的名称、正文、截止日期或标签、状态、预计时间',
    params: { id: '待办ID（number）', text: '新名称（string，可选）', content: '新正文（string，可选）', dueDate: '截止日期YYYY-MM-DD（string，可选）', tags: '标签逗号分隔（string，可选）', repeat: '重复刷新：daily/weekly/monthly（string，可选，设为空字符串则取消重复）', status: '进度状态（string，可选，设为空字符串则清除）', estMinutes: '预计完成时间分钟（number，可选，设为null或0则清除）' }
  },
  delete_todo: {
    description: '删除一个待办事项及其所有子任务',
    params: { id: '待办ID（number）' }
  },
  toggle_todo: {
    description: '切换待办完成状态（勾选/取消勾选）',
    params: { id: '待办ID（number）' }
  },
  move_todo: {
    description: '将待办移动到另一个父任务下。支持 path 自动创建父层级',
    params: { id: '待办ID（number，必填）', parentId: '新父任务ID（number，可选，与path二选一）', path: '目标父路径层级数组（不含自身），按顺序自动查找/创建（array of strings，可选，如["高数","18.01"]，与parentId二选一）' }
  },
  list_todos: {
    description: '列出待办事项，支持多种筛选条件。可按关键词搜索、按标签筛选、按截止日期范围筛选、按完成状态筛选。一次性返回全部匹配结果（无分页）',
    params: { search: '搜索关键词，模糊匹配名称和正文（string，可选）', tags: '标签筛选，逗号分隔，返回包含任意匹配标签的待办（string，可选）', dueFrom: '截止日期起始，格式YYYY-MM-DD（string，可选）', dueTo: '截止日期结束，格式YYYY-MM-DD（string，可选）', completed: '按完成状态筛选 true/false（boolean，可选）' }
  },
  get_todo_detail: {
    description: '获取单个待办的详细信息，包括正文备注、标签、截止日期、子任务列表',
    params: { id: '待办ID（number）' }
  },
  get_today_status: {
    description: '查看今日状态：打卡天数、今日聚焦任务详情（含关联待办信息）、全局待办完成情况',
    params: {}
  },
  get_focus_tasks: {
    description: '查看今日已设置的聚焦任务列表，返回每个聚焦任务的ID、名称和完成状态',
    params: {}
  },
  set_focus_task: {
    description: '设置或移除今日聚焦任务。注意：每次调用会追加一个聚焦任务（不会覆盖已有任务），最多累计' + getMaxFocusCount() + '个。例如连续调用多次可依次添加。传null则清空全部。可用get_focus_tasks查看当前列表',
    params: { todoId: '要设为聚焦的待办ID（number），传null则清空所有聚焦任务' }
  },
  get_stats: {
    description: '获取全局统计：各模块数据概览（待办完成率、笔记数、链接数等）',
    params: {}
  },
  get_todo_stats: {
    description: '获取待办统计与趋势数据，支持按标签、日期范围、完成状态筛选',
    params: { tag: '按标签筛选（string，可选）', dueFrom: '截止日期起始，格式YYYY-MM-DD（string，可选）', dueTo: '截止日期结束，格式YYYY-MM-DD（string，可选）', completedOnly: '仅统计已完成（boolean，可选）' }
  },
  batch_update_todos: {
    description: '批量操作待办：批量切换完成状态、批量设置标签、批量设置截止日期、批量删除',
    params: { ids: '待办ID数组（number[]）', action: '操作类型：toggle_completed / set_tags / set_due_date / delete（string）', value: '操作值：toggle_completed时为true/false，set_tags时为标签字符串逗号分隔，set_due_date时为YYYY-MM-DD日期字符串，delete时不需要（string/boolean，可选）' }
  },
  add_note: {
    description: '创建一条新笔记。支持 path 或 folderId 指定目标文件夹',
    params: { title: '笔记标题（string）', content: '笔记内容（string，用真实换行分段，不要写 \\n）', folderId: '目标文件夹ID（number，可选，与path二选一）', path: '目标文件夹路径（不含自身），按顺序自动查找/创建（array of strings，可选，如["数学","微积分"]，与folderId二选一）' }
  },
  update_note: {
    description: '更新已有笔记的标题或内容。注意：content 请用真实换行分段，不要写字面的 \\n',
    params: { id: '笔记ID（number）', title: '新标题（string，可选）', content: '新内容（string，可选，用真实换行分段，不要写 \\n）' }
  },
  move_note: {
    description: '将笔记移动到指定文件夹。支持 path 自动创建文件夹层级',
    params: { id: '笔记ID（number，必填）', folderId: '目标文件夹ID（number，可选，与path二选一）', path: '目标文件夹路径（不含自身），按顺序自动查找/创建（array of strings，可选，如["数学","微积分"]，与folderId二选一）' }
  },
  delete_note: {
    description: '删除一条笔记',
    params: { id: '笔记ID（number）' }
  },
  list_notes: {
    description: '列出所有笔记及其文件夹结构。使用 [1]→[1.1] 数字层级编号，文件夹和笔记统排在同一棵树中，每个节点包含名称、ID、摘要（笔记）或子节点概况（文件夹）。如需搜索笔记正文，请使用 search_notes',
    params: {}
  },
  search_notes: {
    description: '搜索笔记，在标题和正文中查找关键词，返回匹配的笔记列表（含内容摘要）',
    params: { query: '搜索关键词（string）' }
  },
  get_note_detail: {
    description: '获取单条笔记的完整内容（包括标题、正文、创建/更新时间）',
    params: { id: '笔记ID（number）' }
  },
  get_note_changes: {
    description: '获取昨天或今天有修改的笔记列表，用于回顾学习进展。可以看到哪些笔记被编辑过',
    params: { period: '时间范围：today（今天）或 yesterday（昨天），默认today（string，可选）' }
  },
  add_link: {
    description: '添加一个快捷访问链接',
    params: { name: '名称（string）', url: 'URL地址（string）', category: '分类名（string，可选，默认"默认分类"）', type: '类型：link或app（string，可选，默认link）' }
  },
  delete_link: {
    description: '删除一个快捷访问链接',
    params: { id: '链接ID（number）' }
  },
  list_links: {
    description: '列出所有快捷访问链接',
    params: {}
  },
  get_review_status: {
    description: '查看间隔重复复习状态：待复习笔记列表（含逾期信息）、复习轮次分布、已复习笔记数',
    params: {}
  },
  get_habits_status: {
    description: '查看习惯追踪状态：所有习惯的今日打卡情况、连续天数、本周进度',
    params: {}
  },
  schedule_automation: {
    description: '创建一个定时自动化任务：在指定时间自动调用AI（在同一对话窗口），AI收到一条系统消息提示执行任务。支持每天重复或仅执行一次',
    params: { at: '触发时间，格式HH:MM，24小时制（string，必填）', prompt: '触发时发送给AI的系统提示，描述需要AI做什么（string，必填）', repeat: '重复模式：daily=每天重复（默认），once=仅执行一次（string，可选）' }
  },
  list_automations: {
    description: '列出所有已创建的自动化任务',
    params: {}
  },
  delete_automation: {
    description: '删除一个自动化任务',
    params: { id: '自动化任务ID（number）' }
  },
  list_memories: {
    description: '查看 AI 长期记忆中储存的条目。可按类型和关键词筛选，按置信度或时间排序',
    params: { type: '记忆类型：fact/preference/goal/ability/behavior/mental（string，可选）', search: '搜索关键词（string，可选）', sort: '排序方式：confidence（按置信度）/ recent（按更新时间）（string，可选）' }
  },
  get_memory_detail: {
    description: '查看特定记忆条目的完整信息，包括置信度、来源、时间等',
    params: { id: '记忆条目ID（number）' }
  },
  web_search: {
    description: '联网搜索互联网信息。当用户询问实时信息、新闻、最新知识或你需要获取外部资料时使用。支持 Brave / Tavily / Exa / SearchAPI 等搜索引擎。返回搜索结果摘要。注意：当前时间：' + new Date().toISOString().slice(0, 10),
    params: { query: '搜索关键词（string，必填）', max_results: '返回结果数量，最多10个，默认5（number，可选）' }
  },
  read_webpage: {
    description: '抓取并阅读指定网页的正文内容。当用户粘贴一个链接、或明确要求阅读/总结/分析某个网页时使用（无需用户开启网络搜索开关）。采用真实浏览器渲染，能读取普通网页及 JS 动态渲染页面。注意：需登录或需点击交互才显示内容的页面可能读不到正文',
    params: { url: '网页URL（string，必填）', maxChars: '最多返回的正文字符数（number，可选，默认6000）' }
  },
  quest_get: {
    description: '查看任务线系统全貌：主线章节（人生阶段）、素质线（并行成长）、任务状态、进度、徽章、奖励池。可指定章节或任务查看详情。注意：当前数据快照中已包含任务线状态摘要，如需全部任务详情才调用本工具',
    params: { lineId: '章节ID（number，可选，只看该章节的任务）', questId: '任务ID（number，可选，看单个任务详情）' }
  },
  quest_create_line: {
    description: '创建任务线章节。type=main 为人生主线阶段（顺序推进，完成上一章解锁下一章），type=quality 为素质线（并行成长，如英语/体能/阅读/专业技能）。用于把用户的顶层设计/目标拆解为章节',
    params: { name: '章节名称（string，必填）', type: '章节类型：main主线/quality素质线（string，默认quality）', desc: '章节描述，说明这一阶段的意义（string，可选）' }
  },
  quest_update_line: {
    description: '更新任务线章节的名称或描述',
    params: { id: '章节ID（number，必填）', name: '新名称（string，可选）', desc: '新描述（string，可选）' }
  },
  quest_create: {
    description: '创建任务（里程碑）。新任务默认 draft 草稿状态，需用户确认后转 active。任务支持前置依赖（deps，完成 A 解锁 B）和完成条件。desc 是任务的一段完整文字描述（建议 80~200 字），用 GTNH 任务书的风格写（详见下方【GTNH 任务描述风格】）：第二人称"你"的向导口吻，短句+感叹号，轻松俏皮；内容必须包含三方面：目标（做什么）、怎么做（具体路径）、意义/价值（为什么重要，如何推动目标）；可用"是时候...了/别忘了.../你将会..."等句式做骨架，避免说明书腔和空洞口号。kind 区分主线/支线任务：主线任务用金色框表示章节关键里程碑，支线任务用蓝色框。pos 可指定任务在画布上的摆放位置（GTNH 手动画布风格），同一章节内任一任务设了 pos 即整章切为手动布局，未设 pos 的任务会自动排到默认区，箭头仍按 deps 自动连接。⚠️ 依赖设计（DAG）：deps 可引用任意章节的任务 ID 实现跨章节依赖（跨线交织），主线关键任务（kind=main）是锚点，支线任务应挂在锚点上或相互交叉；禁止把所有任务排成 A→B→C 单一直线链，同层级应并行展开',
    params: { lineId: '所属章节ID（number，必填）', title: '任务标题（string，必填）', kind: '任务类型：main主线/side支线（string，默认side）', desc: '任务完整描述（string，可选，一段文字）——GTNH 风格：第二人称"你"的向导口吻+短句+感叹号，含目标/怎么做/意义，可用"是时候...了""别忘了...""你将会..."句式，避免说明书腔', deps: '前置依赖任务ID数组（array of numbers，可选）——可引用任意章节的任务ID（跨章节依赖），用任务线状态摘要中的 [ID:xxx] 关键任务锚点', pos: '任务在画布上的位置 {x,y}（object，可选）——x/y 为非负整数画布坐标；设了即整章切手动布局', milestone: '是否重点标注（boolean，可选）' }
  },
  quest_update: {
    description: '更新任务的标题、描述、类型、依赖、位置或状态。状态可取：draft/active/locked/done/skipped；kind 可取 main/side；pos 为画布坐标 {x,y}（传 null 可清除手动位置回退自动布局）。⚠️ 依赖设计（DAG）：deps 可引用任意章节任务 ID（跨章节依赖），应构成多线交织的 DAG 而非单一直线链，主线关键任务作锚点',
    params: { id: '任务ID（number，必填）', title: '新标题（string，可选）', kind: '任务类型 main主线/side支线（string，可选）', desc: '任务完整描述（string，可选，一段文字，含目标/意义/产出）', status: '新状态（string，可选）', deps: '前置依赖任务ID数组（array of numbers，可选）——可引用任意章节的任务ID（跨章节依赖）', pos: '任务在画布上的位置 {x,y}（object，可选）——传 null 清除手动位置回退自动布局' }
  },
  quest_link_todo: {
    description: '为任务绑定完成条件：完成指定待办后任务条件达成（自动检测）',
    params: { questId: '任务ID（number，必填）', todoId: '待办ID（number，必填）' }
  },
  quest_link_note: {
    description: '为任务绑定完成条件：创建/撰写指定笔记后任务条件达成（自动检测）',
    params: { questId: '任务ID（number，必填）', noteId: '笔记ID（number，必填）' }
  },
  quest_link_timer: {
    description: '为任务绑定完成条件：对指定待办/目标专注计时累计达标后任务条件达成（自动检测）',
    params: { questId: '任务ID（number，必填）', targetId: '计时目标ID（number，必填）', minutes: '累计专注分钟数（number，必填）', targetType: '目标类型：todo/goal（string，可选，默认todo）' }
  },
  quest_add_manual_cond: {
    description: '为任务添加手动打卡条件（如"和导师聊一次"等无法自动检测的抽象条件）',
    params: { questId: '任务ID（number，必填）', label: '条件描述（string，必填）' }
  },
  quest_complete: {
    description: '标记任务完成，触发徽章检测并解锁下游任务。注意：草稿任务需先确认、锁定任务需先完成前置',
    params: { id: '任务ID（number，必填）' }
  },
  quest_skip: {
    description: '跳过任务（GTNH 支持跳过任务，避免被不合理的任务卡死）',
    params: { id: '任务ID（number，必填）' }
  },
  quest_review: {
    description: '复盘任务线：获取当前卡点（长期无进展的任务）、难度失衡、章节进度，并给出下一步行动建议。常用于晚间复盘或用户感到停滞时',
    params: {}
  }
};

function buildToolsSystemPrompt() {
  // Check if web search is enabled for the active conversation
  const _activeConv = getActiveConv();
  const _wsMode = _activeConv?._webSearchMode || null; // 'native' | 'external' | null (Kimi)
  const _wsEnabled = _activeConv?._webSearchEnabled === true || !!_wsMode;
  const _isKimiNative = _wsMode === 'native';
  const _isKimiExternal = _wsMode === 'external';

  let prompt = '你是「我的学习桌面」的内置 AI 助手，核心使命是<b>积极主动地帮助和提醒用户</b>，帮助用户管理学习任务、整理笔记、解答问题、提供学习建议。\n\n';

  prompt += '═══ 系统模块概览 ═══\n';
  prompt += '1. 📋 待办管理：支持多层级任务、截止日期、进度状态、预计时长、正文备注、标签、搜索筛选\n';
  const maxFocusCount = typeof getMaxFocusCount === 'function' ? getMaxFocusCount() : 3;
  prompt += '2. 🎯 今日聚焦：每天最多设置' + maxFocusCount + '个聚焦任务，支持打卡（连续天数统计）\n';
  prompt += '3. 📝 笔记管理：多篇笔记，支持文件夹多级分类，每篇有标题和正文，自动保存。add_note 和 move_note 支持 path 参数自动创建文件夹层级\n';
  prompt += '4. 🔗 快捷访问：常用网站/应用链接，支持分类\n';
  prompt += '5. 🤖 AI 助手：多对话标签页，支持多种模型，可上传附件，可通过工具调用操作系统数据\n';
  if (_wsEnabled) {
    if (_isKimiNative) {
      prompt += '6. 🌐 联网搜索（Kimi 原生）：已开启 $web_search 内置搜索，你的回复会自动调用 Kimi 原生搜索引擎获取最新信息\n';
      prompt += '7. ⏰ 自动化：可在当前对话中创建定时任务，到达指定时间后自动触发 AI 执行\n\n';
    } else {
      prompt += '6. 🌐 网络搜索（已开启）：你可以使用 web_search 工具搜索互联网获取最新信息。用户已开启了「网络搜索」开关，请在适当情况下主动使用 web_search 获取实时信息\n';
      prompt += '7. ⏰ 自动化：可在当前对话中创建定时任务，到达指定时间后自动触发 AI 执行\n\n';
    }
  } else {
    prompt += '6. ⏰ 自动化：可在当前对话中创建定时任务，到达指定时间后自动触发 AI 执行\n\n';
  }

  prompt += '═══ 工具调用说明 ═══\n';
  prompt += '你可以通过返回 <tool_call> 标签来直接操作用户的待办、笔记和链接。格式如下：\n\n';
  prompt += '<tool_call>{"action":"工具名","params":{参数对象}}</tool_call>\n';
  prompt += '注意：开始标签和结束标签必须一致，都使用 tool_call。不要写成 tool_action。\n\n';
  prompt += '可用工具列表：\n';
  for (const [name, tool] of Object.entries(AI_TOOLS)) {
    // Skip web_search if toggle is off, or when using Kimi native search
    if (name === 'web_search') {
      if (!_wsEnabled) continue;
      if (_isKimiNative) continue;
    }
    prompt += `- ${name}: ${tool.description}。参数：${JSON.stringify(tool.params)}\n`;
  }
  prompt += '\n规则：\n';
  prompt += '1. 一个回复可以包含多个 <tool_call>，按操作顺序排列，文本说明放在各工具调用的前后\n';
  prompt += '2. 查询类操作（list_todos / get_todo_detail / list_notes / search_notes / get_note_detail / list_links / get_today_status / get_stats / get_todo_stats）的结果会注入为后续上下文，务必实际调用获取真实数据后再回答，不要编造\n';
  prompt += '   注意：当前数据快照（═══ 当前数据快照 ═══）与工具返回的数据来自同一数据源，查询结果应完全一致。如果快照已包含足够信息，可不必重复调用 list_todos / list_notes / list_links 等查询工具，直接基于快照回答即可。需要详细信息时才调用 get_todo_detail / get_note_detail。\n';
  prompt += '3. 注意：待办支持多层级（父子任务）。一个顶级任务下可能有子任务、孙任务、甚至更多层。list_todos 会以编号方式展示所有层级（如 [1] → [1.1] → [1.1.1]），请根据编号正确理解层级关系。优先使用 list_todos 获取完整层级，需要详细信息时才调用 get_todo_detail。\n';
  prompt += '4. 定时自动化触发时，你会收到一条以「[🤖 系统自动触发]」开头的消息，其中包含任务内容，请直接执行任务并在回复中向用户说明完成了什么。这条消息不是用户手动发送的，而是系统自动注入的\n';
  prompt += '5. 如果用户只是聊天/提问/问知识类问题，不需要调用工具，正常回答即可。\n';
  if (_wsEnabled) {
    if (_isKimiNative) {
      prompt += '   注意：用户已开启「Kimi 原生搜索」，你拥有内置 $web_search 能力，当用户问实时信息、新闻、最新知识等需要联网的问题时，你会自动触发原生搜索并回答\n';
    } else {
      prompt += '   注意：用户已开启「网络搜索」开关，当用户问实时信息、新闻、最新知识等需要外部资料的问题时，请主动使用 web_search 工具联网搜索后回答\n';
    }
  }
  prompt += '6. 请用中文回复\n';
  prompt += '7. 当用户要求「推荐今日聚焦任务」时，请基于现有待办推荐 1 个最重要的聚焦任务即可，不要推荐多个。如果用户明确要求 3 个，再推荐 3 个。\n';
  prompt += '8. 重要：当你返回一个 <tool_call> 后，系统会执行对应的工具，并将结果以「【工具执行结果】」开头的 system 消息注入到对话中。\n';
  prompt += '   你必须仔细阅读该结果：如果结果以 ❌ 开头或以「错误」开头，说明工具调用失败了，请告知用户失败原因，不要假装成功。如果结果以 ✅ 开头，说明成功了。\n';
  prompt += '   另外，add_note 和 update_note 的 content 参数中，请使用真实的换行（回车换行）来分段，不要使用字面上的 \n 字符（即不要在字符串中写反斜杠n），否则笔记内容中会显示成字面 \n 文本而不会换行。\n';
  prompt += '9. 你可以通过 <call_ai> 标签唤起另一个 AI 助手参与对话。格式：<call_ai>{"keyId":"目标 Key 名称","prompt":"要发送的消息"}</call_ai>\n';
  prompt += '   系统会在你回复后自动调用目标 AI，它的回复会以独立消息直接显示在对话中（标注 🔑 Key 名称）。你不需要重复或转发该回复。\n';
  prompt += '10. ⚡ 善用自动化工具构造全时段提醒：\n';
  prompt += '    (a) 你的回复首先要切合用户当前提问和对话主题，不要在无关主题时额外提醒。如果与当前话题相关，可以在主题内做自然延伸进行提醒。\n';
  prompt += '    (b) 更重要的是：利用 <tool_call>{"action":"schedule_automation","params":{"at":"HH:MM","prompt":"提醒内容","repeat":"daily"}}</tool_call> 工具来创建定时自动化任务，让系统在指定时间自动触发提醒，而不是只在聊天中口头提醒。例如：\n';
  prompt += '      - 用户提到明天要交作业 → 设置一个每天 20:00 的「检查作业进度」自动提醒\n';
  prompt += '      - 用户说最近要备考 → 设置一个每天 08:00 的「今日学习计划」自动推送\n';
  prompt += '      - 发现待办中有即将到期却没安排聚焦的任务 → 设置提前一天的「到期提醒」\n';
  prompt += '    总之，优先用 schedule_automation 构造自动化提醒链，让提醒不依赖实时对话。\n';
  prompt += '11. ⭐ 信任工具执行结果：当工具返回以 ✅ 开头的成功结果时，说明操作已成功完成。\n';
  prompt += '    **不要对成功的操作进行「删除后重建」或「验证性查询」**。\n';
  prompt += '    例如：\n';
  prompt += '    - batch_add_todos 返回 ✅ 批量创建成功（已列出所有创建的待办名称和数量）→ 直接回复用户，不要 delete_todo 删除后重新创建\n';
  prompt += '    - update_todo 返回 ✅ 更新成功 → 任务已经更新好了，不要再去 list_todos 验证\n';
  prompt += '    - 工具结果中已经包含了足够的信息（名称、ID、数量等），相信它。\n';
  prompt += '12. 🌐 阅读网页：当用户消息中包含 http(s):// 链接、或明确要求「阅读/总结/分析某个网页」时，请主动调用 read_webpage 工具获取网页正文后再回答。此工具不依赖「网络搜索」开关，只要用户给出 URL 或表达阅读网页的意图即可使用。若 read_webpage 返回 ❌ 错误（如需登录、渲染超时），如实告知用户原因。\n';

  // ── 注入当前 AI 身份 ──
  const currentCfg = getEffectiveApiConfig();
  prompt += `═══ 当前 AI 身份 ═══\n`;
  prompt += `  你的 Key 名称：${currentCfg.name || '未命名'}\n`;
  prompt += `  你的模型：${currentCfg.model || '未知'}\n`;
  prompt += `你可以在回复末尾添加 <call_ai>{"keyId":"其他 Key 名称","prompt":"要发送的消息"}</call_ai> 来调用其他 AI 助手。\n\n`;

  // ── 注入实时上下文 ──
  prompt += '═══ 当前数据快照（只读参考） ═══\n';

  // ── 昨日/今日待办完成情况 ──
  const _todayStr = getTodayStr();
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterdayStr = yesterdayDate.getFullYear() + '-' + String(yesterdayDate.getMonth() + 1).padStart(2, '0') + '-' + String(yesterdayDate.getDate()).padStart(2, '0');

  // Collect completed todos (both current and deleted)
  const todayCompleted = [];
  const yesterdayCompleted = [];
  for (const t of todos) {
    if (t.completedAt === _todayStr) todayCompleted.push(t);
    if (t.completedAt === yesterdayStr) yesterdayCompleted.push(t);
  }
  // Also check the completed log for deleted todos
  const completedLog = loadTodoCompletedLog();
  for (const rec of completedLog) {
    if (rec.completedAt === _todayStr) todayCompleted.push(rec);
    if (rec.completedAt === yesterdayStr) yesterdayCompleted.push(rec);
  }

  if (yesterdayCompleted.length > 0) {
    prompt += `📅 昨日（${yesterdayStr}）完成 ${yesterdayCompleted.length} 个待办：\n`;
    yesterdayCompleted.forEach(t => {
      prompt += `   ✅ ${t.text}\n`;
    });
  }
  if (todayCompleted.length > 0) {
    prompt += `📅 今日（${_todayStr}）已完成 ${todayCompleted.length} 个待办：\n`;
    todayCompleted.forEach(t => {
      prompt += `   ✅ ${t.text}\n`;
    });
  }
  if (yesterdayCompleted.length > 0 || todayCompleted.length > 0) {
    prompt += '\n';
  }

  // 待办概览 — 明确解释总数构成：顶级任务数 + 所有层级子任务数
  const doneCount = todos.filter(t => t.done).length;
  const totalCount = todos.length;
  const topLevelTodos = todos.filter(t => t.parentId === null);
  // 递归统计所有层级的子任务（使用 getAllDescendantIds）
  let actualChildCount = 0;
  for (const t of topLevelTodos) {
    const descendants = getAllDescendantIds(t.id);
    actualChildCount += descendants.length - 1; // 减1排除自身
  }
  const orphanChildren = todos.filter(t => t.parentId !== null && !todos.some(p => p.id === t.parentId));
  prompt += `📋 待办：共 ${totalCount} 个（${topLevelTodos.length} 个顶级任务 + ${actualChildCount} 个子任务` + (orphanChildren.length > 0 ? ` + ${orphanChildren.length} 个孤立子任务` : '') + `），已完成 ${doneCount} 个` + (totalCount > 0 ? `（${Math.round(doneCount/totalCount*100)}%）` : '') + '\n';
  prompt += `  ⚠️ 说明：总数 = 顶级任务数 + 所有层级子任务数。例如 3 个待办 = 1 个顶级任务 + 2 个子任务（可能含多层级）。\n`;
  prompt += `  ⚠️ 注意：以下仅列出顶级任务。如需查看完整的任务层级（含子任务），请调用 list_todos 工具。\n`;
  prompt += `  ⚠️ 注意：快照数据与 list_todos 工具返回的数据来自同一数据源，查询结果应完全一致。如果工具查询结果与快照一致，无需重复查询。\n`;
  if (topLevelTodos.length > 0) {
    prompt += `  以下列出所有顶级任务：\n`;
    topLevelTodos.forEach(t => {
      const childCount = getChildren(t.id).length;
      const timerStr = getTodoTimerStr(t.id);
      prompt += `   [ID:${t.id}] ${t.done ? '✅' : '⬜'} ${t.text}` + (childCount > 0 ? `（含 ${childCount} 个子任务）` : '') + (t.dueDate ? ` 📅${t.dueDate}` : '') + (t.done && t.completedAt ? ` ✅完成于${t.completedAt}` : '') + timerStr + (t.tags && t.tags.length > 0 ? ` 🏷️${t.tags.join(',')}` : '') + '\n';
    });
  }

  // 今日聚焦
  const focusData = getTodayFocusItems();
  const focusItems = focusData.items || [];
  if (focusItems.length > 0) {
    const focusDone = focusItems.filter(i => i.done).length;
    prompt += `🎯 今日聚焦：${focusDone}/${focusItems.length}（已完成数/已设置数）\n`;
    focusItems.forEach(item => {
      prompt += `   ${item.done ? '✅' : '⬜'} [ID:${item.todoId}] ${item.text}\n`;
    });
  } else {
    prompt += '🎯 今日聚焦：未设置\n';
  }

  // 打卡
  const checkinData = loadCheckinData();
  const todayStr = getTodayStr();
  prompt += `🔥 打卡：连续 ${checkinData.streak} 天` + (checkinData.dates.includes(todayStr) ? '（今日已打卡）' : '（今日未打卡）') + '\n';

  // 复习状态
  if (typeof getNotesDueForReview === 'function') {
    const dueNotes = getNotesDueForReview();
    const allNotes = (typeof notes !== 'undefined' && Array.isArray(notes)) ? notes.filter(n => n.type === 'note' && n.content && n.content.trim()) : [];
    const reviewedCount = allNotes.filter(n => n._reviewHistory && n._reviewHistory.length > 0).length;
    const overdueCount = dueNotes.filter(d => {
      const nextDate = typeof calcNextReviewDate === 'function'
        ? toLocalDateStr(calcNextReviewDate(d.note)) : '';
      return nextDate && nextDate < todayStr;
    }).length;
    prompt += `🧠 复习：${dueNotes.length} 篇待复习（${overdueCount} 篇逾期），${reviewedCount}/${allNotes.length} 篇参与间隔复习`;
    if (dueNotes.length > 0) {
      prompt += `\n   ${dueNotes.slice(0, 8).map(d => {
        const n = d.note;
        const count = d.reviewCount;
        const nextDate = typeof calcNextReviewDate === 'function'
          ? toLocalDateStr(calcNextReviewDate(n)) : '';
        const overdue = nextDate && nextDate < todayStr ? ' ⚠️逾期' : '';
        const stage = count === 0 ? '新笔记' : `第${count + 1}轮`;
        return `📖 ${n.title || '未命名'}(${stage}${overdue})`;
      }).join('，')}`;
      if (dueNotes.length > 8) prompt += ` ...等${dueNotes.length}篇`;
    }
    prompt += '\n';
  }

  // 习惯状态
  if (typeof loadHabits === 'function') {
    try {
      const habits = loadHabits();
      const todayStr = getTodayStr();
      const doneCount = habits.filter(h => {
        const c = (h.checkins && h.checkins[todayStr]) ? h.checkins[todayStr] : 0;
        return c >= (h.dailyTarget || 1);
      }).length;
      prompt += `\n💡 今日习惯：${doneCount}/${habits.length} 已完成`;
      if (habits.length > 0) {
        const lines = habits.map(h => {
          const todayCount = (h.checkins && h.checkins[todayStr]) ? h.checkins[todayStr] : 0;
          const met = todayCount >= (h.dailyTarget || 1);
          return `${met ? '✓' : '○'} ${h.emoji || ''} ${h.name} (${todayCount}/${h.dailyTarget || 1})`;
        });
        prompt += `\n   ${lines.join('，')}`;
      }
      prompt += '\n';
    } catch {}
  }

  // 任务线状态（GTNH 式任务书系统）
  if (typeof buildAiSummary === 'function') {
    try {
      prompt += '\n' + buildAiSummary();
    } catch (e) { /* ignore */ }
  }

  // 笔记 & 链接
  const noteFolders = notes.filter(n => n.type === 'folder');
  const noteItems = notes.filter(n => n.type === 'note');
  prompt += `📝 笔记：${noteItems.length} 篇，${noteFolders.length} 个文件夹 | 🔗 快捷访问：${links.length} 个\n`;
  // Numbered hierarchy tree: [1] → [1.1] → [1.1.1], interleaving folders and notes
  if (noteItems.length > 0 || noteFolders.length > 0) {
    const folderMap = {}; noteFolders.forEach(f => { folderMap[f.id] = f; });
    let noteIdx = 0;
    function buildTree(parentId, prefix) {
      // Get child folders and notes at this level
      const childFolders = noteFolders.filter(f => f.parentId === parentId);
      const childNotes = noteItems.filter(n => n.parentId === parentId);
      let localIdx = 1;
      // Folders first
      for (const f of childFolders) {
        const num = prefix ? prefix + '.' + localIdx : String(localIdx);
        const subFolderCount = noteFolders.filter(sf => sf.parentId === f.id).length;
        const subNoteCount = noteItems.filter(sn => sn.parentId === f.id).length;
        const parts = [subNoteCount > 0 ? `${subNoteCount} 篇笔记` : '', subFolderCount > 0 ? `${subFolderCount} 个子文件夹` : ''].filter(Boolean);
        prompt += `   [${num}] 📁 [ID:${f.id}] ${f.title || '未命名'}` + (parts.length > 0 ? `（${parts.join('，')}）` : '') + '\n';
        buildTree(f.id, num);
        localIdx++;
      }
      // Notes after folders at same level
      for (const n of childNotes) {
        const num = prefix ? prefix + '.' + localIdx : String(localIdx);
        const summary = n.summary || '';
        prompt += `   [${num}] 📄 [ID:${n.id}] ${n.title || '未命名'}` + (summary ? ' — ' + summary : '') + '\n';
        localIdx++;
      }
    }
    buildTree(null, '');
  }

  // 自动化任务
  if (automations.length > 0) {
    prompt += `⏰ 自动化任务：${automations.length} 个（${automations.filter(a => a.enabled !== false).length} 个启用）\n`;
    automations.forEach(a => {
      prompt += `   [ID:${a.id}] ${a.enabled === false ? '⏸️' : '▶️'} 每天 ${a.at} → ${a.prompt.slice(0, 30)}${a.prompt.length > 30 ? '…' : ''}` + (a.lastRun ? `（上次：${a.lastRun}）` : '') + '\n';
    });
  }

  // 开发者模式
  if (getSettings().developerMode) {
    prompt += '\n═══ 🧑‍💻 开发者模式 ═══\n';
    prompt += '当前用户是本应用的开发者，你正被集成到应用中作为 AI 助手模块。\n';
    prompt += '在回复时，如果确实有想法，可在末尾附加以下内容（可选，不要凑数）：\n';
    prompt += '- 💡 优化建议：功能、UI/UX、性能等方面的改进建议\n';
    prompt += '- 🔌 建议新增接口：你缺少的数据或操作能力，说明用途\n';
  }

  // ── 注入长期记忆 ──
  if (typeof formatMemoryForPrompt === 'function') {
    prompt += formatMemoryForPrompt();
  }

  return prompt;
}

// ═══════════ Helper: resolve a path array to a parent ID ═══════════
// Traverses/creates intermediate nodes along the path, returns the deepest node's ID.
function resolveTodoPath(pathArr) {
  if (!Array.isArray(pathArr) || pathArr.length === 0) return null;
  let parentId = null;
  for (const segment of pathArr) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // Look for existing todo with matching text and parent
    let existing = todos.find(t => t.text === trimmed && t.parentId === parentId);
    if (existing) {
      parentId = existing.id;
    } else {
      // Create intermediate node
      const newId = genId();
      const newNode = { id: newId, text: trimmed, done: false, parentId, dueDate: null, content: '', tags: [], createdAt: Date.now(), repeat: null };
      todos.push(newNode);
      parentId = newId;
    }
  }
  return parentId;
}

// ═══════════ Helper: execute call_ai as an independent API request ═══════════
// Returns the response text on success, or an error message on failure
async function executeCallAiAndPush(params, conv) {
  const keyId = params.keyId || params.key_id || '';
  const promptText = params.prompt || '';
  if (!keyId) return '⚠️ call_ai 跳过：缺少 keyId';
  if (!promptText) return '⚠️ call_ai 跳过：缺少 prompt';

  const allKeys = loadApiKeys();
  const targetKey = allKeys.find(k => k.id === keyId || k.name === keyId);
  if (!targetKey) return `⚠️ call_ai 失败：未找到 Key "${escapeHtml(keyId)}"`;

  const baseUrl = (targetKey.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  try {
    // Build request params respecting target key's settings
    const targetCfg = {
      model: targetKey.model || 'gpt-3.5-turbo',
      deepThink: targetKey.deepThink === true,
      temperature: targetKey.temperature != null ? targetKey.temperature : 0.7,
      maxTokens: targetKey.maxTokens || 0
    };
    const deepThinkParams = buildDeepThinkParams(targetCfg);
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + targetKey.key
      },
      body: JSON.stringify({
        model: targetCfg.model,
        messages: [
          { role: 'system', content: `你是 ${targetKey.name}（模型：${targetKey.model}），请根据用户的问题给出你的回答。` },
          { role: 'user', content: promptText }
        ],
        temperature: targetCfg.temperature,
        max_tokens: targetCfg.maxTokens || 1024,
        ...deepThinkParams
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return `❌ 调用 ${targetKey.name} 失败：${err.error?.message || `HTTP ${resp.status}`}`;
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content || '（未收到回复）';
    const now = new Date();
    const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    appendMessage(conv, {
      role: 'assistant',
      content: reply,
      time: timeStr,
      keyName: targetKey.name
    });
    safeSaveAiConvs();
    return null; // null = success, no message needed
  } catch (err) {
    return `❌ 调用 ${targetKey.name} 失败：${err.message}`;
  }
}

async function executeToolCall(action, params) {
  switch (action) {
    case 'add_todo': {
      const text = params.text || params.content || '';
      if (!text) return '❌ 创建失败：缺少待办内容';
      // Resolve parent from path or parentId
      let parentId = null;
      let pathInfo = '';
      if (params.path && Array.isArray(params.path) && params.path.length > 0) {
        // Avoid duplicate: if text matches the last path segment, skip it
        const effectivePath = (params.path[params.path.length - 1] === text)
          ? params.path.slice(0, -1)
          : params.path;
        parentId = resolveTodoPath(effectivePath);
        pathInfo = ' → ' + params.path.join(' > ');
      } else {
        parentId = params.parentId || params.parent_id || null;
      }
      const dueDate = params.dueDate || params.due_date || null;
      const content = params.content || '';
      const tagsStr = params.tags || '';
      const tags = tagsStr ? tagsStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
      const repeatVal = params.repeat || null;
      const statusVal = params.status || null;
      const estMinVal = (params.estMinutes && params.estMinutes > 0) ? params.estMinutes : null;
      const newTodo = { id: genId(), text, done: false, parentId, dueDate, content, tags, createdAt: Date.now(), repeat: repeatVal, status: statusVal, estMinutes: estMinVal };
      todos.push(newTodo);
      saveData('study_todos_v2', todos);
      return `✅ 创建成功：${text}（ID:${newTodo.id}）${pathInfo}` + (dueDate ? `，截止：${dueDate}` : '') + (tags.length > 0 ? `，标签：${tags.join('、')}` : '') + (repeatVal ? `，重复：${repeatVal}` : '');
    }
    case 'update_todo': {
      const id = params.id;
      if (!id) return '错误：缺少待办ID';
      const t = findTodo(id);
      if (!t) return `错误：未找到ID为 ${id} 的待办`;
      const changes = [];
      if (params.text !== undefined) { t.text = params.text; changes.push('名称'); }
      if (params.content !== undefined) { t.content = params.content; changes.push('正文'); }
      if (params.dueDate !== undefined || params.due_date !== undefined) { t.dueDate = params.dueDate || params.due_date || null; changes.push('截止日期'); }
      if (params.tags !== undefined) { t.tags = params.tags ? params.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean) : []; changes.push('标签'); }
      if (params.repeat !== undefined) { t.repeat = params.repeat || null; changes.push('重复'); }
      if (params.status !== undefined) { t.status = params.status || null; changes.push('状态'); }
      if (params.estMinutes !== undefined) { t.estMinutes = (params.estMinutes && params.estMinutes > 0) ? params.estMinutes : null; changes.push('预计时长'); }
      if (changes.length === 0) return '未做任何修改';
      saveData('study_todos_v2', todos);
      return `✅ 已更新待办"${t.text}"（修改了：${changes.join('、')}）`;
    }
    case 'delete_todo': {
      const id = params.id;
      if (!id) return '错误：缺少待办ID';
      const t = findTodo(id);
      if (!t) return `错误：未找到ID为 ${id} 的待办`;
      const text = t.text;
      // 软删除：与 UI 行为一致（已完成的子任务先记入完成日志，再整体移入回收站），避免数据丢失
      const descendantIds = getAllDescendantIds(id);
      const completedLog = loadTodoCompletedLog();
      for (const did of descendantIds) {
        const dt = findTodo(did);
        if (dt && dt.completedAt) {
          completedLog.push({ id: dt.id, text: dt.text, completedAt: dt.completedAt, deletedAt: formatDate(new Date()) });
        }
      }
      saveTodoCompletedLog(completedLog);
      if (typeof moveToTrash === 'function') {
        moveToTrash('todos', t);
      } else {
        todos = todos.filter(t2 => !descendantIds.includes(t2.id));
        saveData('study_todos_v2', todos);
      }
      return `✅ 已删除待办：${text}`;
    }
    case 'toggle_todo': {
      const id = params.id;
      if (!id) return '错误：缺少待办ID';
      const t = findTodo(id);
      if (!t) return `错误：未找到ID为 ${id} 的待办`;
      t.done = !t.done;
      if (t.done) {
        t.completedAt = getTodayStr();
        const descendantIds = getAllDescendantIds(id).filter(did => did !== id);
        for (const did of descendantIds) { const d = findTodo(did); if (d) { d.done = true; if (!d.completedAt) d.completedAt = getTodayStr(); } }
      } else {
        delete t.completedAt;
      }
      saveData('study_todos_v2', todos);
      if (typeof tlOnTodosChanged === 'function') tlOnTodosChanged();
      return `✅ 已将待办"${t.text}"标记为${t.done ? '已完成' : '未完成'}`;
    }
    case 'move_todo': {
      const todoId = Number(params.id);
      if (!todoId) return '错误：缺少待办ID';
      const t = findTodo(todoId);
      if (!t) return `错误：未找到ID为 ${todoId} 的待办`;
      let newParent = null;
      if (params.parentId) {
        newParent = Number(params.parentId);
      } else if (params.path && Array.isArray(params.path) && params.path.length > 0) {
        newParent = resolveTodoPath(params.path);
      }
      t.parentId = newParent;
      saveData('study_todos_v2', todos);
      const parentName = t.parentId ? (findTodo(t.parentId)?.text || '根目录') : '根目录';
      return `✅ 已移动待办"${t.text}"到「${parentName}」下`;
    }
    case 'list_todos': {
      const search = (params.search || '').toLowerCase();
      const tagsFilter = params.tags ? params.tags.split(/[,，]/).map(s => s.trim().toLowerCase()).filter(Boolean) : null;
      const dueFrom = params.dueFrom || params.due_from || null;
      const dueTo = params.dueTo || params.due_to || null;
      const completedFilter = params.completed !== undefined ? params.completed : null;

      let list = todos.slice();
      // Search in text and content
      if (search) {
        list = list.filter(t => t.text.toLowerCase().includes(search) || (t.content || '').toLowerCase().includes(search));
      }
      // Tag filter (match any)
      if (tagsFilter && tagsFilter.length > 0) {
        list = list.filter(t => {
          const todoTags = (t.tags || []).map(tag => tag.toLowerCase());
          return tagsFilter.some(ft => todoTags.includes(ft));
        });
      }
      // Due date range
      if (dueFrom) {
        list = list.filter(t => t.dueDate && t.dueDate >= dueFrom);
      }
      if (dueTo) {
        list = list.filter(t => t.dueDate && t.dueDate <= dueTo);
      }
      // Completed filter
      if (completedFilter !== null) {
        list = list.filter(t => t.done === completedFilter);
      }

      if (list.length === 0) {
        let reason = '📋 当前没有待办事项。';
        if (search) reason = `📋 没有找到包含"${params.search}"的待办。`;
        else if (tagsFilter) reason = `📋 没有找到标签包含"${params.tags}"的待办。`;
        else if (completedFilter === true) reason = '📋 没有已完成的待办。';
        else if (completedFilter === false) reason = '📋 没有未完成的待办。';
        return reason;
      }

      const topLevel = list.filter(t => t.parentId === null);

      let result = `📋 待办事项列表（共${list.length}个）\n`;
      if (search) result = `📋 搜索"${params.search}"结果（共${list.length}个）\n`;
      if (tagsFilter) result = `📋 标签"${params.tags}"筛选结果（共${list.length}个）\n`;
      result += '\n';
      // 结构化层级展示：使用数字编号，避免树形图的理解偏差
      // 格式：顶级编号 → 子编号 → 孙编号，如 "1 → 1.1 → 1.1.1"
      let globalIdx = 1;
      topLevel.forEach(t => {
        const status = t.done ? '✅' : '⬜';
        const timerStr = getTodoTimerStr(t.id);
        const statusLabel = t.status ? ` [${t.status}]` : '';
        const estLabel = t.estMinutes ? ` ⏳${t.estMinutes}分钟` : '';
        result += `[${globalIdx}] ${status} [ID:${t.id}] ${t.text}` + statusLabel + estLabel + (t.dueDate ? ` 📅${t.dueDate}` : '') + (t.done && t.completedAt ? ` ✅完成于${t.completedAt}` : '') + timerStr + (t.tags && t.tags.length > 0 ? ` 🏷️${t.tags.join(',')}` : '') + '\n';
        // 递归展示所有层级子任务
        function renderChildren(parentId, prefix) {
          const directKids = list.filter(c => c.parentId === parentId);
          let subIdx = 1;
          for (const c of directKids) {
            const childPrefix = prefix + '.' + subIdx;
            const childTimerStr = getTodoTimerStr(c.id);
            const cStatusLabel = c.status ? ` [${c.status}]` : '';
            const cEstLabel = c.estMinutes ? ` ⏳${c.estMinutes}分钟` : '';
            result += `[${childPrefix}] ${c.done ? '✅' : '⬜'} [ID:${c.id}] ${c.text}` + cStatusLabel + cEstLabel + (c.dueDate ? ` 📅${c.dueDate}` : '') + (c.done && c.completedAt ? ` ✅完成于${c.completedAt}` : '') + childTimerStr + (c.tags && c.tags.length > 0 ? ` 🏷️${c.tags.join(',')}` : '') + '\n';
            renderChildren(c.id, childPrefix);
            subIdx++;
          }
        }
        renderChildren(t.id, String(globalIdx));
        globalIdx++;
      });
      return result;
    }
    case 'get_todo_detail': {
      const id = params.id;
      if (!id) return '错误：缺少待办ID';
      const t = findTodo(id);
      if (!t) return `错误：未找到ID为 ${id} 的待办`;
      let result = `📋 待办详情 [ID:${t.id}]\n`;
      result += `📌 名称：${t.text}\n`;
      result += `✅ 状态：${t.done ? '已完成' : '未完成'}\n`;
      if (t.done && t.completedAt) result += `✅ 完成日期：${t.completedAt}\n`;
      if (t.dueDate) result += `📅 截止日期：${t.dueDate}\n`;
      const timerStr = getTodoTimerStr(t.id);
      if (timerStr) result += `⏱️ 计时：${timerStr.trim()}\n`;
      if (t.tags && t.tags.length > 0) result += `🏷️ 标签：${t.tags.join('、')}\n`;
      if (t.content) result += `📝 正文/备注：${t.content}\n`;
      if (t.parentId) {
        const parent = findTodo(t.parentId);
        if (parent) result += `📂 父任务：[ID:${parent.id}] ${parent.text}\n`;
      }
      // Recursively show all descendant todos
      const allDescendantIds = getAllDescendantIds(id).filter(did => did !== id);
      if (allDescendantIds.length > 0) {
        result += `\n📎 子任务（共${allDescendantIds.length}个）：\n`;
        let subIdx = 1;
        function renderDetailChildren(parentId, prefix) {
          const directKids = getChildren(parentId);
          for (const c of directKids) {
            const childPrefix = prefix ? prefix + '.' + subIdx : String(subIdx);
            const childTimerStr = getTodoTimerStr(c.id);
            result += `  [${childPrefix}] ${c.done ? '✅' : '⬜'} [ID:${c.id}] ${c.text}` + (c.dueDate ? ` 📅${c.dueDate}` : '') + (c.done && c.completedAt ? ` ✅完成于${c.completedAt}` : '') + childTimerStr + '\n';
            const savedSubIdx = subIdx;
            subIdx++;
            renderDetailChildren(c.id, childPrefix);
            subIdx = savedSubIdx + 1;
          }
        }
        renderDetailChildren(id, '');
      }
      return result;
    }
    case 'get_today_status': {
      const focusData = getTodayFocusItems();
      const focusItems = focusData.items || [];
      const focusDone = focusItems.filter(i => i.done).length;
      const checkinData = loadCheckinData();
      const todayStr = getTodayStr();
      const isCheckedIn = checkinData.dates.includes(todayStr);

      let result = '📅 今日状态报告\n';
      result += `🔥 打卡：连续 ${checkinData.streak} 天` + (isCheckedIn ? '，今日已打卡 ✅' : '，今日未打卡') + '\n\n';
      result += `🎯 今日聚焦：${focusDone}/${focusItems.length}\n`;
      if (focusItems.length > 0) {
        focusItems.forEach((item, i) => {
          const todo = todos.find(t => t.id === item.todoId);
          result += `   ${item.done ? '✅' : '⬜'} [ID:${item.todoId}] ${item.text}`;
          if (todo && todo.dueDate) result += ` 📅${todo.dueDate}`;
          if (todo && todo.done && todo.completedAt) result += ` ✅完成于${todo.completedAt}`;
          if (todo && todo.tags && todo.tags.length > 0) result += ` 🏷️${todo.tags.join(',')}`;
          result += '\n';
          // Show children of focus tasks
          if (todo) {
            const children = getChildren(item.todoId);
            children.forEach(c => {
              result += `      └ ${c.done ? '✅' : '⬜'} [ID:${c.id}] ${c.text}` + (c.dueDate ? ` 📅${c.dueDate}` : '') + (c.done && c.completedAt ? ` ✅完成于${c.completedAt}` : '') + '\n';
            });
          }
        });
        if (focusDone === focusItems.length && focusItems.length > 0) {
          result += '\n🎉 太棒了！今日聚焦任务全部完成！';
        } else if (focusDone > 0) {
          result += `\n💪 已完成 ${focusDone} 项，还剩 ${focusItems.length - focusDone} 项，继续加油！`;
        } else {
          result += '\n📌 今日聚焦尚未开始，赶快行动吧！';
        }
      } else {
        const maxFocus = typeof getMaxFocusCount === 'function' ? getMaxFocusCount() : 3;
        result += '\n💡 还没有设置今日聚焦，去「今天」页面从待办中选择' + maxFocus + '个最重要的任务吧。';
      }

      // 昨日/今日待办完成情况
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterdayStr = yesterdayDate.getFullYear() + '-' + String(yesterdayDate.getMonth() + 1).padStart(2, '0') + '-' + String(yesterdayDate.getDate()).padStart(2, '0');

      const todayCompleted = [];
      const yesterdayCompleted = [];
      for (const t of todos) {
        if (t.completedAt === todayStr) todayCompleted.push(t);
        if (t.completedAt === yesterdayStr) yesterdayCompleted.push(t);
      }
      const completedLog = loadTodoCompletedLog();
      for (const rec of completedLog) {
        if (rec.completedAt === todayStr) todayCompleted.push(rec);
        if (rec.completedAt === yesterdayStr) yesterdayCompleted.push(rec);
      }

      if (yesterdayCompleted.length > 0) {
        result += `\n📅 昨日完成 ${yesterdayCompleted.length} 个待办：\n`;
        yesterdayCompleted.forEach(t => { result += `   ✅ ${t.text}\n`; });
      }
      if (todayCompleted.length > 0) {
        result += `\n📅 今日已完成 ${todayCompleted.length} 个待办：\n`;
        todayCompleted.forEach(t => { result += `   ✅ ${t.text}\n`; });
      }

      const allDone = todos.filter(t => t.done).length;
      result += `\n\n📋 全局待办：${todos.length} 个，已完成 ${allDone} 个` + (todos.length > 0 ? `（${Math.round(allDone/todos.length*100)}%）` : '');
      return result;
    }
    case 'set_focus_task': {
      const todoId = params.todoId || params.todo_id;
      const data = loadFocusData();
      // Initialize if needed
      const todayStr = getTodayStr();
      if (!data._date || data._date !== todayStr) {
        data._date = todayStr;
        data.items = [];
      }
      if (!data.items) data.items = [];

      const maxFocus = typeof getMaxFocusCount === 'function' ? getMaxFocusCount() : 3;

      if (todoId === null || todoId === undefined || todoId === '') {
        // Clear all focus tasks
        data.items = [];
        saveFocusData(data);
        return '✅ 已清空今日聚焦任务';
      }

      const todo = findTodo(todoId);
      if (!todo) return `错误：未找到ID为 ${todoId} 的待办`;
      if (data.items.length >= maxFocus) return `错误：今日聚焦最多${maxFocus}个任务，当前已有${data.items.length}个。请先移除一些再添加。`;
      if (data.items.some(i => i.todoId === todoId)) return `"${todo.text}"已经是今日聚焦任务了`;

      data.items.push({ todoId: todo.id, text: todo.text, done: todo.done });
      saveFocusData(data);
      return `✅ 已将"${todo.text}"设为今日聚焦任务（${data.items.length}/${maxFocus}）`;
    }
    case 'get_focus_tasks': {
      const focusData = getTodayFocusItems();
      const focusItems = focusData.items || [];
      if (focusItems.length === 0) return '🎯 今日尚未设置聚焦任务。';
      const focusDone = focusItems.filter(i => i.done).length;
      let result = `🎯 今日聚焦任务（${focusDone}/${focusItems.length}）\n\n`;
      focusItems.forEach((item, idx) => {
        result += `${idx + 1}. ${item.done ? '✅' : '⬜'} [ID:${item.todoId}] ${item.text}\n`;
        // Show associated todo info
        const todo = todos.find(t => t.id === item.todoId);
        if (todo && todo.dueDate) result += `   截止日期：${todo.dueDate}\n`;
      });
      return result;
    }
    case 'get_stats': {
      const doneCount = todos.filter(t => t.done).length;
      const totalTodos = todos.length;
      const completionRate = totalTodos > 0 ? Math.round(doneCount / totalTodos * 100) : 0;
      const topLevelTodos = todos.filter(t => t.parentId === null);
      const checkinData = loadCheckinData();

      let result = '📊 全局统计摘要\n\n';
      result += `📋 待办事项：共 ${totalTodos} 个\n`;
      result += `   ✅ 已完成：${doneCount} 个（${completionRate}%）\n`;
      result += `   ⬜ 未完成：${totalTodos - doneCount} 个\n`;
      result += `   📂 顶级任务：${topLevelTodos.length} 个\n`;
      result += `   📅 有截止日期：${todos.filter(t => t.dueDate).length} 个\n\n`;

      const focusData = getTodayFocusItems();
      const focusItems = focusData.items || [];
      const focusDone = focusItems.filter(i => i.done).length;
      result += `🎯 今日聚焦：${focusDone}/${focusItems.length}\n\n`;

      result += `🔥 连续打卡：${checkinData.streak} 天\n\n`;
      result += `📝 笔记：${notes.length} 篇\n`;
      result += `🔗 快捷访问：${links.length} 个（${new Set(links.map(l => l.category || '默认分类')).size} 个分类）\n\n`;

      // 昨日/今日待办完成情况
      const todayStr = getTodayStr();
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterdayStr = yesterdayDate.getFullYear() + '-' + String(yesterdayDate.getMonth() + 1).padStart(2, '0') + '-' + String(yesterdayDate.getDate()).padStart(2, '0');
      const todayCompleted = [];
      const yesterdayCompleted = [];
      for (const t of todos) {
        if (t.completedAt === todayStr) todayCompleted.push(t);
        if (t.completedAt === yesterdayStr) yesterdayCompleted.push(t);
      }
      const completedLog = loadTodoCompletedLog();
      for (const rec of completedLog) {
        if (rec.completedAt === todayStr) todayCompleted.push(rec);
        if (rec.completedAt === yesterdayStr) yesterdayCompleted.push(rec);
      }
      if (yesterdayCompleted.length > 0) {
        result += `📅 昨日完成 ${yesterdayCompleted.length} 个待办：\n`;
        yesterdayCompleted.forEach(t => { result += `   ✅ ${t.text}\n`; });
      }
      if (todayCompleted.length > 0) {
        result += `📅 今日已完成 ${todayCompleted.length} 个待办：\n`;
        todayCompleted.forEach(t => { result += `   ✅ ${t.text}\n`; });
      }
      if (yesterdayCompleted.length > 0 || todayCompleted.length > 0) result += '\n';

      if (completionRate >= 80) result += '🌟 完成率优秀，继续保持！';
      else if (completionRate >= 50) result += '👍 进度不错，再加把劲！';
      else if (totalTodos > 0) result += '📌 还有很多待办需要完成，加油！';
      else result += '✨ 开始创建你的第一个待办吧！';

      return result;
    }
    case 'get_todo_stats': {
      const tag = (params.tag || '').toLowerCase();
      const dueFrom = params.dueFrom || params.due_from || null;
      const dueTo = params.dueTo || params.due_to || null;
      const completedOnly = params.completedOnly || params.completed_only || false;

      let filtered = todos.slice();
      if (tag) filtered = filtered.filter(t => (t.tags || []).some(tg => tg.toLowerCase() === tag));
      if (dueFrom) filtered = filtered.filter(t => t.dueDate && t.dueDate >= dueFrom);
      if (dueTo) filtered = filtered.filter(t => t.dueDate && t.dueDate <= dueTo);
      if (completedOnly) filtered = filtered.filter(t => t.done);

      const total = filtered.length;
      const completed = filtered.filter(t => t.done).length;
      const now = new Date();
      const todayStr = getTodayStr();
      const overdue = filtered.filter(t => !t.done && t.dueDate && t.dueDate < todayStr).length;

      // Build per-date stats for the last 14 days
      const byDate = [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const created = filtered.filter(t => {
          // Estimate creation date from id (timestamp-based)
          const ts = t.id;
          const cd = new Date(ts);
          return cd.getFullYear() + '-' + String(cd.getMonth() + 1).padStart(2, '0') + '-' + String(cd.getDate()).padStart(2, '0') === ds;
        }).length;
        const done = filtered.filter(t => {
          if (!t.done || !t.completedAt) return false;
          return t.completedAt === ds;
        }).length;
        if (created > 0 || done > 0) {
          byDate.push({ date: ds, completed: done, created });
        }
      }

      let result = '📊 待办统计\n\n';
      if (tag) result = `📊 待办统计（标签：${tag}）\n\n`;
      if (dueFrom || dueTo) result = `📊 待办统计（${dueFrom || '不限'} ~ ${dueTo || '不限'}）\n\n`;
      result += `📋 总数：${total} 个\n`;
      result += `✅ 已完成：${completed} 个` + (total > 0 ? `（${Math.round(completed / total * 100)}%）` : '') + '\n';
      result += `⬜ 未完成：${total - completed} 个\n`;
      result += `⏰ 已逾期：${overdue} 个\n\n`;

      if (byDate.length > 0) {
        result += '📈 近14天趋势：\n';
        byDate.forEach(d => {
          result += `   ${d.date}：新建 ${d.created} 个，完成 ${d.completed} 个\n`;
        });
      } else {
        result += '📈 近14天无数据。\n';
      }

      return result;
    }
    case 'get_review_status': {
      if (typeof getNotesDueForReview !== 'function') return '⚠️ 复习系统未加载。';
      const dueNotes = getNotesDueForReview();
      const allNotes = (typeof notes !== 'undefined' && Array.isArray(notes))
        ? notes.filter(n => n.type === 'note' && n.content && n.content.trim()) : [];
      const reviewedNotes = allNotes.filter(n => n._reviewHistory && n._reviewHistory.length > 0);

      // Review round distribution
      const roundDist = {};
      for (const n of reviewedNotes) {
        const r = (n._reviewHistory || []).length;
        roundDist[r] = (roundDist[r] || 0) + 1;
      }
      const roundLines = Object.entries(roundDist)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([r, c]) => `第${r}轮：${c} 篇`)
        .join('，');

      let result = `🧠 复习状态\n\n`;
      result += `📊 概览：\n`;
      result += `  - 参与间隔复习：${reviewedNotes.length}/${allNotes.length} 篇笔记\n`;
      result += `  - 待复习：${dueNotes.length} 篇\n`;
      result += `  - 复习轮次分布：${roundLines || '无数据'}\n`;
      result += `  - 总复习次数：${reviewedNotes.reduce((s, n) => s + (n._reviewHistory || []).length, 0)} 次\n\n`;

      if (dueNotes.length > 0) {
        result += `📖 待复习笔记列表：\n`;
        dueNotes.forEach((d, i) => {
          const n = d.note; // getNotesDueForReview 返回 {note, reviewCount, nextReviewDate} 包装对象
          const count = d.reviewCount;
          const intervalDays = typeof calcNextReviewDate === 'function' ? (() => {
            const next = calcNextReviewDate(n);
            const lastReview = n._reviewHistory && n._reviewHistory.length > 0
              ? new Date(n._reviewHistory[n._reviewHistory.length - 1]) : null;
            if (lastReview) {
              const diff = Math.round((next - lastReview) / 86400000);
              return diff;
            }
            return n._reviewDays || 1;
          })() : (n._reviewDays || 1);
          const nextDate = typeof calcNextReviewDate === 'function'
            ? toLocalDateStr(calcNextReviewDate(n)) : '';
          const isOverdue = nextDate && nextDate < getTodayStr();
          const overdueTag = isOverdue ? ' ⚠️逾期' : '';
          const reviewStage = count === 0 ? '新笔记' : `第${count+1}轮（间隔${intervalDays}天）`;
          result += `  ${i+1}. 📖 [ID:${n.id}] ${n.title || '未命名'} — ${reviewStage} → ${nextDate}${overdueTag}\n`;
        });
      } else {
        result += `✅ 暂无待复习笔记，太棒了！\n`;
      }

      return result;
    }
    case 'get_habits_status': {
      if (typeof loadHabits !== 'function') return '⚠️ 习惯系统未加载。';
      try {
        const habits = loadHabits();
        const todayStr = getTodayStr();
        if (habits.length === 0) return '💡 你还没有创建任何习惯。去「习惯」页面添加吧！';

        let result = '💡 今日习惯状态\n\n';
        const doneCount = habits.filter(h => {
          const c = (h.checkins && h.checkins[todayStr]) ? h.checkins[todayStr] : 0;
          return c >= (h.dailyTarget || 1);
        }).length;
        result += `📊 完成率：${doneCount}/${habits.length}\n\n`;

        // Get current week days
        const now = new Date();
        const dayOfWeek = now.getDay();
        const monday = new Date(now);
        monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

        habits.forEach((h, i) => {
          const todayCount = (h.checkins && h.checkins[todayStr]) ? h.checkins[todayStr] : 0;
          const todayMet = todayCount >= (h.dailyTarget || 1);
          const statusIcon = todayMet ? '✅' : (todayCount > 0 ? '🔄' : '⬜');

          // Calculate streak
          let streak = 0;
          const checkDate = new Date();
          while (true) {
            const ds = checkDate.toISOString().slice(0, 10);
            const c = (h.checkins && h.checkins[ds]) ? h.checkins[ds] : 0;
            if (c >= (h.dailyTarget || 1)) { streak++; checkDate.setDate(checkDate.getDate() - 1); }
            else break;
          }

          // Weekly progress (Mon-Sun this week)
          let weekDone = 0;
          for (let d = 0; d < 7; d++) {
            const wd = new Date(monday);
            wd.setDate(monday.getDate() + d);
            const wds = wd.toISOString().slice(0, 10);
            const c = (h.checkins && h.checkins[wds]) ? h.checkins[wds] : 0;
            if (c >= (h.dailyTarget || 1)) weekDone++;
          }

          result += `${i + 1}. ${statusIcon} ${h.emoji || ''} ${h.name}\n`;
          result += `   今日：${todayCount}/${h.dailyTarget || 1}  ${todayMet ? '✓已达标' : (todayCount > 0 ? '进行中' : '未开始')}\n`;
          result += `   连续：${streak} 天  |  本周达标：${weekDone}/7 天\n`;
          if (h.notes) result += `   备注：${h.notes}\n`;
        });

        return result;
      } catch (e) { return '⚠️ 获取习惯数据失败：' + e.message; }
    }
    case 'batch_update_todos': {
      const ids = params.ids || [];
      const action = params.action || '';
      if (!ids.length) return '错误：缺少待办ID列表';
      if (!action) return '错误：缺少操作类型（toggle_completed/set_tags/set_due_date/delete）';

      let affected = 0;
      switch (action) {
        case 'toggle_completed': {
          const targetDone = params.value !== undefined ? Boolean(params.value) : undefined;
          ids.forEach(id => {
            const t = findTodo(id);
            if (t) {
              t.done = targetDone !== undefined ? targetDone : !t.done;
              if (t.done) t.completedAt = getTodayStr();
              else delete t.completedAt;
              affected++;
            }
          });
          saveData('study_todos_v2', todos);
          if (typeof tlOnTodosChanged === 'function') tlOnTodosChanged();
          return `✅ 已批量${targetDone === true ? '勾选' : targetDone === false ? '取消勾选' : '切换'} ${affected} 个待办`;
        }
        case 'set_tags': {
          const tagsVal = params.value || '';
          const tags = tagsVal ? tagsVal.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
          ids.forEach(id => {
            const t = findTodo(id);
            if (t) { t.tags = tags; affected++; }
          });
          saveData('study_todos_v2', todos);
          return `✅ 已为 ${affected} 个待办设置标签：${tags.join('、') || '(无)'}`;
        }
        case 'set_due_date': {
          const dateVal = params.value || null;
          ids.forEach(id => {
            const t = findTodo(id);
            if (t) { t.dueDate = dateVal; affected++; }
          });
          saveData('study_todos_v2', todos);
          return `✅ 已为 ${affected} 个待办设置截止日期：${dateVal || '(已清除)'}`;
        }
        case 'delete': {
          const allDescendants = new Set();
          ids.forEach(id => {
            getAllDescendantIds(id).forEach(did => allDescendants.add(did));
          });
          const before = todos.length;
          todos = todos.filter(t => !allDescendants.has(t.id));
          affected = before - todos.length;
          saveData('study_todos_v2', todos);
          return `✅ 已批量删除 ${affected} 个待办（含子任务）`;
        }
        default:
          return `错误：不支持的操作类型 "${action}"。支持：toggle_completed, set_tags, set_due_date, delete`;
      }
    }
    case 'batch_add_todos': {
      const items = params.todos || [];
      if (!items.length) return '⚠️ batch_add_todos: 未提供任何待办数据';
      const results = [];
      let createdCount = 0;
      for (const item of items) {
        if (!item.text) { results.push(`⚠️ 跳过空内容项`); continue; }
        let parentId = null;
        if (item.path && Array.isArray(item.path) && item.path.length > 0) {
          // Avoid duplicate: if text matches the last path segment, the todo itself
          // IS that segment — skip it in path resolution
          const effectivePath = (item.path[item.path.length - 1] === item.text)
            ? item.path.slice(0, -1)
            : item.path;
          parentId = resolveTodoPath(effectivePath);
        } else if (item.parentId) {
          parentId = item.parentId;
        }
        const dueDate = item.dueDate || null;
        const content = item.content || '';
        const tagsStr = item.tags || '';
        const tags = typeof tagsStr === 'string' ? tagsStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
        const repeatVal = item.repeat || null;
        const statusVal = item.status || null;
        const estMinVal = (item.estMinutes && item.estMinutes > 0) ? item.estMinutes : null;
        const newTodo = { id: genId(), text: item.text, done: false, parentId, dueDate, content, tags, createdAt: Date.now(), repeat: repeatVal, status: statusVal, estMinutes: estMinVal };
        todos.push(newTodo);
        results.push(item.text);
        createdCount++;
      }
      saveData('study_todos_v2', todos);
      return `✅ 批量创建成功：共创建 ${createdCount} 个待办\n${results.map((r, i) => `  ${i+1}. ${r}`).join('\n')}`;
    }
    case 'add_note': {
      const title = params.title || '未命名笔记';
      let content = params.content || '';
      // Replace literal \n with real newlines (keep LaTeX \[ and \( markers intact)
      content = content.replace(/\\n/g, '\n');
      let folderId = null;
      if (params.folderId) {
        folderId = Number(params.folderId);
      } else if (params.path && Array.isArray(params.path) && params.path.length > 0) {
        if (typeof resolveNoteFolderPath === 'function') {
          // Avoid duplicate: if title matches the last path segment, skip it
          const effectivePath = (params.path[params.path.length - 1] === title)
            ? params.path.slice(0, -1)
            : params.path;
          folderId = resolveNoteFolderPath(effectivePath);
        }
      }
      const newNote = {
        id: genId(), type: 'note', title, content,
        parentId: folderId,
        summary: '',
        _summaryFresh: false,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      notes.push(newNote);
      saveData('study_notes_v2', notes);
      return `✅ 已创建笔记：${title} [ID:${newNote.id}]`;
    }
    case 'update_note': {
      const id = Number(params.id);
      if (!id) return '错误：缺少笔记ID';
      const note = notes.find(n => n.id === id);
      if (!note) return `错误：未找到ID为 ${params.id} 的笔记`;
      if (params.title !== undefined) note.title = params.title;
      if (params.content !== undefined) note.content = params.content.replace(/\\n/g, '\n');
      note.updatedAt = new Date().toISOString();
      saveData('study_notes_v2', notes);
      return `✅ 已更新笔记：${note.title}`;
    }
    case 'move_note': {
      const noteId = Number(params.id);
      if (!noteId) return '错误：缺少笔记ID';
      const note = notes.find(n => n.id === noteId);
      if (!note) return `错误：未找到ID为 ${noteId} 的笔记`;
      let targetFolder = null;
      if (params.folderId) {
        targetFolder = Number(params.folderId);
      } else if (params.path && Array.isArray(params.path) && params.path.length > 0) {
        if (typeof resolveNoteFolderPath === 'function') {
          targetFolder = resolveNoteFolderPath(params.path);
        } else {
          return '错误：resolveNoteFolderPath 不可用';
        }
      }
      const folderName = targetFolder
        ? (notes.find(f => f.type === 'folder' && f.id === targetFolder)?.title || '根目录')
        : '根目录';
      note.parentId = targetFolder;
      saveData('study_notes_v2', notes);
      return `✅ 已移动笔记「${note.title}」到「${folderName}」`;
    }
    case 'delete_note': {
      const id = Number(params.id);
      if (!id) return '错误：缺少笔记ID';
      const note = notes.find(n => n.id === id);
      if (!note) return `错误：未找到ID为 ${id} 的笔记`;
      notes = notes.filter(n => n.id !== id);
      if (activeNoteId === id) activeNoteId = notes[0] ? notes[0].id : null;
      saveData('study_notes_v2', notes);
      return `✅ 已删除笔记：${note.title}`;
    }
    case 'list_notes': {
      if (notes.length === 0) return '📝 当前没有笔记。';
      // Trigger summary freshness check for current note (fire-and-forget)
      if (typeof checkAndUpdateSummary === 'function') checkAndUpdateSummary();
      const noteFolders = notes.filter(n => n.type === 'folder');
      const noteItems = notes.filter(n => n.type === 'note');

      let result = `📝 笔记概览：${noteFolders.length} 个文件夹，${noteItems.length} 篇笔记\n\n`;

      // Numbered hierarchy: [1] → [1.1], interleaving folders and notes
      function buildTree(parentId, prefix) {
        const childFolders = noteFolders.filter(f => f.parentId === parentId);
        const childNotes = noteItems.filter(n => n.parentId === parentId);
        let localIdx = 1;
        for (const f of childFolders) {
          const num = prefix ? prefix + '.' + localIdx : String(localIdx);
          const subFolderCount = noteFolders.filter(sf => sf.parentId === f.id).length;
          const subNoteCount = noteItems.filter(sn => sn.parentId === f.id).length;
          const parts = [subNoteCount > 0 ? `${subNoteCount} 篇笔记` : '', subFolderCount > 0 ? `${subFolderCount} 个子文件夹` : ''].filter(Boolean);
          result += `[${num}] 📁 [ID:${f.id}] ${f.title || '未命名'}` + (parts.length > 0 ? `（${parts.join('，')}）` : '') + '\n';
          buildTree(f.id, num);
          localIdx++;
        }
        for (const n of childNotes) {
          const num = prefix ? prefix + '.' + localIdx : String(localIdx);
          const summary = n.summary || '';
          result += `[${num}] 📄 [ID:${n.id}] ${n.title || '未命名'}` + (summary ? ' — 摘要：' + summary : '') + '\n';
          localIdx++;
        }
      }
      buildTree(null, '');

      if (result === `📝 笔记概览：${noteFolders.length} 个文件夹，${noteItems.length} 篇笔记\n\n`) {
        result += '(空)';
      }
      return result;
    }
    case 'search_notes': {
      const query = (params.query || '').toLowerCase();
      if (!query) return '错误：缺少搜索关键词';
      const matches = notes.filter(n => {
        const title = (n.title || '').toLowerCase();
        const content = (n.content || '').toLowerCase();
        return title.includes(query) || content.includes(query);
      });
      if (matches.length === 0) return `📝 没有找到包含"${params.query}"的笔记。`;
      // Trigger summary freshness check (fire-and-forget)
      if (typeof checkAndUpdateSummary === 'function') checkAndUpdateSummary();
      let result = `📝 搜索"${params.query}"结果（共${matches.length}篇）：\n\n`;
      matches.forEach(n => {
        const title = n.title || '未命名';
        const summary = n.summary || '';
        const content = n.content || '';
        // Extract a highlight snippet around the query
        let snippet = '';
        const idx = content.toLowerCase().indexOf(query);
        if (idx >= 0) {
          const start = Math.max(0, idx - 30);
          const end = Math.min(content.length, idx + query.length + 30);
          snippet = (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
        } else {
          snippet = content.slice(0, 60) + (content.length > 60 ? '…' : '');
        }
        result += `- [ID:${n.id}] ${title}\n`;
        if (summary) result += `  📝 ${summary}\n`;
        result += `  📄 ${snippet}\n`;
      });
      result += '\n💡 使用 get_note_detail 查看笔记完整内容。';
      return result;
    }
    case 'get_note_detail': {
      const id = params.id;
      if (!id) return '错误：缺少笔记ID';
      const n = notes.find(nt => nt.id === id);
      if (!n) return `错误：未找到ID为 ${id} 的笔记`;
      let result = `📝 笔记详情 [ID:${n.id}]\n`;
      result += `📌 标题：${n.title || '未命名'}\n`;
      result += `🕐 创建时间：${n.createdAt ? new Date(n.createdAt).toLocaleString('zh-CN') : '未知'}\n`;
      result += `🕑 最后编辑：${n.updatedAt ? new Date(n.updatedAt).toLocaleString('zh-CN') : '未知'}\n`;
      result += `\n📄 正文：\n${n.content || '(空)'}\n`;
      return result;
    }
    case 'get_note_changes': {
      const period = (params.period || 'today').toLowerCase();
      const now = new Date();
      let targetDate;
      if (period === 'yesterday') {
        targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() - 1);
      } else {
        targetDate = now;
      }
      const targetDateStr = targetDate.getFullYear() + '-' + String(targetDate.getMonth() + 1).padStart(2, '0') + '-' + String(targetDate.getDate()).padStart(2, '0');
      const periodLabel = period === 'yesterday' ? '昨天' : '今天';

      const changed = notes.filter(n => {
        if (!n.updatedAt) return false;
        const d = new Date(n.updatedAt);
        const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        return ds === targetDateStr;
      });

      if (changed.length === 0) return `📝 ${periodLabel}没有修改过笔记。`;
      let result = `📝 ${periodLabel}修改的笔记（共${changed.length}篇）：\n\n`;
      changed.forEach(n => {
        result += `- [ID:${n.id}] ${n.title || '未命名'}\n`;
        result += `  🕑 编辑于：${new Date(n.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}\n`;
        const preview = (n.content || '').length > 80 ? n.content.slice(0, 80) + '…' : (n.content || '');
        if (preview) result += `  📄 ${preview}\n`;
      });
      result += '\n💡 使用 get_note_detail 查看具体笔记的完整内容。';
      return result;
    }
    case 'add_link': {
      const name = params.name || '';
      if (!name) return '错误：缺少链接名称';
      const url = params.url || '';
      const category = params.category || '默认分类';
      const type = params.type === 'app' ? 'app' : 'link';
      const newLink = { id: genId(), name, url, category, type };
      links.unshift(newLink);
      saveData('study_links_v3', links);
      return `✅ 已添加快捷访问：${name}（${category}）`;
    }
    case 'delete_link': {
      const id = params.id;
      if (!id) return '错误：缺少链接ID';
      const link = links.find(l => l.id === id);
      if (!link) return `错误：未找到ID为 ${id} 的链接`;
      links = links.filter(l => l.id !== id);
      saveData('study_links_v3', links);
      return `✅ 已删除快捷访问：${link.name}`;
    }
    case 'list_links': {
      if (links.length === 0) return '🔗 当前没有快捷访问。';
      let result = '🔗 快捷访问列表：\n';
      links.forEach(l => {
        result += `- [ID:${l.id}] ${l.name} → ${l.url || '(无链接)'} [${l.category || '默认分类'}] ${l.type === 'app' ? '📱' : '🌐'}\n`;
      });
      return result;
    }
    case 'schedule_automation': {
      const at = params.at;
      if (!at || !/^\d{2}:\d{2}$/.test(at)) return '错误：缺少有效的时间参数 at，格式为 HH:MM（如 09:30）';
      const promptText = params.prompt;
      if (!promptText) return '错误：缺少 prompt 参数，请描述触发时AI应该做什么';
      const repeat = params.repeat === 'once' ? 'once' : 'daily';
      const convId = activeConvId;
      if (!convId) return '错误：没有活跃的对话';
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
      startAutomationTimer();
      const repeatLabel = repeat === 'once' ? '一次性' : '每天';
      return `✅ 已创建${repeatLabel}自动化任务（ID:${newAuto.id}）：${repeat === 'daily' ? '每天 ' : ''}${at} 自动执行「${promptText.slice(0, 30)}${promptText.length > 30 ? '…' : ''}」`;
    }
    case 'list_automations': {
      if (automations.length === 0) return '⏰ 当前没有自动化任务';
      let result = '⏰ 自动化任务列表：\n';
      automations.forEach(a => {
        const repeatLabel = a.repeat === 'once' ? '一次性' : '每天';
        const timeLabel = a.repeat === 'once' ? ` ${a.at} 触发` : `每天 ${a.at}`;
        result += `- [ID:${a.id}] ${repeatLabel}${timeLabel} → ${a.prompt.slice(0, 40)}${a.prompt.length > 40 ? '…' : ''}` + (a.enabled === false ? ' [已停用]' : '') + (a.lastRun ? `（上次运行：${a.lastRun}）` : '（尚未运行）') + '\n';
      });
      return result;
    }
    case 'delete_automation': {
      const id = params.id;
      if (!id) return '错误：缺少自动化任务ID';
      const idx = automations.findIndex(a => a.id === id);
      if (idx === -1) return `错误：未找到ID为 ${id} 的自动化任务`;
      const removed = automations.splice(idx, 1)[0];
      saveData('study_automations', automations);
      if (automations.length === 0) stopAutomationTimer();
      return `✅ 已删除自动化任务：每天 ${removed.at}「${removed.prompt.slice(0, 30)}」`;
    }
    case 'list_memories': {
      return typeof toolListMemories === 'function' ? toolListMemories(params) : '错误：记忆系统未加载';
    }
    case 'get_memory_detail': {
      return typeof toolGetMemoryDetail === 'function' ? toolGetMemoryDetail(params) : '错误：记忆系统未加载';
    }
    case 'web_search': {
      const query = params.query || '';
      if (!query) return '❌ 搜索失败：请输入搜索关键词';
      const maxResults = Math.min(Number(params.max_results) || 5, 10);
      const result = await performWebSearch(query, maxResults);
      if (!result) return `🌐 未找到"${query}"的相关搜索结果`;
      return `🌐 网络搜索结果（"${query}"）：\n\n${result}`;
    }
    case 'read_webpage': {
      const url = params.url || '';
      if (!url) return '❌ 读取失败：缺少网页 URL';
      if (typeof window === 'undefined' || !window.electronAPI || typeof window.electronAPI.webRead !== 'function') {
        return '❌ 当前环境不支持读取网页（缺少 electronAPI.webRead，请完全重启应用后重试）';
      }
      const maxChars = Math.max(Number(params.maxChars) || 6000, 500);
      try {
        const res = await window.electronAPI.webRead({ url, maxChars });
        if (!res || res.ok !== true) {
          return '❌ 读取网页失败：' + ((res && res.error) || '未知错误');
        }
        let text = (res.text || '').trim();
        if (!text) return '❌ 未能提取到该网页的正文内容';
        if (text.length > maxChars) {
          text = text.slice(0, maxChars) + '\n\n[内容过长，已截断...]';
        }
        return `📄 网页阅读成功\n🔗 来源：${res.finalUrl || url}\n📌 标题：${res.title || '(无标题)'}\n\n${text}`;
      } catch (err) {
        return '❌ 读取网页失败：' + String((err && err.message) || err);
      }
    }
    // ── 任务线系统（GTNH 式任务书） ──
    case 'quest_get': {
      if (typeof loadTaskLineStore !== 'function' || typeof buildAiSummary !== 'function') return '❌ 任务线系统未加载。';
      const qStore = loadTaskLineStore();
      const qId = params.questId ? Number(params.questId) : null;
      const qLineId = params.lineId ? Number(params.lineId) : null;
      if (qId) {
        const q = qStore.quests.find(x => x.id === qId);
        if (!q) return `❌ 未找到任务 ID ${qId}`;
        const line = qStore.lines.find(l => l.id === q.lineId);
        const statusMap = { draft: '草稿（待确认）', locked: '锁定（前置未完成）', active: '进行中', done: '已完成', skipped: '已跳过' };
        let r = `🔍 任务详情 [ID:${q.id}]\n`;
        r += `📌 ${q.title}\n`;
        r += `📂 所属：${line ? (line.type === 'main' ? '主线' : '素质线') + '「' + line.name + '」' : '（章节已删除）'}\n`;
        r += `📊 状态：${statusMap[q.status] || q.status}\n`;
        if (q.desc) r += `📜 描述：${q.desc}\n`;
        if (q.deps && q.deps.length > 0) {
          r += `🔗 前置依赖：\n`;
          for (const did of q.deps) {
            const d = qStore.quests.find(x => x.id === did);
            const dmet = d && (d.status === 'done' || d.status === 'skipped');
            r += `   ${dmet ? '✅' : '⬜'} [ID:${did}] ${d ? d.title : '（已删除）'}\n`;
          }
        }
        if (q.conditions && q.conditions.length > 0) {
          r += `📋 完成条件（${q.conditions.filter(c => tlIsCondMet(c)).length}/${q.conditions.length}）：\n`;
          q.conditions.forEach((c, i) => {
            const met = tlIsCondMet(c);
            r += `   ${met ? '✅' : '⬜'} ${i + 1}. ${c.label || c.type}${c.type === 'timer' ? '（' + c.minutes + ' 分钟）' : ''}\n`;
          });
        }
        r += `📐 类型：${q.kind === 'main' ? '主线关键任务' : '支线任务'}`;
        if (q.pos && typeof q.pos.x === 'number' && typeof q.pos.y === 'number') {
          r += `\n📍 画布位置：(${q.pos.x}, ${q.pos.y})`;
        }
        return r;
      }
      if (qLineId) {
        const line = qStore.lines.find(l => l.id === qLineId);
        if (!line) return `❌ 未找到章节 ID ${qLineId}`;
        const qs = qStore.quests.filter(x => x.lineId === qLineId);
        let r = `📂 章节「${line.name}」任务列表（${qs.length} 个）\n`;
        if (qs.length === 0) return r + '（暂无任务，可用 quest_create 创建）';
        for (const q of qs) {
          const met = tlQuestCondMetCount(q);
          r += `   [ID:${q.id}] ${q.status === 'done' ? '✅' : q.status === 'locked' ? '🔒' : q.status === 'draft' ? '✏️' : q.status === 'skipped' ? '⏭️' : '▶️'} ${q.kind === 'main' ? '⭐' : '🔷'} ${q.title}` + (q.conditions.length ? `（条件 ${met}/${q.conditions.length}）` : '') + '\n';
        }
        return r;
      }
      return buildAiSummary() + '\n\n（完整任务列表可用 quest_get 指定 lineId 查看）';
    }
    case 'quest_create_line': {
      if (typeof tlAddLine !== 'function') return '❌ 任务线系统未加载。';
      const name = params.name;
      if (!name || !name.trim()) return '❌ 创建失败：缺少章节名称';
      const type = params.type === 'main' ? 'main' : 'quality';
      const line = tlAddLine({ name, type, desc: params.desc || '' });
      if (!line) return '❌ 创建失败';
      return `✅ 已创建${type === 'main' ? '主线章节' : '素质线'}「${line.name}」[ID:${line.id}]` + (params.desc ? `\n   描述：${params.desc}` : '');
    }
    case 'quest_update_line': {
      if (typeof tlUpdateLine !== 'function') return '❌ 任务线系统未加载。';
      const id = Number(params.id);
      if (!id) return '❌ 缺少章节ID';
      const patch = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.desc !== undefined) patch.desc = params.desc;
      const line = tlUpdateLine(id, patch);
      if (!line) return `❌ 未找到章节 ID ${id}`;
      return `✅ 已更新章节「${line.name}」`;
    }
    case 'quest_create': {
      if (typeof tlAddQuest !== 'function') return '❌ 任务线系统未加载。';
      const lineId = Number(params.lineId);
      const title = params.title;
      if (!lineId) return '❌ 创建失败：缺少 lineId（所属章节）';
      if (!title || !title.trim()) return '❌ 创建失败：缺少任务标题';
      const q = tlAddQuest({
        lineId,
        title,
        kind: params.kind === 'main' ? 'main' : 'side',
        desc: params.desc || '',
        deps: params.deps,
        milestone: params.milestone === true,
        pos: params.pos
      });
      if (!q) return `❌ 创建失败：章节 ID ${lineId} 不存在`;
      const depNames = (q.deps || []).map(did => { const d = tlGetQuest(did); return d ? d.title : '#' + did; });
      // deps 有效性校验：不存在的任务 ID 会让任务永远锁定，提示 AI 修正
      const invalidDeps = (q.deps || []).filter(did => !tlGetQuest(did));
      const invalidHint = invalidDeps.length > 0
        ? `\n   ⚠️ 警告：${invalidDeps.join('、')} 不是有效的任务 ID，该任务将保持锁定。请用 quest_get 确认正确的 [ID:xxx]（可跨章节），再用 quest_update 修正 deps，或删除该依赖。`
        : '';
      return `✅ 已创建${q.kind === 'main' ? '【主线】' : '【支线】'}任务「${q.title}」[ID:${q.id}]（草稿状态，用户确认后转 active）\n` +
        `   所属章节：[ID:${lineId}]\n` +
        (q.desc ? `   📜 描述：${q.desc}\n` : '') +
        (depNames.length ? `   🔗 前置依赖：${depNames.join('、')}\n` : '') +
        `   📐 在任务图中显示为${q.kind === 'main' ? '金色主线框' : '蓝色支线框'}` +
        invalidHint;
    }
    case 'quest_update': {
      if (typeof tlUpdateQuest !== 'function') return '❌ 任务线系统未加载。';
      const id = Number(params.id);
      if (!id) return '❌ 缺少任务ID';
      const patch = {};
      if (params.title !== undefined) patch.title = params.title;
      if (params.desc !== undefined) patch.desc = params.desc;
      if (params.status !== undefined) patch.status = params.status;
      if (params.kind !== undefined) patch.kind = params.kind;
      if (params.deps !== undefined) patch.deps = Array.isArray(params.deps) ? params.deps.map(Number) : patch.deps;
      if (params.pos !== undefined) patch.pos = params.pos;
      const q = tlUpdateQuest(id, patch);
      if (!q) return `❌ 未找到任务 ID ${id}`;
      // 状态改为 active 后，根据依赖重新判定（deps 未满足则自动转 locked）
      if (typeof tlRefreshQuestStatus === 'function') tlRefreshQuestStatus(id);
      const finalQ = tlGetQuest(id);
      const statusText = finalQ ? finalQ.status : (params.status || '');
      let invalidHint = '';
      if (patch.deps !== undefined && q.deps && q.deps.length > 0) {
        const invalidDeps = q.deps.filter(did => !tlGetQuest(did));
        if (invalidDeps.length > 0) {
          invalidHint = `\n   ⚠️ 警告：${invalidDeps.join('、')} 不是有效的任务 ID，该任务将保持锁定。请用 quest_get 确认正确的 [ID:xxx]（可跨章节）后修正。`;
        }
      }
      return `✅ 已更新任务「${q.title}」` + (params.status ? `（状态：${statusText}）` : '') + (finalQ && statusText === 'locked' ? '，前置任务未完成，已转为锁定' : '') + invalidHint;
    }
    case 'quest_link_todo': {
      if (typeof tlGetQuest !== 'function' || typeof tlMakeTodoCond !== 'function') return '❌ 任务线系统未加载。';
      const qId = Number(params.questId);
      const todoId = Number(params.todoId);
      if (!qId || !todoId) return '❌ 缺少 questId 或 todoId';
      const q = tlGetQuest(qId);
      if (!q) return `❌ 未找到任务 ID ${qId}`;
      const t = typeof findTodo === 'function' ? findTodo(todoId) : null;
      if (!t) return `❌ 未找到待办 ID ${todoId}`;
      const cond = tlMakeTodoCond(todoId);
      q.conditions = q.conditions || [];
      if (q.conditions.some(c => c.type === 'todo' && c.todoId === todoId)) return `ℹ️ 该待办已绑定为此任务的条件`;
      q.conditions.push(cond);
      const store = loadTaskLineStore();
      saveTaskLineStore(store);
      if (typeof tlRefreshQuestStatus === 'function') tlRefreshQuestStatus(qId);
      if (typeof renderTaskLine === 'function') renderTaskLine();
      return `✅ 已绑定完成条件：${cond.label}`;
    }
    case 'quest_link_note': {
      if (typeof tlGetQuest !== 'function' || typeof tlMakeNoteCond !== 'function') return '❌ 任务线系统未加载。';
      const qId = Number(params.questId);
      const noteId = Number(params.noteId);
      if (!qId || !noteId) return '❌ 缺少 questId 或 noteId';
      const q = tlGetQuest(qId);
      if (!q) return `❌ 未找到任务 ID ${qId}`;
      const n = (typeof notes !== 'undefined') ? notes.find(x => x.id === noteId && x.type === 'note') : null;
      if (!n) return `❌ 未找到笔记 ID ${noteId}`;
      const cond = tlMakeNoteCond(noteId);
      q.conditions = q.conditions || [];
      if (q.conditions.some(c => c.type === 'note' && c.noteId === noteId)) return `ℹ️ 该笔记已绑定为此任务的条件`;
      q.conditions.push(cond);
      const store = loadTaskLineStore();
      saveTaskLineStore(store);
      if (typeof tlRefreshQuestStatus === 'function') tlRefreshQuestStatus(qId);
      if (typeof renderTaskLine === 'function') renderTaskLine();
      return `✅ 已绑定完成条件：${cond.label}`;
    }
    case 'quest_link_timer': {
      if (typeof tlGetQuest !== 'function' || typeof tlMakeTimerCond !== 'function') return '❌ 任务线系统未加载。';
      const qId = Number(params.questId);
      const targetId = Number(params.targetId);
      const minutes = Number(params.minutes) || 0;
      if (!qId || !targetId || !minutes) return '❌ 缺少 questId、targetId 或 minutes';
      const q = tlGetQuest(qId);
      if (!q) return `❌ 未找到任务 ID ${qId}`;
      const cond = tlMakeTimerCond(targetId, minutes, params.targetType || 'todo');
      q.conditions = q.conditions || [];
      q.conditions.push(cond);
      const store = loadTaskLineStore();
      saveTaskLineStore(store);
      if (typeof tlRefreshQuestStatus === 'function') tlRefreshQuestStatus(qId);
      if (typeof renderTaskLine === 'function') renderTaskLine();
      return `✅ 已绑定完成条件：${cond.label}`;
    }
    case 'quest_add_manual_cond': {
      if (typeof tlGetQuest !== 'function') return '❌ 任务线系统未加载。';
      const qId = Number(params.questId);
      const label = params.label;
      if (!qId || !label) return '❌ 缺少 questId 或 label';
      const q = tlGetQuest(qId);
      if (!q) return `❌ 未找到任务 ID ${qId}`;
      q.conditions = q.conditions || [];
      q.conditions.push({ type: 'manual', label, done: false });
      const store = loadTaskLineStore();
      saveTaskLineStore(store);
      if (typeof renderTaskLine === 'function') renderTaskLine();
      return `✅ 已添加手动打卡条件：${label}`;
    }
    case 'quest_complete': {
      if (typeof tlCompleteQuest !== 'function') return '❌ 任务线系统未加载。';
      const id = Number(params.id);
      if (!id) return '❌ 缺少任务ID';
      const res = tlCompleteQuest(id, 'ai');
      if (!res.ok) return '❌ ' + res.msg;
      return `✅ ${res.msg}` + (res.badge && res.badge.length > 0 ? `｜新徽章：${res.badge.map(b => b.name).join('、')}` : '');
    }
    case 'quest_skip': {
      if (typeof tlSkipQuest !== 'function') return '❌ 任务线系统未加载。';
      const id = Number(params.id);
      if (!id) return '❌ 缺少任务ID';
      const res = tlSkipQuest(id);
      if (!res.ok) return '❌ ' + res.msg;
      return `✅ ${res.msg}`;
    }
    case 'quest_review': {
      if (typeof buildAiSummary !== 'function' || typeof loadTaskLineStore !== 'function') return '❌ 任务线系统未加载。';
      const store = loadTaskLineStore();
      let r = buildAiSummary();
      // 卡点分析
      const stuck = store.quests.filter(q => q.status === 'active' && q.conditions.length > 0 && tlQuestCondMetCount(q) === 0);
      const half = store.quests.filter(q => q.status === 'active' && q.conditions.length > 0 && tlQuestCondMetCount(q) > 0 && !tlQuestCondMet(q));
      const lockedCount = store.quests.filter(q => q.status === 'locked').length;
      if (stuck.length > 0) {
        r += `\n⏳ 长期无进展（条件全部未动，建议拆分或调整）：\n`;
        for (const q of stuck) r += `   · [ID:${q.id}] ${q.title}（条件 ${tlQuestCondMetCount(q)}/${q.conditions.length}）\n`;
      }
      if (half.length > 0) {
        r += `\n🚧 进行中（条件部分达成，建议近期完成）：\n`;
        for (const q of half) r += `   · [ID:${q.id}] ${q.title}（条件 ${tlQuestCondMetCount(q)}/${q.conditions.length}）\n`;
      }
      if (lockedCount > 0) r += `\n🔒 ${lockedCount} 个任务因前置未完成而锁定。\n`;
      r += `\n💡 请基于以上数据给用户 1~3 条下一步行动建议（可配合 add_todo 创建今日待办）。`;
      return r;
    }
    default:
      return `错误：未知的工具 "${action}"`;
  }
}

// Tool call result indicator - to be shown in chat
// Parses a single <tool_call> block, returns { action, params } or null
function parseSingleToolCall(raw) {
  const actionMatch = raw.match(/"action"\s*:\s*"([^"]+)"/);
  const action = actionMatch ? actionMatch[1] : null;
  if (!action) return null;

  // Find params object: locate "params":{ and its matching }
  const paramsIdx = raw.indexOf('"params"');
  if (paramsIdx === -1) return null;
  const braceStart = raw.indexOf('{', paramsIdx);
  let depth = 0, braceEnd = -1;
  let inStr = false, esc = false;
  for (let i = braceStart; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
  }
  if (braceEnd === -1) return null;

  // Use JSON.parse to correctly unescape all string values (e.g., \\Delta -> \Delta)
  const paramsJson = raw.slice(braceStart, braceEnd + 1);
  let params;
  try {
    params = JSON.parse(paramsJson);
  } catch (e) {
    // Fallback: manual extraction for malformed JSON
    const paramsStr = raw.slice(braceStart + 1, braceEnd);
    params = {};
    const simpleKeys = ['title', 'text', 'tags', 'dueDate', 'at', 'search', 'name', 'url', 'category', 'type', 'repeat', 'keyId', 'key_id', 'prompt'];
    for (const key of simpleKeys) {
      const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]*)"');
      const m = paramsStr.match(re);
      if (m) params[key] = m[1];
    }

    function extractLongStringParam(keyName, targetObj, targetKey) {
      const keyIdx = paramsStr.indexOf('"' + keyName + '"');
      if (keyIdx === -1) return;
      const prefix = '"' + keyName + '":';
      const valStart = keyIdx + prefix.length + 1;
      for (let i = valStart; i < paramsStr.length; i++) {
        const ch = paramsStr[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '"') {
          const after = paramsStr.slice(i + 1).trim();
          if (after.startsWith(',') || after.startsWith('}')) {
            targetObj[targetKey] = paramsStr.slice(valStart, i);
            return;
          }
        }
      }
      targetObj[targetKey] = paramsStr.slice(valStart, -1);
    }

    extractLongStringParam('content', params, 'content');
    extractLongStringParam('prompt', params, 'prompt');

    const parentIdMatch = paramsStr.match(/"parentId"\s*:\s*"?(\d+)"?/);
    if (parentIdMatch) params.parentId = parseInt(parentIdMatch[1], 10);
    const idMatch = paramsStr.match(/"id"\s*:\s*"?(\d+)"?/);
    if (idMatch) params.id = parseInt(idMatch[1], 10);
    const todoIdMatch = paramsStr.match(/"todoId"\s*:\s*"?(\d+)"?/);
    if (todoIdMatch) params.todoId = parseInt(todoIdMatch[1], 10);

    function extractJsonArray(keyName) {
      const keyIdx = paramsStr.indexOf('"' + keyName + '"');
      if (keyIdx === -1) return null;
      const colonIdx = paramsStr.indexOf(':', keyIdx);
      if (colonIdx === -1) return null;
      const arrStart = paramsStr.indexOf('[', colonIdx);
      if (arrStart === -1) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = arrStart; i < paramsStr.length; i++) {
        const ch = paramsStr[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === '[') depth++;
        if (ch === ']') { depth--; if (depth === 0) {
          try { return JSON.parse(paramsStr.slice(arrStart, i + 1)); } catch(e) { return null; }
        }}
      }
      return null;
    }

    const pathArr = extractJsonArray('path');
    if (pathArr) params.path = pathArr;
    const todosArr = extractJsonArray('todos');
    if (todosArr) params.todos = todosArr;
  }

  return { action, params };
}

// Extract all <tool_call> blocks from AI reply, returns { cleanText, toolCalls[] }
function extractToolCalls(text) {
  // Accept both <tool_call> and <tool_action>, and both proper closing </tool_call> and self-closing <tool_call>
  const matches = [...text.matchAll(/<(tool_call|tool_action)>([\s\S]*?)<\/(tool_call|tool_action)>/g)];
  // Also try self-closing pattern (some models like Kimi use <tool_call>...</tool_call> without slash)
  // Use brace counting to find the matching closing brace, then check for <tool_call>
  const selfCloseMatches = [];
  const scRe = /<(tool_call|tool_action)>\{/g;
  let scMatch;
  while ((scMatch = scRe.exec(text)) !== null) {
    const tagName = scMatch[1];
    const start = scMatch.index;
    let braceDepth = 1;
    let pos = scMatch.index + scMatch[0].length;
    // Count braces to find matching }
    while (braceDepth > 0 && pos < text.length) {
      if (text[pos] === '{') braceDepth++;
      else if (text[pos] === '}') braceDepth--;
      pos++;
    }
    if (braceDepth === 0) {
      // Check if followed by <tool_call> or <tool_action> (self-closing)
      const after = text.slice(pos);
      const closeMatch = after.match(/^<\/?(tool_call|tool_action)>/);
      if (closeMatch) {
        const endIdx = pos + closeMatch[0].length;
        const fullMatch = text.slice(start, endIdx);
        selfCloseMatches.push(fullMatch);
      }
    }
  }
  // Merge both, preferring proper closing
  const allMatches = matches.length > 0 ? matches : selfCloseMatches;
  if (allMatches.length === 0) return { cleanText: text, toolCalls: [] };

  // Remove all tool_call/tool_action and memory blocks from display text
  let cleanText = text
    .replace(/<(tool_call|tool_action)>[\s\S]*?<\/(tool_call|tool_action)>/g, '')
    .replace(/<(tool_call|tool_action)>[\s\S]*?<(tool_call|tool_action)>/g, '')
    .replace(/<memory>[\s\S]*?<\/memory>/g, '')
    .trim();

  const toolCalls = [];
  for (const match of matches) {
    const raw = match[2].trim(); // match[2] is the JSON content between tags
    const parsed = parseSingleToolCall(raw);
    if (parsed && parsed.action && AI_TOOLS[parsed.action]) {
      toolCalls.push(parsed);
    }
  }
  // If no proper-close matches found, try self-close matches
  if (toolCalls.length === 0) {
    for (const raw of selfCloseMatches) {
      const m = raw.match(/<(tool_call|tool_action)>\{([\s\S]*)\}<\/?(tool_call|tool_action)>/);
      if (m) {
        const json = m[2].trim();
        const parsed = parseSingleToolCall(json);
        if (parsed && parsed.action && AI_TOOLS[parsed.action]) {
          toolCalls.push(parsed);
        }
      }
    }
  }

  return { cleanText, toolCalls };
}
