// Account preferences. Device state and credentials are deliberately absent.
(function (global) {
  'use strict';
  const API_KEY = 'study_api_key_settings_v1';
  const labels = {
    study_max_focus_count: '聚焦任务数量', study_todo_statuses: '待办状态',
    study_review_mode: '笔记复习模式', study_review_custom_intervals: '自定义复习间隔',
    study_auto_summary: '笔记自动摘要', study_morning_cfg: '晨间日报设置',
    study_evening_report_cfg: '晚间日报设置', study_auto_title_enabled: '自动生成对话标题',
    study_memory_dedup_mode: 'AI 记忆整理方式', study_memory_dedup_threshold: 'AI 记忆整理阈值',
    study_books_kb_truncate: '教材正文截断阈值', study_bk_explain_ctx_rounds: '教材上下文轮数',
    study_reminder_checkin_time: '打卡提醒时间', study_reminder_focus_after_min: '聚焦提醒间隔',
    study_reminder_idle_after_min: '空闲提醒间隔', study_reminder_idle_exempt_ranges: '提醒免打扰时段',
    study_reminder_idle_exempt_enabled: '提醒免打扰开关', study_reminder_idle_max_count: '空闲提醒次数',
    study_reminder_idle_unlimited: '空闲提醒次数限制', study_web_search_engine: '网络搜索引擎',
    study_ai_library_pdf_max_mib: '文件库 PDF 读取限制', study_ai_image_upload: '图片附件上传方式',
    study_active_api_key_id: '当前 AI Key', study_dayreport_key_id: '日报 AI Key',
    study_summary_ai_key_id: '笔记摘要 AI Key', study_auto_title_ai_key_id: '对话标题 AI Key',
    [API_KEY]: 'API Key 配置（不含密钥）'
  };
  const jsonKeys = new Set(['study_todo_statuses', 'study_morning_cfg', 'study_evening_report_cfg', 'study_reminder_idle_exempt_ranges', API_KEY]);
  const fields = ['id', 'name', 'baseUrl', 'model', 'temperature', 'deepThink', 'maxTokens', 'contextLimit', 'contextBudget', 'titleContextCount', 'createdAt'];
  function apiSettings(keys) {
    if (!Array.isArray(keys)) throw new Error('API Key 配置格式无效');
    const ids = new Set();
    return keys.map(key => {
      if (!key || typeof key.id !== 'string' || !key.id || ids.has(key.id)) throw new Error('API Key 标识无效');
      ids.add(key.id);
      const item = {};
      for (const field of fields) {
        const value = key[field];
        if (value !== undefined && value !== null && ['string', 'number', 'boolean'].includes(typeof value)) item[field] = value;
      }
      return item;
    });
  }
  function isKey(key) { return Object.prototype.hasOwnProperty.call(labels, key); }
  function decode(key, raw) {
    if (raw === null) return null;
    const value = jsonKeys.has(key) ? JSON.parse(raw) : raw;
    return key === API_KEY ? apiSettings(value) : value;
  }
  function setItem(key, value) {
    const before = localStorage.getItem(key), raw = String(value);
    localStorage.setItem(key, raw);
    if (before !== raw && isKey(key) && global.Sync) {
      try { global.Sync.onLocalChange(key); }
      catch (_) { console.warn('[settings-sync] 本地设置已保存，同步变更登记失败'); }
    }
  }
  function publishApiKeys(keys) {
    setItem(API_KEY, JSON.stringify(apiSettings(keys)));
  }
  async function apply(key, value) {
    let previousKeys;
    if (key === API_KEY) {
      const settings = apiSettings(value || []);
      previousKeys = global.loadApiKeys();
      // Only local secrets with the same stable id may be reused. Never accept a remote key field.
      const secrets = new Map(previousKeys.map(item => [item.id, item.key || '']));
      const result = await global.saveApiKeys(settings.map(item => ({ ...item, key: secrets.get(item.id) || '' })), { sync: false });
      if (!result || !result.ok) throw new Error('API Key 配置未保存');
      value = settings;
    } else if (value !== null && !jsonKeys.has(key) && typeof value !== 'string') {
      throw new Error('设置值格式无效');
    }
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, jsonKeys.has(key) ? JSON.stringify(value) : value);
      if (global.StudyData && global.StudyData.isManaged(key)) await global.StudyData.flush([key]);
    } catch (error) {
      if (previousKeys) await global.saveApiKeys(previousKeys, { sync: false });
      throw error;
    }
    return true;
  }
  function initialize() {
    // Backfill existing configuration before the first pull. No credential enters this mirror.
    if (typeof global.loadApiKeys === 'function') {
      const keys = global.loadApiKeys();
      if (keys.length || localStorage.getItem(API_KEY) !== null) publishApiKeys(keys);
    }
  }
  global.SettingsSync = { API_KEY, keys: Object.keys(labels), labels, isKey, decode, apply, setItem, publishApiKeys, apiSettings, initialize };
  global.setSyncedSetting = setItem;
})(window);
