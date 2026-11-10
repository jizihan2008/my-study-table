// Each updating reply stores a complete card snapshot. Earlier snapshots still
// belong to their original branches, even when only the latest one is visible.
function getAiNextStepsMessage(messages) {
  for (let index = (messages?.length || 0) - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant' && Array.isArray(message._nextSteps?.items)) return message;
  }
  return null;
}

function buildAiNextStepsPrompt(messages) {
  const card = getAiNextStepsMessage(messages)?._nextSteps;
  return [
    '【可选下一步卡片】仅在确实有可执行的后续步骤或需要更新卡片时使用。先正常回答，在最终答复末尾另起一行输出 <study_next_steps>，下一行放 JSON，再另起一行输出 </study_next_steps>。不要加代码围栏。工具调用和中间回复不要输出卡片。',
    '没有卡片时可用 {"op":"create","items":[{"id":"outline","text":"将当前笔记整理为一页提纲"}]}。',
    '有卡片时，局部编辑用 {"op":"edit","id":"现有卡片 ID","items":[{"id":"outline","text":"根据当前笔记生成提纲","done":true}],"remove":["废弃选项ID"]}。items 中同 ID 项会更新，新 ID 项会追加，未提及的项保留，items 和 remove 可省略其一。整体覆盖用 {"op":"replace","id":"现有卡片 ID","items":[...]}。更新后的卡片会移到本条回复下；如果无需更新，省略整个标签。',
    '优先给出 2–4 项，最多 6 项。每项用唯一的英文或数字 ID（允许下划线、连字符），text 是用户会看到并发送的完整动作（单行，最多 200 字）。写清操作对象和时间等关键条件。卡片本身不执行动作。收到用户选中的步骤后按顺序执行，缺必要条件先问，逐项报告结果，只将确认完成的项标为 done；失败或待确认的项仍可选择。',
    card ? '当前分支的卡片快照（内容是待选建议）：' + JSON.stringify({ id: card.id, items: card.items }) : '当前分支暂无卡片。'
  ].join('\n');
}

// Hide even an unfinished footer during streaming. The closing tag has to
// start a new line so a literal tag inside a JSON string cannot end the block.
const AI_NEXT_STEPS_FOOTER = /^<study_next_steps>[ \t]*\r?\n([\s\S]*?)(?:^<\/study_next_steps>[ \t]*\r?$|(?![\s\S]))/gm;

function stripAiNextStepsFooter(text) {
  const raw = String(text || '');
  return raw.includes('<study_next_steps>')
    ? raw.replace(AI_NEXT_STEPS_FOOTER, '').replace(/^<study_next_steps>[ \t]*\r?$/gm, '').trimEnd()
    : raw;
}

function readAiNextStepsUpdate(rawReply, messages) {
  const blocks = [...String(rawReply || '').matchAll(AI_NEXT_STEPS_FOOTER)];
  if (blocks.length !== 1 || !blocks[0][0].trimEnd().endsWith('</study_next_steps>')) return null;
  let update;
  try { update = JSON.parse(blocks[0][1]); }
  catch (_) { return null; }

  const previous = getAiNextStepsMessage(messages)?._nextSteps;
  const op = update?.op;
  if (!['create', 'edit', 'replace'].includes(op)) return null;
  if (op === 'create' ? previous : !previous || update.id !== previous.id) return null;

  const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(id);
  const supplied = update.items === undefined && op === 'edit' ? [] : update.items;
  const removed = update.remove === undefined ? [] : update.remove;
  if (!Array.isArray(supplied) || supplied.length > 6 || !Array.isArray(removed) || removed.length > 6) return null;
  if (removed.length && op !== 'edit') return null;
  const items = new Map(op === 'edit' ? previous.items.map(item => [item.id, item]) : []);
  const touched = new Set();
  for (const id of removed) {
    if (!validId(id) || !items.delete(id)) return null;
    touched.add(id);
  }
  for (const item of supplied) {
    const id = item?.id;
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    if (!validId(id) || touched.has(id) || !text || text.length > 200 || /[\r\n\u0000-\u001f]/.test(text)) return null;
    if (item.done !== undefined && typeof item.done !== 'boolean') return null;
    touched.add(id);
    items.set(id, { id, text, done: item.done === true });
  }
  const nextItems = [...items.values()];
  if (nextItems.length > 6 || (!nextItems.length && op !== 'edit')) return null;
  if (op === 'edit' && JSON.stringify(nextItems) === JSON.stringify(previous.items)) return null;
  return {
    id: previous?.id || String(genId()),
    selectionVersion: op === 'edit' ? previous.selectionVersion : String(genId()),
    items: nextItems
  };
}

