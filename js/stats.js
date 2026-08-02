// ═══════════ Stats: Data Collection ═══════════
// Uses existing getDateStr() and getPastDateStr() from habits.js and settings.js
let STATS_PERIOD = 7;

function collectDateRange(days) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(getPastDateStr(i));
  return dates;
}

function collectTodoStats(days) {
  const range = collectDateRange(days);
  const todos = JSON.parse(localStorage.getItem('study_todos_v2') || '[]');
  const completed = {}, created = {};
  range.forEach(d => { completed[d] = 0; created[d] = 0; });
  todos.forEach(t => {
    // completedAt is set when todo.toggle → completedAt = formatDate(new Date())
    const rawD = t.completedAt || '';
    const d = (typeof rawD === 'string' ? rawD : String(rawD)).slice(0, 10);
    if (d && completed[d] !== undefined) completed[d]++;
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

function collectTimerStats(days) {
  const range = collectDateRange(days);
  const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
  const dailyMinutes = {}, dailySessions = {};
  range.forEach(d => { dailyMinutes[d] = 0; dailySessions[d] = 0; });
  records.forEach(r => {
    // timer records use { date: "2026-07-24", totalMs: number }
    const d = (r.date || '').slice(0, 10);
    if (dailyMinutes[d] !== undefined) {
      dailyMinutes[d] += (r.totalMs || 0) / 60000;
      dailySessions[d]++;
    }
  });
  return { range, dailyMinutes, dailySessions };
}

function collectHabitStats(days) {
  const range = collectDateRange(days);
  const habits = JSON.parse(localStorage.getItem('study_habits_v2') || '[]');
  const dailyRate = {};
  range.forEach(d => { dailyRate[d] = 0; });
  const activeHabits = habits.filter(h => h.checkins);
  if (activeHabits.length === 0) return { range, dailyRate, habitCount: 0 };
  // For each day, average completion rate across all active habits
  range.forEach(d => {
    let totalRate = 0;
    activeHabits.forEach(h => {
      const target = h.dailyTarget || 1;
      const done = h.checkins[d] || 0;
      totalRate += Math.min(1, done / target); // 0~1 per habit
    });
    dailyRate[d] = Math.round((totalRate / activeHabits.length) * 100);
  });
  return { range, dailyRate, habitCount: activeHabits.length };
}

function collectOverallStats() {
  const todos = JSON.parse(localStorage.getItem('study_todos_v2') || '[]');
  const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
  const notes = JSON.parse(localStorage.getItem('study_notes_v2') || '[]');
  const checkin = JSON.parse(localStorage.getItem('study_checkin') || '{"dates":[],"streak":0}');
  const habits = JSON.parse(localStorage.getItem('study_habits_v2') || '[]');
  const totalMin = records.reduce((s, r) => s + (r.totalMs || 0) / 60000, 0);
  const activeDays = new Set(records.map(r => (r.date || '').slice(0, 10)).filter(Boolean)).size;
  return {
    totalTodos: todos.length, completedTodos: todos.filter(t => t.done).length,
    totalMin, totalSessions: records.length,
    totalNotes: notes.filter(n => n.type === 'note').length, activeDays,
    streak: checkin.streak || 0, totalHabits: habits.length
  };
}

function setStatsPeriod(days) {
  STATS_PERIOD = days;
  renderStats();
}

function formatStatsTime(minutes) {
  if (minutes < 60) return Math.round(minutes) + '分钟';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? h + 'h ' + m + 'm' : h + '小时';
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
    dots += '<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="3.5" fill="var(--primary)" stroke="#fff" stroke-width="1.5"/>';
    if (i % li === 0) xLabels += '<text x="'+x.toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" font-size="10" fill="var(--text-secondary)">'+range[i].slice(5)+'</text>';
  });
  el.innerHTML = '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'"><defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--primary)" stop-opacity="0.25"/><stop offset="100%" stop-color="var(--primary)" stop-opacity="0.02"/></linearGradient></defs>'+grid+'<path d="'+areaD+'" fill="url(#ag)"/><polyline points="'+pts.trim()+'" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>'+dots+xLabels+'</svg>';
}

function renderFocusBarChart(cId, stats) {
  const el = document.getElementById(cId); if (!el) return;
  const { range, dailyMinutes } = stats;
  const elW = el.parentElement ? el.parentElement.clientWidth : 0;
  const W = Math.max(200, (elW || el.clientWidth || 260) - 30);
  const H = 180;
  const padL = 36, padR = 12, padT = 12, padB = 26, plotW = W - padL - padR, plotH = H - padT - padB;
  const vals = range.map(d => dailyMinutes[d]);
  const maxY = Math.max(30, ...vals) || 30;
  const bc = vals.length;
  const bw = Math.min(26, Math.max(6, (plotW / bc) * 0.62));
  const gap = plotW / bc;
  let grid = '', bars = '';
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH * g / 4, v = Math.round(maxY * (1 - g / 4));
    grid += '<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(padL+plotW)+'" y2="'+y.toFixed(1)+'" stroke="var(--border)" stroke-dasharray="3,3"/><text x="'+(padL-6)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" font-size="9" fill="var(--text-secondary)">'+v+'m</text>';
  }
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  vals.forEach((v, i) => {
    const x = padL + i * gap + (gap - bw) / 2;
    const barH = Math.max(2, (v / maxY) * plotH);
    const y = padT + plotH - barH;
    bars += '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+bw.toFixed(1)+'" height="'+barH.toFixed(1)+'" rx="3" fill="'+((v>=avg && v>0)?'var(--primary)':'var(--border)')+'" opacity="'+(v>=avg && v>0?'0.9':'0.5')+'"/>';
  });
  let xLabels = ''; const li = range.length > 14 ? 4 : (range.length > 7 ? 2 : 1);
  range.forEach((d, i) => { if (i % li === 0) { const x = padL + i * gap + gap / 2; xLabels += '<text x="'+x.toFixed(1)+'" y="'+(H-4)+'" text-anchor="middle" font-size="10" fill="var(--text-secondary)">'+d.slice(5)+'</text>'; } });
  el.innerHTML = '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">'+grid+bars+xLabels+'</svg>';
}

