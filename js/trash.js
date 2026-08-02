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
  try { localStorage.setItem(TRASH_KEYS[module], JSON.stringify(data)); } catch (e) { console.error('saveTrash error:', e); }
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
    saveData('study_todos_v2', todos);
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
    saveData('study_notes_v2', notes);
    renderNotes();
  } else if (module === 'links') {
    trash.unshift({ ...item, deletedAt: new Date().toISOString() });
    links = links.filter(l => l.id !== item.id);
    saveData('study_links_v3', links);
    renderLinks();
  } else if (module === 'habits') {
    trash.unshift({ ...item, deletedAt: new Date().toISOString() });
    habits = habits.filter(h => h.id !== item.id);
    if (typeof saveHabits === 'function') saveHabits();
    if (typeof renderHabits === 'function') renderHabits();
  }
  
  saveTrash(module, trash);
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
    archive.unshift({ ...item, archivedAt: new Date().toISOString() });
    notes = notes.filter(n => n.id !== item.id);
    if (activeNoteId === item.id) {
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

// ── 从回收站恢复 ──
function restoreFromTrash(module, id) {
  const trash = loadTrash(module);
  const idx = trash.findIndex(item => item.id === id);
  if (idx === -1) return;
  
  const restored = trash[idx];
  const { deletedAt, ...item } = restored;
  trash.splice(idx, 1);
  
  if (module === 'todos') {
    // Restore all items with the same deletedAt (children of the restored parent)
    if (restored.deletedAt) {
      const siblings = trash.filter(t => t.deletedAt === restored.deletedAt).map(t => {
        const { deletedAt: d, ...it } = t;
        return it;
      });
      todos.push(item, ...siblings);
      // Remove siblings from trash
      siblings.forEach(s => {
        const si = trash.findIndex(t => t.id === s.id);
        if (si >= 0) trash.splice(si, 1);
      });
    } else {
      todos.push(item);
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
    todos.push(item);
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
    
    // For todos, also remove children deleted at the same time
    if (module === 'todos') {
      const target = trash[currentIdx];
      if (target.deletedAt) {
        trash = trash.filter(t => t.deletedAt !== target.deletedAt);
      } else {
        trash.splice(currentIdx, 1);
      }
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
    currentArchive.splice(currentIdx, 1);
    saveArchive(module, currentArchive);
    
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

// ── 清空回收站 ──
function emptyTrash(module) {
  const totalCount = Object.values(TRASH_KEYS).reduce((sum, k) => {
    try { return sum + (JSON.parse(localStorage.getItem(k)) || []).length; } catch { return sum; }
  }, 0);
  if (totalCount === 0) return;
  if (typeof showCustomConfirm === 'function') {
    showCustomConfirm(`确定要永久清空回收站中的所有 ${totalCount} 项内容吗？此操作不可撤销！`).then(confirmed => {
      if (!confirmed) return;
      Object.keys(TRASH_KEYS).forEach(m => saveTrash(m, []));
      const activeSection = document.querySelector('.section.active');
      if (activeSection && activeSection.id === 'section-trash') renderTrash();
    });
  } else {
    if (confirm(`确定要永久清空回收站中的所有 ${totalCount} 项内容吗？此操作不可撤销！`)) {
      Object.keys(TRASH_KEYS).forEach(m => saveTrash(m, []));
      const activeSection = document.querySelector('.section.active');
      if (activeSection && activeSection.id === 'section-trash') renderTrash();
    }
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
    
    // Group by deletedAt for hierarchical todos
    const groups = {};
    if (module === 'todos') {
      trash.forEach(item => {
        const key = item.deletedAt || 'unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      });
    }
    
    html += `<div class="trash-module-section">
      <div class="trash-module-header">
        <span><i data-lucide="${MODULE_ICONS[module]}" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> ${MODULE_LABELS[module]}</span>
        <span class="trash-module-count">${trash.length} 项</span>
      </div>
      <div class="trash-items">`;
    
    if (module === 'todos') {
      // Render grouped todos
      Object.keys(groups).forEach(key => {
        const groupItems = groups[key];
        const parent = groupItems.find(i => !i.parentId || !groupItems.some(g => g.id === i.parentId));
        const mainItem = parent || groupItems[0];
        const childCount = groupItems.length > 1 ? groupItems.length - 1 : 0;
        const deletedDate = formatDate(new Date(groupItems[0].deletedAt));
        
        html += `<div class="trash-item">
          <div class="trash-item-info">
            <span class="trash-item-type-badge todo">待办</span>
            <span class="trash-item-name">${escapeHtml(mainItem.text ? mainItem.text.slice(0, 60) : mainItem.title || '（无标题）')}</span>
            ${childCount > 0 ? `<span class="trash-child-count">+${childCount} 子任务</span>` : ''}
            <span class="trash-item-date">删除于 ${deletedDate}</span>
          </div>
          <div class="trash-item-actions">
            <button onclick="restoreFromTrash('${module}', ${mainItem.id})" title="恢复" class="trash-action-btn restore"><i data-lucide="undo-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
            <button onclick="permanentlyDelete('${module}', ${mainItem.id})" title="永久删除" class="trash-action-btn perm-del"><i data-lucide="trash-2" class="lucide-icon" style="width:14px;height:14px;"></i></button>
          </div>
        </div>`;
      });
    } else if (module === 'notes') {
      trash.forEach(item => {
        const isFolder = item.type === 'folder';
        const deletedDate = formatDate(new Date(item.deletedAt));
        html += `<div class="trash-item">
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
    html = `<div class="empty-state">
      <i data-lucide="trash-2" class="lucide-icon" style="width:64px;height:64px;margin-bottom:12px;opacity:0.4;color:var(--text-secondary);display:block;margin-left:auto;margin-right:auto;"></i>
      <p>回收站是空的</p>
      <p style="font-size:12px;color:var(--text-secondary);">删除的内容会暂时存放在这里</p>
    </div>`;
  }
  
  container.innerHTML = html;
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
      archive.forEach(item => {
        const archivedDate = formatDate(new Date(item.archivedAt));
        html += `<div class="trash-item">
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
      archive.forEach(item => {
        const isFolder = item.type === 'folder';
        const archivedDate = formatDate(new Date(item.archivedAt));
        html += `<div class="trash-item">
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
