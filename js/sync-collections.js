// Record-level sync for collections whose members have stable IDs.
(function (global) {
  'use strict';

  const COLLECTIONS = {
    study_todos_v2: '待办',
    study_notes_v2: '笔记',
    study_links_v3: '链接',
    study_calendar_events: '日历事件',
    study_habits_v2: '习惯',
    study_books_v1: '教材'
  };
  const STATE_KEY = 'study_sync_collection_state_v1';
  const ORDER_STATE_KEY = 'study_sync_collection_order_v1';
  const CONFLICT_KEY = 'study_sync_collection_conflicts_v1';
  const PREFIX = 'mst:item:v1:';
  const ORDER_PREFIX = 'mst:order:v1:';
  let applyingRemote = false;
  let running = Promise.resolve();
  const pendingCollections = new Set();
  const changeVersions = new Map();

  function isCollection(key) { return Object.prototype.hasOwnProperty.call(COLLECTIONS, key); }
  function isCloudKey(key) {
    return typeof key === 'string' && (key.startsWith(PREFIX) || key.startsWith(ORDER_PREFIX));
  }
  function orderKey(collection) { return ORDER_PREFIX + encodeURIComponent(collection); }
  function cloudKey(collection, id) {
    return PREFIX + encodeURIComponent(collection) + ':' + encodeURIComponent(String(id));
  }
  function parseCloudKey(key) {
    if (!isCloudKey(key)) return null;
    const parts = key.slice(PREFIX.length).split(':');
    if (parts.length !== 2) return null;
    try {
      const collection = decodeURIComponent(parts[0]);
      const id = decodeURIComponent(parts[1]);
      return isCollection(collection) ? { collection, id } : null;
    } catch (_) { return null; }
  }
  function parseOrderKey(key) {
    if (typeof key !== 'string' || !key.startsWith(ORDER_PREFIX)) return null;
    try {
      const collection = decodeURIComponent(key.slice(ORDER_PREFIX.length));
      return isCollection(collection) ? collection : null;
    } catch (_) { return null; }
  }
  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (_) { return fallback; }
  }
  function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function hash(value) {
    // Array positions shift when a different record is inserted or removed.
    // Only the record content belongs to this record's conflict domain.
    const normalized = value && value.deleted ? { deleted: true } : value && value.item;
    const text = JSON.stringify(normalized === undefined ? null : normalized);
    if (global.StudyData && global.StudyData.hashText) return global.StudyData.hashText(text);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  }
  function deletedValue() { return { deleted: true }; }
  function entry(item, index) { return { item, index, deleted: false }; }
  function readItems(collection) {
    const raw = localStorage.getItem(collection);
    if (raw == null) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error(collection + ' 本地数据不是数组');
    const ids = new Set();
    for (const item of items) {
      if (!item || item.id == null || ids.has(String(item.id))) {
        throw new Error(collection + ' 含缺失或重复的记录 ID');
      }
      ids.add(String(item.id));
    }
    return items;
  }
  function localMap(collection) {
    return new Map(readItems(collection).map((item, index) => [String(item.id), entry(item, index)]));
  }
  function state() { return readJson(STATE_KEY, {}); }
  function conflicts() { return readJson(CONFLICT_KEY, {}); }
  function recordState(collection, id, value, timestamp) {
    const all = state();
    const group = all[collection] || {};
    group[id] = { hash: hash(value), timestamp };
    all[collection] = group;
    writeJson(STATE_KEY, all);
  }
  function queueConflict(collection, id, localValue, remoteRow, reason) {
    const all = conflicts();
    const key = cloudKey(collection, id);
    const item = localValue && localValue.item;
    const baseline = (state()[collection] || {})[id];
    all[key] = {
      key, collection, id,
      label: COLLECTIONS[collection] + '：' + String(item && (item.title || item.text || item.name) || id),
      reason,
      baseTimestamp: baseline && baseline.timestamp || null,
      remoteTimestamp: remoteRow && remoteRow.updated_at || null,
      detectedAt: all[key] && all[key].detectedAt || new Date().toISOString()
    };
    writeJson(CONFLICT_KEY, all);
  }
  function queueOrderConflict(collection, remoteRow, baseline) {
    const all = conflicts();
    const key = orderKey(collection);
    all[key] = {
      key, collection, label: COLLECTIONS[collection] + '：排序',
      reason: 'both-changed-order',
      baseTimestamp: baseline && baseline.timestamp || null,
      remoteTimestamp: remoteRow.updated_at,
      detectedAt: all[key] && all[key].detectedAt || new Date().toISOString()
    };
    writeJson(CONFLICT_KEY, all);
  }
  function clearConflict(key) {
    const all = conflicts();
    if (key in all) { delete all[key]; writeJson(CONFLICT_KEY, all); }
  }
  function getPendingConflicts() { return Object.values(conflicts()); }
  function pendingCount() {
    const pending = new Set(getPendingConflicts().map(item => item.key));
    const all = state();
    for (const collection of Object.keys(COLLECTIONS)) {
      try {
        const current = localMap(collection);
        const known = all[collection] || {};
        const ids = new Set([...current.keys(), ...Object.keys(known)]);
        for (const id of ids) {
          const value = current.get(id) || deletedValue();
          if (!known[id] || known[id].hash !== hash(value)) pending.add(cloudKey(collection, id));
        }
      } catch (_) { pending.add(collection); }
    }
    return pending.size;
  }
  function onLocalChange(key) {
    if (!isCollection(key) || applyingRemote) return false;
    pendingCollections.add(key);
    changeVersions.set(key, (changeVersions.get(key) || 0) + 1);
    return true;
  }
  function onRemoteChange(key) {
    if (key.startsWith(ORDER_PREFIX)) {
      try {
        const collection = decodeURIComponent(key.slice(ORDER_PREFIX.length));
        if (isCollection(collection)) {
          pendingCollections.add(collection);
          changeVersions.set(collection, (changeVersions.get(collection) || 0) + 1);
        }
      } catch (_) {}
      return;
    }
    const parsed = parseCloudKey(key);
    if (parsed) {
      pendingCollections.add(parsed.collection);
      changeVersions.set(parsed.collection, (changeVersions.get(parsed.collection) || 0) + 1);
    }
  }

  async function queryAll(makeQuery) {
    const size = 500;
    const rows = [];
    for (let start = 0; ; start += size) {
      let query = makeQuery();
      if (typeof query.range !== 'function') {
        const { data, error } = await query;
        if (error) throw new Error(error.message || '读取云端记录失败');
        return data || [];
      }
      if (typeof query.order === 'function') query = query.order('key', { ascending: true });
      const { data, error } = await query.range(start, start + size - 1);
      if (error) throw new Error(error.message || '读取云端记录失败');
      rows.push(...(data || []));
      if (!data || data.length < size) return rows;
    }
  }
  async function remoteRows(c, userId, collection) {
    const prefix = PREFIX + encodeURIComponent(collection) + ':';
    const rows = await queryAll(() => c.from('user_data')
      .select('key,value,updated_at').eq('user_id', userId).like('key', prefix + '%'));
    const result = new Map();
    for (const row of rows) {
      const parsed = parseCloudKey(row.key);
      if (parsed && parsed.collection === collection) result.set(parsed.id, row);
    }
    return result;
  }
  async function legacyRows(c, userId) {
    const { data, error } = await c.from('user_data').select('key,value,updated_at')
      .eq('user_id', userId).in('key', Object.keys(COLLECTIONS));
    if (error) throw new Error(error.message || '读取旧版云端数据失败');
    return new Map((data || []).map(row => [row.key, row]));
  }
  function legacyMap(row) {
    if (!row || !Array.isArray(row.value)) return new Map();
    const map = new Map();
    row.value.forEach((item, index) => {
      if (item && item.id != null) map.set(String(item.id), {
        key: null, value: entry(item, index), updated_at: row.updated_at, legacy: true
      });
    });
    return map;
  }
  function applyRemote(collection, id, value) {
    const items = readItems(collection);
    const existingIndex = items.findIndex(item => String(item.id) === String(id));
    if (existingIndex >= 0) items.splice(existingIndex, 1);
    if (value && !value.deleted) {
      if (!value.item || String(value.item.id) !== String(id)) throw new Error('云端记录 ID 不匹配');
      const index = Math.max(0, Math.min(items.length, Number(value.index) || 0));
      items.splice(index, 0, value.item);
    }
    applyingRemote = true;
    try {
      if (typeof saveData === 'function') {
        if (!saveData(collection, items)) throw new Error('保存远端记录到本地失败');
      } else writeJson(collection, items);
    } finally { applyingRemote = false; }
  }
  function applyOrder(collection, wantedIds) {
    const items = readItems(collection);
    const byId = new Map(items.map(item => [String(item.id), item]));
    const ordered = [];
    for (const id of wantedIds || []) {
      const item = byId.get(String(id));
      if (item) { ordered.push(item); byId.delete(String(id)); }
    }
    ordered.push(...byId.values());
    if (items.map(item => String(item.id)).join('\u0000') ===
        ordered.map(item => String(item.id)).join('\u0000')) return false;
    applyingRemote = true;
    try {
      if (typeof saveData === 'function') {
        if (!saveData(collection, ordered)) throw new Error('保存云端排序失败');
      } else writeJson(collection, ordered);
    } finally { applyingRemote = false; }
    return true;
  }
  async function syncOrder(c, userId, collection) {
    const key = orderKey(collection);
    if (conflicts()[key]) return false;
    const initialIds = readItems(collection).map(item => String(item.id));
    if (!initialIds.length && !readJson(ORDER_STATE_KEY, {})[collection]) return false;
    const { data: remote, error } = await c.from('user_data')
      .select('value,updated_at').eq('user_id', userId).eq('key', key).maybeSingle();
    if (error) throw new Error(error.message || '读取云端排序失败');
    const all = readJson(ORDER_STATE_KEY, {});
    const baseline = all[collection];
    const current = readItems(collection).map(item => String(item.id));
    const remoteIds = remote && Array.isArray(remote.value) ? remote.value.map(String) : null;
    const localChanged = !!baseline && baseline.ids.join('\u0000') !== current.join('\u0000');
    const remoteChanged = !!baseline && remote && remote.updated_at !== baseline.timestamp;
    if (localChanged && remoteChanged && remoteIds &&
        current.join('\u0000') !== remoteIds.join('\u0000')) {
      queueOrderConflict(collection, remote, baseline);
      return false;
    }
    let applied = false;
    if (remoteIds && (!baseline || !localChanged || remoteChanged)) {
      applied = applyOrder(collection, remoteIds);
    }
    const desired = readItems(collection).map(item => String(item.id));
    const cloudOrder = remoteIds && remoteIds.join('\u0000');
    if (!remote || desired.join('\u0000') !== cloudOrder) {
      const result = remote
        ? await c.from('user_data').update({ value: desired }).eq('user_id', userId)
          .eq('key', key).eq('updated_at', remote.updated_at).select('updated_at').maybeSingle()
        : await c.from('user_data').insert({ user_id: userId, key, value: desired })
          .select('updated_at').single();
      if (result.error && result.error.code !== '23505') throw new Error(result.error.message || '上传排序失败');
      if (result.data && result.data.updated_at) {
        all[collection] = { ids: desired, timestamp: result.data.updated_at };
        writeJson(ORDER_STATE_KEY, all);
      } else {
        const { data: latest, error: readError } = await c.from('user_data')
          .select('value,updated_at').eq('user_id', userId).eq('key', key).maybeSingle();
        if (readError || !latest) throw new Error('上传排序后无法读取云端版本');
        queueOrderConflict(collection, latest, baseline);
      }
    } else {
      all[collection] = { ids: desired, timestamp: remote.updated_at };
      writeJson(ORDER_STATE_KEY, all);
    }
    return applied;
  }
  async function writeItem(c, userId, collection, id, value, baseTimestamp, force) {
    const key = cloudKey(collection, id);
    let result;
    if (force) {
      result = await c.from('user_data').upsert({ user_id: userId, key, value },
        { onConflict: 'user_id,key' }).select('updated_at').single();
    } else if (baseTimestamp) {
      result = await c.from('user_data').update({ value }).eq('user_id', userId)
        .eq('key', key).eq('updated_at', baseTimestamp).select('updated_at').maybeSingle();
    } else {
      result = await c.from('user_data').insert({ user_id: userId, key, value })
        .select('updated_at').single();
    }
    if (result && result.error && result.error.code === '23505') return { conflict: true };
    if (result && result.error) throw new Error(result.error.message || '上传记录失败');
    if (!result || !result.data || !result.data.updated_at) return { conflict: true };
    return { timestamp: result.data.updated_at };
  }
  async function syncCollection(c, userId, collection, legacy, force) {
    const known = state()[collection] || {};
    const cloud = await remoteRows(c, userId, collection);
    const local = localMap(collection);
    const old = legacyMap(legacy);
    const ids = new Set([...local.keys(), ...Object.keys(known), ...cloud.keys(), ...old.keys()]);
    let applied = false;
    for (const id of ids) {
      const key = cloudKey(collection, id);
      if (conflicts()[key] && !force) continue;
      const current = local.get(id);
      const value = current || deletedValue();
      const latest = localMap(collection).get(id) || deletedValue();
      if (hash(latest) !== hash(value)) {
        pendingCollections.add(collection);
        continue;
      }
      const baseline = known[id];
      const remote = cloud.get(id) || old.get(id);
      const cloudRow = cloud.get(id);
      const oldRow = old.get(id);
      if (!force && cloudRow && legacy &&
          new Date(legacy.updated_at).getTime() > new Date(cloudRow.updated_at).getTime() &&
          hash(oldRow ? oldRow.value : deletedValue()) !== hash(cloudRow.value)) {
        queueConflict(collection, id, value, cloudRow, 'legacy-device-change');
        continue;
      }
      const remoteValue = remote && remote.value;
      const dirty = !!baseline && baseline.hash !== hash(value);
      const advanced = !!baseline && (!remote || remote.updated_at !== baseline.timestamp);
      if (!baseline && current && remote && hash(value) !== hash(remoteValue) && !force) {
        queueConflict(collection, id, value, remote, 'missing-sync-base');
        continue;
      }
      if (dirty && advanced && !force) {
        queueConflict(collection, id, value, remote, 'both-changed');
        continue;
      }
      if (current && remote && !baseline && hash(value) === hash(remoteValue)) {
        if (!remote.legacy) { recordState(collection, id, value, remote.updated_at); continue; }
      }
      if (remote && !dirty && (!current || baseline && advanced) && !force) {
        applyRemote(collection, id, remoteValue);
        applied = true;
        if (!remote.legacy) { recordState(collection, id, remoteValue, remote.updated_at); continue; }
      }
      if (!current && !baseline && !remote) continue;
      if (remote && !remote.legacy && !dirty && baseline && !advanced && !force) continue;
      // Legacy whole-array rows are only a migration source. New writes always use item rows.
      const upload = remote && remote.legacy && !dirty && !force ? remoteValue : value;
      const expected = cloud.get(id) && cloud.get(id).updated_at || null;
      const written = await writeItem(c, userId, collection, id, upload, expected, force);
      if (written.conflict) { queueConflict(collection, id, value, remote, 'cloud-changed-during-upload'); continue; }
      recordState(collection, id, upload, written.timestamp);
      clearConflict(key);
    }
    applied = await syncOrder(c, userId, collection) || applied;
    return applied;
  }
  function sync(options = {}) {
    const work = running.then(async () => {
      const { session, client, force, full } = options;
      if (!session || !session.user || !client) return { applied: false };
      if (global.Sync && global.Sync.canSyncAccount && !global.Sync.canSyncAccount(session.user.id)) {
        return { applied: false, blocked: true };
      }
      const selected = force || full ? Object.keys(COLLECTIONS) : Array.from(pendingCollections);
      if (!selected.length) return { applied: false, errors: [] };
      const legacy = await legacyRows(client, session.user.id);
      let applied = false;
      const errors = [];
      for (const collection of selected) {
        const versionAtStart = changeVersions.get(collection) || 0;
        try {
          applied = await syncCollection(client, session.user.id, collection, legacy.get(collection), !!force) || applied;
          if ((changeVersions.get(collection) || 0) === versionAtStart) pendingCollections.delete(collection);
        } catch (e) {
          errors.push(COLLECTIONS[collection] + '：' + String(e && e.message || e));
        }
      }
      return { applied, errors };
    });
    running = work.catch(() => {});
    return work;
  }
  async function resolveConflict(key, choice, session, client) {
    const orderCollection = parseOrderKey(key);
    if (orderCollection) {
      if (!conflicts()[key]) return { ok: false, reason: '冲突不存在' };
      if (!session || !client || !global.Sync.canSyncAccount(session.user.id)) return { ok: false, reason: '账号不可用' };
      try {
        const { data: remote, error } = await client.from('user_data')
          .select('value,updated_at').eq('user_id', session.user.id).eq('key', key).maybeSingle();
        if (error || !remote || !Array.isArray(remote.value)) throw new Error('云端排序不可用');
        const previous = conflicts()[key];
        if (previous.remoteTimestamp !== remote.updated_at) throw new Error('云端排序已变化，请重新同步');
        let ids;
        let timestamp = remote.updated_at;
        if (choice === 'remote') {
          ids = remote.value.map(String);
          applyOrder(orderCollection, ids);
        } else if (choice === 'local') {
          ids = readItems(orderCollection).map(item => String(item.id));
          const result = await client.from('user_data').update({ value: ids })
            .eq('user_id', session.user.id).eq('key', key)
            .eq('updated_at', remote.updated_at).select('updated_at').maybeSingle();
          if (result.error || !result.data) throw new Error('云端排序已变化，请重新同步');
          timestamp = result.data.updated_at;
        } else return { ok: false, reason: '无效的处理方式' };
        const all = readJson(ORDER_STATE_KEY, {});
        all[orderCollection] = { ids: readItems(orderCollection).map(item => String(item.id)), timestamp };
        writeJson(ORDER_STATE_KEY, all);
        clearConflict(key);
        pendingCollections.add(orderCollection);
        return { ok: true, applied: choice === 'remote' };
      } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    }
    const parsed = parseCloudKey(key);
    if (!parsed || !conflicts()[key]) return { ok: false, reason: '冲突不存在' };
    if (!session || !client || !global.Sync.canSyncAccount(session.user.id)) return { ok: false, reason: '账号不可用' };
    const { collection, id } = parsed;
    try {
      const cloud = await remoteRows(client, session.user.id, collection);
      let remote = cloud.get(id);
      if (!remote || conflicts()[key].reason === 'legacy-device-change') {
        const legacy = await legacyRows(client, session.user.id);
        remote = legacyMap(legacy.get(collection)).get(id);
        if (!remote && conflicts()[key].reason === 'legacy-device-change') {
          remote = { value: deletedValue(), legacy: true };
        }
      }
      if (choice === 'local') {
        const value = localMap(collection).get(id) || deletedValue();
        const result = await writeItem(client, session.user.id, collection, id, value, null, true);
        recordState(collection, id, value, result.timestamp);
      } else if (choice === 'remote') {
        if (!remote) throw new Error('云端记录不存在');
        if (remote.legacy) {
          const result = await writeItem(client, session.user.id, collection, id, remote.value, null, true);
          if (result.conflict) throw new Error('云端记录已变化，请重试');
          applyRemote(collection, id, remote.value);
          recordState(collection, id, remote.value, result.timestamp);
        } else {
          applyRemote(collection, id, remote.value);
          recordState(collection, id, remote.value, remote.updated_at);
        }
      } else return { ok: false, reason: '无效的处理方式' };
      clearConflict(key);
      return { ok: true, applied: choice === 'remote' };
    } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  }

  global.SyncCollections = { isCollection, isCloudKey, onLocalChange, onRemoteChange, sync,
    pendingCount, getPendingConflicts, resolveConflict };
  if (global.__MST_TEST__) global.SyncCollections.__test = { cloudKey, parseCloudKey, localMap };
})(typeof window !== 'undefined' ? window : globalThis);
