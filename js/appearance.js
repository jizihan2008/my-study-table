// ═══════════ Appearance System (主题 / 预设 / 玻璃 / 背景) ═══════════
// 从 settings.js 拆分独立模块。统一派生入口 getEffectiveTheme()：
// 输入(cfg + 明暗theme + presets) → 派生(effective) → 渲染/应用。
// 依赖：window.electronAPI、lucide、updateLiquidGlass(liquid-glass.js)。

// ═══════════ Custom Theme & Background System ═══════════

const THEME_PRESETS = {
  default:  { name:'默认',  icon:'circle',     light:{accent:'#4f6ef7'},                    dark:{accent:'#818cf8'} },
  sky:      { name:'天空',  icon:'cloud',       light:{accent:'#3b82f6',bg:'gradient',gAngle:200,gFrom:'#e0f2fe',gTo:'#fdf2f8'}, dark:{accent:'#60a5fa',bg:'gradient',gAngle:200,gFrom:'#1e3a5f',gTo:'#1a1a2e'} },
  forest:   { name:'森林',  icon:'tree-pine',   light:{accent:'#059669',bg:'gradient',gAngle:160,gFrom:'#d1fae5',gTo:'#ecfdf5'}, dark:{accent:'#34d399',bg:'gradient',gAngle:160,gFrom:'#064e3b',gTo:'#0f172a'} },
  sunset:   { name:'日落',  icon:'sunset',      light:{accent:'#f97316',bg:'gradient',gAngle:135,gFrom:'#fef3c7',gTo:'#fce7f3'}, dark:{accent:'#fb923c',bg:'gradient',gAngle:135,gFrom:'#7c2d12',gTo:'#1a1a2e'} },
  lavender: { name:'薰衣草',icon:'flower',      light:{accent:'#8b5cf6',bg:'gradient',gAngle:135,gFrom:'#ede9fe',gTo:'#fae8ff'}, dark:{accent:'#a78bfa',bg:'gradient',gAngle:135,gFrom:'#2e1065',gTo:'#0f172a'} },
  slate:    { name:'墨灰',  icon:'layers',      light:{accent:'#64748b'},                    dark:{accent:'#94a3b8'} },
  glass:    { name:'磨砂玻璃',icon:'sparkles',   light:{accent:'#4f6ef7',glass:true},         dark:{accent:'#818cf8',glass:true} },
};

const ACCENT_PRESETS = ['#4f6ef7','#3b82f6','#059669','#f97316','#8b5cf6','#64748b','#ef4444','#ec4899','#14b8a6','#f59e0b'];

// ── Custom (user-created) presets ──
function getCustomPresets() {
  try {
    const raw = localStorage.getItem('study_custom_presets');
    if (!raw) return {};
    const v = JSON.parse(raw);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}

function saveCustomPresets(data) {
  localStorage.setItem('study_custom_presets', JSON.stringify(data));
}

function getAllPresets() {
  const custom = getCustomPresets();
  // Custom presets override built-in by same id (unlikely), merge custom last
  return { ...THEME_PRESETS, ...custom };
}

function deleteCustomPreset(id) {
  if (THEME_PRESETS[id]) return; // Don't delete built-in presets
  const custom = getCustomPresets();
  delete custom[id];
  saveCustomPresets(custom);
}

function loadCustomTheme() {
  try {
    const raw = localStorage.getItem('study_theme_custom');
    if (!raw) return createDefaultTheme();
    const data = { ...createDefaultTheme(), ...JSON.parse(raw) };
    // Migrate glassRefract → glassCurve / glassDeflect / glassGlow
    if (data.glassRefract !== undefined && data.glassCurve === undefined) {
      data.glassCurve = data.glassRefract;
      data.glassDeflect = 18;
      data.glassGlow = data.glassRefract;
      delete data.glassRefract;
    }
    return data;
  } catch { return createDefaultTheme(); }
}

function createDefaultTheme() {
  return { preset:'default', accent:'#4f6ef7', bgType:'none', bgColor:'#f0f2f5', bgAngle:135, bgFrom:'#667eea', bgTo:'#764ba2', bgImage:'', bgVideo:'', bgOverlay:0.3, bgBlur:0, glass:false, glassBlur:16, glassOpacity:100, glassCurve:60, glassDeflect:18, glassGlow:50 };
}

function saveCustomTheme(data) {
  localStorage.setItem('study_theme_custom', JSON.stringify(data));
}

// ── Effective value resolution ──
// 统一"预设优先、cfg 兜底"取值逻辑，供应用链与渲染面板共用，消除重复三元表达式
// forcedMode 可选：指定解析明暗模式（如保存预设时同时解析 light/dark），默认取当前主题
function getEffectiveTheme(cfg, forcedMode) {
  const mode = forcedMode || (isDarkTheme() ? 'dark' : 'light');
  const preset = getAllPresets()[cfg.preset];
  const presetMode = (preset && preset[mode]) || (preset && preset.light) || null;
  const isPreset = cfg.preset !== 'custom' && !!presetMode;
  const pick = (pkey, cval, fallback) =>
    (isPreset && presetMode[pkey] !== undefined) ? presetMode[pkey] : (cval !== undefined ? cval : fallback);
  return {
    mode, preset, presetMode, isPreset,
    accent: pick('accent', cfg.accent, '#4f6ef7'),
    bgType: pick('bg', cfg.bgType, 'none'),
    glass: (isPreset && presetMode.glass === true) ? true : !!cfg.glass,
    glassFromPreset: isPreset && presetMode.glass === true,
    bgFromPreset: isPreset && presetMode.bg !== undefined,
    glassBlur: pick('glassBlur', cfg.glassBlur, 16),
    glassOpacity: pick('glassOpacity', cfg.glassOpacity, 100),
    glassCurve: pick('glassCurve', cfg.glassCurve, 60),
    glassDeflect: pick('glassDeflect', cfg.glassDeflect, 18),
    glassGlow: pick('glassGlow', cfg.glassGlow, 50),
    bgColor: pick('bgColor', cfg.bgColor, '#f0f2f5'),
    bgAngle: pick('gAngle', cfg.bgAngle, 135),
    bgFrom: pick('gFrom', cfg.bgFrom, '#667eea'),
    bgTo: pick('gTo', cfg.bgTo, '#764ba2'),
    bgImage: pick('bgImage', cfg.bgImage, ''),
    bgVideo: pick('bgVideo', cfg.bgVideo, ''),
    bgOverlay: pick('bgOverlay', cfg.bgOverlay, 0.3),
    bgBlur: pick('bgBlur', cfg.bgBlur, 0)
  };
}

// 关闭玻璃时还原所有插值 CSS 变量与模糊值，避免"半透明但无模糊"的透明残留
function resetGlassVariables() {
  const style = document.documentElement.style;
  const names = new Set();
  for (const defs of [GLASS_VAR_DEFS.light, GLASS_VAR_DEFS.dark]) {
    for (const def of defs) names.add(def.name);
  }
  names.forEach(n => style.removeProperty(n));
  style.removeProperty('--glass-blur');
}

// 构造安全的 CSS url()：转义引号/反斜杠/括号，防止 URL 破坏整条 CSS 规则
function cssUrl(url) {
  if (!url) return 'none';
  const u = String(url).trim();
  if (/^url\(/i.test(u)) return u;
  return `url("${u.replace(/["\\]/g, m => '\\' + m).replace(/\)/g, '%29')}")`;
}

// 仅允许合法 CSS 颜色（十六进制/rgb/hsl/常见关键词），其余一律降级为默认色，防 CSS 注入
function safeCssColor(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\([\d\s,./%]+\)$/i.test(s)) return s;
  if (/^hsla?\([\d\s,./%deg]+\)$/i.test(s)) return s;
  if (/^[a-z]+$/i.test(s)) return s;
  return fallback;
}

// 仅允许安全的背景图 URL（http(s)/相对路径/位图 data:image），其余返回空串
function safeBgImageUrl(v) {
  const s = String(v || '').trim();
  return /^(https?:\/\/|\/|\.\.?\/|data:image\/(png|jpe?g|gif|webp);)/i.test(s) ? s : '';
}

function safeCssAngle(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 135;
}

// ── Helpers ──

function adjustColor(hex, amount) {
  const num = parseInt(hex.replace('#',''), 16);
  const r = Math.min(255, Math.max(0, ((num >> 16) & 0xFF) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xFF) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xFF) + amount));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function isDarkTheme() {
  const html = document.documentElement;
  return html.getAttribute('data-theme') === 'dark';
}

