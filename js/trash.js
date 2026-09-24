// ═══════════ 回收站 & 归档管理器 ═══════════
// 为待办、笔记、快捷访问、习惯提供统一的回收站和归档功能

const TRASH_KEYS = {
  todos: 'study_todos_trash',
  notes: 'study_notes_trash',
  links: 'study_links_trash',
  habits: 'study_habits_trash'
};

const ARCHIVE_KEYS = {
  todos: 'study_todos_archive',
  notes: 'study_notes_archive',
  links: 'study_links_archive',
  habits: 'study_habits_archive'
};

const MODULE_LABELS = {
  todos: '待办',
  notes: '笔记',
  links: '快捷访问',
  habits: '习惯'
};

const MODULE_ICONS = {
  todos: 'check-square',
  notes: 'file-text',
  links: 'layout-grid',
  habits: 'target'
};

// ── 加载/保存 ──
function loadTrash(module) {
  try { return JSON.parse(localStorage.getItem(TRASH_KEYS[module])) || []; } catch { return []; }
}

function saveTrash(module, data) {
  try {
    const raw = JSON.stringify(data);
    localStorage.setItem(TRASH_KEYS[module], raw);
    return localStorage.getItem(TRASH_KEYS[module]) === raw;
  } catch (e) { console.error('saveTrash error:', e); return false; }
}

function loadArchive(module) {
  try { return JSON.parse(localStorage.getItem(ARCHIVE_KEYS[module])) || []; } catch { return []; }
}

function saveArchive(module, data) {
  try { localStorage.setItem(ARCHIVE_KEYS[module], JSON.stringify(data)); } catch (e) { console.error('saveArchive error:', e); }
}

// ── 移到回收站 ──
function moveToTrash(module, item) {
  const trash = loadTrash(module);
  const items = [];
  
  // Handle hierarchical deletions (todos with children)
  if (module === 'todos' && typeof getAllDescendantIds === 'function') {
    const descendantIds = getAllDescendantIds(item.id);
    const allIds = new Set([item.id, ...descendantIds]);
    const moved = todos.filter(t => allIds.has(t.id));
    moved.forEach(t => {
      trash.unshift({ ...t, deletedAt: new Date().toISOString() });
    });
    todos = todos.filter(t => !allIds.has(t.id));
    if (saveData('study_todos_v2', todos) !== true) return false;
    expandedTodoIds.delete(item.id);
    saveExpandedTodoIds();
  } else if (module === 'notes') {
    // For notes, preserve folder structure in trash
    if (item.type === 'folder') {
      // Move folder and all its descendants to trash
      const folderIds = new Set();
      function collectDescendantNoteIds(folderId) {
        folderIds.add(folderId);
        notes.filter(n => n.parentId === folderId).forEach(child => {
          if (child.type === 'folder') collectDescendantNoteIds(child.id);
          else folderIds.add(child.id);
        });
      }
      collectDescendantNoteIds(item.id);
      const moved = notes.filter(n => folderIds.has(n.id));
      moved.forEach(n => {
        trash.unshift({ ...n, deletedAt: new Date().toISOString() });
      });
      notes = notes.filter(n => !folderIds.has(n.id));
    } else {
      trash.unshift({ ...item, deletedAt: new Date().toISOString() });
      notes = notes.filter(n => n.id !== item.id);
    }
    if (activeNoteId === item.id || (item.type === 'folder' && activeNoteId && trash.find(t => t.id === activeNoteId))) {
      activeNoteId = (notes.find(n => n.type === 'note') || notes[0])?.id || null;
    }
    localStorage.setItem('study_active_note', activeNoteId);
    if (saveData('study_notes_v2', notes) !== true) return false;
    renderNotes();
  } else if (module === 'links') {
    trash.unshift({ ...item, deletedAt: new Date().toISOString() });
    links = links.filter(l => l.id !== item.id);
    if (saveData('study_links_v3', links) !== true) return false;
    renderLinks();
  } else if (module === 'habits') {
    trash.unshift({ ...item, deletedAt: new Date().toISOString() });
    habits = habits.filter(h => h.id !== item.id);
    if (typeof saveHabits === 'function') saveHabits();
    if (typeof renderHabits === 'function') renderHabits();
  }
  
  return saveTrash(module, trash);
}

