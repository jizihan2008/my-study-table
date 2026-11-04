// ═══════════ Stats: Data Collection ═══════════
// Uses existing getDateStr() and getPastDateStr() from habits.js and settings.js
let STATS_PERIOD = 7;

function collectDateRange(days, offset = 0) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(getPastDateStr(i + offset));
  return dates;
}

function collectTodoStats(days) {
  const range = collectDateRange(days);
  const todos = JSON.parse(localStorage.getItem('study_todos_v2') || '[]');
  const completed = {}, created = {};
  const seenCompletions = new Set();
  range.forEach(d => { completed[d] = 0; created[d] = 0; });
  for (const todo of [...todos, ...loadTodoCompletedLog()]) {
    const date = String(todo.completedAt || '').slice(0, 10);
    if (!Object.hasOwn(completed, date)) continue;
    const key = todo.id == null ? todo : String(todo.id) + '|' + date;
    if (seenCompletions.has(key)) continue;
    seenCompletions.add(key);
    completed[date]++;
  }
  todos.forEach(t => {
    // createdAt 是毫秒时间戳（数字），需格式化为 YYYY-MM-DD 才能与日期键匹配
    const rawCd = t.createdAt;
    let cd = '';
    if (rawCd) {
      if (typeof rawCd === 'string') cd = rawCd.slice(0, 10);
      else {
        const cdDate = new Date(rawCd);
        cd = `${cdDate.getFullYear()}-${String(cdDate.getMonth() + 1).padStart(2, '0')}-${String(cdDate.getDate()).padStart(2, '0')}`;
      }
    }
    if (cd && created[cd] !== undefined) created[cd]++;
  });
  return { range, completed, created };
}

function loadStatsFocusRecords(types = new Map(loadTimerActivityTypes().map(type => [type.id, type]))) {
  const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
  return records.filter(record => typeof record.affectsFocus === 'boolean'
    ? record.affectsFocus
    : types.get(getTimerActivityType(record))?.affectsFocus);
}

function groupStatsFocusRecords(records) {
  const byDate = new Map();
  for (const record of records) {
    const date = String(record.date || '').slice(0, 10);
    if (!date) continue;
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(record.date === date ? record : { ...record, date });
  }
  return byDate;
}

function collectTimerStats(days, offset = 0) {
  const range = collectDateRange(days, offset);
  const dailyMinutes = {}, dailySessions = {}, dailyTypeMinutes = {}, dailyRecords = {};
  const typeTotals = new Map();
  const types = new Map(loadTimerActivityTypes().map(type => [type.id, type]));
  const recordsByDate = groupStatsFocusRecords(loadStatsFocusRecords(types));
  for (const date of range) {
    const records = recordsByDate.get(date) || [];
    dailyRecords[date] = records;
    dailySessions[date] = records.length;
    dailyMinutes[date] = 0;
    const byType = dailyTypeMinutes[date] = new Map();
    if (!records.length) continue;
    const summary = getTimerRecordsDurationSummary(records, date, { splitTypeOverlaps: true });
    dailyMinutes[date] = summary.totalMs / 60000;
    for (const [type, ms] of Object.entries(summary.typeMs)) {
      if (ms <= 0) continue;
      const minutes = ms / 60000;
      byType.set(type, minutes);
      typeTotals.set(type, (typeTotals.get(type) || 0) + minutes);
      if (!types.has(type)) types.set(type, { id: type, label: type });
    }
  }
  return { range, dailyMinutes, dailySessions, dailyTypeMinutes, dailyRecords, typeTotals, types,
    totalMinutes: range.reduce((sum, date) => sum + dailyMinutes[date], 0) };
}

