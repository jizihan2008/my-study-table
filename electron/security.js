'use strict';

const path = require('path');
const net = require('node:net');

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
  return parts[0] === 0 || parts[0] >= 224 || parts[0] === 10 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && (parts[1] === 168 || (parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)))) ||
    (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || (parts[1] === 51 && parts[2] === 100))) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113);
}

function isPrivateIpv6(hostname) {
  const value = hostname.toLowerCase();
  // WHATWG URL canonicalizes dotted IPv4-mapped addresses to hexadecimal.
  const mapped = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/.exec(value);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return value === '::' || value === '::1' ||
    value.startsWith('fc') || value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.');
}

function isPublicIp(value) {
  let address = String(value || '').replace(/^\[|\]$/g, '');
  if (net.isIP(address) === 6) address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return net.isIP(address) === 4 ? !isPrivateIpv4(address)
    : net.isIP(address) === 6 && !isPrivateIpv6(address) && /^[23]/.test(address) &&
      !address.startsWith('2001:db8:') && !address.startsWith('2002:');
}

function parsePublicWebUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('网页 URL 必须是最多 2048 字的字符串');
  const parsed = parseExternalUrl(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议的网页');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (parsed.username || parsed.password) throw new Error('网页 URL 不允许包含用户名或密码');
  if (BLOCKED_WEB_HOSTS.has(hostname) || (net.isIP(hostname) && !isPublicIp(hostname)) || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !hostname.includes('.') && !net.isIP(hostname)) {
    throw new Error('不允许访问本机或局域网地址');
  }
  return parsed;
}

module.exports = {
  isPathInside,
  normalizeExtensionId,
  parseExternalUrl,
  isPublicIp,
  parsePublicWebUrl
};