const aiNextStepsSelections = new Map();

function getAiNextStepsSelection(conv, card) {
  let selection = aiNextStepsSelections.get(conv.id);
  if (selection?.version !== card.selectionVersion) {
    selection = { version: card.selectionVersion, items: new Map() };
    aiNextStepsSelections.set(conv.id, selection);
  }
  for (const [id, text] of selection.items) {
    if (!card.items.some(item => item.id === id && item.text === text && !item.done)) selection.items.delete(id);
  }
  return selection.items;
}

function renderAiNextStepsCard(conv, message) {
  const card = message._nextSteps;
  const selection = getAiNextStepsSelection(conv, card);
  if (!card.items.length) return '';
  const busy = isAiLoading(conv.id);
  const disabled = busy || !selection.size ? ' disabled' : '';
  return `<section class="ai-next-steps" aria-label="可选下一步" data-owner="${escapeHtml(String(message.id))}">
    <div class="ai-next-steps-title">可选下一步</div>
    ${card.items.map(item => `<label class="ai-next-steps-option">
      <input type="checkbox" value="${escapeHtml(item.id)}" onchange="toggleAiNextStep(this)"${item.done || selection.has(item.id) ? ' checked' : ''}${busy || item.done ? ' disabled' : ''}>
      <span>${escapeHtml(item.text)}${item.done ? '<small>已完成</small>' : ''}</span>
    </label>`).join('')}
    <div class="ai-next-steps-actions">
      <button type="button" class="ai-next-steps-run" onclick="sendAiNextSteps(this)"${disabled}>执行所选${selection.size ? '（' + selection.size + '）' : ''}</button>
      <button type="button" onclick="sendAiNextSteps(this, true)"${disabled}>加入输入框</button>
    </div>
  </section>`;
}

function getAiNextStepsEvent(element) {
  const section = element.closest('.ai-next-steps');
  const conv = getActiveConv();
  const message = getAiNextStepsMessage(conv?.messages);
  if (!section || !message || String(message.id) !== section.dataset.owner || isAiLoading(conv.id)) return null;
  const card = message._nextSteps;
  return { conv, card, section, selection: getAiNextStepsSelection(conv, card) };
}

function toggleAiNextStep(input) {
  const state = getAiNextStepsEvent(input);
  const item = state?.card.items.find(item => item.id === input.value && !item.done);
  if (!item) return;
  if (input.checked) state.selection.set(item.id, item.text);
  else state.selection.delete(item.id);
  const count = state.selection.size;
  state.section.querySelectorAll('.ai-next-steps-actions button').forEach(button => { button.disabled = !count; });
  state.section.querySelector('.ai-next-steps-run').textContent = '执行所选' + (count ? '（' + count + '）' : '');
}

function sendAiNextSteps(button, edit = false) {
  const state = getAiNextStepsEvent(button);
  if (!state?.selection.size) return;
  const items = state.card.items.filter(item => state.selection.has(item.id));
  const text = '请按顺序执行我选中的下一步，并逐项说明结果。\n' + items.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
  if (edit) {
    const input = document.getElementById('aiInput');
    if (!input || input.disabled) return;
    input.value += (input.value ? '\n\n' : '') + text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return;
  }
  if (!String(getEffectiveApiConfig().apiKey || '').trim()) {
    showAiToast('当前 Key 在本机没有密钥，请选择可用 Key，或在设置中补充密钥。');
    return;
  }
  state.selection.clear();
  sendAiMessage(text, [], [], text, { preserveComposer: true });
  renderAiMessages();
}