// ── Apply custom theme CSS variables via injected <style> ──

function applyCustomTheme() {
  const cfg = loadCustomTheme();
  const eff = getEffectiveTheme(cfg);

  // Determine effective accent and background from preset or custom
  const accent = eff.accent;
  const hover = adjustColor(accent, isDarkTheme() ? 25 : -25);
  const bgImage = buildBgImageValue(eff);
  const overlay = `rgba(0,0,0,${eff.bgOverlay})`;
  const blur = eff.bgBlur + 'px';

  // Build CSS text
  const css = [
    `:root {`,
    `  --primary: ${accent};`,
    `  --primary-hover: ${hover};`,
    `  --bg-image: ${bgImage};`,
    `  --theme-overlay: ${overlay};`,
    `  --bg-blur: ${blur};`,
    `}`,
    // Override dark-theme specific vars if in dark mode
    isDarkTheme() ? `[data-theme="dark"] { --primary: ${accent}; --primary-hover: ${hover}; }` : '',
  ].filter(Boolean).join('\n');

  // Inject or update
  let el = document.getElementById('theme-custom-css');
  if (!el) {
    el = document.createElement('style');
    el.id = 'theme-custom-css';
    document.head.appendChild(el);
  }
  el.textContent = css;

  // Apply glass effect attribute
  const glass = eff.glass;
  document.documentElement.setAttribute('data-glass', glass ? 'true' : 'false');
  if (glass) {
    // Apply glass blur / opacity (interpolate CSS variable alphas) / refraction sub-controls
    document.documentElement.style.setProperty('--glass-blur', eff.glassBlur + 'px');
    applyGlassOpacity(eff.glassOpacity);
    applyGlassCurve(eff.glassCurve);
    applyGlassDeflect(eff.glassDeflect);
    applyGlassGlow(eff.glassGlow);
  } else {
    // 关闭玻璃：还原所有插值变量与模糊，避免"半透明但无模糊"残留
    resetGlassVariables();
  }

  // Handle video background
  const effectiveBgType = eff.bgType;
  const effectiveBgVideo = eff.bgVideo;
  const videoEl = document.querySelector('.app-bg-video');
  const videoOverlay = document.querySelector('.app-bg-video-overlay');
  const bgLayer = document.querySelector('.app-bg-layer');

  if (effectiveBgType === 'video' && effectiveBgVideo && videoEl) {
    videoEl.src = effectiveBgVideo;
    videoEl.classList.add('active');
    if (videoOverlay) videoOverlay.classList.add('active');
    if (bgLayer) bgLayer.style.display = 'none';
    videoEl.play().catch(() => {}); // autoplay may be blocked, silently ignore
  } else {
    if (videoEl) { videoEl.classList.remove('active'); videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); }
    if (videoOverlay) videoOverlay.classList.remove('active');
    if (bgLayer) bgLayer.style.display = '';
  }
}

