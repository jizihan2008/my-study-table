// ═══════════════════════════════════════════════════════════
//  受限插件 API（extAPI）
//  提供给 plugin / patch 扩展的唯一入口。运行在渲染进程，
//  contextIsolation + nodeIntegration:false 下无法直接访问
//  文件系统，只能通过本白名单接口获得受限能力。
//  数据读写限制：扩展只能访问自己的数据区 study_ext_<id>_*
// ═══════════════════════════════════════════════════════════

(function () {
  // 当前正在执行的扩展上下文（由 ExtManager 在执行前设置）
  window.__extCtx = { id: '', name: '' };

  function ctx() { return window.__extCtx || { id: '', name: '' }; }

  // ── UI 注册接口（委托给 ExtManager）──
  function registerNavItem(config) {
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.addNavItem) {
      return window.ExtManager.addNavItem(ctx().id, config);
    }
    return { ok: false, reason: 'ExtManager 未就绪' };
  }

  function registerSection(config) {
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.addSection) {
      return window.ExtManager.addSection(ctx().id, config);
    }
    return { ok: false, reason: 'ExtManager 未就绪' };
  }

  function addToolbarButton(config) {
    if (typeof window.ExtManager !== 'undefined' && window.ExtManager.addToolbarButton) {
      return window.ExtManager.addToolbarButton(ctx().id, config);
    }
    return { ok: false, reason: 'ExtManager 未就绪' };
  }

  // ── 事件订阅 / 触发 ──
  function on(event, handler) {
    if (typeof window.ExtBus !== 'undefined' && window.ExtBus.on) {
      return window.ExtBus.on(ctx().id, event, handler);
    }
    return { ok: false, reason: 'ExtBus 未就绪' };
  }

  function emit(event, data) {
    if (typeof window.ExtBus !== 'undefined' && window.ExtBus.emit) {
      return window.ExtBus.emit(event, data);
    }
    return { ok: false, reason: 'ExtBus 未就绪' };
  }

  // ── 受限数据访问：仅允许本扩展自己的命名空间 ──
  function _extDataKey(key) {
    return 'study_ext_' + ctx().id + '_' + key;
  }

  function getData(key) {
    try {
      return JSON.parse(localStorage.getItem(_extDataKey(key)));
    } catch (e) { return null; }
  }

  function setData(key, value) {
    try {
      localStorage.setItem(_extDataKey(key), JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  function removeData(key) {
    try {
      localStorage.removeItem(_extDataKey(key));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  // ── 系统通知 ──
  function notify(title, body) {
    try {
      if (typeof window.electronAPI !== 'undefined' && window.electronAPI.showNotification) {
        window.electronAPI.showNotification(String(title), String(body || ''))
          .catch(err => console.warn('[extAPI] 通知失败:', err));
      } else if (typeof Notification !== 'undefined' && typeof Notification === 'function') {
        new Notification(String(title), { body: String(body || '') });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  // ── 日志（带扩展前缀）──
  function log() {
    const args = Array.from(arguments);
    console.log('[ext:' + ctx().id + ']', ...args);
  }
  function warn() {
    const args = Array.from(arguments);
    console.warn('[ext:' + ctx().id + ']', ...args);
  }
  function error() {
    const args = Array.from(arguments);
    console.error('[ext:' + ctx().id + ']', ...args);
  }

  // ── 白名单调用核心函数（patch 专用）──
  // 允许扩展调用一些核心全局函数。仅用于读取，避免越权修改。
  function callCore(fnName) {
    const allowedRead = ['loadData', 'getSettings', 'getEffectiveApiConfig', 'loadApiKeys'];
    if (!allowedRead.includes(fnName)) return { ok: false, reason: '不允许调用 ' + fnName };
    if (typeof window[fnName] !== 'function') return { ok: false, reason: '函数不存在: ' + fnName };
    try {
      const args = Array.prototype.slice.call(arguments, 1);
      return { ok: true, result: window[fnName].apply(window, args) };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  // ── 打开外部链接 ──
  function openExternal(url) {
    try {
      if (typeof window.electronAPI !== 'undefined' && window.electronAPI.openExternal) {
        window.electronAPI.openExternal(String(url)).catch(() => {});
      } else {
        window.open(String(url), '_blank');
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    }
  }

  window.extAPI = {
    _extId: function () { return ctx().id; },
    registerNavItem,
    registerSection,
    addToolbarButton,
    on,
    emit,
    getData,
    setData,
    removeData,
    notify,
    log,
    warn,
    error,
    callCore,
    openExternal
  };

  // 暴露事件总线（供核心模块 emit 应用事件）
  if (!window.ExtBus) {
    window.ExtBus = {
      _handlers: {}, // event -> [{ extId, handler }]
      on: function (extId, event, handler) {
        if (typeof handler !== 'function') return { ok: false, reason: 'handler 必须是函数' };
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push({ extId: String(extId), handler });
        return { ok: true };
      },
      off: function (extId, event) {
        if (!this._handlers[event]) return;
        this._handlers[event] = this._handlers[event].filter(h => h.extId !== String(extId));
      },
      emit: function (event, data) {
        const list = this._handlers[event] || [];
        list.forEach(h => {
          try { h.handler(data || {}); } catch (e) {
            console.error('[ExtBus] 事件处理器出错', event, e);
          }
        });
        // 事件生命周期钩子：卸载扩展时清理
        return { ok: true, listeners: list.length };
      },
      _listenersOf: function (extId) {
        const result = [];
        Object.keys(this._handlers).forEach(ev => {
          this._handlers[ev].forEach(h => {
            if (h.extId === String(extId)) result.push(ev);
          });
        });
        return result;
      }
    };
  }
})();