function collectHabitStats(days) {
  const range = collectDateRange(days);
  const habits = JSON.parse(localStorage.getItem('study_habits_v2') || '[]');
  const dailyRate = {}, dailyEligible = {}, dailyMet = {};
  const seen = new Set(habits.filter(habit => habit.id != null).map(habit => String(habit.id)));
  const inactive = [...loadArchive('habits'), ...loadTrash('habits')].filter(habit => {
    if (habit.id == null) return true;
    const id = String(habit.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const entries = [...habits, ...inactive].map(habit => {
    const start = statsLocalDate(habit.createdAt);
    const end = statsLocalDate(habit.archivedAt || habit.deletedAt);
    const checkins = Array.isArray(habit.checkins) ? habit.checkins.reduce((counts, date) => {
      counts[date] = (counts[date] || 0) + 1;
      return counts;
    }, Object.create(null)) : (habit.checkins || {});
    return { start, end, checkins, target: Math.max(1, Number(habit.dailyTarget) || 1) };
  });
  let eligible = 0, met = 0;
  for (const date of range) {
    const active = entries.filter(habit => date >= habit.start && (!habit.end || date <= habit.end));
    const completed = active.filter(habit => (habit.checkins[date] || 0) >= habit.target).length;
    dailyEligible[date] = active.length;
    dailyMet[date] = completed;
    dailyRate[date] = active.length ? Math.round(completed / active.length * 100) : null;
    eligible += active.length;
    met += completed;
  }
  return { range, dailyRate, dailyEligible, dailyMet, eligible, met, rate: eligible ? Math.round(met / eligible * 100) : null };
}

function statsLocalDate(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? formatDate(date) : '';
}

function collectOverallStats() {
  const todos = JSON.parse(localStorage.getItem('study_todos_v2') || '[]');
  const notes = JSON.parse(localStorage.getItem('study_notes_v2') || '[]');
  const checkin = JSON.parse(localStorage.getItem('study_checkin') || '{"dates":[],"streak":0}');
  const habits = JSON.parse(localStorage.getItem('study_habits_v2') || '[]');
  const focusRecords = loadStatsFocusRecords();
  const byDate = groupStatsFocusRecords(focusRecords);
  const totalMin = [...byDate].reduce((sum, [date, records]) =>
    sum + getTimerRecordsDurationSummary(records, date).totalMs / 60000, 0);
  const activeDays = byDate.size;
  return {
    totalTodos: todos.length, completedTodos: todos.filter(t => t.done).length,
    totalMin, totalSessions: focusRecords.length,
    totalNotes: notes.filter(n => n.type === 'note').length, activeDays,
    streak: checkin.streak || 0, totalHabits: habits.length
  };
}

function setStatsPeriod(days) {
  STATS_PERIOD = days;
  renderStats();
}

function formatStatsTime(minutes) {
  const rounded = Math.round(minutes);
  if (minutes > 0 && rounded === 0) return '<1分钟';
  if (rounded < 60) return rounded + '分钟';
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? h + 'h ' + m + 'm' : h + '小时';
}

const AI_USAGE_FEATURE_LABELS = {
  chat: 'AI 对话', chat_tool_followup: '工具调用续答', call_ai: '子模型调用',
  conversation_title: '对话标题', note_summary: '笔记摘要', note_keywords: '笔记关键词',
  memory_dedup: '记忆去重', memory_conversation_summary: '对话记忆摘要', memory_extract: '记忆提取',
  memory_daily_summary: '每日记忆整合', memory_profile: '用户画像', stats_analysis: '统计分析', other: '其他',
  morning_report: '晨间日报', evening_report: '晚间日报', taskline: '任务线', books: '教材学习',
  inbox_summary: '消息摘要', inbox_daily_report: '消息日报'
};

function emptyAiUsageSummary() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, exactRequests: 0, estimatedRequests: 0 };
}

function mergeAiUsageBucket(target, source) {
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'requests', 'exactRequests', 'estimatedRequests']) {
    target[key] = (Number(target[key]) || 0) + (Number(source?.[key]) || 0);
  }
}

function collectAiUsageStats(days) {
  const range = collectDateRange(days);
  let store = { days: {}, legacyMonths: {} };
  try {
    store = typeof AIClient !== 'undefined' && AIClient.getUsageData
      ? AIClient.getUsageData()
      : JSON.parse(localStorage.getItem('study_ai_usage_v2') || '{}');
  } catch (_) {}
  const total = emptyAiUsageSummary();
  const daily = {};
  const byModel = {};
  const byFeature = {};
  for (const date of range) {
    const row = store.days?.[date] || emptyAiUsageSummary();
    daily[date] = Number(row.totalTokens) || (Number(row.inputTokens) || 0) + (Number(row.outputTokens) || 0);
    mergeAiUsageBucket(total, row);
    for (const [name, bucket] of Object.entries(row.byModel || {})) {
      mergeAiUsageBucket(byModel[name] || (byModel[name] = emptyAiUsageSummary()), bucket);
    }
    for (const [name, bucket] of Object.entries(row.byFeature || {})) {
      mergeAiUsageBucket(byFeature[name] || (byFeature[name] = emptyAiUsageSummary()), bucket);
    }
  }
  let legacyTokens = 0;
  for (const row of Object.values(store.legacyMonths || {})) {
    legacyTokens += (Number(row?.inputTokens) || 0) + (Number(row?.outputTokens) || 0);
  }
  return { range, daily, total, byModel, byFeature, legacyTokens };
}

