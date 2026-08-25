// Shared, side-effect-free policies for the two cloud-sync channels.
(function registerSyncPolicy(global, factory) {
  'use strict';

  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.SyncPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis, function createSyncPolicy() {
  'use strict';

  function timestampMs(value) {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  function compareTimestamps(left, right) {
    const leftMs = timestampMs(left);
    const rightMs = timestampMs(right);
    if (leftMs === null || rightMs === null) return null;
    if (leftMs === rightMs) return 0;
    return leftMs > rightMs ? 1 : -1;
  }

  // Decide which side is authoritative without performing any I/O.
  // A missing base timestamp means this device has never observed the cloud
  // version, so two non-empty copies must be treated as a conflict.
  function decideMerge({ localEmpty, localDirty, baseTimestamp, remoteExists, remoteHasData, remoteTimestamp }) {
    if (!remoteExists) return localEmpty ? 'noop' : 'upload';
    if (!remoteHasData) return localEmpty ? 'noop' : 'upload';
    if (localEmpty) return 'pull';

    const compared = compareTimestamps(remoteTimestamp, baseTimestamp);
    if (localDirty) {
      if (!baseTimestamp || compared === null || compared > 0) return 'conflict';
      return 'upload';
    }
    if (!baseTimestamp || compared === null) return 'conflict';
    if (compared > 0) return 'pull';
    if (compared < 0) return 'upload';
    return 'noop';
  }

  // Recursive setTimeout avoids overlapping runs and keeps scheduling after
  // every completed run. This is intentionally not setInterval.
  function createRecurringTask(run, delayMs, timers = {}) {
    if (typeof run !== 'function') throw new TypeError('run must be a function');
    const setTimer = timers.setTimeout || setTimeout;
    const clearTimer = timers.clearTimeout || clearTimeout;
    let timer = null;
    let stopped = true;
    let running = null;

    function clearScheduled() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function schedule() {
      clearScheduled();
      if (stopped) return;
      timer = setTimer(() => { void trigger(); }, delayMs);
    }

    async function trigger() {
      if (stopped) return false;
      if (running) return running;
      clearScheduled();
      running = Promise.resolve()
        .then(run)
        .finally(() => {
          running = null;
          schedule();
        });
      try {
        await running;
        return true;
      } catch (e) {
        return false;
      }
    }

    function start(options = {}) {
      stopped = false;
      clearScheduled();
      if (options.immediate) return trigger();
      schedule();
      return Promise.resolve(false);
    }

    function stop() {
      stopped = true;
      clearScheduled();
    }

    return {
      start,
      stop,
      trigger,
      get active() { return !stopped; },
      get running() { return !!running; }
    };
  }

  return { compareTimestamps, createRecurringTask, decideMerge };
});
