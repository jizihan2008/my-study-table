'use strict';

const path = require('path');

const BLOCKED_EXTERNAL_PROTOCOLS = new Set([
  'data:',
  'file:',
  'javascript:',
  'vbscript:'
]);

const BLOCKED_WEB_HOSTS = new Set([
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  'localhost',
  'localhost.localdomain'
]);

function normalizeExtensionId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]+$/.test(id) ? id : '';
}

function isPathInside(base, target, options = {}) {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative === '') return options.allowBase === true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function parseExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('链接不能为空');
  const parsed = new URL(raw);
  if (BLOCKED_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new Error('不允许打开该协议的链接');
  }
  return parsed;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168);
}

function isPrivateIpv6(hostname) {
  const value = hostname.toLowerCase();
  return value === '::' || value === '::1' ||
    value.startsWith('fc') || value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.');
}

function parsePublicWebUrl(value) {
  const parsed = parseExternalUrl(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议的网页');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_WEB_HOSTS.has(hostname) || isPrivateIpv4(hostname) || isPrivateIpv6(hostname) || hostname.endsWith('.localhost')) {
    throw new Error('不允许访问本机或局域网地址');
  }
  return parsed;
}

module.exports = {
  isPathInside,
  normalizeExtensionId,
  parseExternalUrl,
  parsePublicWebUrl
};