// 基于派生后的 eff 构造背景 CSS 值（纯函数：eff → css value）
function buildBgImageValue(eff) {
  // 预设模式且预设定义了背景 → 用预设背景
  if (eff.isPreset && eff.presetMode) {
    const pMode = eff.presetMode;
    if (pMode.bg === 'gradient') {
      return `linear-gradient(${safeCssAngle(pMode.gAngle)}deg, ${safeCssColor(pMode.gFrom, '#667eea')}, ${safeCssColor(pMode.gTo, '#764ba2')})`;
    }
    if (pMode.bg === 'image' && pMode.bgImage) {
      const img = safeBgImageUrl(pMode.bgImage);
      return img ? cssUrl(img) : 'none';
    }
  }
  // Use custom background
  switch (eff.bgType) {
    case 'color': return 'none'; // use --bg via background-color
    case 'gradient': return `linear-gradient(${safeCssAngle(eff.bgAngle)}deg, ${safeCssColor(eff.bgFrom, '#667eea')}, ${safeCssColor(eff.bgTo, '#764ba2')})`;
    case 'image': {
      const img = safeBgImageUrl(eff.bgImage);
      return img ? cssUrl(img) : 'none';
    }
    case 'video': return 'none'; // handled by <video> element in applyCustomTheme
    default: return 'none';
  }
}

// ── Glass opacity interpolation ──
// For each glass CSS variable, linearly interpolate alpha between opaque and glass values.
const GLASS_VAR_DEFS = {
  light: [
    { name:'--card',               o: [255,255,255,0.95], g: [255,255,255,0.15] },
    { name:'--sidebar-bg',         o: [255,255,255,0.98], g: [255,255,255,0.18] },
    { name:'--todo-bg',            o: [255,255,255,0.95], g: [255,255,255,0.1] },
    { name:'--todo-hover-bg',      o: [255,255,255,0.95], g: [255,255,255,0.18] },
    { name:'--input-bg',           o: [255,255,255,0.92], g: [255,255,255,0.08] },
    { name:'--hover-bg',           o: [255,255,255,0.9],  g: [255,255,255,0.12] },
    { name:'--search-bg',          o: [255,255,255,0.93], g: [255,255,255,0.1] },
    { name:'--note-item-bg',       o: [255,255,255,0.93], g: [255,255,255,0.14] },
    { name:'--note-item-active-bg',o: [79,110,247,0.08],  g: [79,110,247,0.1] },
    { name:'--modal-bg',           o: [255,255,255,0.95], g: [255,255,255,0.35] },
    { name:'--cat-section-bg',     o: [255,255,255,0.9],  g: [255,255,255,0.08] },
    { name:'--cat-header-bg',      o: [255,255,255,0.93], g: [255,255,255,0.15] },
    { name:'--sub-input-bg',       o: [255,255,255,0.92], g: [255,255,255,0.1] },
    { name:'--badge-bg',           o: [255,255,255,0.93], g: [255,255,255,0.14] },
    { name:'--progress-bg',        o: [255,255,255,0.9],  g: [255,255,255,0.1] },
    { name:'--path-bg',            o: [255,255,255,0.9],  g: [255,255,255,0.1] },
    { name:'--note-list-bg',       o: [255,255,255,0.9],  g: [255,255,255,0.08] },
    { name:'--modal-overlay',      o: [0,0,0,0.1],        g: [0,0,0,0.2] },
  ],
  dark: [
    { name:'--card',               o: [15,23,42,0.95],    g: [15,23,42,0.15] },
    { name:'--sidebar-bg',         o: [15,23,42,0.98],    g: [15,23,42,0.2] },
    { name:'--todo-bg',            o: [15,23,42,0.95],    g: [15,23,42,0.1] },
    { name:'--todo-hover-bg',      o: [30,41,59,0.95],    g: [30,41,59,0.18] },
    { name:'--input-bg',           o: [15,23,42,0.92],    g: [15,23,42,0.08] },
    { name:'--hover-bg',           o: [30,41,59,0.92],    g: [30,41,59,0.12] },
    { name:'--search-bg',          o: [15,23,42,0.93],    g: [15,23,42,0.1] },
    { name:'--note-item-bg',       o: [15,23,42,0.93],    g: [15,23,42,0.14] },
    { name:'--note-item-active-bg',o: [129,140,248,0.1],  g: [129,140,248,0.12] },
    { name:'--modal-bg',           o: [15,23,42,0.95],    g: [15,23,42,0.35] },
    { name:'--cat-section-bg',     o: [15,23,42,0.9],     g: [15,23,42,0.08] },
    { name:'--cat-header-bg',      o: [15,23,42,0.93],    g: [15,23,42,0.15] },
    { name:'--sub-input-bg',       o: [15,23,42,0.92],    g: [15,23,42,0.1] },
    { name:'--badge-bg',           o: [30,41,59,0.93],    g: [30,41,59,0.14] },
    { name:'--progress-bg',        o: [30,41,59,0.92],    g: [30,41,59,0.12] },
    { name:'--path-bg',            o: [15,23,42,0.9],     g: [15,23,42,0.1] },
    { name:'--note-list-bg',       o: [15,23,42,0.9],     g: [15,23,42,0.08] },
    { name:'--modal-overlay',      o: [0,0,0,0.15],       g: [0,0,0,0.3] },
  ]
};

function applyGlassOpacity(opacityPercent) {
  // 0% = 不透明实色, 100% = 最透明玻璃
  const t = Math.max(0, Math.min(100, opacityPercent)) / 100; // 0..1
  const mode = isDarkTheme() ? 'dark' : 'light';
  const defs = GLASS_VAR_DEFS[mode];
  const style = document.documentElement.style;
  for (const def of defs) {
    const alpha = def.o[3] - (def.o[3] - def.g[3]) * t;
    style.setProperty(def.name, `rgba(${def.o[0]},${def.o[1]},${def.o[2]},${alpha.toFixed(3)})`);
  }
}