// ── 移到归档 ──
function moveToArchive(module, item) {
  const archive = loadArchive(module);
  
  if (module === 'todos') {
    archive.unshift({ ...item, archivedAt: new Date().toISOString() });
    todos = todos.filter(t => t.id !== item.id);
    saveData('study_todos_v2', todos);
    expandedTodoIds.delete(item.id);
    saveExpandedTodoIds();
  } else if (module === 'notes') {
    const ids = item.type === 'folder'
      ? new Set(collectStoredDescendantIds(notes, item.id))
      : new Set([item.id]);
    const archivedAt = new Date().toISOString();
    notes.filter(n => ids.has(n.id)).forEach(n => archive.unshift({ ...n, archivedAt }));
    notes = notes.filter(n => !ids.has(n.id));
    if (ids.has(activeNoteId)) {
      activeNoteId = (notes.find(n => n.type === 'note') || notes[0])?.id || null;
    }
    localStorage.setItem('study_active_note', activeNoteId);
    saveData('study_notes_v2', notes);
    renderNotes();
  } else if (module === 'links') {
    archive.unshift({ ...item, archivedAt: new Date().toISOString() });
    links = links.filter(l => l.id !== item.id);
    saveData('study_links_v3', links);
    renderLinks();
  } else if (module === 'habits') {
    archive.unshift({ ...item, archivedAt: new Date().toISOString() });
    habits = habits.filter(h => h.id !== item.id);
    if (typeof saveHabits === 'function') saveHabits();
    if (typeof renderHabits === 'function') renderHabits();
  }
  
  saveArchive(module, archive);
}

function collectStoredDescendantIds(items, id) {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    items.forEach(item => {
      if (!ids.has(item.id) && ids.has(item.parentId)) {
        ids.add(item.id);
        changed = true;
      }
    });
  }
  return [...ids];
}

function orderedStoredTree(items) {
  const byId = new Map(items.map(item => [item.id, item]));
  const children = new Map();
  items.forEach(item => {
    const parent = item.parentId !== item.id && byId.has(item.parentId) ? item.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  });
  const result = [];
  const seen = new Set();
  function visit(item, depth) {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    result.push({ item, depth });
    (children.get(item.id) || []).forEach(child => visit(child, depth + 1));
  }
  (children.get(null) || []).forEach(item => visit(item, 0));
  items.forEach(item => visit(item, 0)); // Legacy data may contain cycles.
  return result;
}

// ── 从回收站恢复 ──
function restoreFromTrash(module, id) {
  const trash = loadTrash(module);
  const idx = trash.findIndex(item => item.id === id);
  if (idx === -1) return;
  
  const restored = trash[idx];
  const { deletedAt, ...item } = restored;
  trash.splice(idx, 1);
  
  if (module === 'todos') {
    const descendants = new Set(collectStoredDescendantIds(trash, id));
    todos.push(item);
    for (let i = trash.length - 1; i >= 0; i--) {
      if (descendants.has(trash[i].id)) {
        const { deletedAt: _, ...child } = trash[i];
        todos.push(child);
        trash.splice(i, 1);
      }
    }
    saveData('study_todos_v2', todos);
    if (typeof renderTodos === 'function') renderTodos();
  } else if (module === 'notes') {
    notes.push(item);
    // Also restore ALL descendants (recursively) if the item is a folder
    if (item.type === 'folder') {
      const restoreTree = (pid) => {
        for (let i = 0; i < trash.length; i++) {
          if (trash[i].parentId === pid && trash[i].id !== pid) {
            const { deletedAt: d2, ...childItem } = trash[i];
            notes.push(childItem);
            trash.splice(i, 1);
            i--;
            restoreTree(childItem.id); // 递归恢复孙级及更深层级
          }
        }
      };
      restoreTree(id);
    }
    saveData('study_notes_v2', notes);
    renderNotes();
  } else if (module === 'links') {
    links.push(item);
    saveData('study_links_v3', links);
    renderLinks();
  } else if (module === 'habits') {
    habits.push(item);
    if (typeof saveHabits === 'function') saveHabits();
    if (typeof renderHabits === 'function') renderHabits();
  }
  
  saveTrash(module, trash);
  renderTrash();
}

