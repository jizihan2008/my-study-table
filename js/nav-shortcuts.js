/* Pure sidebar navigation shortcut model.
 * 侧边栏栏目的快捷键统一为「Ctrl + 按键」，因此只存基础按键（字母 / 数字 / F1~F12 / 符号）。
 * 与 DOM、localStorage 无关，便于单元测试（tests/nav-shortcuts.test.js）。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NavShortcuts = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // 未自定义时的默认分配：可见栏目按顺序 Ctrl+1~9（保持旧版行为）
  const DEFAULT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const PUNCTUATION = [',', '.', '/', ';', "'", '[', ']', '-', '=', '`', '\\'];
  const NAMED_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
  const MODIFIER_KEYS = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Unidentified', 'Process'];
  // 应用/系统已占用的 Ctrl 组合，绑定后可能同时触发（仅提示，不阻止）
  const RESERVED_KEYS = ['r', 'z', 'y'];

  // 归一化按键：支持字母 / 数字 / F1~F12 / 常见符号，其余一律返回空串
  function normalize(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    if (!raw) return '';
    if (raw.length === 1) {
      const ch = raw.toLowerCase();
      if (/^[a-z0-9]$/.test(ch)) return ch;
      return PUNCTUATION.indexOf(ch) >= 0 ? ch : '';
    }
    const upper = raw.toUpperCase();
    return NAMED_KEYS.indexOf(upper) >= 0 ? upper : '';
  }

  // 从键盘事件提取按键。requireCtrl=false 时允许录制时只按基础键（界面标签始终显示 Ctrl+）
  function fromEvent(ev, opts) {
    if (!ev) return '';
    const requireCtrl = !opts || opts.requireCtrl !== false;
    if (requireCtrl && !ev.ctrlKey && !ev.metaKey) return '';
    if (ev.altKey) return '';
    const key = ev.key;
    if (typeof key !== 'string' || !key || MODIFIER_KEYS.indexOf(key) >= 0) return '';
    // Ctrl+Shift+字母 视为另一组组合键，不参与自定义；符号键要求不带 Shift
    if (ev.shiftKey && (/^[a-zA-Z]$/.test(key) || key.length === 1)) return '';
    return normalize(key);
  }

  function label(key) {
    const k = normalize(key);
    if (!k) return '';
    return 'Ctrl+' + (k.length === 1 ? k.toUpperCase() : k);
  }

  function isReserved(key) {
    const k = normalize(key);
    return !!k && RESERVED_KEYS.indexOf(k) >= 0;
  }

  function defaults(visibleIds) {
    const map = {};
    (visibleIds || []).forEach(function (id, i) {
      map[id] = i < DEFAULT_KEYS.length ? DEFAULT_KEYS[i] : '';
    });
    return map;
  }

  // 生成生效映射：ids 为全部栏目（含隐藏项，隐藏项的绑定保留），按顺序去重
  function resolve(stored, ids) {
    const map = {};
    const used = {};
    (ids || []).forEach(function (id) {
      const key = normalize(stored && stored[id]);
      if (!key || used[key]) { map[id] = ''; return; }
      used[key] = id;
      map[id] = key;
    });
    return map;
  }

  // 绑定按键：同一按键被其他栏目占用时自动从对方移除（返回被顶掉的栏目 id）
  function assign(map, tabId, key, ids) {
    const next = {};
    Object.keys(map || {}).forEach(function (id) { next[id] = normalize(map[id]); });
    (ids || []).forEach(function (id) { if (!(id in next)) next[id] = ''; });
    if (!tabId) return { map: next, displaced: [] };
    const wanted = normalize(key);
    const displaced = [];
    Object.keys(next).forEach(function (id) {
      if (id !== tabId && wanted && next[id] === wanted) {
        next[id] = '';
        displaced.push(id);
      }
    });
    next[tabId] = wanted;
    return { map: next, displaced: displaced };
  }

  function clear(map, tabId) {
    const next = {};
    Object.keys(map || {}).forEach(function (id) { next[id] = normalize(map[id]); });
    next[tabId] = '';
    return next;
  }

  // 按键触发时匹配栏目；只匹配可见（未隐藏）栏目
  function match(map, key, visibleIds) {
    const wanted = normalize(key);
    if (!wanted || !map) return '';
    const ids = visibleIds || Object.keys(map);
    for (let i = 0; i < ids.length; i++) {
      if (map[ids[i]] === wanted) return ids[i];
    }
    return '';
  }

  return {
    DEFAULT_KEYS: DEFAULT_KEYS,
    NAMED_KEYS: NAMED_KEYS,
    normalize: normalize,
    fromEvent: fromEvent,
    label: label,
    isReserved: isReserved,
    defaults: defaults,
    resolve: resolve,
    assign: assign,
    clear: clear,
    match: match
  };
});
