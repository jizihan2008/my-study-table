// Read-only, bounded content previews for all sync conflict channels.
(function (global, factory) {
  'use strict';
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./sync-policy') : global.SyncPolicy);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.SyncDiff = api;
})(typeof window !== 'undefined' ? window : globalThis, function (policy) {
  'use strict';

  const FIELD_LABELS = {
    title: '标题', text: '文字', content: '正文', name: '名称', description: '描述',
    completed: '完成状态', done: '完成状态', dueDate: '截止日期', completedAt: '完成时间',
    createdAt: '创建时间', updatedAt: '修改时间', parentId: '所属文件夹 / 父项目',
    tags: '标签', url: '网址', source: '来源', color: '颜色', pinned: '置顶',
    systemPrompt: '系统提示词', messages: '消息', items: '消息 / 日志', meta: '基本信息',
    tree: '对话分支', activePath: '当前分支', role: '消息角色', lines: '任务线',
    date: '日期', start: '开始时间', end: '结束时间', deleted: '删除状态',
    autoTitled: '自动标题', daily: '日报标记', id: 'ID'
  };
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const itemLabel = (value, index) => value && typeof value === 'object'
    ? String(value.title || value.text || value.name || (value.id != null ? 'ID ' + value.id : '第 ' + (index + 1) + ' 项')).slice(0, 80)
    : '第 ' + (index + 1) + ' 项';

  function preview(value, missing, offset = 0) {
    if (missing) return '（不存在 / 已删除）';
    if (value === null) return '（空值 null）';
    if (value === '') return '（空字符串）';
    if (typeof value === 'boolean') return value ? 'true（是）' : 'false（否）';
    if (typeof value === 'number') return value + '（数字）';
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    if (text === undefined) return '（未设置）';
    let start = Math.max(0, offset - 70);
    // Short lines must not bury the actual change below many lines of context.
    const precedingLine = text.lastIndexOf('\n', Math.max(0, offset - 1));
    if (precedingLine > 0) start = Math.max(start, text.lastIndexOf('\n', precedingLine - 1) + 1);
    let end = Math.min(text.length, start + 260);
    let nextLine = offset;
    for (let i = 0; i < 3; i++) {
      const newline = text.indexOf('\n', nextLine);
      if (newline < 0) break;
      nextLine = newline + 1;
      if (i === 2) end = Math.min(end, newline);
    }
    return (start ? '…' : '') + text.slice(start, end) + (text.length > end ? '…' : '');
  }

  function compare(local, remote, options = {}) {
    const entries = [];
    let truncated = false;
    let visited = 0;
    const limit = 40;
    function add(path, left, right, leftMissing, rightMissing, kind = '修改') {
      if (entries.length >= limit) { truncated = true; return; }
      let offset = 0;
      let location = '';
      if (!leftMissing && !rightMissing && typeof left === 'string' && typeof right === 'string') {
        while (offset < Math.min(left.length, right.length) && left[offset] === right[offset]) offset++;
        const before = left.slice(0, offset);
        const line = before.split('\n').length;
        const column = offset - before.lastIndexOf('\n');
        location = '首次不同：第 ' + line + ' 行，第 ' + column + ' 个字符';
      }
      entries.push({ path: path || '内容', kind: leftMissing ? '仅云端存在' : rightMissing ? '仅本地存在' : kind,
        local: preview(left, leftMissing, offset), remote: preview(right, rightMissing, offset), location });
    }
    function walk(left, right, path, leftMissing = false, rightMissing = false, depth = 0) {
      if (++visited > 20000 || entries.length >= limit) { truncated = true; return; }
      if (leftMissing && rightMissing) return;
      if (leftMissing || rightMissing) { add(path, left, right, leftMissing, rightMissing); return; }
      if (policy.sameContent(left, right)) return;
      if (depth >= 30) { add(path, left, right, false, false); return; }
      if (Array.isArray(left) && Array.isArray(right)) {
        const keyed = array => array.every(item => item && typeof item === 'object' && item.id != null) &&
          new Set(array.map(item => String(item.id))).size === array.length;
        if (keyed(left) && keyed(right)) {
          const a = new Map(left.map((item, i) => [String(item.id), { item, i }]));
          const b = new Map(right.map((item, i) => [String(item.id), { item, i }]));
          const commonA = [...a.keys()].filter(id => b.has(id));
          const commonB = [...b.keys()].filter(id => a.has(id));
          if (!policy.sameContent(commonA, commonB)) {
            add((path || '列表') + ' → 顺序', left.map(itemLabel), right.map(itemLabel), false, false, '顺序变化');
          }
          for (const id of new Set([...a.keys(), ...b.keys()])) {
            if (entries.length >= limit || visited > 20000) { truncated = true; break; }
            const x = a.get(id), y = b.get(id), label = itemLabel((x || y).item, (x || y).i);
            walk(x && x.item, y && y.item, (path ? path + ' → ' : '') + label + ' [ID ' + id + ']', !x, !y, depth + 1);
          }
        } else {
          for (let i = 0; i < Math.max(left.length, right.length); i++) {
            if (entries.length >= limit || visited > 20000) { truncated = true; break; }
            walk(left[i], right[i], (path ? path + ' → ' : '') + '第 ' + (i + 1) + ' 项', i >= left.length, i >= right.length, depth + 1);
          }
        }
        return;
      }
      if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
          if (entries.length >= limit || visited > 20000) { truncated = true; break; }
          walk(left[key], right[key], (path ? path + ' → ' : '') + (FIELD_LABELS[key] || key),
            !Object.prototype.hasOwnProperty.call(left, key), !Object.prototype.hasOwnProperty.call(right, key), depth + 1);
        }
        return;
      }
      add(path, left, right, false, false);
    }
    walk(local, remote, '', !!options.localMissing, !!options.remoteMissing);
    return { entries, truncated };
  }

  function render(result) {
    if (!result || !result.ok) return '<p class="sync-diff-hint">无法查看差异：' + escape(result && result.reason || '读取失败，请重试') + '</p>';
    const diff = compare(result.local, result.remote, result);
    if (!diff.entries.length && !diff.truncated) return '<p class="sync-diff-hint">两端当前内容一致。请重新同步以核对并排除这项冲突。</p>';
    return '<p class="sync-diff-hint">对比的是当前本地与刚读取的云端内容；长内容显示差异附近的片段。</p>' +
      diff.entries.map(entry => '<section class="sync-diff-entry"><div class="sync-diff-path"><strong>' + escape(entry.path) + '</strong><span>' + escape(entry.kind) + '</span></div>' +
        (entry.location ? '<p class="sync-diff-location">' + escape(entry.location) + '</p>' : '') +
        '<div class="sync-diff-columns"><div><span>本地</span><pre>' + escape(entry.local) + '</pre></div><div><span>云端</span><pre>' + escape(entry.remote) + '</pre></div></div></section>').join('') +
      (diff.truncated ? '<p class="sync-diff-hint">差异较多，当前展示前 40 项或已扫描范围内的差异。</p>' : '');
  }

  async function show(button, load) {
    const target = button.closest('.sync-conflict-item').querySelector('.sync-conflict-diff');
    if (!target || button.disabled) return;
    button.disabled = true;
    target.hidden = false;
    target.textContent = '正在读取云端内容并比较…';
    try { target.innerHTML = render(await load()); }
    catch (error) { target.innerHTML = render({ ok: false, reason: String(error && error.message || error) }); }
    finally { button.disabled = false; button.textContent = '刷新具体差异'; }
  }

  return { compare, render, show };
});
