(function registerFriendsPollingPolicy(global, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.FriendsPollingPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis, function createFriendsPollingPolicy() {
  'use strict';

  const CHAT_FAST_MS = 3000;
  const CHAT_WARM_MS = 10000;
  const CHAT_IDLE_MS = 30000;

  function nextChatDelay(idleMs) {
    const idle = Math.max(0, Number(idleMs) || 0);
    if (idle < 30 * 1000) return CHAT_FAST_MS;
    if (idle < 2 * 60 * 1000) return CHAT_WARM_MS;
    return CHAT_IDLE_MS;
  }

  function messageKey(message) {
    if (message && message.id !== undefined && message.id !== null) return 'id:' + String(message.id);
    const row = message || {};
    return ['row', row.conversation_id, row.sender_id, row.created_at, row.content].map(String).join(':');
  }

  function mergeMessages(existing, incoming) {
    const current = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Set(current.map(messageKey));
    const added = [];
    for (const message of (Array.isArray(incoming) ? incoming : [])) {
      const key = messageKey(message);
      if (seen.has(key)) continue;
      seen.add(key);
      current.push(message);
      added.push(message);
    }
    current.sort((left, right) => {
      const byTime = String(left && left.created_at || '').localeCompare(String(right && right.created_at || ''));
      if (byTime) return byTime;
      return messageKey(left).localeCompare(messageKey(right));
    });
    return { messages: current, added };
  }

  function canPoll({ online = true, visible = true, sectionActive = true } = {}) {
    return !!online && !!visible && !!sectionActive;
  }

  return {
    CHAT_FAST_MS,
    CHAT_WARM_MS,
    CHAT_IDLE_MS,
    canPoll,
    mergeMessages,
    nextChatDelay
  };
});
