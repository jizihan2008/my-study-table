// ═══════════ Notes: Data (unified with folders, like todos) ═══════════
// v=20260724-r11: align header buttons, summary text label, context menu entries
// notes array now stores BOTH notes and folders.
// Each item: { id, type: 'note'|'folder', parentId, title, ... }
// Folders use `title` as folder name (same field).
// For backward compat: notes is the single source of truth.

// Migration: merge old notesFolders into notes
(function migrateNoteData() {
  const oldFolders = loadData('study_notes_folders');
  if (oldFolders && Array.isArray(oldFolders) && oldFolders.length > 0) {
    for (const f of oldFolders) {
      if (!notes.some(n => n.id === f.id)) {
        notes.push({ id: f.id, type: 'folder', parentId: f.parentId || null, title: f.name, summary: '', _summaryFresh: true });
      }
    }
    // Convert folderId -> parentId on notes
    for (const n of notes) {
      if (n.type !== 'folder' && n.folderId !== undefined) {
        n.parentId = n.folderId;
        delete n.folderId;
      }
    }
    localStorage.removeItem('study_notes_folders');
    saveData('study_notes_v2', notes);
  }
  // Ensure all items have required fields
  for (const n of notes) {
    if (!n.type) n.type = 'note';
    if (n.parentId === undefined) n.parentId = null;
    if (n._summaryFresh === undefined) n._summaryFresh = false;
    if (n.type === 'note' && !n._reviewHistory) n._reviewHistory = [];
    if (n.type === 'note' && n._skipReview === undefined) n._skipReview = false;
    if (n.type === 'note' && !Array.isArray(n.tags)) n.tags = [];
    if (n.type === 'note' && !Array.isArray(n._annotations)) n._annotations = [];
  }
})();

// Computed
function getNoteFolders() { return notes.filter(n => n.type === 'folder'); }
function getNoteItems() { return notes.filter(n => n.type === 'note'); }

function getActiveNote() {
  if (!activeNoteId) return null;
  return notes.find(n => n.id === activeNoteId && n.type === 'note') || null;
}

function findNoteItem(id) { return notes.find(n => n.id === id); }
function getNoteItemChildren(parentId) { return notes.filter(n => n.parentId === parentId); }

function createNewNote(parentId) {
  const newNote = { id: genId(), type: 'note', title: '', content: '', summary: '', _summaryFresh: false, parentId: parentId || null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), _reviewHistory: [], _skipReview: false, tags: [] };
  notes.push(newNote);
  activeNoteId = newNote.id;
  localStorage.setItem('study_active_note', activeNoteId);
  saveData('study_notes_v2', notes);
  renderNotes();
  setTimeout(() => document.getElementById('noteTitleInput').focus(), 100);
}

function createNoteFolder(name, parentId) {
  if (!name || !name.trim()) return null;
  const folder = { id: genId(), type: 'folder', title: name.trim(), parentId: parentId || null, summary: '', _summaryFresh: true };
  notes.push(folder);
  saveData('study_notes_v2', notes);
  renderNoteList();
  return folder;
}

function deleteNote(id, e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const item = findNoteItem(id);
  if (!item) return;
  if (notes.filter(n => n.type === 'note').length <= 1 && item.type === 'note') {
    // Don't delete the last note, just clear it
    item.title = ''; item.content = ''; item.summary = ''; item._summaryFresh = false;
    activeNoteId = item.id;
    saveData('study_notes_v2', notes);
    renderNotes();
    return;
  }
  // Soft delete: move to trash
  if (typeof moveToTrash === 'function') { moveToTrash('notes', item); }
}

function archiveNote(id) {
  const item = findNoteItem(id);
  if (!item) return;
  const label = item.type === 'folder' ? '文件夹' : '笔记';
  showCustomConfirm(`确定要归档此${label}吗？<br><small>归档后可从归档页面查看和恢复。</small>`).then(confirmed => {
    if (!confirmed) return;
    if (typeof moveToArchive === 'function') { moveToArchive('notes', item); }
  });
}

function deleteNoteFolder(id) {
  showCustomConfirm('确定删除此文件夹？文件夹内的内容将一起移到回收站中。', { dontAskKey: 'study_dontask_delete_folder' }).then(confirmed=>{
    if(confirmed)deleteNote(id, null);
  });
}

function confirmDeleteNote(id, e) {
  if (e && e.stopPropagation) e.stopPropagation();
  showCustomConfirm('确定删除这条笔记？删除后可在回收站中恢复。').then(confirmed => {
    if (confirmed) deleteNote(id, null);
  });
}

// ── 笔记移动端两级导航（目录 → 正文），类似教材界面 ──
let notesMobileView = 'toc';   // 'toc' | 'main'
function notesIsMobile() {
  return (typeof Env !== 'undefined' && Env.isMobile) ||
    (typeof window !== 'undefined' && window.innerWidth <= 800);
}
function notesApplyMobileView() {
  const sec = document.getElementById('section-notes');
  if (!sec) return;
  if (notesIsMobile()) sec.dataset.notesview = notesMobileView || 'toc';
  else delete sec.dataset.notesview;
}
function notesGoToc() { if (!notesIsMobile()) return; notesMobileView = 'toc'; notesApplyMobileView(); }
function notesGoMain() { if (!notesIsMobile()) return; notesMobileView = 'main'; notesApplyMobileView(); }

// 移动端右下角视图切换菜单（预览/编辑/摘要）
function toggleNotesMobileViewMenu() {
  const menu = document.getElementById('notesMvMenu');
  if (!menu) return;
  const show = menu.style.display !== 'block';
  menu.style.display = show ? 'block' : 'none';
  // 标记菜单里当前激活的视图
  if (show) {
    const btns = menu.querySelectorAll('button');
    const active = ['preview', 'edit', 'summary'].indexOf(noteViewMode);
    btns.forEach(function(b, i) { b.classList.toggle('active', i === active); });
  }
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}
function hideNotesMobileViewMenu() {
  const menu = document.getElementById('notesMvMenu');
  if (menu) menu.style.display = 'none';
}
// 点击浮层外关闭菜单
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('notesMobileViews');
  const menu = document.getElementById('notesMvMenu');
  if (wrap && menu && menu.style.display === 'block' && !wrap.contains(e.target)) menu.style.display = 'none';
});

function selectNote(id) {
  checkAndUpdateSummary();
  activeNoteId = id;
  localStorage.setItem('study_active_note', activeNoteId);
  if (notesIsMobile()) notesMobileView = 'main';   // 移动端选中笔记 → 进入正文页
  renderNotes();
  renderNotesTagInput();
  applyTagFilterBar();
}

function onNoteTitleChange() {
  const note = getActiveNote();
  if (!note) return;
  const titleInput = document.getElementById('noteTitleInput');
  note.title = titleInput.value;
  note.updatedAt = new Date().toISOString();
  updateLastEditedDisplay(note);
  if (!note._dirtyTitle) {
    pushNotesUndo(note.id, note.content, note.title);
    note._dirtyTitle = true;
    notesRedoStack = [];
  }
  if (notesDebounceId) clearTimeout(notesDebounceId);
  notesDebounceId = setTimeout(() => {
    note._summaryFresh = false;
    saveData('study_notes_v2', notes);
    note._dirtyTitle = false;
    renderNoteList();
  }, 400);
}

function onNotesChange() {
  const note = getActiveNote();
  if (!note) return;
  const textarea = document.getElementById('notesTextarea');
  if (!textarea) return;
  note.content = textarea.value;
  note.updatedAt = new Date().toISOString();
  const chars = note.content.replace(/\s/g, '').length;
  document.getElementById('notesWordCount').textContent = chars + ' 字';
  document.getElementById('notesStatus').textContent = '保存中…';
  updateLastEditedDisplay(note);
  if (!note._dirtyContent) {
    pushNotesUndo(note.id, note.content, note.title);
    note._dirtyContent = true;
    notesRedoStack = [];
  }
  if (notesDebounceId) clearTimeout(notesDebounceId);
  notesDebounceId = setTimeout(() => {
    note._summaryFresh = false;
    // 编辑笔记不再重置复习周期（改为右键菜单手动「重置复习周期」）
    saveData('study_notes_v2', notes);
    document.getElementById('notesStatus').textContent = '已保存';
    note._dirtyContent = false;
    renderNoteList();
  }, 500);
}

function updateLastEditedDisplay(note) {
  const el = document.getElementById('notesLastEdited');
  if (!el || !note) return;
  const d = new Date(note.updatedAt);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) el.textContent = '刚刚编辑';
  else if (diffMin < 60) el.textContent = diffMin + '分钟前';
  else if (diffMin < 1440) el.textContent = Math.floor(diffMin / 60) + '小时前';
  else el.textContent = d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function pushNotesUndo(noteId, content, title) {
  notesUndoStack.push({ noteId, content, title, timestamp: Date.now() });
  if (notesUndoStack.length > 50) notesUndoStack.shift();
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('notesUndoBtn');
  const redoBtn = document.getElementById('notesRedoBtn');
  if (undoBtn) undoBtn.disabled = notesUndoStack.length === 0;
  if (redoBtn) redoBtn.disabled = notesRedoStack.length === 0;
}

function undoNote() {
  if (notesUndoStack.length === 0) return;
  if (noteViewMode === 'preview') switchNoteView('edit');
  const snapshot = notesUndoStack.pop();
  const note = notes.find(n => n.id === snapshot.noteId);
  if (!note) { updateUndoRedoButtons(); return; }
  notesRedoStack.push({ noteId: note.id, content: note.content, title: note.title, timestamp: Date.now() });
  note.content = snapshot.content;
  note.title = snapshot.title;
  note.updatedAt = new Date().toISOString();
  note._dirtyTitle = false;
  note._dirtyContent = false;
  saveData('study_notes_v2', notes);
  const textarea = document.getElementById('notesTextarea');
  const titleInput = document.getElementById('noteTitleInput');
  if (textarea) textarea.value = note.content;
  if (titleInput) titleInput.value = note.title;
  document.getElementById('notesStatus').textContent = '已撤销';
  updateLastEditedDisplay(note);
  const chars = (note.content || '').replace(/\s/g, '').length;
  document.getElementById('notesWordCount').textContent = chars + ' 字';
  updateUndoRedoButtons();
  renderNoteList();
}

