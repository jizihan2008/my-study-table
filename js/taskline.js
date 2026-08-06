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
  try { localStorage.setItem(TASkLINE_KEY, JSON.stringify(store)); } catch (e) { console.error('[任务线] 保存失败:', e); }
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
  // 手动画布位置（画布绝对坐标 {x,y}，仅在该章节存在手动布局时生效）
  if (pos && typeof pos === 'object' && typeof pos.x === 'number' && isFinite(pos.x) && typeof pos.y === 'number' && isFinite(pos.y)) {
    quest.pos = { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) };
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
      q.pos = { x: Math.max(0, Math.round(patch.pos.x)), y: Math.max(0, Math.round(patch.pos.y)) };
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
· deps 必须无环（草稿阶段可自行规划整张图），跨章节引用前先用 quest_get(lineId=章节ID) 确认任务存在。`;
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
let tlDragMode = false; // 拖拽模式：开启后可在画布上手动拖动节点
const TL_NODE_H = 52;
const TL_GAP_X = 56;
const TL_GAP_Y = 20;
const TL_PAD = 30;

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
// 返回 { width, height, nodes: { id, x, y, w }, edges: [{x1,y1,x2,y2,ext}], manual }
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
      edges.push({
        x1: depPos.x + depPos.w,
        y1: depPos.y + TL_NODE_H / 2,
        x2: srcPos.x,
        y2: srcPos.y + TL_NODE_H / 2,
        ext: !!(dep && dep._ext) // 指向外部占位节点的边用虚线
      });
    }
  }
  return { width: maxX + TL_PAD, height: maxY + TL_PAD, nodes, edges, manual: false };
}

// 手动布局：有 pos 的任务按坐标放置，无 pos 的任务排到默认区，外部占位节点放最左侧，箭头仍按 deps 自动连接
function tlLayoutGraphManual(quests, extList, all) {
  const nodeW = {};
  for (const q of all) {
    const len = (q.title || '').length;
    nodeW[q.id] = Math.min(230, Math.max(110, len * 14 + 56));
  }
  const nodes = {};
  let maxX = TL_PAD, maxY = TL_PAD;
  // 1) 有 pos 的任务：按坐标放置
  for (const q of quests) {
    if (!q.pos || typeof q.pos.x !== 'number' || typeof q.pos.y !== 'number') continue;
    const x = TL_PAD + q.pos.x;
    const y = TL_PAD + q.pos.y;
    nodes[q.id] = { x, y, w: nodeW[q.id], h: TL_NODE_H, manual: true };
    maxX = Math.max(maxX, x + nodeW[q.id]);
    maxY = Math.max(maxY, y + TL_NODE_H);
  }
  // 2) 外部占位节点：放最左侧一列
  let extY = TL_PAD;
  for (const ext of extList) {
    const x = TL_PAD;
    nodes[ext.id] = { x, y: extY, w: nodeW[ext.id], h: TL_NODE_H, manual: true };
    maxX = Math.max(maxX, x + nodeW[ext.id]);
    maxY = Math.max(maxY, extY + TL_NODE_H);
    extY += TL_NODE_H + TL_GAP_Y;
  }
  // 3) 无 pos 的任务：排到默认区（右下依次排列）
  const noPos = quests.filter(q => !q.pos || typeof q.pos.x !== 'number');
  let autoX = TL_PAD, autoY = maxY + TL_GAP_Y;
  for (const q of noPos) {
    nodes[q.id] = { x: autoX, y: autoY, w: nodeW[q.id], h: TL_NODE_H, manual: true };
    maxX = Math.max(maxX, autoX + nodeW[q.id]);
    maxY = Math.max(maxY, autoY + TL_NODE_H);
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
      edges.push({
        x1: depPos.x + depPos.w,
        y1: depPos.y + TL_NODE_H / 2,
        x2: srcPos.x,
        y2: srcPos.y + TL_NODE_H / 2,
        ext: !!(dep && dep._ext) // 指向外部占位节点的边用虚线
      });
    }
  }
  return { width: maxX + TL_PAD, height: maxY + TL_PAD, nodes, edges, manual: true };
}

// ─────────────────────── UI 渲染（GTNH 任务图 + 章节目录浮窗） ───────────────────────
function renderTaskLine() {
  const app = document.getElementById('tasklineApp');
  if (!app) return;
  if (typeof tlRefreshAll === 'function') tlRefreshAll();
  tlDrainFeedbackAndNotify();
  const store = loadTaskLineStore();
  if (store.lines.length === 0) {
    tlActiveLineId = null;
  } else if (!store.lines.some(l => l.id === tlActiveLineId)) {
    tlActiveLineId = store.lines[0].id;
  }
  const line = store.lines.find(l => l.id === tlActiveLineId) || null;
  const balance = tlRewardBalance(store);
  let html = '';
  // ── 顶部工具条 ──
  html += `<div class="tl-toolbar">
    <button class="tl-tool-btn tl-tool-chapter" onclick="tlOpenChapterPanel('chapters')">
      <i data-lucide="map" class="lucide-icon" style="width:15px;height:15px;"></i>
      <span class="tl-tool-chapter-name">${line ? escapeHtml(line.name) : '选择章节'}</span>
      <i data-lucide="chevron-down" class="lucide-icon" style="width:13px;height:13px;"></i>
    </button>
    <div class="tl-toolbar-stats">
      <button class="tl-tool-btn" onclick="tlOpenChapterPanel('badges')" title="徽章收藏"><i data-lucide="award" class="lucide-icon" style="width:15px;height:15px;"></i><span>${store.badges.length}</span></button>
      <button class="tl-tool-btn" onclick="tlOpenChapterPanel('rewards')" title="奖励兑换（可兑换 ${balance} 个任务额度）"><i data-lucide="gift" class="lucide-icon" style="width:15px;height:15px;"></i><span>${balance}</span></button>
    </div>
    <div class="tl-toolbar-actions">
      <label class="tl-auto-toggle" title="条件满足时自动完成任务">
        <input type="checkbox" class="tl-checkbox" ${store.toggle.autoComplete !== false ? 'checked' : ''} onchange="tlToggleAutoComplete(this.checked)">
        <span>自动完成</span>
      </label>
      ${line ? `<button class="btn-add tl-tool-add" onclick="tlOpenQuestForm(${line.id})"><i data-lucide="plus" class="lucide-icon" style="width:14px;height:14px;"></i>任务</button>` : ''}
    </div>
  </div>`;
  // ── 主区域：任务图 ──
  if (!line) {
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
  html += `<div class="tl-footer-hint">💡 任务线由 AI 设计任务的样子：<b>金色框 = 主线关键任务</b>，<b>蓝色框 = 支线任务</b>，箭头 = 依赖关系。在 AI 对话中直接说「给英语素质线加任务」「查看任务线」即可。</div>`;
  app.innerHTML = html;
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
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
      ${tlDragMode ? `onmousedown="return tlNodeDragStart(event, ${q.id})"` : `onclick="tlOpenQuestDetail(${q.id})"`}
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
    const mx = (e.x1 + e.x2) / 2;
    const cls = e.ext ? 'tl-edge tl-edge-ext' : 'tl-edge';
    edgesHtml += `<path class="${cls}" d="M ${e.x1} ${e.y1} C ${mx} ${e.y1}, ${mx} ${e.y2}, ${e.x2} ${e.y2}" marker-end="url(#tlArrow)"/>`;
  }
  const lockedBanner = isLocked ? `<div class="tl-locked-banner"><i data-lucide="lock" class="lucide-icon" style="width:14px;height:14px;"></i> 前置章节未完成，本章节任务已锁定</div>` : '';
  return `<div class="tl-graph-wrap">
    ${lockedBanner}
    <div class="tl-graph-head">
      <div class="tl-graph-title">
        <span class="tl-line-type-badge ${line.type === 'main' ? 'tl-type-main' : 'tl-type-quality'}">${line.type === 'main' ? '主线章节' : '素质线'}</span>
        <span class="tl-graph-name">${escapeHtml(line.name)}</span>
      </div>
      <div class="tl-graph-progress">
        <div class="tl-graph-progress-track"><div class="tl-graph-progress-fill" style="width:${p.percent}%;"></div></div>
        <span class="tl-graph-pct">${p.percent}%</span>
      </div>
      <div class="tl-graph-actions">
        <button class="notes-undo-btn ${tlDragMode ? 'active' : ''}" onclick="tlToggleDragMode()" title="开启后可直接拖动节点调整位置（写入画布坐标）"><i data-lucide="${tlDragMode ? 'hand' : 'move'}" class="lucide-icon" style="width:13px;height:13px;"></i>${tlDragMode ? '拖拽中' : '拖拽'}</button>
        <button class="notes-undo-btn" onclick="tlOpenLineEditForm(${line.id})" title="编辑章节"><i data-lucide="pencil" class="lucide-icon" style="width:13px;height:13px;"></i></button>
        <button class="notes-undo-btn" onclick="tlDeleteLineAsk(${line.id})" title="删除章节"><i data-lucide="trash-2" class="lucide-icon" style="width:13px;height:13px;"></i></button>
      </div>
    </div>
    ${line.desc ? `<div class="tl-graph-desc">${escapeHtml(line.desc)}</div>` : ''}
    <div class="tl-graph-canvas">
      <div class="tl-graph-inner" style="width:${layout.width}px;height:${layout.height}px;">
        <svg class="tl-graph-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">
          <defs><marker id="tlArrow" markerWidth="9" markerHeight="9" refX="7" refY="3.5" orient="auto"><path d="M0,0 L8,3.5 L0,7 Z" fill="var(--primary)"/></marker></defs>
          ${edgesHtml}
        </svg>
        <div class="tl-graph-nodes">${nodesHtml}</div>
      </div>
    </div>
    <div class="tl-graph-legend">
      <span class="tl-legend-item"><span class="tl-legend-swatch tl-legend-main"></span>主线关键任务</span>
      <span class="tl-legend-item"><span class="tl-legend-swatch tl-legend-side"></span>支线任务</span>
      <span class="tl-legend-item"><i data-lucide="lock" class="lucide-icon" style="width:11px;height:11px;"></i>未解锁</span>
      <span class="tl-legend-item"><i data-lucide="check" class="lucide-icon" style="width:11px;height:11px;"></i>已完成</span>
      ${extQuests.length > 0 ? `<span class="tl-legend-item"><span class="tl-legend-swatch tl-legend-ext"></span>跨章节依赖（虚线，点击跳转）</span>` : ''}
    </div>
  </div>`;
}

// ── 拖拽模式：切换 / 节点拖动 ──
function tlToggleDragMode() {
  tlDragMode = !tlDragMode;
  renderTaskLine();
}
// 拖拽开始（仅拖拽模式下由节点 onmousedown 触发）
function tlNodeDragStart(ev, questId) {
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
    el.style.left = (origLeft + dx) + 'px';
    el.style.top = (origTop + dy) + 'px';
    el.style.zIndex = 50;
    dragging = true;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!dragging) { tlOpenQuestDetail(questId); return; } // 未拖动 = 点击，打开详情
    // 写入画布坐标（减去 TL_PAD，与手动布局坐标一致）
    const q = tlGetQuest(questId);
    if (q) {
      const newX = Math.max(0, Math.round(origLeft + moved.x - TL_PAD));
      const newY = Math.max(0, Math.round(origTop + moved.y - TL_PAD));
      tlUpdateQuest(questId, { pos: { x: newX, y: newY } });
    }
    renderTaskLine(); // 重绘，重新计算连线
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  return false; // 阻止默认拖拽/选中
}

// 章节目录浮窗（章节 / 徽章 / 奖励兑换 三个 tab）
function tlOpenChapterPanel(tab) {
  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="map" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 章节目录';
  const store = loadTaskLineStore();
  const mains = store.lines.filter(l => l.type === 'main').sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const quals = store.lines.filter(l => l.type === 'quality').sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const cur = tab || 'chapters';
  let content = '';
  if (cur === 'chapters') {
    content = `<div class="tl-catalog">
      <div class="tl-catalog-section">
        <div class="tl-catalog-label">主线章节（顺序推进）</div>
        ${mains.length === 0 ? '<div class="tl-catalog-empty">暂无主线章节</div>' : mains.map(l => {
          const p = tlLineProgress(l);
          const curMark = l.id === tlActiveLineId ? '<span class="tl-catalog-cur">当前</span>' : '';
          const lockMark = p.locked ? ' <span class="tl-catalog-lock">🔒</span>' : '';
          return `<div class="tl-catalog-item ${l.id === tlActiveLineId ? 'active' : ''}" onclick="tlSwitchLine(${l.id})">
            <div class="tl-catalog-item-main">
              <span class="tl-catalog-name">${escapeHtml(l.name)}</span>${curMark}${lockMark}
              <span class="tl-catalog-progress">${p.done}/${p.total} · ${p.percent}%</span>
            </div>
          </div>`;
        }).join('')}
        <button class="tl-catalog-add" onclick="tlOpenLineForm('main')"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i>新建主线章节</button>
      </div>
      <div class="tl-catalog-section">
        <div class="tl-catalog-label">素质线（并行成长）</div>
        ${quals.length === 0 ? '<div class="tl-catalog-empty">暂无素质线</div>' : quals.map(l => {
          const p = tlLineProgress(l);
          const curMark = l.id === tlActiveLineId ? '<span class="tl-catalog-cur">当前</span>' : '';
          return `<div class="tl-catalog-item ${l.id === tlActiveLineId ? 'active' : ''}" onclick="tlSwitchLine(${l.id})">
            <div class="tl-catalog-item-main">
              <span class="tl-catalog-name">${escapeHtml(l.name)}</span>${curMark}
              <span class="tl-catalog-progress">${p.done}/${p.total} · ${p.percent}%</span>
            </div>
          </div>`;
        }).join('')}
        <button class="tl-catalog-add" onclick="tlOpenLineForm('quality')"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i>新建素质线</button>
      </div>
    </div>`;
  } else if (cur === 'badges') {
    content = `<div class="tl-catalog">
      <div class="tl-catalog-label">徽章收藏</div>
      <div class="tl-badge-list">
        ${store.badges.length === 0 ? '<div class="tl-badge-empty">完成第一个任务即可获得首枚徽章</div>' : store.badges.slice().reverse().map(b => `
          <div class="tl-badge" title="${escapeHtml(b.desc)}">
            <div class="tl-badge-icon">${b.icon}</div>
            <div class="tl-badge-name">${escapeHtml(b.name)}</div>
            <div class="tl-badge-date">${(new Date(b.earnedAt)).toLocaleDateString('zh-CN')}</div>
          </div>`).join('')}
      </div>
    </div>`;
  } else if (cur === 'rewards') {
    const doneCount = tlDoneCount(store);
    const balance = tlRewardBalance(store);
    content = `<div class="tl-catalog">
      <div class="tl-catalog-label">自定义奖励池 <span class="tl-pool-hint">完成任务解锁自己的欲望清单</span></div>
      <div class="tl-pool-balance">已完成任务 ${doneCount} 个｜可兑换额度 <b>${balance}</b></div>
      <div class="tl-pool-form">
        <input type="text" id="tlRewardName" placeholder="奖励名称，如：看一集剧 / 一杯奶茶">
        <input type="number" id="tlRewardCost" placeholder="需完成任务数" style="width:110px;" min="1" value="1">
        <button class="btn-add" onclick="tlSubmitReward()"><i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;"></i>添加</button>
      </div>
      <div class="tl-pool-list">
        ${store.rewards.length === 0 ? '<div class="tl-badge-empty">暂无自定义奖励，添加一个让自己有期待的目标吧</div>' : store.rewards.map(r => `
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
  }
  body.innerHTML = `
    <div class="tl-catalog-tabs">
      <button class="tl-catalog-tab ${cur === 'chapters' ? 'active' : ''}" onclick="tlOpenChapterPanel('chapters')"><i data-lucide="map" class="lucide-icon" style="width:13px;height:13px;"></i>章节</button>
      <button class="tl-catalog-tab ${cur === 'badges' ? 'active' : ''}" onclick="tlOpenChapterPanel('badges')"><i data-lucide="award" class="lucide-icon" style="width:13px;height:13px;"></i>徽章${store.badges.length > 0 ? '(' + store.badges.length + ')' : ''}</button>
      <button class="tl-catalog-tab ${cur === 'rewards' ? 'active' : ''}" onclick="tlOpenChapterPanel('rewards')"><i data-lucide="gift" class="lucide-icon" style="width:13px;height:13px;"></i>奖励兑换</button>
    </div>
    <div class="tl-catalog-body">${content}</div>`;
  document.getElementById('editModal').classList.add('open');
  if (typeof lucide !== 'undefined') setTimeout(function () { lucide.createIcons(); }, 0);
}
function tlSwitchLine(id) {
  tlActiveLineId = id;
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

function tlOpenQuestForm(lineId) {
  const store = loadTaskLineStore();
  const line = store.lines.find(l => l.id === lineId);
  if (!line) return;
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
    desc: document.getElementById('tlQuestDesc').value.trim()
  });
  closeEditModal();
  renderTaskLine();
}

// ─────────────────────── 任务详情浮层 ───────────────────────
function tlOpenQuestDetail(id) {
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
  const typeLabel = { todo: '📋 待办', note: '📝 笔记', timer: '⏱️ 计时', manual: '🖐️ 手动' };
  const body = document.getElementById('editModalBody');
  const title = document.getElementById('editModalTitle');
  title.innerHTML = '<i data-lucide="pencil" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑任务';
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
