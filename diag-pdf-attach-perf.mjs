// 诊断：AI 附件 PDF 路径的真实耗时分布（文本提取模式）
// 目的：定位"只发几页却很慢"的开销到底在 读取文件 / 打开文档 / 解析页数 / 选页提取 的哪一步。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

const ms = (t0) => Math.round(performance.now() - t0);
const PDF_TEXT_MAX_CHARS = 80000;

function readFileAsArrayBuffer(file) {
  const fd = readFileSync(file);
  return fd.buffer.slice(fd.byteOffset, fd.byteOffset + fd.byteLength);
}

// 与 openPdfAttachment 完全一致的打开方式（多传一个 file 兼容 opts）
async function openPdf(file) {
  const buffer = readFileAsArrayBuffer(file);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
  return { pdf: await loadingTask.promise, bytes: buffer.byteLength };
}

// 复刻 extractPdfAttachmentText，但记录每页耗时
async function extract(file, startPage, endPage, maxChars) {
  const tOpen = performance.now();
  const { pdf } = await openPdf(file);
  const tOpened = ms(tOpen);
  let chars = 0; let pages = 0; const pageTimes = [];
  const first = startPage || 1;
  const last = endPage || pdf.numPages;
  for (let p = first; p <= last; p++) {
    const t = performance.now();
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = (content.items || []).map(i => (i && i.str !== undefined ? i.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    if (p <= first + 4 || p % 100 === 0) pageTimes.push(`p${p}:${ms(t)}ms`);
    chars += text.length;
    pages++;
    if (chars >= maxChars) break;
  }
  const tTotal = ms(tOpen);
  try { await pdf.destroy(); } catch (e) {}
  return { tOpened, tTotal, pages, chars, pageTimes };
}

const targets = process.argv.slice(2);
const files = targets.length ? targets : [
  'D:/BaiduNetdiskDownload/Introduction to Algorithms, fourth edition.pdf',
  'D:/BaiduNetdiskDownload/离散数学及其应用 第8版 肯尼思 H 罗森 教材 英文版.pdf',
  'D:/BaiduNetdiskDownload/概率论基础教程第10版英文.pdf'
];

for (const f of files) {
  let sizeMB = 0;
  try { sizeMB = (statSync(f).size / 1048576).toFixed(1); } catch (e) { console.log(`跳过（不存在）：${f}`); continue; }
  console.log(`\n================ ${path.basename(f)} (${sizeMB} MB) ================`);

  const tRead = performance.now();
  readFileAsArrayBuffer(f);
  console.log(`[1] 读文件到 ArrayBuffer: ${ms(tRead)} ms`);

  const tOpenOnly = performance.now();
  const opened = await openPdf(f);
  console.log(`[2] pdf.js 打开文档（getDocument + promise）: ${ms(tOpenOnly)} ms  → 共 ${opened.pdf.numPages} 页`);
  try { await opened.pdf.destroy(); } catch (e) {}

  for (const [label, s, e] of [['仅第 3–8 页', 3, 8], ['第 1–10 页', 1, 10], ['留空=全书（到 8 万字符上限）', null, null]]) {
    const r = await extract(f, s, e, PDF_TEXT_MAX_CHARS);
    console.log(`[3] ${label}: 打开 ${r.tOpened} ms | 合计 ${r.tTotal} ms | 处理 ${r.pages} 页 / ${r.chars} 字符 | 样本 ${r.pageTimes.slice(0, 6).join(' ')}`);
  }
}
console.log('\n诊断完成');