function redoNote() {
  if (notesRedoStack.length === 0) return;
  if (noteViewMode === 'preview') switchNoteView('edit');
  const snapshot = notesRedoStack.pop();
  const note = notes.find(n => n.id === snapshot.noteId);
  if (!note) { updateUndoRedoButtons(); return; }
  notesUndoStack.push({ noteId: note.id, content: note.content, title: note.title, timestamp: Date.now() });
  note.content = snapshot.content;
  note.title = snapshot.title;
  note.updatedAt = new Date().toISOString();
  note._dirtyTitle = false;
  note._dirtyContent = false;
  saveData('study_notes_v2', notes);
  const textarea = document.getElementById('notesTextarea');
  const titleInput = document.getElementById('noteTitleInput');
  if (textarea) textarea.value = note.content;
  if (titleInput) titleInput.value = note.title;
  document.getElementById('notesStatus').textContent = '已恢复';
  updateLastEditedDisplay(note);
  const chars = (note.content || '').replace(/\s/g, '').length;
  document.getElementById('notesWordCount').textContent = chars + ' 字';
  updateUndoRedoButtons();
  renderNoteList();
}

// ═══════════ Notes: Rendering ═══════════
// Detect and repair circular folder references in the notes tree
function repairCircularFolderRefs() {
  const folders = notes.filter(n => n.type === 'folder');
  for (const f of folders) {
    // Check if folder's parentId points to itself
    if (f.parentId === f.id) {
      console.warn('[repair] 修复自引用文件夹:', f.title, f.id);
      f.parentId = null;
    }
  }
  // Detect cycles by tracing parent chains
  for (const f of folders) {
    const seen = new Set();
    let current = f;
    while (current.parentId !== null && current.parentId !== undefined) {
      if (seen.has(current.id)) {
        // Cycle detected! Break it by setting parent to null
        console.warn('[repair] 检测到文件夹循环引用:', f.title, f.id, '→ 断开');
        f.parentId = null;
        break;
      }
      seen.add(current.id);
      current = notes.find(n => n.id === current.parentId);
      if (!current) break; // parent no longer exists
    }
  }
}

function renderNoteList() {
  const list = document.getElementById('notesList');
  if (!list) return;
  
  // First, detect and repair circular folder references
  repairCircularFolderRefs();

  // Collect note IDs matching the active tag filter
  const tagFilterMatchIds = notesTagFilter
    ? new Set(notes.filter(n => n.type==='note' && Array.isArray(n.tags) && n.tags.includes(notesTagFilter)).map(n=>n.id))
    : null;

  function renderItem(item, depth, visited) {
    if (depth > 50) return ''; // Safety: prevent infinite recursion
    visited = visited || new Set();
    if (visited.has(item.id)) return ''; // Circular reference detected
    visited.add(item.id);
    if (item.type === 'folder') {
      const children = getNoteItemChildren(item.id);
      const expandId = 'ns-exp-' + item.id;
      const isRenaming = item.id === renamingFolderId;
      const nameHtml = isRenaming
        ? `<input class="ns-rename-input" type="text" value="${escapeHtml(item.title||'')}"
             onkeydown="event.stopPropagation();if(event.key==='Enter')commitFolderRename(${item.id},this);else if(event.key==='Escape')cancelFolderRename()"
             onblur="commitFolderRename(${item.id},this)"
             onclick="event.stopPropagation()"
             data-folder-id="${item.id}">`
        : `<span class="ns-name">📁 ${escapeHtml(item.title||'')}</span>`;
      return `<li class="ns-folder" draggable="true" data-item-id="${item.id}" style="padding-left:${depth*16+4}px">
        <div class="ns-folder-header" onclick="toggleNoteFolder('${expandId}')">
          <span class="ns-toggle">${children.length>0?'▾':'▸'}</span>
          ${nameHtml}
        </div>
        <ul class="ns-children" id="${expandId}" style="display:${depth<2?'block':'none'}">${children.map(c=>renderItem(c,depth+1,visited)).join('')}</ul>
      </li>`;
    } else {
      // Apply tag filter
      if (tagFilterMatchIds && !tagFilterMatchIds.has(item.id)) return '';

      // Review status badge
      let reviewBadge = '';
      if (item._skipReview) {
        reviewBadge = '<span class="ns-review-badge skipped" title="已跳过复习">跳过</span>';
      } else if (item.content && item.content.trim()) {
        const nextDate = calcNextReviewDate(item);
        const dueDays = daysBetweenDateStr(getTodayStr(), toLocalDateStr(nextDate));
        if (dueDays <= 0) {
          reviewBadge = '<span class="ns-review-badge due" title="待复习">复习</span>';
        } else if (dueDays <= 2) {
          reviewBadge = '<span class="ns-review-badge soon" title="即将需要复习">' + dueDays + '天</span>';
        }
      }
      // Tags
      const tagsHtml = (item.tags&&item.tags.length>0)
        ? item.tags.map(t=>`<span class="ns-tag" data-tag="${encodeURIComponent(t)}" onclick="event.stopPropagation();selectTagFromCard(this)" title="筛选此标签">${escapeHtml(t)}</span>`).join('')
        : '';
      // Summary line (only if enabled globally)
      const summaryText = item.summary||'';
      const summaryHtml = (notesSummaryVisible && summaryText)
        ? `<div class="ns-note-summary">${escapeHtml(summaryText)}</div>`
        : '';
      return `<li class="ns-note${item.id===activeNoteId?' active':''}" draggable="true" data-item-id="${item.id}" onclick="selectNote(${item.id})" style="padding-left:${depth*16+12}px">
        <div class="ns-note-top">
          <span class="ns-note-title">${escapeHtml(item.title||'')||'未命名笔记'}</span>
          ${tagsHtml}
          ${reviewBadge}
        </div>
        ${summaryHtml}
      </li>`;
    }
  }
  
  const rootItems = notes.filter(n => !n.parentId);
  
  // Build tag filter bar HTML
  let filterBarHtml = '';
  if (notesTagFilter) {
    filterBarHtml = `<div class="ns-tag-filter-bar" id="notesTagFilterBar">
      <span class="ns-tag-filter-label">标签筛选：</span>
      <span class="ns-tag ns-tag-filter-active">${escapeHtml(notesTagFilter)}</span>
      <span class="ns-tag-filter-clear" onclick="clearTagFilter()" title="清除筛选">✕</span>
    </div>`;
  }
  
  const hasAny = rootItems.length > 0;
  list.innerHTML = filterBarHtml + `<ul class="ns-root">${hasAny?'':''}${rootItems.map(n=>renderItem(n,0,new Set())).join('')}</ul>`;
  if (!hasAny) list.innerHTML += '<div class="notes-empty-hint" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">暂无笔记，右键可新建文件夹</div>';
  
  // Auto-focus rename input if in renaming mode
  if (renamingFolderId !== null) {
    const renameInput = list.querySelector('.ns-rename-input');
    if (renameInput) {
      setTimeout(() => {
        renameInput.focus();
        renameInput.select();
      }, 50);
    }
  }
  
  // Right-click context menu
  list.oncontextmenu = function(e) {
    e.preventDefault();
    const el = e.target.closest('[data-item-id]');
    if (el) {
      const item = findNoteItem(parseInt(el.dataset.itemId));
      if (item) {
        const folderId = item.type === 'folder' ? item.id : null;
        const noteId = item.type === 'note' ? item.id : null;
        showNotesContextMenu(e.clientX, e.clientY, folderId, noteId);
      }
    } else {
      // Right-click on empty space — show general menu (new note/folder only)
      showNotesContextMenu(e.clientX, e.clientY, null, null);
    }
  };
}

function toggleNoteFolder(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const isExpanded = el.style.display !== 'none';
  el.style.display = isExpanded ? 'none' : 'block';
  // Update toggle icon (▾ expanded / ▸ collapsed)
  const header = el.parentElement?.querySelector('.ns-folder-header');
  if (header) {
    const toggle = header.querySelector('.ns-toggle');
    if (toggle) toggle.textContent = isExpanded ? '▸' : '▾';
  }
}

// ═══════════ Notes: Summary visibility ═══════════
let notesSummaryVisible = localStorage.getItem('study_notes_summary_visible') !== 'false'; // default: true

function toggleNotesSummaryVisible() {
  notesSummaryVisible = !notesSummaryVisible;
  localStorage.setItem('study_notes_summary_visible', notesSummaryVisible);
  const btn = document.getElementById('notesToggleSummaryBtn');
  if (btn) {
    btn.title = notesSummaryVisible ? '隐藏摘要' : '显示摘要';
    btn.classList.toggle('off', !notesSummaryVisible);
    const text = btn.querySelector('.notes-header-btn-text');
    if (text) text.textContent = notesSummaryVisible ? '摘要' : '摘要';
  }
  renderNoteList();
}

// ═══════════ Notes: Tag filter ═══════════
let notesTagFilter = null; // tag string to filter by, null = no filter

function selectTagFromCard(el) {
  const tag = decodeURIComponent(el.dataset.tag);
  // Toggle tag filter: if already filtering by this tag, clear; else set
  if (notesTagFilter === tag) {
    notesTagFilter = null;
  } else {
    notesTagFilter = tag;
  }
  renderNoteList();
  applyTagFilterBar();
}

function applyTagFilterBar() {
  const bar = document.getElementById('notesTagFilterBar');
  if (!bar) return;
  if (notesTagFilter) {
    bar.innerHTML = `<span class="ns-tag-filter-label">标签筛选：</span><span class="ns-tag ns-tag-filter-active">${escapeHtml(notesTagFilter)}</span><span class="ns-tag-filter-clear" onclick="clearTagFilter()" title="清除筛选">✕</span>`;
    bar.style.display = 'flex';
  } else {
    bar.innerHTML = '';
    bar.style.display = 'none';
  }
}

function clearTagFilter() {
  notesTagFilter = null;
  renderNoteList();
  const bar = document.getElementById('notesTagFilterBar');
  if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
}

// ═══════════ Notes: Inline Rename (like Windows) ═══════════
let renamingFolderId = null;

function renameNoteFolder(id) {
  const item = findNoteItem(id);
  if (!item || item.type !== 'folder') return;
  renamingFolderId = id;
  renderNoteList();
}

function commitFolderRename(id, inputEl) {
  if (renamingFolderId !== id) return; // already handled by Enter-then-blur
  const value = inputEl ? inputEl.value : '';
  const item = findNoteItem(id);
  if (item && item.type === 'folder') {
    item.title = value.trim() || item.title;
    saveData('study_notes_v2', notes);
  }
  renamingFolderId = null;
  renderNoteList();
}

