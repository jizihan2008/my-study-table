// 同步渲染期间将 HTML 写入转成 DOM 差量更新；普通交互沿用原来的渲染方式。
(function (global) {
  'use strict';
  let depth = 0;
  let currentRender = null;
  const pending = new WeakMap();
  const descriptor = Object.getOwnPropertyDescriptor(global.Element.prototype, 'innerHTML');

  function key(node) {
    if (node.nodeType !== 1) return null;
    for (const attr of ['id', 'data-id', 'data-item-id', 'data-sync-id', 'data-qid']) {
      if (node.hasAttribute(attr)) return node.tagName + ':' + attr + ':' + node.getAttribute(attr);
    }
    return null;
  }
  function compatible(a, b) {
    if (a.nodeType === 1 && b.nodeType === 1 && a.getAttribute('data-lucide') &&
        a.getAttribute('data-lucide') === b.getAttribute('data-lucide')) return true;
    return a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
  }
  function protectedNode(node) {
    const active = global.document.activeElement;
    return active && active !== global.document.body && (node === active || node.contains?.(active));
  }
  function patch(node, desired) {
    if (node.isEqualNode(desired)) return;
    // lucide 已将占位 i 转成 svg，相同图标不重复替换。
    if (node.nodeType === 1 && node.getAttribute('data-lucide') &&
        node.getAttribute('data-lucide') === desired.getAttribute('data-lucide')) return;
    if (node.nodeType !== 1) {
      if (node.nodeValue !== desired.nodeValue) node.nodeValue = desired.nodeValue;
      return;
    }
    // 输入中的控件不写属性或子节点，保留值、选区和 IME 组合态。
    if (node === global.document.activeElement) return;
    for (const attr of Array.from(node.attributes)) {
      if (!desired.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    }
    for (const attr of Array.from(desired.attributes)) {
      if (node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    }
    reconcile(node, desired);
  }
  function reconcile(parent, desired) {
    const old = Array.from(parent.childNodes);
    const keyed = new Map(old.map(node => [key(node), node]).filter(([id]) => id));
    const used = new Set();
    let cursor = parent.firstChild;
    for (const next of Array.from(desired.childNodes)) {
      const id = key(next);
      let node = id ? keyed.get(id) : old.find(item => !used.has(item) && !key(item) && compatible(item, next));
      if (!node || !compatible(node, next)) node = next.cloneNode(true);
      used.add(node);
      if (node !== cursor) {
        // 移动包含焦点的条目可能触发 blur，留到用户结束编辑后处理。
        if (protectedNode(node) || (cursor && protectedNode(cursor))) return false;
        parent.insertBefore(node, cursor);
      }
      patch(node, next);
      cursor = node.nextSibling;
    }
    for (const node of old) {
      if (used.has(node)) continue;
      if (protectedNode(node)) return false;
      node.remove();
    }
    return true;
  }
  function update(parent, html) {
    const desired = parent.cloneNode(false);
    descriptor.set.call(desired, html);
    // 深层的移动/删除也需要一次失焦后的补更新。
    const active = global.document.activeElement;
    if (protectedNode(parent)) {
      const existing = pending.get(parent);
      pending.set(parent, { html, render: currentRender });
      if (existing === undefined) active.addEventListener('blur', () => {
        global.setTimeout(() => {
          const latest = pending.get(parent);
          pending.delete(parent);
          if (parent.isConnected && latest !== undefined) {
            if (latest.render) run(latest.render);
            else update(parent, latest.html);
          }
        }, 0);
      }, { once: true });
    }
    reconcile(parent, desired);
  }
  function run(render) {
    const previousRender = currentRender;
    currentRender = render;
    if (depth++) {
      try { return render(); } finally { depth--; currentRender = previousRender; }
    }
    Object.defineProperty(global.Element.prototype, 'innerHTML', {
      ...descriptor, set(html) { update(this, html); }
    });
    try { return render(); }
    finally {
      depth--;
      currentRender = previousRender;
      Object.defineProperty(global.Element.prototype, 'innerHTML', descriptor);
    }
  }
  global.SyncDOM = { run, update, get active() { return depth > 0; } };
})(window);
