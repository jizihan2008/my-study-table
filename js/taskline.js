// ═══════════════════════════════════════════════
//  任务线系统（GTNH 任务书理念）
//  章节双轴：主线（人生阶段，顺序推进）+ 素质线（并行成长）
//  任务：依赖解锁 / 完成条件（绑定待办·笔记·计时）/ 三段式描述
//  奖励：即时反馈 + 徽章收藏 + 自定义奖励池
//  与对话 AI 适配：quest_* 工具集 + buildAiSummary 注入
// ═══════════════════════════════════════════════

const TASkLINE_KEY = 'study_taskline_v1';

// ─────────────────────── 存储层 ───────────────────────
function loadTaskLineStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(TASkLINE_KEY));
    if (raw && typeof raw === 'object') {
      if (!Array.isArray(raw.lines)) raw.lines = [];
      if (!Array.isArray(raw.quests)) raw.quests = [];
      if (!Array.isArray(raw.badges)) raw.badges = [];
      if (!Array.isArray(raw.rewards)) raw.rewards = [];
      if (!raw.spent) raw.spent = 0;   // 奖励兑换已消耗的任务计数
      if (!raw.toggle) raw.toggle = {};
      // 迁移旧版任务描述：{goal,meaning,output} 对象 → 一段文字
      for (const q of raw.quests) {
        if (q.desc && typeof q.desc === 'object' && !Array.isArray(q.desc)) {
          const d = q.desc;
          const parts = [];
          if (d.goal) parts.push('【目标】' + d.goal);
          if (d.meaning) parts.push('【意义】' + d.meaning);
          if (d.output) parts.push('【产出】' + d.output);
          q.desc = parts.join('\n');
        } else if (typeof q.desc !== 'string') {
          q.desc = '';
        }
      }
      return raw;
    }
  } catch (e) { /* ignore */ }
  return { version: 3, spent: 0, lines: [], quests: [], badges: [], rewards: [], toggle: {} };
}
function saveTaskLineStore(store) {
  try {
    if (typeof saveData === 'function') saveData(TASkLINE_KEY, store);
    else localStorage.setItem(TASkLINE_KEY, JSON.stringify(store));
  } catch (e) { console.error('[任务线] 保存失败:', e); }
}
function tlGetLines() { return loadTaskLineStore().lines; }
function tlGetQuests() { return loadTaskLineStore().quests; }

// 完成任务总数 / 奖励兑换可用额度（完成任务数 - 已兑换消耗）
function tlDoneCount(store) {
  return (store ? store.quests : tlGetQuests()).filter(q => q.status === 'done').length;
}
function tlRewardBalance(store) {
  if (!store) store = loadTaskLineStore();
  return tlDoneCount(store) - (store.spent || 0);
}

// ─────────────────────── 章节 CRUD ───────────────────────
function tlAddLine({ name, type = 'quality', desc = '' }) {
  if (!name || !name.trim()) return null;
  const store = loadTaskLineStore();
  const existing = store.lines.filter(l => l.type === type);
  const line = {
    id: genId(),
    name: name.trim(),
    type: type === 'main' ? 'main' : 'quality',
    desc: desc || '',
    sort: existing.length > 0 ? Math.max(...existing.map(l => l.sort || 0)) + 1 : 0,
    createdAt: Date.now()
  };
  store.lines.push(line);
  saveTaskLineStore(store);
  return line;
}
function tlUpdateLine(id, patch) {
  const store = loadTaskLineStore();
  const line = store.lines.find(l => l.id === id);
  if (!line) return null;
  if (patch.name !== undefined) line.name = patch.name.trim() || line.name;
  if (patch.desc !== undefined) line.desc = patch.desc;
  if (patch.type !== undefined) line.type = patch.type;
  saveTaskLineStore(store);
  return line;
}
function tlDeleteLine(id) {
  const store = loadTaskLineStore();
  const target = store.lines.find(l => l.id === id);
  if (!target) return false;
  // 删除该章节的所有任务（含被其他任务依赖的：一并删除依赖引用）
  const lineQuestIds = new Set(store.quests.filter(q => q.lineId === id).map(q => q.id));
  store.quests = store.quests.filter(q => q.lineId !== id);
  store.quests.forEach(q => { if (q.deps) q.deps = q.deps.filter(d => !lineQuestIds.has(d)); });
  store.lines = store.lines.filter(l => l.id !== id);
  saveTaskLineStore(store);
  return true;
}

// ─────────────────────── 任务 CRUD ───────────────────────
// kind: 'main' 主线关键任务（金色框）| 'side' 支线任务（普通框）
// desc: 任务的一段完整文字描述（含目标/意义/产出）；兼容旧版 goal/meaning/output 分离参数
function tlAddQuest({ lineId, title, goal = '', meaning = '', output = '', desc, deps = [], conditions = [], kind = 'side', status = 'draft', milestone = false, pos = null }) {
  if (!lineId || !title || !title.trim()) return null;
  const store = loadTaskLineStore();
  const line = store.lines.find(l => l.id === lineId);
  if (!line) return null;
  let descText = desc;
  if (!descText && (goal || meaning || output)) {
    const parts = [];
    if (goal) parts.push('【目标】' + goal);
    if (meaning) parts.push('【意义】' + meaning);
    if (output) parts.push('【产出】' + output);
    descText = parts.join('\n');
  }
  const lineQuests = store.quests.filter(q => q.lineId === lineId);
  const quest = {
    id: genId(),
    lineId,
    title: title.trim(),
    status: 'draft', // AI 生成默认草稿，用户确认后转 active
    kind: kind === 'main' ? 'main' : 'side',
    desc: descText || '',
    deps: Array.isArray(deps) ? deps.filter(d => d !== null) : [],
    conditions: Array.isArray(conditions) ? conditions : [],
    milestone: !!milestone,
    sort: lineQuests.length > 0 ? Math.max(...lineQuests.map(q => q.sort || 0)) + 1 : 0,
    createdAt: Date.now()
  };
  // 手动画布位置（画布绝对坐标 {x,y}，可为负：节点可放左/上边界外）
  if (pos && typeof pos === 'object' && typeof pos.x === 'number' && isFinite(pos.x) && typeof pos.y === 'number' && isFinite(pos.y)) {
    quest.pos = { x: Math.round(pos.x), y: Math.round(pos.y) };
  }
  store.quests.push(quest);
  saveTaskLineStore(store);
  return quest;
}
function tlUpdateQuest(id, patch) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === id);
  if (!q) return null;
  if (patch.title !== undefined) q.title = patch.title.trim() || q.title;
  if (patch.desc !== undefined) q.desc = patch.desc;
  if (patch.deps !== undefined) q.deps = Array.isArray(patch.deps) ? patch.deps : q.deps;
  if (patch.status !== undefined && ['draft', 'active', 'locked', 'done', 'skipped'].includes(patch.status)) q.status = patch.status;
  if (patch.kind !== undefined) q.kind = patch.kind === 'main' ? 'main' : 'side';
  if (patch.milestone !== undefined) q.milestone = !!patch.milestone;
  if (patch.sort !== undefined) q.sort = patch.sort;
  if (patch.conditions !== undefined && Array.isArray(patch.conditions)) q.conditions = patch.conditions;
  if (patch.pos !== undefined) {
    if (patch.pos === null || patch.pos === false) {
      delete q.pos; // 清除手动位置，回退自动布局
    } else if (typeof patch.pos === 'object' && typeof patch.pos.x === 'number' && isFinite(patch.pos.x) && typeof patch.pos.y === 'number' && isFinite(patch.pos.y)) {
      q.pos = { x: Math.round(patch.pos.x), y: Math.round(patch.pos.y) };
    }
  }
  saveTaskLineStore(store);
  return q;
}
function tlDeleteQuest(id) {
  const store = loadTaskLineStore();
  if (!store.quests.some(q => q.id === id)) return false;
  store.quests = store.quests.filter(q => q.id !== id);
  store.quests.forEach(q => { if (q.deps) q.deps = q.deps.filter(d => d !== id); });
  saveTaskLineStore(store);
  return true;
}
function tlGetQuest(id) { return tlGetQuests().find(q => q.id === id) || null; }

// ─────────────────────── 完成条件 ───────────────────────
// 条件结构: { type: 'todo'|'note'|'timer'|'manual', todoId/noteId/targetId, targetType, minutes, label, done }
function tlCheckCondition(cond) {
  if (!cond || !cond.type) return false;
  try {
    switch (cond.type) {
      case 'todo': {
        const t = (typeof findTodo === 'function') ? findTodo(cond.todoId) : null;
        return !!t && t.done === true;
      }
      case 'note': {
        const n = (typeof notes !== 'undefined') ? notes.find(x => x.id === cond.noteId && x.type === 'note') : null;
        return !!n && !!(n.content || '').trim();
      }
      case 'timer': {
        const minutes = cond.minutes || 0;
        if (!minutes) return false;
        const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
        let total = 0;
        for (const r of records) {
          const targetId = r.targetId || r.todoId;
          const targetType = r.targetType || 'todo';
          if (cond.targetType && targetType !== cond.targetType) continue;
          if (targetId === cond.targetId) total += (r.totalMs || 0);
        }
        return total >= minutes * 60000;
      }
      case 'manual':
        return cond.done === true;
      default:
        return false;
    }
  } catch (e) { return false; }
}
// 条件满足 = 自动检测满足 或 用户手动标记完成
function tlIsCondMet(cond) {
  if (cond && cond.done === true) return true;
  return tlCheckCondition(cond);
}
function tlQuestCondMet(quest) {
  if (!quest || !quest.conditions || quest.conditions.length === 0) return true; // 无条件的任务即完成
  return quest.conditions.every(c => tlIsCondMet(c));
}
function tlQuestCondMetCount(quest) {
  if (!quest || !quest.conditions) return 0;
  return quest.conditions.filter(c => tlIsCondMet(c)).length;
}
// 手动打卡 / 取消
function tlToggleManualCond(questId, condIndex) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q || !q.conditions[condIndex]) return;
  const cond = q.conditions[condIndex];
  if (cond.type === 'manual') {
    cond.done = !cond.done;
  } else {
    // 自动检测类条件允许手动覆盖（如待办被删除后）
    cond.done = !(cond.done === true);
  }
  saveTaskLineStore(store);
  tlRefreshQuestStatus(questId);
  if (typeof renderTaskLine === 'function') renderTaskLine();
}

// ─────────────────────── 依赖解锁 & 状态刷新 ───────────────────────
// 主线章节是否已解锁：上一主线章节（sort 更小）必须全部任务 done/skipped
function tlMainLineUnlocked(store, line) {
  if (line.type !== 'main') return true;
  const prev = store.lines
    .filter(l => l.type === 'main' && l.sort < (line.sort || 0))
    .sort((a, b) => a.sort - b.sort);
  if (prev.length === 0) return true;
  const prevLine = prev[prev.length - 1];
  const qs = store.quests.filter(q => q.lineId === prevLine.id);
  if (qs.length === 0) return true; // 空章节直接解锁
  return qs.every(q => q.status === 'done' || q.status === 'skipped');
}

// 刷新单个任务状态（依赖解锁）
function tlRefreshQuestStatus(questId) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return;
  if (q.status === 'done' || q.status === 'skipped') return; // 终态不变
  const depsMet = (q.deps || []).every(did => {
    const d = store.quests.find(x => x.id === did);
    return d && (d.status === 'done' || d.status === 'skipped');
  });
  if (!depsMet) {
    if (q.status === 'active') q.status = 'locked';
  } else {
    if (q.status === 'locked') q.status = 'active';
    if (q.status === 'draft') q.status = 'draft'; // 草稿保持草稿，需确认
  }
  saveTaskLineStore(store);
}

// 全局刷新：重新计算所有任务状态 + 主线章节解锁 + 自动完成检测
function tlRefreshAll() {
  const store = loadTaskLineStore();
  let changed = false;
  const today = getTodayStr();
  for (const line of store.lines) {
    // 主线章节：依赖上一章完成
    if (line.type === 'main') {
      const locked = !tlMainLineUnlocked(store, line);
      const lineQuests = store.quests.filter(q => q.lineId === line.id);
      if (locked) {
        for (const q of lineQuests) {
          if (q.status !== 'done' && q.status !== 'skipped' && q.status !== 'draft') {
            q.status = 'locked'; changed = true;
          }
        }
      }
    }
  }
  // 逐个任务：依赖解锁
  for (const q of store.quests) {
    if (q.status === 'done' || q.status === 'skipped') continue;
    const depsMet = (q.deps || []).every(did => {
      const d = store.quests.find(x => x.id === did);
      return d && (d.status === 'done' || d.status === 'skipped');
    });
    if (!depsMet) {
      if (q.status === 'active') { q.status = 'locked'; changed = true; }
    } else if (q.status === 'locked') {
      q.status = 'active'; changed = true;
    }
  }
  // 自动完成检测（仅 active 且有完成条件的任务：条件全满足才自动完成；无条件任务需手动点完成）
  const autoComplete = store.toggle.autoComplete !== false;
  for (const q of store.quests) {
    if (q.status !== 'active') continue;
    if (q.conditions && q.conditions.length > 0 && tlQuestCondMet(q)) {
      q.status = 'done';
      q.completedAt = today;
      q.autoCompleted = true;
      changed = true;
      // 完成时记录即时反馈队列（UI 展示）
      if (!store.toggle.silent) {
        const fb = store._feedback = store._feedback || [];
        fb.push({ type: 'complete', questId: q.id, title: q.title, at: Date.now() });
      }
    }
  }
  if (changed) saveTaskLineStore(store);
  return changed;
}