function cancelFolderRename() {
  renamingFolderId = null;
  renderNoteList();
}

// ═══════════ Notes: Drag & Drop (same pattern as todos) ═══════════
(function(){
let _dragId=null,_dropEl=null,_dropZone=null;

function clearInd(){
  if(_dropEl){_dropEl.remove();_dropEl=null}_dropZone=null;
  document.querySelectorAll('.ns-folder-header.drop-target').forEach(el=>el.classList.remove('drop-target'));
}

function showInd(ref,zone){
  if(zone!=='child'&&_dropEl&&_dropZone==='child')clearInd();
  // If same zone and indicator exists in DOM, just move it (don't recreate to avoid layout shift)
  if(_dropEl&&_dropZone===zone&&_dropEl.parentNode){
    ref.parentNode.insertBefore(_dropEl,zone==='before'?ref:ref.nextElementSibling||null);
    return;
  }
  clearInd();
  if(zone==='child'){
    ref.classList.add('drop-target');
  }else{
    if(!_dropEl){_dropEl=document.createElement('div');_dropEl.className='notes-drop-indicator';}
    ref.parentNode.insertBefore(_dropEl,zone==='before'?ref:ref.nextElementSibling||null);
    _dropZone=zone;
  }
}

function isDescendantOf(itemId,childId){
  for(let c=findNoteItem(childId);c;c=c.parentId?findNoteItem(c.parentId):null)
    if(c.id===itemId)return true;
  return false;
}

function reorderItem(draggedId,targetId,zone){
  const dragged=findNoteItem(draggedId),target=findNoteItem(targetId);
  if(!dragged||!target)return;
  // Remove dragged first
  notes=notes.filter(n=>n.id!==draggedId);
  const targetIdx=notes.findIndex(n=>n.id===targetId);
  if(targetIdx===-1){notes.push(dragged);saveData('study_notes_v2',notes);return;}
  if(zone==='child'){
    dragged.parentId=targetId;
    const firstChildIdx=notes.findIndex(n=>n.parentId===targetId);
    if(firstChildIdx>=0)notes.splice(firstChildIdx,0,dragged);
    else notes.splice(targetIdx+1,0,dragged);
  }else{
    dragged.parentId=target.parentId;
    notes.splice(zone==='before'?targetIdx:targetIdx+1,0,dragged);
  }
  saveData('study_notes_v2',notes);
}

document.addEventListener('dragstart',function(e){
  if(e.target.closest('button,input,textarea'))return;
  const notesList=document.getElementById('notesList');
  let li=null;
  for(let el=e.target;el&&el!==notesList;el=el.parentElement){
    if(el.hasAttribute&&el.hasAttribute('data-item-id')){li=el;break;}
  }
  if(!li)return;
  _dragId=parseInt(li.dataset.itemId);
  if(isNaN(_dragId))return;
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',String(_dragId));
  requestAnimationFrame(()=>li.classList.add('dragging'));
});

document.addEventListener('dragend',function(){
  document.querySelectorAll('.dragging').forEach(el=>el.classList.remove('dragging'));
  clearInd();_dragId=null;
});

document.addEventListener('dragover',function(e){
  // Check if cursor is in the notes list area
  const notesList=document.getElementById('notesList');
  if(!notesList||!_dragId)return;
  const inNotesArea=notesList.contains(e.target);
  if(!inNotesArea)return;
  // Walk up from e.target to find the nearest [data-item-id] element
  let li=null;
  for(let el=e.target;el&&el!==notesList;el=el.parentElement){
    if(el.hasAttribute&&el.hasAttribute('data-item-id')){li=el;break;}
  }
  if(!li&&e.target.closest)li=e.target.closest('[data-item-id]');
  if(!li){
    e.preventDefault();e.dataTransfer.dropEffect='move';
    const rootUl=notesList.querySelector('.ns-root');
    if(!rootUl)return;
    const first=rootUl.firstElementChild;
    if(!first)return;
    const rect=notesList.getBoundingClientRect();
    const isTop=e.clientY-rect.top<rect.height*0.4;
    const target=isTop?first:rootUl.lastElementChild;
    const zone=isTop?'before':'after';
    if(_dropZone!==zone||!_dropEl||!_dropEl.parentNode){
      clearInd();
      showInd(target,zone);
    }
    return;
  }
  const targetId=parseInt(li.dataset.itemId);
  if(targetId===_dragId||isNaN(targetId))return;
  const target=findNoteItem(targetId);
  if(!target)return;
  if(target.type==='folder'&&isDescendantOf(_dragId,targetId))return;
  const dragged=findNoteItem(_dragId);
  if(dragged&&dragged.type==='folder'&&target.type==='folder'&&isDescendantOf(_dragId,targetId))return;
  e.preventDefault();e.dataTransfer.dropEffect='move';
  const ref=target.type==='folder'?li.querySelector('.ns-folder-header'):li;
  if(!ref)return;
  const r=ref.getBoundingClientRect(),relY=e.clientY-r.top,h=r.height;
  const folderHasChildren=target.type==='folder'&&getNoteItemChildren(target.id).length>0;
  const zone=target.type==='folder'?(relY<h*0.25?'before':folderHasChildren?'child':(relY<h*0.5?'child':'after')):(relY<h*0.5?'before':'after');
  if(target.type==='folder'&&zone==='child'&&ref)showInd(ref,'child');
  else showInd(li,zone);
});

document.addEventListener('drop',function(e){
  const notesList=document.getElementById('notesList');
  if(!notesList||!_dragId)return;
  const inNotesArea=notesList.contains(e.target);
  if(!inNotesArea)return;
  let li=null;
  for(let el=e.target;el&&el!==notesList;el=el.parentElement){
    if(el.hasAttribute&&el.hasAttribute('data-item-id')){li=el;break;}
  }
  if(!li&&e.target.closest)li=e.target.closest('[data-item-id]');
  const dragged=findNoteItem(_dragId);
  if(!dragged)return;
  if(!li){
    // Drop on empty area — move to root level
    e.preventDefault();
    notes=notes.filter(n=>n.id!==_dragId);
    dragged.parentId=null;
    if(_dropZone==='before'){
      notes.unshift(dragged);
    }else{
      notes.push(dragged);
    }
    saveData('study_notes_v2',notes);
    clearInd();_dragId=null;renderNoteList();
    return;
  }
  const targetId=parseInt(li.dataset.itemId);
  if(targetId===_dragId||isNaN(targetId))return;
  const target=findNoteItem(targetId);
  if(!target)return;
  if(dragged.type==='folder'&&target.type==='folder'&&isDescendantOf(_dragId,targetId))return;
  e.preventDefault();
  const zone=_dropZone||(target.type==='folder'?'child':'after');
  reorderItem(_dragId,targetId,zone);
  clearInd();_dragId=null;
  renderNoteList();
  if(zone==='child'&&target.type==='folder'){
    const eid='ns-exp-'+targetId;const el=document.getElementById(eid);
    if(el)el.style.display='block';
  }
});
})();

// ═══════════ Notes: Context Menu ═══════════
function showNotesContextMenu(x,y,folderId,noteId){
  const menu=document.getElementById('notesContextMenu');
  if(!menu)return;
  menu.style.left=x+'px';menu.style.top=y+'px';
  menu.dataset.folderId=folderId||'';
  menu.dataset.noteId=noteId||'';
  menu.classList.add('visible');
  // 边界修正：菜单不超出视口
  const rect=menu.getBoundingClientRect();
  const vw=window.innerWidth, vh=window.innerHeight;
  if(rect.right>vw)menu.style.left=Math.max(0,vw-rect.width-6)+'px';
  if(rect.bottom>vh)menu.style.top=Math.max(0,vh-rect.height-6)+'px';
  // Show folder-only items only when right-clicking a folder
  const folderItems=document.getElementById('ctxFolderItems');
  if(folderItems)folderItems.style.display=folderId?'':'none';
  // Show note-only items only when right-clicking a note
  const noteItems=document.getElementById('ctxNoteItems');
  if(noteItems)noteItems.style.display=noteId?'':'none';
  // Update summary toggle text
  const summaryText=document.getElementById('ctxToggleSummaryText');
  const summaryIcon=document.getElementById('ctxToggleSummary')?.querySelector('[data-lucide]');
  if(summaryText)summaryText.textContent=notesSummaryVisible?'隐藏摘要':'显示摘要';
  // Update sidebar toggle text & icon
  const sidebarText=document.getElementById('ctxToggleSidebarText');
  const sidebarIcon=document.getElementById('ctxToggleSidebar')?.querySelector('[data-lucide]');
  if(sidebarText)sidebarText.textContent=notesSidebarHidden?'展开笔记列表':'收起笔记列表';
  if(sidebarIcon)sidebarIcon.setAttribute('data-lucide',notesSidebarHidden?'panel-left':'panel-left-close');
  // Update skip review menu text based on current note state
  if(noteId){
    const note=findNoteItem(noteId);
    const txt=document.getElementById('ctxToggleReviewText');
    const icon=document.getElementById('ctxToggleReview')?.querySelector('[data-lucide]');
    if(txt)txt.textContent=note&&note._skipReview?'恢复复习':'跳过复习';
    if(icon)icon.setAttribute('data-lucide',note&&note._skipReview?'eye':'eye-off');
    // 「完成复习」仅对今天到期/逾期的笔记显示（跳过复习或尚未到期的笔记不显示）
    const mkEl=document.getElementById('ctxMarkReviewed');
    if(mkEl){
      const isDue=!!(note && note.type==='note' && !note._skipReview && note.content && note.content.trim()
        && toLocalDateStr(calcNextReviewDate(note)) <= getTodayStr());
      mkEl.style.display=isDue?'':'none';
    }
  }
  document.querySelectorAll('.ns-folder-header').forEach(h=>h.classList.remove('context-active'));
  if(folderId){const el=document.querySelector(`[data-item-id="${folderId}"] .ns-folder-header`);if(el)el.classList.add('context-active');}
}
function closeNotesContextMenu(){
  const menu=document.getElementById('notesContextMenu');
  if(menu)menu.classList.remove('visible');
  document.querySelectorAll('.ns-folder-header').forEach(h=>h.classList.remove('context-active'));
}
document.addEventListener('click',function(e){if(!e.target.closest('#notesContextMenu'))closeNotesContextMenu();});

