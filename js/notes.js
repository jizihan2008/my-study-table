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

function selectNote(id) {
  checkAndUpdateSummary();
  activeNoteId = id;
  localStorage.setItem('study_active_note', activeNoteId);
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
    // Editing a note resets its review cycle (it'll be due again after 1 day)
    resetReviewOnEdit(note);
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
  document.getElementById('notesWordCount').textContent=chars+' 字';
  document.getElementById('notesStatus').textContent='已保存';
  updateLastEditedDisplay(note);
  renderNoteSummary();
  renderNotesTagInput();
  applyTagFilterBar();
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
  else{ta.classList.remove('hidden');ta.focus();if(eb)eb.classList.add('active');}
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
