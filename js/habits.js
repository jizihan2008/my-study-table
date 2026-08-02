// ═══════════ Habits: Data ═══════════
const HABITS_KEY = 'study_habits_v2'; // v2: checkins as {date: count} + dailyTarget/weeklyTarget
const HABIT_EMOJIS = ['📖','🏃','🧘','💪','🎯','✍️','🌅','💤','🥗','💧','📝','🎸','🌿','🧠','⌨️','🎨','🗣️','🚶','🏊','🚴'];
const HABIT_COLORS = ['#4f6ef7','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#f97316','#84cc16','#6366f1'];

let habits = loadAndMigrateHabits();

function loadAndMigrateHabits() {
  let raw = loadData(HABITS_KEY);
  // If empty, try v1 key
  if (!raw || !raw.length) {
    const v1 = loadData('study_habits_v1');
    if (v1 && v1.length) raw = v1;
    else return [];
  }
  // Migrate: string[] checkins → {date: count}
  let changed = false;
  for (const h of raw) {
    if (Array.isArray(h.checkins)) {
      const map = {};
      for (const d of h.checkins) { map[d] = (map[d] || 0) + 1; }
      h.checkins = map;
      changed = true;
    }
    if (h.checkins == null) h.checkins = {};
    if (h.dailyTarget == null) h.dailyTarget = 1;
    if (h.weeklyTarget == null) h.weeklyTarget = 7;
  }
  if (changed) saveData(HABITS_KEY, raw);
  return raw;
}

function loadHabits() { habits = loadAndMigrateHabits(); return habits; }
function saveHabits() { saveData(HABITS_KEY, habits); }

function getTodayDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getYesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getDateStr(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

// ── Helpers ──
function getCkMap(habit) { return habit.checkins || {}; }
function getDayCount(habit, dateStr) { return getCkMap(habit)[dateStr] || 0; }
function isDayMet(habit, dateStr) { return getDayCount(habit, dateStr) >= (habit.dailyTarget || 1); }

// ═══════════ Streak Calculation ═══════════
function calcStreak(habit) {
  const today = getTodayDateStr();
  const todayMet = isDayMet(habit, today);
  const todayCount = getDayCount(habit, today);
  const target = habit.dailyTarget || 1;

  // Current streak (consecutive days meeting dailyTarget)
  let streak = 0;
  const cursor = new Date();
  if (!todayMet) cursor.setDate(cursor.getDate() - 1);
  while (true) {
    const ds = getDateStr(cursor);
    if (isDayMet(habit, ds)) { streak++; cursor.setDate(cursor.getDate() - 1); }
    else break;
  }

  // Best streak
  const allDates = Object.keys(getCkMap(habit)).filter(d => (getCkMap(habit)[d] || 0) >= target).sort();
  let bestStreak = 0, currentRun = 0;
  for (let i = 0; i < allDates.length; i++) {
    if (i === 0) { currentRun = 1; }
    else {
      const prev = new Date(allDates[i - 1]);
      const curr = new Date(allDates[i]);
      const diff = Math.round((curr - prev) / 86400000);
      if (diff === 1) { currentRun++; }
      else { currentRun = 1; }
    }
    if (currentRun > bestStreak) bestStreak = currentRun;
  }

  return { streak, bestStreak, todayCount, todayMet, target };
}

// ═══════════ Weekly Progress ═══════════
function calcWeekProgress(habit) {
  const map = getCkMap(habit);
  const now = new Date();
  const dayOfWeek = now.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);

  const days = [];
  const dayLabels = ['一', '二', '三', '四', '五', '六', '日'];
  let totalCount = 0;
  let metDays = 0;
  const target = habit.dailyTarget || 1;
  const weekTarget = habit.weeklyTarget || 7;

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const ds = getDateStr(d);
    const cnt = map[ds] || 0;
    const met = cnt >= target;
    totalCount += cnt;
    if (met) metDays++;
    const isToday = ds === getTodayDateStr();
    days.push({ label: dayLabels[i], date: ds, count: cnt, met, isToday, target });
  }
  return { days, totalCount, metDays, weekTarget, target };
}