function contextNewNote(){
  const menu=document.getElementById('notesContextMenu');
  const folderId=menu?(parseInt(menu.dataset.folderId)||null):null;
  closeNotesContextMenu();createNewNote(folderId);
}
// ═══════════ 笔记选区 → AI 解释（右键新开对话标签页）═══════════
// 在笔记预览/编辑区选中一段文字后右键，弹出「AI 解释」菜单；
// 点击后切换到 AI 页、新建一个对话标签页并把选中文字作为提问发送。
// 提问会附带：笔记标题、笔记 id、选中内容的上下文片段（前后各若干字符）。
// 在预览 DOM 中把选区映射到纯文本区间（按 DOM 文本节点顺序拼接全文）
function getNotePreviewSelRange() {
  const pv = document.getElementById('notesPreview');
  if (!pv) return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const nodes = [];
  const walker = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT);
  let total = 0;
  while (walker.nextNode()) {
    const n = walker.currentNode;
    nodes.push({ node: n, start: total, len: n.textContent.length });
    total += n.textContent.length;
  }
  if (nodes.length === 0) return null;
  const locate = (node, offset) => {
    if (!node) return 0;
    if (node.nodeType === Node.TEXT_NODE) {
      for (const it of nodes) if (it.node === node) return it.start + Math.min(offset, it.len);
      return 0;
    }
    for (const it of nodes) if (it.node.parentNode === node) return it.start + Math.min(offset, it.len);
    return 0;
  };
  const a = locate(sel.anchorNode, sel.anchorOffset);
  const b = locate(sel.focusNode, sel.focusOffset);
  return { start: Math.min(a, b), end: Math.max(a, b), fullText: nodes.map(n => n.textContent).join('') };
}
// 提取选中内容在完整文本中的上下文（前后各 N 字符，边缘加省略号）
function buildNoteCtx(fullText, selStart, selEnd, N) {
  const n = N || 120;
  const s = Math.max(0, selStart - n);
  const e = Math.min(fullText.length, selEnd + n);
  return {
    prefix: (s > 0 ? '…' : '') + fullText.slice(s, selStart),
    suffix: fullText.slice(selEnd, e) + (e < fullText.length ? '…' : '')
  };
}
function bindNoteSelectionAiMenu() {
  const pv = document.getElementById('notesPreview');
  if (pv) {
    pv.addEventListener('contextmenu', function (e) {
      closeNoteAnnFloat();   // 防止残留的批注浮层遮挡右键目标
      const r = getNotePreviewSelRange();
      const sel = window.getSelection();
      // 兜底：TreeWalker 定位失败时直接用选区文本
      const fallbackText = sel && !sel.isCollapsed ? sel.toString().trim() : '';
      const rawSel = r ? r.fullText.substring(r.start, r.end) : '';
      const text = rawSel.trim() || fallbackText;
      if (!text) return;   // 无选中文字 → 走浏览器默认行为
      e.preventDefault();
      let selStart = -1, selEnd = -1, fullText = '';
      if (r) {
        selStart = r.start + (rawSel.length - rawSel.trimStart().length);
        selEnd = r.start + rawSel.trimEnd().length;
        fullText = r.fullText;
      }
      // 批注锚点基于源文本（textarea.value）。预览渲染文本 ≠ 源文本（markdown 语法被渲染），
      // 用「内容匹配」反查源文本位置；找不到则禁用添加批注（AI 解释仍可用）。
      let srcStart = -1, srcEnd = -1;
      const note = getActiveNote();
      if (note) {
        const S = note.content || '';
        const found = S.indexOf(text);
        if (found >= 0) { srcStart = found; srcEnd = found + text.length; }
      }
      showNoteAiExplainMenu(e.clientX, e.clientY, text, buildNoteCtx(fullText, selStart, selEnd), srcStart, srcEnd);
    });
  }
  const ta = document.getElementById('notesTextarea');
  if (ta) {
    ta.addEventListener('contextmenu', function (e) {
      closeNoteAnnFloat();
      const rawSel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
      if (!rawSel.trim()) return;
      e.preventDefault();
      const selStart = ta.selectionStart + (rawSel.length - rawSel.trimStart().length);
      const selEnd = ta.selectionStart + rawSel.trimEnd().length;
      showNoteAiExplainMenu(e.clientX, e.clientY, rawSel.trim(), buildNoteCtx(ta.value, selStart, selEnd), selStart, selEnd);
    });
  }
}
function showNoteAiExplainMenu(x, y, text, ctx, srcStart, srcEnd) {
  let menu = document.getElementById('noteAiExplainMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'noteAiExplainMenu';
    menu.className = 'context-menu visible';
    menu.innerHTML = '<div class="context-menu-item" onclick="aiExplainSelection()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:6px;"><path d="M12 3l1.9 5.7a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z"/></svg>🤖 AI 解释选中文字</div>'
      + '<div class="context-menu-sep"></div>'
      + '<div class="context-menu-item" id="noteAiExplainAddAnn" onclick="addAnnFromSelection()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:6px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>💬 添加批注</div>';
    document.body.appendChild(menu);
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#noteAiExplainMenu')) closeNoteAiExplainMenu();
    });
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.dataset.text = text;
  menu.dataset.ctx = ctx ? JSON.stringify(ctx) : '';
  menu.dataset.srcStart = (srcStart === undefined || srcStart === null) ? -1 : srcStart;
  menu.dataset.srcEnd = (srcEnd === undefined || srcEnd === null) ? -1 : srcEnd;
  // 无法定位源文本位置时（预览中内容跨 markdown 语法导致 indexOf 失败）隐藏批注项
  const addAnnItem = menu.querySelector('#noteAiExplainAddAnn');
  if (addAnnItem) addAnnItem.style.display = (menu.dataset.srcStart >= 0) ? '' : 'none';
  menu.style.display = 'block';
}
// 从右键菜单「添加批注」：打开批注输入模态
function addAnnFromSelection() {
  const menu = document.getElementById('noteAiExplainMenu');
  const start = menu ? parseInt(menu.dataset.srcStart || '-1', 10) : -1;
  const end = menu ? parseInt(menu.dataset.srcEnd || '-1', 10) : -1;
  const text = menu ? (menu.dataset.text || '') : '';
  closeNoteAiExplainMenu();
  if (start < 0 || end <= start || !text) return;
  openNoteAnnModal(start, end, text, null);
}
function closeNoteAiExplainMenu() {
  const menu = document.getElementById('noteAiExplainMenu');
  if (menu) menu.style.display = 'none';
}
function aiExplainSelection() {
  const menu = document.getElementById('noteAiExplainMenu');
  const text = menu ? (menu.dataset.text || '') : '';
  let ctx = null;
  try { ctx = menu.dataset.ctx ? JSON.parse(menu.dataset.ctx) : null; } catch (e) { ctx = null; }
  closeNoteAiExplainMenu();
  if (!text) return;
  // 附带笔记标题 + id（getActiveNote 取当前打开/选中的笔记）
  const note = getActiveNote();
  const title = note ? (note.title || '未命名笔记') : '';
  const nid = note ? note.id : '';
  let prompt = '请解释下面这段内容，它出自笔记「' + title + '」（笔记ID：' + nid + '）。\n\n';
  if (ctx && (ctx.prefix || ctx.suffix)) {
    prompt += '以下是选中内容及其上下文片段（⟪⟫ 内为需要解释的选中内容）：\n';
    prompt += ctx.prefix + '⟪⟫' + text + '⟪⟫' + ctx.suffix;
  } else {
    prompt += text;
  }
  // 切到 AI 页 → 新开一个对话标签页
  if (typeof switchTab === 'function') switchTab('ai');
  if (typeof createNewConv === 'function') createNewConv();
  // 新会话渲染后填入输入框并发送（sendAiMessage 从 #aiInput 读取）
  setTimeout(function () {
    const input = document.getElementById('aiInput');
    if (input) {
      input.value = prompt;
      if (typeof autoResizeAiInput === 'function') autoResizeAiInput();
      if (typeof sendAiMessage === 'function') sendAiMessage();
    }
  }, 80);
}
bindNoteSelectionAiMenu();   // 绑定笔记预览/编辑区的选中文字 → AI 解释右键菜单

// ═══════════ 笔记批注系统 ═══════════
// 数据：note._annotations = [{ id, start, end, text, createdAt, updatedAt }]
//   start/end = 源文本（textarea.value）字符偏移；text = 批注文字
// 预览高亮：ai-render.js 的 formatNoteContent 用 ⟦id⟧ 标记注入渲染后替换为 <mark class="note-ann">
function getNoteAnnotations() {
  const note = getActiveNote();
  if (!note) return [];
  if (!Array.isArray(note._annotations)) note._annotations = [];
  return note._annotations;
}
function saveNoteAnnotations(note) {
  if (!note) note = getActiveNote();
  if (!note) return;
  note.updatedAt = new Date().toISOString();
  saveData('study_notes_v2', notes);
  renderNotes();
  renderNoteAnnBadge();
}
function addNoteAnnotation(start, end, text) {
  const note = getActiveNote();
  if (!note) return null;
  if (!Array.isArray(note._annotations)) note._annotations = [];
  const ann = { id: genId(), start: start, end: end, text: text, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  note._annotations.push(ann);
  saveNoteAnnotations(note);
  showAiToast('已添加批注 💬');
  return ann;
}
function updateNoteAnnotation(id, text) {
  const note = getActiveNote();
  if (!note || !Array.isArray(note._annotations)) return;
  const ann = note._annotations.find(a => a.id === id);
  if (!ann) return;
  ann.text = text;
  ann.updatedAt = new Date().toISOString();
  saveNoteAnnotations(note);
  showAiToast('批注已更新 ✏️');
}
function deleteNoteAnnotation(id) {
  const note = getActiveNote();
  if (!note || !Array.isArray(note._annotations)) return;
  note._annotations = note._annotations.filter(a => a.id !== id);
  saveNoteAnnotations(note);
  showAiToast('批注已删除 🗑️');
}
// 跳转定位：切到编辑模式并选中锚点区间
function jumpToAnnotation(start, end) {
  closeNoteAnnPanel();
  switchNoteView('edit');
  const ta = document.getElementById('notesTextarea');
  if (!ta) return;
  ta.focus();
  const s = Math.max(0, Math.min(start, ta.value.length));
  const e = Math.max(s, Math.min(end, ta.value.length));
  ta.setSelectionRange(s, e);
  try {
    const line = ta.value.slice(0, s).split('\n').length;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, (line - 4) * lh);
  } catch (err) {}
}

