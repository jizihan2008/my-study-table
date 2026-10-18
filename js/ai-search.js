// ═══════════════════════════════════════════════
//  AI 网络搜索：多引擎搜索、Windows 通知、侧边栏徽章
// ═══════════════════════════════════════════════

// ═══════════ Windows Notification ═══════════

// Completion metadata travels with the conversation through SyncLogs. Receiving
// preferences and delivery receipts belong to this device, never to the account.
function aiCompletionDeviceId() {
  let id = localStorage.getItem('study_device_id');
  if (!id) {
    id = 'device_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
    localStorage.setItem('study_device_id', id);
  }
  return id;
}

function recordAiTaskCompletion(conv, text, keyName) {
  if (!conv || !String(text || '').trim()) return;
  const at = Date.now();
  const event = {
    id: aiCompletionDeviceId() + ':' + at + ':' + Math.random().toString(36).slice(2),
    deviceId: aiCompletionDeviceId(), at,
    preview: String(text).replace(/<[^>]+>/g, '').slice(0, 120),
    keyName: String(keyName || 'AI').slice(0, 80)
  };
  conv.aiCompletions = [...(Array.isArray(conv.aiCompletions) ? conv.aiCompletions : []), event].slice(-20);
  conv.updatedAt = at;
}

function receiveAiTaskCompletions(conv, events) {
  if (!conv || !Array.isArray(events)) return;
  const receiptKey = 'study_ai_completion_receipts_v1';
  let receipts;
  try { receipts = JSON.parse(localStorage.getItem(receiptKey)) || []; } catch (_) { receipts = []; }
  if (!Array.isArray(receipts)) receipts = [];
  const seen = new Set(receipts);
  const deviceId = aiCompletionDeviceId();
  const pending = [];
  for (const event of events.slice(-20)) {
    if (!event || typeof event.id !== 'string' || seen.has(event.id)) continue;
    seen.add(event.id);
    // Consume disabled/expired deliveries as well, so enabling never replays them.
    if (event.deviceId && event.deviceId !== deviceId && Number.isFinite(event.at)
        && Math.abs(Date.now() - event.at) <= 24 * 60 * 60 * 1000
        && localStorage.getItem('study_ai_cross_device_notify') !== 'false') pending.push(event);
  }
  localStorage.setItem(receiptKey, JSON.stringify([...seen].slice(-500)));
  if (!pending.length) return;
  conv._hasUnread = true;
  if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();
  updateSidebarAiBadge();
  for (const event of pending) {
    const title = '🤖 其它设备的 AI 任务已完成 — ' + (conv.title || '对话');
    const body = '[' + String(event.keyName || 'AI').slice(0, 80) + '] ' + String(event.preview || '').slice(0, 120);
    if (typeof showMiniToast === 'function') showMiniToast(title);
    if (typeof sendNotification === 'function') {
      sendNotification(title, body, 'ai-complete-' + event.id, { tab: 'ai', convId: conv.id });
    }
  }
}

function saveAiCrossDeviceNotificationSetting(enabled) {
  localStorage.setItem('study_ai_cross_device_notify', String(!!enabled));
  if (enabled && typeof requestNotificationPermission === 'function') requestNotificationPermission();
}