// ── Glass refraction sub-controls ──
// 弯曲程度: SVG displacement scale (0~60px max displacement at edges)
function applyGlassCurve(percent) {
  const t = Math.max(0, Math.min(100, percent));
  if (typeof updateLiquidGlass === 'function') {
    updateLiquidGlass(Math.round(t * 0.6), undefined);
  }
}

// 偏折程度: edge zone width (0%~40%), how far inward the bending extends
function applyGlassDeflect(percent) {
  const t = Math.max(0, Math.min(100, percent));
  const edgeRatio = (t / 100) * 0.4; // 0 ~ 0.4
  if (typeof updateLiquidGlass === 'function') {
    updateLiquidGlass(undefined, edgeRatio);
  }
}

// 顶层辉光: specular highlight intensity (0~100%)
function applyGlassGlow(percent) {
  const t = Math.max(0, Math.min(100, percent));
  document.documentElement.style.setProperty('--glass-glow', (t / 100).toFixed(2));
}

function applyPreset(presetId) {
  const allPresets = getAllPresets();
  const preset = allPresets[presetId];
  if (!preset) return;
  const cfg = loadCustomTheme();
  cfg.preset = presetId;
  cfg.bgType = 'none';
  // Sync glass flag — use preset value, default to false
  const currentMode = isDarkTheme() ? 'dark' : 'light';
  const presetModeData = preset[currentMode] || preset.light || {};
  cfg.glass = presetModeData.glass === true;
  cfg.glassBlur = presetModeData.glassBlur !== undefined ? presetModeData.glassBlur : 16;
  cfg.glassOpacity = presetModeData.glassOpacity !== undefined ? presetModeData.glassOpacity : 100;
  cfg.glassCurve = presetModeData.glassCurve !== undefined ? presetModeData.glassCurve : 60;
  cfg.glassDeflect = presetModeData.glassDeflect !== undefined ? presetModeData.glassDeflect : 18;
  cfg.glassGlow = presetModeData.glassGlow !== undefined ? presetModeData.glassGlow : 50;
  saveCustomTheme(cfg);
  applyCustomTheme();
}

// ── Switch from preset to custom mode (sync all effective preset values into cfg) ──
function switchToCustomMode(cfg) {
  if (cfg.preset === 'custom') return cfg;
  const allPresets = getAllPresets();
  const preset = allPresets[cfg.preset];
  const mode = isDarkTheme() ? 'dark' : 'light';
  const base = (preset && preset[mode]) ? preset[mode] : (preset && preset.light ? preset.light : null);
  if (!base) { cfg.preset = 'custom'; return cfg; }
  // Copy all effective preset values into cfg so custom mode starts from the preset
  cfg.accent = base.accent || cfg.accent;
  cfg.bgType = base.bg || cfg.bgType;
  cfg.bgAngle = base.gAngle !== undefined ? base.gAngle : cfg.bgAngle;
  cfg.bgFrom = base.gFrom || cfg.bgFrom;
  cfg.bgTo = base.gTo || cfg.bgTo;
  cfg.bgImage = base.bgImage || cfg.bgImage;
  cfg.bgVideo = base.bgVideo || cfg.bgVideo;
  cfg.glass = base.glass === true;
  cfg.glassBlur = base.glassBlur !== undefined ? base.glassBlur : (cfg.glassBlur ?? 16);
  cfg.glassOpacity = base.glassOpacity !== undefined ? base.glassOpacity : (cfg.glassOpacity ?? 100);
  cfg.glassCurve = base.glassCurve !== undefined ? base.glassCurve : (cfg.glassCurve ?? 60);
  cfg.glassDeflect = base.glassDeflect !== undefined ? base.glassDeflect : (cfg.glassDeflect ?? 18);
  cfg.glassGlow = base.glassGlow !== undefined ? base.glassGlow : (cfg.glassGlow ?? 50);
  cfg.preset = 'custom';
  return cfg;
}

// ── 页面缩放（手机端为主，全端可用） ──
const UI_ZOOM_KEY = 'study_ui_zoom';
function getUiZoom() {
  try { const v = parseFloat(localStorage.getItem(UI_ZOOM_KEY)); if (v >= 0.7 && v <= 1.5) return v; } catch (e) {}
  return 1;
}
function setUiZoom(v) {
  v = Math.min(1.5, Math.max(0.7, Math.round(v * 100) / 100));
  localStorage.setItem(UI_ZOOM_KEY, String(v));
  applyUiZoom();
}
function applyUiZoom(el) {
  const zoom = String(getUiZoom());
  if (el) {
    // 对单个动态元素应用缩放（如计时器浮窗）
    if (el && el.style) el.style.zoom = zoom;
    return;
  }
  // 对所有需跟随缩放的容器应用（含 .app 之外的固定浮层）
  const app = document.querySelector('.app');
  if (app) app.style.zoom = zoom;
  const float = document.getElementById('timerFloat');
  if (float) float.style.zoom = zoom;
  const more = document.getElementById('mobileMorePanel');
  if (more) more.style.zoom = zoom;
}

// ── Render Appearance Panel ──

