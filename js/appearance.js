/* Appearance controller. ThemeModel resolves configuration; this file owns DOM
   application and settings. Changes never overwrite a preset or user content. */
const THEME_PRESETS = ThemeModel.PRESETS;
const ACCENT_PRESETS = ['#4f6ef7','#3276c3','#287e63','#b9633e','#8462ba','#586b7d','#c45069','#92713e'];
const APPEARANCE_KEY = 'study_theme_custom';
const appearanceMediaCache = new Map();
const appearanceMediaPending = new Set();
let appearanceFrame = 0;
let appearanceRevision = 0;
let appearanceFailedVideo = '';
function createDefaultTheme() { return ThemeModel.defaults(); }
function loadCustomTheme() {
  try { return ThemeModel.normalize(JSON.parse(localStorage.getItem(APPEARANCE_KEY))); }
  catch { return createDefaultTheme(); }
}
function saveCustomTheme(data) { localStorage.setItem(APPEARANCE_KEY,JSON.stringify(ThemeModel.normalize(data))); }
function getCustomPresets() {
  try { const p=JSON.parse(localStorage.getItem('study_custom_presets'));return p && typeof p==='object' && !Array.isArray(p)?p:{}; }
  catch{return {};}
}
function saveCustomPresets(data) { localStorage.setItem('study_custom_presets',JSON.stringify(data)); }
function getAllPresets() { return {...getCustomPresets(),...THEME_PRESETS}; }
function deleteCustomPreset(id) {
  if(Object.prototype.hasOwnProperty.call(THEME_PRESETS,id))return;
  const custom=getCustomPresets();delete custom[id];saveCustomPresets(custom);
}
function isDarkTheme() { return document.documentElement.dataset.theme==='dark'; }
function getEffectiveTheme(cfg,forcedMode) { return ThemeModel.resolve(cfg,forcedMode || (isDarkTheme()?'dark':'light'),getCustomPresets()); }
function safeCssColor(v,fallback) {return ThemeModel.color(v,fallback);}
function safeBgImageUrl(v) {return ThemeModel.mediaUrl(v,'image');}
function safeCssAngle(v) {return ThemeModel.clamp(v,0,360,135);}
function cssUrl(url) {return 'url("'+String(url).replace(/["\\]/g,'\\$&').replace(/[\n\r]/g,'')+'")';}
function adjustColor(hex,amount) {
  const h=ThemeModel.color(hex,'#4f6ef7').slice(1);
  return '#'+[0,2,4].map(i=>Math.max(0,Math.min(255,parseInt(h.slice(i,i+2),16)+amount)).toString(16).padStart(2,'0')).join('');
}
function appearanceNotice(message) {
  const status=document.getElementById('appearanceStatus');
  if(status)status.textContent=message;
}
function scheduleAppearance() {
  if(appearanceFrame)return;
  appearanceFrame=requestAnimationFrame(()=>{appearanceFrame=0;applyCustomTheme();});
}
function updateAppearance(changes,rerender) {
  if (Object.prototype.hasOwnProperty.call(changes,'bgVideo')) appearanceFailedVideo='';
  try { saveCustomTheme(ThemeModel.patch(loadCustomTheme(),changes)); }
  catch { appearanceNotice('设置未能保存，请检查可用存储空间。');return; }
  scheduleAppearance();
  if(rerender)renderAppearancePanel();
}
function applyPreset(id) {
  const preset=getAllPresets()[id];if(!preset)return;
  const prev=getEffectiveTheme(loadCustomTheme());
  const cfg={...createDefaultTheme(),preset:id,material:preset.material || prev.material,bgImage:prev.bgImage,bgVideo:prev.bgVideo};
  saveCustomTheme(cfg);applyCustomTheme();
}
function switchToCustomMode(cfg) {
  return {...ThemeModel.snapshot(getEffectiveTheme(cfg)),version:2,preset:'custom',overrides:{}};
}
function saveAppearancePreset(name) {
  const trimmed=String(name || '').trim().slice(0,40);if(!trimmed)return null;
  const cfg=loadCustomTheme(), custom=getCustomPresets();
  const id='custom_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7);
  custom[id]={name:trimmed,icon:'palette',light:ThemeModel.snapshot(getEffectiveTheme(cfg,'light')),dark:ThemeModel.snapshot(getEffectiveTheme(cfg,'dark'))};
  saveCustomPresets(custom);saveCustomTheme({...createDefaultTheme(),preset:id,material:getEffectiveTheme(cfg).material});
  applyCustomTheme();return id;
}
function resolveMedia(url,kind) {
  if(!url)return '';
  if(appearanceMediaCache.has(url))return appearanceMediaCache.get(url);
  if(!/^(idb:|blob:)/.test(url))return url;
  if(appearanceMediaPending.has(url))return '';
  const storage=window.BgMediaIDB;
  if(!storage)return '';
  appearanceMediaPending.add(url);
  const restore=url.startsWith('idb:')?storage.resolveAsset(url):
    kind==='image'?storage.loadImageUrl():storage.loadVideoUrl();
  Promise.resolve(restore).then(result=>{
    const resolved=typeof result==='string'?result:result?.url;
    appearanceMediaCache.set(url,resolved || '');
    const eff=getEffectiveTheme(loadCustomTheme());
    if(eff[kind==='image'?'bgImage':'bgVideo']===url){
      applyCustomTheme();
      if(!resolved)appearanceNotice('背景文件暂时不可用，请重新选择本地文件。');
    }
  }).catch(()=>{
    appearanceMediaCache.set(url,'');appearanceNotice('背景文件加载失败，请重新选择文件。');
  }).finally(()=>appearanceMediaPending.delete(url));
  return '';
}
function buildBgImageValue(eff) {
  if(eff.bgType==='gradient')return 'linear-gradient('+eff.bgAngle+'deg,'+eff.bgFrom+','+eff.bgTo+')';
  if(eff.bgType==='image'){
    const url=resolveMedia(eff.bgImage,'image');return url?cssUrl(url):'none';
  }
  return 'none';
}
function resetGlassVariables() {
  // Remove values owned by the former inline-variable renderer when hot reloading.
  const names=['card','sidebar-bg','todo-bg','todo-hover-bg','input-bg','hover-bg','search-bg','note-item-bg','note-item-active-bg','modal-bg','cat-section-bg','cat-header-bg','sub-input-bg','badge-bg','progress-bg','path-bg','note-list-bg','modal-overlay','glass-blur','glass-glow'];
  names.forEach(n=>document.documentElement.style.removeProperty('--'+n));
}
function applyCustomTheme() {
  appearanceRevision++;
  const root=document.documentElement,cfg=loadCustomTheme(),eff=getEffectiveTheme(cfg);
  const dark=eff.mode==='dark',surface=dark?'28,34,46':'255,255,255';
  const glass=eff.material!=='solid';
  const alpha=ThemeModel.surfaceAlpha(eff.material,eff.glassOpacity);
  const rgba=(a)=>'rgba('+surface+','+a.toFixed(3)+')';
  const themedRgba=(darkRgb,lightRgb,value)=>'rgba('+(dark?darkRgb:lightRgb)+','+value.toFixed(3)+')';
  const ink=ThemeModel.contrastInk(eff.accent);
  const values={
    '--primary':eff.accent,'--primary-hover':adjustColor(eff.accent,dark?12:-14),'--on-primary':ink,
    '--bg':eff.bgType==='color'?eff.bgColor:dark?'#141821':'#f6f7f9',
    '--bg-image':buildBgImageValue(eff),'--bg-blur':eff.bgBlur+'px',
    '--theme-overlay':eff.bgType==='none' || eff.bgType==='color'?'transparent':'rgba('+(dark?'10,15,25':'247,249,253')+','+eff.bgOverlay+')',
    '--card':rgba(alpha),'--sidebar-bg':rgba(alpha),
    '--modal-bg':rgba(alpha),'--input-bg':dark?'rgba(17,23,34,.78)':'rgba(247,249,253,.84)',
    '--search-bg':dark?'rgba(17,23,34,.78)':'rgba(247,249,253,.84)',
    '--todo-bg':themedRgba('27,35,49','250,252,255',alpha),
    '--todo-hover-bg':themedRgba('38,48,65','245,248,255',alpha),
    '--note-list-bg':rgba(alpha),'--note-item-bg':rgba(alpha),
    '--note-item-active-bg':'color-mix(in srgb,'+eff.accent+' '+(12*alpha).toFixed(2)+'%,transparent)',
    '--cat-section-bg':rgba(alpha),'--cat-header-bg':rgba(alpha),
    '--sub-input-bg':rgba(.9),'--path-bg':rgba(alpha),
    '--hover-bg':dark?'rgba(43,54,73,.9)':'rgba(239,244,252,.9)',
    '--badge-bg':dark?'#303b50':'#e9edf5','--progress-bg':dark?'#273245':'#e9edf5',
    '--modal-overlay':dark?'rgba(5,9,18,.6)':'rgba(32,44,67,.28)',
    '--glass-surface':rgba(alpha),'--glass-modal':rgba(alpha),
    '--glass-pointer-intensity':(eff.glassPointerIntensity/100).toFixed(2),'--glass-pointer-size':eff.glassPointerSize+'px',
    '--glass-glow':(eff.glassGlow/100).toFixed(2),'--glass-blur':eff.glassBlur+'px',
    '--glass-saturation':eff.glassSaturation+'%',
    '--glass-border':dark?'rgba(215,231,255,.18)':'rgba(255,255,255,.72)',
    '--glass-shadow':dark?'0 16px 42px rgba(0,0,0,.2)':'0 12px 36px rgba(38,57,83,.09)'
  };
  resetGlassVariables();
  let style=document.getElementById('theme-custom-css');
  if(!style){style=document.createElement('style');style.id='theme-custom-css';document.head.appendChild(style);}
  style.textContent=':root[data-theme] {'+Object.entries(values).map(([k,v])=>k+':'+v+';').join('')+'}';
  root.dataset.appearanceVersion='2';root.dataset.glass=glass?'true':'false';delete root.dataset.glassClear;root.dataset.material=eff.material;
  window.LiquidGlass?.configure(eff);
  const bg=document.querySelector('.app-bg-layer');
  const video=document.querySelector('.app-bg-video'),veil=document.querySelector('.app-bg-video-overlay');
  const resolvedVideo=eff.bgType==='video'?resolveMedia(eff.bgVideo,'video'):'';
  const videoUrl=resolvedVideo===appearanceFailedVideo?'':resolvedVideo;
  if(video) {
    if(videoUrl){
      if(video.getAttribute('src')!==videoUrl)video.src=videoUrl;
      video.classList.add('active');veil?.classList.add('active');if(bg)bg.style.display='none';
      syncAppearanceVideo();
    } else {
      video.pause();video.classList.remove('active');veil?.classList.remove('active');
      if(video.hasAttribute('src')){video.removeAttribute('src');video.load();}
      if(bg)bg.style.display='';
    }
  }
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',values['--bg']);
  updateAppearancePreview();
}
function syncAppearanceVideo() {
  const video=document.querySelector('.app-bg-video');
  if(!video?.classList.contains('active'))return;
  const source=video.getAttribute('src');
  if(document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches)video.pause();
  else if(video.paused)video.play().catch(()=>{
    if(!video.classList.contains('active') || video.getAttribute('src')!==source)return;
    if(video.error)appearanceNotice('视频无法解码，请更换支持的视频文件。');
    else appearanceNotice('视频播放暂未开始，点击页面后重试。');
  });
}
document.querySelector('.app-bg-video')?.addEventListener('error',()=>{
  const video=document.querySelector('.app-bg-video');
  if(!video?.getAttribute('src'))return;
  appearanceFailedVideo=video.getAttribute('src');
  applyCustomTheme();
  appearanceNotice('视频无法加载或解码，已恢复默认背景。请更换视频文件。');
});
document.addEventListener('visibilitychange',syncAppearanceVideo);
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',syncAppearanceVideo);
document.addEventListener('pointerdown',syncAppearanceVideo,{passive:true});
window.addEventListener('storage',event=>{
  if([APPEARANCE_KEY,'study_custom_presets','study_theme'].includes(event.key)){
    applyTheme(getTheme());if(document.getElementById('settingsPanelAppearance')?.classList.contains('active'))renderAppearancePanel();
  }
});
function applyGlassOpacity(v){updateAppearance({glassOpacity:v});}
function applyGlassCurve(v){updateAppearance({glassCurve:v});}
function applyGlassDeflect(v){updateAppearance({glassDeflect:v});}
function applyGlassGlow(v){updateAppearance({glassGlow:v});}
const UI_ZOOM_KEY='study_ui_zoom';
function getUiZoom(){try{return ThemeModel.clamp(parseFloat(localStorage.getItem(UI_ZOOM_KEY)),.7,1.5,1);}catch{return 1;}}
function setUiZoom(v){localStorage.setItem(UI_ZOOM_KEY,String(ThemeModel.clamp(v,.7,1.5,1)));applyUiZoom();}
function applyUiZoom(el){
  const zoom=String(getUiZoom());
  if(el?.style){el.style.zoom=zoom;return;}
  for(const selector of ['.app','#timerFloat','#mobileMorePanel']){const node=document.querySelector(selector);if(node)node.style.zoom=zoom;}
}


function apEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function apIcon(name){return '<i data-lucide="'+name+'" aria-hidden="true"></i>';}
function apRange(id,key,label,value,min,max,unit,step) {
  return '<div class="ap-range"><label for="'+id+'">'+label+'</label><output id="'+id+'Val" for="'+id+'">'+(key==='bgOverlay'?Math.round(value*100):value)+unit+'</output><input id="'+id+'" data-range="'+key+'" type="range" min="'+min+'" max="'+max+'" step="'+(step || 1)+'" value="'+value+'" data-unit="'+unit+'"></div>';
}
function apChoices(items,value,attribute) {
  return '<div class="ap-segment">'+items.map(([id,label,icon])=>'<button type="button" '+attribute+'="'+id+'" aria-pressed="'+(id===value)+'" class="'+(id===value?'active':'')+'">'+(icon?apIcon(icon):'')+label+'</button>').join('')+'</div>';
}
function renderAppearancePanel() {
  const container=document.getElementById('appearancePanelContent');if(!container)return;
  const scroller=container.closest('.modal-body'),scrollTop=scroller?.scrollTop || 0;
  const cfg=loadCustomTheme(),eff=getEffectiveTheme(cfg),custom=getCustomPresets();
  const palettes=Object.entries(getAllPresets()).map(([id,p])=>{
    const pm=ThemeModel.presetMode(p,eff.mode),accent=pm.accent || '#4f6ef7';
    const bg=pm.bgType==='gradient'?'linear-gradient(135deg,'+pm.bgFrom+','+pm.bgTo+')':pm.bgType==='color'?pm.bgColor:'color-mix(in srgb,'+accent+' 14%,var(--ap-panel))';
    return '<div class="ap-preset-wrap"><button type="button" class="ap-preset '+(cfg.preset===id?'active':'')+'" data-preset="'+apEscape(id)+'" aria-pressed="'+(cfg.preset===id)+'" title="'+apEscape(p.name || id)+'"><span class="ap-palette" style="--palette-bg:'+bg+';--palette-accent:'+accent+'"><span></span><span></span><span></span></span><span>'+apEscape(p.name || id)+'</span></button>'+
      (Object.prototype.hasOwnProperty.call(custom,id)&&!Object.prototype.hasOwnProperty.call(THEME_PRESETS,id)?'<button type="button" class="ap-preset-delete" data-delete-preset="'+apEscape(id)+'" aria-label="删除预设 '+apEscape(p.name || id)+'">'+apIcon('x')+'</button>':'')+'</div>';
  }).join('');
  const bgType=eff.bgType;
  let backgroundControls='';
  if(bgType==='color')backgroundControls='<label class="ap-color-row" for="bgColorPicker">背景颜色<input type="color" id="bgColorPicker" data-color="bgColor" value="'+eff.bgColor+'"></label>';
  if(bgType==='gradient')backgroundControls='<div class="ap-gradient-colors"><label for="bgFromPicker">起点<input type="color" id="bgFromPicker" data-color="bgFrom" value="'+eff.bgFrom+'"></label><span>→</span><label for="bgToPicker">终点<input type="color" id="bgToPicker" data-color="bgTo" value="'+eff.bgTo+'"></label></div>'+apRange('bgAngleSlider','bgAngle','渐变方向',eff.bgAngle,0,360,'°');
  if(bgType==='image'||bgType==='video'){
    const value=eff[bgType==='image'?'bgImage':'bgVideo'];
    const local=/^(idb:|blob:|data:)/.test(value);
    backgroundControls='<div class="ap-media"><label for="apMediaUrl">'+(bgType==='image'?'图片':'视频')+'地址</label><div class="ap-url-row"><input id="apMediaUrl" type="text" value="'+apEscape(local?'':value)+'" placeholder="https://…"><button type="button" id="apMediaApply">应用</button></div><button type="button" id="apMediaPick" class="ap-upload">'+apIcon('upload')+(local?'已选择本地文件 · 更换':'选择本地'+(bgType==='image'?'图片':'视频'))+'</button><input id="apMediaFile" type="file" accept="'+bgType+'/*" hidden><p class="ap-hint">本地文件会保存在此设备，重新打开应用后仍可使用。</p></div>';
  }
  const glassControls=eff.glass?
    apRange('glassBlurSlider','glassBlur','磨砂模糊',eff.glassBlur,0,40,'px')+
    apRange('glassOpacitySlider','glassOpacity','通透程度',eff.glassOpacity,0,100,'%')+
    (eff.material==='liquid'?apRange('glassCurveSlider','glassCurve','边缘折射',eff.glassCurve,0,100,'%')+
    apRange('glassDeflectSlider','glassDeflect','折射范围',eff.glassDeflect,0,100,'%')+
    apRange('glassGlowSlider','glassGlow','边缘高光',eff.glassGlow,0,100,'%')+
    apRange('glassPointerIntensitySlider','glassPointerIntensity','光标高光强度',eff.glassPointerIntensity,0,100,'%')+
    apRange('glassPointerSizeSlider','glassPointerSize','光标高光范围',eff.glassPointerSize,80,600,'px'):'')+
    apRange('glassSaturationSlider','glassSaturation','背景饱和度',eff.glassSaturation,100,180,'%'):'<p class="ap-hint">清晰、安静的实色面板，适合长时间阅读。</p>';
  container.innerHTML=
    '<div class="appearance-studio"><div class="ap-heading"><div><span class="ap-eyebrow">MAKE IT YOURS</span><h2>让学习空间，更像你。</h2><p>挑一种颜色，留一点光。每次调整，即时呈现。</p></div><span id="appearanceStatus" class="ap-save-status" role="status" aria-live="polite">设置已保存</span></div>'+
    '<div class="appearance-preview" aria-label="当前主题效果预览"><div class="ap-preview-orb ap-preview-orb-one"></div><div class="ap-preview-orb ap-preview-orb-two"></div><div class="appearance-preview-card"><div class="ap-preview-rail">'+apIcon('book-open')+'<span></span><span></span><span></span></div><div class="ap-preview-content"><span class="ap-preview-kicker">YOUR QUIET CORNER</span><h3>专注此刻</h3><p>把时间，留给重要的事。</p><div class="ap-preview-task">'+apIcon('circle-check')+'向今天的目标，再近一步</div><div class="ap-preview-action">开始专注 '+apIcon('arrow-up-right')+'</div></div></div><div class="ap-preview-caption"><span id="apPreviewName"></span><span id="apRenderStatus"></span></div></div>'+
    '<div class="ap-columns"><div class="ap-column">'+
    '<section class="ap-section"><div class="ap-section-head"><h3>'+apIcon('sun-moon')+'明暗模式</h3></div>'+
    apChoices([['light','浅色','sun'],['dark','深色','moon'],['system','跟随系统','monitor']],getTheme(),'data-theme-mode')+'</section>'+
    '<section class="ap-section"><div class="ap-section-head"><h3>'+apIcon('palette')+'主题配色</h3><button type="button" id="saveAsPresetBtn" class="ap-text-button">'+apIcon('plus')+'保存预设</button></div><div class="ap-presets">'+palettes+'</div><div class="ap-accent"><span>强调色</span><div class="ap-swatches">'+ACCENT_PRESETS.map(c=>'<button type="button" data-accent="'+c+'" class="ap-swatch" style="--swatch:'+c+'" aria-label="强调色 '+c+'" aria-pressed="'+(c===eff.accent)+'"></button>').join('')+'<input type="color" id="accentCustomPicker" data-color="accent" value="'+eff.accent+'" aria-label="自定义强调色"></div></div></section>'+
    '<section class="ap-section"><div class="ap-section-head"><h3>'+apIcon('image')+'背景</h3></div>'+
    apChoices([['none','默认'],['color','纯色'],['gradient','渐变'],['image','图片'],['video','视频']],bgType,'data-bgtype')+
    '<div class="ap-bg-controls">'+backgroundControls+
    (['gradient','image','video'].includes(bgType)?apRange('bgOverlaySlider','bgOverlay','背景柔化',eff.bgOverlay,0,.8,'%',.01)+apRange('bgBlurSlider','bgBlur','背景模糊',eff.bgBlur,0,24,'px'):'')+'</div></section></div>'+
    '<div class="ap-column"><section class="ap-section"><div class="ap-section-head"><h3>'+apIcon('layers')+'界面材质</h3></div><div class="ap-materials">'+
    [['solid','实色','干净，专注内容','square'],['frosted','磨砂','柔和，朦胧透光','cloud'],['liquid','液态玻璃','流光，轻盈折射','sparkles']].map(([id,label,hint,icon])=>'<button type="button" data-material="'+id+'" class="ap-material '+(eff.material===id?'active':'')+'" aria-pressed="'+(eff.material===id)+'">'+apIcon(icon)+'<strong>'+label+'</strong><small>'+hint+'</small></button>').join('')+'</div><div class="ap-material-controls">'+glassControls+'</div>'+
    (eff.glass?'<div class="ap-performance"><label for="glassQuality">效果质量</label><select id="glassQuality"><option value="auto" '+(eff.glassQuality==='auto'?'selected':'')+'>自动适配</option><option value="high" '+(eff.glassQuality==='high'?'selected':'')+'>精细效果</option><option value="low" '+(eff.glassQuality==='low'?'selected':'')+'>流畅优先</option></select></div><p class="ap-hint">自动模式会在手机上减轻效果。减少动态效果开启时，暂停折射动态与视频背景。</p>'+
    (eff.material==='liquid'?'<label class="ap-switch-row" for="glassMotion"><span>跟随光影<small>移动到预览或面板上查看效果，强度为 0 时隐藏</small></span><input type="checkbox" id="glassMotion" '+(eff.glassMotion?'checked':'')+'></label>':''):'')+'</section>'+
    '<section class="ap-section"><div class="ap-section-head"><h3>'+apIcon('scan')+'界面大小</h3></div>'+apRange('uiZoomSlider','uiZoom','页面缩放',Math.round(getUiZoom()*100),70,150,'%',5)+'</section></div></div>'+
    '<div class="ap-footer"><p>主题与材质独立调整，自建预设会保存完整外观。</p><button type="button" id="themeResetBtn">'+apIcon('rotate-ccw')+'恢复默认外观</button></div></div>';
  if(typeof lucide!=='undefined')lucide.createIcons();
  bindAppearanceEvents();updateAppearancePreview();
  if(scroller)scroller.scrollTop=scrollTop;
}
function updateAppearancePreview() {
  const container=document.getElementById('appearancePanelContent');
  if(!container?.querySelector('.appearance-preview'))return;
  const cfg=loadCustomTheme(),eff=getEffectiveTheme(cfg);
  const preview=container.querySelector('.appearance-preview');
  preview.style.backgroundImage=buildBgImageValue(eff);
  preview.style.backgroundColor=eff.bgType==='color'?eff.bgColor:isDarkTheme()?'#27354b':'#dce6f4';
  const title=document.getElementById('apPreviewName');
  const name=eff.preset?.name || '自定义';
  if(title)title.textContent=name+' · '+({solid:'实色',frosted:'磨砂',liquid:'液态玻璃'}[eff.material])+(Object.keys(cfg.overrides).length?' · 已调整':'');
  const state=window.LiquidGlass?.status();
  const renderStatus=document.getElementById('apRenderStatus');
  if(renderStatus)renderStatus.textContent=!eff.glass?'实色面板':!state?.blurSupported?'当前设备使用实色回退':state.refract?'折射与高光已启用':eff.material==='liquid'?'当前设备使用轻量玻璃':'柔和磨砂已启用';
  container.querySelectorAll('[data-accent]').forEach(btn=>btn.setAttribute('aria-pressed',String(btn.dataset.accent===eff.accent)));
  container.querySelectorAll('[data-theme-mode]').forEach(btn=>{
    const active=btn.dataset.themeMode===getTheme();btn.classList.toggle('active',active);btn.setAttribute('aria-pressed',String(active));
  });
}
window.addEventListener('liquidglasschange',updateAppearancePreview);
function bindAppearanceEvents() {
  const container=document.getElementById('appearancePanelContent');
  container.onclick=async event=>{
    const button=event.target.closest('button');if(!button || !container.contains(button))return;
    try{
      if(button.dataset.preset){applyPreset(button.dataset.preset);renderAppearancePanel();}
      else if(button.dataset.themeMode){applyTheme(button.dataset.themeMode);renderAppearancePanel();}
      else if(button.dataset.accent){updateAppearance({accent:button.dataset.accent});}
      else if(button.dataset.bgtype){updateAppearance({bgType:button.dataset.bgtype},true);}
      else if(button.dataset.material){updateAppearance({material:button.dataset.material},true);}
      else if(button.dataset.deletePreset){
        const id=button.dataset.deletePreset;
        if(await showCustomConfirm('删除这个自建预设？当前外观会保留。')){
          const cfg=loadCustomTheme();
          if(cfg.preset===id)saveCustomTheme(switchToCustomMode(cfg));
          deleteCustomPreset(id);applyCustomTheme();renderAppearancePanel();
        }
      } else if(button.id==='saveAsPresetBtn'){
        const name=await showCustomPrompt('给这套外观起个名字','我的主题');
        if(name){saveAppearancePreset(name);renderAppearancePanel();}
      } else if(button.id==='themeResetBtn'){
        if(await showCustomConfirm('恢复默认配色、背景、材质和界面大小？明暗模式、自建预设与学习内容会保留。')){
          saveCustomTheme(createDefaultTheme());setUiZoom(1);applyCustomTheme();renderAppearancePanel();
        }
      } else if(button.id==='apMediaPick')document.getElementById('apMediaFile')?.click();
      else if(button.id==='apMediaApply'){
        const kind=getEffectiveTheme(loadCustomTheme()).bgType;
        const raw=document.getElementById('apMediaUrl').value.trim(),url=ThemeModel.mediaUrl(raw,kind);
        if(raw&&!url){appearanceNotice('请输入有效的图片或视频地址。');return;}
        updateAppearance({[kind==='image'?'bgImage':'bgVideo']:url});
      }
    }catch(error){appearanceNotice('操作未完成：'+error.message);}
  };
  container.oninput=event=>{
    const input=event.target,key=input.dataset.range || input.dataset.color;
    if(!key)return;
    if(input.dataset.range){
      const value=Number(input.value),output=document.getElementById(input.id+'Val');
      if(output)output.textContent=(key==='bgOverlay'?Math.round(value*100):value)+input.dataset.unit;
      if(key==='uiZoom'){setUiZoom(value/100);return;}
      updateAppearance({[key]:value});
    }else updateAppearance({[key]:input.value});
  };
  container.onchange=async event=>{
    const input=event.target;
    if(input.id==='glassQuality')updateAppearance({glassQuality:input.value});
    if(input.id==='glassMotion')updateAppearance({glassMotion:input.checked});
    if(input.id==='apMediaFile'&&input.files?.[0]){
      const file=input.files[0],kind=getEffectiveTheme(loadCustomTheme()).bgType,revision=appearanceRevision;
      appearanceNotice('正在保存本地背景…');
      try{
        const asset=await window.BgMediaIDB.saveAsset(file,kind);
        if(revision!==appearanceRevision)return;
        if(!asset?.url)throw new Error('本地文件未能保存');
        updateAppearance({[kind==='image'?'bgImage':'bgVideo']:asset.url},true);
      }catch(error){appearanceNotice('背景保存失败：'+error.message);}
    }
  };
  container.onkeydown=event=>{if(event.target.id==='apMediaUrl'&&event.key==='Enter'){event.preventDefault();document.getElementById('apMediaApply')?.click();}};
}