// Update the sidebar AI nav item badge (red dot when any conversation has unread)
function updateSidebarAiBadge() {
  const navBtn = document.getElementById('nav-ai');
  if (!navBtn) return;
  const hasUnread = aiConvs.some(c => c._hasUnread === true || c._hasUnreadAuto === true);
  let badge = navBtn.querySelector('.ai-nav-badge');
  if (hasUnread) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ai-nav-badge';
      navBtn.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

// Send a Windows notification when AI replies arrive while user is not looking
function sendAiNotification(conv, messageText, keyName) {
  if (!('Notification' in window)) return; // Not supported

  // Only skip notification if user is on the AI tab AND viewing this exact conversation
  const isOnAiTab = document.getElementById('section-ai')?.classList.contains('active');
  if (!document.hidden && isOnAiTab && getActiveConv()?.id === conv.id) return;

  // Mark conversation as having unread AI reply
  if (conv) {
    conv._hasUnread = true;
    conv._hasUnreadAuto = false; // merge into unified _hasUnread
    safeSaveAiConvs();
    updateSidebarAiBadge();
  }

  // Request permission if not yet decided
  if (Notification.permission === 'default') {
    Notification.requestPermission();
    return;
  }
  if (Notification.permission !== 'granted') return;

  const title = `🤖 AI 回复 — ${conv.title || '对话'}`;
  const preview = (messageText || '').replace(/<[^>]+>/g, '').slice(0, 120);
  const body = keyName ? `[${keyName}] ${preview}` : preview;

  // 点击通知 → 切到 AI tab 并打开对应对话（convId）
  const target = { tab: 'ai', convId: conv ? conv.id : null };
  if (typeof sendNotification === 'function') {
    sendNotification(title, body, 'ai-reply-' + (conv ? conv.id : 'x'), target);
  } else {
    try { new Notification(title, { body }); } catch (e) {}
  }
}

// ═══════════ Web Search (multi-engine) ═══════════
// Search provider is independent from the model used for conversation.
async function performWebSearch(query, maxResults) {
  maxResults = Math.max(1, Math.min(10, Math.floor(Number(maxResults) || 5)));
  const engine = localStorage.getItem('study_web_search_engine') || 'duckduckgo';
  let failure = '';
  if (engine === 'deepseek') {
    try {
      const result = await WebAccess.search(query, maxResults);
      if (result) return '搜索来源：DeepSeek Search\n' + result;
      failure = 'DeepSeek 未找到结果';
    } catch (error) { failure = error.message; }
  }
  const result = await performLegacyWebSearch(query, maxResults, engine === 'deepseek' ? 'duckduckgo' : engine);
  if (result) return (failure ? '⚠️ ' + failure + '；已回退 DuckDuckGo（搜索摘要，未核对全文）\n' : '') + result;
  return '❌ ' + (failure ? failure + '；DuckDuckGo 回退也未获得结果。' : '搜索未获得可引用的结果，可能无匹配内容或网络请求失败。') + '请检查网络、Key 或余额后重试，不要声称已查到资料。';
}
async function performLegacyWebSearch(query, maxResults, selectedEngine) {
  const engine = selectedEngine;
  const fallbackNotice = engine !== 'duckduckgo' ? `⚠️ ${engine} 未获得有效结果，已回退 DuckDuckGo。\n` : '';
  const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(12000), credentials: 'omit', cache: 'no-store' });
  const apiKey = typeof SecretVault !== 'undefined'
    ? SecretVault.get('study_web_search_key', '')
    : (localStorage.getItem('study_web_search_key') || '');
  const q = encodeURIComponent(query);

  // ── Brave Search ──
  if (engine === 'brave' && apiKey) {
    try {
      const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${q}&count=${maxResults}`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey }
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.web && data.web.results && data.web.results.length > 0) {
          const result = WebAccess.formatSources(data.web.results.map(item => ({ ...item, summary: item.description })), maxResults);
          if (result) return '搜索来源：Brave\n' + result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Tavily Search ──
  if (engine === 'tavily' && apiKey) {
    try {
      const resp = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: false })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          const result = WebAccess.formatSources(data.results.map(item => ({ ...item, summary: item.content })), maxResults);
          if (result) return '搜索来源：Tavily\n' + result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Exa Search ──
  if (engine === 'exa' && apiKey) {
    try {
      const resp = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ query, numResults: maxResults, useAutoprompt: true })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.results && data.results.length > 0) {
          const result = WebAccess.formatSources(data.results.map(item => ({ ...item, summary: item.text || item.snippet })), maxResults);
          if (result) return '搜索来源：Exa\n' + result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── SearchAPI.io ──
  if (engine === 'searchapi' && apiKey) {
    try {
      const resp = await fetch(`https://www.searchapi.io/api/v1/search?api_key=${apiKey}&q=${q}&engine=google&num=${maxResults}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.organic_results && data.organic_results.length > 0) {
          const result = WebAccess.formatSources(data.organic_results.map(item => ({ ...item, url: item.link })), maxResults);
          if (result) return '搜索来源：SearchAPI\n' + result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── DuckDuckGo (free, no key needed) ──
  // Step 1: Try Instant Answer API (works for definitions, math, etc.)
  try {
    const resp = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1`);
    if (resp.ok) {
      const data = await resp.json();
      let result = '';
      if (data.AbstractText && data.AbstractURL) result += WebAccess.link(data.Heading || '来源', data.AbstractURL) + '\n' + data.AbstractText + '\n\n';
      if (data.RelatedTopics && data.RelatedTopics.length > 0) {
        result += data.RelatedTopics.slice(0, maxResults).map(item => {
          if (item.Text && item.FirstURL) return `• ${WebAccess.link(item.Text, WebAccess.publicUrl(item.FirstURL))}`;
          if (item.Topics) return item.Topics.filter(t => t.FirstURL).slice(0, 3).map(t => `• ${WebAccess.link(t.Text, WebAccess.publicUrl(t.FirstURL))}`).join('\n');
          return '';
        }).filter(Boolean).join('\n');
      }
      if (result) return fallbackNotice + '搜索来源：DuckDuckGo\n' + result;
    }
  } catch (e) { /* fall through */ }

  // Step 2: Use DuckDuckGo HTML search (scrape organic results)
  // This works for general web searches that the instant answer API doesn't cover
  try {
    const resp = await fetch(`https://html.duckduckgo.com/html/?q=${q}`);
    if (resp.ok) {
      const html = await resp.text();
      const results = [];
      // Parse organic results from DuckDuckGo's HTML response
      const resultRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      let count = 0;
      while ((match = resultRegex.exec(html)) !== null && count < maxResults) {
        const target = new URL(match[1].replace(/&amp;/g, '&'), 'https://html.duckduckgo.com');
        const url = WebAccess.publicUrl(target.searchParams.get('uddg') || target.href);
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (title && snippet) {
          results.push(`${count + 1}. ${WebAccess.link(title, url)}\n   ${snippet}`);
          count++;
        }
      }
      if (results.length > 0) return fallbackNotice + '搜索来源：DuckDuckGo\n' + results.join('\n\n');

      // Fallback regex for different HTML structure
      const fallbackRegex = /class="result__body"[^>]*>[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let fCount = 0;
      while ((match = fallbackRegex.exec(html)) !== null && fCount < maxResults) {
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (title && snippet) {
          const target = new URL(match[1].replace(/&amp;/g, '&'), 'https://html.duckduckgo.com');
          const url = WebAccess.publicUrl(target.searchParams.get('uddg') || target.href);
          results.push(`${fCount + 1}. ${WebAccess.link(title, url)}\n   ${snippet}`);
          fCount++;
        }
      }
      if (results.length > 0) return fallbackNotice + '搜索来源：DuckDuckGo\n' + results.join('\n\n');
    }
  } catch (e) { /* fall through */ }

  return null;
}
