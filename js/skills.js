// 可复用的 AI 行为准则。选中技能时由 ai-attach.js 将当时的文字快照插入下一条消息。
'use strict';

const AI_SKILLS_KEY = 'study_ai_skills_v1';
let activeAiSkillId = null;
let aiSkillPickerQuery = '';

function loadAiSkills() {
  try {
    const value = JSON.parse(localStorage.getItem(AI_SKILLS_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.content === 'string');
  } catch (_) { return []; }
}

function getAiSkill(id) {
  return loadAiSkills().find(item => item.id === id) || null;
}

function saveAiSkills(items) {
  localStorage.setItem(AI_SKILLS_KEY, JSON.stringify(items));
}

function refreshAiSkillViews() {
  if (document.getElementById('section-skills')?.classList.contains('active')) renderSkillsStudio();
  if (typeof renderAiContextPreview === 'function') renderAiContextPreview();
  const picker = document.getElementById('aiSkillPickerOverlay');
  if (picker && picker.style.display !== 'none') renderAiSkillPicker();
}

function aiSkillEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function aiSkillId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'skill-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function aiSkillEditorChanged() {
  const name = document.getElementById('aiSkillName');
  const content = document.getElementById('aiSkillContent');
  if (!name || !content) return false;
  const saved = activeAiSkillId ? getAiSkill(activeAiSkillId) : null;
  return name.value.trim() !== (saved?.name || '') || content.value.trim() !== (saved?.content || '');
}

function selectAiSkill(id) {
  if (aiSkillEditorChanged() && !confirm('当前技能有未保存的修改，确定放弃吗？')) return;
  activeAiSkillId = id;
  renderSkillsStudio();
}

function renderSkillsStudio() {
  const root = document.getElementById('skillsStudio');
  if (!root) return;
  const skills = loadAiSkills();
  if (activeAiSkillId && !skills.some(item => item.id === activeAiSkillId)) activeAiSkillId = null;
  const current = activeAiSkillId ? skills.find(item => item.id === activeAiSkillId) : null;
  root.innerHTML = `
    <aside class="skills-list-panel">
      <div class="skills-panel-head"><div><h2>技能库</h2><p>${skills.length} 个技能</p></div><button type="button" class="skills-primary-btn" onclick="selectAiSkill(null)"><i data-lucide="plus"></i> 新建</button></div>
      <div class="skills-list" aria-label="技能列表">${skills.length ? skills.map((item, index) => `
        <button type="button" class="skills-list-item${item.id === activeAiSkillId ? ' active' : ''}" onclick="selectAiSkill(loadAiSkills()[${index}].id)">
          <strong>${aiSkillEscape(item.name)}</strong><span>${aiSkillEscape(item.content.replace(/\s+/g, ' ').slice(0, 80))}</span>
        </button>`).join('') : '<div class="skills-empty">还没有技能。创建一个常用的处理准则，之后可在 AI 对话中插入。</div>'}</div>
    </aside>
    <div class="skills-editor-panel">
      <div class="skills-editor-head"><div><h2>${current ? '编辑技能' : '新建技能'}</h2><p>技能文字会在选中后插入下一条 AI 消息。</p></div>${current ? '<button type="button" class="skills-delete-btn" onclick="deleteAiSkill()"><i data-lucide="trash-2"></i> 删除</button>' : ''}</div>
      <label class="skills-field-label" for="aiSkillName">名称</label>
      <input id="aiSkillName" class="skills-input" maxlength="80" placeholder="例如：严谨核对事实" value="${aiSkillEscape(current?.name || '')}">
      <label class="skills-field-label" for="aiSkillContent">技能准则</label>
      <textarea id="aiSkillContent" class="skills-content" placeholder="写下 AI 处理这类任务时应遵循的准则…">${aiSkillEscape(current?.content || '')}</textarea>
      <div class="skills-save-row"><button type="button" class="skills-primary-btn" onclick="saveAiSkillEditor()"><i data-lucide="save"></i> 保存技能</button><span id="aiSkillStatus" role="status"></span></div>
      <div class="skills-generate-box"><h3><i data-lucide="wand-sparkles"></i> 让 AI 整理准则</h3><p>描述你希望 AI 如何处理某类事情。生成结果会放入上方编辑框，检查后再保存。</p>
        <textarea id="aiSkillIdea" placeholder="例如：回答医学问题时，先说明信息的适用范围，区分证据与推测，并提醒我何时该咨询医生。"></textarea>
        <button type="button" id="aiSkillGenerateBtn" class="skills-secondary-btn" onclick="generateAiSkill()">AI 整理为技能文字</button>
      </div>
    </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function saveAiSkillEditor() {
  const name = document.getElementById('aiSkillName')?.value.trim() || '';
  const content = document.getElementById('aiSkillContent')?.value.trim() || '';
  const status = document.getElementById('aiSkillStatus');
  if (!name || !content) { if (status) status.textContent = '请填写名称和准则'; return; }
  const skills = loadAiSkills();
  const now = new Date().toISOString();
  let item = activeAiSkillId ? skills.find(skill => skill.id === activeAiSkillId) : null;
  if (item) {
    item.name = name;
    item.content = content;
    item.updatedAt = now;
  } else {
    item = { id: aiSkillId(), name, content, createdAt: now, updatedAt: now };
    skills.push(item);
    activeAiSkillId = item.id;
  }
  try { saveAiSkills(skills); }
  catch (error) { if (status) status.textContent = '保存失败：' + error.message; return; }
  renderSkillsStudio();
  const savedStatus = document.getElementById('aiSkillStatus');
  if (savedStatus) savedStatus.textContent = '已保存';
  if (typeof renderAiContextPreview === 'function') renderAiContextPreview();
}

function deleteAiSkill() {
  const item = activeAiSkillId ? getAiSkill(activeAiSkillId) : null;
  if (!item || !confirm(`删除技能“${item.name}”？已发送的对话内容不会改变。`)) return;
  try { saveAiSkills(loadAiSkills().filter(skill => skill.id !== item.id)); }
  catch (error) { alert('删除失败：' + error.message); return; }
  activeAiSkillId = null;
  renderSkillsStudio();
  if (typeof renderAiContextPreview === 'function') renderAiContextPreview();
}

async function generateAiSkill() {
  const idea = document.getElementById('aiSkillIdea')?.value.trim() || '';
  const status = document.getElementById('aiSkillStatus');
  if (!idea) { if (status) status.textContent = '请先描述处理要求'; return; }
  const config = typeof getEffectiveApiConfig === 'function' ? { ...getEffectiveApiConfig() } : null;
  if (!config?.apiKey) { if (status) status.textContent = '请先在设置中配置 AI Key'; return; }
  const button = document.getElementById('aiSkillGenerateBtn');
  if (button) { button.disabled = true; button.textContent = '正在整理…'; }
  if (status) status.textContent = '';
  try {
    const name = document.getElementById('aiSkillName')?.value.trim() || '';
    const messages = [
      { role: 'system', content: '你是 AI 技能编辑。请根据用户描述，把某类行为或处理方式整理成一段可直接放进提示词的中文准则。只输出准则正文，不要标题、代码块、说明或引号。使用清晰的祈使句，保留用户提出的边界和条件，不添加无关要求。' },
      { role: 'user', content: (name ? `技能名称：${name}\n` : '') + `处理要求：${idea}` }
    ];
    const result = await callAiApiNonStream(messages, { ...config, deepThink: false, conversationSettings: {} }, null, { feature: 'skills', disableTools: true });
    const content = String(result.cleanText || '').replace(/^```(?:text|markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
    if (!content) throw new Error('AI 没有返回技能文字');
    const editor = document.getElementById('aiSkillContent');
    if (editor) editor.value = content;
    if (status) status.textContent = '已生成，请检查并保存';
  } catch (error) {
    if (status) status.textContent = '生成失败：' + (error.message || error);
  } finally {
    if (button) { button.disabled = false; button.textContent = 'AI 整理为技能文字'; }
  }
}