// 完成 / 跳过任务（手动）
function tlCompleteQuest(id, source = 'manual') {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === id);
  if (!q) return { ok: false, msg: '未找到任务' };
  if (q.status === 'done') return { ok: false, msg: '任务已完成' };
  if (q.status === 'draft') return { ok: false, msg: '草稿任务需先确认（设为 active）' };
  if (q.status === 'locked') return { ok: false, msg: '任务处于锁定状态，请先完成前置任务' };
  q.status = 'done';
  q.completedAt = getTodayStr();
  q.autoCompleted = false;
  saveTaskLineStore(store);
  // 解锁下游任务 + 自动徽章 + 即时反馈
  tlRefreshAll();
  const badge = tlCheckAutoBadges();
  if (source === 'ai' || source === 'manual') {
    if (typeof sendNotification === 'function') {
      sendNotification('🏆 任务完成：' + q.title, '继续推进你的任务线！', 'taskline-complete');
    }
  }
  if (typeof renderTaskLine === 'function') renderTaskLine();
  return { ok: true, badge, msg: `✅ 已完成任务「${q.title}」` };
}
function tlSkipQuest(id) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === id);
  if (!q) return { ok: false, msg: '未找到任务' };
  if (q.status === 'done') return { ok: false, msg: '已完成任务不可跳过' };
  q.status = 'skipped';
  q.skippedAt = getTodayStr();
  saveTaskLineStore(store);
  tlRefreshAll();
  if (typeof renderTaskLine === 'function') renderTaskLine();
  return { ok: true, msg: `已跳过任务「${q.title}」` };
}
// 草稿确认 → active
function tlActivateQuest(id) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === id);
  if (!q) return { ok: false, msg: '未找到任务' };
  if (q.status !== 'draft') return { ok: false, msg: '该任务不是草稿状态' };
  // 检查依赖
  const depsMet = (q.deps || []).every(did => {
    const d = store.quests.find(x => x.id === did);
    return d && (d.status === 'done' || d.status === 'skipped');
  });
  q.status = depsMet ? 'active' : 'locked';
  saveTaskLineStore(store);
  if (typeof renderTaskLine === 'function') renderTaskLine();
  return { ok: true, msg: `任务「${q.title}」已${q.status === 'active' ? '激活' : '锁定（待前置完成）'}` };
}

// ─────────────────────── 徽章 & 奖励池 ───────────────────────
function tlAddBadge(name, icon, desc) {
  const store = loadTaskLineStore();
  if (store.badges.some(b => b.name === name)) return false;
  store.badges.push({ id: genId(), name, icon: icon || '🎖️', desc: desc || '', earnedAt: Date.now() });
  saveTaskLineStore(store);
  return true;
}
function tlCheckAutoBadges() {
  const store = loadTaskLineStore();
  let added = [];
  const totalDone = tlDoneCount(store);
  const defs = [
    { name: '初试身手', icon: '🌱', desc: '完成第一个任务', test: totalDone >= 1 },
    { name: '小有成就', icon: '🌟', desc: '累计完成 5 个任务', test: totalDone >= 5 },
    { name: '坚持不懈', icon: '🔥', desc: '累计完成 10 个任务', test: totalDone >= 10 },
    { name: '渐入佳境', icon: '🎯', desc: '累计完成 15 个任务', test: totalDone >= 15 },
    { name: '连战连胜', icon: '⚡', desc: '累计完成 20 个任务', test: totalDone >= 20 },
    { name: '炉火纯青', icon: '🏅', desc: '累计完成 30 个任务', test: totalDone >= 30 }
  ];
  for (const l of store.lines) {
    const lqs = store.quests.filter(q => q.lineId === l.id);
    if (lqs.length > 0 && lqs.every(q => q.status === 'done')) {
      defs.push({ name: `章节达成：${l.name}`, icon: l.type === 'main' ? '🏁' : '🎯', desc: `完成「${l.name}」全部任务`, test: true });
    }
  }
  for (const d of defs) {
    if (d.test && tlAddBadge(d.name, d.icon, d.desc)) added.push(d);
  }
  return added;
}
// 自定义奖励池（用完成任务计数兑换）
function tlAddReward({ name, cost, icon }) {
  if (!name || !name.trim()) return null;
  const store = loadTaskLineStore();
  const reward = { id: genId(), name: name.trim(), cost: Number(cost) || 1, icon: icon || '🎁', redeemed: false, redeemedAt: null, createdAt: Date.now() };
  store.rewards.push(reward);
  saveTaskLineStore(store);
  return reward;
}
function tlRedeemReward(id) {
  const store = loadTaskLineStore();
  const r = store.rewards.find(x => x.id === id);
  if (!r) return { ok: false, msg: '未找到奖励' };
  if (r.redeemed) return { ok: false, msg: '该奖励已兑换' };
  const balance = tlRewardBalance(store);
  if (balance < r.cost) return { ok: false, msg: `完成任务不足：需要 ${r.cost} 个任务额度，当前可兑换 ${balance}` };
  store.spent = (store.spent || 0) + r.cost;
  r.redeemed = true;
  r.redeemedAt = getTodayStr();
  saveTaskLineStore(store);
  if (typeof sendNotification === 'function') sendNotification('🎁 已兑换：' + r.name, `消耗 ${r.cost} 个任务额度`, 'taskline-reward');
  if (typeof renderTaskLine === 'function') renderTaskLine();
  return { ok: true, msg: `已兑换「${r.name}」，消耗 ${r.cost} 个任务额度` };
}
function tlDeleteReward(id) {
  const store = loadTaskLineStore();
  store.rewards = store.rewards.filter(r => r.id !== id);
  saveTaskLineStore(store);
  if (typeof renderTaskLine === 'function') renderTaskLine();
}

// 条件辅助：创建条件对象
function tlMakeTodoCond(todoId) {
  const t = (typeof findTodo === 'function') ? findTodo(todoId) : null;
  return { type: 'todo', todoId, label: t ? `完成待办「${t.text}」` : `完成待办 #${todoId}` };
}
function tlMakeNoteCond(noteId) {
  const n = (typeof notes !== 'undefined') ? notes.find(x => x.id === noteId && x.type === 'note') : null;
  return { type: 'note', noteId, label: n ? `撰写笔记「${n.title}」` : `撰写笔记 #${noteId}` };
}
function tlMakeTimerCond(targetId, minutes, targetType) {
  const t = (typeof findTodo === 'function' && targetType !== 'goal') ? findTodo(targetId) : null;
  const label = t ? `专注 ${t.text} 累计 ${minutes} 分钟` : `专注累计 ${minutes} 分钟`;
  return { type: 'timer', targetId, targetType: targetType || 'todo', minutes, label };
}
// 计时条件当前进度（已累计 ms / 需要 ms）
function tlTimerProgress(cond) {
  try {
    const minutes = cond.minutes || 0;
    const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
    let total = 0;
    for (const r of records) {
      const targetId = r.targetId || r.todoId;
      const targetType = r.targetType || 'todo';
      if (cond.targetType && targetType !== cond.targetType) continue;
      if (targetId === cond.targetId) total += (r.totalMs || 0);
    }
    return { curMs: total, needMs: minutes * 60000 };
  } catch (e) { return { curMs: 0, needMs: 0 }; }
}

// ─────────────────────── AI 摘要 ───────────────────────
function buildAiSummary() {
  const store = loadTaskLineStore();
  const lines = store.lines;
  const quests = store.quests;
  const today = getTodayStr();
  const totalDone = tlDoneCount(store);
  let s = `═══ 任务线状态 ═══\n`;
  const mainsN = lines.filter(l => l.type === 'main').length;
  const qualsN = lines.filter(l => l.type === 'quality').length;
  s += `📂 章节 ${lines.length} 个（主线 ${mainsN} / 素质线 ${qualsN}）｜已完成任务 ${totalDone} 个｜徽章 ${store.badges.length} 枚\n`;
  if (lines.length === 0) {
    s += '📭 任务线尚未初始化：没有章节。可引导用户做顶层设计（愿景/目标），然后创建主线章节（人生阶段）和素质线（培养方向）。\n';
    return s;
  }
  // 主线（当前章节 = 第一个已解锁且未全部完成的章节）
  const mains = lines.filter(l => l.type === 'main').sort((a, b) => a.sort - b.sort);
  if (mains.length > 0) {
    const cur = mains.find(l => {
      if (!tlMainLineUnlocked(store, l)) return false;
      const lqs = quests.filter(q => q.lineId === l.id);
      if (lqs.length === 0) return true; // 空章节视为当前
      return !lqs.every(q => q.status === 'done');
    }) || mains[mains.length - 1];
    const idx = mains.indexOf(cur) + 1;
    s += `📖 主线：当前第 ${idx} 章「${cur.name}」[ID:${cur.id}]\n`;
    // 全部主线章节带 ID（供 quest_create / quest_update 指定 lineId）
    for (const m of mains) {
      const mqs = quests.filter(q => q.lineId === m.id);
      const mdone = mqs.filter(q => q.status === 'done').length;
      const lock = tlMainLineUnlocked(store, m) ? '' : ' 🔒';
      const curMark = m.id === cur.id ? '（当前）' : '';
      s += `   · [ID:${m.id}] 第${mains.indexOf(m) + 1}章「${m.name}」${lock}：${mdone}/${mqs.length} 完成${curMark}\n`;
      // 跨章节依赖锚点：本章主线关键任务（kind=main）的 ID，可被其他章节任务引用为 deps
      const anchors = mqs.filter(q => q.kind === 'main').slice(0, 6);
      if (anchors.length > 0) {
        s += `      关键任务锚点：` + anchors.map(a => `[ID:${a.id}]${a.title}`).join('、') + `\n`;
      }
    }
  } else {
    s += '📖 主线：未创建主线章节（type=main），可用 quest_create_line 创建（创建后返回章节 ID）。\n';
  }
  // 素质线（全部带 ID，供 AI 指定 lineId）
  const quals = lines.filter(l => l.type === 'quality').sort((a, b) => a.sort - b.sort);
  if (quals.length > 0) {
    s += `🌱 素质线（${quals.length} 条）：\n`;
    for (const q of quals) {
      const qs = quests.filter(x => x.lineId === q.id);
      const doneN = qs.filter(x => x.status === 'done').length;
      s += `   · [ID:${q.id}] ${q.name}：${doneN}/${qs.length} 完成\n`;
      // 跨章节依赖锚点：本条线主线关键任务（kind=main）的 ID
      const anchors = qs.filter(x => x.kind === 'main').slice(0, 6);
      if (anchors.length > 0) {
        s += `      关键任务锚点：` + anchors.map(a => `[ID:${a.id}]${a.title}`).join('、') + `\n`;
      }
    }
  }
  // 当前激活任务
  const active = quests.filter(q => q.status === 'active');
  if (active.length > 0) {
    s += `🎯 当前激活任务：\n`;
    for (const a of active) {
      const line = lines.find(l => l.id === a.lineId);
      const met = tlQuestCondMetCount(a);
      s += `   · [ID:${a.id}] ${a.title}（${line ? line.name + ' · ' : ''}条件 ${met}/${a.conditions.length}）\n`;
    }
  } else {
    s += '🎯 当前无激活任务。\n';
  }
  // 今日新完成
  const todayDone = quests.filter(q => q.status === 'done' && q.completedAt === today);
  if (todayDone.length > 0) s += `✅ 今日完成：${todayDone.map(q => q.title).join('、')}\n`;
  // 草稿待确认
  const drafts = quests.filter(q => q.status === 'draft');
  if (drafts.length > 0) s += `📝 待确认草稿任务 ${drafts.length} 个（可询问用户确认后转 active）：${drafts.slice(0, 5).map(q => q.title).join('、')}\n`;
  // 卡点：长期 active 但条件 0 推进
  const stuck = active.filter(a => a.conditions.length > 0 && tlQuestCondMetCount(a) === 0);
  if (stuck.length > 0) s += `⏳ 可能卡住的任务（条件尚无进展）：${stuck.slice(0, 3).map(q => q.title).join('、')}\n`;
  // DAG 设计指导：防止 AI 生成单一直线链
  s += `\n📐 DAG 设计指导：任务线是「多线交织的 DAG 图」（GTNH 风格），不是单一直线链。设计任务依赖时：
· deps 可引用任意章节的任务 ID（跨章节依赖，包括主线其他章节、其他素质线的任务），用上方 [ID:xxx] 锚点；
· 主线关键任务（kind=main）作为章节里程碑锚点，支线任务（kind=side）应挂在锚点下方或相互交叉，形成分支汇合；
· 禁止把所有任务排成 A→B→C→D 的单链：同一层级应并行展开（如主线打基础的同时，素质线可并行推进）；
· deps 必须无环（草稿阶段可自行规划整张图），跨章节引用前先用 quest_get(lineId=章节ID) 确认任务存在。
✍️ GTNH 任务描述风格（写 quest_create / quest_update 的 desc 时遵循）：像通关过的老玩家坐在旁边教你——第二人称"你"的向导口吻，短句+感叹号，轻松俏皮不端着。结构四段式：①钩子开场（"是时候...了"/"什么...?"/"你可能已经注意到..."）；②怎么做（具体路径，需要配方时用 NEI/tooltip 指路，不抄清单）；③意义/价值（"你将会..."，为什么重要）；④收尾激励（"作为奖励..."/"祝你好运"）。标题要短且有梗（谐音/口语），如「奶牛应该Moo!」。禁止说明书腔（第一步/第二步）、学术腔（综上所述）、空洞口号（努力吧）和网络烂梗。内容可以硬核，语气永远轻松。`;
  return s;
}

// ─────────────────────── 即时反馈队列 ───────────────────────
function tlDrainFeedback() {
  const store = loadTaskLineStore();
  const fb = store._feedback || [];
  delete store._feedback;
  saveTaskLineStore(store);
  return fb;
}
// 取走反馈队列并弹系统通知（供待办联动等外部调用）
function tlDrainFeedbackAndNotify() {
  const fb = tlDrainFeedback();
  if (fb.length === 0 || typeof sendNotification !== 'function') return;
  for (const f of fb) {
    if (f.type === 'complete') {
      sendNotification('🏆 任务线：任务完成', `「${f.title}」的条件已全部达成！`, 'taskline-complete');
    }
  }
}
// 待办完成联动：外部（如 toggleTodo）在保存待办后调用
function tlOnTodosChanged() {
  if (typeof tlRefreshAll === 'function') tlRefreshAll();
  tlDrainFeedbackAndNotify();
}

// ─────────────────────── 统计辅助 ───────────────────────
function tlLineProgress(line) {
  const store = loadTaskLineStore();
  const qs = store.quests.filter(q => q.lineId === line.id);
  if (qs.length === 0) return { total: 0, done: 0, percent: 0, locked: false };
  const done = qs.filter(q => q.status === 'done').length;
  const skipped = qs.filter(q => q.status === 'skipped').length;
  const percent = Math.round((done + skipped) / qs.length * 100);
  const locked = line.type === 'main' && !tlMainLineUnlocked(store, line);
  return { total: qs.length, done, skipped, percent, locked };
}