// ── 批注输入模态 ──
let _noteAnnModalState = null;   // { start, end, anchorText, editId }
function openNoteAnnModal(start, end, anchorText, editId) {
  _noteAnnModalState = { start: start, end: end, anchorText: anchorText, editId: editId };
  const overlay = document.getElementById('noteAnnModal');
  if (!overlay) return;
  const titleEl = overlay.querySelector('.note-ann-modal-title-text');
  const anchorEl = overlay.querySelector('.note-ann-modal-anchor');
  const textEl = document.getElementById('noteAnnModalText');
  if (titleEl) titleEl.textContent = editId ? '编辑批注' : '添加批注';
  if (anchorEl) anchorEl.textContent = anchorText || '';
  if (textEl) textEl.value = editId ? ((getNoteAnnotations().find(a => a.id === editId) || {}).text || '') : '';
  updateNoteAnnCount();
  overlay.classList.add('open');
  setTimeout(function () { if (textEl) textEl.focus(); }, 60);
}
// 批注输入字数统计
function updateNoteAnnCount() {
  const textEl = document.getElementById('noteAnnModalText');
  const countEl = document.getElementById('noteAnnCount');
  if (!textEl || !countEl) return;
  const n = textEl.value.length;
  countEl.textContent = n;
  const wrap = countEl.closest('.na-count');
  if (wrap) wrap.classList.toggle('near-limit', n >= 1900);
}
document.addEventListener('input', function (e) {
  if (e.target && e.target.id === 'noteAnnModalText') updateNoteAnnCount();
});
function closeNoteAnnModal() {
  const overlay = document.getElementById('noteAnnModal');
  if (overlay) overlay.classList.remove('open');
  _noteAnnModalState = null;
}
function saveNoteAnnModal() {
  const st = _noteAnnModalState;
  const textEl = document.getElementById('noteAnnModalText');
  const content = textEl ? textEl.value.trim() : '';
  if (!st || !content) return;
  if (st.editId) updateNoteAnnotation(st.editId, content);
  else addNoteAnnotation(st.start, st.end, content);
  closeNoteAnnModal();
}
// 模态内 Esc 关闭 / Ctrl+Enter 保存
document.addEventListener('keydown', function (e) {
  const overlay = document.getElementById('noteAnnModal');
  if (!overlay || !overlay.classList.contains('open')) return;
  if (e.key === 'Escape') { closeNoteAnnModal(); }
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNoteAnnModal(); }
});

// ── 批注浮层（点击预览高亮 mark 打开）──
let _noteAnnFloatEscHandler = null;
function openNoteAnnFloat(annId) {
  const note = getActiveNote();
  const ann = note && Array.isArray(note._annotations) ? note._annotations.find(a => a.id === annId) : null;
  if (!note || !ann) return;
  const old = document.getElementById('noteAnnFloat');
  if (old) old.remove();
  const anchorText = (note.content || '').substring(ann.start, ann.end) || '（位置已失效）';
  const float = document.createElement('div');
  float.id = 'noteAnnFloat';
  float.className = 'note-ann-float';
  float.innerHTML = `
    <div class="naf-head">
      <span class="naf-title">💬 批注</span>
      <button class="naf-close" title="关闭 (Esc)" onclick="closeNoteAnnFloat()">✕</button>
    </div>
    <div class="naf-anchor">${escapeHtml(anchorText)}</div>
    <div class="naf-text">${escapeHtml(ann.text)}</div>
    <div class="naf-meta">${fmtNoteFloatTime(ann.updatedAt)}</div>
    <div class="naf-actions">
      <button onclick="editNoteAnnFromFloat('${ann.id}')">✏️ 编辑</button>
      <button onclick="jumpToAnnotation(${ann.start}, ${ann.end})">📍 定位</button>
      <button class="danger" onclick="deleteNoteAnnFromFloat('${ann.id}')">🗑️ 删除</button>
    </div>`;
  document.body.appendChild(float);
  if (_noteAnnFloatEscHandler) document.removeEventListener('keydown', _noteAnnFloatEscHandler);
  _noteAnnFloatEscHandler = function (e) { if (e.key === 'Escape') closeNoteAnnFloat(); };
  document.addEventListener('keydown', _noteAnnFloatEscHandler);
}
function closeNoteAnnFloat() {
  const f = document.getElementById('noteAnnFloat');
  if (f) f.remove();
  if (_noteAnnFloatEscHandler) { document.removeEventListener('keydown', _noteAnnFloatEscHandler); _noteAnnFloatEscHandler = null; }
}
function editNoteAnnFromFloat(annId) {
  const note = getActiveNote();
  const ann = note && Array.isArray(note._annotations) ? note._annotations.find(a => a.id === annId) : null;
  if (!ann) return;
  const anchorText = (note.content || '').substring(ann.start, ann.end) || '';
  closeNoteAnnFloat();
  openNoteAnnModal(ann.start, ann.end, anchorText, annId);
}
function deleteNoteAnnFromFloat(annId) {
  showCustomConfirm('确定删除这条批注？').then(function (ok) {
    if (!ok) return;
    closeNoteAnnFloat();
    deleteNoteAnnotation(annId);
  });
}
// 预览区点击高亮 → 打开批注浮层（事件委托，mark 随渲染更新）
// 关键：仅当没有非折叠选区时才弹浮层。否则用户"选中文字（拖选/双击）后右键"时，
// mouseup 落在 mark 上会立刻弹出浮层，遮挡预览区导致后续 contextmenu 目标变成浮层，
// 右键菜单（AI 解释/添加批注）失效。
document.addEventListener('click', function (e) {
  const mark = e.target.closest ? e.target.closest('mark.note-ann') : null;
  if (!mark) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;   // 正在选中文字 → 不弹浮层，交给右键菜单
  e.stopPropagation();
  openNoteAnnFloat(mark.dataset.id);
});

// ── 批注列表浮窗 ──
// 与笔记浮窗 openNoteFloat 相同的 .bk-node-float note-float 机制：
// 毛玻璃、可拖拽、8 向调整大小、关闭按钮；点击其它地方不会关闭（仅按钮/✕/Esc 关闭）。
let _noteAnnPanelEscHandler = null;
function toggleNoteAnnPanel() {
  const panel = document.getElementById('noteAnnPanel');
  if (panel) { closeNoteAnnPanel(); return; }
  openNoteAnnPanel();
}
function openNoteAnnPanel() {
  const old = document.getElementById('noteAnnPanel');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'noteAnnPanel';
  // 注意：不能共用 .note-ann-float（单条批注浮层带 transform 定位），会导致拖动跳变
  panel.className = 'bk-node-float note-float note-ann-list-float';
  panel.innerHTML = `
    <div class="bnf-rs bnf-rs-n" data-dir="n"></div><div class="bnf-rs bnf-rs-s" data-dir="s"></div>
    <div class="bnf-rs bnf-rs-e" data-dir="e"></div><div class="bnf-rs bnf-rs-w" data-dir="w"></div>
    <div class="bnf-rs bnf-rs-ne" data-dir="ne"></div><div class="bnf-rs bnf-rs-nw" data-dir="nw"></div>
    <div class="bnf-rs bnf-rs-se" data-dir="se"></div><div class="bnf-rs bnf-rs-sw" data-dir="sw"></div>
    <div class="bnf-header">
      <span class="bnf-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
      <span class="bnf-title" id="noteAnnPanelTitle">批注列表</span>
      <button class="bnf-close" title="关闭 (Esc)" onclick="closeNoteAnnPanel()">✕</button>
    </div>
    <div class="bnf-body note-ann-list" id="noteAnnPanelBody"></div>`;
  document.body.appendChild(panel);
  renderNoteAnnPanel();
  // 复用笔记浮窗的拖拽 / 8 向缩放
  if (typeof makeBkNodeFloatDraggable === 'function') { try { makeBkNodeFloatDraggable(panel); } catch (e) {} }
  if (typeof makeBkNodeFloatResizable === 'function') { try { makeBkNodeFloatResizable(panel); } catch (e) {} }
  // Esc 关闭（单例监听，防重复注册）
  if (_noteAnnPanelEscHandler) document.removeEventListener('keydown', _noteAnnPanelEscHandler);
  _noteAnnPanelEscHandler = function (e) { if (e.key === 'Escape') closeNoteAnnPanel(); };
  document.addEventListener('keydown', _noteAnnPanelEscHandler);
}
function renderNoteAnnPanel() {
  const panel = document.getElementById('noteAnnPanel');
  if (!panel) return;
  const titleEl = document.getElementById('noteAnnPanelTitle');
  const body = document.getElementById('noteAnnPanelBody');
  if (!body) return;
  const note = getActiveNote();
  const anns = note && Array.isArray(note._annotations)
    ? note._annotations.slice().sort((a, b) => a.start - b.start) : [];
  if (titleEl) titleEl.textContent = '批注列表（' + anns.length + '）';
  if (anns.length === 0) {
    body.innerHTML = '<div class="nap-empty">暂无批注。<br>在编辑或预览中选中文字，右键 → 「添加批注」。</div>';
    return;
  }
  body.innerHTML = anns.map(function (a) {
    const anchor = (note.content || '').substring(a.start, a.end) || '（位置已失效）';
    return '<div class="nap-item" onclick="jumpToAnnotation(' + a.start + ', ' + a.end + ')">'
      + '<div class="nap-anchor">' + escapeHtml(anchor) + '</div>'
      + '<div class="nap-text">' + escapeHtml(a.text) + '</div>'
      + '<div class="nap-meta">' + fmtNoteFloatTime(a.updatedAt) + '</div>'
      + '</div>';
  }).join('');
}
function closeNoteAnnPanel() {
  const panel = document.getElementById('noteAnnPanel');
  if (panel) panel.remove();
  if (_noteAnnPanelEscHandler) {
    document.removeEventListener('keydown', _noteAnnPanelEscHandler);
    _noteAnnPanelEscHandler = null;
  }
}
// 编辑器 header「批注」按钮徽章（桌面 + 手机版两处）
function renderNoteAnnBadge() {
  const note = getActiveNote();
  const cnt = note && Array.isArray(note._annotations) ? note._annotations.length : 0;
  const label = cnt > 0 ? ' ' + cnt : '';
  const el = document.getElementById('notesAnnCount');
  if (el) el.textContent = label;
  const elM = document.getElementById('notesAnnCountMobile');
  if (elM) elM.textContent = label;
  const btn = document.getElementById('notesAnnBtn');
  if (btn) btn.classList.toggle('has-ann', cnt > 0);
}
function contextNewFolder(){
  const menu=document.getElementById('notesContextMenu');
  const parentId=menu?(parseInt(menu.dataset.folderId)||null):null;
  closeNotesContextMenu();
  createNoteFolder('新建文件夹',parentId);
}
function contextDeleteFolder(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.folderId):null;
  closeNotesContextMenu();
  if(id)deleteNoteFolder(id); // deleteNoteFolder handles its own confirm
}
function contextRenameFolder(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.folderId):null;
  closeNotesContextMenu();if(id)renameNoteFolder(id);
}
function contextToggleSkipReview(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.noteId):null;
  if(!id)return;
  const note=findNoteItem(id);
  if(!note||note.type!=='note')return;
  note._skipReview=!note._skipReview;
  saveData('study_notes_v2',notes);
  closeNotesContextMenu();
  renderNoteList();
  if(typeof renderReviewCard==='function')renderReviewCard();
}
function contextMarkReviewed(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.noteId):null;
  closeNotesContextMenu();
  if(!id)return;
  markNoteReviewed(id);   // 复用复习卡片「复习完成」逻辑：push 复习记录 + 更新 updatedAt + 保存
}
// 右键「浮窗查看」：打开笔记浮窗（原列表项上的浮窗按钮移到这里）
function contextOpenNoteFloat(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.noteId):null;
  closeNotesContextMenu();
  if(!id)return;
  openNoteFloat(id);
}
// 右键「重置复习周期」：手动重置复习周期（原编辑自动重置改为手动触发）
function contextResetReview(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.noteId):null;
  closeNotesContextMenu();
  if(!id)return;
  const note=findNoteItem(id);
  if(!note)return;
  resetReviewOnEdit(note);
  saveData('study_notes_v2',notes);
  renderNoteList();
  if(typeof renderReviewCard==='function')renderReviewCard();
  showAiToast('已重置复习周期');
}
function contextArchiveNote(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.noteId):null;
  closeNotesContextMenu();
  if(id)archiveNote(id);
}
function contextArchiveFolder(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.folderId):null;
  closeNotesContextMenu();
  if(id)archiveNote(id);
}
function contextDeleteNote(){
  const menu=document.getElementById('notesContextMenu');
  const id=menu?parseInt(menu.dataset.noteId):null;
  closeNotesContextMenu();
  if(id)confirmDeleteNote(id);
}
function contextToggleNotesSummary(){
  closeNotesContextMenu();
  toggleNotesSummaryVisible();
}
function contextToggleNotesSidebar(){
  closeNotesContextMenu();
  toggleNotesSidebar();
}
function resetAllFolders(){
  closeNotesContextMenu();
  showCustomConfirm('确定要清空所有文件夹吗？笔记不会丢失，但需要重新分类。', { dontAskKey: 'study_dontask_clear_folders' }).then(confirmed=>{
    if(!confirmed)return;
    notes.forEach(n=>{if(n.type==='folder')n.parentId=null;else n.parentId=null;});
    notes=notes.filter(n=>n.type!=='folder');
    saveData('study_notes_v2',notes);renderNoteList();
  });
}

