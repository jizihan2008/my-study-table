// QQ 聊天记录数据层：IndexedDB v2（时间索引、分片暂存、检索、日报与备份）
window.QQChats = (function () {
  'use strict';

  const DB_NAME = 'mst-qqchats';
  const DB_VERSION = 2;
  const CHAT_STORE = 'chats';
  const MSG_STORE = 'messages';
  const STAGE_STORE = 'stagedMessages';
  const BATCH_SIZE = 500;
  const MAX_RESTORE_MESSAGES = 500000;
  let _dbPromise = null;
  let _stageCleanupDone = false;
  const _importSessions = new Map();
  const metaCache = [];

  function _open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHAT_STORE)) db.createObjectStore(CHAT_STORE, { keyPath: 'chatId' });
        const messages = db.objectStoreNames.contains(MSG_STORE)
          ? req.transaction.objectStore(MSG_STORE)
          : db.createObjectStore(MSG_STORE, { keyPath: 'msgKey' });
        if (!messages.indexNames.contains('byChat')) messages.createIndex('byChat', ['chatId', 'order']);
        if (!messages.indexNames.contains('byChatTime')) messages.createIndex('byChatTime', ['chatId', 'timestamp', 'order']);
        if (!messages.indexNames.contains('byTime')) messages.createIndex('byTime', ['timestamp', 'chatId', 'order']);
        if (!messages.indexNames.contains('byChatSenderTime')) messages.createIndex('byChatSenderTime', ['chatId', 'senderName', 'timestamp', 'order']);
        if (!db.objectStoreNames.contains(STAGE_STORE)) {
          const staged = db.createObjectStore(STAGE_STORE, { keyPath: 'stageKey' });
          staged.createIndex('bySession', ['sessionId', 'stageOrder']);
        }
      };
      req.onsuccess = function () {
        const db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) {} _dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { _dbPromise = null; reject(req.error || new Error('打开数据库失败')); };
      req.onblocked = function () { reject(new Error('数据库升级被其他窗口阻止，请关闭其他应用窗口后重试')); };
    });
    return _dbPromise;
  }

  function _txDone(tx, message) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(true); };
      tx.onabort = function () { reject(tx.error || new Error(message || '数据库事务已取消')); };
      tx.onerror = function () {};
    });
  }

  function _request(req, fallback) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result === undefined ? fallback : req.result); };
      req.onerror = function () { reject(req.error || new Error('数据库请求失败')); };
    });
  }

  function _readFileText(file) {
    if (file && typeof file.text === 'function') return file.text();
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function _toTs(value) {
    if (!value) return 0;
    const numberValue = Number(value);
    if (!isNaN(numberValue) && numberValue > 0) return numberValue < 100000000000 ? numberValue * 1000 : numberValue;
    const date = new Date(String(value));
    return isNaN(date.getTime()) ? 0 : date.getTime();
  }

  function _fmtTime(ts) {
    const date = new Date(ts);
    if (isNaN(date.getTime())) return '';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function _messageDateKey(message) {
    if (message && message.time && /^\d{4}-\d{2}-\d{2}/.test(message.time)) return message.time.slice(0, 10);
    if (message && message.timestamp) return _fmtTime(message.timestamp).slice(0, 10) || '未知日期';
    return '未知日期';
  }

  function _parseChatInfo(json) {
    const chat = (json && json.chatInfo) || {};
    const statistics = (json && json.statistics) || {};
    return {
      name: String(chat.name || chat.peerName || 'QQ 会话'),
      chatType: chat.type === 'group' ? 'group' : (chat.type === 'temp' ? 'temp' : 'private'),
      peerUin: String(chat.peerUin || chat.peerUid || chat.groupCode || ''),
      selfUin: String(chat.selfUin || chat.selfUid || ''),
      conversationId: String(chat.conversationId || chat.chatId || chat.sessionId || ''),
      selfName: String(chat.selfName || '我'),
      avatarUrl: String(chat.avatar || ''),
      total: Number(statistics.totalMessages) || Number(statistics.total) || (Array.isArray(json && json.messages) ? json.messages.length : 0),
      participants: Array.isArray(statistics.senders) ? statistics.senders.length : (Number(statistics.participants) || 0),
      timeStart: _toTs(statistics.timeRange && statistics.timeRange.start),
      timeEnd: _toTs(statistics.timeRange && statistics.timeRange.end)
    };
  }

  function _safeIdPart(value) { return encodeURIComponent(String(value || '').trim()).slice(0, 240); }
  function _buildChatId(info) {
    if (info.peerUin) return 'qq|' + info.chatType + '|' + _safeIdPart(info.peerUin);
    if (info.conversationId) return 'qq|' + info.chatType + '|session|' + _safeIdPart(info.conversationId);
    return 'qq|' + info.chatType + '|named|' + _safeIdPart(info.selfUin + '|' + info.name);
  }

  function _fingerprintBase(message) {
    return JSON.stringify([Number(message.timestamp) || 0, String(message.senderUin || ''), String(message.senderName || ''), String(message.type || ''), String(message.text || ''), !!message.recalled, !!message.system]);
  }

  function _normalizeMessages(chatId, rawMessages, state) {
    state = state || { nextOrder: 0, occurrences: new Map() };
    if (!(state.occurrences instanceof Map)) state.occurrences = new Map();
    const out = [];
    for (const raw of rawMessages || []) {
      const message = raw || {};
      const sender = message.sender || {};
      const content = message.content || {};
      const timestamp = _toTs(message.timestamp || message.time);
      let time = String(message.time || '');
      if (!time && timestamp) time = _fmtTime(timestamp);
      else if (time && /T.*(?:Z|[+-]\d\d:?\d\d)$/.test(time) && timestamp) time = _fmtTime(timestamp);
      const normalized = {
        msgKey: '', chatId, order: state.nextOrder++, id: String(message.id || ''), timestamp, time,
        senderName: String(sender.name || sender.nickname || '未知'), senderUin: String(sender.uin || sender.uid || ''),
        text: String(content.text !== undefined ? content.text : (typeof content === 'string' ? content : '')),
        type: String(message.type || message.messageType || ''), recalled: !!message.recalled, system: !!message.system
      };
      const base = _fingerprintBase(normalized);
      const occurrence = (state.occurrences.get(base) || 0) + 1;
      state.occurrences.set(base, occurrence);
      normalized.fingerprint = base + '#' + occurrence;
      normalized.msgKey = chatId + '::' + normalized.order;
      out.push(normalized);
    }
    return out;
  }

  async function _getChat(chatId) {
    const db = await _open();
    return _request(db.transaction(CHAT_STORE, 'readonly').objectStore(CHAT_STORE).get(chatId), null).catch(function () { return null; });
  }

  async function _putChat(meta) {
    const db = await _open();
    const tx = db.transaction(CHAT_STORE, 'readwrite');
    tx.objectStore(CHAT_STORE).put(meta);
    return _txDone(tx, '保存会话失败');
  }

  async function _putMessages(items) {
    if (!items || items.length === 0) return true;
    const db = await _open();
    for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
      const tx = db.transaction(MSG_STORE, 'readwrite');
      const store = tx.objectStore(MSG_STORE);
      for (const item of items.slice(offset, offset + BATCH_SIZE)) store.put(item);
      await _txDone(tx, '写入消息失败');
    }
    return true;
  }

  async function _getExistingMsgInfo(chatId) {
    const db = await _open();
    return new Promise(function (resolve) {
      const index = db.transaction(MSG_STORE, 'readonly').objectStore(MSG_STORE).index('byChat');
      const req = index.openCursor(IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]));
      const ids = new Set();
      const fingerprints = new Set();
      const occurrences = new Map();
      let maxOrder = -1;
      let count = 0;
      req.onsuccess = function () {
        const cursor = req.result;
        if (!cursor) { resolve({ ids, fingerprints, maxOrder, count }); return; }
        const value = cursor.value;
        if (value.id) ids.add(String(value.id));
        const base = _fingerprintBase(value);
        const occurrence = (occurrences.get(base) || 0) + 1;
        occurrences.set(base, occurrence);
        fingerprints.add(base + '#' + occurrence);
        if (value.fingerprint) fingerprints.add(value.fingerprint);
        maxOrder = Math.max(maxOrder, Number(value.order) || 0);
        count++;
        cursor.continue();
      };
      req.onerror = function () { resolve({ ids, fingerprints, maxOrder: -1, count: 0 }); };
    });
  }

  function _dedupeMerge(existingInfo, messages) {
    const toAdd = [];
    let skipped = 0;
    for (const message of messages) {
      const duplicate = message.id ? existingInfo.ids.has(message.id) : existingInfo.fingerprints.has(message.fingerprint);
      if (duplicate) { skipped++; continue; }
      message.order = ++existingInfo.maxOrder;
      message.msgKey = message.chatId + '::' + message.order;
      if (message.id) existingInfo.ids.add(message.id); else existingInfo.fingerprints.add(message.fingerprint);
      toAdd.push(message);
    }
    return { toAdd, existingCount: skipped };
  }

  function _messageStats(messages, seed) {
    const stats = seed || { count: 0, timeStart: 0, timeEnd: 0, lastMessageText: '', lastTextTs: -1, affectedDates: new Set() };
    if (!(stats.affectedDates instanceof Set)) stats.affectedDates = new Set(stats.affectedDates || []);
    for (const message of messages || []) {
      stats.count++;
      if (message.timestamp && (!stats.timeStart || message.timestamp < stats.timeStart)) stats.timeStart = message.timestamp;
      if (message.timestamp && message.timestamp > stats.timeEnd) stats.timeEnd = message.timestamp;
      if (message.text && message.timestamp >= stats.lastTextTs) { stats.lastTextTs = message.timestamp; stats.lastMessageText = message.text; }
      stats.affectedDates.add(_messageDateKey(message));
    }
    return stats;
  }

  function _newChatMeta(chatId, info, stats) {
    return {
      chatId, name: info.name, chatType: info.chatType, peerUin: info.peerUin, selfUin: info.selfUin,
      selfName: info.selfName || '我', avatarUrl: info.avatarUrl || '', total: stats.count,
      participants: info.participants || 0, timeStart: stats.timeStart || info.timeStart || 0,
      timeEnd: stats.timeEnd || info.timeEnd || 0, importedAt: new Date().toISOString(),
      lastMessageText: stats.lastMessageText || '', summary: '', summaryUpTo: 0, summaryDate: '',
      dailyReports: [], schemaVersion: 2
    };
  }

  function _mergedChatMeta(oldMeta, info, stats) {
    const dailyReports = (Array.isArray(oldMeta.dailyReports) ? oldMeta.dailyReports : []).map(function (report) {
      return stats.affectedDates.has(report.date)
        ? Object.assign({}, report, { stale: true, staleSince: new Date().toISOString() })
        : report;
    });
    const starts = [Number(oldMeta.timeStart) || 0, stats.timeStart || info.timeStart || 0].filter(function (value) { return value > 0; });
    const latestIsNew = stats.timeEnd >= (Number(oldMeta.timeEnd) || 0);
    return Object.assign({}, oldMeta, {
      name: info.name || oldMeta.name, chatType: info.chatType || oldMeta.chatType,
      peerUin: info.peerUin || oldMeta.peerUin, selfUin: info.selfUin || oldMeta.selfUin,
      total: (Number(oldMeta.total) || 0) + stats.count,
      participants: info.participants || oldMeta.participants || 0,
      timeStart: starts.length ? Math.min.apply(Math, starts) : 0,
      timeEnd: Math.max(Number(oldMeta.timeEnd) || 0, stats.timeEnd || info.timeEnd || 0),
      importedAt: new Date().toISOString(),
      lastMessageText: latestIsNew && stats.lastMessageText ? stats.lastMessageText : (oldMeta.lastMessageText || ''),
      dailyReports, summaryUpTo: 0, schemaVersion: 2
    });
  }

  async function _deleteChatRecords(chatId, includeMeta) {
    const db = await _open();
    const tx = db.transaction([CHAT_STORE, MSG_STORE], 'readwrite');
    if (includeMeta) tx.objectStore(CHAT_STORE).delete(chatId);
    const req = tx.objectStore(MSG_STORE).index('byChat').openCursor(IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]));
    req.onsuccess = function () { const cursor = req.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    await _txDone(tx, '删除会话失败');
  }

  async function _stageMessages(session, messages) {
    if (!messages.length) return;
    const db = await _open();
    for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
      const tx = db.transaction(STAGE_STORE, 'readwrite');
      const store = tx.objectStore(STAGE_STORE);
      for (const message of messages.slice(offset, offset + BATCH_SIZE)) {
        const stageOrder = session.stagedCount++;
        store.put(Object.assign({}, message, { stageKey: session.id + '::' + stageOrder, sessionId: session.id, stageOrder }));
      }
      await _txDone(tx, '暂存消息分片失败');
    }
  }

  async function _clearStage(sessionId) {
    const db = await _open();
    const tx = db.transaction(STAGE_STORE, 'readwrite');
    const req = tx.objectStore(STAGE_STORE).index('bySession').openCursor(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
    req.onsuccess = function () { const cursor = req.result; if (cursor) { cursor.delete(); cursor.continue(); } };
    await _txDone(tx, '清理导入暂存失败');
  }

  async function _commitStage(session, meta) {
    const db = await _open();
    const tx = db.transaction([CHAT_STORE, MSG_STORE, STAGE_STORE], 'readwrite');
    const chats = tx.objectStore(CHAT_STORE);
    const messages = tx.objectStore(MSG_STORE);
    const staged = tx.objectStore(STAGE_STORE);
    const copyStaged = function () {
      const req = staged.index('bySession').openCursor(IDBKeyRange.bound([session.id, 0], [session.id, Number.MAX_SAFE_INTEGER]));
      req.onsuccess = function () {
        const cursor = req.result;
        if (!cursor) { chats.put(meta); return; }
        const value = Object.assign({}, cursor.value);
        delete value.stageKey; delete value.sessionId; delete value.stageOrder;
        messages.put(value);
        cursor.delete();
        cursor.continue();
      };
    };
    if (session.mode === 'overwrite' && session.existing) {
      const req = messages.index('byChat').openCursor(IDBKeyRange.bound([session.chatId, 0], [session.chatId, Number.MAX_SAFE_INTEGER]));
      req.onsuccess = function () { const cursor = req.result; if (cursor) { cursor.delete(); cursor.continue(); } else copyStaged(); };
    } else copyStaged();
    await _txDone(tx, '提交导入数据失败');
  }

  function _newSessionId() { return 'qqimport-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); }

  const api = {
    metaCache,

    async inspectImport(source) {
      const info = _parseChatInfo(source);
      const chatId = _buildChatId(info);
      const chat = await _getChat(chatId);
      return { chatId, chat, exists: !!chat, info };
    },

    async importJsonFile(file, opts) {
      opts = opts || {};
      let json;
      try { json = JSON.parse(await _readFileText(file)); }
      catch (error) { throw new Error('JSON 解析失败：' + ((error && error.message) || error)); }
      if (!json || !Array.isArray(json.messages)) throw new Error('不是有效的 qq-chat-exporter JSON：缺少 messages 数组');
      const info = _parseChatInfo(json);
      const chatId = _buildChatId(info);
      const existing = await _getChat(chatId);
      if (existing && !opts.force && !opts.merge) return { chatId, exists: true, chat: existing, added: 0 };
      let messages = _normalizeMessages(chatId, json.messages, { nextOrder: 0, occurrences: new Map() });
      let skipped = 0;
      let meta;
      if (existing && opts.merge) {
        const dedupe = _dedupeMerge(await _getExistingMsgInfo(chatId), messages);
        messages = dedupe.toAdd;
        skipped = dedupe.existingCount;
        meta = _mergedChatMeta(existing, info, _messageStats(messages));
      } else {
        if (existing) await _deleteChatRecords(chatId, true);
        meta = _newChatMeta(chatId, info, _messageStats(messages));
      }
      const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      for (let offset = 0; offset < messages.length; offset += BATCH_SIZE) {
        await _putMessages(messages.slice(offset, offset + BATCH_SIZE));
        if (onProgress) onProgress(Math.min(offset + BATCH_SIZE, messages.length), messages.length);
      }
      await _putChat(meta);
      await api.loadMetaCache();
      return { chatId, added: messages.length, exists: !!existing, merged: !!(existing && opts.merge), existingCount: skipped, chat: meta };
    },

    async beginChunkedImport(manifest, opts) {
      opts = opts || {};
      if (!manifest || !manifest.chatInfo) throw new Error('不是有效的 qq-chat-exporter JSONL 数据：缺少 chatInfo');
      const info = _parseChatInfo(manifest);
      const chatId = _buildChatId(info);
      const existing = await _getChat(chatId);
      if (existing && !opts.force && !opts.merge) return { chatId, exists: true, chat: existing };
      const mode = existing && opts.merge ? 'merge' : (existing && opts.force ? 'overwrite' : 'new');
      const existingInfo = mode === 'merge' ? await _getExistingMsgInfo(chatId) : { ids: new Set(), fingerprints: new Set(), maxOrder: -1, count: 0 };
      const session = {
        id: _newSessionId(), chatId, info, existing, existingInfo, mode,
        normalizeState: { nextOrder: mode === 'merge' ? existingInfo.maxOrder + 1 : 0, occurrences: new Map() },
        stats: _messageStats([]), stagedCount: 0, rawCount: 0, skipped: 0
      };
      _importSessions.set(session.id, session);
      return { sessionId: session.id, chatId, exists: !!existing, chat: existing, mode };
    },

    async appendChunkedImport(sessionId, rawMessages) {
      const session = _importSessions.get(sessionId);
      if (!session) throw new Error('导入会话已失效，请重新选择文件夹');
      if (!Array.isArray(rawMessages)) throw new Error('消息分片格式无效');
      session.rawCount += rawMessages.length;
      let messages = _normalizeMessages(session.chatId, rawMessages, session.normalizeState);
      if (session.mode === 'merge') {
        const dedupe = _dedupeMerge(session.existingInfo, messages);
        messages = dedupe.toAdd;
        session.skipped += dedupe.existingCount;
      }
      _messageStats(messages, session.stats);
      await _stageMessages(session, messages);
      return { added: messages.length, skipped: session.skipped, staged: session.stagedCount, raw: session.rawCount };
    },

    async finishChunkedImport(sessionId) {
      const session = _importSessions.get(sessionId);
      if (!session) throw new Error('导入会话已失效，请重新导入');
      const meta = session.mode === 'merge' ? _mergedChatMeta(session.existing, session.info, session.stats) : _newChatMeta(session.chatId, session.info, session.stats);
      await _commitStage(session, meta);
      _importSessions.delete(sessionId);
      await api.loadMetaCache();
      return { chatId: session.chatId, added: session.stagedCount, exists: !!session.existing, merged: session.mode === 'merge', existingCount: session.skipped, chat: meta };
    },

    async abortChunkedImport(sessionId) {
      _importSessions.delete(sessionId);
      await _clearStage(sessionId).catch(function () {});
      return true;
    },

    async importChunkedJsonl(manifest, allMessages, opts) {
      const begin = await api.beginChunkedImport(manifest, opts || {});
      if (!begin.sessionId) return { chatId: begin.chatId, exists: true, chat: begin.chat, added: 0 };
      try {
        await api.appendChunkedImport(begin.sessionId, allMessages || []);
        return await api.finishChunkedImport(begin.sessionId);
      } catch (error) {
        await api.abortChunkedImport(begin.sessionId);
        throw error;
      }
    },

    async getAllMessages(chatId) {
      const chat = await _getChat(chatId);
      return api.getMessages(chatId, 0, chat ? chat.total : Number.MAX_SAFE_INTEGER);
    },

    async listChats() {
      try {
        const db = await _open();
        const list = await _request(db.transaction(CHAT_STORE, 'readonly').objectStore(CHAT_STORE).getAll(), []);
        return (list || []).sort(function (a, b) { return String(b.importedAt || '').localeCompare(String(a.importedAt || '')); });
      } catch (e) { return []; }
    },

    async getMessages(chatId, offset, limit) {
      const db = await _open();
      const start = Math.max(0, Number(offset) || 0);
      const need = Math.max(1, Number(limit) || 200);
      return new Promise(function (resolve) {
        const index = db.transaction(MSG_STORE, 'readonly').objectStore(MSG_STORE).index('byChatTime');
        const req = index.openCursor(IDBKeyRange.bound([chatId, 0, 0], [chatId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]));
        const items = [];
        let advanced = false;
        req.onsuccess = function () {
          const cursor = req.result;
          if (!cursor || items.length >= need) { resolve(items); return; }
          if (!advanced && start > 0) { advanced = true; cursor.advance(start); return; }
          advanced = true;
          items.push(cursor.value);
          cursor.continue();
        };
        req.onerror = function () { resolve([]); };
      });
    },

    async getMessagePosition(chatId, order) {
      try {
        const db = await _open();
        const tx = db.transaction(MSG_STORE, 'readonly');
        const store = tx.objectStore(MSG_STORE);
        const message = await _request(store.index('byChat').get([chatId, Number(order)]), null);
        if (!message) return -1;
        const countTx = db.transaction(MSG_STORE, 'readonly');
        const count = await _request(countTx.objectStore(MSG_STORE).index('byChatTime').count(IDBKeyRange.bound([chatId, 0, 0], [chatId, Number(message.timestamp) || 0, Number(message.order) || 0])), 0);
        return Math.max(0, Number(count) - 1);
      } catch (e) { return -1; }
    },

    async searchMessages(query, chatId, maxResults, filters) {
      const needle = String(query || '').trim().toLowerCase();
      filters = filters || {};
      const sender = String(filters.sender || '').trim().toLowerCase();
      if (!needle && !sender) return [];
      const limit = Math.min(Math.max(Number(maxResults) || 10, 1), 100);
      const from = filters.dateFrom ? new Date(filters.dateFrom + 'T00:00:00').getTime() : 0;
      const to = filters.dateTo ? new Date(filters.dateTo + 'T23:59:59.999').getTime() : Number.MAX_SAFE_INTEGER;
      const db = await _open();
      return new Promise(function (resolve) {
        const store = db.transaction(MSG_STORE, 'readonly').objectStore(MSG_STORE);
        const index = chatId ? store.index('byChatTime') : store.index('byTime');
        const range = chatId
          ? IDBKeyRange.bound([chatId, from, 0], [chatId, to, Number.MAX_SAFE_INTEGER])
          : IDBKeyRange.bound([from, '', 0], [to, '\uffff', Number.MAX_SAFE_INTEGER]);
        const req = index.openCursor(range, 'prev');
        const out = [];
        req.onsuccess = function () {
          const cursor = req.result;
          if (!cursor || out.length >= limit) { resolve(out); return; }
          const message = cursor.value;
          const textMatch = !needle || String(message.text || '').toLowerCase().includes(needle);
          const senderMatch = !sender || String(message.senderName || '').toLowerCase().includes(sender);
          if (textMatch && senderMatch) out.push({ chatId: message.chatId, order: message.order, timestamp: message.timestamp, time: message.time, senderName: message.senderName, text: message.text });
          cursor.continue();
        };
        req.onerror = function () { resolve([]); };
      });
    },

    async deleteChat(chatId) {
      try {
        await _deleteChatRecords(chatId, true);
        for (let i = metaCache.length - 1; i >= 0; i--) if (metaCache[i].chatId === chatId) metaCache.splice(i, 1);
        return true;
      } catch (e) { return false; }
    },

    async setSummary(chatId, summary, opts) {
      try {
        const chat = await _getChat(chatId);
        if (!chat) return false;
        chat.summary = summary;
        if (opts && opts.summaryUpTo !== undefined) chat.summaryUpTo = opts.summaryUpTo;
        if (opts && opts.summaryDate !== undefined) chat.summaryDate = opts.summaryDate;
        await _putChat(chat);
        await api.loadMetaCache();
        return true;
      } catch (e) { return false; }
    },

    async setDailyReport(chatId, date, payload) {
      try {
        const chat = await _getChat(chatId);
        if (!chat) return false;
        const report = typeof payload === 'string' ? payload : String((payload && payload.report) || '');
        const items = payload && Array.isArray(payload.items) ? payload.items : [];
        if (!Array.isArray(chat.dailyReports)) chat.dailyReports = [];
        const index = chat.dailyReports.findIndex(function (item) { return item.date === date; });
        const next = { date, report, items, stale: false, updatedAt: new Date().toISOString() };
        if (index >= 0) chat.dailyReports[index] = next; else chat.dailyReports.push(next);
        chat.dailyReports.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
        await _putChat(chat);
        await api.loadMetaCache();
        return true;
      } catch (e) { return false; }
    },

    async exportDatabase() {
      const db = await _open();
      const chats = await _request(db.transaction(CHAT_STORE, 'readonly').objectStore(CHAT_STORE).getAll(), []);
      const messages = await new Promise(function (resolve) {
        const out = [];
        const req = db.transaction(MSG_STORE, 'readonly').objectStore(MSG_STORE).openCursor();
        req.onsuccess = function () { const cursor = req.result; if (cursor) { out.push(cursor.value); cursor.continue(); } else resolve(out); };
        req.onerror = function () { resolve(out); };
      });
      return { format: 'mst-qqchats-backup', version: 1, exportedAt: new Date().toISOString(), chats, messages };
    },

    async restoreDatabase(backup) {
      if (!backup || backup.format !== 'mst-qqchats-backup' || !Array.isArray(backup.chats) || !Array.isArray(backup.messages)) throw new Error('不是有效的 QQ 聊天备份文件');
      if (backup.messages.length > MAX_RESTORE_MESSAGES) throw new Error('备份消息超过 50 万条，拒绝恢复');
      const chatIds = new Set(backup.chats.map(function (chat) { return String(chat.chatId || ''); }).filter(Boolean));
      const db = await _open();
      const tx = db.transaction([CHAT_STORE, MSG_STORE, STAGE_STORE], 'readwrite');
      const chats = tx.objectStore(CHAT_STORE);
      const messages = tx.objectStore(MSG_STORE);
      chats.clear(); messages.clear(); tx.objectStore(STAGE_STORE).clear();
      for (const chat of backup.chats) if (chat && chatIds.has(String(chat.chatId || ''))) chats.put(Object.assign({}, chat, { schemaVersion: 2 }));
      for (const message of backup.messages) {
        const chatId = String((message && message.chatId) || '');
        const order = Math.max(0, Number(message && message.order) || 0);
        if (!chatIds.has(chatId)) continue;
        messages.put(Object.assign({}, message, { chatId, order, msgKey: chatId + '::' + order, timestamp: Math.max(0, Number(message.timestamp) || 0), senderName: String(message.senderName || '未知'), text: String(message.text || '') }));
      }
      await _txDone(tx, '恢复 QQ 聊天备份失败');
      await api.loadMetaCache();
      return { chats: backup.chats.length, messages: backup.messages.length };
    },

    async getStats() {
      const db = await _open();
      const tx = db.transaction([CHAT_STORE, MSG_STORE], 'readonly');
      const counts = await Promise.all([
        _request(tx.objectStore(CHAT_STORE).count(), 0),
        _request(tx.objectStore(MSG_STORE).count(), 0)
      ]);
      const chats = counts[0];
      const messages = counts[1];
      return { chats: Number(chats) || 0, messages: Number(messages) || 0 };
    },

    async loadMetaCache() {
      if (!_stageCleanupDone && _importSessions.size === 0) {
        try {
          const db = await _open();
          const tx = db.transaction(STAGE_STORE, 'readwrite');
          tx.objectStore(STAGE_STORE).clear();
          await _txDone(tx, '清理未完成导入失败');
        } catch (e) {}
        _stageCleanupDone = true;
      }
      const list = await api.listChats();
      metaCache.length = 0;
      for (const chat of list) metaCache.push(chat);
      return metaCache;
    }
  };

  return api;
})();
