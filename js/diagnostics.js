(function initializeDiagnostics(global) {
  'use strict';
  function report(type, value) {
    const payload = {
      type,
      message: String(value && value.message || value || ''),
      stack: String(value && value.stack || ''),
      url: location.href
    };
    if (global.electronAPI && typeof global.electronAPI.reportDiagnostic === 'function') {
      global.electronAPI.reportDiagnostic(payload).catch(() => {});
    } else {
      console.error('[diagnostic]', payload);
    }
  }
  global.addEventListener('error', event => report('error', event.error || event.message));
  global.addEventListener('unhandledrejection', event => report('unhandledrejection', event.reason));
  global.AppDiagnostics = Object.freeze({ report });
  if (global.StudyPlatform) global.StudyPlatform.defineModule('diagnostics', global.AppDiagnostics);
})(window);