function renderAppearancePanel() {
  const container = document.getElementById('appearancePanelContent');
  if (!container) return;

  const cfg = loadCustomTheme();
  const mode = isDarkTheme() ? 'dark' : 'light';

  // 页面缩放设置（手机端调节界面大小）
  const zoomVal = Math.round(getUiZoom() * 100);
  const zoomBlock = `
    <div class="theme-card" style="margin-bottom:14px;">
      <div style="font-weight:600;font-size:14px;margin-bottom:8px;">🔍 页面缩放</div>
      <div style="display:flex;align-items:center;gap:12px;">
        <span style="font-size:12px;color:var(--text-secondary);width:52px;flex-shrink:0;">${zoomVal}%</span>
        <input type="range" min="70" max="150" step="5" value="${zoomVal}"
               style="flex:1;" oninput="setUiZoom(this.value/100);this.previousElementSibling.textContent=this.value+'%'">
      </div>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:6px;">调整整个应用界面大小（70% ~ 150%），手机端可放大缩小。</div>
    </div>`;

  // Resolve preset mode data once for reuse
  const allPresets = getAllPresets();
  const preset = allPresets[cfg.preset];
  const presetMode = preset && preset[mode] ? preset[mode] : null;
  const isCustomPreset = cfg.preset !== 'default' && !THEME_PRESETS[cfg.preset];
  const customPresets = getCustomPresets();

  // Build preset cards HTML — built-in first, then custom
  const builtInEntries = Object.entries(THEME_PRESETS);
  const customEntries = Object.entries(customPresets);
  const allEntries = [...builtInEntries, ...customEntries];

  const presetCards = allEntries.map(([id, p]) => {
    const active = cfg.preset === id ? ' active' : '';
    const isCustom = !!customPresets[id];
    const pm = p[mode] || p.light || {};
    const idAttr = escapeAttr(String(id));
    const nameHtml = escapeHtml(p.name || id);
    let previewStyle = '';
    if (pm.bg === 'gradient') {
      const a = safeCssAngle(pm.gAngle);
      const f = safeCssColor(pm.gFrom, '#667eea');
      const t = safeCssColor(pm.gTo, '#764ba2');
      previewStyle = `background:linear-gradient(${a}deg,${f},${t})`;
    } else if (pm.bg === 'image' && pm.bgImage) {
      const bgUrl = safeBgImageUrl(pm.bgImage);
      previewStyle = bgUrl ? `background-image:url(${bgUrl});background-size:cover` : 'background:#667eea';
    } else if (pm.bg === 'video') {
      previewStyle = `background:#1a1a2e`; // dark with ▶ overlay via CSS
    } else {
      previewStyle = `background:${safeCssColor(pm.accent, p.light?.accent || '#4f6ef7')}`;
    }
    return `<div class="theme-preset-card${active}" data-preset="${idAttr}" title="${escapeAttr(p.name || id)}">
      <div class="tpc-preview" style="${previewStyle}"></div>
      <div class="tpc-name">${nameHtml}</div>
      ${isCustom ? '<span class="tpc-delete" data-delete-preset="' + idAttr + '" title="删除预设">✕</span>' : ''}
    </div>`;
  }).join('');

  // Effective values — 统一从 getEffectiveTheme 解析（预设优先、cfg 兜底），消除重复三元
  const eff = getEffectiveTheme(cfg);
  const effectiveAccent = eff.accent;
  const effectiveBgType = eff.bgType;
  const isPresetBg = eff.bgFromPreset;
  const effectiveGlass = eff.glass;
  const isPresetGlass = eff.glassFromPreset;
  const effectiveGlassBlur = eff.glassBlur;
  const effectiveGlassOpacity = eff.glassOpacity;
  const effectiveGlassCurve = eff.glassCurve;
  const effectiveGlassDeflect = eff.glassDeflect;
  const effectiveGlassGlow = eff.glassGlow;
  const effectiveBgColor = eff.bgColor;
  const effectiveBgAngle = eff.bgAngle;
  const effectiveBgFrom = eff.bgFrom;
  const effectiveBgTo = eff.bgTo;
  const effectiveBgImage = eff.bgImage;
  const effectiveBgVideo = eff.bgVideo;
  const effectiveBgOverlay = eff.bgOverlay;
  const effectiveBgBlur = eff.bgBlur;

  // Accent swatches
  const swatches = ACCENT_PRESETS.map(c => {
    const active = c === effectiveAccent ? ' active' : '';
    return `<button class="accent-swatch${active}" style="background:${c}" data-accent="${c}" title="${c}"></button>`;
  }).join('');

  // Background type
  const bgTypes = [
    { id:'none', label:'无' },
    { id:'color', label:'纯色' },
    { id:'gradient', label:'渐变' },
    { id:'image', label:'图片' },
    { id:'video', label:'视频' },
  ];
  const bgTabs = bgTypes.map(t => {
    const active = effectiveBgType === t.id ? ' active' : '';
    return `<button class="bg-type-tab${active}" data-bgtype="${t.id}">${t.label}</button>`;
  }).join('');

  // Build bg edit controls — always show editable, using effective values
  let bgExtra = '';
  if (effectiveBgType === 'color') {
    bgExtra = `<div class="bg-gradient-row">
      <label>颜色</label>
      <input type="color" id="bgColorPicker" value="${effectiveBgColor}" style="width:48px;height:28px">
    </div>`;
  } else if (effectiveBgType === 'gradient') {
    bgExtra = `
      <div class="bg-gradient-row">
        <label>角度</label>
        <input type="range" id="bgAngleSlider" min="0" max="360" value="${effectiveBgAngle}">
        <span class="slider-val" id="bgAngleVal">${effectiveBgAngle}°</span>
      </div>
      <div class="bg-gradient-row">
        <label>起点</label>
        <input type="color" id="bgFromPicker" value="${effectiveBgFrom}">
        <label>终点</label>
        <input type="color" id="bgToPicker" value="${effectiveBgTo}">
      </div>`;
  } else if (effectiveBgType === 'image') {
    bgExtra = `<div class="bg-image-url-row">
      <input type="text" id="bgImageUrl" value="${escapeAttr(effectiveBgImage || '')}" placeholder="输入图片 URL 或 Data URL">
      <button id="bgImageApply">应用</button>
    </div>
    <div class="bg-image-local-row">
      <button id="bgImagePickLocal" style="padding:5px 14px;border:1px dashed var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:12px;cursor:pointer;">
        <i data-lucide="folder-open" class="lucide-icon" style="width:13px;height:13px;vertical-align:middle;margin-right:4px"></i>打开本地文件
      </button>
    </div>`;
  } else if (effectiveBgType === 'video') {
    bgExtra = `<div class="bg-image-url-row">
      <input type="text" id="bgVideoUrl" value="${escapeAttr(effectiveBgVideo || '')}" placeholder="输入视频 URL 或文件路径">
      <button id="bgVideoApply">应用</button>
    </div>
    <div class="bg-image-local-row">
      <button id="bgVideoPickLocal" style="padding:5px 14px;border:1px dashed var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:12px;cursor:pointer;">
        <i data-lucide="video" class="lucide-icon" style="width:13px;height:13px;vertical-align:middle;margin-right:4px"></i>打开本地文件
      </button>
    </div>`;
  }

  // Overlay & blur sliders (when bg is active, whether preset or custom)
  const showSliders = effectiveBgType !== 'none';
  const sliderSection = !showSliders ? '' : `
    <div class="settings-section">
      <h3><i data-lucide="contrast" class="lucide-icon" style="width:14px;height:14px"></i> 覆盖与模糊</h3>
      <div class="appearance-slider">
        <label>覆盖</label>
        <input type="range" id="bgOverlaySlider" min="0" max="1" step="0.05" value="${effectiveBgOverlay}">
        <span class="slider-val" id="bgOverlayVal">${Math.round(effectiveBgOverlay * 100)}%</span>
      </div>
      <div class="appearance-slider">
        <label>模糊</label>
        <input type="range" id="bgBlurSlider" min="0" max="20" step="1" value="${effectiveBgBlur}">
        <span class="slider-val" id="bgBlurVal">${effectiveBgBlur}px</span>
      </div>
    </div>`;

  container.innerHTML = `
    ${zoomBlock}
    <div class="settings-section">
      <h3><i data-lucide="shapes" class="lucide-icon" style="width:14px;height:14px"></i> 主题预设</h3>
      <div class="theme-presets">${presetCards}</div>
      <button id="saveAsPresetBtn" style="margin-top:10px;padding:5px 14px;border:1px dashed var(--border);border-radius:6px;background:transparent;color:var(--text-secondary);font-size:12px;cursor:pointer;width:100%;">
        <i data-lucide="plus" class="lucide-icon" style="width:13px;height:13px;vertical-align:middle;margin-right:4px"></i>保存为预设
      </button>
    </div>

    <div class="settings-section">
      <h3><i data-lucide="pipette" class="lucide-icon" style="width:14px;height:14px"></i> 强调色</h3>
      <div class="accent-swatches">
        ${swatches}
        <input type="color" class="accent-custom-input" id="accentCustomPicker" value="${effectiveAccent}" title="自定义颜色">
      </div>
    </div>

    <div class="settings-section">
      <h3><i data-lucide="image" class="lucide-icon" style="width:14px;height:14px"></i> 背景</h3>
      <div class="bg-type-tabs">${bgTabs}</div>
      ${bgExtra}
      ${sliderSection}
    </div>

    <div class="settings-section">
      <h3><i data-lucide="sparkles" class="lucide-icon" style="width:14px;height:14px"></i> 效果</h3>
      <div class="settings-item-row">
        <span class="settings-item-label">
          磨砂玻璃效果
          <small class="settings-item-desc">让侧栏、卡片等界面呈现半透明毛玻璃质感</small>
        </span>
        <label class="toggle-switch">
          <input type="checkbox" id="glassToggle" ${effectiveGlass ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>
      </div>
      ${effectiveGlass ? `<div class="slider-row" style="margin-top:8px;">
        <span style="font-size:12px;color:var(--text-secondary);">磨砂程度</span>
        <input type="range" id="glassBlurSlider" min="0" max="50" value="${effectiveGlassBlur}">
        <span id="glassBlurVal" style="font-size:12px;color:var(--text-secondary);min-width:32px;">${effectiveGlassBlur}px</span>
      </div>
      <div class="slider-row" style="margin-top:6px;">
        <span style="font-size:12px;color:var(--text-secondary);">透明度</span>
        <input type="range" id="glassOpacitySlider" min="0" max="100" value="${effectiveGlassOpacity}">
        <span id="glassOpacityVal" style="font-size:12px;color:var(--text-secondary);min-width:36px;">${effectiveGlassOpacity}%</span>
      </div>
      <div class="slider-row" style="margin-top:6px;">
        <span style="font-size:12px;color:var(--text-secondary);">弯曲程度</span>
        <input type="range" id="glassCurveSlider" min="0" max="100" value="${effectiveGlassCurve}">
        <span id="glassCurveVal" style="font-size:12px;color:var(--text-secondary);min-width:36px;">${effectiveGlassCurve}%</span>
      </div>
      <div class="slider-row" style="margin-top:6px;">
        <span style="font-size:12px;color:var(--text-secondary);">偏折程度</span>
        <input type="range" id="glassDeflectSlider" min="0" max="100" value="${effectiveGlassDeflect}">
        <span id="glassDeflectVal" style="font-size:12px;color:var(--text-secondary);min-width:36px;">${effectiveGlassDeflect}%</span>
      </div>
      <div class="slider-row" style="margin-top:6px;">
        <span style="font-size:12px;color:var(--text-secondary);">顶层辉光</span>
        <input type="range" id="glassGlowSlider" min="0" max="100" value="${effectiveGlassGlow}">
        <span id="glassGlowVal" style="font-size:12px;color:var(--text-secondary);min-width:36px;">${effectiveGlassGlow}%</span>
      </div>` : ''}
      ${isPresetGlass ? '<div class="bg-preset-info">由「' + preset.name + '」预设提供此效果</div>' : ''}
    </div>

    <div class="settings-section" style="text-align:center;padding-top:12px">
      <button id="themeResetBtn" style="padding:6px 16px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font-size:12px;cursor:pointer;">
        <i data-lucide="rotate-ccw" class="lucide-icon" style="width:13px;height:13px;vertical-align:middle;margin-right:4px"></i>恢复默认
      </button>
    </div>
  `;

  lucide.createIcons();
  bindAppearanceEvents();
}