// ─────────────────────── 任务图布局（GTNH 式平面图） ───────────────────────
let tlActiveLineId = null;
let tlDragMode = true; // 拖拽模式：默认开启，可直接拖动节点（点击=打开详情，按住拖动=移动）
let tlSuppressClick = false; // 拖动后抑制节点 click（避免误开详情）
let tlDraggingQuestId = null; // 拖拽锁：拖拽中跳过 renderTaskLine 重绘（防同步重绘导致节点回弹）
const TL_NODE_H = 52;
const TL_GAP_X = 56;
const TL_GAP_Y = 20;
const TL_PAD = 60;

function tlComputeDepth(quests) {
  const depth = {};
  const visiting = {};
  function calc(q) {
    if (depth[q.id] !== undefined) return depth[q.id];
    if (q._ext) { depth[q.id] = 0; return 0; } // 外部占位节点：深度 0，不展开其依赖
    if (visiting[q.id]) { depth[q.id] = 0; return 0; } // 循环防护
    visiting[q.id] = true;
    const deps = (q.deps || []).filter(did => quests.some(x => x.id === did));
    let d = 0;
    for (const did of deps) {
      const dep = quests.find(x => x.id === did);
      d = Math.max(d, calc(dep) + 1);
    }
    depth[q.id] = d;
    delete visiting[q.id];
    return d;
  }
  quests.forEach(q => calc(q));
  return depth;
}
// 计算两个节点之间"最接近"的连接锚点：从前置节点最接近目标节点的那条边，
// 指向目标节点最接近前置节点的那条边。
// 锚点始终取边的中点；在两对候选中点（水平：左右边中点对 / 垂直：上下边中点对）
// 中按欧氏距离选择更短的一对，保证连线从最近的中点进出。
// 特殊规则：两节点在水平方向有重叠（一方右端超过另一方左端）时，
// 禁止用左/右缘中点连接（箭头会穿进重叠区域），强制改用上下边中点对。
function tlEdgeAnchorPoints(a, b) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  // 水平方向是否重叠：a 的右端 > b 的左端 且 b 的右端 > a 的左端
  const hOverlap = a.x + a.w > b.x && b.x + b.w > a.x;
  // 垂直中点对：a 上 b 下 → a 底缘中点 ↔ b 顶缘中点；反之互换
  let v1, v2;
  if (acy <= bcy) { v1 = { x: acx, y: a.y + a.h }; v2 = { x: bcx, y: b.y }; }
  else { v1 = { x: acx, y: a.y }; v2 = { x: bcx, y: b.y + b.h }; }
  if (hOverlap) {
    // 水平重叠：左/右缘中点会穿入重叠区，强制用垂直（上下边）中点对
    return { x1: v1.x, y1: v1.y, x2: v2.x, y2: v2.y, vertical: true };
  }
  // 水平中点对：a 左 b 右 → a 右缘中点 ↔ b 左缘中点；反之互换
  let h1, h2;
  if (acx <= bcx) { h1 = { x: a.x + a.w, y: acy }; h2 = { x: b.x, y: bcy }; }
  else { h1 = { x: a.x, y: acy }; h2 = { x: b.x + b.w, y: bcy }; }
  const dist2 = (p, q) => (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
  const useH = dist2(h1, h2) <= dist2(v1, v2);
  if (useH) return { x1: h1.x, y1: h1.y, x2: h2.x, y2: h2.y, vertical: false };
  return { x1: v1.x, y1: v1.y, x2: v2.x, y2: v2.y, vertical: true };
}

// 返回 { width, height, nodes: { id, x, y, w }, edges: [{x1,y1,x2,y2,ext,vertical}], manual }
// extQuests：跨章节外部占位任务（渲染为虚线灰框，不参与条件/解锁逻辑）
function tlLayoutGraph(quests, extQuests) {
  const extList = (extQuests || []).map(e => Object.assign({}, e, { _ext: true, sort: -1 }));
  const all = extList.concat(quests);
  // 整章手动布局：本章节内任一任务设置了 pos（画布坐标）即切换为手动画布
  const manual = quests.some(q => q.pos && typeof q.pos.x === 'number' && typeof q.pos.y === 'number');
  if (manual) return tlLayoutGraphManual(quests, extList, all);
  const depthMap = tlComputeDepth(all);
  const maxDepth = all.length > 0 ? Math.max(...Object.values(depthMap)) : 0;
  const byDepth = [];
  for (let i = 0; i <= maxDepth; i++) byDepth.push([]);
  const sorted = all.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  for (const q of sorted) byDepth[depthMap[q.id]].push(q);
  const colW = new Array(maxDepth + 1).fill(0);
  const nodeW = {};
  for (const q of all) {
    const len = (q.title || '').length;
    nodeW[q.id] = Math.min(230, Math.max(110, len * 14 + 56));
  }
  for (let d = 0; d <= maxDepth; d++) {
    if (byDepth[d].length > 0) colW[d] = Math.max(...byDepth[d].map(q => nodeW[q.id]));
  }
  const colX = [0];
  for (let d = 1; d <= maxDepth; d++) colX[d] = colX[d - 1] + colW[d - 1] + TL_GAP_X;
  const nodes = {};
  let maxX = 0, maxY = 0;
  for (let d = 0; d <= maxDepth; d++) {
    const col = byDepth[d];
    const cw = colW[d];
    col.forEach((q, i) => {
      const x = TL_PAD + colX[d] + Math.round((cw - nodeW[q.id]) / 2);
      const y = TL_PAD + i * (TL_NODE_H + TL_GAP_Y);
      nodes[q.id] = { x, y, w: nodeW[q.id], h: TL_NODE_H, depth: d };
      maxX = Math.max(maxX, x + nodeW[q.id]);
      maxY = Math.max(maxY, y + TL_NODE_H);
    });
  }
  const edges = [];
  for (const q of quests) {
    const srcPos = nodes[q.id];
    if (!srcPos) continue;
    for (const did of (q.deps || [])) {
      const depPos = nodes[did];
      if (!depPos) continue;
      const dep = all.find(x => x.id === did);
      const pt = tlEdgeAnchorPoints(depPos, srcPos);
      edges.push({
        x1: pt.x1, y1: pt.y1, x2: pt.x2, y2: pt.y2,
        vertical: pt.vertical,
        ext: !!(dep && dep._ext) // 指向外部占位节点的边用虚线
      });
    }
  }
  return { width: maxX + TL_PAD, height: maxY + TL_PAD, nodes, edges, manual: false, minX: 0, minY: 0 };
}

// 手动布局：有 pos 的任务按坐标放置，无 pos 的任务排到默认区，外部占位节点放最左侧，箭头仍按 deps 自动连接。
// 坐标允许为负（节点可拖到画布左/上边界外）：计算内容范围 minX/minY/maxX/maxY，
// 渲染时 SVG viewBox 与 nodes 容器据此平移，使负坐标区域同样可见。
function tlLayoutGraphManual(quests, extList, all) {
  const nodeW = {};
  for (const q of all) {
    const len = (q.title || '').length;
    nodeW[q.id] = Math.min(230, Math.max(110, len * 14 + 56));
  }
  const nodes = {};
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const track = (x, y, w) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + TL_NODE_H);
  };
  // 1) 有 pos 的任务：按坐标放置（pos 可为负 → x/y 可为负）
  for (const q of quests) {
    if (!q.pos || typeof q.pos.x !== 'number' || typeof q.pos.y !== 'number') continue;
    const x = TL_PAD + q.pos.x;
    const y = TL_PAD + q.pos.y;
    nodes[q.id] = { x, y, w: nodeW[q.id], h: TL_NODE_H, manual: true };
    track(x, y, nodeW[q.id]);
  }
  // 2) 外部占位节点：放最左侧一列
  let extY = TL_PAD;
  for (const ext of extList) {
    const x = TL_PAD;
    nodes[ext.id] = { x, y: extY, w: nodeW[ext.id], h: TL_NODE_H, manual: true };
    track(x, extY, nodeW[ext.id]);
    extY += TL_NODE_H + TL_GAP_Y;
  }
  // 3) 无 pos 的任务：排到默认区（右下依次排列）
  const noPos = quests.filter(q => !q.pos || typeof q.pos.x !== 'number');
  let autoY = (maxY === -Infinity ? TL_PAD : maxY) + TL_GAP_Y;
  let autoX = TL_PAD;
  for (const q of noPos) {
    nodes[q.id] = { x: autoX, y: autoY, w: nodeW[q.id], h: TL_NODE_H, manual: true };
    track(autoX, autoY, nodeW[q.id]);
    autoX += nodeW[q.id] + TL_GAP_X;
  }
  // 4) 依赖连线（箭头跟随 deps，位置自由）
  const edges = [];
  for (const q of quests) {
    const srcPos = nodes[q.id];
    if (!srcPos) continue;
    for (const did of (q.deps || [])) {
      const depPos = nodes[did];
      if (!depPos) continue;
      const dep = all.find(x => x.id === did);
      const pt = tlEdgeAnchorPoints(depPos, srcPos);
      edges.push({
        x1: pt.x1, y1: pt.y1, x2: pt.x2, y2: pt.y2,
        vertical: pt.vertical,
        ext: !!(dep && dep._ext) // 指向外部占位节点的边用虚线
      });
    }
  }
  if (minX === Infinity) { minX = TL_PAD; minY = TL_PAD; maxX = TL_PAD; maxY = TL_PAD; }
  // 内容范围含负坐标：宽高覆盖 min..max，并记录 minX/minY 供渲染平移 viewBox/nodes
  const width = (maxX - minX) + TL_PAD;
  const height = (maxY - minY) + TL_PAD;
  return { width, height, nodes, edges, manual: true, minX, minY };
}

// ─────────────────────── UI 渲染（GTNH 任务图 + 章节目录浮窗） ───────────────────────
function renderTaskLine() {
  const app = document.getElementById('tasklineApp');
  if (!app) return;
  // 拖拽锁：拖拽过程中跳过重绘。sync.js 的 _refreshUI 会调用 renderTaskLine()，
  // 若拖拽中（未松手）同步/Realtime 触发重绘，会重建 DOM 并把节点重置回原位置 → 视觉"回弹"。
  if (tlDraggingQuestId !== null) return;
  if (typeof tlRefreshAll === 'function') tlRefreshAll();
  tlDrainFeedbackAndNotify();
  const store = loadTaskLineStore();
  if (store.lines.length === 0) {
    tlActiveLineId = null;
  } else if (!store.lines.some(l => l.id === tlActiveLineId)) {
    tlActiveLineId = store.lines[0].id;
  }
  const line = store.lines.find(l => l.id === tlActiveLineId) || null;
  let html = '';
  // 任务图画布：占满整个卡片
  html += `<div class="tl-layout">`;
  html += `<div class="tl-main">`;
  if (tlMainView === 'badges') {
    // 主区域：徽章与奖励界面
    html += tlRenderBadgesMain(store);
  } else if (!line) {
    html += `<div class="tl-empty tl-empty-big">
      <i data-lucide="map" class="lucide-icon" style="width:52px;height:52px;opacity:.35;"></i>
      <p>任务线尚未开始。在 AI 对话中说「把我的目标拆成任务线」，让 AI 设计主线章节和素质线，任务图会在这里展开。</p>
      <div class="tl-empty-actions">
        <button class="btn-add" onclick="tlOpenLineForm('main')"><i data-lucide="flag" class="lucide-icon" style="width:14px;height:14px;"></i>新建主线章节</button>
        <button class="btn-add" onclick="tlOpenLineForm('quality')"><i data-lucide="sprout" class="lucide-icon" style="width:14px;height:14px;"></i>新建素质线</button>
      </div>
    </div>`;
  } else {
    html += tlRenderGraph(store, line);
  }
  html += `</div>`;
  // 右侧 hover 触发条（仿左侧界面栏）
  html += `<div class="tl-sidebar-hover-trigger" id="tlSidebarHoverTrigger" title="展开任务线侧边栏"></div>`;
  // 手机端「章节」按钮（无 hover，手机用按钮打开右侧侧边栏）
  html += `<button class="tl-mobile-side-btn" onclick="tlToggleSidebar()" title="章节 / 徽章与奖励">
    <i data-lucide="layout-list" class="lucide-icon"></i><span>章节</span>
  </button>`;
  html += `</div>`;
  // 右侧侧边栏：fixed 浮层，hover 滑入
  html += tlRenderSidebar(store, line);
  app.innerHTML = html;
  tlApplyGraphView(); // 恢复画布缩放/平移视图状态（若有画布）
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
  initTlSidebarHover();
}

