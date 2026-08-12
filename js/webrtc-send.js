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
  // 本地信令（局域网）状态
  let sndLanIp = null;
  let sndLanPort = null;
  let sndUnsubIncoming = null;
  let sndSigBase = null;      // http://<ip>:<port>，用于桌面自身 POST 信令

  function _emitStatus(status) {
    if (sndOnStatus) { try { sndOnStatus(status); } catch (e) {} }
  }

  // 生成 6 位配对码
  function generateCode() {
    let code = '';
    for (let i = 0; i < 6; i++) code += String(Math.floor(Math.random() * 10));
    return code;
  }

  // ── 向本地信令服务器提交一条信令（POST /signal）──
  async function _sigPost(code, event, payload) {
    try {
      await fetch(sndSigBase + '/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, event: event, payload: payload || {}, from: 'send' })
      });
    } catch (e) {
      console.warn('[webrtc-send] 本地信令发送失败:', e);
    }
  }

  // ── 开始配对：启动本地信令服务器，生成配对码，等待手机端就绪 ────
  function startPair(opts) {
    opts = opts || {};
    sndOnStatus = opts.onStatus || null;
    sndCancel = false;
    // 优先用外部传入的 code（如 UI 已生成并展示给用户的配对码），保证与信令频道一致
    sndCode = (opts.code && String(opts.code).replace(/\D/g, '') || '');
    if (sndCode.length !== 6) sndCode = generateCode();

    // 优先用本地信令服务器（Electron 桌面端），彻底摆脱对 Supabase Realtime 的依赖
    if (window.electronAPI && typeof window.electronAPI.webrtcSignalStart === 'function') {
      window.electronAPI.webrtcSignalStart().then((res) => {
        if (!res || !res.ok) {
          _emitStatus({ phase: 'error', message: '启动本地信令服务器失败：' + ((res && res.reason) || '未知错误') });
          return;
        }
        sndLanIp = (res.ips && res.ips[0]) || '127.0.0.1';
        sndLanPort = res.port;
        sndSigBase = 'http://' + (res.ips && res.ips[0] ? res.ips[0] : '127.0.0.1') + ':' + res.port;
        // 监听手机端通过主进程推送来的信令（ready/answer/ice）
        if (sndUnsubIncoming) { try { sndUnsubIncoming(); } catch (e) {} }
        sndUnsubIncoming = window.electronAPI.onWebrtcSignalIncoming(({ code, event, payload }) => {
          if (code !== sndCode) return;
          console.log('[webrtc-send] 本地信令收到:', event);
          if (event === 'ready') {
            sndReady = true;
            _emitStatus({ phase: 'connecting', code: sndCode, message: '已检测到手机端，正在建立连接…' });
            _createOffer();
          } else if (event === 'answer') { _onAnswer(payload); }
          else if (event === 'ice') { _onIce(payload); }
        });
        _emitStatus({ phase: 'pairing', code: sndCode, ip: sndLanIp, port: sndLanPort, message: '配对码已生成：' + sndCode + '（本机 IP：' + sndLanIp + '）' });
      }).catch((e) => {
        _emitStatus({ phase: 'error', message: '启动本地信令服务器出错：' + String(e) });
      });
      return sndCode;
    }

    // 降级：非 Electron（如网页版）回退到 Supabase Realtime 信令
    if (typeof getSupabaseClient !== 'function') { _emitStatus({ phase: 'error', message: '未配置信令通道，无法配对' }); return null; }
    sndClient = getSupabaseClient();
    if (!sndClient) { _emitStatus({ phase: 'error', message: 'Supabase 客户端不可用' }); return null; }

    _emitStatus({ phase: 'pairing', code: sndCode, message: '配对码已生成：' + sndCode });

    try {
      sndChannel = sndClient.channel('pdf-transfer-' + sndCode, {
        config: { broadcast: { self: false } }
      });
      sndChannel.on('broadcast', { event: 'ready' }, (p) => {
        console.log('[webrtc-send] 收到手机端 ready', p);
        sndReady = true;
        _emitStatus({ phase: 'connecting', code: sndCode, message: '已检测到手机端，正在建立连接…' });
        _createOffer();
      });
      sndChannel.on('broadcast', { event: 'answer' }, (p) => { console.log('[webrtc-send] 收到 answer'); _onAnswer(p); });
      sndChannel.on('broadcast', { event: 'ice' }, (p) => { console.log('[webrtc-send] 收到 ice'); _onIce(p); });
      sndChannel.subscribe((status, err) => {
        console.log('[webrtc-send] channel subscribe:', status, err);
        if (err) _emitStatus({ phase: 'error', message: '配对频道订阅失败：' + String(err && err.message || err) });
      });
    } catch (e) {
      _emitStatus({ phase: 'error', message: '配对频道创建失败：' + String(e) });
    }
    return sndCode;
  }

  async function _createOffer() {
    sndPeer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        // 腾讯云免费 STUN，国内网络更稳（替代可能被墙的 Google/Twilio STUN）
        { urls: 'stun:stun.qq.com:3478' }
      ],
      iceCandidatePoolSize: 4
    });
    sndPeer.onicecandidate = function (e) {
      if (!e.candidate) return;
      if (sndSigBase) {
        _sigPost(sndCode, 'ice', { candidate: e.candidate.toJSON() });
      } else if (sndChannel) {
        sndChannel.send({ type: 'broadcast', event: 'ice', payload: { candidate: e.candidate.toJSON() } });
      }
    };
    // 监控 ICE 连接状态，避免「无限等待」且无提示
    sndPeer.oniceconnectionstatechange = function () {
      const st = sndPeer ? sndPeer.iceConnectionState : 'closed';
      if (st === 'connected' || st === 'completed') {
        _emitStatus({ phase: 'connecting', message: '连接已建立，开始传输…' });
      } else if (st === 'failed' || st === 'disconnected') {
        console.warn('[webrtc-send] ICE 连接失败:', st);
        _emitStatus({ phase: 'waiting', message: '无法建立 P2P 直连（' + st + '）。请确认两台设备在同一网络，且路由器未开启「AP 隔离」；跨网络传输需要配置 TURN 服务器。' });
      }
    };
    sndDataChannel = sndPeer.createDataChannel('pdf', { ordered: true });
    _setupDataChannel(sndDataChannel);

    try {
      const offer = await sndPeer.createOffer();
      await sndPeer.setLocalDescription(offer);
      if (sndSigBase) {
        _sigPost(sndCode, 'offer', { sdp: sndPeer.localDescription.sdp });
      } else if (sndChannel) {
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
