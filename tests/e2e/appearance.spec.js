'use strict';
const { test, expect } = require('@playwright/test');
const { _electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
let app, page, profile;
const errors=[];
async function editRange(id,value) {
  await page.locator('#'+id).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
}
async function effective() { return page.evaluate(()=>getEffectiveTheme(loadCustomTheme())); }
test.beforeAll(async()=>{
  profile=await fs.mkdtemp(path.join(os.tmpdir(),'mst-appearance-'));
  app=await _electron.launch({args:[path.resolve('.')],env:{...process.env,MST_E2E:'1',MST_USER_DATA_PATH:profile}});
  page=await app.firstWindow();
  page.on('pageerror',error=>errors.push(error.stack || error.message));
  await page.waitForFunction(()=>typeof window.ThemeModel!=='undefined' && document.querySelector('#nav-today'));
});
test.afterAll(async()=>{if(app)await app.close();if(profile)await fs.rm(profile,{recursive:true,force:true});});
test.beforeEach(async()=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.emulateMedia({colorScheme:'light',reducedMotion:'no-preference'});
  await page.evaluate(()=>{saveCustomTheme(createDefaultTheme());applyTheme('light');switchTab('today');openSettingsModal();switchSettingsTab('appearance');});
});
test('preset, material and sliders compose and survive a renderer reload',async()=>{
  await page.click('[data-preset="forest"]');
  await page.click('[data-material="liquid"]');
  await expect(page.locator('html')).toHaveAttribute('data-material','liquid');
  await editRange('glassBlurSlider',25);
  await editRange('glassOpacitySlider',81);
  await editRange('glassCurveSlider',44);
  await expect.poll(async()=>(await effective()).glassBlur).toBe(25);
  expect((await effective()).accent).toBe('#287e63');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-today'));
  await expect(page.locator('html')).toHaveAttribute('data-material','liquid');
  expect((await effective()).glassOpacity).toBe(81);
  expect((await effective()).glassCurve).toBe(44);
  expect((await effective()).accent).toBe('#287e63');
});
test('solid mode removes refraction and translucent material without losing palette',async()=>{
  await page.click('[data-preset="glass"]');
  await expect(page.locator('html')).toHaveAttribute('data-glass-renderer','liquid');
  await page.click('[data-material="solid"]');
  await expect(page.locator('html')).toHaveAttribute('data-glass-renderer','solid');
  await expect(page.locator('#liquid-glass-svg')).toHaveCount(0);
  expect((await effective()).accent).toBe('#5269b4');
  const style=await page.locator('#todayFocusCard').evaluate(el=>({background:getComputedStyle(el).backgroundColor,filter:getComputedStyle(el).backdropFilter}));
  expect(style.background).toBe('rgb(255, 255, 255)');expect(style.filter).toBe('none');
});
test('system theme responds to OS changes while explicit mode remains fixed',async()=>{
  await page.click('[data-theme-mode="system"]');
  await page.emulateMedia({colorScheme:'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>getTheme())).toBe('system');
  await page.click('[data-theme-mode="light"]');
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.emulateMedia({colorScheme:'light'});await page.emulateMedia({colorScheme:'dark'});
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});
test('color backgrounds are applied and bright accents receive a readable foreground',async()=>{
  await page.click('[data-bgtype="color"]');
  await page.locator('#bgColorPicker').evaluate(el=>{el.value='#123456';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect.poll(()=>page.locator('.app-bg-layer').evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(18, 52, 86)');
  await page.locator('#accentCustomPicker').evaluate(el=>{el.value='#ffff00';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect.poll(()=>page.locator('.ap-preview-action').evaluate(el=>getComputedStyle(el).color)).toBe('rgb(16, 23, 37)');
});
test('reduced motion and mobile automatic quality disable refraction and pointer animation',async()=>{
  await page.click('[data-preset="glass"]');
  await expect(page.locator('html')).toHaveAttribute('data-glass-renderer','liquid');
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('html')).toHaveAttribute('data-glass-renderer','frosted');
  await expect(page.locator('html')).toHaveAttribute('data-glass-motion','false');
  await expect(page.locator('#liquid-glass-svg')).toHaveCount(0);
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('html')).toHaveAttribute('data-glass-renderer','frosted');
  expect(await page.locator('.appearance-studio').evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
});
test('saved presets preserve gradient direction, material and both mode palettes',async()=>{
  await page.click('[data-preset="sunset"]');await page.click('[data-material="frosted"]');
  await editRange('bgAngleSlider',217);await editRange('glassBlurSlider',23);
  const id=await page.evaluate(()=>saveAppearancePreset('测试外观'));
  await page.evaluate(()=>applyPreset('default'));
  await page.evaluate(id=>applyPreset(id),id);
  expect((await effective()).bgAngle).toBe(217);expect((await effective()).glassBlur).toBe(23);
  expect((await effective()).material).toBe('frosted');
  await page.evaluate(()=>applyTheme('dark'));
  expect((await effective()).accent).toBe('#efab87');
  await page.evaluate(()=>applyPreset('forest'));
  expect((await effective()).material).toBe('frosted');
});
test('each uploaded background retains its own persistent asset across reloads',async()=>{
  const result=await page.evaluate(async()=>{
    const make=async color=>{
      const canvas=document.createElement('canvas');canvas.width=canvas.height=8;
      const c=canvas.getContext('2d');c.fillStyle=color;c.fillRect(0,0,8,8);
      return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    };
    const first=await BgMediaIDB.saveAsset(await make('#ff0000'),'image');
    const second=await BgMediaIDB.saveAsset(await make('#00ff00'),'image');
    saveCustomTheme(ThemeModel.patch(loadCustomTheme(),{bgType:'image',bgImage:first.url}));
    return {first,second};
  });
  expect(result.first.url).not.toBe(result.second.url);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-today'));
  await expect.poll(()=>page.locator('.app-bg-layer').evaluate(el=>getComputedStyle(el).backgroundImage)).toContain('blob:');
  const colors=await page.evaluate(async ({first,second})=>{
    const sample=async ref=>{
      const url=await BgMediaIDB.resolveAsset(ref);
      const image=new Image();image.src=url;await image.decode();
      const c=document.createElement('canvas');c.width=c.height=8;
      const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
      return [...ctx.getImageData(0,0,1,1).data].slice(0,3);
    };
    return [await sample(first.url),await sample(second.url)];
  },result);
  expect(colors).toEqual([[255,0,0],[0,255,0]]);
});
test('video source is stable while changing glass parameters',async()=>{
  const bytes=[...await fs.readFile(path.join(__dirname,'..','fixtures','appearance.webm'))];
  await page.evaluate(async bytes=>{
    const saved=await BgMediaIDB.saveAsset(new Blob([new Uint8Array(bytes)],{type:'video/webm'}),'video');
    updateAppearance({bgType:'video',bgVideo:saved.url,material:'liquid'},true);
  },bytes);
  await expect.poll(()=>page.locator('.app-bg-video').evaluate(el=>el.readyState)).toBeGreaterThanOrEqual(2);
  const initial=await page.locator('.app-bg-video').evaluate(el=>{
    window.__appearanceLoads=0;el.addEventListener('loadstart',()=>window.__appearanceLoads++);
    return el.getAttribute('src');
  });
  await editRange('glassBlurSlider',7);await editRange('glassOpacitySlider',40);await editRange('glassGlowSlider',84);
  await expect.poll(async()=>(await effective()).glassGlow).toBe(84);
  expect(await page.locator('.app-bg-video').getAttribute('src')).toBe(initial);
  expect(await page.evaluate(()=>window.__appearanceLoads)).toBe(0);
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect.poll(()=>page.locator('.app-bg-video').evaluate(el=>el.paused)).toBe(true);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-today'));
  await expect.poll(()=>page.locator('.app-bg-video').evaluate(el=>el.readyState)).toBeGreaterThanOrEqual(2);
});
test('unsupported video falls back to a visible background with an actionable message',async()=>{
  await page.evaluate(async()=>{
    const saved=await BgMediaIDB.saveAsset(new Blob(['invalid video'],{type:'video/webm'}),'video');
    updateAppearance({bgType:'video',bgVideo:saved.url},true);
  });
  await expect(page.locator('#appearanceStatus')).toContainText('无法加载或解码');
  await expect(page.locator('.app-bg-video')).not.toHaveClass(/active/);
  await expect(page.locator('.app-bg-layer')).toBeVisible();
});
test('pointer highlight controls persist independently of edge glow',async()=>{
  await page.click('[data-preset="glass"]');
  await editRange('glassGlowSlider',0);
  await editRange('glassPointerIntensitySlider',85);
  await editRange('glassPointerSizeSlider',360);
  const preview=page.locator('.appearance-preview-card');
  await preview.scrollIntoViewIfNeeded();await preview.hover();
  await expect.poll(()=>preview.evaluate(el=>el.style.getPropertyValue('--glass-pointer-active'))).toBe('1');
  expect(await preview.evaluate(el=>getComputedStyle(el).getPropertyValue('--glass-pointer-intensity').trim())).toBe('0.85');
  expect(await preview.evaluate(el=>getComputedStyle(el,'::before').backgroundImage)).toContain('360px');
  await page.locator('#glassMotion').uncheck();
  await expect.poll(()=>preview.evaluate(el=>el.style.getPropertyValue('--glass-pointer-active'))).toBe('');
  await page.reload();await page.waitForFunction(()=>document.querySelector('#nav-today'));
  const cfg=await effective();
  expect(cfg.glassPointerIntensity).toBe(85);expect(cfg.glassPointerSize).toBe(360);
  expect(cfg.glassGlow).toBe(0);expect(cfg.glassMotion).toBe(false);
});
test('appearance interactions produce no uncaught renderer errors',()=>{expect(errors).toEqual([]);});