// 单章节任务图
function tlRenderGraph(store, line) {
  const quests = store.quests.filter(q => q.lineId === line.id);
  const p = tlLineProgress(line);
  const isLocked = p.locked;
  if (quests.length === 0) {
    return `<div class="tl-empty">
      <i data-lucide="swords" class="lucide-icon" style="width:44px;height:44px;opacity:.35;"></i>
      <p>「${escapeHtml(line.name)}」还没有任务。让 AI 设计任务（会说清每个任务的目标、意义、产出），或手动添加。</p>
      <div class="tl-empty-actions">
        <button class="btn-add" onclick="tlOpenQuestForm(${line.id})"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i>添加任务</button>
      </div>
    </div>`;
  }
  // 跨章节依赖：收集本章节任务指向其他章节任务的 deps，作为外部占位节点参与布局
  const inLineIds = new Set(quests.map(q => q.id));
  const extById = {};
  for (const q of quests) {
    for (const did of (q.deps || [])) {
      if (inLineIds.has(did)) continue;
      const ext = store.quests.find(x => x.id === did);
      if (ext && !extById[ext.id]) extById[ext.id] = ext;
    }
  }
  const extQuests = Object.values(extById);
  const layout = tlLayoutGraph(quests, extQuests);
  const lineNameById = {};
  for (const l of store.lines) lineNameById[l.id] = l.name;
  let nodesHtml = '';
  for (const q of quests) {
    const pos = layout.nodes[q.id];
    if (!pos) continue;
    const iconMap = { draft: '✏️', locked: '🔒', active: '▶️', done: '✅', skipped: '⏭️' };
    const met = tlQuestCondMetCount(q);
    const condStr = q.conditions.length > 0 ? `条件 ${met}/${q.conditions.length}` : '';
    const kindTag = q.kind === 'main' ? '<span class="tl-node-kind">主线</span>' : '';
    nodesHtml += `<div class="tl-node tl-node-${q.kind} tl-node-${q.status}${q.milestone ? ' tl-node-milestone' : ''}${tlDragMode ? ' tl-node-draggable' : ''}"
      style="left:${pos.x}px;top:${pos.y}px;width:${pos.w}px;"
      data-qid="${q.id}"
      onmousedown="return tlNodeDragStart(event, ${q.id})"
      ontouchstart="return tlNodeDragTouchStart(event, ${q.id})"
      onclick="tlOpenQuestDetail(${q.id})"
      oncontextmenu="tlShowQuestContextMenu(event, ${q.id})"
      title="${escapeHtml(q.title)}">
      <div class="tl-node-head">
        <span class="tl-node-icon">${iconMap[q.status] || '❓'}</span>
        ${kindTag}
      </div>
      <div class="tl-node-title">${escapeHtml(q.title)}</div>
      ${condStr ? `<div class="tl-node-cond">${condStr}</div>` : ''}
    </div>`;
  }
  // 外部占位节点（其他章节的任务，点击跳转到对应章节并高亮）
  for (const ext of extQuests) {
    const pos = layout.nodes[ext.id];
    if (!pos) continue;
    const extLineName = lineNameById[ext.lineId] || '其他章节';
    nodesHtml += `<div class="tl-node tl-node-ext"
      style="left:${pos.x}px;top:${pos.y}px;width:${pos.w}px;"
      data-qid="${ext.id}"
      onclick="tlGotoExternalQuest(${ext.id})"
      title="来自「${escapeHtml(extLineName)}」的任务，点击跳转查看">
      <div class="tl-node-head">
        <span class="tl-node-icon">🔗</span>
        <span class="tl-node-ext-tag">${escapeHtml(extLineName)}</span>
      </div>
      <div class="tl-node-title">${escapeHtml(ext.title)}</div>
    </div>`;
  }
  let edgesHtml = '';
  for (const e of layout.edges) {
    const cls = e.ext ? 'tl-edge tl-edge-ext' : 'tl-edge';
    let d;
    if (e.vertical) {
      const my = (e.y1 + e.y2) / 2;
      d = `M ${e.x1} ${e.y1} C ${e.x1} ${my}, ${e.x2} ${my}, ${e.x2} ${e.y2}`;
    } else {
      const mx = (e.x1 + e.x2) / 2;
      d = `M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}`;
    }
    edgesHtml += `<path class="${cls}" d="${d}" marker-end="url(#tlArrow)"/>`;
  }
  // 图例（浮动在画布右下角）
  const extCount = quests.reduce((acc, q) => {
    for (const did of (q.deps || [])) {
      const dep = store.quests.find(x => x.id === did);
      if (dep && dep.lineId !== line.id) { acc.push(did); break; }
    }
    return acc;
  }, []).length;
  const legendHtml = `<div class="tl-graph-legend tl-graph-legend-float">
    <span class="tl-legend-item"><span class="tl-legend-swatch tl-legend-main"></span>主线关键</span>
    <span class="tl-legend-item"><span class="tl-legend-swatch tl-legend-side"></span>支线任务</span>
    <span class="tl-legend-item"><i data-lucide="lock" class="lucide-icon" style="width:11px;height:11px;"></i>未解锁</span>
    <span class="tl-legend-item"><i data-lucide="check" class="lucide-icon" style="width:11px;height:11px;"></i>已完成</span>
    ${extCount > 0 ? `<span class="tl-legend-item"><span class="tl-legend-swatch tl-legend-ext"></span>跨章节依赖</span>` : ''}
  </div>`;
  const lockedBanner = isLocked ? `<div class="tl-locked-banner tl-locked-banner-float"><i data-lucide="lock" class="lucide-icon" style="width:14px;height:14px;"></i> 前置章节未完成，本章节任务已锁定</div>` : '';
  // 内容可能含负坐标（拖到左/上边界外）：nodes 容器与 SVG 整体平移 -minX/-minY，
  // 使负坐标区域落入画布可视范围；viewBox 起点为 (minX, minY) 保持连线坐标对应。
  const shiftX = -(layout.minX || 0), shiftY = -(layout.minY || 0);
  const vbX = layout.minX || 0, vbY = layout.minY || 0;
  return `<div class="tl-graph-wrap" id="tlGraphWrap" oncontextmenu="tlShowGraphContextMenu(event, ${line.id})">
    <div class="tl-graph-canvas" onmousedown="tlGraphCanvasDown(event)" ontouchstart="tlGraphCanvasTouchStart(event)" onwheel="tlGraphCanvasWheel(event)">
      <div class="tl-graph-inner" style="width:${layout.width}px;height:${layout.height}px;">
        <svg class="tl-graph-svg" width="${layout.width}" height="${layout.height}" viewBox="${vbX} ${vbY} ${layout.width} ${layout.height}">
          <defs><marker id="tlArrow" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L8,3.5 L0,7 Z" fill="var(--primary)"/></marker></defs>
          ${edgesHtml}
        </svg>
        <div class="tl-graph-nodes" style="left:${shiftX}px;top:${shiftY}px;">${nodesHtml}</div>
      </div>
    </div>
    ${lockedBanner}
    ${legendHtml}
    <div class="tl-zoom-indicator" id="tlZoomIndicator" onclick="tlResetGraphView()" title="复位视图（快捷键 R）：恢复 100% 缩放与初始位置">100%</div>
  </div>`;
}

// 主区域视图：'graph' 章节画布（默认） | 'badges' 徽章与奖励界面
let tlMainView = 'graph';
function tlShowBadges() {
  tlMainView = 'badges';
  renderTaskLine();
}

// 右侧侧边栏：fixed 浮层（仿左侧界面栏，hover 滑入/收起）
// 仅章节列表（主线 + 独立章节）+ 底部「徽章与奖励」入口；
// 章节级操作（拖拽/加任务/编辑/删除）移到任务图右键菜单
function tlRenderSidebar(store, line) {
  let html = `<div class="tl-sidebar" id="tlSidebar">`;
  html += `<div class="tl-side-bar-head">
    <span class="tl-side-bar-title">任务线</span>
    <button class="tl-side-toggle" onclick="tlToggleSidebar()" title="收起侧边栏"><i data-lucide="panel-right-close" class="lucide-icon" style="width:15px;height:15px;"></i></button>
  </div>`;
  // 主线章节（无标题、无框）
  html += `<div class="tl-side-group">${tlRenderSideLines(store, 'main')}</div>`;
  html += `<div class="tl-side-sep"></div>`;
  // 独立章节（无标题、无框）
  html += `<div class="tl-side-group">${tlRenderSideLines(store, 'quality')}</div>`;
  html += `<div class="tl-side-sep"></div>`;
  // 徽章与奖励入口：点击后主卡片切换为徽章奖励界面
  html += `<button class="tl-side-entry ${tlMainView === 'badges' ? 'active' : ''}" onclick="tlShowBadges()">
    <i data-lucide="award" class="lucide-icon" style="width:15px;height:15px;"></i>
    <span>徽章与奖励</span>
    <i data-lucide="chevron-right" class="lucide-icon" style="width:13px;height:13px;margin-left:auto;"></i>
  </button>`;
  html += `</div>`;
  return html;
}

// 侧边栏-章节列表项（type: main | quality），点击切换当前章节并回画布视图
function tlRenderSideLines(store, type) {
  const lines = store.lines.filter(l => l.type === type).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  if (lines.length === 0) return `<div class="tl-catalog-empty">暂无${type === 'main' ? '主线' : '独立'}章节</div>`;
  return lines.map(l => {
    const p = tlLineProgress(l);
    const isCur = l.id === tlActiveLineId && tlMainView !== 'badges';
    const curMark = isCur ? '<span class="tl-catalog-cur">当前</span>' : '';
    const lockMark = p.locked ? ' <span class="tl-catalog-lock">🔒</span>' : '';
    return `<div class="tl-catalog-item ${isCur ? 'active' : ''}" onclick="tlSwitchLine(${l.id})">
      <div class="tl-catalog-item-main">
        <span class="tl-catalog-name">${escapeHtml(l.name)}</span>${curMark}${lockMark}
        <span class="tl-catalog-progress">${p.done}/${p.total} · ${p.percent}%</span>
      </div>
    </div>`;
  }).join('');
}

// 主区域-徽章与奖励界面（点侧边栏「徽章与奖励」入口后主卡片显示）
function tlRenderBadgesMain(store) {
  const doneCount = tlDoneCount(store);
  const balance = tlRewardBalance(store);
  let html = `<div class="tl-badges-main">`;
  html += `<div class="tl-badges-main-head">
    <span class="tl-badges-main-title"><i data-lucide="award" class="lucide-icon" style="width:18px;height:18px;"></i> 徽章与奖励</span>
  </div>`;
  // 徽章收藏
  html += `<div class="tl-badges-card">
    <div class="tl-catalog-label">徽章收藏</div>
    ${store.badges.length === 0
      ? '<div class="tl-badge-empty">完成第一个任务即可获得首枚徽章</div>'
      : `<div class="tl-badge-list tl-badges-big">${store.badges.slice().reverse().map(b => `
          <div class="tl-badge" title="${escapeHtml(b.desc)}">
            <div class="tl-badge-icon">${b.icon}</div>
            <div class="tl-badge-name">${escapeHtml(b.name)}</div>
            <div class="tl-badge-date">${(new Date(b.earnedAt)).toLocaleDateString('zh-CN')}</div>
          </div>`).join('')}</div>`}
  </div>`;
  // 自定义奖励池
  html += `<div class="tl-badges-card">
    <div class="tl-catalog-label">自定义奖励池 <span class="tl-pool-hint">完成任务解锁自己的欲望清单</span></div>
    <div class="tl-pool-balance">已完成任务 ${doneCount} 个｜可兑换额度 <b>${balance}</b></div>
    <div class="tl-pool-form">
      <input type="text" id="tlRewardName" placeholder="奖励名称，如：看一集剧 / 一杯奶茶">
      <input type="number" id="tlRewardCost" placeholder="需完成任务数" style="width:110px;" min="1" value="1">
      <button class="btn-add" onclick="tlSubmitReward()"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i>添加</button>
    </div>
    <div class="tl-pool-list">
      ${store.rewards.length === 0
        ? '<div class="tl-badge-empty">暂无自定义奖励，添加一个让自己有期待的目标吧</div>'
        : store.rewards.map(r => `
          <div class="tl-pool-item ${r.redeemed ? 'tl-pool-redeemed' : ''}">
            <span class="tl-pool-icon">${r.icon}</span>
            <span class="tl-pool-name">${escapeHtml(r.name)}</span>
            <span class="tl-pool-cost">${r.redeemed ? '已兑换' : r.cost + ' 任务'}</span>
            ${r.redeemed
              ? `<button class="notes-undo-btn" onclick="tlDeleteReward(${r.id})" title="删除"><i data-lucide="trash-2" class="lucide-icon" style="width:12px;height:12px;"></i></button>`
              : `<button class="notes-undo-btn tl-pool-redeem-btn" onclick="tlRedeemReward(${r.id})" title="兑换"><i data-lucide="gift" class="lucide-icon" style="width:12px;height:12px;"></i></button>
                 <button class="notes-undo-btn" onclick="tlDeleteReward(${r.id})" title="删除"><i data-lucide="trash-2" class="lucide-icon" style="width:12px;height:12px;"></i></button>`}
          </div>`).join('')}
    </div>
  </div>`;
  html += `</div>`;
  return html;
}


// ── 右侧侧边栏（hover 触发）/ 拖拽模式切换 / 节点拖动 ──
let tlSidebarCloseTimer = null;
const TL_SIDEBAR_HOVER_DELAY = 300;

function openTlSidebar() {
  if (tlSidebarCloseTimer) { clearTimeout(tlSidebarCloseTimer); tlSidebarCloseTimer = null; }
  const sb = document.getElementById('tlSidebar');
  if (sb) sb.classList.add('open');
}
function scheduleCloseTlSidebar() {
  if (tlSidebarCloseTimer) clearTimeout(tlSidebarCloseTimer);
  tlSidebarCloseTimer = setTimeout(function () {
    const sb = document.getElementById('tlSidebar');
    if (sb) sb.classList.remove('open');
    tlSidebarCloseTimer = null;
  }, TL_SIDEBAR_HOVER_DELAY);
}
function tlToggleSidebar() {
  const sb = document.getElementById('tlSidebar');
  if (!sb) return;
  if (sb.classList.contains('open')) sb.classList.remove('open');
  else sb.classList.add('open');
}
function initTlSidebarHover() {
  const trigger = document.getElementById('tlSidebarHoverTrigger');
  const sb = document.getElementById('tlSidebar');
  if (!trigger || !sb) return;
  trigger.addEventListener('mouseenter', openTlSidebar);
  sb.addEventListener('mouseenter', openTlSidebar);
  sb.addEventListener('mouseleave', scheduleCloseTlSidebar);
}
function tlToggleDragMode() {
  tlDragMode = !tlDragMode;
  renderTaskLine();
}

