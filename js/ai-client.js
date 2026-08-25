// Shared reliability, privacy and usage policy for model HTTP requests.
(function createAiClient(global) {
  'use strict';

  const active = new Map();
  const approvedFingerprints = new Set();
  const COSTS_PER_MILLION = Object.freeze({
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60 },
    'gpt-4.1': { input: 2.00, output: 8.00 },
    'o3-mini': { input: 1.10, output: 4.40 }
  });

  function numberSetting(key, fallback, min, max) {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function addController(scope, controller) {
    const key = String(scope || 'global');
    const values = active.get(key) || new Set();
    values.add(controller);
    active.set(key, values);
    return () => {
      values.delete(controller);
      if (!values.size) active.delete(key);
    };
  }

  async function fetchWithPolicy(url, options = {}, policy = {}) {
    const retries = policy.retries == null
      ? numberSetting('study_ai_retry_count', 2, 0, 4)
      : Math.max(0, Number(policy.retries) || 0);
    const timeoutMs = policy.timeoutMs || numberSetting('study_ai_timeout_ms', 60000, 5000, 300000);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const release = addController(policy.scope, controller);
      const externalSignal = options.signal;
      const abortFromExternal = () => controller.abort(externalSignal.reason);
      if (externalSignal) {
        if (externalSignal.aborted) abortFromExternal();
        else externalSignal.addEventListener('abort', abortFromExternal, { once: true });
      }
      const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
        if (!retryable || attempt === retries) return response;
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
        const retryAfter = Number(response.headers.get('retry-after'));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(8000, 500 * Math.pow(2, attempt)));
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || attempt === retries) {
          const reason = controller.signal.reason;
          if (reason && reason.name === 'TimeoutError') throw new Error('AI 请求超时，请检查网络或调高超时时间');
          if (controller.signal.aborted) throw new Error('AI 请求已取消');
          throw error;
        }
        await delay(Math.min(8000, 500 * Math.pow(2, attempt)));
      } finally {
        clearTimeout(timer);
        release();
        if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
      }
    }
    throw lastError || new Error('AI 请求失败');
  }

  function userText(messages) {
    return (messages || []).filter(message => message && message.role === 'user').map(message => {
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) return message.content.filter(item => item && item.type === 'text').map(item => item.text || '').join('\n');
      return '';
    }).join('\n');
  }

  function findSensitiveContent(messages) {
    const text = userText(messages);
    const matches = [];
    const rules = [
      ['API Key', /\b(?:sk|key)-[a-zA-Z0-9_-]{16,}\b/],
      ['访问令牌', /\bBearer\s+[a-zA-Z0-9._-]{16,}\b/i],
      ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
      ['密码字段', /(?:密码|password|passwd|授权码)\s*[:：=]\s*\S{4,}/i],
      ['身份证号', /\b\d{17}[\dXx]\b/]
    ];
    for (const [label, rule] of rules) if (rule.test(text)) matches.push(label);
    return matches;
  }

  async function confirmSensitiveContent(messages) {
    const matches = findSensitiveContent(messages);
    if (!matches.length || localStorage.getItem('study_ai_sensitive_warning') === 'false') return true;
    const fingerprint = matches.join('|') + ':' + userText(messages).length;
    if (approvedFingerprints.has(fingerprint)) return true;
    const message = '检测到可能的敏感信息（' + matches.join('、') + '）。继续后，这些内容会发送给当前 AI 服务商。是否继续？';
    const accepted = typeof global.showCustomConfirm === 'function'
      ? await global.showCustomConfirm(message, { title: '敏感信息提醒', okText: '仍然发送', danger: true })
      : global.confirm(message);
    if (accepted) approvedFingerprints.add(fingerprint);
    return !!accepted;
  }

  function recordUsage(model, usage) {
    if (!usage) return null;
    const inputTokens = Number(usage.prompt_tokens || usage.input_tokens) || 0;
    const outputTokens = Number(usage.completion_tokens || usage.output_tokens) || 0;
    const modelName = String(model || 'unknown');
    const priceKey = Object.keys(COSTS_PER_MILLION).find(key => modelName.toLowerCase().includes(key));
    const price = priceKey ? COSTS_PER_MILLION[priceKey] : null;
    const estimatedUsd = price ? (inputTokens * price.input + outputTokens * price.output) / 1000000 : null;
    const month = new Date().toISOString().slice(0, 7);
    const key = 'study_ai_usage_v1';
    let store = {};
    try { store = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
    const row = store[month] || { inputTokens: 0, outputTokens: 0, requests: 0, estimatedUsd: 0 };
    row.inputTokens += inputTokens;
    row.outputTokens += outputTokens;
    row.requests += 1;
    if (estimatedUsd != null) row.estimatedUsd += estimatedUsd;
    store[month] = row;
    if (global.StudyPlatform) global.StudyPlatform.storage.setJson(key, store);
    else localStorage.setItem(key, JSON.stringify(store));
    if (global.StudyPlatform) global.StudyPlatform.events.emit('ai:usage', { model: modelName, inputTokens, outputTokens, estimatedUsd });
    return { inputTokens, outputTokens, estimatedUsd };
  }

  global.AIClient = Object.freeze({
    cancel(scope) {
      const controllers = active.get(String(scope || 'global')) || [];
      for (const controller of controllers) controller.abort();
      return controllers.size || 0;
    },
    cancelAll() {
      let count = 0;
      for (const controllers of active.values()) for (const controller of controllers) { controller.abort(); count++; }
      return count;
    },
    confirmSensitiveContent,
    fetchWithPolicy,
    findSensitiveContent,
    recordUsage
  });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('ai-client', global.AIClient);
})(window);
