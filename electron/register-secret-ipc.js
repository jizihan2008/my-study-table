'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

const ALLOWED_SECRET_KEYS = new Set([
  'study_ai_api_key',
  'study_api_keys',
  'study_web_search_key',
  'study_mail_accounts',
  'study_mail_config',
  'study_inbox_config',
  'study_codegen_api_key',
  'study_codebuddy_api_key'
]);

function assertAllowedKey(value) {
  const key = String(value || '');
  if (!ALLOWED_SECRET_KEYS.has(key)) throw new Error('不允许访问该凭据键');
  return key;
}

function registerSecretIpc({ ipcMain, safeStorage, userDataPath }) {
  const vaultPath = path.join(userDataPath, 'secure-secrets.json');
  let writeChain = Promise.resolve();

  function encryptionAvailable() {
    try { return !!safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  async function readVault() {
    try {
      const parsed = JSON.parse(await fs.readFile(vaultPath, 'utf8'));
      return parsed && parsed.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} };
    } catch {
      return { version: 1, entries: {} };
    }
  }

  function updateVault(mutator) {
    writeChain = writeChain.catch(() => {}).then(async () => {
      const vault = await readVault();
      const result = await mutator(vault);
      await fs.mkdir(path.dirname(vaultPath), { recursive: true });
      await fs.writeFile(vaultPath, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 });
      return result;
    });
    return writeChain;
  }

  function encrypt(value) {
    if (!encryptionAvailable()) throw new Error('当前系统无法使用安全凭据存储');
    return safeStorage.encryptString(String(value)).toString('base64');
  }

  function decrypt(value) {
    if (!encryptionAvailable()) throw new Error('当前系统无法使用安全凭据存储');
    return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
  }

  ipcMain.handle('secret:status', async () => ({ available: encryptionAvailable() }));

  ipcMain.handle('secret:load-all', async () => {
    if (!encryptionAvailable()) return { ok: false, available: false, values: {} };
    await writeChain.catch(() => {});
    const vault = await readVault();
    const values = {};
    for (const [key, encrypted] of Object.entries(vault.entries)) {
      if (!ALLOWED_SECRET_KEYS.has(key)) continue;
      try { values[key] = decrypt(encrypted); } catch {}
    }
    return { ok: true, available: true, values };
  });

  ipcMain.handle('secret:set', async (_event, { key, value } = {}) => {
    const safeKey = assertAllowedKey(key);
    await updateVault(vault => { vault.entries[safeKey] = encrypt(value == null ? '' : value); });
    return { ok: true };
  });

  ipcMain.handle('secret:delete', async (_event, { key } = {}) => {
    const safeKey = assertAllowedKey(key);
    await updateVault(vault => { delete vault.entries[safeKey]; });
    return { ok: true };
  });

  ipcMain.handle('secret:migrate', async (_event, values = {}) => {
    if (!encryptionAvailable()) return { ok: false, available: false, migrated: [] };
    const migrated = [];
    await updateVault(vault => {
      for (const [key, value] of Object.entries(values || {})) {
        if (!ALLOWED_SECRET_KEYS.has(key) || value == null || value === '') continue;
        if (!vault.entries[key]) vault.entries[key] = encrypt(value);
        migrated.push(key);
      }
    });
    return { ok: true, available: true, migrated };
  });

  return { vaultPath, encryptionAvailable };
}

module.exports = { ALLOWED_SECRET_KEYS, assertAllowedKey, registerSecretIpc };