// ═══════════ Notes: Sidebar Toggle ═══════════
let notesSidebarHidden = localStorage.getItem('study_notes_sidebar_hidden') === 'true';

function toggleNotesSidebar() {
  notesSidebarHidden = !notesSidebarHidden;
  localStorage.setItem('study_notes_sidebar_hidden', notesSidebarHidden);
  const sidebar = document.getElementById('notesSidebar');
  const toggle = document.getElementById('notesSidebarToggle');
  if (!sidebar || !toggle) return;
  sidebar.classList.toggle('hidden', notesSidebarHidden);
  const icon = toggle.querySelector('.lucide-icon') || toggle.querySelector('i');
  if (icon) {
    icon.setAttribute('data-lucide', notesSidebarHidden ? 'panel-left' : 'panel-left-close');
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
  toggle.title = notesSidebarHidden ? '显示笔记列表' : '隐藏笔记列表';
}

function renderNotes(){
  // Apply sidebar hidden state
  const sidebar = document.getElementById('notesSidebar');
  const toggle = document.getElementById('notesSidebarToggle');
  if (sidebar) sidebar.classList.toggle('hidden', notesSidebarHidden);
  if (toggle) toggle.title = notesSidebarHidden ? '显示笔记列表' : '隐藏笔记列表';
  if(notes.filter(n=>n.type==='note').length===0){createNewNote();return;}
  if(!notes.find(n=>n.id===activeNoteId&&n.type==='note')){
    const firstNote=notes.find(n=>n.type==='note');
    if(firstNote)activeNoteId=firstNote.id;
    localStorage.setItem('study_active_note',activeNoteId);
  }
  renderNoteList();
  const note=getActiveNote();
  if(!note)return;
  const titleInput=document.getElementById('noteTitleInput');
  const textarea=document.getElementById('notesTextarea');
  if(titleInput)titleInput.value=note.title;
  if(textarea)textarea.value=note.content;
  switchNoteView(noteViewMode);
  const chars=(note.content||'').replace(/\s/g,'').length;
  const wcEl=document.getElementById('notesWordCount');
  const stEl=document.getElementById('notesStatus');
  if (wcEl) wcEl.textContent=chars+' 字';
  if (stEl) stEl.textContent='已保存';
  updateLastEditedDisplay(note);
  renderNoteSummary();
  renderNotesTagInput();
  applyTagFilterBar();
  notesApplyMobileView();
  renderNoteAnnBadge();
}

// ═══════════ Notes: Markdown Formatting ═══════════
// Format toolbar — wrap/unwrap selection with Markdown syntax
// Pair markers: bold/italic/strikethrough/code toggle on/off when already wrapped
const FORMAT_DEFS = {
  bold:          { p: '**', s: '**', ph: '粗体文字' },
  italic:        { p: '*',  s: '*',  ph: '斜体文字' },
  strikethrough: { p: '~~', s: '~~', ph: '删除的文字' },
  code:          { p: '`',  s: '`',  ph: '代码' },
  latex:         { p: '\\(', s: '\\)', ph: '公式' },
};

function formatText(type) {
  const ta = document.getElementById('notesTextarea');
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = ta.value;
  const sel = text.substring(start, end);

  // ── Toggle-able types: unwrap if already wrapped ──
  const def = FORMAT_DEFS[type];
  if (def && sel) {
    const { p, s, ph } = def;
    if (sel.startsWith(p) && sel.endsWith(s) && sel.length >= p.length + s.length) {
      const inner = sel.slice(p.length, -s.length);
      // Double-check: both sides must be the marker (e.g. **bold** → inner is "bold")
      ta.value = text.substring(0, start) + inner + text.substring(end);
      ta.selectionStart = start;
      ta.selectionEnd = start + inner.length;
      ta.focus();
      onNotesChange();
      return;
    }
  }

  let prefix = '', suffix = '', placeholder = '';

  switch (type) {
    case 'bold':        prefix = '**';  suffix = '**';  placeholder = '粗体文字'; break;
    case 'italic':      prefix = '*';   suffix = '*';   placeholder = '斜体文字'; break;
    case 'strikethrough': prefix = '~~'; suffix = '~~'; placeholder = '删除的文字'; break;
    case 'code':        prefix = '`';   suffix = '`';   placeholder = '代码'; break;
    case 'latex':       prefix = '\\(';  suffix = '\\)';  placeholder = '公式'; break;
    case 'heading':     prefix = '## '; suffix = '';    placeholder = '标题'; break;
    case 'link':        prefix = '[';   suffix = '](url)'; placeholder = '链接文字'; break;
    case 'ul':          prefix = '- ';  suffix = '';    placeholder = '列表项'; break;
    case 'ol':          prefix = '1. '; suffix = '';    placeholder = '列表项'; break;
    case 'quote':       prefix = '> ';  suffix = '';    placeholder = '引用文字'; break;
    case 'task':        prefix = '- [ ] '; suffix = ''; placeholder = '待办事项'; break;
    case 'hr': {
      // Only prepend \n if neither the preceding char nor the cursor position is \n
      const beforeNl = start > 0 && text[start - 1] !== '\n' && text[start] !== '\n' ? '\n' : '';
      // Only append \n if the next char isn't already \n
      const afterNl = end < text.length && text[end] !== '\n' ? '\n' : '';
      ta.value = text.substring(0, start) + beforeNl + '---' + afterNl + text.substring(end);
      ta.selectionStart = ta.selectionEnd = start + beforeNl.length + 3 + afterNl.length;
      ta.focus();
      onNotesChange();
      return;
    }
    default: return;
  }
  
  // For heading/list/quote that belong at line start, detect & prepend newline if needed
  // Avoid double \n: also check that cursor isn't already at a \n position
  if (prefix.endsWith(' ') && start > 0 && text[start - 1] !== '\n' && text[start] !== '\n') {
    const lineStartIdx = text.lastIndexOf('\n', start - 1);
    const col = start - (lineStartIdx === -1 ? 0 : lineStartIdx + 1);
    if (col > 0) {
      prefix = '\n' + prefix;
    }
  }
  
  const insert = sel ? prefix + sel + suffix : prefix + placeholder + suffix;
  const newText = text.substring(0, start) + insert + text.substring(end);
  ta.value = newText;
  
  // Set cursor/selection
  if (sel) {
    ta.selectionStart = start;
    ta.selectionEnd = start + insert.length;
  } else {
    const phStart = start + prefix.length;
    ta.selectionStart = phStart;
    ta.selectionEnd = phStart + placeholder.length;
  }
  
  ta.focus();
  onNotesChange();
}

// Keyboard shortcuts for formatting
document.addEventListener('keydown', function(e) {
  const ta = document.getElementById('notesTextarea');
  if (!ta || document.activeElement !== ta) return;
  if (!e.ctrlKey && !e.metaKey) return;
  
  const key = e.key.toLowerCase();
  let action = null;
  if (key === 'b') action = 'bold';
  else if (key === 'i') action = 'italic';
  else if (key === 'u') action = 'strikethrough';
  else if (key === 'k') action = 'link';
  
  if (action) {
    e.preventDefault();
    formatText(action);
  }
});

let noteViewMode='preview';
function switchNoteView(mode){
  noteViewMode=mode;
  const ta=document.getElementById('notesTextarea'),pv=document.getElementById('notesPreview'),sp=document.getElementById('notesSummaryPanel');
  const eb=document.getElementById('notesEditBtn'),pb=document.getElementById('notesPreviewBtn'),sb=document.getElementById('notesSummaryBtn');
  ta.classList.add('hidden');pv.classList.remove('active');if(sp)sp.style.display='none';
  [eb,pb,sb].forEach(b=>{if(b)b.classList.remove('active')});
  // Show/hide format toolbar: only visible in edit mode
  const tb=document.getElementById('notesFormatToolbar');if(tb)tb.style.display=mode==='edit'?'':'none';
  if(mode==='preview'){const n=getActiveNote();pv.innerHTML=n?formatNoteContent(n.content||''):'<p style="color:var(--text-secondary)">暂无内容</p>';pv.classList.add('active');if(pb)pb.classList.add('active');}
  else if(mode==='summary'){if(sp)sp.style.display='flex';if(sb)sb.classList.add('active');renderNoteSummary();const n=getActiveNote();if(n&&!n._summaryFresh&&(n.content||'').trim().length>0&&isAutoSummaryEnabled()){n._summaryUpdating=true;renderNoteSummary();generateNoteSummary(n).then(()=>{n._summaryUpdating=false;renderNoteSummary()});}}
  else{ta.classList.remove('hidden');if(eb)eb.classList.add('active');} // 不自动聚焦，避免移动端切编辑模式弹键盘
}

// ═══════════ Notes: Summary ═══════════
function getSummaryAiKey(){try{const keyId=localStorage.getItem('study_summary_ai_key_id');if(keyId){const keys=loadApiKeys();return keys.find(k=>k.id===keyId)||null;}}catch{}return null;}
async function generateNoteSummary(note){
  if(!note||!note.content){note.summary='';note._summaryFresh=true;saveData('study_notes_v2',notes);return;}
  const aiKey=getSummaryAiKey();
  if(!aiKey){note.summary='（未配置摘要 AI Key）';note._summaryFresh=true;saveData('study_notes_v2',notes);renderNoteSummary();return;}
  const baseUrl=(aiKey.baseUrl||'https://api.openai.com/v1').replace(/\/+$/,'');
  const truncContent=note.content.slice(0,6000);
  try{
    const resp=await fetch(baseUrl+'/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+aiKey.key},
      body:JSON.stringify({model:aiKey.model||'gpt-3.5-turbo',messages:[{role:'system',content:'你是一个笔记摘要助手。根据以下笔记内容，生成一段简短的中文摘要（不超过100字），概括核心要点。只输出摘要文本，不要加额外说明。'},{role:'user',content:'笔记标题：'+(note.title||'未命名')+'\n\n笔记内容：\n'+truncContent}],temperature:0.3,max_tokens:200})
    });
    if(resp.ok){const data=await resp.json();note.summary=(data.choices?.[0]?.message?.content||'').trim().slice(0,200);}else note.summary='（摘要生成失败）';
  }catch{note.summary='（摘要生成失败）';}
  note._summaryFresh=true;saveData('study_notes_v2',notes);renderNoteSummary();
}
function renderNoteSummary(){
  const panel=document.getElementById('notesSummaryPanel');if(!panel)return;
  const note=getActiveNote();if(!note){panel.innerHTML='';return;}
  const isFresh=note._summaryFresh,needsUpdate=!isFresh&&(note.content||'').trim().length>0;
  if(!note.summary&&!isFresh&&!needsUpdate)panel.innerHTML='<div class="notes-summary-empty">暂无摘要</div>';
  else if(!note.summary&&isFresh&&!note.content)panel.innerHTML='<div class="notes-summary-empty">空笔记</div>';
  else if(note._summaryUpdating)panel.innerHTML='<div class="notes-summary-status stale">⏳ 正在更新摘要…</div>';
  else{const stale=!isFresh&&needsUpdate;panel.innerHTML=`<div class="notes-summary-status ${isFresh?'fresh':'stale'}">${isFresh?'✅ 最新':'🔄 需要更新'}${stale?'<button class="notes-summary-inline-btn" onclick="refreshNoteSummary()">更新</button>':''}</div><div class="notes-summary-text">${escapeHtml(note.summary||'')}</div>`;}
}
function isAutoSummaryEnabled(){return localStorage.getItem('study_auto_summary')!=='false';}
function checkAndUpdateSummary(){if(!isAutoSummaryEnabled())return;const n=getActiveNote();if(n&&!n._summaryFresh&&(n.content||'').trim().length>0)generateNoteSummary(n);}
function refreshNoteSummary(){const n=getActiveNote();if(!n)return;const p=document.getElementById('notesSummaryPanel');if(p)p.innerHTML='<div class="notes-summary-empty">生成中…</div>';generateNoteSummary(n);}
function autoResizeAiInput(){const i=document.getElementById('aiInput');if(!i)return;i.style.height='auto';i.style.height=Math.min(i.scrollHeight,120)+'px';}
function handleAiInputKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendAiMessage();}}
document.addEventListener('visibilitychange',function(){if(document.hidden&&typeof checkAndUpdateSummary==='function')checkAndUpdateSummary();});

