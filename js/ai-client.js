// Shared reliability, privacy and usage policy for model HTTP requests.
(function createAiClient(global) {
  'use strict';

  const active = new Map();
  const approvedFingerprints = new Set();
  const USAGE_KEY = 'study_ai_usage_v2';
  const LEGACY_USAGE_KEY = 'study_ai_usage_v1';
  const COSTS_PER_MILLION = Object.freeze({
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60 },
    'gpt-4.1': { input: 2.00, output: 8.00 },
    'o3-mini': { input: 1.10, output: 4.40 }
  });

  function numberSetting(key, fallback, min, max) {
    const raw = localStorage.getItem(key);
    if (raw == null || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }

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
      let timer = null;
      const refreshTimeout = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), timeoutMs);
      };
      refreshTimeout();
      let handedOff = false;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearTimeout(timer);
        release();
        if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternal);
      };
      try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const retryable = [408, 409, 425, 429].includes(response.status) || response.status >= 500;
        if (!retryable || attempt === retries) {
          // fetch() resolves as soon as response headers arrive. Streaming callers
          // must keep the controller registered until the response body is consumed,
          // otherwise the Stop button can no longer abort an active SSE stream.
          if (policy.keepAlive) {
            handedOff = true;
            Object.defineProperty(response, '_aiRequestControl', {
              configurable: true,
              value: Object.freeze({ controller, release: cleanup, touch: refreshTimeout })
            });
          }
          return response;
        }
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {});
        const rawRetryAfter = response.headers.get('retry-after');
        const retryAfter = rawRetryAfter == null || rawRetryAfter.trim() === '' ? NaN
          : (/^\d+(\.\d+)?$/.test(rawRetryAfter) ? Number(rawRetryAfter) * 1000 : Date.parse(rawRetryAfter) - Date.now());
        await delay(Number.isFinite(retryAfter) ? Math.max(0, Math.min(30000, retryAfter)) : Math.min(8000, 500 * Math.pow(2, attempt)), controller.signal);
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted || attempt === retries) {
          const reason = controller.signal.reason;
          if (reason && reason.name === 'TimeoutError') throw new Error('AI 请求超时，请检查网络或调高超时时间');
          if (controller.signal.aborted) throw new Error('AI 请求已取消');
          throw error;
        }
        try {
          await delay(Math.min(8000, 500 * Math.pow(2, attempt)), controller.signal);
        } catch {
          throw new Error(controller.signal.reason?.name === 'TimeoutError' ? 'AI 请求超时，请检查网络或调高超时时间' : 'AI 请求已取消');
        }
      } finally {
        if (!handedOff) cleanup();
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

  // Conservative fallback for OpenAI-compatible providers that omit usage.
  // The result is deliberately marked as estimated in the stored aggregates.
  function estimateTokens(value) {
    let text = '';
    try { text = typeof value === 'string' ? value : JSON.stringify(value == null ? '' : value); }
    catch (_) { text = String(value || ''); }
    const nonAscii = (text.match(/[^\x00-\x7f]/g) || []).length;
    return Math.max(0, Math.ceil((text.length - nonAscii) / 3 + nonAscii));
  }

  function localDateKey(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function emptyUsageStore() {
    return { version: 2, days: {}, legacyMonths: {} };
  }

  function loadUsageStore() {
    let store = null;
    try { store = JSON.parse(localStorage.getItem(USAGE_KEY) || 'null'); } catch (_) {}
    if (!store || store.version !== 2 || !store.days) store = emptyUsageStore();
    if (!store.legacyMonths || typeof store.legacyMonths !== 'object') store.legacyMonths = {};
    if (Object.keys(store.legacyMonths).length === 0) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_USAGE_KEY) || '{}');
        if (legacy && typeof legacy === 'object') store.legacyMonths = legacy;
      } catch (_) {}
    }
    return store;
  }

  function saveUsageStore(store) {
    if (global.StudyPlatform) global.StudyPlatform.storage.setJson(USAGE_KEY, store);
    else localStorage.setItem(USAGE_KEY, JSON.stringify(store));
  }

  function emptyUsageBucket() {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, exactRequests: 0, estimatedRequests: 0, estimatedUsd: 0 };
  }

  function addToBucket(bucket, inputTokens, outputTokens, exact, estimatedUsd) {
    bucket.inputTokens = (Number(bucket.inputTokens) || 0) + inputTokens;
    bucket.outputTokens = (Number(bucket.outputTokens) || 0) + outputTokens;
    bucket.totalTokens = (Number(bucket.totalTokens) || 0) + inputTokens + outputTokens;
    bucket.requests = (Number(bucket.requests) || 0) + 1;
    const accuracyKey = exact ? 'exactRequests' : 'estimatedRequests';
    bucket[accuracyKey] = (Number(bucket[accuracyKey]) || 0) + 1;
    if (estimatedUsd != null) bucket.estimatedUsd = (Number(bucket.estimatedUsd) || 0) + estimatedUsd;
    return bucket;
  }

  function safeDimension(value, fallback) {
    const text = String(value || fallback).trim().slice(0, 80);
    const safe = text || fallback;
    return ['__proto__', 'prototype', 'constructor'].includes(safe) ? '_' + safe : safe;
  }

  function recordUsage(model, usage, metadata = {}) {
    const hasProviderUsage = !!usage && [usage.prompt_tokens, usage.input_tokens, usage.completion_tokens, usage.output_tokens, usage.total_tokens]
      .some(value => value != null && Number.isFinite(Number(value)));
    let inputTokens = hasProviderUsage ? (Number(usage.prompt_tokens ?? usage.input_tokens) || 0) : estimateTokens(metadata.input);
    let outputTokens = hasProviderUsage ? (Number(usage.completion_tokens ?? usage.output_tokens) || 0) : estimateTokens(metadata.output);
    if (hasProviderUsage && inputTokens === 0 && outputTokens === 0 && Number(usage.total_tokens) > 0) {
      outputTokens = Number(usage.total_tokens);
    }
    inputTokens = Math.max(0, Math.round(inputTokens));
    outputTokens = Math.max(0, Math.round(outputTokens));
    if (!hasProviderUsage && inputTokens === 0 && outputTokens === 0) return null;
    const modelName = safeDimension(model, 'unknown');
    const priceKey = Object.keys(COSTS_PER_MILLION).find(key => modelName.toLowerCase().includes(key));
    const price = priceKey ? COSTS_PER_MILLION[priceKey] : null;
    const estimatedUsd = price ? (inputTokens * price.input + outputTokens * price.output) / 1000000 : null;
    const exact = hasProviderUsage;
    const feature = safeDimension(metadata.feature, 'other');
    const dayKey = localDateKey(metadata.timestamp);
    const store = loadUsageStore();
    const day = store.days[dayKey] || { ...emptyUsageBucket(), byModel: {}, byFeature: {} };
    addToBucket(day, inputTokens, outputTokens, exact, estimatedUsd);
    day.byModel = day.byModel || {};
    day.byFeature = day.byFeature || {};
    addToBucket(day.byModel[modelName] || (day.byModel[modelName] = emptyUsageBucket()), inputTokens, outputTokens, exact, estimatedUsd);
    addToBucket(day.byFeature[feature] || (day.byFeature[feature] = emptyUsageBucket()), inputTokens, outputTokens, exact, estimatedUsd);
    store.days[dayKey] = day;
    saveUsageStore(store);
    const detail = { model: modelName, feature, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, exact, estimatedUsd, day: dayKey };
    if (global.StudyPlatform) global.StudyPlatform.events.emit('ai:usage', detail);
    return detail;
  }

  function clearUsage() {
    const store = emptyUsageStore();
    saveUsageStore(store);
    if (global.StudyPlatform) global.StudyPlatform.storage.remove(LEGACY_USAGE_KEY);
    else localStorage.removeItem(LEGACY_USAGE_KEY);
    if (global.StudyPlatform) global.StudyPlatform.events.emit('ai:usage-cleared', {});
    return store;
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
    clearUsage,
    estimateTokens,
    fetchWithPolicy,
    findSensitiveContent,
    getUsageData: loadUsageStore,
    recordUsage
  });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('ai-client', global.AIClient);
})(window);
