'use strict';

const SENSITIVE_STORAGE_KEYS = new Set([
  'study_ai_api_key',
  'study_api_keys',
  'study_web_search_key',
  'study_mail_accounts',
  'study_mail_config',
  'study_inbox_config',
  'study_supabase_config',
  'study_codegen_api_key',
  'study_codebuddy_api_key'
]);

function sanitizeBackupData(data, options = {}) {
  const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  if (options.includeSecrets === true) return { ...source };
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !SENSITIVE_STORAGE_KEYS.has(key))
  );
}

function isSensitiveStorageKey(key) {
  return SENSITIVE_STORAGE_KEYS.has(String(key || ''));
}

module.exports = {
  SENSITIVE_STORAGE_KEYS,
  isSensitiveStorageKey,
  sanitizeBackupData
};
