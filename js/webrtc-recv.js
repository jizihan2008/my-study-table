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
  // 本地信令（局域网）状态
  let rcvSigBase = null;         // http://<桌面IP>:<port>
  let rcvPollTimer = null;       // 轮询定时器
  let rcvLastSeq = 0;            // 已拉取到的最大 seq
  let rcvPolling = false;

  function _emitStatus(status) {
    if (rcvOnStatus) { try { rcvOnStatus(status); } catch (e) {} }
  }

  // ── 本地信令：POST 一条信令到桌面端服务器 ──
  async function _rcvSigPost(event, payload) {
    if (!rcvSigBase) return;
    try {
      const res = await fetch(rcvSigBase + '/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: rcvSigCode, event: event, payload: payload || {}, from: 'recv' })
      });
      return res.ok;
    } catch (e) { console.warn('[webrtc-recv] 信令发送失败:', e); return false; }
  }

  let rcvSigCode = null;
  let rcvConnFailCount = 0;    // 连续连接失败计数（用于判断是否地址错误）
  let rcvStartedOffer = false; // 是否已收到 offer 并建立 peer
  // ── 本地信令：轮询拉取桌面端发来的信令（offer/ice）──
  function _startSigPolling() {
    if (rcvPollTimer) { clearTimeout(rcvPollTimer); rcvPollTimer = null; }
    rcvPolling = false;
    const tick = async function () {
      if (!rcvSigBase) return;
      try {
        const res = await fetch(rcvSigBase + '/signal/' + rcvSigCode + '?since=' + rcvLastSeq);
        if (res.ok) {
          rcvConnFailCount = 0;   // 连接正常，重置失败计数
          const data = await res.json();
          if (data && Array.isArray(data.items)) {
            for (const it of data.items) {
              rcvLastSeq = Math.max(rcvLastSeq, it.seq);
              console.log('[webrtc-recv] 本地信令收到:', it.event);
              if (it.event === 'offer') { rcvStartedOffer = true; _onOffer(it.payload || {}); }
              else if (it.event === 'ice') { _onIce(it.payload || {}); }
            }
          }
        } else {
          rcvConnFailCount++;
        }
      } catch (e) {
        rcvConnFailCount++;
        // CORS/网络失败：连续失败提示地址可能不对
        if (rcvConnFailCount === 3) {
          _emitStatus({ phase: 'error', message: '无法连接桌面端信令服务器。请确认：① 电脑端使用的是 Electron 桌面版（不是网页版），并已重启；② IP/端口填写的是电脑弹窗中显示的局域网 IP；③ 手机和电脑在同一网络。' });
        }
      }
      // 已建立 P2P 连接后停止轮询，避免无用请求
      if (rcvConnected) { _stopSigPolling(); return; }
      rcvPollTimer = setTimeout(tick, 400);
    };
    rcvPollTimer = setTimeout(tick, 200);
  }
  function _stopSigPolling() {
    if (rcvPollTimer) { clearTimeout(rcvPollTimer); rcvPollTimer = null; }
    rcvPolling = false;
  }

  // ── 开始接收：输入配对码 + 桌面端 IP，等待桌面端发起 ──────────────
  function startReceive(code, opts) {
    opts = opts || {};
    rcvOnStatus = opts.onStatus || null;
    // 优先使用本地信令：需要桌面端 IP（同 WiFi，纯局域网）
    if (opts.ip) {
      code = String(code || '').replace(/\D/g, '');
      if (code.length !== 6) { _emitStatus({ phase: 'error', message: '配对码应为 6 位数字' }); return; }
      const ip = String(opts.ip).trim();
      const port = Number(opts.port) || 0;
      if (!ip || !port) { _emitStatus({ phase: 'error', message: '请填写桌面端 IP 与端口' }); return; }
      rcvSigCode = code;
      rcvSigBase = 'http://' + ip + ':' + port;
      rcvConnFailCount = 0;
      rcvStartedOffer = false;
      _emitStatus({ phase: 'waiting', message: '正在连接桌面端 ' + ip + ':' + port + '（配对码 ' + code + '）…' });
      // 通知桌面端已就绪，并开始轮询桌面端发来的信令
      _rcvSigPost('ready', {}).then((ok) => {
        if (!ok) {
          _emitStatus({ phase: 'error', message: '无法连接桌面端信令服务器 ' + ip + ':' + port + '（被拒绝或 CORS 拦截）。请确认：① 电脑端使用 Electron 桌面版并已重启；② IP/端口是电脑弹窗显示的真实局域网地址（如 192.168.x.x）；③ 手机与电脑在同一网络。' });
          return;
        }
        _startSigPolling();
      }).catch((e) => {
        _emitStatus({ phase: 'error', message: '无法连接桌面端信令服务器：' + String(e) });
      });
      return;
    }

    // 降级：无 IP 时回退到 Supabase Realtime 信令
    if (typeof getSupabaseClient !== 'function') { _emitStatus({ phase: 'error', message: '未配置信令通道，无法配对' }); return; }
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
      rcvChannel.on('broadcast', { event: 'offer' }, (p) => { console.log('[webrtc-recv] 收到 offer'); _onOffer(p); });
      rcvChannel.on('broadcast', { event: 'ice' }, (p) => { console.log('[webrtc-recv] 收到 ice'); _onIce(p); });
      rcvChannel.subscribe((status, err) => {
        console.log('[webrtc-recv] channel subscribe:', status, err);
        if (status === 'SUBSCRIBED') {
          // 通知桌面端手机已就绪
          console.log('[webrtc-recv] 发送 ready');
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
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        // 腾讯云免费 STUN，国内网络更稳（替代可能被墙的 Google/Twilio STUN）
        { urls: 'stun:stun.qq.com:3478' }
      ],
      iceCandidatePoolSize: 4
    });
    rcvPeer.onicecandidate = function (e) {
      if (!e.candidate) return;
      if (rcvSigBase) {
        _rcvSigPost('ice', { candidate: e.candidate.toJSON() });
      } else if (rcvChannel) {
        rcvChannel.send({ type: 'broadcast', event: 'ice', payload: { candidate: e.candidate.toJSON() } });
      }
    };
    // 监控 ICE 连接状态，避免「无限等待」且无提示
    rcvPeer.oniceconnectionstatechange = function () {
      const st = rcvPeer ? rcvPeer.iceConnectionState : 'closed';
      if (st === 'connected' || st === 'completed') {
        _emitStatus({ phase: 'connecting', message: '连接已建立，正在接收…' });
      } else if (st === 'failed' || st === 'disconnected') {
        console.warn('[webrtc-recv] ICE 连接失败:', st);
        _emitStatus({ phase: 'waiting', message: '无法建立 P2P 直连（' + st + '）。请确认两台设备在同一网络，且路由器未开启「AP 隔离」；跨网络传输需要配置 TURN 服务器。' });
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
      if (rcvSigBase) {
        _rcvSigPost('answer', { sdp: rcvPeer.localDescription.sdp });
      } else if (rcvChannel) {
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