// ── 从归档恢复 ──
function restoreFromArchive(module, id) {
  const archive = loadArchive(module);
  const idx = archive.findIndex(item => item.id === id);
  if (idx === -1) return;
  
  const restored = archive[idx];
  const { archivedAt, ...item } = restored;
  archive.splice(idx, 1);
  
  if (module === 'todos') {
    const descendants = new Set(collectStoredDescendantIds(archive, id));
    todos.push(item);
    for (let i = archive.length - 1; i >= 0; i--) {
      if (descendants.has(archive[i].id)) {
        const { archivedAt: _, ...child } = archive[i];
        todos.push(child);
        archive.splice(i, 1);
      }
    }
    saveData('study_todos_v2', todos);
    if (typeof renderTodos === 'function') renderTodos();
  } else if (module === 'notes') {
    notes.push(item);
    // Also restore ALL descendants (recursively) if the item is a folder
    if (item.type === 'folder') {
      const restoreTree = (pid) => {
        for (let i = 0; i < archive.length; i++) {
          if (archive[i].parentId === pid && archive[i].id !== pid) {
            const { archivedAt: a2, ...childItem } = archive[i];
            notes.push(childItem);
            archive.splice(i, 1);
            i--;
            restoreTree(childItem.id); // 递归恢复孙级及更深层级
          }
        }
      };
      restoreTree(id);
    }
    saveData('study_notes_v2', notes);
    renderNotes();
  } else if (module === 'links') {
    links.push(item);
    saveData('study_links_v3', links);
    renderLinks();
  } else if (module === 'habits') {
    habits.push(item);
    if (typeof saveHabits === 'function') saveHabits();
    if (typeof renderHabits === 'function') renderHabits();
  }
  
  saveArchive(module, archive);
  renderArchive();
}

// ── 从回收站永久删除 ──
function permanentlyDelete(module, id) {
  let trash = loadTrash(module);
  const idx = trash.findIndex(item => item.id === id);
  if (idx === -1) return;

  const name = trash[idx].text || trash[idx].title || trash[idx].name || '此项';

  const doDelete = () => {
    trash = loadTrash(module); // re-read in case it changed
    const currentIdx = trash.findIndex(item => item.id === id);
    if (currentIdx === -1) return;
    
    if (module === 'todos' || module === 'notes') {
      const ids = new Set(collectStoredDescendantIds(trash, id));
      trash = trash.filter(t => !ids.has(t.id));
    } else {
      trash.splice(currentIdx, 1);
    }
    saveTrash(module, trash);
    
    const activeSection = document.querySelector('.section.active');
    if (activeSection && activeSection.id === 'section-trash') renderTrash();
  };

  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(`确定要永久删除「${escapeHtml(String(name).slice(0, 40))}」吗？此操作不可撤销！`).then(confirmed => {
      if (confirmed) doDelete();
    });
  } else {
    if (confirm(`确定要永久删除该项吗？此操作不可撤销！`)) doDelete();
  }
}

// ── 从归档永久删除 ──
function permanentlyDeleteFromArchive(module, id) {
  const archive = loadArchive(module);
  const idx = archive.findIndex(item => item.id === id);
  if (idx === -1) return;
  const name = archive[idx].text || archive[idx].title || archive[idx].name || '此项';

  const doDelete = () => {
    const currentArchive = loadArchive(module);
    const currentIdx = currentArchive.findIndex(item => item.id === id);
    if (currentIdx === -1) return;
    const ids = module === 'todos' || module === 'notes'
      ? new Set(collectStoredDescendantIds(currentArchive, id)) : new Set([id]);
    saveArchive(module, currentArchive.filter(item => !ids.has(item.id)));
    
    const activeSection = document.querySelector('.section.active');
    if (activeSection && activeSection.id === 'section-archive') renderArchive();
  };

  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(`确定要永久删除「${escapeHtml(String(name).slice(0, 40))}」吗？此操作不可撤销！`).then(confirmed => {
      if (confirmed) doDelete();
    });
  } else {
    if (confirm(`确定要永久删除该项吗？此操作不可撤销！`)) doDelete();
  }
}

// ── 清空回收站（含扩展回收站） ──
function emptyTrash(module) {
  const totalCount = Object.values(TRASH_KEYS).reduce((sum, k) => {
    try { return sum + (JSON.parse(localStorage.getItem(k)) || []).length; } catch { return sum; }
  }, 0);
  const confirmMsg = totalCount > 0
    ? `确定要永久清空回收站中的所有 ${totalCount} 项内容吗？此操作不可撤销！`
    : '确定要永久清空回收站吗？此操作不可撤销！';
  const doEmpty = () => {
    Object.keys(TRASH_KEYS).forEach(m => saveTrash(m, []));
    // 一并清空扩展回收站（文件系统目录）
    if (window.ExtensionRepository && window.ExtensionRepository.trashEmpty) {
      window.ExtensionRepository.trashEmpty().catch(() => {});
    }
    const activeSection = document.querySelector('.section.active');
    if (activeSection && activeSection.id === 'section-trash') renderTrash();
  };
  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(confirmMsg).then(confirmed => { if (confirmed) doEmpty(); });
  } else {
    if (confirm(confirmMsg)) doEmpty();
  }
}

