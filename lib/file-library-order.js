(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FileLibraryOrder = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function compare(a, b) {
    const aOrder = Number.isFinite(a.order) ? a.order : Infinity;
    const bOrder = Number.isFinite(b.order) ? b.order : Infinity;
    return aOrder - bOrder || (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name, 'zh-CN');
  }

  function organize(rows, { id, parentId = null, beforeId = null } = {}) {
    const byId = new Map(rows.map(row => [row.id, row]));
    const item = byId.get(id);
    if (!item) throw new Error('项目不存在');
    if (parentId && byId.get(parentId)?.kind !== 'folder') throw new Error('目标文件夹不存在');
    const visited = new Set();
    for (let cursor = parentId; cursor; cursor = byId.get(cursor)?.parentId) {
      if (cursor === id || visited.has(cursor)) throw new Error('不能将文件夹放入自身或其子文件夹');
      visited.add(cursor);
    }
    const siblings = rows.filter(row => (row.parentId || null) === parentId && row.id !== id).sort(compare);
    if (beforeId === id) return [];
    const index = beforeId === null ? siblings.length : siblings.findIndex(row => row.id === beforeId);
    if (index < 0) throw new Error('排序目标不存在');
    siblings.splice(index, 0, item);
    return siblings.map((row, order) => ({ ...row, parentId, order }));
  }

  return { compare, organize };
});
