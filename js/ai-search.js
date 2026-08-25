// ═══════════════════════════════════════════════
//  AI 网络搜索：多引擎搜索、Windows 通知、侧边栏徽章
// ═══════════════════════════════════════════════

// ═══════════ Windows Notification ═══════════

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
// Supported engines: DuckDuckGo (free), Brave, Tavily, Exa, SearchAPI
async function performWebSearch(query, maxResults) {
  const engine = localStorage.getItem('study_web_search_engine') || 'duckduckgo';
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
          return data.web.results.slice(0, maxResults).map((item, i) =>
            `${i + 1}. ${item.title}\n   ${item.description}\n   ${item.url}`
          ).join('\n\n');
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
          return data.results.slice(0, maxResults).map((item, i) =>
            `${i + 1}. ${item.title}\n   ${item.content}\n   ${item.url}`
          ).join('\n\n');
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
          return data.results.slice(0, maxResults).map((item, i) =>
            `${i + 1}. ${item.title}\n   ${item.text || item.snippet || ''}\n   ${item.url}`
          ).join('\n\n');
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
          return data.organic_results.slice(0, maxResults).map((item, i) =>
            `${i + 1}. ${item.title}\n   ${item.snippet}\n   ${item.link}`
          ).join('\n\n');
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
      if (data.AbstractText) result += data.AbstractText + '\n\n';
      if (data.RelatedTopics && data.RelatedTopics.length > 0) {
        result += data.RelatedTopics.slice(0, maxResults).map(item => {
          if (item.Text) return `• ${item.Text}`;
          if (item.Topics) return item.Topics.slice(0, 3).map(t => `• ${t.Text}`).join('\n');
          return '';
        }).filter(Boolean).join('\n');
      }
      if (result) return result;
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
        const url = match[1].replace(/\/\/html\.duckduckgo\.com\/redirect\?[^&]*&uddg=/, '').replace(/%3A/g, ':').replace(/%2F/g, '/').replace(/%3F/g, '?').replace(/%3D/g, '=').replace(/%26/g, '&');
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (title && snippet) {
          results.push(`${count + 1}. ${decodeURIComponent(title)}\n   ${decodeURIComponent(snippet)}\n   ${decodeURIComponent(url)}`);
          count++;
        }
      }
      if (results.length > 0) return results.join('\n\n');

      // Fallback regex for different HTML structure
      const fallbackRegex = /class="result__body"[^>]*>[\s\S]*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let fCount = 0;
      while ((match = fallbackRegex.exec(html)) !== null && fCount < maxResults) {
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        const snippet = match[3].replace(/<[^>]+>/g, '').trim();
        if (title && snippet) {
          results.push(`${fCount + 1}. ${title}\n   ${snippet}`);
          fCount++;
        }
      }
      if (results.length > 0) return results.join('\n\n');
    }
  } catch (e) { /* fall through */ }

  return null;
}