// ── 任务图右键菜单（拖拽切换 / 添加任务 / 编辑章节 / 删除章节）──
let tlGraphCtxLineId = null;
// 右键位置相对画布 inner 的坐标（用于「添加任务」定位，pos 需减去 TL_PAD 偏移）
let tlGraphCtxPos = null;
function tlShowGraphContextMenu(ev, lineId) {
  ev.preventDefault();
  ev.stopPropagation();
  tlCloseQuestContextMenu(); // 任务级菜单已打开时，先关闭再显示图级菜单
  const menu = document.getElementById('tlTaskContextMenu');
  if (!menu) return;
  tlGraphCtxLineId = lineId;
  // 记录鼠标在画布 inner 内的位置（相对 inner 左上角，含平移偏移后的实际画布坐标）
  const wrap = ev.currentTarget.closest('.tl-graph-wrap');
  const inner = wrap ? wrap.querySelector('.tl-graph-inner') : null;
  if (inner) {
    const iRect = inner.getBoundingClientRect();
    // 除以当前缩放：iRect 是 transform 后的视觉尺寸，需换算回画布绝对坐标
    tlGraphCtxPos = { x: (ev.clientX - iRect.left) / tlGraphView.scale, y: (ev.clientY - iRect.top) / tlGraphView.scale };
  } else {
    tlGraphCtxPos = null;
  }
  // 同步当前拖拽模式状态
  const dragItem = menu.querySelector('#tlCtxDragMode');
  if (dragItem) {
    dragItem.innerHTML = `<i data-lucide="${tlDragMode ? 'hand' : 'move'}" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> ${tlDragMode ? '关闭拖拽模式' : '开启拖拽模式'}`;
  }
  // 同步自动完成状态
  const store = loadTaskLineStore();
  const autoItem = menu.querySelector('#tlCtxAutoComplete');
  if (autoItem) {
    const on = store.toggle.autoComplete !== false;
    autoItem.innerHTML = `<i data-lucide="${on ? 'check-circle' : 'circle'}" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i> ${on ? '自动完成：开' : '自动完成：关'}`;
  }
  menu.style.left = ev.clientX + 'px';
  menu.style.top = ev.clientY + 'px';
  menu.classList.add('visible');
  // 边界修正
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlCloseGraphContextMenu() {
  const menu = document.getElementById('tlTaskContextMenu');
  if (menu) menu.classList.remove('visible');
  tlGraphCtxLineId = null;
}

// ── 任务级右键菜单（跳过 / 确认 / 完成 / 编辑 / 删除）──
let tlQuestCtxId = null;
function tlShowQuestContextMenu(ev, questId) {
  ev.preventDefault();
  ev.stopPropagation();
  tlCloseGraphContextMenu(); // 图级菜单已打开时，先关闭再显示任务级菜单
  const menu = document.getElementById('tlQuestContextMenu');
  if (!menu) return;
  tlQuestCtxId = questId;
  const q = tlGetQuest(questId);
  if (!q) return;
  // 同步「确认任务 / 完成任务」按钮的显示状态
  const confirmItem = document.getElementById('tlQCtxConfirm');
  const doneItem = document.getElementById('tlQCtxDone');
  const skipItem = document.getElementById('tlQCtxSkip');
  if (confirmItem) confirmItem.style.display = q.status === 'draft' ? '' : 'none';
  if (doneItem) doneItem.style.display = q.status === 'active' ? '' : 'none';
  if (skipItem) skipItem.style.display = q.status === 'done' ? 'none' : '';
  // 已完成的额外禁用删除？不，删除始终可用
  menu.style.left = ev.clientX + 'px';
  menu.style.top = ev.clientY + 'px';
  menu.classList.add('visible');
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlCloseQuestContextMenu() {
  const menu = document.getElementById('tlQuestContextMenu');
  if (menu) menu.classList.remove('visible');
  tlQuestCtxId = null;
}
// 任务级菜单动作
function tlQCtxSkip() {
  const id = tlQuestCtxId;
  tlCloseQuestContextMenu();
  if (id != null) tlSkipQuest(id);
}
function tlQCtxConfirm() {
  const id = tlQuestCtxId;
  tlCloseQuestContextMenu();
  if (id != null) tlActivateQuest(id);
}
function tlQCtxDone() {
  const id = tlQuestCtxId;
  tlCloseQuestContextMenu();
  if (id != null) tlCompleteQuest(id);
}
function tlQCtxEdit() {
  const id = tlQuestCtxId;
  tlCloseQuestContextMenu();
  if (id != null) tlEditQuestForm(id);
}
function tlQCtxDelete() {
  const id = tlQuestCtxId;
  tlCloseQuestContextMenu();
  if (id != null) tlDeleteQuestAsk(id);
}
// 右键菜单动作
function tlCtxToggleDrag() {
  tlCloseGraphContextMenu();
  tlToggleDragMode();
}
function tlCtxAddQuest() {
  const id = tlGraphCtxLineId;
  const p = tlGraphCtxPos;
  tlCloseGraphContextMenu();
  if (id != null) tlOpenQuestForm(id, p);
}
function tlCtxEditLine() {
  const id = tlGraphCtxLineId;
  tlCloseGraphContextMenu();
  if (id != null) tlOpenLineEditForm(id);
}
function tlCtxDeleteLine() {
  const id = tlGraphCtxLineId;
  tlCloseGraphContextMenu();
  if (id != null) tlDeleteLineAsk(id);
}
// ── 画布平移（手型工具）──
// 视口固定为主卡片区域（overflow hidden），拖动空白处平移 .tl-graph-inner 位置
let tlGraphPan = null; // { startX, startY, origLeft, origTop }
// 平移自由余量：内容允许完全拖出视口（露出的空白区域大小），防止拖到找不回
const TL_PAN_MARGIN = 150;
// 画布缩放范围：40% ~ 300%
const TL_SCALE_MIN = 0.4, TL_SCALE_MAX = 3;
// 画布视图状态：缩放比例 + 内容偏移（px）。重绘后由 tlApplyGraphView 恢复。
let tlGraphView = { scale: 1, left: 0, top: 0 };
// 视图状态钳制（内容不会完全拖出视口）
function tlClampGraphView(inner, canvas) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const iw = inner.offsetWidth * tlGraphView.scale, ih = inner.offsetHeight * tlGraphView.scale;
  // 钳制范围：允许内容两侧各留 TL_PAN_MARGIN 余量，但必须保证内容右缘/下缘能滚入视口——
  // 旧公式下界 -(iw+margin) 会把内容右缘推到视口左侧外，导致右侧节点永远无法滚进视口
  // （拖拽跟随被钳制 → 节点"弹回来"）。
  const minL = Math.min(0, cw - iw) - TL_PAN_MARGIN;
  const maxL = Math.max(0, cw - iw) + TL_PAN_MARGIN;
  const minT = Math.min(0, ch - ih) - TL_PAN_MARGIN;
  const maxT = Math.max(0, ch - ih) + TL_PAN_MARGIN;
  const nl = Math.max(minL, Math.min(maxL, tlGraphView.left));
  const nt = Math.max(minT, Math.min(maxT, tlGraphView.top));
  tlGraphView.left = nl;
  tlGraphView.top = nt;
}
// 重绘后恢复视图（切换章节 / 拖拽节点重绘后保留缩放与平移位置）
function tlApplyGraphView() {
  if (tlMainView !== 'graph') return;
  const wrap = document.getElementById('tlGraphWrap');
  const canvas = wrap ? wrap.querySelector('.tl-graph-canvas') : null;
  const inner = canvas ? canvas.querySelector('.tl-graph-inner') : null;
  if (!canvas || !inner) return;
  tlClampGraphView(inner, canvas);
  inner.style.left = tlGraphView.left + 'px';
  inner.style.top = tlGraphView.top + 'px';
  inner.style.transform = tlGraphView.scale === 1 ? '' : `scale(${tlGraphView.scale})`;
  inner.style.transformOrigin = '0 0';
  tlUpdateGraphZoomUI();
}
// 滚轮缩放（锚定鼠标位置：缩放后鼠标指向的内容保持不动）
function tlGraphCanvasWheel(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  const canvas = ev.currentTarget;
  const inner = canvas.querySelector('.tl-graph-inner');
  if (!inner) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const factor = Math.exp(-ev.deltaY * 0.0015); // 平滑指数缩放
  const ns = Math.min(TL_SCALE_MAX, Math.max(TL_SCALE_MIN, tlGraphView.scale * factor));
  if (ns === tlGraphView.scale) return;
  const k = ns / tlGraphView.scale;
  tlGraphView.scale = ns;
  tlGraphView.left = mx - (mx - tlGraphView.left) * k;
  tlGraphView.top = my - (my - tlGraphView.top) * k;
  tlClampGraphView(inner, canvas);
  inner.style.transform = `scale(${tlGraphView.scale})`;
  inner.style.transformOrigin = '0 0';
  inner.style.left = tlGraphView.left + 'px';
  inner.style.top = tlGraphView.top + 'px';
  tlUpdateGraphZoomUI();
}
// 复位视图：恢复 100% 缩放与初始位置（快捷键 R）
function tlResetGraphView() {
  tlGraphView = { scale: 1, left: 0, top: 0 };
  const canvas = document.getElementById('tlGraphWrap');
  const inner = canvas ? canvas.querySelector('.tl-graph-inner') : null;
  if (inner) {
    inner.style.transform = '';
    inner.style.left = '0px';
    inner.style.top = '0px';
  }
  tlUpdateGraphZoomUI();
}
// 更新左下角缩放指示器
function tlUpdateGraphZoomUI() {
  const el = document.getElementById('tlZoomIndicator');
  if (el) el.textContent = Math.round(tlGraphView.scale * 100) + '%';
}
function tlGraphCanvasDown(ev) {
  // 点击到节点 / 浮动图例 / 缩放指示器 / 锁定横幅上时不平移（节点有自己的拖拽逻辑）
  if (ev.target.closest('.tl-node') || ev.target.closest('.tl-graph-legend-float') || ev.target.closest('.tl-locked-banner-float') || ev.target.closest('.tl-zoom-indicator')) return;
  const canvas = ev.currentTarget;
  const inner = canvas.querySelector('.tl-graph-inner');
  if (!inner) return;
  ev.preventDefault();
  ev.stopPropagation();
  const startX = ev.clientX, startY = ev.clientY;
  const origLeft = tlGraphView.left;
  const origTop = tlGraphView.top;
  canvas.classList.add('tl-graph-panning');
  tlGraphPan = { startX, startY, origLeft, origTop };
  function onMove(e) {
    if (!tlGraphPan) return;
    const dx = e.clientX - tlGraphPan.startX;
    const dy = e.clientY - tlGraphPan.startY;
    // 自由平移：内容可拖出视口任意一侧（露出大块空白），仅在两侧保留 TL_PAN_MARGIN 余量避免完全丢失
    tlGraphView.left = tlGraphPan.origLeft + dx;
    tlGraphView.top = tlGraphPan.origTop + dy;
    tlClampGraphView(inner, canvas);
    inner.style.left = tlGraphView.left + 'px';
    inner.style.top = tlGraphView.top + 'px';
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (canvas) canvas.classList.remove('tl-graph-panning');
    tlGraphPan = null;
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 触屏版画布平移（手机：单指拖动平移任务图画布）
function tlGraphCanvasTouchStart(ev) {
  if (ev.target.closest('.tl-node') || ev.target.closest('.tl-graph-legend-float') || ev.target.closest('.tl-locked-banner-float') || ev.target.closest('.tl-zoom-indicator')) return;
  const canvas = ev.currentTarget;
  const inner = canvas ? canvas.querySelector('.tl-graph-inner') : null;
  if (!inner || ev.touches.length !== 1) return;
  ev.preventDefault();
  ev.stopPropagation();
  const touch = ev.touches[0];
  const startX = touch.clientX, startY = touch.clientY;
  const origLeft = tlGraphView.left;
  const origTop = tlGraphView.top;
  canvas.classList.add('tl-graph-panning');
  tlGraphPan = { startX, startY, origLeft, origTop };
  let touchId = touch.identifier;
  function onMove(e) {
    if (!tlGraphPan) return;
    const t = Array.from(e.changedTouches).find(function(x) { return x.identifier === touchId; });
    if (!t) return;
    const dx = t.clientX - tlGraphPan.startX;
    const dy = t.clientY - tlGraphPan.startY;
    tlGraphView.left = tlGraphPan.origLeft + dx;
    tlGraphView.top = tlGraphPan.origTop + dy;
    tlClampGraphView(inner, canvas);
    inner.style.left = tlGraphView.left + 'px';
    inner.style.top = tlGraphView.top + 'px';
  }
  function onUp(e) {
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    document.removeEventListener('touchcancel', onUp);
    if (canvas) canvas.classList.remove('tl-graph-panning');
    tlGraphPan = null;
  }
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
  document.addEventListener('touchcancel', onUp);
}

function tlCtxToggleAuto() {
  const id = tlGraphCtxLineId;
  tlCloseGraphContextMenu();
  if (id != null) {
    const store = loadTaskLineStore();
    const on = store.toggle.autoComplete !== false;
    tlToggleAutoComplete(!on);
  }
}
// 左键/右键点击任意菜单外部时，关闭任务线右键菜单（图级 + 任务级）
function tlCloseAllContextMenus() {
  tlCloseGraphContextMenu();
  tlCloseQuestContextMenu();
}
// 快捷键：R 复位任务图视图（恢复 100% 缩放与初始位置）
document.addEventListener('keydown', function (e) {
  if (e.key !== 'r' && e.key !== 'R') return;
  // 焦点在输入框/可编辑区域时不触发
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
  // 仅当任务线章节画布可见时生效
  const section = document.getElementById('section-taskline');
  if (section && section.classList.contains('active') && document.getElementById('tlGraphWrap')) {
    e.preventDefault();
    tlResetGraphView();
  }
});
document.addEventListener('click', function (e) {
  if (!e.target.closest('#tlTaskContextMenu') && !e.target.closest('#tlQuestContextMenu')) tlCloseAllContextMenus();
});
document.addEventListener('contextmenu', function (e) {
  // 新右键菜单自身已 stopPropagation 不会冒泡到这里；此处捕获点击其它区域时关闭菜单
  if (!e.target.closest('#tlTaskContextMenu') && !e.target.closest('#tlQuestContextMenu')) tlCloseAllContextMenus();
});
// 拖拽开始（节点 onmousedown 触发；tlDragMode 关闭时返回 true 放行点击）
// 说明：节点四方向均可拖出画布边界（含负坐标），画布边界与 viewBox 在松手重绘时
// 由 tlLayoutGraphManual 一次性计算；拖拽过程中保持 nodes 平移/viewBox 不变以避免闪烁。
// 拖拽/落点后：若节点超出当前视口（.tl-graph-canvas）可视区，自动平移视图跟随，
// 保证"放出去的节点"始终可见（否则会被 overflow hidden 裁剪导致节点"消失"）。
// skipClamp=true（拖拽中使用）：跳过钳制，允许视口平移到负区域/边界外，
// 使拖到左/上边界外的节点仍可见；同时拖拽中不修改 nodes 平移与 viewBox，
// 避免所有节点视觉位置逐帧跳动（画布闪烁）。
function tlFollowNodeInView(nodeEl, skipClamp) {
  const canvas = nodeEl.closest('.tl-graph-canvas');
  const inner = nodeEl.closest('.tl-graph-inner');
  if (!canvas || !inner) return;
  const scale = tlGraphView.scale;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  // nodes 容器平移量（负坐标偏移），节点视口坐标 = inner 平移 + nodes 平移 + 节点在 nodes 内坐标 × 缩放
  const nodesEl = inner.querySelector('.tl-graph-nodes');
  const shiftX = nodesEl ? (parseFloat(nodesEl.style.left) || 0) : 0;
  const shiftY = nodesEl ? (parseFloat(nodesEl.style.top) || 0) : 0;
  const nx = tlGraphView.left + (nodeEl.offsetLeft + shiftX) * scale;
  const ny = tlGraphView.top + (nodeEl.offsetTop + shiftY) * scale;
  const nw = nodeEl.offsetWidth * scale, nh = nodeEl.offsetHeight * scale;
  let dl = 0, dt = 0;
  if (nx < 24) dl = 24 - nx;
  else if (nx + nw > cw - 24) dl = (cw - 24) - (nx + nw);
  if (ny < 24) dt = 24 - ny;
  else if (ny + nh > ch - 24) dt = (ch - 24) - (ny + nh);
  if (dl !== 0 || dt !== 0) {
    // left/top 单位即屏幕像素（transform scale 只缩放内容不缩放 left/top），
    // dl/dt 已是屏幕像素位移，直接累加即可
    tlGraphView.left += dl;
    tlGraphView.top += dt;
    if (!skipClamp) tlClampGraphView(inner, canvas);
    inner.style.left = tlGraphView.left + 'px';
    inner.style.top = tlGraphView.top + 'px';
  }
}
// 重绘后保证节点可见（复用跟随逻辑，对重绘后的新节点元素调用）
function tlEnsureNodeVisible(questId) {
  if (tlMainView !== 'graph') return;
  const wrap = document.getElementById('tlGraphWrap');
  const canvas = wrap ? wrap.querySelector('.tl-graph-canvas') : null;
  const node = canvas ? canvas.querySelector('.tl-node[data-qid="' + questId + '"]') : null;
  if (!canvas || !node) return;
  tlFollowNodeInView(node);
}
function tlNodeDragStart(ev, questId) {
  // 右键（button 2）不启动节点拖拽，留给右键菜单
  if (ev.button === 2) return true;
  if (!tlDragMode) return true; // 拖拽关闭：不拦截，正常触发 onclick 打开详情
  ev.preventDefault();
  ev.stopPropagation();
  const el = ev.currentTarget;
  const startX = ev.clientX, startY = ev.clientY;
  const origLeft = el.offsetLeft, origTop = el.offsetTop;
  const moved = { x: 0, y: 0 };
  let dragging = false;
  function onMove(e) {
    const dx = e.clientX - startX, dy = e.clientY - startY;
    moved.x = dx; moved.y = dy;
    // 屏幕像素差需除以当前缩放换算为画布坐标差
    el.style.left = (origLeft + dx / tlGraphView.scale) + 'px';
    el.style.top = (origTop + dy / tlGraphView.scale) + 'px';
    el.style.zIndex = 50;
    dragging = true;
    tlDraggingQuestId = questId; // 拖拽锁：拖拽中跳过 renderTaskLine 重绘
    // 节点超出视口时自动平移跟随（跳过钳制：允许平移到负区域/边界外），
    // 拖拽过程中不修改 nodes 平移与 viewBox，避免画布闪烁
    tlFollowNodeInView(el, true);
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!dragging) return; // 未拖动 = 点击，onclick 会打开详情
    tlDraggingQuestId = null; // 解除拖拽锁
    tlSuppressClick = true; // 拖动过：抑制随后的 click 事件
    setTimeout(function () { tlSuppressClick = false; }, 0);
    // 写入画布坐标（减去 TL_PAD，与手动布局坐标一致）。
    // 直接读取节点实际布局位置（el.offsetLeft）而非累加 moved.x：
    // 若最后一次 mousemove 未触发（快速拖拽/鼠标移出窗口），moved.x 会滞后，
    // 保存坐标偏小 → 重绘后节点"弹回"。offsetLeft 反映真实落点。
    // 允许负坐标：节点可拖到画布左/上边界外（渲染时 nodes/SVG 平移使负区域可见）。
    const q = tlGetQuest(questId);
    if (q) {
      const newX = Math.round(el.offsetLeft - TL_PAD);
      const newY = Math.round(el.offsetTop - TL_PAD);
      tlUpdateQuest(questId, { pos: { x: newX, y: newY } });
    }
    renderTaskLine(); // 重绘，重新计算连线
    // 重绘后 inner 尺寸已包含新落点（tlLayoutGraphManual 按 min/max 计算）；
    // 若落点仍落在当前视口外，自动平移视图让节点可见
    tlEnsureNodeVisible(questId);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  return false; // 阻止默认拖拽/选中
}

// 触屏版节点拖拽（手机：长按拖动节点调整画布位置）
function tlNodeDragTouchStart(ev, questId) {
  if (!tlDragMode) return true; // 拖拽关闭：放行，正常触击打开详情
  ev.preventDefault();
  ev.stopPropagation();
  const el = ev.currentTarget;
  if (ev.touches.length !== 1) return false;
  const touch = ev.touches[0];
  const startX = touch.clientX, startY = touch.clientY;
  const origLeft = el.offsetLeft, origTop = el.offsetTop;
  const moved = { x: 0, y: 0 };
  let dragging = false;
  let touchId = touch.identifier;
  // 触屏先等待 200ms 长按判定，避免误触发（画布平移与节点点击）
  let longPress = false;
  const longTimer = setTimeout(function() { longPress = true; }, 200);
  function onMove(e) {
    const t = Array.from(e.changedTouches).find(function(x) { return x.identifier === touchId; });
    if (!t || !longPress) return;
    const dx = t.clientX - startX, dy = t.clientY - startY;
    moved.x = dx; moved.y = dy;
    el.style.left = (origLeft + dx / tlGraphView.scale) + 'px';
    el.style.top = (origTop + dy / tlGraphView.scale) + 'px';
    el.style.zIndex = 50;
    dragging = true;
    tlDraggingQuestId = questId; // 拖拽锁：拖拽中跳过 renderTaskLine 重绘
    // 节点超出视口时自动平移跟随（跳过钳制：允许平移到负区域/边界外），
    // 拖拽过程中不修改 nodes 平移与 viewBox，避免画布闪烁
    tlFollowNodeInView(el, true);
  }
  function onUp() {
    clearTimeout(longTimer);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    document.removeEventListener('touchcancel', onUp);
    if (!dragging) return; // 未拖动 = 点击，onclick 打开详情
    tlDraggingQuestId = null; // 解除拖拽锁
    tlSuppressClick = true;
    setTimeout(function() { tlSuppressClick = false; }, 0);
    // 同鼠标版：直接读取节点实际布局位置，避免最后 touchmove 未触发导致坐标滞后回弹
    // 允许负坐标：节点可拖到画布左/上边界外
    const q = tlGetQuest(questId);
    if (q) {
      const newX = Math.round(el.offsetLeft - TL_PAD);
      const newY = Math.round(el.offsetTop - TL_PAD);
      tlUpdateQuest(questId, { pos: { x: newX, y: newY } });
    }
    renderTaskLine();
    // 重绘后 inner 尺寸已包含新落点；若落点仍超出视口，自动平移视图让节点可见
    tlEnsureNodeVisible(questId);
  }
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
  document.addEventListener('touchcancel', onUp);
  return false;
}

function tlSwitchLine(id) {
  tlActiveLineId = id;
  tlMainView = 'graph'; // 从侧边栏选章节 → 回到章节画布视图
  closeEditModal();
  renderTaskLine();
}

// ─────────────────────── 表单（章节/任务） ───────────────────────
function tlOpenLineForm(type) {
  tlOpenLineModal(null, type);
}
function tlOpenLineEditForm(lineId) {
  const store = loadTaskLineStore();
  const line = store.lines.find(l => l.id === lineId);
  if (!line) return;
  tlOpenLineModal(line);
}
function tlOpenLineModal(line, presetType) {
  const isEdit = !!line;
  const type = isEdit ? line.type : (presetType || 'quality');
  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="map" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> ' + (isEdit ? '编辑章节' : '新建章节');
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;min-width:320px;">
      <label class="settings-label" style="margin:0;">章节名称 *</label>
      <input type="text" id="tlLineName" value="${escapeHtml(isEdit ? line.name : '')}" placeholder="${type === 'main' ? '如：奠基 / 深耕 / 突破 / 输出' : '如：英语素质 / 体能 / 阅读'}" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);">
      <label class="settings-label" style="margin:0;">章节描述（说明这一阶段的意义）</label>
      <textarea id="tlLineDesc" rows="3" placeholder="这一阶段想培养什么、达到什么状态…" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);resize:vertical;">${escapeHtml(isEdit ? (line.desc || '') : '')}</textarea>
      <label class="settings-label" style="margin:0;">类型</label>
      <select id="tlLineType" ${isEdit ? 'disabled' : ''} style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);">
        <option value="main" ${type === 'main' ? 'selected' : ''}>主线（人生阶段，顺序推进）</option>
        <option value="quality" ${type === 'quality' ? 'selected' : ''}>素质线（并行成长）</option>
      </select>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
        <button class="notes-undo-btn" onclick="closeEditModal()">取消</button>
        <button class="btn-add" onclick="tlSubmitLineForm(${isEdit ? line.id : 'null'})"><i data-lucide="check" class="lucide-icon" style="width:14px;height:14px;"></i>保存</button>
      </div>
    </div>`;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('tlLineName').focus(), 100);
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlSubmitLineForm(id) {
  const name = document.getElementById('tlLineName').value.trim();
  if (!name) { showCustomConfirm('章节名称不能为空'); return; }
  const desc = document.getElementById('tlLineDesc').value.trim();
  if (id) {
    tlUpdateLine(id, { name, desc });
  } else {
    const type = document.getElementById('tlLineType').value;
    const line = tlAddLine({ name, type, desc });
    if (line) tlActiveLineId = line.id; // 新建章节后自动切换显示
  }
  closeEditModal();
  renderTaskLine();
}

let tlQuestFormPos = null; // 临时：右键添加任务时的画布位置（绝对坐标，已减 TL_PAD）
function tlOpenQuestForm(lineId, canvasPos) {
  const store = loadTaskLineStore();
  const line = store.lines.find(l => l.id === lineId);
  if (!line) return;
  // 从「相对 inner 左上角」的点击位置换算为任务画布绝对坐标（pos 需减去 TL_PAD 内边距）
  tlQuestFormPos = canvasPos
    ? { x: Math.round(canvasPos.x - TL_PAD), y: Math.round(canvasPos.y - TL_PAD) }
    : null;
  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="swords" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 添加任务';
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;min-width:340px;">
      <label class="settings-label" style="margin:0;">所属章节</label>
      <div style="font-size:13px;color:var(--text-secondary);">${escapeHtml(line.name)}</div>
      <label class="settings-label" style="margin:0;">任务类型</label>
      <select id="tlQuestKind" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);">
        <option value="main">主线关键任务（金色框，章节里程碑）</option>
        <option value="side" selected>支线任务（普通框）</option>
      </select>
      <label class="settings-label" style="margin:0;">任务标题 *</label>
      <input type="text" id="tlQuestTitle" placeholder="要达成的一个可衡量的成长里程碑" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);">
      <label class="settings-label" style="margin:0;">任务描述（一段文字，说明目标、意义与产出）</label>
      <textarea id="tlQuestDesc" rows="5" placeholder="为什么做这件事？完成后会变成什么样？——写成一段完整的话，不要只写一句话" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);resize:vertical;line-height:1.6;"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
        <button class="notes-undo-btn" onclick="closeEditModal()">取消</button>
        <button class="btn-add" onclick="tlSubmitQuestForm(${lineId})"><i data-lucide="check" class="lucide-icon" style="width:14px;height:14px;"></i>保存（草稿）</button>
      </div>
    </div>`;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('tlQuestTitle').focus(), 100);
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlSubmitQuestForm(lineId) {
  const title = document.getElementById('tlQuestTitle').value.trim();
  if (!title) { showCustomConfirm('任务标题不能为空'); return; }
  const kind = document.getElementById('tlQuestKind').value;
  tlAddQuest({
    lineId,
    title,
    kind,
    desc: document.getElementById('tlQuestDesc').value.trim(),
    pos: tlQuestFormPos
  });
  tlQuestFormPos = null;
  closeEditModal();
  renderTaskLine();
}