// ═══════════ Notes: Tag Management ═══════════
function renderNotesTagInput() {
  const bar = document.getElementById('notesTagBar');
  if (!bar) return;
  const note = getActiveNote();
  if (!note) { bar.innerHTML = ''; return; }
  const tags = note.tags || [];
  const tagChips = tags.map((t, i) =>
    `<span class="ed-tag-chip">${escapeHtml(t)}<span class="ed-tag-remove" onclick="removeNoteTag(${i})" title="删除标签">✕</span></span>`
  ).join('');
  bar.innerHTML = tagChips
    + `<input type="text" class="ed-tag-input" id="edTagInput" placeholder="${tags.length ? '+' : '添加标签'}" onkeydown="handleTagInputKey(event)" onblur="commitTagInput()">`;
}

function handleTagInputKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); commitTagInput(); }
  else if (e.key === ',') { e.preventDefault(); commitTagInput(); }
}

function commitTagInput() {
  const input = document.getElementById('edTagInput');
  if (!input) return;
  const val = input.value.trim();
  input.value = '';
  if (!val) return;
  const note = getActiveNote();
  if (!note) return;
  if (!Array.isArray(note.tags)) note.tags = [];
  // Split by comma for convenience
  const newTags = val.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  for (const t of newTags) {
    if (!note.tags.includes(t)) note.tags.push(t);
  }
  note.updatedAt = new Date().toISOString();
  saveData('study_notes_v2', notes);
  renderNotesTagInput();
  renderNoteList();
}

function removeNoteTag(index) {
  const note = getActiveNote();
  if (!note || !Array.isArray(note.tags)) return;
  note.tags.splice(index, 1);
  note.updatedAt = new Date().toISOString();
  saveData('study_notes_v2', notes);
  renderNotesTagInput();
  renderNoteList();
}

// ═══════════ Notes: helpers for other modules ═══════════
// resolveNoteFolderPath for AI path support
function resolveNoteFolderPath(path){
  if(!path||path.length===0)return null;
  let parentId=null;
  const seenInThisCall=new Set();
  for(const seg of path){
    // Safety: prevent folder with empty name
    if(!seg||!seg.trim())continue;
    let folder=notes.find(f=>f.type==='folder'&&f.title===seg&&f.parentId===parentId);
    if(!folder){
      const newId=genId();
      folder={id:newId,type:'folder',title:seg,parentId:parentId||null,summary:'',_summaryFresh:true};
      notes.push(folder);
    }
    // Safety: never set parentId to self
    if(folder.id===parentId){parentId=folder.id;continue;}
    parentId=folder.id;
  }
  saveData('study_notes_v2',notes);return parentId;
}

// showCustomPrompt for Electron compatibility
function showCustomPrompt(message,defaultValue){
  return new Promise((resolve)=>{
    const overlay=document.getElementById('promptOverlay'),msgEl=document.getElementById('promptMsg'),inputEl=document.getElementById('promptInput');
    const cancelBtn=document.getElementById('promptCancel'),okBtn=document.getElementById('promptOk');
    if(!overlay||!msgEl||!inputEl||!cancelBtn||!okBtn){resolve(prompt(message)||null);return;}
    msgEl.textContent=message;inputEl.value=defaultValue||'';overlay.classList.add('open');setTimeout(()=>inputEl.focus(),50);
    function cleanup(r){overlay.classList.remove('open');cancelBtn.removeEventListener('click',onCancel);okBtn.removeEventListener('click',onOk);overlay.removeEventListener('click',onOverlay);document.removeEventListener('keydown',onKey);resolve(r);}
    function onCancel(){cleanup(null);}
    function onOk(){cleanup(inputEl.value||null);}
    function onOverlay(e){if(e.target===overlay)cleanup(null);}
    function onKey(e){if(e.key==='Escape')cleanup(null);if(e.key==='Enter')cleanup(inputEl.value||null);}
    cancelBtn.addEventListener('click',onCancel);okBtn.addEventListener('click',onOk);overlay.addEventListener('click',onOverlay);document.addEventListener('keydown',onKey);
  });
}

// ═══════════ Settings panel helpers ═══════════
function resetFoldersFromSettings() {
  if (typeof resetAllFolders === 'function') {
    resetAllFolders();
    // Refresh the folder select after reset
    setTimeout(populateFolderSelect, 100);
  }
}

// ═══════════ Spaced Repetition Review System ═══════════
// Ebbinghaus-style spaced repetition intervals (in days):
// After review: 1, 2, 4, 7, 15, 30, 60, 120...

const REVIEW_PRESETS = {
  standard:  [1, 2, 4, 7, 15, 30, 60, 120],
  relaxed:   [2, 4, 8, 15, 30, 60, 120, 240]
};

// Get current review intervals based on user settings
function getReviewIntervals() {
  const mode = localStorage.getItem('study_review_mode') || 'standard';
  if (mode === 'custom') {
    const raw = localStorage.getItem('study_review_custom_intervals');
    if (raw) {
      const arr = raw.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
      if (arr.length > 0) return arr;
    }
    // Fallback to standard if custom is invalid
    return REVIEW_PRESETS.standard;
  }
  return REVIEW_PRESETS[mode] || REVIEW_PRESETS.standard;
}

