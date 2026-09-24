'use strict';
// 校验 index.html 的 js/css 版本号与 service-worker.js 预缓存列表是否一致
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2] || process.cwd();
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map(m => m[1]);
const pre = [...sw.matchAll(/'\.\/((?:js|css)\/[^']+)'/g)].map(m => m[1]);
const preByPath = new Map(pre.map(p => [p.split('?')[0], p]));
console.log('index.html 引用:', refs.length, '| SW 预缓存:', pre.length);
let bad = 0;
for (const ref of refs) {
  const swRef = preByPath.get(ref.split('?')[0]);
  if (!swRef) { console.log('  [SW 未预缓存] ' + ref); continue; }
  if (swRef !== ref) { console.log('  [版本不一致] html=' + ref + '  sw=' + swRef); bad++; }
}
const htmlPaths = new Set(refs.map(r => r.split('?')[0]));
for (const p of pre) if (!htmlPaths.has(p.split('?')[0])) console.log('  [SW 多余条目] ' + p);
console.log(bad === 0 ? '本次改动涉及的文件版本号一致 ✅' : '存在 ' + bad + ' 处版本不一致 ❌');