// ─────────────────────── 任务详情浮层 ───────────────────────
function tlOpenQuestDetail(id) {
  if (tlSuppressClick) { tlSuppressClick = false; return; } // 拖动后抑制误开详情
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === id);
  if (!q) return;
  const line = store.lines.find(l => l.id === q.lineId);
  const statusMap = { draft: '✏️ 草稿（待确认）', locked: '🔒 锁定（前置未完成）', active: '▶️ 进行中', done: '✅ 已完成', skipped: '⏭️ 已跳过' };
  const kindMap = { main: '⭐ 主线关键任务', side: '🔷 支线任务' };
  // 依赖详情（跨章节依赖标注所属章节，点击跳转）
  let depsHtml = '';
  if (q.deps && q.deps.length > 0) {
    depsHtml = `<div class="tl-detail-block"><div class="tl-detail-label">前置任务</div>`;
    for (const did of q.deps) {
      const d = store.quests.find(x => x.id === did);
      const dLine = d ? store.lines.find(l => l.id === d.lineId) : null;
      const crossMark = d && dLine && d.lineId !== q.lineId ? `<span class="tl-deps-line">${escapeHtml(dLine.name)}</span>` : '';
      const doneCls = d && (d.status === 'done' || d.status === 'skipped') ? 'ok' : 'wait';
      depsHtml += `<div class="tl-detail-deps ${doneCls}">${d ? escapeHtml(d.title) : '（已删除）'}${crossMark}${d ? `<button class="notes-undo-btn tl-deps-goto" onclick="tlGotoExternalQuest(${d.id})" title="跳到该章节查看">查看</button>` : ''}</div>`;
    }
    depsHtml += `</div>`;
  }
  // 条件列表
  let condHtml = '';
  if (q.conditions.length > 0) {
    condHtml = `<div class="tl-detail-block"><div class="tl-detail-label">完成条件（${tlQuestCondMetCount(q)}/${q.conditions.length}）</div>`;
    q.conditions.forEach((c, i) => {
      const met = tlIsCondMet(c);
      const typeLabel = { todo: '📋 待办', note: '📝 笔记', timer: '⏱️ 计时', manual: '🖐️ 手动' }[c.type] || '❓';
      // 实时状态与跳转
      let extra = '';
      let gotoBtn = '';
      if (c.type === 'todo') {
        const t = (typeof findTodo === 'function') ? findTodo(c.todoId) : null;
        extra = t ? (t.done ? '<span class="tl-cond-state ok">✓ 已完成</span>' : '<span class="tl-cond-state">○ 未完成</span>') : '<span class="tl-cond-state">（待办已删除）</span>';
        if (t) gotoBtn = `<button class="notes-undo-btn tl-cond-goto" onclick="tlGotoTodo(${c.todoId})" title="跳到待办页定位该待办">去待办</button>`;
      } else if (c.type === 'note') {
        const n = (typeof notes !== 'undefined') ? notes.find(x => x.id === c.noteId && x.type === 'note') : null;
        extra = n ? ((n.content || '').trim() ? '<span class="tl-cond-state ok">✓ 已写</span>' : '<span class="tl-cond-state">○ 空白</span>') : '<span class="tl-cond-state">（笔记已删除）</span>';
        if (n) gotoBtn = `<button class="notes-undo-btn tl-cond-goto" onclick="tlGotoNote(${c.noteId})" title="跳到笔记页定位该笔记">打开笔记</button>`;
      } else if (c.type === 'timer') {
        const pr = tlTimerProgress(c);
        const curMin = Math.floor(pr.curMs / 60000);
        const needMin = Math.floor(pr.needMs / 60000);
        extra = `<span class="tl-cond-state ${met ? 'ok' : ''}">⏱ ${curMin}/${needMin} 分钟</span>`;
      }
      condHtml += `<div class="tl-detail-cond ${met ? 'ok' : ''}">
        <span class="tl-cond-status">${met ? '✅' : '⬜'}</span>
        <span class="tl-cond-text">${typeLabel} · ${escapeHtml(c.label || '')}${extra ? '<br>' + extra : ''}</span>
        ${gotoBtn}
        <button class="notes-undo-btn tl-cond-manual" onclick="tlToggleManualCond(${q.id}, ${i})" title="手动打卡/取消">${c.done === true ? '取消打卡' : '手动打卡'}</button>
      </div>`;
    });
    condHtml += `</div>`;
  }
  // 三段式描述
  const descBlock = q.desc ? `<div class="tl-detail-block"><div class="tl-detail-label">📜 任务描述</div><div class="tl-detail-text tl-desc-pre">${escapeHtml(q.desc)}</div></div>` : '';

  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="swords" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 任务详情';
  body.innerHTML = `
    <div class="tl-detail" style="min-width:360px;max-width:440px;">
      <div class="tl-detail-head">
        <div class="tl-detail-title">${escapeHtml(q.title)}</div>
        <div class="tl-detail-status tl-status-${q.status}">${statusMap[q.status] || q.status}</div>
      </div>
      <div class="tl-detail-line">${line ? (line.type === 'main' ? '📖 主线' : '🌱 素质线') + ' · ' + escapeHtml(line.name) : '（章节已删除）'}</div>
      ${descBlock}
      ${depsHtml}
      ${condHtml}
      <div class="tl-detail-actions">
        ${q.status === 'draft' ? `<button class="btn-add" onclick="tlActivateQuest(${q.id})"><i data-lucide="check" class="lucide-icon" style="width:14px;height:14px;"></i>确认任务</button>` : ''}
        ${q.status === 'active' ? `<button class="btn-add" onclick="tlCompleteQuest(${q.id})"><i data-lucide="check-check" class="lucide-icon" style="width:14px;height:14px;"></i>完成任务</button>` : ''}
        ${q.status !== 'done' ? `<button class="notes-undo-btn" onclick="tlSkipQuest(${q.id})"><i data-lucide="skip-forward" class="lucide-icon" style="width:14px;height:14px;"></i>跳过</button>` : ''}
        <button class="notes-undo-btn" onclick="tlEditQuestForm(${q.id})"><i data-lucide="pencil" class="lucide-icon" style="width:14px;height:14px;"></i>编辑</button>
        <button class="notes-undo-btn" onclick="tlDeleteQuestAsk(${q.id})" style="color:var(--danger);"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i>删除</button>
      </div>
    </div>`;
  document.getElementById('editModal').classList.add('open');
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlEditQuestForm(id) {
  const q = tlGetQuest(id);
  if (!q) return;
  const store = loadTaskLineStore();
  const typeLabel = { todo: '📋 待办', note: '📝 笔记', timer: '⏱️ 计时', manual: '🖐️ 手动' };
  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="pencil" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑任务';
  const depOptions = tlRenderDepOptions(q.id);
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:10px;min-width:360px;">
      <label class="settings-label" style="margin:0;">任务类型</label>
      <select id="tlQuestKind" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);">
        <option value="main" ${q.kind === 'main' ? 'selected' : ''}>主线关键任务（金色框，章节里程碑）</option>
        <option value="side" ${q.kind !== 'main' ? 'selected' : ''}>支线任务（普通框）</option>
      </select>
      <label class="settings-label" style="margin:0;">任务标题 *</label>
      <input type="text" id="tlQuestTitle" value="${escapeHtml(q.title)}" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);">
      <label class="settings-label" style="margin:0;">任务描述（一段文字，说明目标、意义与产出）</label>
      <textarea id="tlQuestDesc" rows="5" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);resize:vertical;line-height:1.6;">${escapeHtml(q.desc || '')}</textarea>
      <div class="tl-ai-gen-row">
        <input type="text" id="tlQuestAiHint" placeholder="可选：告诉 AI 生成方向，如「突出刷材料的步骤」" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);font-size:12px;flex:1;min-width:0;">
        <button class="btn-add tl-edit-cond-btn" id="tlAiGenBtn" onclick="tlAiGenerateDesc(${q.id})" title="把任务标题、章节、前置/下游任务、完成条件发给 AI，按 GTNH 风格生成一段介绍并回填"><i data-lucide="sparkles" class="lucide-icon" style="width:13px;height:13px;"></i>AI 生成介绍</button>
      </div>
      <label class="settings-label" style="margin:0;">前置依赖（完成这些任务后本任务才解锁，可跨章节）</label>
      <div class="tl-edit-conds">
        <div id="tlEditDepList" class="tl-edit-cond-list">
          ${(q.deps && q.deps.length > 0)
            ? q.deps.map((did, i) => {
                const d = store.quests.find(x => x.id === did);
                const dLine = d ? store.lines.find(l => l.id === d.lineId) : null;
                const crossTag = d && dLine && d.lineId !== q.lineId ? `<span class="tl-deps-line">${escapeHtml(dLine.name)}</span>` : '';
                return `<div class="tl-edit-cond-item">
                  <span>${d ? escapeHtml(d.title) : '（已删除）'}${crossTag}</span>
                  <button class="notes-undo-btn tl-edit-cond-del" onclick="tlRemoveDep(${q.id}, ${i})" title="移除依赖"><i data-lucide="x" class="lucide-icon" style="width:12px;height:12px;"></i></button>
                </div>`;
              }).join('')
            : '<div class="tl-badge-empty">暂无前置依赖（立即激活）</div>'}
        </div>
        <div class="tl-edit-cond-add">
          <select id="tlDepSel" style="padding:6px 8px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);font-size:12px;flex:1;min-width:120px;">${depOptions}</select>
          <button class="btn-add tl-edit-cond-btn" onclick="tlAddDep(${q.id})"><i data-lucide="plus" class="lucide-icon" style="width:12px;height:12px;"></i>添加</button>
        </div>
      </div>
      <label class="settings-label" style="margin:0;">完成条件</label>
      <div class="tl-edit-conds">
        <div id="tlEditCondList" class="tl-edit-cond-list">
          ${(q.conditions && q.conditions.length > 0)
            ? q.conditions.map((c, i) => `
              <div class="tl-edit-cond-item">
                <span>${typeLabel[c.type] || '❓'} · ${escapeHtml(c.label || '')}</span>
                <button class="notes-undo-btn tl-edit-cond-del" onclick="tlRemoveCond(${q.id}, ${i})" title="移除条件"><i data-lucide="x" class="lucide-icon" style="width:12px;height:12px;"></i></button>
              </div>`).join('')
            : '<div class="tl-badge-empty">暂无条件（激活后需手动点完成）</div>'}
        </div>
        <div class="tl-edit-cond-add">
          <select id="tlCondType" onchange="tlRenderCondFields(this.value)" style="padding:6px 8px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);font-size:12px;">
            <option value="todo">📋 待办完成</option>
            <option value="note">📝 笔记撰写</option>
            <option value="timer">⏱️ 计时达标</option>
            <option value="manual">🖐️ 手动打卡</option>
          </select>
          <div id="tlCondFields" class="tl-edit-cond-fields"></div>
          <button class="btn-add tl-edit-cond-btn" onclick="tlAddCond(${q.id})"><i data-lucide="plus" class="lucide-icon" style="width:12px;height:12px;"></i>添加</button>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px;">
        <button class="notes-undo-btn" onclick="closeEditModal()">取消</button>
        <button class="btn-add" onclick="tlSubmitEditQuest(${q.id})"><i data-lucide="check" class="lucide-icon" style="width:14px;height:14px;"></i>保存</button>
      </div>
    </div>`;
  document.getElementById('editModal').classList.add('open');
  setTimeout(function () { tlRenderCondFields('todo'); }, 0);
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlSubmitEditQuest(id) {
  const title = document.getElementById('tlQuestTitle').value.trim();
  if (!title) { showCustomConfirm('任务标题不能为空'); return; }
  const kindEl = document.getElementById('tlQuestKind');
  tlUpdateQuest(id, {
    title,
    kind: kindEl ? kindEl.value : undefined,
    desc: document.getElementById('tlQuestDesc').value.trim()
  });
  closeEditModal();
  renderTaskLine();
}

// ─────────────────────── AI 生成任务介绍 ───────────────────────
// 收集任务上下文（任务本体 + 增强上下文 + 前置/下游任务 + 风格约束），
// 发给当前 AI 对话，把回复回填到描述 textarea（不直接保存，用户可再改）。
const TL_AI_STYLE = `像通关过的老玩家坐在旁边教你——第二人称「你」的向导口吻，短句+感叹号，轻松俏皮不端着。结构四段式：①钩子开场（"是时候...了"/"什么...?"/"你可能已经注意到..."）；②怎么做（具体路径，结合完成条件给出，不抄清单）；③意义/价值（"你将会..."，为什么重要，结合下游任务）；④收尾激励（"作为奖励..."/"祝你好运"）。禁止说明书腔（第一步/第二步）、学术腔（综上所述）、空洞口号（努力吧）和网络烂梗。内容可以硬核，语气永远轻松。`;
// 构造发给 AI 的指令 prompt
function tlBuildQuestDescPrompt(questId) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return '';
  const line = store.lines.find(l => l.id === q.lineId);
  const statusMap = { draft: '草稿', locked: '锁定', active: '进行中', done: '已完成', skipped: '已跳过' };
  const kindMap = { main: '主线关键任务', side: '支线任务' };
  const typeLabel = { todo: '完成待办', note: '撰写笔记', timer: '计时达标', manual: '手动打卡' };
  // A组·任务本体：前置任务（标题+状态）
  const deps = (q.deps || []).map(did => {
    const d = store.quests.find(x => x.id === did);
    return d ? `「${d.title}」（${kindMap[d.kind] || d.kind}·${statusMap[d.status] || d.status}）` : '（已删除）';
  });
  // B组·增强上下文：下游任务（依赖本任务的任务）
  const dependents = store.quests.filter(x => (x.deps || []).includes(q.id));
  const dependentStr = dependents.length
    ? dependents.map(d => `「${d.title}」（${kindMap[d.kind] || d.kind}·${statusMap[d.status] || d.status}）`).join('、')
    : '无';
  // A组·完成条件（补关联待办/笔记实际标题）
  const conds = (q.conditions || []).map(c => {
    let extra = '';
    if (c.type === 'todo') {
      const t = (typeof findTodo === 'function') ? findTodo(c.todoId) : null;
      if (t) extra = `（关联待办：${t.title}）`;
    } else if (c.type === 'note') {
      const n = (typeof notes !== 'undefined') ? notes.find(x => x.id === c.noteId && x.type === 'note') : null;
      if (n) extra = `（关联笔记：${n.title}）`;
    } else if (c.type === 'timer') {
      extra = `（需计时 ${c.minutes || 0} 分钟）`;
    }
    return `${typeLabel[c.type] || c.type}「${c.label || ''}」${extra}`;
  });
  // B组·章节内其他任务标题（避免描述重复）
  const sameLineQuests = store.quests.filter(x => x.lineId === q.lineId && x.id !== q.id).map(x => x.title);
  // B组·已有描述（可参考/改写）
  const existingDesc = q.desc ? `\n【已有描述（供参考或改写，不必保留）】\n${q.desc}\n` : '';
  // B组·用户补充方向
  const hintEl = document.getElementById('tlQuestAiHint');
  const hint = hintEl ? hintEl.value.trim() : '';
  const hintStr = hint ? `\n【用户补充要求】${hint}\n` : '';
  const lineInfo = line
    ? `${line.name}（${line.type === 'main' ? '主线' : '素质线'}${line.desc ? '：' + line.desc : ''}）`
    : '未知章节';
  return `请为任务线中的一个任务写一段介绍文字（即任务描述 desc）。只输出最终描述本身，不要任何解释、前缀或 markdown 代码块。

