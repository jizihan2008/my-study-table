(function initFileLibrary(global) {
  'use strict';

  const DB_NAME = 'study-file-library';
  const STORE = 'files';
  let query = '';
  let currentFolderId = null;
  let draggedId = null;
  let organizing = false;
  let dropTarget = null;
  const { compare, organize } = global.FileLibraryOrder;

  function isDesktop() { return !!global.electronAPI?.filesList; }
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idb(mode, callback) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = callback(tx.objectStore(STORE));
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  function req(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function listFiles() {
    if (isDesktop()) return global.electronAPI.filesList();
    const db = await openDb();
    try { return (await req(db.transaction(STORE).objectStore(STORE).getAll())).sort((a, b) => b.createdAt - a.createdAt); }
    finally { db.close(); }
  }
  async function getFile(id) {
    if (isDesktop()) {
      const row = await global.electronAPI.filesRead(id);
      if (!row) return null;
      const bytes = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
      return new File([bytes], row.name, { type: guessType(row.name) });
    }
    const db = await openDb();
    try {
      const row = await req(db.transaction(STORE).objectStore(STORE).get(id));
      return row ? new File([row.blob], row.name, { type: row.type || row.blob.type || guessType(row.name) }) : null;
    } finally { db.close(); }
  }
  function guessType(name) {
    const ext = String(name).split('.').pop().toLowerCase();
    return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv' })[ext] || '';
  }
  function sizeLabel(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  function iconFor(name) {
    const ext = String(name).split('.').pop().toLowerCase();
    if (ext === 'pdf') return 'file-text';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
    if (['zip', 'rar', '7z'].includes(ext)) return 'file-archive';
    return 'file';
  }
  async function importPicked(files, preservePaths = false, destinationId = currentFolderId) {
    const rows = Array.from(files || []);
    if (!rows.length) return;
    try {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      const folders = preservePaths ? (await listFiles()).filter(item => item.kind === 'folder') : [];
      const folderIds = new Map();
      for (const file of rows) {
        let parentId = destinationId;
        if (preservePaths) {
          const parts = String(file.webkitRelativePath || '').split('/').filter(Boolean).slice(0, -1);
          for (const part of parts) {
            const key = `${parentId || ''}\u0000${part}`;
            if (!folderIds.has(key)) {
              let folder = folders.find(item => item.parentId === parentId && item.name === part);
              if (!folder) {
                folder = await saveFolder(part, parentId);
                folders.push(folder);
              }
              folderIds.set(key, folder.id);
            }
            parentId = folderIds.get(key);
          }
        }
        if (isDesktop()) {
          await global.electronAPI.filesImportData([{ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) }], parentId);
        } else {
          await idb('readwrite', store => store.put({ id: 'file_' + crypto.randomUUID(), kind: 'file', parentId, name: file.name, size: file.size, type: file.type, createdAt: Date.now(), blob: file }));
        }
      }
      if (typeof showMiniToast === 'function') showMiniToast(`已导入 ${rows.length} 个文件`);
      renderFileLibrary();
    } catch (error) {
      alert('导入失败：' + (error?.message || error));
    }
  }
  global.importLibraryFiles = async function () {
    try {
      if (isDesktop()) { await global.electronAPI.filesImport(currentFolderId); renderFileLibrary(); return; }
      document.getElementById('fileLibraryInput')?.click();
    } catch (error) { alert('导入失败：' + error.message); }
  };
  global.handleLibraryFileInput = event => { importPicked(event.target.files); event.target.value = ''; };
  global.importLibraryFolder = async function () {
    try {
      if (isDesktop()) { await global.electronAPI.filesImportFolder(currentFolderId); renderFileLibrary(); return; }
      if (typeof global.showDirectoryPicker === 'function') {
        const root = await global.showDirectoryPicker();
        let count = 0;
        const importHandle = async (handle, parentId) => {
          const folder = await saveFolder(handle.name, parentId);
          for await (const child of handle.values()) {
            if (child.kind === 'directory') await importHandle(child, folder.id);
            else if (child.kind === 'file') {
              const file = await child.getFile();
              await idb('readwrite', store => store.put({ id: 'file_' + crypto.randomUUID(), kind: 'file', parentId: folder.id, name: file.name, size: file.size, type: file.type, createdAt: Date.now(), blob: file }));
              count++;
            }
          }
        };
        await importHandle(root, currentFolderId);
        if (typeof showMiniToast === 'function') showMiniToast(`已导入 ${count} 个文件`);
        renderFileLibrary();
        return;
      }
      document.getElementById('fileLibraryFolderInput')?.click();
    } catch (error) { if (error.name !== 'AbortError') alert('导入文件夹失败：' + error.message); }
  };
  global.handleLibraryFolderInput = event => { importPicked(event.target.files, true); event.target.value = ''; };
  async function saveFolder(name, parentId) {
    if (isDesktop()) return global.electronAPI.filesCreateFolder({ name, parentId });
    const folder = { id: 'folder_' + crypto.randomUUID(), kind: 'folder', parentId, name, createdAt: Date.now(), size: 0 };
    await idb('readwrite', store => store.put(folder));
    return folder;
  }
  global.createLibraryFolder = function () {
    const existing = document.getElementById('fileLibraryFolderDialog');
    if (existing) { existing.querySelector('input').focus(); return; }
    const parentId = currentFolderId;
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.id = 'fileLibraryFolderDialog';
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="fileLibraryFolderTitle">
      <div class="modal-header"><span class="modal-title" id="fileLibraryFolderTitle">新建文件夹</span><button type="button" class="modal-close" aria-label="取消">×</button></div>
      <div class="modal-body"><div class="modal-field"><label for="fileLibraryFolderName">文件夹名称</label><input id="fileLibraryFolderName" autocomplete="off"><span role="alert" aria-live="polite"></span></div><button type="submit" class="btn-save-modal">创建</button></div>
    </form>`;
    const input = overlay.querySelector('input');
    const submit = overlay.querySelector('[type="submit"]');
    const errorLabel = overlay.querySelector('[role="alert"]');
    let saving = false;
    const close = () => { if (saving) return; overlay.remove(); previousFocus?.focus(); };
    overlay.querySelector('.modal-close').onclick = close;
    overlay.onclick = event => { if (event.target === overlay) close(); };
    overlay.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const controls = Array.from(overlay.querySelectorAll('button, input')).filter(control => !control.disabled);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    overlay.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      if (saving) return;
      const name = input.value.trim();
      if (!name || name === '.' || name === '..') { errorLabel.textContent = '请输入有效的文件夹名称'; input.focus(); return; }
      saving = true; submit.disabled = true; input.disabled = true; errorLabel.textContent = '';
      try {
        await saveFolder(name, parentId);
        saving = false; close();
        await renderFileLibrary();
      } catch (error) {
        errorLabel.textContent = '新建文件夹失败：' + error.message;
      } finally { saving = false; submit.disabled = false; input.disabled = false; if (overlay.isConnected) input.focus(); }
    };
    document.body.appendChild(overlay);
    input.focus();
  };
  global.openLibraryFolder = id => { currentFolderId = id || null; query = ''; const search = document.getElementById('fileLibrarySearch'); if (search) search.value = ''; renderFileLibrary(); };
  global.searchFileLibrary = value => { query = String(value || '').trim().toLowerCase(); renderFileLibrary(); };
  global.openLibraryFile = async function (id) {
    if (isDesktop()) {
      const result = await global.electronAPI.filesOpen(id);
      if (!result?.ok) alert('打开失败：' + (result?.reason || '未知错误'));
      return;
    }
    // Safari 会在 await 之后丢失“用户手势”，先同步创建窗口，避免 iPhone/iPad 拦截。
    const opened = global.open('', '_blank');
    const file = await getFile(id);
    if (!file) { if (opened) opened.close(); return; }
    const url = URL.createObjectURL(file);
    if (opened) opened.location.href = url;
    else { const a = document.createElement('a'); a.href = url; a.download = file.name; a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  global.deleteLibraryFile = async function (id) {
    const rows = await listFiles();
    const item = rows.find(row => row.id === id);
    if (!item) return;
    if (!confirm(item.kind === 'folder' ? '确定删除这个文件夹及其中的所有内容吗？' : '确定从文件库删除这个文件吗？')) return;
    if (isDesktop()) await global.electronAPI.filesDelete(id);
    else {
      const ids = new Set([id]);
      if (item.kind === 'folder') {
        let changed;
        do { changed = false; for (const row of rows) if (ids.has(row.parentId) && !ids.has(row.id)) { ids.add(row.id); changed = true; } } while (changed);
      }
      await idb('readwrite', store => { for (const entryId of ids) store.delete(entryId); });
    }
    renderFileLibrary();
  };
  global.showFileLibraryFolder = () => global.electronAPI?.filesShowDir?.(currentFolderId);
  global.attachLibraryFileToAi = async function (id) {
    const file = await getFile(id);
    if (!file) return alert('文件不存在');
    addAiAttachmentFiles([file]);
    closeFileLibraryPicker();
    switchTab('ai');
  };
  global.renderFileLibrary = async function () {
    const list = document.getElementById('fileLibraryList');
    if (!list) return;
    const folderButton = document.querySelector('.file-library-system-folder');
    if (folderButton) folderButton.style.display = isDesktop() ? '' : 'none';
    list.innerHTML = '<div class="file-library-empty">正在读取文件…</div>';
    let all;
    try {
      all = await listFiles();
    } catch (error) {
      console.error('[FileLibrary] Failed to read files:', error);
      list.innerHTML = '<div class="file-library-empty"><strong>无法读取文件库</strong><span>请检查浏览器是否允许此网站使用本机存储，然后重试。</span></div>';
      return;
    }
    const byId = new Map(all.map(item => [item.id, item]));
    if (currentFolderId && !byId.has(currentFolderId)) currentFolderId = null;
    const breadcrumbs = document.getElementById('fileLibraryBreadcrumbs');
    if (breadcrumbs) {
      const ancestors = []; let cursor = byId.get(currentFolderId);
      while (cursor && ancestors.length < 100) { ancestors.unshift(cursor); cursor = byId.get(cursor.parentId); }
      breadcrumbs.innerHTML = `<button type="button" data-folder-id="" onclick="openLibraryFolder(null)">文件库</button>${ancestors.map(item => `<i data-lucide="chevron-right"></i><button type="button" data-folder-id="${item.id}" onclick="openLibraryFolder('${item.id}')">${escapeHtml(item.name)}</button>`).join('')}`;
    }
    const files = all.filter(item => query ? item.name.toLowerCase().includes(query) : (item.parentId || null) === currentFolderId)
      .sort(compare);
    if (!files.length) { list.innerHTML = '<div class="file-library-empty"><i data-lucide="folder-open"></i><strong>' + (query ? '没有匹配的文件' : '文件库还是空的') + '</strong><span>导入资料后，可直接打开，也可作为 AI 对话附件。</span></div>'; }
    else list.innerHTML = files.map(item => item.kind === 'folder'
      ? `<article class="file-library-item"><div class="file-library-icon"><i data-lucide="folder"></i></div><button type="button" class="file-library-folder-name" onclick="openLibraryFolder('${item.id}')" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</button><div class="file-library-actions"><button onclick="openLibraryFolder('${item.id}')" title="打开文件夹"><i data-lucide="chevron-right"></i><span>打开</span></button><button class="danger" onclick="deleteLibraryFile('${item.id}')" title="删除文件夹"><i data-lucide="trash-2"></i></button></div></article>`
      : `<article class="file-library-item"><div class="file-library-icon"><i data-lucide="${iconFor(item.name)}"></i></div><div class="file-library-meta"><strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong><span>${sizeLabel(item.size)} · ${new Date(item.createdAt).toLocaleString()}</span></div><div class="file-library-actions"><button onclick="openLibraryFile('${item.id}')" title="打开"><i data-lucide="external-link"></i><span>打开</span></button><button onclick="attachLibraryFileToAi('${item.id}')" title="发送给 AI"><i data-lucide="paperclip"></i><span>给 AI</span></button><button class="danger" onclick="deleteLibraryFile('${item.id}')" title="删除"><i data-lucide="trash-2"></i></button></div></article>`).join('');
    list.querySelectorAll('.file-library-item').forEach((element, index) => {
      const item = files[index];
      element.dataset.itemId = item.id;
      element.dataset.kind = item.kind || 'file';
      element.dataset.parentId = item.parentId || '';
      element.draggable = true;
      const handle = document.createElement('span');
      handle.className = 'file-library-drag-handle';
      handle.title = '拖拽排序；拖到文件夹中间放入，拖到路径栏移出';
      handle.innerHTML = '<i data-lucide="grip-vertical" aria-hidden="true"></i>';
      element.prepend(handle);
    });
    if (global.lucide) global.lucide.createIcons();
  };
  global.openFileLibraryPicker = async function () {
    let overlay = document.getElementById('fileLibraryPicker');
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'fileLibraryPicker'; overlay.className = 'timer-picker-overlay';
      overlay.onclick = event => { if (event.target === overlay) closeFileLibraryPicker(); };
      document.body.appendChild(overlay);
    }
    const all = await listFiles();
    const files = all.filter(item => item.kind !== 'folder');
    const byId = new Map(all.map(item => [item.id, item]));
    const pathFor = item => { const parts = []; let parent = byId.get(item.parentId); while (parent && parts.length < 100) { parts.unshift(parent.name); parent = byId.get(parent.parentId); } return parts.join(' / '); };
    overlay.innerHTML = `<div class="timer-picker ai-context-picker file-library-picker" role="dialog" aria-modal="true" aria-label="从文件库插入"><div class="todo-picker-header"><span><i data-lucide="folder-open"></i> 从文件库插入</span><button type="button" class="todo-picker-close" onclick="closeFileLibraryPicker()" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button></div><div class="file-library-picker-list">${files.length ? files.map(item => `<button onclick="attachLibraryFileToAi('${item.id}')"><i data-lucide="${iconFor(item.name)}"></i><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(pathFor(item) || '文件库')} · ${sizeLabel(item.size)}</small></span></button>`).join('') : '<div class="file-library-empty"><strong>文件库为空</strong><span>请先在“文件库”中导入文件。</span></div>'}</div></div>`;
    overlay.style.display = 'flex'; if (global.lucide) global.lucide.createIcons();
  };
  global.closeFileLibraryPicker = () => { const el = document.getElementById('fileLibraryPicker'); if (el) el.style.display = 'none'; };

  function initFileLibraryInteractions() {
    const section = document.getElementById('section-files');
    if (!section || section._fileDropReady) return;
    section._fileDropReady = true;
    let dragDepth = 0;
    const internalType = 'application/x-study-library-item';
    const isInternal = event => draggedId && Array.from(event.dataTransfer?.types || []).includes(internalType);
    const clearTarget = () => {
      section.querySelectorAll('.library-drop-folder, .library-drop-before, .library-drop-after').forEach(element => element.classList.remove('library-drop-folder', 'library-drop-before', 'library-drop-after'));
      dropTarget = null;
    };
    const finishDrag = () => {
      clearTarget(); draggedId = null;
      section.querySelectorAll('.library-dragging').forEach(element => element.classList.remove('library-dragging'));
    };
    const targetFor = (event, internal) => {
      const breadcrumb = event.target.closest('[data-folder-id]');
      if (breadcrumb) return { element: breadcrumb, parentId: breadcrumb.dataset.folderId || null, beforeId: null, style: 'library-drop-folder' };
      const row = event.target.closest('.file-library-item');
      if (row) {
        if (internal && row.dataset.itemId === draggedId) return null;
        const rect = row.getBoundingClientRect();
        const offset = (event.clientY - rect.top) / rect.height;
        if (row.dataset.kind === 'folder' && (!internal || (offset > .25 && offset < .75))) {
          return { element: row, parentId: row.dataset.itemId, beforeId: null, style: 'library-drop-folder' };
        }
        if (!internal || query) return null;
        const after = offset >= .5;
        return { element: row, parentId: row.dataset.parentId || null, beforeId: after ? row.nextElementSibling?.dataset.itemId || null : row.dataset.itemId, style: after ? 'library-drop-after' : 'library-drop-before' };
      }
      const list = event.target.closest('#fileLibraryList');
      return internal && list && !query ? { element: list, parentId: currentFolderId, beforeId: null, style: 'library-drop-after' } : null;
    };
    section.addEventListener('dragstart', event => {
      const row = event.target.closest('.file-library-item');
      if (!row) return;
      if (organizing || event.target.closest('.file-library-actions')) { event.preventDefault(); return; }
      draggedId = row.dataset.itemId;
      event.dataTransfer.setData(internalType, draggedId);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('library-dragging');
    });
    section.addEventListener('dragend', finishDrag);
    section.addEventListener('dragenter', event => {
      if (isInternal(event)) { event.preventDefault(); return; }
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault(); dragDepth++; section.classList.add('file-drop-active');
    });
    section.addEventListener('dragover', event => {
      const internal = isInternal(event);
      const external = Array.from(event.dataTransfer?.types || []).includes('Files');
      if (internal || external) {
        clearTarget();
        dropTarget = targetFor(event, internal);
        if (dropTarget) {
          event.preventDefault(); event.dataTransfer.dropEffect = internal ? 'move' : 'copy';
          dropTarget.element.classList.add(dropTarget.style);
          section.classList.remove('file-drop-active');
          return;
        }
        if (internal) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; return; }
      }
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; section.classList.add('file-drop-active');
    });
    section.addEventListener('dragleave', event => {
      if (!section.contains(event.relatedTarget)) clearTarget();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) section.classList.remove('file-drop-active');
    });
    section.addEventListener('drop', async event => {
      event.preventDefault(); dragDepth = 0; section.classList.remove('file-drop-active');
      const internal = isInternal(event);
      const target = targetFor(event, internal);
      const id = draggedId;
      finishDrag();
      if (internal) {
        if (!target || organizing) return;
        organizing = true;
        try {
          const payload = { id, parentId: target.parentId, beforeId: target.beforeId };
          if (isDesktop()) {
            const result = await global.electronAPI.filesOrganize(payload);
            if (!result?.ok) throw new Error(result?.reason || '保存失败');
          } else {
            const updates = organize(await listFiles(), payload);
            await idb('readwrite', store => { for (const row of updates) store.put(row); });
          }
          await renderFileLibrary();
        } catch (error) { alert('移动或排序失败：' + error.message); }
        finally { organizing = false; }
        return;
      }
      if (event.dataTransfer?.files?.length) importPicked(event.dataTransfer.files, false, target ? target.parentId : currentFolderId);
    });
    document.addEventListener('paste', event => {
      if (!section.classList.contains('active')) return;
      const files = event.clipboardData?.files;
      if (!files?.length) return;
      event.preventDefault(); importPicked(files);
    });
  }

  // 对话工具与文件库 UI 共用存储适配层，不暴露本机路径或二进制元数据。
  global.aiFileLibrary = Object.freeze({
    async list() {
      return (await listFiles()).map(({ id, kind, parentId, name, size, type, createdAt, order }) =>
        ({ id, kind: kind || 'file', parentId: parentId || null, name, size, type, createdAt, order }));
    },
    read: getFile
  });

  initFileLibraryInteractions();
})(window);