function bindAppearanceEvents() {
  // Preset cards
  document.querySelectorAll('.theme-preset-card').forEach(card => {
    card.addEventListener('click', () => {
      applyPreset(card.dataset.preset);
      renderAppearancePanel();
    });
  });

  // Accent swatches
  document.querySelectorAll('.accent-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      let cfg = loadCustomTheme();
      cfg = switchToCustomMode(cfg);
      cfg.accent = sw.dataset.accent;
      saveCustomTheme(cfg);
      applyCustomTheme();
      renderAppearancePanel();
    });
  });

  // Custom accent picker
  const accentPicker = document.getElementById('accentCustomPicker');
  if (accentPicker) {
    accentPicker.addEventListener('input', () => {
      let cfg = loadCustomTheme();
      cfg = switchToCustomMode(cfg);
      cfg.accent = accentPicker.value;
      saveCustomTheme(cfg);
      applyCustomTheme();
      document.querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'));
    });
  }

  // Background type tabs
  document.querySelectorAll('.bg-type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      let cfg = loadCustomTheme();
      cfg = switchToCustomMode(cfg);
      cfg.bgType = tab.dataset.bgtype;
      saveCustomTheme(cfg);
      applyCustomTheme();
      renderAppearancePanel();
    });
  });

  // Color
  const bgColor = document.getElementById('bgColorPicker');
  if (bgColor) bgColor.addEventListener('input', () => {
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.bgColor = bgColor.value;
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // Gradient angle
  const angleSlider = document.getElementById('bgAngleSlider');
  if (angleSlider) {
    angleSlider.addEventListener('input', () => {
      const val = angleSlider.value;
      document.getElementById('bgAngleVal').textContent = val + '°';
      let cfg = loadCustomTheme();
      cfg = switchToCustomMode(cfg);
      cfg.bgAngle = parseInt(val); saveCustomTheme(cfg);
      applyCustomTheme();
    });
  }
  const fromPicker = document.getElementById('bgFromPicker');
  if (fromPicker) fromPicker.addEventListener('input', () => {
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.bgFrom = fromPicker.value; saveCustomTheme(cfg);
    applyCustomTheme();
  });
  const toPicker = document.getElementById('bgToPicker');
  if (toPicker) toPicker.addEventListener('input', () => {
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.bgTo = toPicker.value; saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // Image URL
  const imgApply = document.getElementById('bgImageApply');
  if (imgApply) imgApply.addEventListener('click', () => {
    const urlInput = document.getElementById('bgImageUrl');
    if (!urlInput) return;
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.bgImage = urlInput.value.trim();
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // Overlay
  const overlaySlider = document.getElementById('bgOverlaySlider');
  if (overlaySlider) overlaySlider.addEventListener('input', () => {
    const val = parseFloat(overlaySlider.value);
    document.getElementById('bgOverlayVal').textContent = Math.round(val * 100) + '%';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.bgOverlay = val; saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // Blur
  const blurSlider = document.getElementById('bgBlurSlider');
  if (blurSlider) blurSlider.addEventListener('input', () => {
    const val = parseInt(blurSlider.value);
    document.getElementById('bgBlurVal').textContent = val + 'px';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.bgBlur = val; saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // ── Glass effect toggle ──
  const glassToggle = document.getElementById('glassToggle');
  if (glassToggle) glassToggle.addEventListener('change', () => {
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.glass = glassToggle.checked;
    saveCustomTheme(cfg);
    applyCustomTheme();
    renderAppearancePanel();
  });

  // ── Glass blur slider ──
  const glassBlurSlider = document.getElementById('glassBlurSlider');
  if (glassBlurSlider) glassBlurSlider.addEventListener('input', () => {
    const val = parseInt(glassBlurSlider.value);
    const valEl = document.getElementById('glassBlurVal');
    if (valEl) valEl.textContent = val + 'px';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.glassBlur = val;
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // ── Glass opacity slider ──
  const glassOpacitySlider = document.getElementById('glassOpacitySlider');
  if (glassOpacitySlider) glassOpacitySlider.addEventListener('input', () => {
    const val = parseInt(glassOpacitySlider.value);
    const valEl = document.getElementById('glassOpacityVal');
    if (valEl) valEl.textContent = val + '%';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.glassOpacity = val;
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // ── Glass curve (弯曲程度) ──
  const glassCurveSlider = document.getElementById('glassCurveSlider');
  if (glassCurveSlider) glassCurveSlider.addEventListener('input', () => {
    const val = parseInt(glassCurveSlider.value);
    const valEl = document.getElementById('glassCurveVal');
    if (valEl) valEl.textContent = val + '%';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.glassCurve = val;
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // ── Glass deflect (偏折程度) ──
  const glassDeflectSlider = document.getElementById('glassDeflectSlider');
  if (glassDeflectSlider) glassDeflectSlider.addEventListener('input', () => {
    const val = parseInt(glassDeflectSlider.value);
    const valEl = document.getElementById('glassDeflectVal');
    if (valEl) valEl.textContent = val + '%';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.glassDeflect = val;
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // ── Glass glow (顶层辉光) ──
  const glassGlowSlider = document.getElementById('glassGlowSlider');
  if (glassGlowSlider) glassGlowSlider.addEventListener('input', () => {
    const val = parseInt(glassGlowSlider.value);
    const valEl = document.getElementById('glassGlowVal');
    if (valEl) valEl.textContent = val + '%';
    let cfg = loadCustomTheme();
    cfg = switchToCustomMode(cfg);
    cfg.glassGlow = val;
    saveCustomTheme(cfg);
    applyCustomTheme();
  });

  // ── Custom Preset: Save as preset ──
  const savePresetBtn = document.getElementById('saveAsPresetBtn');
  if (savePresetBtn) savePresetBtn.addEventListener('click', async () => {
    const name = await showCustomPrompt('为新预设命名：', '我的主题');
    if (!name || !name.trim()) return;
    const id = 'custom_' + Date.now();
    const cfg = loadCustomTheme();
    // 修复：用 effective 值保存（预设模式下 cfg 原始值可能过期），并同时写入 light/dark 双 mode
    const buildModeData = (mode) => {
      const eff = getEffectiveTheme(cfg, mode);
      const d = {
        accent: eff.accent,
        bg: eff.bgType !== 'none' ? eff.bgType : undefined,
        bgColor: eff.bgColor,
        bgAngle: eff.bgAngle,
        bgFrom: eff.bgFrom,
        bgTo: eff.bgTo,
        bgImage: eff.bgImage || undefined,
        bgVideo: eff.bgVideo || undefined,
        glass: eff.glass || undefined,
        glassBlur: eff.glassBlur !== undefined ? eff.glassBlur : undefined,
        glassOpacity: eff.glassOpacity !== undefined ? eff.glassOpacity : undefined,
        glassCurve: eff.glassCurve !== undefined ? eff.glassCurve : undefined,
        glassDeflect: eff.glassDeflect !== undefined ? eff.glassDeflect : undefined,
        glassGlow: eff.glassGlow !== undefined ? eff.glassGlow : undefined
      };
      // Remove undefined fields
      Object.keys(d).forEach(k => { if (d[k] === undefined) delete d[k]; });
      return d;
    };
    const presetData = {
      name: name.trim(),
      icon: 'palette',
      light: buildModeData('light'),
      dark: buildModeData('dark')
    };
    const custom = getCustomPresets();
    custom[id] = presetData;
    saveCustomPresets(custom);
    // Apply as active preset
    cfg.preset = id;
    cfg.bgType = 'none';
    saveCustomTheme(cfg);
    applyCustomTheme();
    renderAppearancePanel();
  });

  // ── Custom Preset: Delete ──
  document.querySelectorAll('.tpc-delete').forEach(delBtn => {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const presetId = delBtn.dataset.deletePreset;
      if (!presetId) return;
      const confirmed = await showCustomConfirm(`确认删除预设「${getAllPresets()[presetId]?.name || presetId}」？`);
      if (!confirmed) return;
      deleteCustomPreset(presetId);
      // If this preset was active, switch to default
      const cfg = loadCustomTheme();
      if (cfg.preset === presetId) {
        cfg.preset = 'default';
        cfg.bgType = 'none';
        saveCustomTheme(cfg);
        applyCustomTheme();
      }
      renderAppearancePanel();
    });
  });

  // ── Local image file picker ──
  const pickLocalBtn = document.getElementById('bgImagePickLocal');
  if (pickLocalBtn) pickLocalBtn.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.openImageDialog) {
      const result = await window.electronAPI.openImageDialog();
      if (!result || !result.dataUrl) return;
      if (result.warning) alert(result.warning);
      const urlInput = document.getElementById('bgImageUrl');
      if (urlInput) urlInput.value = result.dataUrl;
      const cfg = loadCustomTheme();
      cfg.bgImage = result.dataUrl;
      saveCustomTheme(cfg);
      applyCustomTheme();
    } else {
      // Fallback for non-Electron: use hidden file input
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.onchange = () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.size > 6 * 1024 * 1024) { alert('图片较大（>6MB），可能影响性能'); }
        const reader = new FileReader();
        reader.onload = () => {
          const urlInput = document.getElementById('bgImageUrl');
          if (urlInput) urlInput.value = reader.result;
          const cfg = loadCustomTheme();
          cfg.bgImage = reader.result;
          saveCustomTheme(cfg);
          applyCustomTheme();
        };
        reader.readAsDataURL(file);
      };
      fileInput.click();
    }
  });

  // ── Video URL apply ──
  const videoApplyBtn = document.getElementById('bgVideoApply');
  const videoUrlInput = document.getElementById('bgVideoUrl');
  if (videoApplyBtn && videoUrlInput) {
    videoApplyBtn.addEventListener('click', () => {
      const val = videoUrlInput.value.trim();
      const cfg = loadCustomTheme();
      cfg.bgVideo = val;
      saveCustomTheme(cfg);
      applyCustomTheme();
    });
    videoUrlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') videoApplyBtn.click();
    });
  }

  // ── Local video file picker ──
  const pickVideoBtn = document.getElementById('bgVideoPickLocal');
  if (pickVideoBtn) pickVideoBtn.addEventListener('click', async () => {
    if (window.electronAPI && window.electronAPI.openVideoDialog) {
      const result = await window.electronAPI.openVideoDialog();
      if (!result) return;
      if (result.error) { alert(result.error); return; }
      if (result.fileUrl) {
        const urlInput = document.getElementById('bgVideoUrl');
        if (urlInput) urlInput.value = result.fileUrl;
        const cfg = loadCustomTheme();
        cfg.bgVideo = result.fileUrl;
        saveCustomTheme(cfg);
        applyCustomTheme();
      }
    } else {
      // Fallback for non-Electron: use hidden file input
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'video/*';
      fileInput.onchange = () => {
        const file = fileInput.files[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        const urlInput = document.getElementById('bgVideoUrl');
        if (urlInput) urlInput.value = url;
        const cfg = loadCustomTheme();
        cfg.bgVideo = url;
        saveCustomTheme(cfg);
        applyCustomTheme();
      };
      fileInput.click();
    }
  });

  // Reset
  const resetBtn = document.getElementById('themeResetBtn');
  if (resetBtn) resetBtn.addEventListener('click', async () => {
    const confirmed = await showCustomConfirm('将重置自定义外观（强调色、背景、玻璃效果），明暗主题与自建预设保持不变。继续？');
    if (!confirmed) return;
    localStorage.removeItem('study_theme_custom');
    applyCustomTheme();
    renderAppearancePanel();
  });
}