【任务标题】${q.title}
【任务类型】${kindMap[q.kind] || q.kind}
【所属章节】${lineInfo}
【当前状态】${statusMap[q.status] || q.status}
【前置任务（本任务解锁前需完成的）】${deps.length ? deps.join('；') : '无'}
【下游任务（本任务完成后将解锁/推动的）】${dependentStr}
【完成条件】${conds.length ? conds.join('；') : '无（手动完成）'}
【章节内其他任务】${sameLineQuests.length ? sameLineQuests.join('、') : '无'}${existingDesc}${hintStr}
【风格要求】${TL_AI_STYLE}

请写一段 80~200 字的介绍文字（第二人称，围绕完成条件给出具体路径、结合下游任务说明价值，四段式）。不要调用任何工具，直接输出文本。`;
}
// 点击「AI 生成介绍」：构造指令 → 独立调用 AI API（不进入任何对话）→ 回填描述框
async function tlAiGenerateDesc(questId) {
  const apiCfg = getEffectiveApiConfig();
  if (!apiCfg.apiKey) { openSettingsModal(); return; }
  const btn = document.getElementById('tlAiGenBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="lucide-icon" style="width:13px;height:13px;"></i>生成中…';
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
  try {
    const prompt = tlBuildQuestDescPrompt(questId);
    if (!prompt) { showCustomConfirm('任务数据缺失，无法生成'); return; }
    // 独立构造消息数组：系统提示（含任务线全局上下文）+ 生成指令。
    // conv 传 null → 不写入任何对话历史、不记 rawLogs，消息不进入当前 AI 对话。
    const systemPrompt = (typeof buildToolsSystemPrompt === 'function')
      ? buildToolsSystemPrompt()
      : '你是「我的学习桌面」的内置 AI 助手。';
    const apiMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ];
    const { cleanText } = await callAiApi(apiMessages, apiCfg, null);
    if (cleanText) {
      // 去除可能的 markdown 代码块包裹和 <memory> 标签，取纯文本回填
      let text = cleanText
        .replace(/<memory>[\s\S]*?<\/memory>/g, '')
        .replace(/^```[\s\S]*?\n/, '')
        .replace(/\n```$/, '')
        .trim();
      const descEl = document.getElementById('tlQuestDesc');
      if (descEl) {
        descEl.value = text;
        descEl.focus();
      }
    } else {
      showCustomConfirm('AI 没有返回内容，请重试或检查 API 配置');
    }
  } catch (err) {
    console.error('[tlAiGenerateDesc] 生成失败:', err);
    showCustomConfirm('AI 生成失败：' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="sparkles" class="lucide-icon" style="width:13px;height:13px;"></i>AI 生成介绍';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

// ── 编辑表单：前置依赖管理（可跨章节） ──
// 生成依赖选择器选项：按章节分组列出所有任务（排除自身与已在 deps 中的）
function tlRenderDepOptions(questId) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return '';
  const currentDeps = new Set(q.deps || []);
  const lines = store.lines.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
  let opts = '';
  for (const line of lines) {
    const qs = store.quests.filter(x => x.lineId === line.id && x.id !== questId && !currentDeps.has(x.id));
    if (qs.length === 0) continue;
    opts += `<optgroup label="${escapeHtml(line.name)}">`;
    opts += qs.map(x => `<option value="${x.id}">${escapeHtml(x.title.slice(0, 36))}</option>`).join('');
    opts += `</optgroup>`;
  }
  if (!opts) opts = '<option value="">（没有可添加的任务）</option>';
  return opts;
}
// 添加依赖（即时保存，局部刷新）
function tlAddDep(questId) {
  const sel = document.getElementById('tlDepSel');
  if (!sel) return;
  const depId = Number(sel.value);
  if (!depId) { showCustomConfirm('请选择要添加的前置任务'); return; }
  if (depId === questId) { showCustomConfirm('不能依赖自己'); return; }
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return;
  q.deps = q.deps || [];
  if (q.deps.includes(depId)) { showCustomConfirm('该任务已在依赖列表中'); return; }
  q.deps.push(depId);
  saveTaskLineStore(store);
  // 依赖改变后刷新解锁状态
  if (typeof tlRefreshQuestStatus === 'function') tlRefreshQuestStatus(questId);
  tlRenderEditDepList(questId);
}
// 移除依赖（即时保存，局部刷新）
function tlRemoveDep(questId, index) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return;
  q.deps.splice(index, 1);
  saveTaskLineStore(store);
  if (typeof tlRefreshQuestStatus === 'function') tlRefreshQuestStatus(questId);
  tlRenderEditDepList(questId);
}
// 局部刷新依赖列表 + 选择器（不重开表单，避免丢失未保存的标题/描述）
function tlRenderEditDepList(questId) {
  const listEl = document.getElementById('tlEditDepList');
  const selEl = document.getElementById('tlDepSel');
  if (!listEl && !selEl) return;
  const q = tlGetQuest(questId);
  if (!q) return;
  const store = loadTaskLineStore();
  if (listEl) {
    listEl.innerHTML = (q.deps && q.deps.length > 0)
      ? q.deps.map((did, i) => {
          const d = store.quests.find(x => x.id === did);
          const dLine = d ? store.lines.find(l => l.id === d.lineId) : null;
          const crossTag = d && dLine && d.lineId !== q.lineId ? `<span class="tl-deps-line">${escapeHtml(dLine.name)}</span>` : '';
          return `<div class="tl-edit-cond-item">
            <span>${d ? escapeHtml(d.title) : '（已删除）'}${crossTag}</span>
            <button class="notes-undo-btn tl-edit-cond-del" onclick="tlRemoveDep(${questId}, ${i})" title="移除依赖"><i data-lucide="x" class="lucide-icon" style="width:12px;height:12px;"></i></button>
          </div>`;
        }).join('')
      : '<div class="tl-badge-empty">暂无前置依赖（立即激活）</div>';
  }
  if (selEl) {
    selEl.innerHTML = tlRenderDepOptions(questId);
  }
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ── 编辑表单：完成条件管理 ──
// 切换条件类型 → 渲染对应字段区
function tlRenderCondFields(type) {
  const wrap = document.getElementById('tlCondFields');
  if (!wrap) return;
  const tlist = (typeof todos !== 'undefined') ? todos.slice(0, 100) : [];
  const nlist = (typeof notes !== 'undefined') ? notes.filter(n => n.type === 'note').slice(0, 100) : [];
  const selStyle = 'padding:6px 8px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);font-size:12px;flex:1;min-width:120px;';
  const inpStyle = 'padding:6px 8px;border-radius:8px;border:1px solid var(--border, #ddd);background:var(--input-bg, transparent);color:var(--text);font-size:12px;';
  if (type === 'todo') {
    wrap.innerHTML = tlist.length > 0
      ? `<select id="tlCondTodoSel" style="${selStyle}">${tlist.map(t => `<option value="${t.id}">${escapeHtml((t.text || '').slice(0, 30))}</option>`).join('')}</select>`
      : '<span style="font-size:12px;color:var(--text-secondary);">暂无待办</span>';
  } else if (type === 'note') {
    wrap.innerHTML = nlist.length > 0
      ? `<select id="tlCondNoteSel" style="${selStyle}">${nlist.map(n => `<option value="${n.id}">${escapeHtml((n.title || '未命名').slice(0, 30))}</option>`).join('')}</select>`
      : '<span style="font-size:12px;color:var(--text-secondary);">暂无笔记</span>';
  } else if (type === 'timer') {
    wrap.innerHTML = (tlist.length > 0
      ? `<select id="tlCondTimerTarget" style="${selStyle}">${tlist.map(t => `<option value="${t.id}">${escapeHtml((t.text || '').slice(0, 24))}</option>`).join('')}</select>`
      : '<span style="font-size:12px;color:var(--text-secondary);">暂无目标</span>')
      + `<input type="number" id="tlCondTimerMin" min="1" value="30" style="${inpStyle};width:70px;"> 分钟`;
  } else {
    wrap.innerHTML = `<input type="text" id="tlCondManualLabel" placeholder="如：和导师聊一次" style="${inpStyle};flex:1;min-width:120px;">`;
  }
}
// 添加条件（即时保存，局部刷新）
function tlAddCond(questId) {
  const typeEl = document.getElementById('tlCondType');
  if (!typeEl) return;
  const type = typeEl.value;
  let cond = null;
  if (type === 'todo') {
    const sel = document.getElementById('tlCondTodoSel');
    const id = sel ? Number(sel.value) : 0;
    if (!id) { showCustomConfirm('请选择待办'); return; }
    cond = tlMakeTodoCond(id);
  } else if (type === 'note') {
    const sel = document.getElementById('tlCondNoteSel');
    const id = sel ? Number(sel.value) : 0;
    if (!id) { showCustomConfirm('请选择笔记'); return; }
    cond = tlMakeNoteCond(id);
  } else if (type === 'timer') {
    const sel = document.getElementById('tlCondTimerTarget');
    const minEl = document.getElementById('tlCondTimerMin');
    const id = sel ? Number(sel.value) : 0;
    const min = minEl ? Math.floor(Number(minEl.value)) : 0;
    if (!id || !min) { showCustomConfirm('请选择计时目标并填写分钟数'); return; }
    cond = tlMakeTimerCond(id, min);
  } else {
    const lblEl = document.getElementById('tlCondManualLabel');
    const lbl = lblEl ? lblEl.value.trim() : '';
    if (!lbl) { showCustomConfirm('请填写条件描述'); return; }
    cond = { type: 'manual', label: lbl, done: false };
  }
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return;
  q.conditions = q.conditions || [];
  q.conditions.push(cond);
  saveTaskLineStore(store);
  tlRenderEditCondList(questId);
  tlRenderCondFields(type);
}
// 移除条件（即时保存，局部刷新）
function tlRemoveCond(questId, index) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return;
  q.conditions.splice(index, 1);
  saveTaskLineStore(store);
  tlRenderEditCondList(questId);
}
// 局部刷新条件列表（不重开表单，避免丢失未保存的标题/描述）
function tlRenderEditCondList(questId) {
  const el = document.getElementById('tlEditCondList');
  if (!el) return;
  const q = tlGetQuest(questId);
  if (!q) return;
  const typeLabel = { todo: '📋 待办', note: '📝 笔记', timer: '⏱️ 计时', manual: '🖐️ 手动' };
  el.innerHTML = (q.conditions && q.conditions.length > 0)
    ? q.conditions.map((c, i) => `
        <div class="tl-edit-cond-item">
          <span>${typeLabel[c.type] || '❓'} · ${escapeHtml(c.label || '')}</span>
          <button class="notes-undo-btn tl-edit-cond-del" onclick="tlRemoveCond(${questId}, ${i})" title="移除条件"><i data-lucide="x" class="lucide-icon" style="width:12px;height:12px;"></i></button>
        </div>`).join('')
    : '<div class="tl-badge-empty">暂无条件（激活后需手动点完成）</div>';
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// ─────────────────────── 条件跳转（去待办 / 打开笔记） ───────────────────────
function tlGotoTodo(todoId) {
  closeEditModal();
  if (typeof switchTab === 'function') switchTab('todo');
  // 展开祖先链（只展开尚未展开的父节点）
  const chain = [];
  let cur = (typeof findTodo === 'function') ? findTodo(todoId) : null;
  let guard = 0;
  while (cur && cur.parentId != null && guard++ < 50) {
    const p = (typeof findTodo === 'function') ? findTodo(cur.parentId) : null;
    if (!p) break;
    chain.unshift(p.id);
    cur = p;
  }
  for (const pid of chain) {
    if (typeof expandedTodoIds !== 'undefined' && !expandedTodoIds.has(pid) && typeof toggleExpand === 'function') {
      try { toggleExpand(pid); } catch (e) { /* ignore */ }
    }
  }
  setTimeout(() => {
    const li = document.querySelector('li[data-id="' + todoId + '"]');
    if (li) {
      li.scrollIntoView({ behavior: 'smooth', block: 'center' });
      li.classList.add('tl-flash');
      setTimeout(() => li.classList.remove('tl-flash'), 1800);
    }
  }, 150);
}
function tlGotoNote(noteId) {
  closeEditModal();
  if (typeof switchTab === 'function') switchTab('notes');
  setTimeout(() => {
    const li = document.querySelector('li[data-item-id="' + noteId + '"]');
    if (li) {
      li.scrollIntoView({ behavior: 'smooth', block: 'center' });
      li.classList.add('tl-flash');
      setTimeout(() => li.classList.remove('tl-flash'), 1800);
    }
  }, 150);
}
// 跨章节占位节点跳转：切换到所属章节并高亮目标任务
function tlGotoExternalQuest(questId) {
  const store = loadTaskLineStore();
  const q = store.quests.find(x => x.id === questId);
  if (!q) return;
  tlActiveLineId = q.lineId;
  renderTaskLine();
  setTimeout(() => {
    const el = document.querySelector('.tl-node[data-qid="' + questId + '"]');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('tl-flash');
      setTimeout(() => el.classList.remove('tl-flash'), 1800);
    }
  }, 150);
}

// ─────────────────────── 删除确认 & 设置 ───────────────────────
function tlDeleteLineAsk(id) {
  const store = loadTaskLineStore();
  const line = store.lines.find(l => l.id === id);
  if (!line) return;
  showCustomConfirm(`确定删除章节「${line.name}」吗？该章节下的所有任务也会一并删除。`).then(ok => {
    if (!ok) return;
    tlDeleteLine(id);
    renderTaskLine();
  });
}
function tlDeleteQuestAsk(id) {
  const q = tlGetQuest(id);
  if (!q) return;
  showCustomConfirm(`确定删除任务「${q.title}」吗？`).then(ok => {
    if (!ok) return;
    tlDeleteQuest(id);
    closeEditModal();
    renderTaskLine();
  });
}
function tlToggleAutoComplete(on) {
  const store = loadTaskLineStore();
  store.toggle.autoComplete = !!on;
  saveTaskLineStore(store);
  renderTaskLine();
}
function tlSubmitReward() {
  const name = document.getElementById('tlRewardName').value.trim();
  const cost = parseInt(document.getElementById('tlRewardCost').value, 10) || 0;
  if (!name) { showCustomConfirm('请输入奖励名称'); return; }
  tlAddReward({ name, cost });
  renderTaskLine();
}

// 兼容老命名：供 AI 工具调用
function tasklineCheckAllConditions() { tlRefreshAll(); }