function openAiSkillPicker() {
  let overlay = document.getElementById('aiSkillPickerOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'aiSkillPickerOverlay';
    overlay.className = 'timer-picker-overlay';
    overlay.onclick = event => { if (event.target === overlay) closeAiSkillPicker(); };
    document.body.appendChild(overlay);
  }
  aiSkillPickerQuery = '';
  overlay.style.display = '';
  renderAiSkillPicker();
}

function closeAiSkillPicker() {
  const overlay = document.getElementById('aiSkillPickerOverlay');
  if (overlay) overlay.style.display = 'none';
}

function updateAiSkillPickerQuery(value) {
  aiSkillPickerQuery = String(value || '');
  renderAiSkillPicker();
}

function toggleAiSkillInsert(id) {
  const index = aiContextInserts.findIndex(item => item.type === 'skill' && item.id === id);
  if (index >= 0) aiContextInserts.splice(index, 1);
  else if (getAiSkill(id)) aiContextInserts.push({ type: 'skill', id });
  renderAiContextPreview();
  renderAiSkillPicker();
}

function renderAiSkillPicker() {
  const overlay = document.getElementById('aiSkillPickerOverlay');
  if (!overlay) return;
  const skills = loadAiSkills();
  const query = aiSkillPickerQuery.trim().toLowerCase();
  const matching = skills.map((item, index) => ({ item, index }))
    .filter(({ item }) => !query || (item.name + ' ' + item.content).toLowerCase().includes(query));
  overlay.innerHTML = `<div class="timer-picker ai-context-picker ai-skill-picker" role="dialog" aria-modal="true" aria-label="选择技能">
    <div class="todo-picker-header"><span><i data-lucide="sparkles"></i> 插入技能</span><button class="todo-picker-close" onclick="closeAiSkillPicker()" title="关闭"><i data-lucide="x"></i></button></div>
    <div class="todo-picker-search"><input placeholder="搜索技能…" value="${aiSkillEscape(aiSkillPickerQuery)}" oninput="updateAiSkillPickerQuery(this.value)" onkeydown="if(event.key==='Escape')closeAiSkillPicker()"></div>
    <div class="todo-picker-list">${matching.length ? matching.map(({ item, index }) => {
      const selected = aiContextInserts.some(insert => insert.type === 'skill' && insert.id === item.id);
      return `<button type="button" class="skills-picker-item${selected ? ' selected' : ''}" onclick="toggleAiSkillInsert(loadAiSkills()[${index}].id)" aria-pressed="${selected}"><span class="picker-check"></span><span><strong>${aiSkillEscape(item.name)}</strong><small>${aiSkillEscape(item.content.replace(/\s+/g, ' ').slice(0, 110))}</small></span></button>`;
    }).join('') : '<div class="todo-picker-empty">没有匹配的技能</div>'}</div>
    <div class="skills-picker-foot"><button type="button" class="skills-secondary-btn" onclick="closeAiSkillPicker();switchTab('skills')">管理技能</button><button type="button" class="skills-primary-btn" onclick="closeAiSkillPicker()">完成</button></div>
  </div>`;
  if (typeof lucide !== 'undefined') lucide.createIcons();
  const input = overlay.querySelector('input');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}
