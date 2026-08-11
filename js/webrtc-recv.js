// ═══════════════════════════════════════════════════════════════════
// js/webrtc-recv.js — 手机端 PWA 接收端 + IndexedDB PDF 存储
// 通过 Supabase Realtime broadcast channel 与桌面发送端交换 WebRTC
// 信令（SDP/ICE），DataChannel 按 64KB 分片接收 PDF，重组后写入
// IndexedDB（key: pdf:<bookId>），供 pdf.js 离线阅读。
//
// 同时提供 window.BookPdfStore（books-ai.js 的 bkOpenPdfAtPage 调用）：
//   - BookPdfStore.read(bookId)  → 返回 Uint8Array 或 null
//   - BookPdfStore.exists(bookId) → boolean
//   - BookPdfStore.list()         → [{bookId, fileName, size, savedAt}]
//   - BookPdfStore.remove(bookId)
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const IDB_NAME = 'mst-pdf';
  const IDB_STORE = 'pdfs';
  const CHUNK_SIZE = 64 * 1024;   // 64KB

  // ── IndexedDB PDF 存储 ────────────────────────────────
  function _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no-indexeddb')); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: 'bookId' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  const BookPdfStore = {
    async read(bookId) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(String(bookId));
          req.onsuccess = function () {
            db.close();
            const rec = req.result;
            resolve(rec && rec.data ? new Uint8Array(rec.data) : null);
          };
          req.onerror = function () { db.close(); resolve(null); };
        });
      } catch (e) { return null; }
    },
    async exists(bookId) {
      const data = await BookPdfStore.read(bookId);
      return !!data;
    },
    async list() {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
          req.onsuccess = function () {
            db.close();
            const recs = req.result || [];
            resolve(recs.map(r => ({ bookId: r.bookId, fileName: r.fileName || '', size: (r.data || []).length, savedAt: r.savedAt || 0 })));
          };
          req.onerror = function () { db.close(); resolve([]); };
        });
      } catch (e) { return []; }
    },
    async remove(bookId) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).delete(String(bookId));
          tx.oncomplete = function () { db.close(); resolve(); };
          tx.onerror = function () { db.close(); resolve(); };
        });
      } catch (e) { /* 忽略 */ }
    },
    async put(bookId, data, fileName) {
      try {
        const db = await _open();
        return new Promise((resolve) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put({ bookId: String(bookId), data: Array.from(data), fileName: fileName || '', savedAt: Date.now() });
          tx.oncomplete = function () { db.close(); resolve(true); };
          tx.onerror = function () { db.close(); resolve(false); };
        });
      } catch (e) { return false; }
    }
  };
  global.BookPdfStore = BookPdfStore;

  // ── 接收端状态 ────────────────────────────────────────
  let rcvClient = null;          // Supabase 客户端
  let rcvChannel = null;         // Realtime broadcast channel
  let rcvPeer = null;            // RTCPeerConnection
  let rcvDataChannel = null;
  let rcvConnected = false;
  let rcvBuf = null;             // 接收重组缓冲 {chunks:[...], received, total, meta}
  let rcvRcvdBytes = 0;
  let rcvOnStatus = null;

  function _emitStatus(status) {
    if (rcvOnStatus) { try { rcvOnStatus(status); } catch (e) {} }
  }

  // ── 开始接收：输入配对码，等待桌面端发起 ──────────────
  function startReceive(code, opts) {
    opts = opts || {};
    rcvOnStatus = opts.onStatus || null;
    if (typeof getSupabaseClient !== 'function') { _emitStatus({ phase: 'error', message: '未配置 Supabase，无法配对' }); return; }
    rcvClient = getSupabaseClient();
    if (!rcvClient) { _emitStatus({ phase: 'error', message: 'Supabase 客户端不可用' }); return; }

    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) { _emitStatus({ phase: 'error', message: '配对码应为 6 位数字' }); return; }

    _emitStatus({ phase: 'waiting', message: '等待桌面端连接…（配对码 ' + code + '）' });

    // 加入 broadcast channel
    try {
      rcvChannel = rcvClient.channel('pdf-transfer-' + code, {
        config: { broadcast: { self: false } }
      });
      rcvChannel.on('broadcast', { event: 'offer' }, (payload) => _onOffer(payload));
      rcvChannel.on('broadcast', { event: 'ice' }, (payload) => _onIce(payload));
      rcvChannel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          // 通知桌面端手机已就绪
          rcvChannel.send({ type: 'broadcast', event: 'ready', payload: {} });
        } else if (err) {
          _emitStatus({ phase: 'error', message: '配对频道订阅失败：' + String(err && err.message || err) });
        }
      });
    } catch (e) {
      _emitStatus({ phase: 'error', message: '无法加入配对频道：' + String(e) });
    }
  }

  async function _onOffer(payload) {
    const sdp = payload && payload.sdp;
    if (!sdp) return;
    _emitStatus({ phase: 'connecting', message: '收到桌面端连接请求，正在建立…' });

    rcvPeer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }]
    });
    rcvPeer.onicecandidate = function (e) {
      if (e.candidate && rcvChannel) {
        rcvChannel.send({ type: 'broadcast', event: 'ice', payload: { candidate: e.candidate.toJSON() } });
      }
    };
    rcvPeer.ondatachannel = function (ev) {
      rcvDataChannel = ev.channel;
      _setupDataChannel(rcvDataChannel);
    };

    try {
      await rcvPeer.setRemoteDescription({ type: 'offer', sdp: sdp });
      const answer = await rcvPeer.createAnswer();
      await rcvPeer.setLocalDescription(answer);
      if (rcvChannel) {
        rcvChannel.send({ type: 'broadcast', event: 'answer', payload: { sdp: rcvPeer.localDescription.sdp } });
      }
    } catch (e) {
      _emitStatus({ phase: 'error', message: '信令应答失败：' + String(e) });
    }
  }

  function _onIce(payload) {
    if (!rcvPeer || !payload || !payload.candidate) return;
    try {
      rcvPeer.addIceCandidate(payload.candidate);
    } catch (e) { /* 忽略过期 candidate */ }
  }

  function _setupDataChannel(dc) {
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () { rcvConnected = true; _emitStatus({ phase: 'transfer', progress: 0, message: '连接已建立，等待传输…' }); };
    dc.onclose = function () { rcvConnected = false; _emitStatus({ phase: 'idle', message: '传输连接已关闭' }); };
    dc.onerror = function (e) { _emitStatus({ phase: 'error', message: '传输错误' }); };
    dc.onmessage = function (ev) { _onDataMessage(ev.data); };
  }

  function _onDataMessage(data) {
    // 元数据 JSON
    if (typeof data === 'string') {
      try {
        const meta = JSON.parse(data);
        if (meta.type === 'meta') {
          rcvBuf = {
            bookId: String(meta.bookId),
            fileName: meta.fileName || '',
            total: Number(meta.total) || 0,
            chunks: new Array(Math.ceil((Number(meta.total) || 0) / CHUNK_SIZE)),
            received: 0
          };
          rcvRcvdBytes = 0;
          _emitStatus({ phase: 'transfer', progress: 0, message: '开始接收「' + (meta.fileName || meta.bookId) + '」…' });
        } else if (meta.type === 'end') {
          _onTransferComplete();
        }
      } catch (e) { /* 非元数据 */ }
      return;
    }

    // 二进制分片
    if (!rcvBuf) return;
    const totalChunks = rcvBuf.chunks.length;
    const idx = rcvRcvdBytes;
    const chunkArr = new Uint8Array(data);
    const chunkIdx = Math.floor(idx / CHUNK_SIZE);
    if (chunkIdx < totalChunks) {
      rcvBuf.chunks[chunkIdx] = chunkArr;
      rcvBuf.received++;
      rcvRcvdBytes += chunkArr.length;
      const progress = rcvBuf.total ? Math.min(99, Math.floor(rcvRcvdBytes / rcvBuf.total * 100)) : 0;
      _emitStatus({ phase: 'transfer', progress: progress, message: '接收中… ' + (rcvRcvdBytes / 1024 / 1024).toFixed(1) + ' / ' + (rcvBuf.total / 1024 / 1024).toFixed(1) + ' MB' });
    }
  }

  async function _onTransferComplete() {
    if (!rcvBuf) return;
    const totalBytes = rcvBuf.chunks.reduce((s, c) => s + (c ? c.length : 0), 0);
    const full = new Uint8Array(totalBytes);
    let off = 0;
    for (const c of rcvBuf.chunks) {
      if (c) { full.set(c, off); off += c.length; }
    }
    const ok = await BookPdfStore.put(rcvBuf.bookId, full, rcvBuf.fileName);
    const meta = rcvBuf;
    rcvBuf = null;
    rcvRcvdBytes = 0;
    if (ok) {
      _emitStatus({ phase: 'done', progress: 100, message: '「' + (meta.fileName || meta.bookId) + '」接收完成，已保存到本机，可离线阅读。', bookId: meta.bookId, fileName: meta.fileName });
    } else {
      _emitStatus({ phase: 'error', message: '保存 PDF 失败（存储空间不足？）' });
    }
    stopReceive();
  }

  // ── 停止接收 ──────────────────────────────────────────
  function stopReceive() {
    if (rcvDataChannel) { try { rcvDataChannel.close(); } catch (e) {} rcvDataChannel = null; }
    if (rcvPeer) { try { rcvPeer.close(); } catch (e) {} rcvPeer = null; }
    if (rcvChannel) { try { rcvChannel.unsubscribe(); } catch (e) {} rcvChannel = null; }
    rcvConnected = false;
    rcvBuf = null;
    rcvRcvdBytes = 0;
  }

  global.WebRtcRecv = {
    startReceive,
    stopReceive,
    get connected() { return rcvConnected; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
