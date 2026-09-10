/* Liquid surface renderer. Blur is the universal base; refraction is optional.
   Only top-level panels receive expensive filters. No permanent animation loop. */
(function () {
  'use strict';
  const root = document.documentElement;
  const FILTER_ID = 'liquid-glass-filter';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const compact = window.matchMedia('(max-width: 800px)');
  const coarse = window.matchMedia('(pointer: coarse)');
  const chromium = /Chrome\/[\d.]+/.test(navigator.userAgent) && !/CriOS|EdgiOS|FxiOS/.test(navigator.userAgent);
  const blurSupported = typeof CSS !== 'undefined' && (CSS.supports('backdrop-filter','blur(1px)') || CSS.supports('-webkit-backdrop-filter','blur(1px)'));
  const urlSupported = chromium && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter','url("#' + FILTER_ID + '")');
  let config = { material:'solid', glassQuality:'auto', glassBlur:18, glassCurve:35, glassDeflect:25, glassMotion:true };
  let frame = 0, pointerFrame = 0, mapKey = '', mapUrl = '', lastSurface = null, lastPointer = null;
  const surfaces = '.sidebar, .section > .card, .today-dashboard > [class$="-card"], .today-welcome, .modal, .appearance-preview-card';
  function generateMap(edge) {
    const key = edge.toFixed(3);
    if (mapKey === key && mapUrl) return mapUrl;
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const data = context.createImageData(size,size);
    function bend(t) {
      if (edge <= 0) return 0;
      if (t < edge) return -Math.pow(1-t/edge,3);
      if (t > 1-edge) return Math.pow((t-1+edge)/edge,3);
      return 0;
    }
    for (let y=0;y<size;y++) for (let x=0;x<size;x++) {
      const i=(y*size+x)*4;
      data.data[i]=Math.round(128+bend(x/(size-1))*120);
      data.data[i+1]=Math.round(128+bend(y/(size-1))*120);
      data.data[i+2]=128; data.data[i+3]=255;
    }
    context.putImageData(data,0,0);
    mapKey=key; mapUrl=canvas.toDataURL();
    return mapUrl;
  }
  function ensureFilter() {
    let svg=document.getElementById('liquid-glass-svg');
    if (svg) return svg;
    svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.id='liquid-glass-svg';svg.setAttribute('aria-hidden','true');
    svg.style.cssText='position:fixed;width:0;height:0;pointer-events:none;overflow:hidden';
    svg.innerHTML='<defs><filter id="'+FILTER_ID+'" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage id="lg-feimage" width="100%" height="100%" preserveAspectRatio="none" result="map"/><feDisplacementMap id="lg-fedm" in="SourceGraphic" in2="map" xChannelSelector="R" yChannelSelector="G" scale="0"/></filter></defs>';
    svg.querySelector('#lg-feimage').setAttribute('href',generateMap(config.glassDeflect/100*.22));
    document.body.appendChild(svg);return svg;
  }
  function clearPointer() {
    if (lastSurface) { lastSurface.style.removeProperty('--glass-pointer-active');lastSurface.style.removeProperty('--glass-pointer-x');lastSurface.style.removeProperty('--glass-pointer-y'); }
    lastSurface=null;lastPointer=null;
    if(pointerFrame)cancelAnimationFrame(pointerFrame);
    pointerFrame=0;
  }
  function status() {
    const enabled=config.material!=='solid';
    const lite=config.glassQuality==='low' || (config.glassQuality==='auto' && (compact.matches || coarse.matches));
    const refract=enabled && config.material==='liquid' && !lite && !reduced.matches && blurSupported && urlSupported && config.glassCurve>0 && config.glassDeflect>0;
    return { enabled, lite, refract, blurSupported, motion: refract && config.glassMotion && !document.hidden,
      renderer: !enabled?'solid':!blurSupported?'fallback':refract?'liquid':'frosted' };
  }
  function render() {
    frame=0;
    const state=status();
    root.dataset.glassRenderer=state.renderer;
    root.dataset.glassMotion=state.motion?'true':'false';
    if(!state.motion)clearPointer();
    root.style.setProperty('--glass-render-blur',Math.min(config.glassBlur,state.lite?14:40)+'px');
    if (state.refract) {
      ensureFilter();
      document.getElementById('lg-feimage').setAttribute('href',generateMap(config.glassDeflect/100*.22));
      document.getElementById('lg-fedm').setAttribute('scale',String(Math.round(config.glassCurve*.22)));
    } else {
      document.getElementById('liquid-glass-svg')?.remove();
      clearPointer();
    }
    window.dispatchEvent(new CustomEvent('liquidglasschange',{detail:state}));
  }
  function schedule() { if (!frame) frame=requestAnimationFrame(render); }
  function configure(next) { config={...config,...next};schedule(); }
  window.LiquidGlass={ configure, status, destroy() {
    config.material='solid';if(frame)cancelAnimationFrame(frame);frame=0;render();mapUrl='';mapKey='';
  }};
  // Legacy extension hooks remain available.
  window.updateLiquidGlass=function(scale,edgeRatio) {
    if(scale!==undefined)config.glassCurve=Math.max(0,Math.min(100,Number(scale)/.22));
    if(edgeRatio!==undefined)config.glassDeflect=Math.max(0,Math.min(100,Number(edgeRatio)/.22*100));
    schedule();
  };
  document.addEventListener('pointermove',event=>{
    if(!status().motion || event.pointerType==='touch')return;
    const surface=event.target.closest(surfaces);
    if(!surface || surface.matches('#section-today > .card')){clearPointer();return;}
    if(lastSurface!==surface){clearPointer();lastSurface=surface;}
    lastPointer={x:event.clientX,y:event.clientY};
    if(pointerFrame)return;
    pointerFrame=requestAnimationFrame(()=>{
      pointerFrame=0;
      if(!lastSurface?.isConnected || !lastPointer)return;
      const box=lastSurface.getBoundingClientRect();
      lastSurface.style.setProperty('--glass-pointer-active','1');
      lastSurface.style.setProperty('--glass-pointer-x',((lastPointer.x-box.left)/Math.max(1,box.width)*100).toFixed(1)+'%');
      lastSurface.style.setProperty('--glass-pointer-y',((lastPointer.y-box.top)/Math.max(1,box.height)*100).toFixed(1)+'%');
    });
  },{passive:true});
  document.addEventListener('pointerleave',clearPointer);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearPointer();schedule();});
  for(const query of [reduced,compact,coarse])query.addEventListener('change',schedule);
})();
