// Opaque-origin runtime for third-party extensions. Plugin code never executes in the app window.
(function createExtensionSandbox(global) {
  'use strict';

  const runtimes = new Map();
  const DEFAULT_PERMISSIONS = ['ui', 'storage', 'events', 'log'];
  const SOURCE = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'">
<script>
(() => {
  'use strict';
  let token = '', extId = '', permissions = new Set(), data = {}, callbacks = new Map(), seq = 0;
  const send = (type, payload) => parent.postMessage({ mstExtensionSandbox: true, token, type, payload }, '*');
  const callback = fn => { if (typeof fn !== 'function') return null; const id = 'cb_' + (++seq); callbacks.set(id, fn); return id; };
  const allowed = name => permissions.has(name);
  addEventListener('message', async event => {
    const msg = event.data || {};
    if (!msg.mstExtensionHost || (token && msg.token !== token)) return;
    if (msg.type === 'init') {
      token = msg.token; extId = msg.id; permissions = new Set(msg.permissions || []); data = msg.data || {};
      const api = Object.freeze({
        _extId: () => extId,
        registerNavItem(config) { if (!allowed('ui')) return {ok:false,reason:'缺少 ui 权限'}; send('command',{name:'ui.nav',config:{id:config.id,icon:config.icon,label:config.label}}); return {ok:true}; },
        registerSection(config) { if (!allowed('ui')) return {ok:false,reason:'缺少 ui 权限'}; send('command',{name:'ui.section',config:{id:config.id,html:config.html,renderCallbackId:callback(config.render)}}); return {ok:true}; },
        addToolbarButton(config) { if (!allowed('ui')) return {ok:false,reason:'缺少 ui 权限'}; send('command',{name:'ui.toolbar',config:{label:config.label,icon:config.icon,callbackId:callback(config.onclick)}}); return {ok:true}; },
        on(name, handler) { if (!allowed('events')) return {ok:false,reason:'缺少 events 权限'}; const callbackId=callback(handler); send('command',{name:'events.on',event:String(name),callbackId}); return {ok:true}; },
        emit(name, value) { if (!allowed('events')) return {ok:false,reason:'缺少 events 权限'}; send('command',{name:'events.emit',event:String(name),value}); return {ok:true}; },
        getData(key) { return allowed('storage') ? (data[String(key)] ?? null) : null; },
        setData(key, value) { if (!allowed('storage')) return {ok:false,reason:'缺少 storage 权限'}; data[String(key)] = value; send('command',{name:'storage.set',key:String(key),value}); return {ok:true}; },
        removeData(key) { if (!allowed('storage')) return {ok:false,reason:'缺少 storage 权限'}; delete data[String(key)]; send('command',{name:'storage.remove',key:String(key)}); return {ok:true}; },
        notify(title, body) { if (!allowed('notifications')) return {ok:false,reason:'缺少 notifications 权限'}; send('command',{name:'notify',title:String(title),body:String(body||'')}); return {ok:true}; },
        openExternal(url) { if (!allowed('external')) return {ok:false,reason:'缺少 external 权限'}; send('command',{name:'external',url:String(url)}); return {ok:true}; },
        callCore() { return {ok:false,reason:'沙箱插件不能直接调用核心函数'}; },
        log(...args) { if (allowed('log')) send('command',{name:'log',level:'log',args}); },
        warn(...args) { if (allowed('log')) send('command',{name:'log',level:'warn',args}); },
        error(...args) { if (allowed('log')) send('command',{name:'log',level:'error',args}); }
      });
      try {
        const run = new Function('extAPI', '"use strict";\\n' + msg.code + '\\n;return true;');
        run(api);
        const hook = self[extId + '_mount'];
        if (typeof hook === 'function') await hook();
        send('ready', {});
      } catch (error) { send('error', {message:String(error && error.stack || error)}); }
    } else if (msg.type === 'callback') {
      const fn = callbacks.get(msg.callbackId);
      if (fn) { try { await fn(msg.value); } catch (error) { send('error',{message:String(error && error.stack || error)}); } }
    }
  });
  parent.postMessage({ mstExtensionSandbox: true, type: 'boot' }, '*');
})();
</script>`;

  function permissionsOf(manifest) {
    const requested = Array.isArray(manifest && manifest.permissions) ? manifest.permissions : DEFAULT_PERMISSIONS;
    const known = new Set(['ui', 'storage', 'events', 'log', 'notifications', 'external']);
    return requested.map(String).filter(value => known.has(value));
  }

  function extensionData(id) {
    const prefix = 'study_ext_' + id + '_';
    const data = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      try { data[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key)); } catch {}
    }
    return data;
  }

  function invoke(id, callbackId, value) {
    const runtime = runtimes.get(id);
    if (!runtime || !callbackId) return;
    runtime.frame.contentWindow.postMessage({ mstExtensionHost: true, token: runtime.token, type: 'callback', callbackId, value }, '*');
  }

  function handleCommand(runtime, payload) {
    const name = payload && payload.name;
    const api = global.extAPI.forExtension(runtime.id);
    if (name === 'ui.nav') return api.registerNavItem(payload.config || {});
    if (name === 'ui.section') {
      const config = payload.config || {};
      return api.registerSection({
        id: config.id,
        html: config.html,
        render: config.renderCallbackId ? () => invoke(runtime.id, config.renderCallbackId) : null
      });
    }
    if (name === 'ui.toolbar') {
      const config = payload.config || {};
      return api.addToolbarButton({
        label: config.label,
        icon: config.icon,
        onclick: config.callbackId ? () => invoke(runtime.id, config.callbackId) : null
      });
    }
    if (name === 'events.on') return api.on(payload.event, value => invoke(runtime.id, payload.callbackId, value));
    if (name === 'events.emit') return api.emit(payload.event, payload.value);
    if (name === 'storage.set') return api.setData(payload.key, payload.value);
    if (name === 'storage.remove') return api.removeData(payload.key);
    if (name === 'notify') return api.notify(payload.title, payload.body);
    if (name === 'external') return api.openExternal(payload.url);
    if (name === 'log') {
      const method = ['warn', 'error'].includes(payload.level) ? payload.level : 'log';
      console[method]('[sandbox:' + runtime.id + ']', ...(Array.isArray(payload.args) ? payload.args : []));
    }
  }

  function mount(id, code, manifest) {
    unmount(id);
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      const token = crypto.getRandomValues(new Uint32Array(4)).join('-');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      frame.srcdoc = SOURCE;
      const runtime = { id, frame, token, listener: null, timer: null };
      runtime.listener = event => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data || {};
        if (!message.mstExtensionSandbox) return;
        if (message.type === 'boot') {
          frame.contentWindow.postMessage({
            mstExtensionHost: true,
            type: 'init',
            token,
            id,
            code: String(code || ''),
            permissions: permissionsOf(manifest),
            data: extensionData(id)
          }, '*');
        } else if (message.token === token && message.type === 'command') {
          try { handleCommand(runtime, message.payload || {}); } catch (error) { console.error('[ExtSandbox] command failed:', error); }
        } else if (message.token === token && message.type === 'ready') {
          clearTimeout(runtime.timer);
          resolve({ ok: true, sandboxed: true, permissions: permissionsOf(manifest) });
        } else if (message.token === token && message.type === 'error') {
          console.error('[ExtSandbox:' + id + ']', message.payload && message.payload.message);
          if (!runtime.ready) reject(new Error(message.payload && message.payload.message || '插件沙箱执行失败'));
        }
      };
      global.addEventListener('message', runtime.listener);
      runtime.timer = setTimeout(() => reject(new Error('插件沙箱启动超时')), 5000);
      runtimes.set(id, runtime);
      document.body.appendChild(frame);
    });
  }

  function unmount(id) {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    clearTimeout(runtime.timer);
    global.removeEventListener('message', runtime.listener);
    runtime.frame.remove();
    runtimes.delete(id);
  }

  global.ExtSandbox = Object.freeze({ invoke, mount, permissionsOf, unmount });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('extension-sandbox', global.ExtSandbox);
})(window);
