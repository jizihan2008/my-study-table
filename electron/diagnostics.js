'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const MAX_LOG_BYTES = 1024 * 1024;

function sanitizeDiagnostic(value) {
  return String(value == null ? '' : value)
    .replace(/\b(?:sk|key)-[a-zA-Z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/(authorization|password|passwd|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 12000);
}

function registerDiagnostics({ app, ipcMain, userDataPath }) {
  const logPath = path.join(userDataPath, 'logs', 'diagnostics.log');
  let chain = Promise.resolve();

  async function rotate() {
    try {
      const stat = await fs.stat(logPath);
      if (stat.size <= MAX_LOG_BYTES) return;
      await fs.rename(logPath, logPath + '.1').catch(async () => {
        await fs.rm(logPath + '.1', { force: true });
        await fs.rename(logPath, logPath + '.1');
      });
    } catch {}
  }

  function write(type, details) {
    const row = JSON.stringify({
      at: new Date().toISOString(),
      appVersion: app.getVersion(),
      platform: process.platform,
      type: sanitizeDiagnostic(type),
      details: sanitizeDiagnostic(typeof details === 'string' ? details : JSON.stringify(details || {}))
    }) + '\n';
    chain = chain.then(async () => {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await rotate();
      await fs.appendFile(logPath, row, 'utf8');
    }).catch(() => {});
    return chain;
  }

  ipcMain.handle('diagnostic:renderer', async (_event, payload) => {
    await write('renderer-error', payload);
    return { ok: true };
  });
  ipcMain.handle('diagnostic:path', async () => logPath);
  process.on('uncaughtExceptionMonitor', error => write('uncaught-exception', error && error.stack || error));
  process.on('unhandledRejection', reason => write('unhandled-rejection', reason && reason.stack || reason));

  return { logPath, write };
}

module.exports = { MAX_LOG_BYTES, registerDiagnostics, sanitizeDiagnostic };