// ═══════════ Heat Map Data (28 days) ═══════════
function calcMonthDays(habit) {
  const map = getCkMap(habit);
  const today = new Date();
  const target = habit.dailyTarget || 1;
  const days = [];
  const start = new Date(today);
  start.setDate(start.getDate() - 27);

  for (let i = 0; i < 28; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const ds = getDateStr(d);
    const cnt = map[ds] || 0;
    const isToday = ds === getTodayDateStr();
    const isFuture = d > today;
    // Intensity level 0-4 based on count relative to target
    let level = 0;
    if (cnt > 0 && target > 0) {
      const ratio = cnt / target;
      if (ratio >= 1.5) level = 4;
      else if (ratio >= 1) level = 3;
      else if (ratio >= 0.5) level = 2;
      else level = 1;
    }
    days.push({ date: ds, dayNum: d.getDate(), count: cnt, level, isToday, isFuture, target });
  }

  const weeks = [];
  for (let i = 0; i < 28; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

// ═══════════ Habit CRUD ═══════════
function showHabitInput() {
  const panel = document.getElementById('habitInputPanel');
  const btn = document.getElementById('habitAddBtn');
  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    btn.textContent = '取消';
    btn.classList.add('active');
    setTimeout(() => document.getElementById('habitNameInput').focus(), 100);
  } else {
    panel.classList.remove('open');
    btn.textContent = '+ 新增习惯';
    btn.classList.remove('active');
  }
}

function addHabit() {
  const input = document.getElementById('habitNameInput');
  const name = input.value.trim();
  if (!name) return;

  const habit = {
    id: genId(),
    name: name,
    emoji: HABIT_EMOJIS[0],
    color: HABIT_COLORS[0],
    createdAt: new Date().toISOString(),
    checkins: {},
    dailyTarget: 1,
    weeklyTarget: 7,
    notes: '',
    order: habits.length
  };

  habits.push(habit);
  saveHabits();
  input.value = '';
  document.getElementById('habitInputPanel').classList.remove('open');
  document.getElementById('habitAddBtn').textContent = '+ 新增习惯';
  document.getElementById('habitAddBtn').classList.remove('active');
  renderHabits();
}

function incrementHabitCheckin(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;
  const todayStr = getTodayDateStr();
  if (!habit.checkins) habit.checkins = {};
  const before = habit.checkins[todayStr] || 0;
  habit.checkins[todayStr] = before + 1;
  // Track first checkin of the day for reminder system
  if (before === 0 && typeof trackFirstCheckinToday === 'function') {
    trackFirstCheckinToday();
  }
  saveHabits();
  renderHabits();
}

function decrementHabitCheckin(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;
  const todayStr = getTodayDateStr();
  if (!habit.checkins) habit.checkins = {};
  const cur = habit.checkins[todayStr] || 0;
  if (cur <= 1) {
    delete habit.checkins[todayStr];
  } else {
    habit.checkins[todayStr] = cur - 1;
  }
  saveHabits();
  renderHabits();
}

// ── Yesterday check-in ──
function incrementYesterdayCheckin(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;
  const yesterdayStr = getYesterdayDateStr();
  if (!habit.checkins) habit.checkins = {};
  habit.checkins[yesterdayStr] = (habit.checkins[yesterdayStr] || 0) + 1;
  saveHabits();
  renderHabits();
}

function decrementYesterdayCheckin(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;
  const yesterdayStr = getYesterdayDateStr();
  if (!habit.checkins) habit.checkins = {};
  const cur = habit.checkins[yesterdayStr] || 0;
  if (cur <= 1) {
    delete habit.checkins[yesterdayStr];
  } else {
    habit.checkins[yesterdayStr] = cur - 1;
  }
  saveHabits();
  renderHabits();
}

function deleteHabit(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;
  const name = habit.name;

  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(
      `确定要删除习惯「${escapeHtml(name)}」吗？<br><small>删除后可在回收站中恢复。</small>`
    ).then(confirmed => {
      if (!confirmed) return;
      if (typeof moveToTrash === 'function') { moveToTrash('habits', habit); }
    });
  } else {
    if (confirm(`确定要删除习惯「${name}」吗？删除后可在回收站恢复。`)) {
      if (typeof moveToTrash === 'function') { moveToTrash('habits', habit); }
    }
  }
}

