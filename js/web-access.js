// Shared desktop/PWA web access. Only the official DeepSeek host receives credentials.
(function (global) {
  'use strict';
  const snapshots = new Map();
  const TTL = 10 * 60 * 1000, MAX_TEXT = 500000;
  function secret(name) {
    return global.SecretVault ? global.SecretVault.get(name, '') : (localStorage.getItem(name) || '');
  }
  function publicUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('网页 URL 必须是最多 2048 字的字符串');
    const u = new URL(value), h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('仅支持不含用户名和密码的公开 HTTP(S) 网页');
    // Cloud Fetch also performs server-side security checks, including DNS resolution.
    const ipv6 = h.includes(':');
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(h);
    if ((ipv6 && (!/^[23]/.test(h) || h.startsWith('2001:db8:') || h.startsWith('2002:'))) ||
        (!ipv6 && !h.includes('.')) || h.endsWith('.local') || h.endsWith('.localhost') || h === 'localhost' ||
        (ipv4 && (/^(?:0|10|127|169\.254|192\.168|192\.0\.0|192\.0\.2|198\.18|198\.19|198\.51\.100|203\.0\.113)\./.test(h) ||
        /^172\.(?:1[6-9]|2\d|3[01])\./.test(h) || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
        Number(h.split('.')[0]) >= 224))) throw new Error('不允许访问本机、局域网或非公网地址');
    return u.href;
  }
  function options(payload) {
    const url = publicUrl(payload.url);
    const number = (value, fallback) => {
      if (value === undefined) return fallback;
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('字符数和偏移必须是非负整数');
      return value;
    };
    const limit = Math.min(8000, number(payload.limit !== undefined ? payload.limit : payload.maxChars, 6000));
    if (limit < 500) throw new Error('单次字符数至少为 500');
    if (payload.query !== undefined && (typeof payload.query !== 'string' || payload.query.length > 200)) throw new Error('query 最多 200 字');
    if (payload.snapshotId !== undefined && (typeof payload.snapshotId !== 'string' || payload.snapshotId.length > 100)) throw new Error('snapshotId 无效');
    return { url, limit, offset: number(payload.offset, 0), query: (payload.query || '').trim(), snapshotId: payload.snapshotId || '' };
  }
  async function request(kind, body) {
    const key = secret('study_deepseek_web_key').trim();
    if (!key) throw new Error('请在设置 → AI → 联网中填写 DeepSeek API Key');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('https://api.deepseek.com/v1/tools/' + kind, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body), signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store'
      });
      if (!response.ok) {
        const hints = { 400: '请求参数无效', 401: 'API Key 无效', 402: '账户余额不足', 403: '网页被安全策略拒绝', 404: '没有可读取的正文', 429: '请求过于频繁，请稍后重试' };
        throw new Error('DeepSeek HTTP ' + response.status + '：' + (hints[response.status] || '服务暂时不可用，请稍后重试'));
      }
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('DeepSeek 请求超时（20 秒）');
      if (error instanceof TypeError) throw new Error('DeepSeek 网络连接失败，请检查网络或浏览器跨域访问限制');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function link(title, url) {
    url = publicUrl(url);
    return '[' + String(title || url).replace(/[\[\]\\\r\n]/g, ' ').slice(0, 300) + '](' + url.replace(/\(/g, '%28').replace(/\)/g, '%29') + ')';
  }
  function formatSources(items, count) {
    let remaining = 9500;
    return items.slice(0, count).map((item, i) => {
      if (!item || typeof item !== 'object') return '';
      let url;
      try { url = publicUrl(item.url); } catch (_) { return ''; }
      const result = `${i + 1}. ${link(item.title, url)}\n摘要（未核对全文）：${String(item.summary || item.snippet || '').slice(0, 700)}\n${item.date ? '发布时间：' + String(item.date).slice(0, 80) : ''}`;
      if (result.length + 2 > remaining) return '';
      remaining -= result.length + 2;
      return result;
    }).filter(Boolean).join('\n\n');
  }
  async function search(query, count) {
    if (typeof query !== 'string' || !query.trim() || [...query].length > 128) throw new Error('DeepSeek 搜索词须为 1～128 个字符，请缩短查询后重试');
    const data = await request('search', { query, count, need_content: false });
    if (!Array.isArray(data?.results)) throw new Error('DeepSeek 搜索返回格式无效');
    return formatSources(data.results, count);
  }
  function purge() {
    for (const [id, entry] of snapshots) if (Date.now() - entry.created >= TTL) snapshots.delete(id);
  }
  function page(entry, o, id) {
    const text = entry.text, totalChars = text.length;
    if (o.offset > totalChars) throw new Error('offset 超出网页正文长度');
    let output, nextOffset = null;
    if (o.query) {
      const pattern = new RegExp(o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      const snippets = [];
      let cursor = o.offset, remaining = o.limit;
      while (remaining > 200 && snippets.length < 10) {
        pattern.lastIndex = cursor;
        const match = pattern.exec(text);
        if (!match) break;
        const start = Math.max(o.offset, match.index - 150), end = Math.min(totalChars, start + remaining, match.index + match[0].length + 650);
        snippets.push(`[匹配位置 ${match.index}，片段 ${start}–${end}]\n` + text.slice(start, end));
        remaining -= end - start; cursor = end;
      }
      pattern.lastIndex = cursor;
      if (pattern.exec(text)) nextOffset = cursor;
      output = snippets.join('\n\n') || '未找到该关键词';
    } else {
      output = text.slice(o.offset, o.offset + o.limit);
      if (o.offset + output.length < totalChars) nextOffset = o.offset + output.length;
    }
    return { ok: true, text: output, title: entry.title, finalUrl: entry.url, provider: 'DeepSeek Fetch',
      snapshotId: id, offset: o.offset, totalChars, nextOffset, truncated: nextOffset !== null,
      sourceTruncated: entry.sourceTruncated, fetchedAt: entry.fetchedAt, warnings: entry.warnings };
  }
  async function cloudRead(o, owner, warnings) {
    const data = await request('fetch', { url: o.url });
    if (typeof data?.content !== 'string' || !data.content.trim()) throw new Error('DeepSeek 未返回可读取的网页正文');
    purge();
    while (snapshots.size >= 20) snapshots.delete(snapshots.keys().next().value);
    const id = 'cloud-' + global.crypto.randomUUID();
    const sourceTruncated = data.content.length > MAX_TEXT;
    const entry = { text: data.content.slice(0, MAX_TEXT), title: String(data.title || '').slice(0, 300), url: o.url,
      owner, created: Date.now(), fetchedAt: new Date().toISOString(), sourceTruncated,
      warnings: [...warnings, '云端返回的正文无法保证包含网页全部动态内容', ...(sourceTruncated ? ['页面超过提取上限，快照不完整'] : [])] };
    snapshots.set(id, entry);
    return page(entry, o, id);
  }
  async function read(payload, owner = '') {
    try {
      const o = options(payload), native = global.electronAPI?.webRead;
      if (o.snapshotId.startsWith('cloud-')) {
        purge();
        const entry = snapshots.get(o.snapshotId);
        if (!entry || entry.owner !== owner || entry.url !== o.url) throw new Error('网页快照已过期或不属于当前对话/URL，请从 offset=0 重新读取');
        return page(entry, o, o.snapshotId);
      }
      // Continuation must stay on the same backend: never splice a freshly fetched document into a snapshot.
      if (o.snapshotId) {
        if (!native) throw new Error('本地网页快照仅能在原桌面窗口续读，请从 offset=0 重新读取');
        return await native(o);
      }
      if (o.offset > 0) throw new Error('续读必须提供上次返回的 snapshotId');
      const mode = localStorage.getItem('study_web_read_mode') || 'auto';
      const order = mode === 'local' ? ['local'] : mode === 'deepseek' ? ['cloud', 'local'] : ['local', 'cloud'];
      const failures = [];
      for (const provider of order) {
        if (provider === 'local' && !native) continue;
        try {
          const result = provider === 'local' ? await native(o) : await cloudRead(o, owner, failures.map(e => '已回退：' + e));
          if (!result?.ok || !result.text?.trim()) throw new Error(result?.error || '未提取到正文');
          return provider === 'local' ? { ...result, provider: '桌面本地渲染', warnings: [...(result.warnings || []), ...failures.map(e => '已回退：' + e)] } : result;
        } catch (error) { failures.push((provider === 'local' ? '本地读取：' : 'DeepSeek Fetch：') + error.message); }
      }
      throw new Error(failures.join('；') || '当前环境不支持本地读取，请选择自动或 DeepSeek 读取方式');
    } catch (error) { return { ok: false, error: error.message }; }
  }
  global.WebAccess = { read, search, publicUrl, link, formatSources };
})(window);
