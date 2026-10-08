'use strict';

const { parsePublicWebUrl, isPublicIp } = require('./security');
const crypto = require('node:crypto');
const MAX_TEXT = 500000;
const PAGE_LIMIT = 8000; // Leave room for metadata within the AI's 12000-character result budget.
const CACHE_TTL = 10 * 60 * 1000;

function normalizeReadOptions(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('网页读取参数必须是对象');
  const url = parsePublicWebUrl(payload.url).href;
  const integer = (key, fallback, max) => {
    if (payload[key] === undefined) return fallback;
    const n = payload[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error(`${key} 必须是非负整数`);
    return Math.min(n, max);
  };
  const limit = integer(payload.limit !== undefined ? 'limit' : 'maxChars', 6000, PAGE_LIMIT);
  if (limit < 500) throw new Error('limit/maxChars 至少为 500');
  if (payload.query !== undefined && (typeof payload.query !== 'string' || payload.query.length > 200)) throw new Error('query 必须是最多 200 字的字符串');
  if (payload.snapshotId !== undefined && (typeof payload.snapshotId !== 'string' || payload.snapshotId.length > 100)) throw new Error('snapshotId 无效');
  return { url, limit, offset: integer('offset', 0, Number.MAX_SAFE_INTEGER), query: (payload.query || '').trim(), snapshotId: payload.snapshotId || '' };
}

// Executed in an isolated page world. Never delete or rewrite the live DOM.
function extractPage() {
  const title = document.title || '';
  const noise = 'script,style,noscript,svg,canvas,iframe,nav,footer,[hidden],[aria-hidden="true"],.advertisement,.ads,.cookie-banner';
  const visible = el => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
  };
  const candidates = [...document.querySelectorAll('article,main,[role="main"]')].filter(visible);
  const root = candidates.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0] || document.body;
  let visited = 0, size = 0, capped = false;
  const headings = [], links = [], codeBlocks = [];
  const codePrefix = '\u0000WR_' + Math.random().toString(36).slice(2) + '_';
  function walk(node, depth = 0) {
    if (++visited > 100000 || size > 500000 || depth > 150) { capped = true; return ''; }
    if (node.nodeType === 3) { const t = node.nodeValue.replace(/[\t \r\n]+/g, ' '); size += t.length; return t; }
    if (node.nodeType !== 1 || node.matches(noise) || !visible(node)) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'pre') {
      const t = node.textContent.slice(0, 500000 - Math.min(size, 500000)); size += t.length;
      const fence = '`'.repeat((t.match(/`+/g) || []).reduce((n, x) => Math.max(n, x.length + 1), 3));
      const index = codeBlocks.push(fence + '\n' + t + '\n' + fence) - 1;
      return '\n\n' + codePrefix + index + '\u0000\n\n';
    }
    if (tag === 'img') return node.alt ? `[图片：${node.alt}]` : '';
    const content = [...node.childNodes].map(n => walk(n, depth + 1)).join('');
    if (/^h[1-6]$/.test(tag)) {
      if (headings.length < 80) headings.push({ level: Number(tag[1]), text: content.trim().slice(0, 300) });
      return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + content.trim() + '\n\n';
    }
    if (tag === 'a' && content.trim() && node.hasAttribute('href')) {
      try {
        const u = new URL(node.getAttribute('href'), location.href);
        if (/^https?:$/.test(u.protocol) && u.href.length <= 2000) {
          if (links.length < 80) links.push({ text: content.trim().slice(0, 200), url: u.href });
          return `[${content.trim().replace(/\]/g, '\\]')}](${u.href.replace(/\)/g, '%29')})`;
        }
      } catch (_) {}
    }
    if (tag === 'code') return '`' + content + '`';
    if (tag === 'li') return '\n- ' + content.trim() + '\n';
    if (tag === 'tr') return '\n| ' + content.trim() + '\n';
    if (tag === 'td' || tag === 'th') return content.trim().replace(/\|/g, '\\|') + ' | ';
    if (/^(p|div|section|article|main|header|aside|form|blockquote|ul|ol|table|details|summary|dl|dt|dd)$/.test(tag)) return '\n\n' + content.trim() + '\n\n';
    return content;
  }
  const normalized = root ? walk(root).replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '';
  const fullText = normalized.replace(new RegExp(codePrefix + '(\\d+)\u0000', 'g'), (_, i) => codeBlocks[Number(i)]);
  if (fullText.length > 500000) capped = true;
  const text = fullText.slice(0, 500000);
  const bodyText = (document.body && document.body.innerText || '').slice(0, 200000);
  let status = 'ok';
  const challengeTitle = /^(?:just a moment[. …]*|access denied|安全验证|人机验证|验证码|captcha)$/i.test(title.trim());
  const challengeBody = !candidates.length && /verify (?:you are|that you are) human|请完成.{0,12}(?:人机|安全)验证/i.test(bodyText.slice(0, 1000));
  if ((challengeTitle || challengeBody) && text.length < 4000) status = 'challenge';
  else if (([...document.querySelectorAll('input[type="password"]')].some(visible) || /^(?:sign in|log in|登录|登入)(?:\s*[-|—].*)?$/i.test(title)) && text.length < 2000) status = 'login_required';
  const busy = [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible) ||
    /^(?:loading[. …]*|加载中[. …]*|正在加载[. …]*|请稍候[. …]*)$/i.test(bodyText.trim());
  return { title, text, headings, links, status, busy, ready: document.readyState,
    sourceTruncated: capped, hasFrames: !!document.querySelector('iframe'), bodyText };
}

function extractionScript() { return `(${extractPage.toString()})()`; }

async function waitForContent(wc, { timeoutMs = 12000, minWaitMs = 2500, quietMs = 1600, intervalMs = 400, alive = () => true } = {}) {
  const start = Date.now();
  let signature = '', unchangedSince = start, last = null;
  while (alive() && Date.now() - start < timeoutMs) {
    try {
      last = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: extractionScript() }]);
      const next = crypto.createHash('sha256').update((last.bodyText || '') + '\n' + (last.text || '')).digest('hex');
      if (next !== signature) { signature = next; unchangedSince = Date.now(); }
      if (Date.now() - start >= minWaitMs && Date.now() - unchangedSince >= quietMs &&
          last.ready === 'complete' && !last.busy && (last.text || '').length >= 100) return { data: last, stable: true };
    } catch (error) { if (!alive()) throw error; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  if (!alive()) throw new Error('网页读取已取消');
  return { data: last || await wc.executeJavaScriptInIsolatedWorld(999, [{ code: extractionScript() }]), stable: false };
}

function createSnapshotCache() {
  const entries = new Map();
  function purge() {
    for (const [id, value] of entries) if (Date.now() - value.createdAt >= CACHE_TTL) entries.delete(id);
  }
  return {
    put(owner, url, data) {
      purge();
      while (entries.size >= 20) entries.delete(entries.keys().next().value);
      const id = crypto.randomUUID();
      entries.set(id, { owner, url, data: { ...data, text: data.text.slice(0, MAX_TEXT) }, createdAt: Date.now() });
      return id;
    },
    get(owner, options) {
      purge();
      const entry = entries.get(options.snapshotId);
      if (!entry || entry.owner !== owner || entry.url !== options.url) throw new Error('网页快照已过期或不属于当前窗口/URL，请从 offset=0 重新读取');
      return entry.data;
    }
  };
}

function pageSnapshot(data, options, snapshotId) {
  const totalChars = data.text.length;
  if (options.offset > totalChars) throw new Error('offset 超出网页正文长度');
  let text, nextOffset = null, matches = [];
  if (options.query) {
    const pattern = new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    let cursor = options.offset, remaining = options.limit;
    const find = () => { pattern.lastIndex = cursor; return pattern.exec(data.text); };
    while (remaining > 200 && matches.length < 10) {
      const match = find();
      if (!match) break;
      const index = match.index;
      const start = Math.max(options.offset, index - 150), end = Math.min(totalChars, start + remaining, index + match[0].length + 650);
      const snippet = data.text.slice(start, end);
      matches.push({ offset: index, start, end, text: snippet });
      remaining -= snippet.length; cursor = end;
    }
    if (find()) nextOffset = cursor;
    text = matches.map(m => `[匹配位置 ${m.offset}，片段 ${m.start}–${m.end}]\n${m.text}`).join('\n\n') || '未找到该关键词';
  } else {
    text = data.text.slice(options.offset, options.offset + options.limit);
    if (options.offset + text.length < totalChars) nextOffset = options.offset + text.length;
  }
  return { ok: true, title: data.title, finalUrl: data.finalUrl, text, snapshotId,
    offset: options.offset, totalChars, nextOffset, truncated: nextOffset !== null,
    sourceTruncated: !!data.sourceTruncated, warnings: data.warnings || [],
    headings: options.offset === 0 ? data.headings : [], links: options.offset === 0 ? data.links : [], matches };
}

// Validate every request (including redirects, frames, XHR and WebSockets), using
// Chromium's own resolver/cache rather than a separate Node DNS lookup.
async function checkRequestUrl(session, value) {
  const u = new URL(value);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  if (u.protocol === 'wss:') u.protocol = 'https:';
  const parsed = parsePublicWebUrl(u.href);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const result = await session.resolveHost(host, { cacheUsage: 'allowed' });
  if (!result.endpoints || !result.endpoints.length || result.endpoints.some(e => !isPublicIp(e.address))) throw new Error('域名解析到本机、局域网或非公网地址');
  return parsed.href;
}

function installRequestGuard(session, onBlocked = () => {}) {
  session.webRequest.onBeforeRequest((details, callback) => {
    if (/^(data|blob|about):/.test(details.url)) return callback({ cancel: false });
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) onBlocked(details, error);
      callback({ cancel: !!error });
    };
    const timer = setTimeout(() => finish(new Error('域名安全校验超时')), 5000);
    checkRequestUrl(session, details.url).then(() => finish(), finish);
  });
  const denyDownload = event => event.preventDefault();
  session.on('will-download', denyDownload);
  return () => { session.webRequest.onBeforeRequest(null); session.removeListener('will-download', denyDownload); };
}

module.exports = { normalizeReadOptions, extractionScript, waitForContent, createSnapshotCache, pageSnapshot, checkRequestUrl, installRequestGuard };
