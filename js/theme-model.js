/* Pure appearance configuration: migration, preset resolution and validation. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ThemeModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const PRESETS = {
    default: { name: '晴日', icon: 'sun', light: { accent: '#4f6ef7', bg: 'none' }, dark: { accent: '#949bff', bg: 'none' } },
    sky: { name: '晴空', icon: 'cloud', light: { accent: '#3276c3', bg: 'gradient', gAngle: 145, gFrom: '#d9eafb', gTo: '#eef0fa' }, dark: { accent: '#87bafa', bg: 'gradient', gAngle: 145, gFrom: '#152d46', gTo: '#202036' } },
    forest: { name: '林间', icon: 'sprout', light: { accent: '#287e63', bg: 'gradient', gAngle: 150, gFrom: '#cce3d8', gTo: '#f1eddb' }, dark: { accent: '#7cc9a4', bg: 'gradient', gAngle: 150, gFrom: '#173b32', gTo: '#202a25' } },
    sunset: { name: '暮光', icon: 'sunset', light: { accent: '#b9633e', bg: 'gradient', gAngle: 135, gFrom: '#f4d8c5', gTo: '#eee0ef' }, dark: { accent: '#efab87', bg: 'gradient', gAngle: 135, gFrom: '#422936', gTo: '#242640' } },
    lavender: { name: '鸢尾', icon: 'flower', light: { accent: '#8462ba', bg: 'gradient', gAngle: 150, gFrom: '#e0d9ef', gTo: '#f2e7ee' }, dark: { accent: '#c5a9ef', bg: 'gradient', gAngle: 150, gFrom: '#322744', gTo: '#1d263c' } },
    slate: { name: '石墨', icon: 'layers', light: { accent: '#586b7d', bg: 'color', bgColor: '#e9ecef' }, dark: { accent: '#a6bdcf', bg: 'color', bgColor: '#19212b' } },
    glass: { name: '流光', icon: 'sparkles', material: 'liquid', light: { accent: '#5269b4', bg: 'gradient', gAngle: 125, gFrom: '#bededc', gTo: '#d9ccec' }, dark: { accent: '#a3b5f2', bg: 'gradient', gAngle: 125, gFrom: '#18424c', gTo: '#382c58' } }
  };
  const DEFAULTS = {
    version: 2, preset: 'default', accent: '#4f6ef7', bgType: 'none', bgColor: '#f6f7f9',
    bgAngle: 135, bgFrom: '#bededc', bgTo: '#d9ccec', bgImage: '', bgVideo: '',
    bgOverlay: .12, bgBlur: 0, material: 'solid', glass: false,
    glassBlur: 18, glassOpacity: 65, glassCurve: 35, glassDeflect: 25, glassGlow: 55,
    glassPointerIntensity: 20, glassPointerSize: 240,
    glassSaturation: 125, glassQuality: 'auto', glassMotion: true
  };
  const LIMITS = { bgAngle: [0,360], bgOverlay: [0,.8], bgBlur: [0,24], glassBlur: [0,40],
    glassPointerIntensity: [0,100], glassPointerSize: [80,600], glassOpacity: [0,100], glassCurve: [0,100], glassDeflect: [0,100], glassGlow: [0,100], glassSaturation: [100,180] };
  const ALIASES = { bg: 'bgType', gAngle: 'bgAngle', gFrom: 'bgFrom', gTo: 'bgTo' };
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  function clamp(v, min, max, fallback) { const n = Number(v); return Number.isFinite(n) ? Math.min(max,Math.max(min,n)) : fallback; }
  function color(v, fallback) {
    const s = String(v || '').trim();
    if (/^#[a-f\d]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[a-f\d]{3}$/i.test(s)) return '#' + s.slice(1).split('').map(c=>c+c).join('').toLowerCase();
    return fallback;
  }
  function mediaUrl(v, kind) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (/[\u0000-\u001f]/.test(s)) return '';
    if (/^idb:asset_[a-z0-9_-]+$/i.test(s)) return s;
    if (/^(https?:\/\/|blob:|file:\/\/|\.{0,2}\/)/i.test(s)) return s;
    if (kind === 'video' && /^data:video\/(mp4|webm|ogg);base64,/i.test(s)) return s;
    if (kind === 'image' && /^data:image\/(png|jpeg|jpg|webp|gif|avif);base64,/i.test(s)) return s;
    return '';
  }
  function clean(key, value) {
    if (LIMITS[key]) return clamp(value,...LIMITS[key],DEFAULTS[key]);
    if (['accent','bgColor','bgFrom','bgTo'].includes(key)) return color(value,DEFAULTS[key]);
    if (key === 'bgImage') return mediaUrl(value,'image');
    if (key === 'bgVideo') return mediaUrl(value,'video');
    if (key === 'bgType') return ['none','color','gradient','image','video'].includes(value) ? value : 'none';
    if (key === 'material') return ['solid','frosted','liquid'].includes(value) ? value : 'solid';
    if (key === 'glassQuality') return ['auto','high','low'].includes(value) ? value : 'auto';
    if (key === 'glassMotion' || key === 'glass') return value === true;
    return value;
  }
  function presetMode(preset, mode) {
    const source = preset && (preset[mode] || preset.light);
    if (!object(source)) return {};
    const out = {};
    // Old saved presets used bgAngle/bgFrom/bgTo; support both spellings.
    for (const [key,value] of Object.entries(source)) {
      const target = ALIASES[key] || key;
      if (own(DEFAULTS,target) && !['version','preset'].includes(target)) out[target] = clean(target,value);
    }
    if (!own(out,'bgType')) out.bgType = 'none';
    return out;
  }
  function defaults() { return { ...DEFAULTS, overrides: {} }; }
  function normalize(raw) {
    if (!object(raw)) return defaults();
    const cfg = defaults();
    for (const key of Object.keys(DEFAULTS)) if (own(raw,key) && key !== 'version') cfg[key] = clean(key,raw[key]);
    cfg.preset = typeof raw.preset === 'string' && raw.preset.length < 100 ? raw.preset : 'default';
    if (raw.version === 2) {
      if (object(raw.overrides)) for (const [key,value] of Object.entries(raw.overrides)) {
        if (own(DEFAULTS,key) && !['version','preset','glass'].includes(key)) cfg.overrides[key] = clean(key,value);
      }
    } else {
      if (own(raw,'glassRefract') && !own(raw,'glassCurve')) {
        cfg.glassCurve = clean('glassCurve',raw.glassRefract);
        cfg.glassGlow = clean('glassGlow',raw.glassRefract);
      }
      cfg.material = raw.glass === true || cfg.preset === 'glass' ? 'liquid' : 'solid';
      // Existing saved appearance retains its editable parameters. Preset palette
      // still follows light/dark, while the glass toggle remains independently editable.
      for (const key of Object.keys(DEFAULTS)) {
        if (key.startsWith('glass') && key !== 'glass') cfg.overrides[key] = cfg[key];
      }
      cfg.overrides.material = cfg.material;
      for (const key of ['bgOverlay','bgBlur']) if (own(raw,key)) cfg.overrides[key] = cfg[key];
    }
    cfg.glass = cfg.material !== 'solid';
    return cfg;
  }
  function resolve(raw, mode, custom) {
    const cfg = normalize(raw);
    mode = mode === 'dark' ? 'dark' : 'light';
    const presets = { ...(object(custom) ? custom : {}), ...PRESETS };
    const preset = presets[cfg.preset];
    const pm = presetMode(preset,mode);
    const effective = cfg.preset === 'custom' || !preset ? { ...cfg } : { ...cfg,...pm };
    Object.assign(effective,cfg.overrides);
    effective.mode = mode;
    effective.preset = preset || null;
    effective.presetMode = pm;
    effective.isPreset = !!preset && cfg.preset !== 'custom';
    effective.glass = effective.material !== 'solid';
    effective.glassFromPreset = false;
    effective.bgFromPreset = effective.isPreset && !own(cfg.overrides,'bgType');
    return effective;
  }
  function patch(raw, changes) {
    const cfg = normalize(raw);
    for (const [key,value] of Object.entries(changes)) {
      if (!own(DEFAULTS,key) || ['version','preset','glass'].includes(key)) continue;
      cfg[key] = clean(key,value);
      cfg.overrides[key] = cfg[key];
    }
    cfg.glass = cfg.material !== 'solid';
    return cfg;
  }
  function snapshot(eff) {
    const data = {};
    for (const key of Object.keys(DEFAULTS)) if (!['version','preset'].includes(key)) data[key] = clean(key,eff[key]);
    return data;
  }
  function contrastInk(hex) {
    const h = color(hex,'#4f6ef7').slice(1);
    const rgb = [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(n=>n<=.04045?n/12.92:Math.pow((n+.055)/1.055,2.4));
    const l = .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];
    return (l+.05)/.05 > 1.05/(l+.05) ? '#101725' : '#ffffff';
  }
  return { PRESETS, DEFAULTS, defaults, normalize, resolve, patch, snapshot, presetMode, clamp, color, mediaUrl, contrastInk };
});
