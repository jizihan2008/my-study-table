// ═══════════════════════════════════════════════════════════════════
// js/webrtc-send.js — 桌面端 WebRTC PDF 发送端
// 生成 6 位配对码，双方加入 Supabase Realtime broadcast channel 交换
// 信令（SDP/ICE）。连接建立后，通过 DataChannel 将本地 PDF 文件按
// 64KB 分片顺序发送给手机端，发送完发送 end 元数据。
// ═══════════════════════════════════════════════════════════════════

(function (global) {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;

  let sndClient = null;
  let sndChannel = null;
  let sndPeer = null;
  let sndDataChannel = null;
  let sndCode = null;
  let sndReady = false;       // 手机端已加入频道
  let sndConnected = false;   // DataChannel 已打开
  let sndBusy = false;
  let sndOnStatus = null;
  let sndCancel = false;

  function _emitStatus(status) {
    if (sndOnStatus) { try { sndOnStatus(status); } catch (e) {} }
  }

  // 生成 6 位配对码
  function generateCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += String(Math.floor(Math.random() * 10));
    return code;
  }

  // ── 开始配对：生成配对码并订阅频道，等待手机端就绪 ────
  function startPair(opts) {
    opts = opts || {};
    sndOnStatus = opts.onStatus || null;
    sndCancel = false;
    if (typeof getSupabaseClient !== 'function') { _emitStatus({ phase: 'error', message: '未配置 Supabase，无法配对' }); return null; }
    sndClient = getSupabaseClient();
    if (!sndClient) { _emitStatus({ phase: 'error', message: 'Supabase 客户端不可用' }); return null; }

    sndCode = generateCode();
    _emitStatus({ phase: 'pairing', code: sndCode, message: '配对码已生成：' + sndCode });

    try {
      sndChannel = sndClient.channel('pdf-transfer-' + sndCode, {
        config: { broadcast: { self: false } }
      });
      sndChannel.on('broadcast', { event: 'ready' }, () => {
        sndReady = true;
        _emitStatus({ phase: 'connecting', code: sndCode, message: '已检测到手机端，正在建立连接…' });
        _createOffer();
      });
      sndChannel.on('broadcast', { event: 'answer' }, (payload) => _onAnswer(payload));
      sndChannel.on('broadcast', { event: 'ice' }, (payload) => _onIce(payload));
      sndChannel.subscribe();
    } catch (e) {
      _emitStatus({ phase: 'error', message: '配对频道创建失败：' + String(e) });
    }
    return sndCode;
  }

  async function _createOffer() {
    sndPeer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }]
    });
    sndPeer.onicecandidate = function (e) {
      if (e.candidate && sndChannel) {
        sndChannel.send({ type: 'broadcast', event: 'ice', payload: { candidate: e.candidate.toJSON() } });
      }
    };
    sndDataChannel = sndPeer.createDataChannel('pdf', { ordered: true });
    _setupDataChannel(sndDataChannel);

    try {
      const offer = await sndPeer.createOffer();
      await sndPeer.setLocalDescription(offer);
      if (sndChannel) {
        sndChannel.send({ type: 'broadcast', event: 'offer', payload: { sdp: sndPeer.localDescription.sdp } });
      }
    } catch (e) {
      _emitStatus({ phase: 'error', message: '创建连接失败：' + String(e) });
    }
  }

  function _onAnswer(payload) {
    if (!sndPeer || !payload || !payload.sdp) return;
    try {
      sndPeer.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    } catch (e) { /* 忽略 */ }
  }

  function _onIce(payload) {
    if (!sndPeer || !payload || !payload.candidate) return;
    try { sndPeer.addIceCandidate(payload.candidate); } catch (e) { /* 忽略 */ }
  }

  function _setupDataChannel(dc) {
    dc.onopen = function () {
      sndConnected = true;
      _emitStatus({ phase: 'connected', code: sndCode, message: '连接已建立，可以发送 PDF 了。' });
    };
    dc.onclose = function () {
      sndConnected = false;
      _emitStatus({ phase: 'idle', message: '连接已关闭' });
    };
    dc.onerror = function () {
      _emitStatus({ phase: 'error', message: '传输通道错误' });
    };
  }

  // ── 发送 PDF（bytes: Uint8Array / Buffer，fileName, bookId）──
  async function sendPdf(data, bookId, fileName, onProgress) {
    if (!sndDataChannel || sndDataChannel.readyState !== 'open') {
      _emitStatus({ phase: 'error', message: '尚未建立连接，请先配对' });
      return { ok: false, reason: 'not-connected' };
    }
    if (sndBusy) { _emitStatus({ phase: 'error', message: '正在发送其他文件' }); return { ok: false, reason: 'busy' }; }
    sndBusy = true;
    sndCancel = false;

    let bytes;
    if (data instanceof Uint8Array) bytes = data;
    else if (data && typeof data === 'object' && data.data) bytes = new Uint8Array(data.data); // Buffer 序列化
    else if (data && typeof data.buffer !== 'undefined' && data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else { sndBusy = false; return { ok: false, reason: 'bad-data' }; }

    const total = bytes.byteLength;
    const meta = { type: 'meta', bookId: String(bookId), fileName: String(fileName || 'book.pdf'), total: total };
    _emitStatus({ phase: 'transfer', progress: 0, message: '正在发送「' + (fileName || bookId) + '」…' });

    try {
      sndDataChannel.send(JSON.stringify(meta));
      let sent = 0;
      while (sent < total && !sndCancel) {
        const end = Math.min(sent + CHUNK_SIZE, total);
        const chunk = bytes.slice(sent, end);
        // 缓冲拥塞控制
        if (sndDataChannel.bufferedAmount > 16 * 1024 * 1024) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        sndDataChannel.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
        sent = end;
        const progress = Math.floor(sent / total * 100);
        if (onProgress) { try { onProgress(progress); } catch (e) {} }
        _emitStatus({ phase: 'transfer', progress: progress, message: '发送中… ' + (sent / 1024 / 1024).toFixed(1) + ' / ' + (total / 1024 / 1024).toFixed(1) + ' MB' });
        // 让出事件循环
        if (sent % (CHUNK_SIZE * 20) === 0) await new Promise(r => setTimeout(r, 0));
      }
      if (sndCancel) {
        _emitStatus({ phase: 'idle', message: '发送已取消' });
        sndBusy = false;
        return { ok: false, reason: 'cancelled' };
      }
      // 结束标志
      sndDataChannel.send(JSON.stringify({ type: 'end' }));
      _emitStatus({ phase: 'done', progress: 100, message: '「' + (fileName || bookId) + '」发送完成。' });
      sndBusy = false;
      return { ok: true };
    } catch (e) {
      sndBusy = false;
      _emitStatus({ phase: 'error', message: '发送失败：' + String(e) });
      return { ok: false, reason: String(e) };
    }
  }

  function cancelSend() { sndCancel = true; }

  // ── 停止配对 ──────────────────────────────────────────
  function stopPair() {
    sndCancel = true;
    if (sndDataChannel) { try { sndDataChannel.close(); } catch (e) {} sndDataChannel = null; }
    if (sndPeer) { try { sndPeer.close(); } catch (e) {} sndPeer = null; }
    if (sndChannel) { try { sndChannel.unsubscribe(); } catch (e) {} sndChannel = null; }
    sndReady = false; sndConnected = false; sndBusy = false; sndCode = null;
  }

  global.WebRtcSend = {
    startPair,
    sendPdf,
    cancelSend,
    stopPair,
    generateCode,
    get code() { return sndCode; },
    get connected() { return sndConnected; },
    get ready() { return sndReady; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
