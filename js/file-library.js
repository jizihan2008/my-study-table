(function initFileLibrary(global) {
  'use strict';

  const DB_NAME = 'study-file-library';
  const STORE = 'files';
  let query = '';

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
  async function importPicked(files) {
    const rows = Array.from(files || []);
    if (!rows.length) return;
    try {
      if (isDesktop()) {
        const payload = [];
        for (const file of rows) payload.push({ name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) });
        await global.electronAPI.filesImportData(payload);
      } else {
        if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
        for (const file of rows) {
          await idb('readwrite', store => store.put({ id: 'file_' + crypto.randomUUID(), name: file.name, size: file.size, type: file.type, createdAt: Date.now(), blob: file }));
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
      if (isDesktop()) { await global.electronAPI.filesImport(); renderFileLibrary(); return; }
      document.getElementById('fileLibraryInput')?.click();
    } catch (error) { alert('导入失败：' + error.message); }
  };
  global.handleLibraryFileInput = event => { importPicked(event.target.files); event.target.value = ''; };
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
    if (!confirm('确定从文件库删除这个文件吗？')) return;
    if (isDesktop()) await global.electronAPI.filesDelete(id);
    else await idb('readwrite', store => store.delete(id));
    renderFileLibrary();
  };
  global.showFileLibraryFolder = () => global.electronAPI?.filesShowDir?.();
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
    const folderButton = document.querySelector('.file-library-secondary');
    if (folderButton) folderButton.style.display = isDesktop() ? '' : 'none';
    list.innerHTML = '<div class="file-library-empty">正在读取文件…</div>';
    const files = (await listFiles()).filter(item => !query || item.name.toLowerCase().includes(query));
    if (!files.length) { list.innerHTML = '<div class="file-library-empty"><i data-lucide="folder-open"></i><strong>' + (query ? '没有匹配的文件' : '文件库还是空的') + '</strong><span>导入资料后，可直接打开，也可作为 AI 对话附件。</span></div>'; }
    else list.innerHTML = files.map(item => `<article class="file-library-item"><div class="file-library-icon"><i data-lucide="${iconFor(item.name)}"></i></div><div class="file-library-meta"><strong title="${escapeAttr(item.name)}">${escapeHtml(item.name)}</strong><span>${sizeLabel(item.size)} · ${new Date(item.createdAt).toLocaleString()}</span></div><div class="file-library-actions"><button onclick="openLibraryFile('${item.id}')" title="打开"><i data-lucide="external-link"></i><span>打开</span></button><button onclick="attachLibraryFileToAi('${item.id}')" title="发送给 AI"><i data-lucide="paperclip"></i><span>给 AI</span></button><button class="danger" onclick="deleteLibraryFile('${item.id}')" title="删除"><i data-lucide="trash-2"></i></button></div></article>`).join('');
    if (global.lucide) global.lucide.createIcons();
  };
  global.openFileLibraryPicker = async function () {
    let overlay = document.getElementById('fileLibraryPicker');
    if (!overlay) {
      overlay = document.createElement('div'); overlay.id = 'fileLibraryPicker'; overlay.className = 'timer-picker-overlay';
      overlay.onclick = event => { if (event.target === overlay) closeFileLibraryPicker(); };
      document.body.appendChild(overlay);
    }
    const files = await listFiles();
    overlay.innerHTML = `<div class="todo-picker-panel file-library-picker"><div class="todo-picker-header"><span><i data-lucide="folder-open"></i> 从文件库插入</span><button class="todo-picker-close" onclick="closeFileLibraryPicker()">×</button></div><div class="file-library-picker-list">${files.length ? files.map(item => `<button onclick="attachLibraryFileToAi('${item.id}')"><i data-lucide="${iconFor(item.name)}"></i><span><strong>${escapeHtml(item.name)}</strong><small>${sizeLabel(item.size)}</small></span></button>`).join('') : '<div class="file-library-empty"><strong>文件库为空</strong><span>请先在“文件库”中导入文件。</span></div>'}</div></div>`;
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
