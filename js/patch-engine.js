// ═══════════════════════════════════════════════════════════
//  PatchEngine：运行时函数覆盖引擎
//  用于 patch（源码补丁）类扩展。核心思想：保存原函数引用 →
//  覆盖目标全局函数 → 卸载时恢复原函数。真正可装载/卸载，
//  不修改核心磁盘文件，天然支持回滚。
// ═══════════════════════════════════════════════════════════

window.PatchEngine = (function () {
  // extId -> [{ owner, name, original, newFn, isActive }]
  const _overrides = {};

  function _list(extId) {
    if (!_overrides[extId]) _overrides[extId] = [];
    return _overrides[extId];
  }

  // 覆盖目标对象上的函数。target 通常是 window。
  function override(extId, target, name, newFn) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
      return { ok: false, reason: 'target 无效' };
    }
    if (typeof newFn !== 'function') {
      return { ok: false, reason: 'newFn 必须是函数' };
    }
    if (typeof target[name] !== 'function') {
      return { ok: false, reason: '目标函数不存在: ' + name };
    }
    const original = target[name];
    target[name] = newFn;
    _list(extId).push({ owner: target, name, original, newFn, isActive: true });
    return { ok: true };
  }

  // 包装目标函数：wrapper(original, thisArg, args) 形式
  function wrap(extId, target, name, wrapper) {
    if (typeof target[name] !== 'function') {
      return { ok: false, reason: '目标函数不存在: ' + name };
    }
    if (typeof wrapper !== 'function') {
      return { ok: false, reason: 'wrapper 必须是函数' };
    }
    const original = target[name];
    const wrapped = function () {
      return wrapper(original, this, Array.prototype.slice.call(arguments));
    };
    return override(extId, target, name, wrapped);
  }

  // 恢复单个函数（本扩展最近一次覆盖）
  function restore(extId, target, name) {
    const list = _list(extId);
    for (let i = list.length - 1; i >= 0; i--) {
      const rec = list[i];
      if (rec.owner === target && rec.name === name && rec.isActive) {
        // 仅当当前值仍是我们的新函数时恢复，避免踩掉其他扩展的覆盖
        if (rec.owner[name] === rec.newFn) {
          rec.owner[name] = rec.original;
        }
        rec.isActive = false;
        return { ok: true };
      }
    }
    return { ok: false, reason: '未找到覆盖记录' };
  }

  // 恢复某扩展的所有覆盖（卸载 / 回滚时调用）
  function revertExt(extId) {
    const list = _list(extId);
    let restored = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const rec = list[i];
      if (!rec.isActive) continue;
      if (rec.owner[rec.name] === rec.newFn) {
        rec.owner[rec.name] = rec.original;
      }
      rec.isActive = false;
      restored++;
    }
    delete _overrides[extId];
    return { ok: true, restored };
  }

  // 查询某扩展的覆盖记录
  function getOverrides(extId) {
    return _list(extId)
      .filter(r => r.isActive)
      .map(r => ({ name: r.name, active: r.isActive }));
  }

  return {
    override,
    wrap,
    restore,
    revertExt,
    getOverrides
  };
})();