function archiveHabit(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;
  if (typeof moveToArchive === 'function') { moveToArchive('habits', habit); }
}

function openEditHabitModal(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;

  _editHabitEmoji = habit.emoji;
  _editHabitColor = habit.color;
  _editDailyTarget = habit.dailyTarget || 1;
  _editWeeklyTarget = habit.weeklyTarget || 7;

  editModalOpen = true;
  document.getElementById('editModalTitle').innerHTML = '<i data-lucide="target" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 编辑习惯';
  document.getElementById('editModalBody').innerHTML = `
    <div class="modal-field">
      <label>习惯名称</label>
      <input type="text" id="editHabitName" value="${escapeHtml(habit.name)}" maxlength="50" onkeydown="if(event.key==='Enter')saveEditHabit(${habitId})">
    </div>
    <div class="modal-field">
      <label>图标</label>
      <div class="habit-emoji-picker" id="editHabitEmojiPicker">
        ${HABIT_EMOJIS.map(em =>
          `<span class="habit-emoji-option${habit.emoji === em ? ' selected' : ''}" onclick="pickEditHabitEmoji(this, '${em}')">${em}</span>`
        ).join('')}
      </div>
    </div>
    <div class="modal-field">
      <label>颜色</label>
      <div class="habit-color-picker" id="editHabitColorPicker">
        ${HABIT_COLORS.map(c =>
          `<span class="habit-color-option${habit.color === c ? ' selected' : ''}" style="background:${c}" onclick="pickEditHabitColor(this, '${c}')" title="${c}"></span>`
        ).join('')}
      </div>
    </div>
    <div class="modal-field-targets">
      <div class="modal-field">
        <label>每日目标次数</label>
        <input type="number" id="editDailyTarget" value="${_editDailyTarget}" min="1" max="99" style="width:80px;">
      </div>
      <div class="modal-field">
        <label>每周目标次数</label>
        <input type="number" id="editWeeklyTarget" value="${_editWeeklyTarget}" min="1" max="999" style="width:80px;">
      </div>
    </div>
    <div class="modal-field">
      <label>备注</label>
      <textarea id="editHabitNotes" placeholder="可选，记录习惯的目标、心得等...">${escapeHtml(habit.notes || '')}</textarea>
    </div>
    <button class="btn-save-modal" onclick="saveEditHabit(${habitId})">💾 保存</button>
  `;
  document.getElementById('editModal').classList.add('open');
  setTimeout(() => document.getElementById('editHabitName').focus(), 300);
}

let _editHabitEmoji = '';
let _editHabitColor = '';
let _editDailyTarget = 1;
let _editWeeklyTarget = 7;

