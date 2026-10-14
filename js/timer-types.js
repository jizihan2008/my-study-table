// 类型使用稳定 ID；改名或停用不改变历史记录的分类及专注属性。
const TIMER_ACTIVITY_TYPES_KEY = 'study_timer_activity_types';
function loadTimerActivityTypes() {
  const defaults = [
    { id: 'focus', label: '专注', affectsFocus: true, disabled: false },
    { id: 'rest', label: '休息', affectsFocus: false, disabled: false },
    { id: 'other', label: '其它', affectsFocus: false, disabled: false }
  ];
  let saved;
  try { saved = JSON.parse(localStorage.getItem(TIMER_ACTIVITY_TYPES_KEY) || '[]'); } catch { saved = []; }
  const map = new Map(defaults.map(type => [type.id, type]));
  for (const type of Array.isArray(saved) ? saved : []) {
    if (!type || typeof type.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(type.id)) continue;
    const label = String(type.label || '').trim().slice(0, 40);
    if (!label) continue;
    map.set(type.id, { id: type.id, label, affectsFocus: type.affectsFocus === true, disabled: type.disabled === true });
  }
  return [...map.values()];
}
function getTimerActivityType(record) {
  if (typeof record?.activityType === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(record.activityType)) return record.activityType;
  return record?.affectsFocus === false ? 'other' : 'focus';
}
function getTimerActivityLabel(id) {
  return loadTimerActivityTypes().find(type => type.id === id)?.label || id || '未命名类型';
}
function getTimerActivityAffectsFocus(id) {
  return loadTimerActivityTypes().find(type => type.id === id)?.affectsFocus === true;
}
function renderTimerActivityOptions(selected, includeDisabled = false) {
  const types = loadTimerActivityTypes().filter(type => includeDisabled || !type.disabled || type.id === selected);
  if (selected && !types.some(type => type.id === selected)) types.push({ id: selected, label: getTimerActivityLabel(selected) });
  return types.map(type => `<option value="${escapeAttr(type.id)}"${type.id === selected ? ' selected' : ''}>${escapeHtml(type.label)}${type.disabled ? '（已停用）' : ''}</option>`).join('');
}
function saveTimerActivityTypes(types) {
  try {
    if (typeof saveData === 'function') return saveData(TIMER_ACTIVITY_TYPES_KEY, types);
    localStorage.setItem(TIMER_ACTIVITY_TYPES_KEY, JSON.stringify(types));
    return true;
  } catch { return false; }
}
function openTimerTypeManager() {
  let overlay = document.getElementById('timerTypeManager');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'timerTypeManager';
    overlay.className = 'modal-overlay';
    overlay.onclick = event => { if (event.target === overlay) closeTimerTypeManager(); };
    overlay.onkeydown = event => { if (event.key === 'Escape' && !event.isComposing) closeTimerTypeManager(); };
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = `<div class="modal timer-type-manager" role="dialog" aria-modal="true" aria-label="管理计时类型">
    <div class="modal-header"><span class="modal-title">管理计时类型</span><button type="button" class="modal-close" onclick="closeTimerTypeManager()" aria-label="关闭计时类型管理">×</button></div>
    <div class="modal-body">
      <p class="hint">类型可改名或停用。计入专注统计的设置用于新记录，已有记录保留原来的专注属性。</p>
      <div class="timer-types-list">${loadTimerActivityTypes().map(type => `<div class="timer-type-row" data-type-id="${escapeAttr(type.id)}">
        <input class="timer-type-name" aria-label="类型名称" maxlength="40" value="${escapeAttr(type.label)}">
        <label><input class="timer-type-focus" type="checkbox"${type.affectsFocus ? ' checked' : ''}>计入专注</label>
        <label><input class="timer-type-enabled" type="checkbox"${!type.disabled ? ' checked' : ''}>启用</label>
        <button type="button" class="today-timer-link" onclick="saveTimerTypeRow('${type.id}')">保存</button>
      </div>`).join('')}</div>
      <div class="modal-field"><label for="newTimerTypeName">新类型名称</label><input id="newTimerTypeName" maxlength="40" placeholder="例如：通勤、运动、阅读"></div>
      <label class="timer-new-type-focus"><input id="newTimerTypeFocus" type="checkbox">计入专注统计</label>
      <button type="button" class="btn-save-modal" onclick="createTimerActivityType()">创建类型</button>
      <div id="timerTypeManagerStatus" role="status" class="hint"></div>
    </div></div>`;
  overlay.classList.add('open');
  document.getElementById('newTimerTypeName').focus();
}
function refreshTimerActivityTypeControls() {
  for (const id of ['timerActivityType', 'manualRecActivityType', 'calEventActivityType']) {
    const select = document.getElementById(id);
    if (select) select.innerHTML = renderTimerActivityOptions(select.value || 'focus');
  }
  if (typeof renderTodayTimerRecords === 'function') renderTodayTimerRecords();
  if (typeof syncCalEventAutoTimerEnabled === 'function') syncCalEventAutoTimerEnabled();
}
function closeTimerTypeManager() {
  document.getElementById('timerTypeManager')?.classList.remove('open');
  refreshTimerActivityTypeControls();
}
function persistTimerTypeChange(types, message) {
  if (!saveTimerActivityTypes(types)) {
    document.getElementById('timerTypeManagerStatus').textContent = '保存失败，请重试';
    return false;
  }
  openTimerTypeManager();
  document.getElementById('timerTypeManagerStatus').textContent = message;
  refreshTimerActivityTypeControls();
  return true;
}
function createTimerActivityType() {
  const label = document.getElementById('newTimerTypeName').value.trim().slice(0, 40);
  const types = loadTimerActivityTypes();
  if (!label || types.some(type => type.label === label)) {
    document.getElementById('timerTypeManagerStatus').textContent = !label ? '请输入类型名称' : '类型名称已存在';
    return;
  }
  types.push({ id: 'type-' + genId(), label, affectsFocus: document.getElementById('newTimerTypeFocus').checked, disabled: false });
  persistTimerTypeChange(types, '类型已创建');
}
function saveTimerTypeRow(id) {
  const row = document.querySelector(`#timerTypeManager [data-type-id="${id}"]`);
  const types = loadTimerActivityTypes();
  const type = types.find(item => item.id === id);
  if (!row || !type) return;
  const label = row.querySelector('.timer-type-name').value.trim().slice(0, 40);
  if (!label || types.some(item => item.id !== id && item.label === label)) {
    document.getElementById('timerTypeManagerStatus').textContent = !label ? '请输入类型名称' : '类型名称已存在';
    return;
  }
  type.label = label;
  type.affectsFocus = row.querySelector('.timer-type-focus').checked;
  type.disabled = !row.querySelector('.timer-type-enabled').checked;
  persistTimerTypeChange(types, '类型已保存');
}
function getCalendarTimerActivityType(event) {
  return getTimerActivityType({ activityType: event?.autoActivityType, affectsFocus: event?.autoTimer !== false });
}
