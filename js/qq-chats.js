// ═══════════════════════════════════════════════
//  QQ 聊天记录数据层（window.QQChats）
//  负责导入 qq-chat-exporter 导出的单文件 JSON 并存入 IndexedDB，
//  提供会话/消息的分页查询、关键词检索、删除与总结。
//  存储：IndexedDB 库 mst-qqchats（version 1）
//    - store chats（keyPath chatId）    会话元信息
//    - store messages（keyPath msgKey） 消息（索引 byChat: [chatId, order]）
//  依赖：无（纯 IndexedDB + FileReader，可用于 Electron 与 PWA）
// ═══════════════════════════════════════════════

window.QQChats = (function () {
  'use strict';

  const DB_NAME = 'mst-qqchats';
  const DB_VERSION = 1;
  const CHAT_STORE = 'chats';
  const MSG_STORE = 'messages';
  const BATCH_SIZE = 500;

  let _dbPromise = null;
  // 内存会话概览缓存：同步读取，供 AI 系统提示词注入（buildToolsSystemPrompt 为同步函数）
  let metaCache = [];

  // ── IDB 打开 ──
  function _open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(CHAT_STORE)) {
          db.createObjectStore(CHAT_STORE, { keyPath: 'chatId' });
        }
        if (!db.objectStoreNames.contains(MSG_STORE)) {
          const ms = db.createObjectStore(MSG_STORE, { keyPath: 'msgKey' });
          ms.createIndex('byChat', ['chatId', 'order']);
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开数据库失败')); };
    });
    return _dbPromise;
  }

  // 关闭连接并重置单例缓存：db.close() 后 _dbPromise 必须置空，
  // 否则后续 _open() 会复用已关闭的连接 → "The database connection is closing"
  function _closeDb(db) {
    try { if (db) db.close(); } catch (e) {}
    _dbPromise = null;
  }

  // ── 小工具 ──
  function _readFileText(file) {
    return new Promise(function (resolve, reject) {
      if (typeof file.text === 'function') {
        file.text().then(resolve).catch(function (e) { reject(e || new Error('文件读取失败')); });
        return;
      }
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function _getChat(chatId) {
    return _open().then(function (db) {
      return new Promise(function (resolve) {
        const req = db.transaction(CHAT_STORE, 'readonly').objectStore(CHAT_STORE).get(chatId);
        req.onsuccess = function () { _closeDb(db); resolve(req.result || null); };
        req.onerror = function () { _closeDb(db); resolve(null); };
      });
    });
  }

  function _putChat(meta) {
    return _open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(CHAT_STORE, 'readwrite');
        tx.objectStore(CHAT_STORE).put(meta);
        tx.oncomplete = function () { _closeDb(db); resolve(true); };
        tx.onerror = function () { _closeDb(db); reject(tx.error || new Error('保存会话失败')); };
      });
    });
  }

  function _putBatch(items) {
    return _open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(MSG_STORE, 'readwrite');
        const store = tx.objectStore(MSG_STORE);
        for (const it of items) store.put(it);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { _closeDb(db); reject(tx.error || new Error('写入消息失败')); };
      });
    });
  }

  // ── chatId 生成（确定性拼接）──
  function _buildChatId(info) {
    if (info.peerUin) return 'qq|' + info.chatType + '|' + info.peerUin;
    if (info.selfUin) return 'qq|' + info.chatType + '|' + info.selfUin + '|' + info.peerUin;
    return 'qq|' + (info.name || '会话') + '|' + info.chatType + '|' + (info.total || 0) + '|' + (info.timeStart || 0);
  }

  // ── 提取 / 归一化 ──
  // 兼容两种源：
  //   - 单文件 JSON：statistics.total / participants / timeRange.start(end)（毫秒）
  //   - JSONL manifest：statistics.totalMessages / senders[] / timeRange.start(end)（ISO 字符串）
  function _parseChatInfo(json) {
    const ci = json.chatInfo || {};
    const st = json.statistics || {};
    let chatType = 'private';
    if (ci.type === 'group') chatType = 'group';
    else if (ci.type === 'temp') chatType = 'temp';
    // totalMessages 优先（JSONL），回退 total，再回退消息数
    let total = Number(st.totalMessages) || Number(st.total) || 0;
    if (!total && Array.isArray(json.messages)) total = json.messages.length;
    // senders 可能是数字（单文件）或数组（JSONL）
    const participants = Array.isArray(st.senders) ? st.senders.length : (Number(st.participants) || 0);
    // timeRange.start 可能是毫秒数（单文件）或 ISO 字符串（JSONL）
    const ts = st.timeRange && st.timeRange.start;
    const te = st.timeRange && st.timeRange.end;
    return {
      name: ci.name || ci.peerName || 'QQ 会话',
      chatType: chatType,
      peerUin: String(ci.peerUin || ci.peerUid || ''),
      selfUin: String(ci.selfUin || ci.selfUid || ''),
      selfName: ci.selfName || '我',
      avatarUrl: ci.avatar || '',
      total: total,
      participants: participants,
      timeStart: _toTs(ts),
      timeEnd: _toTs(te)
    };
  }

  // 把毫秒数或 ISO 时间字符串统一转成毫秒时间戳
  function _toTs(v) {
    if (!v) return 0;
    const n = Number(v);
    if (!isNaN(n) && n > 0) return n;
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  function _normalizeMessages(chatId, rawMessages) {
    const out = [];
    for (let i = 0; i < rawMessages.length; i++) {
      const m = rawMessages[i] || {};
      const s = m.sender || {};
      const content = m.content || {};
      // time 可能是 "YYYY-MM-DD HH:mm:ss"（单文件）或 ISO（JSONL），统一成可读格式
      let time = String(m.time || '');
      const t = Number(m.timestamp) || 0;
      if (!time && t) time = _fmtTime(t);
      else if (time && /T.*Z$|T.*[+-]\d\d:?\d\d$/.test(time) && t) time = _fmtTime(t); // ISO → 可读
      out.push({
        msgKey: chatId + '::' + i,
        chatId: chatId,
        order: i,
        id: String(m.id || ''),
        timestamp: t,
        time: time,
        senderName: s.name || s.nickname || '未知',
        senderUin: String(s.uin || s.uid || ''),
        text: String(content.text || ''),
        type: String(m.type || m.messageType || ''),
        recalled: !!m.recalled,
        system: !!m.system
      });
    }
    return out;
  }

  function _fmtTime(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function _buildChatMeta(chatId, info, msgs, importedAt) {
    let timeStart = info.timeStart || 0;
    let timeEnd = info.timeEnd || 0;
    let lastText = '';
    for (const m of msgs) {
      if (m.timestamp && (!timeStart || m.timestamp < timeStart)) timeStart = m.timestamp;
      if (m.timestamp && m.timestamp > timeEnd) timeEnd = m.timestamp;
      if (m.text) lastText = m.text;
    }
    return {
      chatId: chatId,
      name: info.name,
      chatType: info.chatType,
      peerUin: info.peerUin,
      selfUin: info.selfUin,
      selfName: info.selfName || '我',
      avatarUrl: info.avatarUrl || '',
      total: msgs.length,
      participants: info.participants || 0,
      timeStart: timeStart,
      timeEnd: timeEnd,
      importedAt: importedAt,
      lastMessageText: lastText,
      summary: '',
      summaryUpTo: 0, // 已总结到第几条消息（order 游标，用于增量总结）
      summaryDate: '', // 上次总结的日期（YYYY-MM-DD，用于分块展示）
      dailyReports: [] // 绿群日报式：按天生成的日报数组 [{ date, title, report }]
    };
  }

  // ── 合并导入辅助 ──
  // 读取已有会话的全部消息 id / 指纹 / 最大 order（用于去重与续接）
  function _getExistingMsgInfo(chatId) {
    return _open().then(function (db) {
      return new Promise(function (resolve) {
        const tx = db.transaction(MSG_STORE, 'readonly');
        const idx = tx.objectStore(MSG_STORE).index('byChat');
        const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
        const req = idx.openCursor(range);
        const ids = new Set();
        const fingerprints = new Set();
        let maxOrder = -1;
        let count = 0;
        req.onsuccess = function () {
          const cur = req.result;
          if (cur) {
            const v = cur.value;
            if (v.id) ids.add(v.id);
            const fp = v.fingerprint || _msgFingerprint(v);
            if (fp) fingerprints.add(fp);
            if (v.order > maxOrder) maxOrder = v.order;
            count++;
            cur.continue();
          } else {
            _closeDb(db);
            resolve({ ids: ids, fingerprints: fingerprints, maxOrder: maxOrder, count: count });
          }
        };
        req.onerror = function () { _closeDb(db); resolve({ ids: new Set(), fingerprints: new Set(), maxOrder: -1, count: 0 }); };
      });
    });
  }

  // 消息去重指纹：timestamp + senderUin + text（无 id 时用）
  function _msgFingerprint(m) {
    const t = (m.timestamp || 0) + '|' + (m.senderUin || '') + '|' + String(m.text || '');
    return t;
  }

  // 合并去重：把新消息 merge 进已有会话
  // existingInfo: { ids, fingerprints, maxOrder }
  // 返回 { toAdd: [], existingCount: number }（toAdd 已带正确的 order 续接）
  function _dedupeMerge(existingInfo, newMsgs) {
    const toAdd = [];
    let existingCount = 0;
    let order = existingInfo.maxOrder + 1;
    for (const m of newMsgs) {
      if (m.id && existingInfo.ids.has(m.id)) { existingCount++; continue; }
      const fp = _msgFingerprint(m);
      if (existingInfo.fingerprints.has(fp)) { existingCount++; continue; }
      m.order = order++;
      m.msgKey = m.chatId + '::' + m.order;
      m.fingerprint = fp;
      toAdd.push(m);
    }
    return { toAdd: toAdd, existingCount: existingCount };
  }

  // 合并后按时间重排会话消息：读取全部 → 按 timestamp 升序 → 重写 order/msgKey 回写 IDB
  // 返回重排后的消息数组（order 已按时间重排）
  async function _reorderChatByTime(chatId) {
    try {
      const db = await _open();
      const all = await new Promise(function (resolve) {
        const tx = db.transaction(MSG_STORE, 'readonly');
        const idx = tx.objectStore(MSG_STORE).index('byChat');
        const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
        const req = idx.openCursor(range);
        const items = [];
        req.onsuccess = function () {
          const cur = req.result;
          if (cur) { items.push(cur.value); cur.continue(); }
          else { _closeDb(db); resolve(items); }
        };
        req.onerror = function () { _closeDb(db); resolve([]); };
      });
      if (all.length <= 1) return all;
      // 按 timestamp 升序稳定排序（同时间保持导入顺序）
      all.sort(function (a, b) { return (a.timestamp - b.timestamp) || (a.order - b.order); });
      // 重写 order 与 msgKey
      for (let i = 0; i < all.length; i++) {
        all[i].order = i;
        all[i].msgKey = chatId + '::' + i;
      }
      // 清空该会话旧消息，再分批重写
      const db2 = await _open();
      await new Promise(function (resolve) {
        const tx = db2.transaction(MSG_STORE, 'readwrite');
        const idx = tx.objectStore(MSG_STORE).index('byChat');
        const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
        const req = idx.openCursor(range);
        req.onsuccess = function () {
          const cur = req.result;
          if (cur) { cur.delete(); cur.continue(); }
          else {
            tx.oncomplete = function () { _closeDb(db2); resolve(true); };
            tx.onerror = function () { _closeDb(db2); resolve(true); };
          }
        };
      });
      for (let i = 0; i < all.length; i += BATCH_SIZE) {
        await _putBatch(all.slice(i, i + BATCH_SIZE));
      }
      return all;
    } catch (e) { return null; }
  }

  // 合并后更新会话 meta：保留 summary/dailyReports，刷新总数/时间/最后消息
  function _buildMergedMeta(chatId, oldMeta, info, allMsgs, importedAt) {
    let timeStart = info.timeStart || 0;
    let timeEnd = info.timeEnd || 0;
    let lastText = '';
    for (const m of allMsgs) {
      if (m.timestamp && (!timeStart || m.timestamp < timeStart)) timeStart = m.timestamp;
      if (m.timestamp && m.timestamp > timeEnd) timeEnd = m.timestamp;
      if (m.text) lastText = m.text;
    }
    return Object.assign({}, oldMeta, {
      name: info.name || oldMeta.name,
      chatType: info.chatType || oldMeta.chatType,
      peerUin: info.peerUin || oldMeta.peerUin,
      selfUin: info.selfUin || oldMeta.selfUin,
      total: allMsgs.length,
      participants: info.participants || oldMeta.participants || 0,
      timeStart: timeStart,
      timeEnd: timeEnd,
      importedAt: importedAt,
      lastMessageText: lastText
    });
  }

  // ═══════════════ 公开 API ═══════════════
  return {
    metaCache: metaCache,

    // 导入 qq-chat-exporter 单文件 JSON。
    // opts: { force: bool（已存在时是否覆盖）, merge: bool（合并去重追加）, onProgress: fn(done, total) }
    // 返回 { chatId, added, exists, chat, merged }
    //  - merge=true 且已存在：按消息 id/指纹去重，新消息续接 order 追加，保留旧 summary/dailyReports
    //  - 若已存在且未传 force/merge：返回 { chatId, exists: true, chat: 旧会话 }，不写入
    async importJsonFile(file, opts) {
      opts = opts || {};
      const text = await _readFileText(file);
      let json;
      try { json = JSON.parse(text); }
      catch (e) { throw new Error('JSON 解析失败：' + (e && e.message ? e.message : e)); }
      if (!json || typeof json !== 'object' || !Array.isArray(json.messages)) {
        throw new Error('不是有效的 qq-chat-exporter JSON：缺少 messages 数组');
      }

      const info = _parseChatInfo(json);
      const chatId = _buildChatId(info);
      const msgs = _normalizeMessages(chatId, json.messages);

      const existing = await _getChat(chatId);
      // ── 合并模式：已存在时去重追加 ──
      if (existing && opts.merge) {
        const existingInfo = await _getExistingMsgInfo(chatId);
        const dedupe = _dedupeMerge(existingInfo, msgs);
        const toAdd = dedupe.toAdd;
        const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
        const total = toAdd.length;
        if (total > 0) {
          for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = toAdd.slice(i, i + BATCH_SIZE);
            await _putBatch(batch);
            if (onProgress) onProgress(Math.min(i + batch.length, total), total);
          }
        }
        // 合并后按时间重排全部消息（保证时间顺序）
        const allMsgs = await _reorderChatByTime(chatId);
        const mergedMeta = _buildMergedMeta(chatId, existing, info, allMsgs || [], new Date().toISOString());
        await _putChat(mergedMeta);
        await this.loadMetaCache();
        return { chatId: chatId, added: toAdd.length, exists: true, merged: true, existingCount: dedupe.existingCount, chat: mergedMeta };
      }
      if (existing && !opts.force) {
        return { chatId: chatId, exists: true, chat: existing, added: 0 };
      }
      if (existing) {
        await this.deleteChat(chatId);
      }

      const total = msgs.length;
      const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
      if (total > 0) {
        for (let i = 0; i < total; i += BATCH_SIZE) {
          const batch = msgs.slice(i, i + BATCH_SIZE);
          await _putBatch(batch);
          if (onProgress) onProgress(Math.min(i + batch.length, total), total);
        }
      }

      const meta = _buildChatMeta(chatId, info, msgs, new Date().toISOString());
      await _putChat(meta);

      await this.loadMetaCache();
      return { chatId: chatId, added: msgs.length, exists: false, chat: meta };
    },

    // 导入 qq-chat-exporter 流式导出的 JSONL 分块数据。
    // manifest：已解析的 manifest.json（含 chatInfo + statistics + chunked.chunks）
    // allMessages：合并后的全部消息对象数组（由调用方从各 chunk 读取拼接）
    // opts: { force: bool（覆盖）, merge: bool（合并去重追加）, onProgress: fn(done, total) }
    // 返回同 importJsonFile（merge 时带 merged/existingCount）
    async importChunkedJsonl(manifest, allMessages, opts) {
      opts = opts || {};
      if (!manifest || !manifest.chatInfo || !Array.isArray(allMessages)) {
        throw new Error('不是有效的 qq-chat-exporter JSONL 数据：缺少 chatInfo 或消息数组');
      }
      const info = _parseChatInfo(manifest);
      const chatId = _buildChatId(info);
      const msgs = _normalizeMessages(chatId, allMessages);

      const existing = await _getChat(chatId);
      // ── 合并模式：已存在时去重追加 ──
      if (existing && opts.merge) {
        const existingInfo = await _getExistingMsgInfo(chatId);
        const dedupe = _dedupeMerge(existingInfo, msgs);
        const toAdd = dedupe.toAdd;
        const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
        const total = toAdd.length;
        if (total > 0) {
          for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = toAdd.slice(i, i + BATCH_SIZE);
            await _putBatch(batch);
            if (onProgress) onProgress(Math.min(i + batch.length, total), total);
          }
        }
        const allMsgs = await _reorderChatByTime(chatId);
        const mergedMeta = _buildMergedMeta(chatId, existing, info, allMsgs || [], new Date().toISOString());
        await _putChat(mergedMeta);
        await this.loadMetaCache();
        return { chatId: chatId, added: toAdd.length, exists: true, merged: true, existingCount: dedupe.existingCount, chat: mergedMeta };
      }
      if (existing && !opts.force) {
        return { chatId: chatId, exists: true, chat: existing, added: 0 };
      }
      if (existing) {
        await this.deleteChat(chatId);
      }

      const total = msgs.length;
      const onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;
      if (total > 0) {
        for (let i = 0; i < total; i += BATCH_SIZE) {
          const batch = msgs.slice(i, i + BATCH_SIZE);
          await _putBatch(batch);
          if (onProgress) onProgress(Math.min(i + batch.length, total), total);
        }
      }

      const meta = _buildChatMeta(chatId, info, msgs, new Date().toISOString());
      await _putChat(meta);

      await this.loadMetaCache();
      return { chatId: chatId, added: msgs.length, exists: false, chat: meta };
    },

    // 读取某会话的全部消息（按 order 升序，用于合并后重算 meta）
    async getAllMessages(chatId) {
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const tx = db.transaction(MSG_STORE, 'readonly');
          const idx = tx.objectStore(MSG_STORE).index('byChat');
          const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
          const req = idx.openCursor(range);
          const items = [];
          req.onsuccess = function () {
            const cur = req.result;
            if (cur) { items.push(cur.value); cur.continue(); }
            else { _closeDb(db); resolve(items); }
          };
          req.onerror = function () { _closeDb(db); resolve([]); };
        });
      } catch (e) { return []; }
    },

    // 会话列表（按导入时间倒序）
    async listChats() {
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const req = db.transaction(CHAT_STORE, 'readonly').objectStore(CHAT_STORE).getAll();
          req.onsuccess = function () {
            _closeDb(db);
            const arr = req.result || [];
            arr.sort(function (a, b) { return (a.importedAt < b.importedAt ? 1 : -1); });
            resolve(arr);
          };
          req.onerror = function () { _closeDb(db); resolve([]); };
        });
      } catch (e) { return []; }
    },

    // 按 byChat 索引分页取消息（offset 起 limit 条，按导入顺序）
    async getMessages(chatId, offset, limit) {
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const tx = db.transaction(MSG_STORE, 'readonly');
          const idx = tx.objectStore(MSG_STORE).index('byChat');
          const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
          const req = idx.openCursor(range);
          const items = [];
          let skipped = 0;
          const need = limit > 0 ? limit : 200;
          req.onsuccess = function () {
            const cur = req.result;
            if (!cur) { _closeDb(db); resolve(items); return; }
            if (skipped < offset) { skipped++; cur.continue(); return; }
            if (items.length >= need) { _closeDb(db); resolve(items); return; }
            items.push(cur.value);
            cur.continue();
          };
          req.onerror = function () { _closeDb(db); resolve([]); };
        });
      } catch (e) { return []; }
    },

    // 关键词检索消息（O(n) 全表/单会话扫描，限制返回条数）
    // 返回 [{ chatId, timestamp, time, senderName, text }]
    async searchMessages(query, chatId, maxResults) {
      const q = String(query || '').toLowerCase();
      if (!q) return [];
      const limit = Math.min(Number(maxResults) || 10, 20);
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const tx = db.transaction(MSG_STORE, 'readonly');
          const store = tx.objectStore(MSG_STORE);
          const req = chatId
            ? store.index('byChat').openCursor(IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]))
            : store.openCursor();
          const out = [];
          req.onsuccess = function () {
            const cur = req.result;
            if (!cur || out.length >= limit) { _closeDb(db); resolve(out); return; }
            const m = cur.value;
            if (String(m.text || '').toLowerCase().indexOf(q) !== -1) {
              out.push({
                chatId: m.chatId,
                order: m.order,
                timestamp: m.timestamp,
                time: m.time,
                senderName: m.senderName,
                text: m.text
              });
            }
            cur.continue();
          };
          req.onerror = function () { _closeDb(db); resolve([]); };
        });
      } catch (e) { return []; }
    },

    // 删除会话及其全部消息
    async deleteChat(chatId) {
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const tx = db.transaction([CHAT_STORE, MSG_STORE], 'readwrite');
          tx.objectStore(CHAT_STORE).delete(chatId);
          const idx = tx.objectStore(MSG_STORE).index('byChat');
          const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
          const req = idx.openCursor(range);
          req.onsuccess = function () {
            const cur = req.result;
            if (cur) { cur.delete(); cur.continue(); }
          };
          tx.oncomplete = function () {
            _closeDb(db);
            // 同步清理内存缓存（原地修改，保持内部与公开引用一致）
            for (let i = metaCache.length - 1; i >= 0; i--) {
              if (metaCache[i].chatId === chatId) metaCache.splice(i, 1);
            }
            resolve(true);
          };
          tx.onerror = function () { _closeDb(db); resolve(false); };
        });
      } catch (e) { return false; }
    },

    // 保存会话 AI 总结（opts: { summaryUpTo, summaryDate }，同步更新 metaCache）
    async setSummary(chatId, summary, opts) {
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const tx = db.transaction(CHAT_STORE, 'readwrite');
          const store = tx.objectStore(CHAT_STORE);
          const getReq = store.get(chatId);
          getReq.onsuccess = function () {
            const c = getReq.result;
            if (c) {
              c.summary = summary;
              if (typeof opts === 'object' && opts) {
                if (opts.summaryUpTo !== undefined) c.summaryUpTo = opts.summaryUpTo;
                if (opts.summaryDate !== undefined) c.summaryDate = opts.summaryDate;
              }
              store.put(c);
            }
          };
          tx.oncomplete = function () {
            _closeDb(db);
            // 原地更新缓存（若已有该会话则直接改，否则以最新列表刷新）
            const mc = metaCache.find(function (x) { return x.chatId === chatId; });
            if (mc) {
              mc.summary = summary;
              if (typeof opts === 'object' && opts) {
                if (opts.summaryUpTo !== undefined) mc.summaryUpTo = opts.summaryUpTo;
                if (opts.summaryDate !== undefined) mc.summaryDate = opts.summaryDate;
              }
            }
            resolve(true);
          };
          tx.onerror = function () { _closeDb(db); resolve(false); };
        });
      } catch (e) { return false; }
    },

    // 保存某一天的日报（绿群日报式：按天 upsert dailyReports）
    // payload: string 兼容旧数据；对象 { report, items }，items=[{ text, order }] 用于条目跳转
    async setDailyReport(chatId, date, payload) {
      const report = (typeof payload === 'string') ? payload : (payload && payload.report ? payload.report : '');
      const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
      try {
        const db = await _open();
        return new Promise(function (resolve) {
          const tx = db.transaction(CHAT_STORE, 'readwrite');
          const store = tx.objectStore(CHAT_STORE);
          const getReq = store.get(chatId);
          getReq.onsuccess = function () {
            const c = getReq.result;
            if (c) {
              if (!Array.isArray(c.dailyReports)) c.dailyReports = [];
              const idx = c.dailyReports.findIndex(function (d) { return d.date === date; });
              if (idx >= 0) { c.dailyReports[idx].report = report; c.dailyReports[idx].items = items; }
              else c.dailyReports.push({ date: date, report: report, items: items });
              // 按日期倒序（最新在前）
              c.dailyReports.sort(function (a, b) { return (a.date < b.date ? 1 : -1); });
              store.put(c);
            }
          };
          tx.oncomplete = function () {
            _closeDb(db);
            // 同步更新内存缓存
            const mc = metaCache.find(function (x) { return x.chatId === chatId; });
            if (mc) {
              if (!Array.isArray(mc.dailyReports)) mc.dailyReports = [];
              const idx = mc.dailyReports.findIndex(function (d) { return d.date === date; });
              if (idx >= 0) { mc.dailyReports[idx].report = report; mc.dailyReports[idx].items = items; }
              else mc.dailyReports.push({ date: date, report: report, items: items });
              mc.dailyReports.sort(function (a, b) { return (a.date < b.date ? 1 : -1); });
            }
            resolve(true);
          };
          tx.onerror = function () { _closeDb(db); resolve(false); };
        });
      } catch (e) { return false; }
    },

    // 重新加载内存会话概览缓存（原地更新，保证 metaCache 引用一致）
    async loadMetaCache() {
      const list = await this.listChats();
      metaCache.length = 0;
      for (const c of list) metaCache.push(c);
      return metaCache;
    }
  };
})();