function renderHabitDoughnut(cId, stats) {
  const el = document.getElementById(cId); if (!el) return;
  const { dailyRate, range } = stats;
  const overallRate = range.reduce((s, d) => s + dailyRate[d], 0) / range.length;
  const svgW = 150; const svgH = 150; const cx = 75; const cy = 75; const r = 55; const sw = 18;
  const angle = (Math.min(100, overallRate) / 100) * 360;
  const strokeColor = overallRate >= 80 ? '#10b981' : (overallRate >= 50 ? '#f59e0b' : '#ef4444');
  el.innerHTML = `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}" opacity="0.25"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${strokeColor}" stroke-width="${sw}"
      stroke-dasharray="${(angle/360)*2*Math.PI*r} ${(1-angle/360)*2*Math.PI*r}"
      stroke-dashoffset="${2*Math.PI*r*0.25}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy-6}" text-anchor="middle" font-size="26" font-weight="700" fill="var(--text)">${Math.round(overallRate)}%</text>
    <text x="${cx}" y="${cy+16}" text-anchor="middle" font-size="11" fill="var(--text-secondary)">习惯完成率</text>
  </svg>`;
}

function renderHeatmap(cId) {
  const el = document.getElementById(cId); if (!el) return;
  const days = 35; const cols = 7;
  const records = JSON.parse(localStorage.getItem('study_timer_records') || '[]');
  const todos = JSON.parse(localStorage.getItem('study_todos_v2') || '[]');
  const activityMap = {};
  for (let i = 0; i < days; i++) activityMap[getPastDateStr(i)] = 0;
  records.forEach(r => { const d = (r.date || '').slice(0, 10); if (activityMap[d] !== undefined) activityMap[d] += (r.totalMs || 0) / 60000; });
  todos.forEach(t => { if (t.done && t.completedAt) { const d = t.completedAt.slice(0, 10); if (activityMap[d] !== undefined) activityMap[d] += 15; } });
  const allVals = Object.values(activityMap).filter(v => v > 0); const maxVal = Math.max(1, ...allVals);
  const cs = 14, cg = 3, lw = 24;
  let cells = '';
  // Loop from today (daysAgo=0) backwards; row 0 = this week, row 4 = oldest
  for (let daysAgo = 0; daysAgo < days; daysAgo++) {
    const ds = getPastDateStr(daysAgo); const val = activityMap[ds] || 0;
    const date = new Date(ds);
    let col = date.getDay() === 0 ? 6 : date.getDay() - 1; // Mon=0, Sun=6
    const row = Math.floor(daysAgo / cols);
    const intensity = maxVal > 0 ? Math.min(1, val / maxVal) : 0;
    const opacity = intensity < 0.01 ? 0.06 : 0.12 + intensity * 0.88;
    cells += '<rect x="'+(col*(cs+cg)+lw)+'" y="'+(row*(cs+cg))+'" width="'+cs+'" height="'+cs+'" rx="3" fill="var(--primary)" opacity="'+opacity.toFixed(2)+'" title="'+ds+': '+Math.round(val)+'分"/>';
  }
  // Day labels (Mon, Wed, Fri, Sun)
  const dayPositions = [{idx:0,y:10},{idx:2,y:27},{idx:4,y:44},{idx:6,y:61}];
  let dl = dayPositions.map(dp => '<text x="0" y="'+dp.y+'" font-size="9" fill="var(--text-secondary)" text-anchor="start">'+['一','三','五','日'][dayPositions.indexOf(dp)]+'</text>').join('');
  const sw = lw + cols * (cs + cg); const rows = Math.ceil(days / cols); const sh = rows * (cs + cg);
  el.innerHTML = '<svg width="'+sw+'" height="'+sh+'" viewBox="0 0 '+sw+' '+sh+'">'+dl+cells+'</svg>';
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
  const hs = collectHabitStats(days); const ov = collectOverallStats();

  const todoDone = ts.range.reduce((s, d) => s + ts.completed[d], 0);
  const totalMin = ms.range.reduce((s, d) => s + ms.dailyMinutes[d], 0);
  const avgRate = hs.range.reduce((s, d) => s + hs.dailyRate[d], 0) / days;

  let breakdown = '';
  ts.range.forEach(d => { breakdown += '- '+d+': 待办完成'+ts.completed[d]+'个, 专注'+Math.round(ms.dailyMinutes[d])+'分, 习惯'+hs.dailyRate[d]+'%\n'; });

  const dataText = `## 最近 ${days} 天统计数据
- 总待办: ${ov.totalTodos}（已完成${ov.completedTodos}，率 ${ov.totalTodos>0?Math.round(ov.completedTodos/ov.totalTodos*100):0}%）
- 本次统计完成: ${todoDone}个
- 总专注: ${Math.round(totalMin)}分(${(totalMin/60).toFixed(1)}h)，日均 ${Math.round(totalMin/days)}分
- 专注次数: ${ov.totalSessions}次
- 习惯完成率: ${Math.round(avgRate)}%
- 连续打卡: ${ov.streak}天 | 笔记: ${ov.totalNotes}篇
- 活跃天数: ${ov.activeDays}

### 每日明细
${breakdown}
### 近7天趋势
${ts.range.slice(-7).map(d => d.slice(5)+': 待办'+ts.completed[d]+' 专注'+Math.round(ms.dailyMinutes[d])+'分 习惯'+hs.dailyRate[d]+'%').join('\n')}`;

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
  let html = ''; const lines = text.split('\n'); let inList = null; // null, 'ul', 'ol'
  function closeList() { if (inList) { html += inList === 'ul' ? '</ul>' : '</ol>'; inList = null; } }
  // 先 HTML 转义再套 Markdown 格式，防止 AI 输出中夹带 HTML/脚本被直接注入
  const fmt = t => escapeHtml(t).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code class="stats-inline-code">$1</code>');
  for (const line of lines) {
    const tr = line.trim();
    if (!tr) { closeList(); continue; }
    if (tr.startsWith('### ')) { closeList(); html += '<h4 class="stats-analysis-h4">'+fmt(tr.slice(4))+'</h4>'; continue; }
    if (tr.startsWith('## ')) { closeList(); html += '<h3 class="stats-analysis-h3">'+fmt(tr.slice(3))+'</h3>'; continue; }
    if (tr.startsWith('# ')) { closeList(); html += '<h2 class="stats-analysis-h2">'+fmt(tr.slice(2))+'</h2>'; continue; }
    if (tr.startsWith('- ') || tr.startsWith('* ')) {
      if (inList !== 'ul') { closeList(); html += '<ul class="stats-analysis-list">'; inList = 'ul'; }
      html += '<li>'+fmt(tr.slice(2))+'</li>'; continue;
    }
    if (/^\d+\.\s/.test(tr)) {
      if (inList !== 'ol') { closeList(); html += '<ol class="stats-analysis-list">'; inList = 'ol'; }
      html += '<li>'+fmt(tr.replace(/^\d+\.\s/,''))+'</li>'; continue;
    }
    closeList();
    html += '<p class="stats-analysis-p">'+fmt(tr)+'</p>';
  }
  closeList();
  return html;
}

