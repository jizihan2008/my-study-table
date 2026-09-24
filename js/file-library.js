(function initFileLibrary(global) {
  'use strict';

  const DB_NAME = 'study-file-library';
  const STORE = 'files';
  let query = '';
  let currentFolderId = null;

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
  async function importPicked(files, preservePaths = false) {
    const rows = Array.from(files || []);
    if (!rows.length) return;
    try {
      if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
      const folders = preservePaths ? (await listFiles()).filter(item => item.kind === 'folder') : [];
      const folderIds = new Map();
      for (const file of rows) {
        let parentId = currentFolderId;
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
  global.createLibraryFolder = async function () {
    const name = prompt('文件夹名称');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return alert('请输入有效的文件夹名称');
    try { await saveFolder(trimmed, currentFolderId); renderFileLibrary(); }
    catch (error) { alert('新建文件夹失败：' + error.message); }
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
      breadcrumbs.innerHTML = `<button type="button" onclick="openLibraryFolder(null)">文件库</button>${ancestors.map(item => `<i data-lucide="chevron-right"></i><button type="button" onclick="openLibraryFolder('${item.id}')">${escapeHtml(item.name)}</button>`).join('')}`;
    }
    const files = all.filter(item => query ? item.name.toLowerCase().includes(query) : (item.parentId || null) === currentFolderId)
      .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN'));
    if (!files.length) { list.innerHTML = '<div class="file-library-empty"><i data-lucide="folder-open"></i><strong>' + (query ? '没有匹配的文件' : '文件库还是空的') + '</strong><span>导入资料后，可直接打开，也可作为 AI 对话附件。</span></div>'; }
    else list.innerHTML = files.map(item => item.kind === 'folder'
      ? `<article class="file-library-item"><div class="file-library-icon"><i data-lucide="folder"></i></div><button type="button" class="file-library-folder-name" onclick="openLibraryFolder('${item.id}')" title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</button><div class="file-library-actions"><button onclick="openLibraryFolder('${item.id}')" title="打开文件夹"><i data-lucide="chevron-right"></i><span>打开</span></button><button class="danger" onclick="deleteLibraryFile('${item.id}')" title="删除文件夹"><i data-lucide="trash-2"></i></button></div></article>`
      : `<article class="file-library-item"><div class="file-library-icon"><i data-lucide="${iconFor(item.name)}"></i></div><div class="file-library-meta"><strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong><span>${sizeLabel(item.size)} · ${new Date(item.createdAt).toLocaleString()}</span></div><div class="file-library-actions"><button onclick="openLibraryFile('${item.id}')" title="打开"><i data-lucide="external-link"></i><span>打开</span></button><button onclick="attachLibraryFileToAi('${item.id}')" title="发送给 AI"><i data-lucide="paperclip"></i><span>给 AI</span></button><button class="danger" onclick="deleteLibraryFile('${item.id}')" title="删除"><i data-lucide="trash-2"></i></button></div></article>`).join('');
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
    overlay.innerHTML = `<div class="todo-picker-panel file-library-picker"><div class="todo-picker-header"><span><i data-lucide="folder-open"></i> 从文件库插入</span><button class="todo-picker-close" onclick="closeFileLibraryPicker()">×</button></div><div class="file-library-picker-list">${files.length ? files.map(item => `<button onclick="attachLibraryFileToAi('${item.id}')"><i data-lucide="${iconFor(item.name)}"></i><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(pathFor(item) || '文件库')} · ${sizeLabel(item.size)}</small></span></button>`).join('') : '<div class="file-library-empty"><strong>文件库为空</strong><span>请先在“文件库”中导入文件。</span></div>'}</div></div>`;
    overlay.style.display = 'flex'; if (global.lucide) global.lucide.createIcons();
  };
  global.closeFileLibraryPicker = () => { const el = document.getElementById('fileLibraryPicker'); if (el) el.style.display = 'none'; };

  function initFileLibraryInteractions() {
    const section = document.getElementById('section-files');
    if (!section || section._fileDropReady) return;
    section._fileDropReady = true;
    let dragDepth = 0;
    section.addEventListener('dragenter', event => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault(); dragDepth++; section.classList.add('file-drop-active');
    });
    section.addEventListener('dragover', event => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; section.classList.add('file-drop-active');
    });
    section.addEventListener('dragleave', event => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) section.classList.remove('file-drop-active');
    });
    section.addEventListener('drop', event => {
      event.preventDefault(); dragDepth = 0; section.classList.remove('file-drop-active');
      if (event.dataTransfer?.files?.length) importPicked(event.dataTransfer.files);
    });
    document.addEventListener('paste', event => {
      if (!section.classList.contains('active')) return;
      const files = event.clipboardData?.files;
      if (!files?.length) return;
      event.preventDefault(); importPicked(files);
    });
  }

  initFileLibraryInteractions();
})(window);