function formatTokenCount(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 1 : 2).replace(/\.0+$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

function statsTip(text) {
  return escapeHtml(String(text)).replace(/"/g, '&quot;');
}

function bindStatsTooltip(container) {
  if (container.dataset.statsTooltipBound) return;
  container.dataset.statsTooltipBound = 'true';
  let tip = document.getElementById('statsNodeTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'statsNodeTooltip';
    tip.className = 'stats-node-tooltip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  const showTip = (node, x, y) => {
    tip.textContent = node.dataset.statsTip;
    tip.hidden = false;
    tip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - tip.offsetWidth - 8)) + 'px';
    const top = y - tip.offsetHeight >= 20 ? y - tip.offsetHeight - 12 : y + 12;
    tip.style.top = Math.max(8, Math.min(top, window.innerHeight - tip.offsetHeight - 8)) + 'px';
  };
  container.addEventListener('pointermove', event => {
    const node = event.target.closest('[data-stats-tip]');
    if (!node || !container.contains(node)) { tip.hidden = true; return; }
    showTip(node, event.clientX, event.clientY);
  });
  container.addEventListener('pointerleave', () => { tip.hidden = true; });
  container.addEventListener('focusin', event => {
    const node = event.target.closest('[data-stats-date][data-stats-tip]');
    if (!node) return;
    const rect = node.getBoundingClientRect();
    showTip(node, rect.right, rect.top);
  });
  container.addEventListener('focusout', () => { tip.hidden = true; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') tip.hidden = true; });
}

function aiUsageBreakdownHtml(entries, labels) {
  const sorted = Object.entries(entries || {}).sort((a, b) => (b[1].totalTokens || 0) - (a[1].totalTokens || 0)).slice(0, 6);
  if (!sorted.length) return '<div class="stats-ai-empty">暂无数据</div>';
  const max = Math.max(1, ...sorted.map(([, row]) => Number(row.totalTokens) || 0));
  return sorted.map(([name, row]) => {
    const label = labels?.[name] || name;
    const width = Math.max(3, Math.round((Number(row.totalTokens) || 0) / max * 100));
    return '<div class="stats-ai-breakdown-row" data-stats-tip="'+statsTip(label+'：'+Math.round(row.totalTokens||0)+' Token，'+(row.requests||0)+' 次请求')+'"><div class="stats-ai-breakdown-meta"><span>'+escapeHtml(label)+'</span><span>'+formatTokenCount(row.totalTokens)+' · '+(row.requests||0)+'次</span></div><div class="stats-ai-breakdown-track"><span style="width:'+width+'%"></span></div></div>';
  }).join('');
}

function renderAiTokenTrend(cId, stats) {
  const el = document.getElementById(cId); if (!el) return;
  const values = stats.range.map(date => stats.daily[date] || 0);
  const max = Math.max(1, ...values);
  el.innerHTML = '<div class="stats-ai-bars">' + values.map((value, index) => {
    const height = value > 0 ? Math.max(4, Math.round(value / max * 100)) : 2;
    const label = stats.range.length <= 7 || index % (stats.range.length > 14 ? 5 : 2) === 0 ? stats.range[index].slice(5) : '';
    return '<div class="stats-ai-bar-col" data-stats-tip="'+statsTip(stats.range[index]+'：'+Math.round(value)+' Token')+'"><span class="stats-ai-bar" style="height:'+height+'%"></span><small>'+label+'</small></div>';
  }).join('') + '</div>';
}

function refreshAiUsagePanel() {
  const stats = collectAiUsageStats(STATS_PERIOD);
  const values = {
    statsAiTotal: formatTokenCount(stats.total.totalTokens), statsAiInput: formatTokenCount(stats.total.inputTokens),
    statsAiOutput: formatTokenCount(stats.total.outputTokens), statsAiRequests: String(stats.total.requests || 0)
  };
  for (const [id, value] of Object.entries(values)) { const el = document.getElementById(id); if (el) el.textContent = value; }
  const accuracy = document.getElementById('statsAiAccuracy');
  if (accuracy) accuracy.textContent = '精确 '+(stats.total.exactRequests||0)+' 次 · 估算 '+(stats.total.estimatedRequests||0)+' 次'
    + (stats.legacyTokens ? ' · 另有旧版累计 '+formatTokenCount(stats.legacyTokens)+' Token' : '');
  const models = document.getElementById('statsAiModels'); if (models) models.innerHTML = aiUsageBreakdownHtml(stats.byModel);
  const features = document.getElementById('statsAiFeatures'); if (features) features.innerHTML = aiUsageBreakdownHtml(stats.byFeature, AI_USAGE_FEATURE_LABELS);
  renderAiTokenTrend('statsAiTrend', stats);
}

async function clearAiUsageStats() {
  const accepted = typeof showCustomConfirm === 'function'
    ? await showCustomConfirm('确定清空全部 AI Token 统计吗？此操作不会删除对话。', { title: '清空 Token 统计', okText: '清空', danger: true })
    : confirm('确定清空全部 AI Token 统计吗？');
  if (!accepted || typeof AIClient === 'undefined') return;
  AIClient.clearUsage();
  refreshAiUsagePanel();
}

// ═══════════ Stats: SVG Charts ═══════════
function renderTodoLineChart(cId, stats) {
  const el = document.getElementById(cId); if (!el) return;
  const { range, completed } = stats;
  // Use parent card width; fallback to 260px if layout not ready
  const elW = el.parentElement ? el.parentElement.clientWidth : 0;
  const W = Math.max(200, (elW || el.clientWidth || 260) - 30);
  const H = 200;
  const padL = 35, padR = 15, padT = 14, padB = 26, plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = range.map(d => completed[d]);
  const maxY = Math.max(5, ...vals) || 5;
  let grid = '', pts = '';
  for (let g = 0; g <= 4; g++) { const y = padT + plotH * g / 4; grid += '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(padL+plotW)+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-dasharray="3,3"/>'; }
  vals.forEach((v, i) => {
    const x = padL + (i / Math.max(1, vals.length - 1)) * plotW;
    const y = padT + plotH - (v / maxY * plotH);
    pts += x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  });
  let areaD = 'M' + padL + ',' + (padT + plotH);
  vals.forEach((v, i) => {
    const x = padL + (i / Math.max(1, vals.length - 1)) * plotW;
    const y = padT + plotH - (v / maxY * plotH);
    areaD += ' L' + x.toFixed(1) + ',' + y.toFixed(1);
  });
  areaD += ' L' + (padL + plotW) + ',' + (padT + plotH) + ' Z';
  let dots = '', xLabels = '';
  const li = range.length > 14 ? 3 : (range.length > 7 ? 2 : 1);
  vals.forEach((v, i) => {
    const x = padL + (i / Math.max(1, vals.length - 1)) * plotW;
    const y = padT + plotH - (v / maxY * plotH);
    dots += '<g class="stats-chart-node" data-stats-tip="'+statsTip(range[i]+'：完成 '+v+' 个待办')+'"><circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="11" fill="transparent"/><circle class="stats-chart-dot" cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="3.5" fill="var(--primary)" stroke="#fff" stroke-width="1.5"/></g>';
    if (i % li === 0) xLabels += '<text x="'+x.toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" font-size="10" fill="var(--text-secondary)">'+range[i].slice(5)+'</text>';
  });
  el.innerHTML = '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--primary)" stop-opacity="0.25"/><stop offset="100%" stop-color="var(--primary)" stop-opacity="0.02"/></linearGradient></defs>'+grid+'<path d="'+areaD+'" fill="url(#ag)"/><polyline points="'+pts.trim()+'" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'+dots+xLabels+'</svg>';
}

function renderFocusBarChart(cId, stats) {
  const el = document.getElementById(cId); if (!el) return;
  const { range, dailyMinutes, dailySessions, dailyTypeMinutes, types } = stats;
  const palette = ['var(--primary)', '#16805a', '#c26a14', '#a04fac', '#087e9e', '#c74663', '#6869b9', '#73832e'];
  const activeTypes = [...types.values()].map((type, i) => ({
    ...type, color: palette[i] || `hsl(${i * 137.508 % 360} 60% 42%)`
  })).filter(type => stats.typeTotals.has(type.id));
  if (!activeTypes.length) {
    el.innerHTML = '<div class="stats-ai-empty">这段时间暂无专注记录</div>';
    return;
  }
  const elW = el.parentElement ? el.parentElement.clientWidth : 0;
  const W = Math.max(200, (elW || el.clientWidth || 260) - 30);
  const H = 180;
  const padL = 36, padR = 12, padT = 12, padB = 26, plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = range.map(d => dailyMinutes[d]);
  const maxY = Math.max(30, ...vals) || 30;
  const bc = vals.length;
  const gap = plotW / bc;
  const bw = Math.min(26, gap * 0.72);
  let grid = '', bars = '';
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH * g / 4, v = Math.round(maxY * (1 - g / 4));
    grid += '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(padL+plotW)+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-dasharray="3,3"/><text x="'+(padL-6)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" font-size="9" fill="var(--text-secondary)">'+v+'m</text>';
  }
  vals.forEach((v, i) => {
    const date = range[i];
    const x = padL + i * gap + (gap - bw) / 2;
    let y = padT + plotH;
    const lines = [date + ' · 合计 ' + formatTimerTime(Math.round(v * 60000)) + ' · ' + dailySessions[date] + ' 条记录'];
    const segments = activeTypes.map(type => {
      const minutes = dailyTypeMinutes[date].get(type.id);
      if (!minutes) return '';
      const height = minutes / maxY * plotH;
      y -= height;
      lines.push(type.label + ' · ' + formatTimerTime(Math.round(minutes * 60000)));
      return `<rect class="stats-chart-bar" x="${x}" y="${y}" width="${bw}" height="${height}" fill="${type.color}"/>`;
    }).join('');
    const summary = statsTip(lines.join('\n'));
    bars += `<g class="stats-chart-node stats-focus-day" tabindex="0" role="button" aria-label="${summary}，查看记录" data-stats-date="${date}" data-stats-tip="${summary}">
      <rect x="${padL + i * gap}" y="${padT}" width="${gap}" height="${plotH}" fill="transparent"/>
      ${segments}
    </g>`;
  });
  let xLabels = ''; const li = range.length > 14 ? 4 : (range.length > 7 ? 2 : 1);
  range.forEach((d, i) => { if (i % li === 0) { const x = padL + i * gap + gap / 2; xLabels += '<text x="'+x.toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" font-size="10" fill="var(--text-secondary)">'+d.slice(5)+'</text>'; } });
  const legend = activeTypes.map(type =>
    `<li><span aria-hidden="true" style="background:${type.color}"></span>${escapeHtml(type.label)}</li>`
  ).join('');
  el.innerHTML = '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="group" aria-label="每日专注时长按类型堆叠">'+grid+bars+xLabels+'</svg>'
    + '<ul class="stats-focus-legend" aria-label="专注类型图例">'+legend+'</ul>';
}

function renderStatsFocusComparison(current, previous) {
  const ids = [...new Set([...current.typeTotals.keys(), ...previous.typeTotals.keys()])]
    .sort((a, b) => (current.typeTotals.get(b) || 0) - (current.typeTotals.get(a) || 0)
      || (previous.typeTotals.get(b) || 0) - (previous.typeTotals.get(a) || 0));
  if (!ids.length) return '<p class="stats-detail-note">两个周期内均无专注时长。</p>';
  const rows = ids.map(id => {
    const label = (current.types.get(id) || previous.types.get(id)).label;
    const minutes = current.typeTotals.get(id) || 0;
    const before = previous.typeTotals.get(id) || 0;
    const share = current.totalMinutes ? (100 * minutes / current.totalMinutes).toFixed(1) + '%' : '—';
    const change = Math.round((minutes - before) * 60);
    const delta = change ? (change > 0 ? '+' : '−') + formatStatsTime(Math.abs(change) / 60) : '持平';
    return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(formatStatsTime(minutes))}</td><td>${share}</td>
      <td>${escapeHtml(formatStatsTime(before))}</td><td>${escapeHtml(delta)}</td></tr>`;
  }).join('');
  return `<div class="stats-comparison-scroll"><table class="stats-comparison">
    <thead><tr><th scope="col">类型</th><th scope="col">本期时长</th><th scope="col">本期占比</th><th scope="col">上期时长</th><th scope="col">较上期</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function renderStatsDayDetail(el, date, timer, todo, habits) {
  const records = timer.dailyRecords[date];
  const rate = habits.dailyRate[date];
  const habitText = rate === null ? '当天无适用习惯' : `习惯达标 ${habits.dailyMet[date]}/${habits.dailyEligible[date]} 项（${rate}%）`;
  const list = records.map(record => {
    const id = getTimerActivityType(record);
    const label = timer.types.get(id)?.label || id;
    const duration = formatTimerTime(Math.max(0, Number(record.totalMs) || 0));
    const periods = (Array.isArray(record.sessions) ? record.sessions : [])
      .filter(session => session && Number.isFinite(session.start) && Number.isFinite(session.end) && session.end > session.start)
      .map(session => formatTimeOnly(session.start) + '–' + formatTimeOnly(session.end)).join('、');
    const title = record.name ? `${escapeHtml(record.name)} <small>${escapeHtml(label)}</small>` : escapeHtml(label);
    return `<li><span>${title}${periods ? '<small class="stats-day-periods">'+escapeHtml(periods)+'</small>' : ''}</span><span>${duration}</span></li>`;
  }).join('');
  el.innerHTML = `<p class="stats-detail-note">专注 ${escapeHtml(formatStatsTime(timer.dailyMinutes[date]))} · 完成待办 ${todo.completed[date]} 项 · ${habitText}</p>`
    + (list ? '<ul class="stats-day-records" aria-label="原始专注记录">'+list+'</ul><p class="stats-detail-note">单条记录显示原始时长，上方合计已合并重叠时段。</p>'
      : '<p class="stats-detail-note">当天无专注记录。</p>');
}

function renderHabitDoughnut(cId, stats) {
  const el = document.getElementById(cId); if (!el) return;
  const { rate: overallRate, range, met, eligible } = stats;
  if (overallRate === null) {
    el.innerHTML = '<div class="stats-ai-empty">本期无适用习惯</div>';
    return;
  }
  const svgW = 150; const svgH = 150; const cx = 75; const cy = 75; const r = 55; const sw = 18;
  const angle = (Math.min(100, overallRate) / 100) * 360;
  const strokeColor = overallRate >= 80 ? '#10b981' : (overallRate >= 50 ? '#f59e0b' : '#ef4444');
  el.innerHTML = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
    <circle class="stats-chart-node" data-stats-tip="${statsTip('最近 '+range.length+' 天：应达标 '+eligible+' 项次，已达标 '+met+' 项次')}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}" opacity="0.25"/>
    <circle class="stats-chart-node stats-doughnut-progress" data-stats-tip="${statsTip('最近 '+range.length+' 天：应达标 '+eligible+' 项次，已达标 '+met+' 项次')}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="${sw}"
      stroke-dasharray="${(angle/360)*2*Math.PI*r} ${(1-angle/360)*2*Math.PI*r}"
      stroke-dashoffset="${2*Math.PI*r*0.25}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy-6}" text-anchor="middle" font-size="26" font-weight="700" fill="var(--text)">${Math.round(overallRate)}%</text>
    <text x="${cx}" y="${cy+16}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">达标 ${met}/${eligible} 项次</text>
  </svg>`;
}

function renderHeatmap(cId, timer, todo) {
  const el = document.getElementById(cId); if (!el) return;
  const max = Math.max(...Object.values(timer.dailyMinutes));
  const offset = (new Date(timer.range[0] + 'T00:00:00').getDay() + 6) % 7;
  const weekdays = [...'一二三四五六日'].map(day => `<span aria-hidden="true">${day}</span>`).join('');
  const empty = '<span aria-hidden="true"></span>'.repeat(offset);
  const cells = timer.range.map(date => {
    const minutes = timer.dailyMinutes[date];
    const intensity = minutes > 0 ? 18 + 56 * minutes / max : 6;
    const tip = statsTip(`${date} · 专注 ${formatStatsTime(minutes)} · 完成待办 ${todo.completed[date]} 项`);
    return `<button type="button" class="stats-heat-cell" data-stats-date="${date}" data-stats-tip="${tip}"
      aria-label="${tip}，查看记录" style="--stats-heat-intensity:${intensity}%">${Number(date.slice(8))}</button>`;
  }).join('');
  el.innerHTML = `<div class="stats-heatmap-grid">${weekdays}${empty}${cells}</div><p class="stats-detail-note">颜色越深，专注时长越长。</p>`;
}

// ═══════════ Stats: AI Analysis ═══════════
async function generateStatsAnalysis() {
  const btn = document.getElementById('statsAnalysisBtn');
  const result = document.getElementById('statsAnalysisResult');
  const loading = document.getElementById('statsAnalysisLoading');
  const placeholder = document.getElementById('statsAnalysisPlaceholder');
  const status = document.getElementById('statsAnalysisStatus');
  if (!result || !loading) return;

  const cfg = typeof getEffectiveApiConfig === 'function' ? getEffectiveApiConfig() : (typeof getEffectiveReportApiConfig === 'function' ? getEffectiveReportApiConfig() : null);
  if (!cfg || !cfg.apiKey) { if (status) status.textContent = '请先在设置中配置 AI API Key'; return; }

  if (btn) btn.disabled = true;
  loading.style.display = 'flex';
  result.style.display = 'none';
  if (placeholder) placeholder.style.display = 'none';
  if (status) status.textContent = '';

  const days = STATS_PERIOD;
  const ts = collectTodoStats(days); const ms = collectTimerStats(days);
  const hs = collectHabitStats(days);

  const todoDone = ts.range.reduce((s, d) => s + ts.completed[d], 0);
  const todoCreated = ts.range.reduce((s, d) => s + ts.created[d], 0);
  const totalMin = ms.totalMinutes;
  const sessions = ms.range.reduce((sum, date) => sum + ms.dailySessions[date], 0);
  const activeDays = ms.range.filter(date => ms.dailyMinutes[date] > 0).length;

  const breakdown = ts.range.map(date => {
    const habits = hs.dailyRate[date] === null ? '无适用习惯' : `习惯达标 ${hs.dailyMet[date]}/${hs.dailyEligible[date]} 项`;
    return `- ${date} · 完成待办 ${ts.completed[date]} 项 · 专注 ${formatStatsTime(ms.dailyMinutes[date])} · ${habits}`;
  }).join('\n');

  const dataText = `## 最近 ${days} 天（${ts.range[0]} 至 ${ts.range[days - 1]}）
- 新建待办 ${todoCreated} 项，完成待办 ${todoDone} 项
- 专注合计 ${formatStatsTime(totalMin)}，日均 ${formatStatsTime(totalMin / days)}，重叠时段已合并
- 专注记录 ${sessions} 条，有专注时长 ${activeDays} 天
- ${hs.rate === null ? '本期无适用习惯' : `习惯完成率 ${hs.rate}%（达标 ${hs.met}/${hs.eligible} 项次）`}

### 每日明细
${breakdown}`;

  const sp = `你是用户的学习伙伴，分析数据并提供洞察。请按以下结构回复：

**📈 整体趋势** — 数据是上升/下降/波动？有无规律？（2-3句）
**🌟 亮点** — 做得好的是什么？（1-2条）
**💡 建议** — 具体可操作的改进建议（1-2条）
**🎯 总结** — 一句鼓励的话

要求：中文、Markdown格式、有数据支撑、语气温暖、300-400字`;

  try {
    const resp = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model || 'gpt-3.5-turbo', messages: [{ role: 'system', content: sp }, { role: 'user', content: dataText }], temperature: cfg.temperature ?? 0.7, max_tokens: 2048 })
    });
    if (!resp.ok) throw new Error('API ' + resp.status + ': ' + await resp.text());
    const data = await resp.json();
    if (typeof AIClient !== 'undefined') AIClient.recordUsage(cfg.model || 'gpt-3.5-turbo', data.usage, {
      feature: 'stats_analysis', input: [sp, dataText], output: data.choices?.[0]?.message
    });
    refreshAiUsagePanel();
    const text = data.choices?.[0]?.message?.content || '（无内容返回）';
    result.innerHTML = parseAnalysisSections(text);
    result.style.display = 'block';
    if (status) status.textContent = '分析生成于 ' + new Date().toLocaleString('zh-CN');
  } catch (e) {
    if (status) status.textContent = '分析失败: ' + e.message;
    console.error('Stats analysis err:', e);
  } finally {
    if (btn) btn.disabled = false;
    loading.style.display = 'none';
  }
}

function parseAnalysisSections(text) {
  if (typeof formatMarkdownBase === 'function') return formatMarkdownBase(String(text || ''));
  return '<p class="stats-analysis-p">' + escapeHtml(String(text || '')).replace(/\n/g, '<br>') + '</p>';
}

// ═══════════ Stats: Main Render ═══════════
function renderStats() {
  const container = document.getElementById('section-stats');
  if (!container) return;
  const tip = document.getElementById('statsNodeTooltip');
  if (tip) tip.hidden = true;
  const days = STATS_PERIOD;
  const ts = collectTodoStats(days); const ms = collectTimerStats(days);
  const hs = collectHabitStats(days);
  const previous = collectTimerStats(days, days);
  const checkin = loadCheckinData();
  const streakLabel = checkin.lastDate ? '连续打卡 · 截至 '+checkin.lastDate : '连续打卡';
  const todoDone = ts.range.reduce((s, d) => s + ts.completed[d], 0);
  const dateOptions = [...ms.range].reverse().map(date => `<option value="${date}">${date}</option>`).join('');
  const compareDates = `本期 ${ms.range[0]} 至 ${ms.range[days - 1]} · 上期 ${previous.range[0]} 至 ${previous.range[days - 1]}`;

  container.innerHTML =
    '<div class="stats-header">'+
      '<div class="stats-header-left"><h2 class="stats-title"><i data-lucide="bar-chart-3" class="lucide-icon" style="width:20px;height:20px;vertical-align:middle"></i> 学习统计</h2><span class="stats-subtitle">最近 '+days+' 天数据概览</span></div>'+
      '<div class="stats-period-selector">'+
        '<button class="stats-period-btn'+(STATS_PERIOD===7?' active':'')+'" onclick="setStatsPeriod(7)">7天</button>'+
        '<button class="stats-period-btn'+(STATS_PERIOD===14?' active':'')+'" onclick="setStatsPeriod(14)">14天</button>'+
        '<button class="stats-period-btn'+(STATS_PERIOD===30?' active':'')+'" onclick="setStatsPeriod(30)">30天</button>'+
      '</div>'+
    '</div>'+
    '<div class="stats-overview-cards">'+
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(79,110,247,.12);color:var(--primary)"><i data-lucide="check-circle" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+todoDone+'</span><span class="stats-oc-label">已完成待办</span></div></div>'+
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(16,185,129,.12);color:#10b981"><i data-lucide="clock" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+escapeHtml(formatStatsTime(ms.totalMinutes))+'</span><span class="stats-oc-label">专注时长</span></div></div>'+
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(245,158,11,.12);color:#f59e0b"><i data-lucide="target" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+(hs.rate === null ? '—' : hs.rate+'%')+'</span><span class="stats-oc-label">'+(hs.rate === null ? '本期无适用习惯' : '习惯完成率')+'</span></div></div>'+
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(139,92,246,.12);color:#8b5cf6"><i data-lucide="flame" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+(Number(checkin.streak) || 0)+'天</span><span class="stats-oc-label">'+escapeHtml(streakLabel)+'</span></div></div>'+
    '</div>'+
    '<div class="stats-charts-row">'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="trending-up" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 完成待办趋势</h3><div class="stats-chart-body" id="statsTodoTrend"></div></div>'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="bar-chart-horizontal" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 每日专注时长</h3><div class="stats-chart-body stats-focus-chart" id="statsFocusChart"></div></div>'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="pie-chart" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 习惯完成率</h3><div class="stats-chart-body" id="statsHabitDoughnut" style="justify-content:center"></div></div>'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="grid" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 专注热力图</h3><div class="stats-chart-body stats-heatmap" id="statsHeatmap"></div></div>'+
    '</div>'+
    '<div class="stats-details-row">'+
      '<section class="stats-chart-card"><h3 class="stats-chart-title">专注类型对比</h3><p class="stats-detail-note">'+compareDates+'</p>'+
        renderStatsFocusComparison(ms, previous)+'<p class="stats-detail-note">重叠时间只计一次，跨类型重叠部分由各类型平分。</p></section>'+
      '<section class="stats-chart-card"><div class="stats-day-header"><h3 class="stats-chart-title">日期明细</h3>'+
        '<select id="statsDaySelect" aria-label="选择统计日期">'+dateOptions+'</select></div><div id="statsDayDetail" aria-live="polite"></div></section>'+
    '</div>'+
    '<div class="stats-ai-card">'+
      '<div class="stats-ai-header"><div><h3><i data-lucide="cpu" class="lucide-icon"></i> AI Token 消耗</h3><p id="statsAiAccuracy">按接口返回值统计；缺失 usage 时使用本地估算</p></div><button class="stats-ai-clear" onclick="clearAiUsageStats()"><i data-lucide="trash-2" class="lucide-icon"></i> 清空统计</button></div>'+
      '<div class="stats-ai-overview">'+
        '<div><strong id="statsAiTotal">0</strong><span>总 Token</span></div><div><strong id="statsAiInput">0</strong><span>输入 Token</span></div><div><strong id="statsAiOutput">0</strong><span>输出 Token</span></div><div><strong id="statsAiRequests">0</strong><span>请求次数</span></div>'+
      '</div>'+
      '<div class="stats-ai-grid">'+
        '<div class="stats-ai-pane"><h4>每日消耗趋势</h4><div id="statsAiTrend" class="stats-ai-trend"></div></div>'+
        '<div class="stats-ai-pane"><h4>按模型</h4><div id="statsAiModels"></div></div>'+
        '<div class="stats-ai-pane"><h4>按功能</h4><div id="statsAiFeatures"></div></div>'+
      '</div>'+
    '</div>'+
    '<div class="stats-analysis-card">'+
      '<div class="stats-analysis-header"><h3 class="stats-chart-title" style="margin:0"><i data-lucide="sparkles" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> AI 趋势分析</h3>'+
        '<button class="stats-analysis-btn" id="statsAnalysisBtn" onclick="generateStatsAnalysis()"><i data-lucide="refresh-cw" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 生成分析</button>'+
      '</div>'+
      '<div class="stats-analysis-body">'+
        '<div class="stats-analysis-loading" id="statsAnalysisLoading" style="display:none"><div class="stats-spinner"></div><span>AI 正在分析你的学习数据…</span></div>'+
        '<div class="stats-analysis-result" id="statsAnalysisResult" style="display:none"></div>'+
        '<div class="stats-analysis-placeholder" id="statsAnalysisPlaceholder"><i data-lucide="brain" class="lucide-icon" style="width:36px;height:36px;color:var(--text-secondary);opacity:.4;margin-bottom:8px"></i><p>点击「生成分析」让 AI 分析你的学习趋势，给出个性化建议</p></div>'+
        '<div class="stats-analysis-status" id="statsAnalysisStatus"></div>'+
      '</div>'+
    '</div>';

  bindStatsTooltip(container);
  const charts = container.querySelector('.stats-charts-row');
  const dateSelect = container.querySelector('#statsDaySelect');
  const detail = container.querySelector('#statsDayDetail');
  const updateDay = () => {
    renderStatsDayDetail(detail, dateSelect.value, ms, ts, hs);
    for (const cell of charts.querySelectorAll('[data-stats-date]')) {
      cell.setAttribute('aria-pressed', String(cell.dataset.statsDate === dateSelect.value));
    }
  };
  dateSelect.addEventListener('change', updateDay);
  const selectChartDay = event => {
    const cell = event.target.closest('[data-stats-date]');
    if (!cell) return;
    dateSelect.value = cell.dataset.statsDate;
    updateDay();
    dateSelect.focus();
  };
  charts.addEventListener('click', selectChartDay);
  charts.addEventListener('keydown', event => {
    if (!event.target.matches('.stats-focus-day') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    selectChartDay(event);
  });
  updateDay();

  // Text summaries do not depend on layout width, so update them even while
  // the stats section is hidden. Charts will be retried once the tab is visible.
  refreshAiUsagePanel();

  // Render charts — retry until layout is ready
  let tries = 0;
  function tryRenderCharts() {
    if (!charts.isConnected) return;
    const trendEl = document.getElementById('statsTodoTrend');
    if (trendEl && (trendEl.clientWidth > 0 || (trendEl.parentElement && trendEl.parentElement.clientWidth > 0))) {
      renderTodoLineChart('statsTodoTrend', ts);
      renderFocusBarChart('statsFocusChart', ms);
      renderHabitDoughnut('statsHabitDoughnut', hs);
      renderHeatmap('statsHeatmap', ms, ts);
      updateDay();
      refreshAiUsagePanel();
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }
    tries++;
    if (tries < 20) requestAnimationFrame(tryRenderCharts);
  }
  requestAnimationFrame(tryRenderCharts);
}
