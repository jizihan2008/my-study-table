'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const model=require('../js/theme-model');

test('legacy glass settings migrate before defaults obscure deprecated refraction',()=>{
  const cfg=model.normalize({preset:'custom',glass:true,glassRefract:72,glassOpacity:80});
  assert.equal(cfg.version,2);assert.equal(cfg.material,'liquid');
  assert.equal(cfg.glassCurve,72);assert.equal(cfg.glassGlow,72);
  assert.equal(model.resolve(cfg,'light').glassOpacity,80);
  assert.deepEqual(model.normalize(cfg),cfg);
});
test('material edits preserve preset palette across light and dark modes',()=>{
  const cfg=model.patch({...model.defaults(),preset:'forest'},{material:'liquid',glassBlur:24});
  const light=model.resolve(cfg,'light'),dark=model.resolve(cfg,'dark');
  assert.equal(light.accent,'#287e63');assert.equal(dark.accent,'#7cc9a4');
  assert.equal(light.glassBlur,24);assert.equal(dark.glassBlur,24);
  assert.equal(light.material,'liquid');assert.equal(cfg.preset,'forest');
});
test('turning off glass overrides a preset and does not change its background',()=>{
  const custom={saved:{name:'saved',light:{accent:'#123456',glass:true,material:'liquid',bg:'gradient',gFrom:'#123456',gTo:'#abcdef'}}};
  const cfg=model.patch({...model.defaults(),preset:'saved'},{material:'solid'});
  const eff=model.resolve(cfg,'light',custom);
  assert.equal(eff.glass,false);assert.equal(eff.bgType,'gradient');
  assert.equal(eff.bgFrom,'#123456');
});
test('custom background controls override preset values without losing other fields',()=>{
  const cfg=model.patch({...model.defaults(),preset:'sky'},{bgType:'color',bgColor:'#123abc'});
  const eff=model.resolve(cfg,'dark');
  assert.equal(eff.bgType,'color');assert.equal(eff.bgColor,'#123abc');
  assert.equal(eff.accent,'#87bafa');
});
test('saved preset round trip includes both gradient spellings and all materials',()=>{
  const cfg=model.patch({...model.defaults(),preset:'sunset'},{glassBlur:9,material:'frosted',bgAngle:215});
  const saved={saved:{light:model.snapshot(model.resolve(cfg,'light')),dark:model.snapshot(model.resolve(cfg,'dark'))}};
  for(const mode of ['light','dark']){
    const expected=model.resolve(cfg,mode);
    const actual=model.resolve({...model.defaults(),preset:'saved'},mode,saved);
    for(const key of ['accent','bgType','bgAngle','bgFrom','bgTo','material','glassBlur'])assert.equal(actual[key],expected[key],key);
  }
  assert.equal(model.presetMode({light:{bg:'gradient',gAngle:45,gFrom:'#abc',gTo:'#def'}},'light').bgFrom,'#aabbcc');
});
test('configuration rejects CSS injection and clamps non-finite and extreme values',()=>{
  const cfg=model.patch(model.defaults(),{accent:'#fff; color:red',bgColor:'url(javascript:x)',glassBlur:Infinity,glassCurve:1000,bgOverlay:-1,glassDeflect:NaN});
  assert.equal(cfg.accent,model.DEFAULTS.accent);
  assert.equal(cfg.bgColor,model.DEFAULTS.bgColor);
  assert.equal(cfg.glassBlur,model.DEFAULTS.glassBlur);
  assert.equal(cfg.glassCurve,100);assert.equal(cfg.bgOverlay,0);
  assert.equal(cfg.glassDeflect,model.DEFAULTS.glassDeflect);
  assert.deepEqual(model.normalize([]),model.defaults());
});
test('media validation preserves local stable assets while rejecting executable schemes',()=>{
  for(const url of ['javascript:alert(1)','data:text/html;base64,abc','data:image/svg+xml;base64,abc','https://a\nb'])assert.equal(model.mediaUrl(url,'image'),'');
  for(const url of ['idb:asset_abc-123','file:///C:/Photos/test.png','https://example.com/image.png','blob:https://example.com/123'])assert.equal(model.mediaUrl(url,'image'),url);
});
test('user presets cannot replace built-in definitions',()=>{
  assert.equal(model.resolve({...model.defaults(),preset:'forest'},'light',{forest:{light:{accent:'#ff0000'}}}).accent,'#287e63');
});
test('accent foreground remains readable for bright and dark custom colors',()=>{
  assert.equal(model.contrastInk('#ffff00'),'#101725');
  assert.equal(model.contrastInk('#101010'),'#ffffff');
});
