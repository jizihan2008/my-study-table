// 验证脚本 v3：直接加载真实的 js/books-pdf.js（(0,eval) 方式），调用真实 bkExtractCaptionsFromText
// 避免脚本内复制的算法与真实代码漂移。对 341/343/344/356 页验证。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// pdf.js 在 Node 下缺失的 DOM 类型 polyfill
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class {
    constructor(init) {
      if (init && init.length === 6) { this.a = init[0]; this.b = init[1]; this.c = init[2]; this.d = init[3]; this.e = init[4]; this.f = init[5]; }
      else { this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0; }
    }
  };
}
if (typeof globalThis.DOMPoint === 'undefined') {
  globalThis.DOMPoint = class { constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; } };
}

const pdfjs = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'pdfjs', 'pdf.min.mjs')).href);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(process.cwd(), 'lib', 'pdfjs', 'pdf.worker.min.mjs')).href;

// ===== 加载真实 books-pdf.js（(0,eval) 方式）=====
globalThis.window = globalThis;
globalThis.document = { baseURI: pathToFileURL(path.join(process.cwd(), 'index.html')).href };
globalThis.pdfjsLib = pdfjs;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.genId = () => 'test-id';
(0, eval)(readFileSync(path.join(process.cwd(), 'js', 'books-pdf.js'), 'utf8'));
const bkExtractCaptionsFromText = globalThis.bkExtractCaptionsFromText;
if (typeof bkExtractCaptionsFromText !== 'function') { console.error('加载真实函数失败'); process.exit(1); }
console.log('已加载真实 bkExtractCaptionsFromText');

// ===== 加载 PDF 并测试 =====
const pdfPath = 'D:/BaiduNetdiskDownload/Introduction to Algorithms, fourth edition.pdf';
const buf = readFileSync(pdfPath);
const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buf) });
const pdf = await loadingTask.promise;

for (const p of [341, 343, 344, 356]) {
  const page = await pdf.getPage(p);
  const tc = await page.getTextContent();
  const caps = bkExtractCaptionsFromText(tc.items);
  console.log(`\n===== 第 ${p} 页 =====`);
  if (!caps.length) { console.log('  无图注（不收集图片）'); continue; }
  for (const c of caps) {
    console.log(`  ✓ 保留  num=${c.num}`);
    console.log(`      text: ${c.text.slice(0, 140)}`);
  }
}

await loadingTask.destroy();
console.log('\n验证完成');