// Get human-readable stage labels for current intervals
function getReviewStageLabels() {
  const intervals = getReviewIntervals();
  return intervals.map(d => {
    if (d >= 365) return Math.round(d / 365) + '年';
    if (d >= 30 && d % 30 === 0) return (d / 30) + '月';
    if (d >= 7 && d % 7 === 0) return (d / 7) + '周';
    return d + '天';
  });
}

// Convert a Date (or date string) to a LOCAL date string YYYY-MM-DD.
// Review dates must be compared/shown in the local timezone; using
// toISOString().slice(0, 10) would yield UTC dates and shift review days
// for timezones east/west of UTC (e.g. UTC+8 notes created before 08:00
// got "today" instead of "tomorrow").
function toLocalDateStr(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

// Whole-day difference (b - a) between two local YYYY-MM-DD date strings.
function daysBetweenDateStr(a, b) {
  if (!a || !b) return 0;
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  const ta = new Date(pa[0], pa[1] - 1, pa[2]).getTime();
  const tb = new Date(pb[0], pb[1] - 1, pb[2]).getTime();
  return Math.round((tb - ta) / 86400000);
}

// Ensure a note has _reviewHistory
function ensureReviewHistory(note) {
  if (!note._reviewHistory) note._reviewHistory = [];
}

// Calculate the next review date for a note based on its review history
function calcNextReviewDate(note) {
  ensureReviewHistory(note);
  if (note._reviewHistory.length === 0) {
    // Never reviewed: due after the FIRST interval from creation (or last update).
    // Must use getReviewIntervals()[0] (e.g. relaxed=2, custom=user-defined) —
    // hardcoding +1 ignored the review mode and made fresh notes inconsistent
    // with edited ones (which take the intervals branch below).
    const base = new Date(note.updatedAt || note.createdAt || Date.now());
    const intervals = getReviewIntervals();
    base.setDate(base.getDate() + (intervals.length > 0 ? intervals[0] : 1));
    return base;
  }
  // Use the most recent review to calculate next interval
  const lastReview = new Date(note._reviewHistory[note._reviewHistory.length - 1]);
  const reviewCount = note._reviewHistory.length;
  const intervals = getReviewIntervals();
  const intervalIdx = Math.min(reviewCount - 1, intervals.length - 1);
  const interval = intervals[intervalIdx];
  const nextDate = new Date(lastReview);
  nextDate.setDate(nextDate.getDate() + interval);
  return nextDate;
}

// Get all notes that are due for review today
function getNotesDueForReview() {
  const todayStr = getTodayStr();
  const dueNotes = [];
  for (const note of notes) {
    if (note.type !== 'note') continue;
    if (!note.content || !note.content.trim()) continue;
    if (note._skipReview) continue;
    const nextDate = calcNextReviewDate(note);
    // Compare date-only in LOCAL timezone so notes appear from start of day
    const nextDateStr = toLocalDateStr(nextDate);
    if (nextDateStr <= todayStr) {
      dueNotes.push({
        note,
        reviewCount: (note._reviewHistory || []).length,
        nextReviewDate: nextDate
      });
    }
  }
  // Sort: most overdue first (oldest nextReviewDate first)
  dueNotes.sort((a, b) => a.nextReviewDate - b.nextReviewDate);
  return dueNotes;
}

// Mark a note as reviewed (called when user clicks "复习完成")
function markNoteReviewed(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || note.type !== 'note') return;
  ensureReviewHistory(note);
  note._reviewHistory.push(new Date().toISOString());
  note.updatedAt = new Date().toISOString();
  saveData('study_notes_v2', notes);
  renderNoteList();
  // Re-render review card if on today tab
  if (typeof renderReviewCard === 'function') renderReviewCard();
}

// Get review summary for display (used in today page)
function getReviewSummary() {
  const due = getNotesDueForReview();
  return {
    totalDue: due.length,
    dueNotes: due.map(d => ({
      id: d.note.id,
      title: d.note.title || '未命名笔记',
      reviewCount: d.reviewCount,
      nextReviewDate: d.nextReviewDate,
      summary: d.note.summary || ''
    }))
  };
}

// Get ALL future review dates for a note (not just the next one)
// Returns [{date: 'YYYY-MM-DD', round: number, isNext: boolean}]
function getAllFutureReviewDates(note) {
  const result = [];
  if (!note.content || !note.content.trim()) return result;
  if (note._skipReview) return result;

  const histories = note._reviewHistory || [];
  const N = histories.length;
  const intervals = getReviewIntervals();

  // Round N+1: the next scheduled review
  const nextDate = calcNextReviewDate(note);
  result.push({
    date: toLocalDateStr(nextDate),
    round: N + 1,
    isNext: true
  });

  // Rounds N+2, N+3, ... all remaining future rounds
  let cumulative = 0;
  const gapIdx = Math.min(N, intervals.length - 1);

  for (let i = gapIdx; i < intervals.length; i++) {
    cumulative += intervals[i];
    const d = new Date(nextDate);
    d.setDate(d.getDate() + cumulative);
    result.push({
      date: toLocalDateStr(d),
      round: N + 1 + (i - gapIdx + 1),
      isNext: false
    });
  }

  return result;
}

// Build a map from date -> review info for all notes (used by calendar)
function buildReviewDateMap() {
  const map = {};
  for (const note of notes) {
    if (note.type !== 'note') continue;
    if (!note.content || !note.content.trim()) continue;
    if (note._skipReview) continue;
    const futureRounds = getAllFutureReviewDates(note);
    for (const rd of futureRounds) {
      if (!map[rd.date]) map[rd.date] = [];
      map[rd.date].push({
        id: note.id,
        title: note.title || '未命名笔记',
        round: rd.round,
        isNext: rd.isNext,
        summary: note.summary || ''
      });
    }
  }
  return map;
}

// Count review rounds on a specific date (used by calendar)
function getReviewCountForDate(dateStr) {
  const map = buildReviewDateMap();
  return (map[dateStr] || []).length;
}

// Get review note details for a specific date (used by calendar panel)
function getReviewNotesForDate(dateStr) {
  const reviewDateMap = buildReviewDateMap();
  const entries = reviewDateMap[dateStr] || [];
  const result = entries.map(e => ({
    id: e.id,
    title: e.title,
    reviewCount: e.round,
    isNext: e.isNext,
    summary: e.summary || '',
    isOverdue: dateStr < getTodayStr()
  }));
  // Sort: overdue first, then isNext first, then by round
  result.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1;
    if (a.isNext !== b.isNext) return a.isNext ? -1 : 1;
    return a.reviewCount - b.reviewCount;
  });
  return result;
}

// Mark note updatedAt → resets review cycle (note was edited, treat as "reviewed")
function resetReviewOnEdit(note) {
  if (!note || note.type !== 'note') return;
  ensureReviewHistory(note);
  // Push a review record for today so the 1-day countdown restarts
  const lastReview = note._reviewHistory.length > 0
    ? note._reviewHistory[note._reviewHistory.length - 1]
    : null;
  const todayStr = getTodayStr();
  // Only reset if the last review wasn't already today (avoid duplicate entries)
  if (lastReview && lastReview.startsWith(todayStr)) return;
  note._reviewHistory.push(new Date().toISOString());
}

// ═══════════ 笔记浮窗（类似教材节点浮窗：右下角可拖拽/缩放卡片）
// 复用 books-ai.js 的通用拖拽/缩放函数（makeBkNodeFloatDraggable/Resizable）与 .bk-node-float/.bnf-* 样式。
let _noteFloatEscHandler = null;
function openNoteFloat(id) {
  const note = findNoteItem(id);
  if (!note) return;
  // 单例：先移除旧的
  const old = document.getElementById('noteFloat');
  if (old) old.remove();

  const title = note.title || '未命名笔记';
  const content = (note.content || '').trim();
  const bodyHtml = content
    ? formatNoteContent(note.content, note)
    : '<div style="color:var(--text-secondary);opacity:.8;padding:8px 0;">（空白笔记）</div>';

  const float = document.createElement('div');
  float.id = 'noteFloat';
  float.className = 'bk-node-float note-float';
  float.innerHTML = `
    <div class="bnf-rs bnf-rs-n" data-dir="n"></div><div class="bnf-rs bnf-rs-s" data-dir="s"></div>
    <div class="bnf-rs bnf-rs-e" data-dir="e"></div><div class="bnf-rs bnf-rs-w" data-dir="w"></div>
    <div class="bnf-rs bnf-rs-ne" data-dir="ne"></div><div class="bnf-rs bnf-rs-nw" data-dir="nw"></div>
    <div class="bnf-rs bnf-rs-se" data-dir="se"></div><div class="bnf-rs bnf-rs-sw" data-dir="sw"></div>
    <div class="bnf-header">
      <span class="bnf-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>
      <span class="bnf-title">${escapeHtml(title)}</span>
      <button class="bnf-close" title="关闭 (Esc)" onclick="closeNoteFloat()">✕</button>
    </div>
    <div class="bnf-body note-float-body">
      <!-- 必须带 active 类：.notes-editor-preview 默认 display:none，缺 active 会导致正文不显示 -->
      <div class="notes-editor-preview active" style="padding:0;">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(float);

  if (typeof makeBkNodeFloatDraggable === 'function') { try { makeBkNodeFloatDraggable(float); } catch (e) {} }
  if (typeof makeBkNodeFloatResizable === 'function') { try { makeBkNodeFloatResizable(float); } catch (e) {} }

  // Esc 关闭（单例监听，防重复注册）
  if (_noteFloatEscHandler) document.removeEventListener('keydown', _noteFloatEscHandler);
  _noteFloatEscHandler = function (e) {
    if (e.key === 'Escape') {
      const f = document.getElementById('noteFloat');
      if (f) f.remove();
    }
  };
  document.addEventListener('keydown', _noteFloatEscHandler);
}
function closeNoteFloat() {
  const f = document.getElementById('noteFloat');
  if (f) f.remove();
  if (_noteFloatEscHandler) {
    document.removeEventListener('keydown', _noteFloatEscHandler);
    _noteFloatEscHandler = null;
  }
}
// 浮窗时间格式化：今天显示「HH:mm」，今年显示「M月d日」，跨年显示「yyyy年M月d日」
function fmtNoteFloatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