// ═══════════ Stats: Main Render ═══════════
function renderStats() {
  const container = document.getElementById('section-stats');
  if (!container) return;
  const days = STATS_PERIOD;
  const ts = collectTodoStats(days); const ms = collectTimerStats(days);
  const hs = collectHabitStats(days); const ov = collectOverallStats();
  const todoDone = ts.range.reduce((s, d) => s + ts.completed[d], 0);
  const totalMin = ms.range.reduce((s, d) => s + ms.dailyMinutes[d], 0);
  const avgRate = hs.range.reduce((s, d) => s + hs.dailyRate[d], 0) / days;

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
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(16,185,129,.12);color:#10b981"><i data-lucide="clock" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+formatStatsTime(totalMin)+'</span><span class="stats-oc-label">专注时长</span></div></div>'+
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(245,158,11,.12);color:#f59e0b"><i data-lucide="target" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+Math.round(avgRate)+'%</span><span class="stats-oc-label">习惯完成率</span></div></div>'+
      '<div class="stats-oc"><div class="stats-oc-icon" style="background:rgba(139,92,246,.12);color:#8b5cf6"><i data-lucide="flame" class="lucide-icon" style="width:18px;height:18px"></i></div><div class="stats-oc-info"><span class="stats-oc-value">'+ov.streak+'天</span><span class="stats-oc-label">连续打卡</span></div></div>'+
    '</div>'+
    '<div class="stats-charts-row">'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="trending-up" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 完成待办趋势</h3><div class="stats-chart-body" id="statsTodoTrend"></div></div>'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="bar-chart-horizontal" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 每日专注时长</h3><div class="stats-chart-body" id="statsFocusChart"></div></div>'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="pie-chart" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 习惯完成率</h3><div class="stats-chart-body" id="statsHabitDoughnut" style="justify-content:center"></div></div>'+
      '<div class="stats-chart-card"><h3 class="stats-chart-title"><i data-lucide="grid" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle"></i> 活动热力图</h3><div class="stats-chart-body" id="statsHeatmap" style="justify-content:center;overflow-x:auto"></div></div>'+
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

  // Render charts — retry until layout is ready
  let tries = 0;
  function tryRenderCharts() {
    const trendEl = document.getElementById('statsTodoTrend');
    if (trendEl && (trendEl.clientWidth > 0 || (trendEl.parentElement && trendEl.parentElement.clientWidth > 0))) {
      renderTodoLineChart('statsTodoTrend', ts);
      renderFocusBarChart('statsFocusChart', ms);
      renderHabitDoughnut('statsHabitDoughnut', hs);
      renderHeatmap('statsHeatmap');
      if (typeof lucide !== 'undefined') lucide.createIcons();
      return;
    }
    tries++;
    if (tries < 20) requestAnimationFrame(tryRenderCharts);
  }
  requestAnimationFrame(tryRenderCharts);
}