// ── 渲染回收站视图 ──
function renderTrash() {
  const container = document.getElementById('trashContainer');
  if (!container) return;
  
  const allModules = ['todos', 'notes', 'links', 'habits'];
  let totalItems = 0;
  let html = '';
  
  allModules.forEach(module => {
    const trash = loadTrash(module);
    if (trash.length === 0) return;
    totalItems += trash.length;
    
    html += `<div class="trash-module-section">
      <div class="trash-module-header">
        <span><i data-lucide="${MODULE_ICONS[module]}" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> ${MODULE_LABELS[module]}</span>
        <span class="trash-module-count">${trash.length} 项</span>
      </div>
      <div class="trash-items">`;
    
    if (module === 'todos') {
      orderedStoredTree(trash).forEach(({ item, depth }) => {
        const deletedDate = formatDate(new Date(item.deletedAt));
        html += `<div class="trash-item" style="--tree-depth:${depth}">
          <div class="trash-item-info">
            <span class="trash-item-type-badge todo">待办</span>
            <span class="trash-item-name">${escapeHtml(item.text ? item.text.slice(0, 60) : item.title || '（无标题）')}</span>
            <span class="trash-item-date">删除于 ${deletedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromTrash('${module}', ${item.id})" title="恢复" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDelete('${module}', ${item.id})" title="永久删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'notes') {
      orderedStoredTree(trash).forEach(({ item, depth }) => {
        const isFolder = item.type === 'folder';
        const deletedDate = formatDate(new Date(item.deletedAt));
        html += `<div class="trash-item" style="--tree-depth:${depth}">
          <div class="trash-item-info">
            <span class="trash-item-type-badge note">${isFolder ? '文件夹' : '笔记'}</span>
            <span class="trash-item-name">${escapeHtml(item.title || '（无标题）')}</span>
            <span class="trash-item-date">删除于 ${deletedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromTrash('${module}', ${item.id})" title="恢复" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDelete('${module}', ${item.id})" title="永久删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'links') {
      trash.forEach(item => {
        const deletedDate = formatDate(new Date(item.deletedAt));
        html += `<div class="trash-item">
          <div class="trash-item-info">
            <span class="trash-item-type-badge link">${item.type === 'app' ? '应用' : '链接'}</span>
            <span class="trash-item-name">${escapeHtml(item.name)}</span>
            <span class="trash-item-date">删除于 ${deletedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromTrash('${module}', ${item.id})" title="恢复" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDelete('${module}', ${item.id})" title="永久删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'habits') {
      trash.forEach(item => {
        const deletedDate = formatDate(new Date(item.deletedAt));
        html += `<div class="trash-item">
          <div class="trash-item-info">
            <span class="trash-item-type-badge habit">习惯</span>
            <span class="trash-item-name">${escapeHtml(item.name)}</span>
            <span class="trash-item-date">删除于 ${deletedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromTrash('${module}', ${item.id})" title="恢复" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDelete('${module}', ${item.id})" title="永久删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    }
    
    html += `</div></div>`;
  });
  
  if (totalItems === 0) {
    html = `<div class="empty-state" id="trashEmptyState">
      <i data-lucide="trash-2" class="lucide-icon" style="width:64px;height:64px;margin-bottom:12px;opacity:0.4;color:var(--text-secondary);display:block;margin-left:auto;margin-right:auto;"></i>
      <p>回收站是空的</p>
      <p style="font-size:12px;color:var(--text-secondary);">删除的内容会暂时存放在这里</p>
    </div>`;
  }
  
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);

  // 扩展回收站（文件系统扩展目录，异步 IPC 加载后并入同一视图）
  renderTrashExtensions();
}

// 渲染「扩展」回收站区块（并入现有回收站视图）
async function renderTrashExtensions() {
  const container = document.getElementById('trashContainer');
  if (!container) return;
  let trashedExts = [];
  try {
    if (window.ExtensionRepository && window.ExtensionRepository.trashList) {
      trashedExts = await window.ExtensionRepository.trashList();
    }
  } catch (e) { /* 失败不阻塞 */ }

  // 移除旧区块（避免重复）
  const old = document.getElementById('trashExtensionsSection');
  if (old) old.remove();

  if (trashedExts.length === 0) return;

  // 若当前是空态，先移除空态
  const empty = document.getElementById('trashEmptyState');
  if (empty) empty.remove();

  const html = `<div class="trash-module-section" id="trashExtensionsSection">
    <div class="trash-module-header">
      <span><i data-lucide="puzzle" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 扩展</span>
      <span class="trash-module-count">${trashedExts.length} 项</span>
    </div>
    <div class="trash-items">
      ${trashedExts.map(t => {
        const m = t.manifest || { name: t.id, version: '?', description: '' };
        const delTime = t.deletedAt ? '删除于 ' + formatDate(new Date(t.deletedAt)) : '';
        return `<div class="trash-item">
          <div class="trash-item-info">
            <span class="trash-item-type-badge ext">扩展</span>
            <span class="trash-item-name">${escapeHtml(m.name || t.id)}</span>
            <span class="trash-item-date">${delTime}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreTrashedExt('${escapeHtml(t.trashDir)}')" title="恢复" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="purgeTrashedExt('${escapeHtml(t.trashDir)}')" title="永久删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
  container.insertAdjacentHTML('beforeend', html);
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

// ── 渲染归档视图 ──
function renderArchive() {
  const container = document.getElementById('archiveContainer');
  if (!container) return;
  
  const allModules = ['todos', 'notes', 'links', 'habits'];
  let totalItems = 0;
  let html = '';
  
  allModules.forEach(module => {
    const archive = loadArchive(module);
    if (archive.length === 0) return;
    totalItems += archive.length;
    
    html += `<div class="trash-module-section">
      <div class="trash-module-header">
        <span><i data-lucide="${MODULE_ICONS[module]}" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> ${MODULE_LABELS[module]}</span>
        <span class="trash-module-count">${archive.length} 项</span>
      </div>
      <div class="trash-items">`;
    
    if (module === 'todos') {
      orderedStoredTree(archive).forEach(({ item, depth }) => {
        const archivedDate = formatDate(new Date(item.archivedAt));
        html += `<div class="trash-item" style="--tree-depth:${depth}">
          <div class="trash-item-info">
            <span class="trash-item-type-badge todo">待办</span>
            <span class="trash-item-name">${escapeHtml(item.text ? item.text.slice(0, 60) : item.title || '（无标题）')}</span>
            <span class="trash-item-date">归档于 ${archivedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromArchive('${module}', ${item.id})" title="取消归档" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDeleteFromArchive('${module}', ${item.id})" title="删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'notes') {
      orderedStoredTree(archive).forEach(({ item, depth }) => {
        const isFolder = item.type === 'folder';
        const archivedDate = formatDate(new Date(item.archivedAt));
        html += `<div class="trash-item" style="--tree-depth:${depth}">
          <div class="trash-item-info">
            <span class="trash-item-type-badge note">${isFolder ? '文件夹' : '笔记'}</span>
            <span class="trash-item-name">${escapeHtml(item.title || '（无标题）')}</span>
            <span class="trash-item-date">归档于 ${archivedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromArchive('${module}', ${item.id})" title="取消归档" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDeleteFromArchive('${module}', ${item.id})" title="删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'links') {
      archive.forEach(item => {
        const archivedDate = formatDate(new Date(item.archivedAt));
        html += `<div class="trash-item">
          <div class="trash-item-info">
            <span class="trash-item-type-badge link">${item.type === 'app' ? '应用' : '链接'}</span>
            <span class="trash-item-name">${escapeHtml(item.name)}</span>
            <span class="trash-item-date">归档于 ${archivedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromArchive('${module}', ${item.id})" title="取消归档" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDeleteFromArchive('${module}', ${item.id})" title="删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'habits') {
      archive.forEach(item => {
        const archivedDate = formatDate(new Date(item.archivedAt));
        html += `<div class="trash-item">
          <div class="trash-item-info">
            <span class="trash-item-type-badge habit">习惯</span>
            <span class="trash-item-name">${escapeHtml(item.name)}</span>
            <span class="trash-item-date">归档于 ${archivedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromArchive('${module}', ${item.id})" title="取消归档" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDeleteFromArchive('${module}', ${item.id})" title="删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    }
    
    html += `</div></div>`;
  });
  
  if (totalItems === 0) {
    html = `<div class="empty-state">
      <i data-lucide="archive" class="lucide-icon" style="width:64px;height:64px;margin-bottom:12px;opacity:0.4;color:var(--text-secondary);display:block;margin-left:auto;margin-right:auto;"></i>
      <p>归档是空的</p>
      <p style="font-size:12px;color:var(--text-secondary);">归档的内容会保存在这里供你回顾</p>
    </div>`;
  }
  
  container.innerHTML = html;
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}