function pickEditHabitEmoji(el, emoji) {
  _editHabitEmoji = emoji;
  document.querySelectorAll('#editHabitEmojiPicker .habit-emoji-option').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

function pickEditHabitColor(el, color) {
  _editHabitColor = color;
  document.querySelectorAll('#editHabitColorPicker .habit-color-option').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

function saveEditHabit(habitId) {
  const habit = habits.find(h => h.id === habitId);
  if (!habit) return;

  const name = document.getElementById('editHabitName').value.trim();
  if (!name) return;

  habit.name = name;
  if (_editHabitEmoji) habit.emoji = _editHabitEmoji;
  if (_editHabitColor) habit.color = _editHabitColor;
  habit.dailyTarget = parseInt(document.getElementById('editDailyTarget').value) || 1;
  habit.weeklyTarget = parseInt(document.getElementById('editWeeklyTarget').value) || 7;
  habit.notes = document.getElementById('editHabitNotes').value.trim();

  _editHabitEmoji = '';
  _editHabitColor = '';
  saveHabits();
  closeEditModal();
  renderHabits();
}

// ═══════════ Rendering ═══════════
// Helper: convert habit color hex to rgba with alpha
function colorWithAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function renderHabits() {
  loadHabits();
  const grid = document.getElementById('habitsGrid');
  const empty = document.getElementById('habitsEmpty');
  if (!grid || !empty) return;

  if (habits.length === 0) {
    grid.style.display = 'none';
    empty.style.display = '';
    return;
  }

  empty.style.display = 'none';
  grid.style.display = 'grid';

  const sorted = [...habits].sort((a, b) => (a.order || 0) - (b.order || 0));

  grid.innerHTML = sorted.map(habit => {
    const { streak, bestStreak, todayCount, todayMet, target } = calcStreak(habit);
    const { days, totalCount, metDays, weekTarget } = calcWeekProgress(habit);
    const weeks = calcMonthDays(habit);
    const totalCheckins = Object.values(getCkMap(habit)).reduce((s, c) => s + c, 0);
    const createdAt = habit.createdAt ? new Date(habit.createdAt) : null;
    const daysSince = createdAt ? Math.floor((Date.now() - createdAt) / 86400000) + 1 : 1;
    const consistency = daysSince > 0 ? Math.min(100, Math.round(totalCheckins / (daysSince * target) * 100)) : 0;

    // Yesterday data
    const yesterdayStr = getYesterdayDateStr();
    const yesterdayCount = getDayCount(habit, yesterdayStr);
    const yesterdayMet = isDayMet(habit, yesterdayStr);

    return `
      <div class="habit-card" style="border-top: 3px solid ${habit.color}">
        <!-- Header -->
        <div class="habit-card-header">
          <div class="habit-card-title" onclick="openEditHabitModal(${habit.id})" title="点击编辑">
            <span class="habit-card-emoji">${habit.emoji}</span>
            <span class="habit-card-name">${escapeHtml(habit.name)}</span>
          </div>
          <div class="habit-card-actions">
            <button class="habit-card-btn" onclick="event.stopPropagation();openEditHabitModal(${habit.id})" title="编辑">
              <i data-lucide="pencil" class="lucide-icon" style="width:13px;height:13px;"></i>
            </button>
            <button class="habit-card-btn" onclick="event.stopPropagation();archiveHabit(${habit.id})" title="归档">
              <i data-lucide="archive" class="lucide-icon" style="width:13px;height:13px;"></i>
            </button>
            <button class="habit-card-btn danger" onclick="event.stopPropagation();deleteHabit(${habit.id})" title="删除">
              <i data-lucide="trash-2" class="lucide-icon" style="width:13px;height:13px;"></i>
            </button>
          </div>
        </div>

        <!-- Stats -->
        <div class="habit-card-stats">
          <div class="habit-stat">
            <span class="habit-stat-value">${streak}</span>
            <span class="habit-stat-label">连续天数</span>
          </div>
          <div class="habit-stat">
            <span class="habit-stat-value">${bestStreak}</span>
            <span class="habit-stat-label">最佳记录</span>
          </div>
          <div class="habit-stat">
            <span class="habit-stat-value">${consistency}%</span>
            <span class="habit-stat-label">坚持率</span>
          </div>
        </div>

        <!-- Daily progress bar -->
        <div class="habit-daily-progress">
          <div class="habit-daily-progress-bar">
            <div class="habit-daily-progress-fill" style="width:${Math.min(100, todayCount / target * 100)}%;background:${habit.color}"></div>
            <span class="habit-daily-progress-text">今日 ${todayCount}/${target} 次</span>
          </div>
        </div>

        <!-- Yesterday check-in area -->
        <div class="habit-yesterday-area">
          <div class="habit-yesterday-header">
            <i data-lucide="clock-4" class="lucide-icon" style="width:12px;height:12px;vertical-align:middle;"></i>
            <span>昨天（${yesterdayStr.slice(5)}）</span>
            ${yesterdayMet ? '<span class="habit-yesterday-tag met">✓ 已达标</span>' : (yesterdayCount > 0 ? '<span class="habit-yesterday-tag partial">未达标</span>' : '<span class="habit-yesterday-tag empty">未打卡</span>')}
          </div>
          <div class="habit-yesterday-actions">
            ${yesterdayCount > 0 ? `
              <button class="habit-yesterday-decr" onclick="decrementYesterdayCheckin(${habit.id})" title="减少昨天一次">
                <i data-lucide="minus" class="lucide-icon" style="width:12px;height:12px;"></i>
              </button>
            ` : ''}
            <button class="habit-yesterday-btn${yesterdayMet ? ' met' : (yesterdayCount > 0 ? ' partial' : '')}"
                    style="--habit-color:${habit.color}"
                    onclick="incrementYesterdayCheckin(${habit.id})">
              <i data-lucide="${yesterdayCount > 0 ? 'check-square' : 'square'}" class="lucide-icon" style="width:13px;height:13px;"></i>
              <span>${yesterdayCount > 0 ? `完成 ${yesterdayCount}/${target} 次` + (yesterdayMet ? ' ✓' : '') : `补打卡 (+1)`}</span>
            </button>
          </div>
        </div>

        <!-- Weekly bar -->
        <div class="habit-week-bar">
          <div class="habit-week-label">本周 ${totalCount}/${weekTarget} 次 · ${metDays} 天达标</div>
          <div class="habit-week-dots">
            ${days.map(d => {
              const intensity = d.met ? Math.min((d.count / d.target), 2) : (d.count > 0 ? 0.3 : 0);
              return `
              <div class="habit-week-dot${d.count > 0 ? ' checked' : ''}${d.isToday ? ' today' : ''}"
                   style="${d.count > 0 ? 'background:' + colorWithAlpha(habit.color, 0.25 + intensity * 0.75) : ''}"
                   title="${d.label} ${d.count}/${d.target}${d.met ? ' ✓' : ''}">
                <span>${d.label}</span>
                ${d.count > 0 ? `<small>${d.count}</small>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>

        <!-- Mini heat map (last 4 weeks) -->
        <div class="habit-heatmap">
          ${weeks.map(week => `
            <div class="habit-heatmap-week">
              ${week.map(d => `
                <div class="habit-heatmap-day${d.level > 0 ? ' checked lvl-' + d.level : ''}${d.isToday ? ' today' : ''}${d.isFuture ? ' future' : ''}"
                     style="${d.level > 0 ? 'background:' + colorWithAlpha(habit.color, 0.15 + d.level * 0.22) : ''}"
                     title="${d.date} ${d.count}/${d.target}"></div>
              `).join('')}
            </div>
          `).join('')}
        </div>

        <!-- Check-in block -->
        <div class="habit-checkin-area">
          ${todayCount > 0 ? `
            <button class="habit-checkin-decr" onclick="decrementHabitCheckin(${habit.id})" title="减少一次">
              <i data-lucide="minus" class="lucide-icon" style="width:14px;height:14px;"></i>
            </button>
          ` : ''}
          <button class="habit-checkin-btn${todayMet ? ' met' : (todayCount > 0 ? ' partial' : '')}"
                  style="--habit-color:${habit.color}"
                  onclick="incrementHabitCheckin(${habit.id})">
            <i data-lucide="${todayMet ? 'check-circle-2' : (todayCount > 0 ? 'circle-dot' : 'plus-circle')}" class="lucide-icon" style="width:16px;height:16px;"></i>
            <span>${todayCount > 0 ? `${todayCount}/${target} 次` + (todayMet ? ' ✓' : '') : `打卡 (+1)`}</span>
          </button>
        </div>

        ${habit.notes ? `<div class="habit-card-notes">${escapeHtml(habit.notes)}</div>` : ''}
      </div>
    `;
  }).join('');

  if (typeof lucide !== 'undefined') setTimeout(() => lucide.createIcons(), 0);
}

// ═══════════ Auto-checkin notification ═══════════
function checkHabitReminder() {
  const today = getTodayDateStr();
  const unchecked = habits.filter(h => !isDayMet(h, today));
  const hour = new Date().getHours();
  if (hour >= 20 && unchecked.length > 0 && unchecked.length === habits.length && habits.length > 0) {
    return;
  }
  if (hour >= 21 && unchecked.length > 0) {
    if (typeof sendNotification === 'function') {
      sendNotification('习惯提醒', `你还有 ${unchecked.length} 个习惯未达标，别忘了哦 🌙`);
    }
  }
}

// ═══════════ Initialization ═══════════
setTimeout(() => { loadHabits(); }, 0);
