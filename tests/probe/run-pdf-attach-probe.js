// 诊断：在真实 Chromium（Electron 渲染进程）里验证 AI 附件「页面图片」模式——
// 既量耗时（逐页渲染/编码/取消），也验证真实 UI 徽标（进度、体积、取消文案），
// 以及真实 sendAiMessage 是否把渲染出的页面带进了消息。
// 页面必须走 http（ES module 在 file:// 下会被 CORS 拦住），脚本自带同源小服务，
// 同时提供仓库文件和大 PDF：
//   node_modules/electron/dist/electron.exe tests/probe/run-pdf-attach-probe.js
// 依赖 D:/BaiduNetdiskDownload 下的教材 PDF，缺失时对应条目会被跳过。
'use strict';
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const LOG = path.resolve(__dirname, 'probe-output.txt');
function log(line) {
  const text = String(line);
  try { fs.appendFileSync(LOG, text + '\n'); } catch (e) {}
  try { process.stdout.write(text + '\n'); } catch (e) {}
}

const PDF_DIR = 'D:/BaiduNetdiskDownload';

const hardStop = setTimeout(() => { log('TIMEOUT: 探针超过 300s 未完成'); app.exit(2); }, 300000);

app.whenReady().then(async () => {
  let win = null;
  try {
    fs.writeFileSync(LOG, '');
    log('electron ' + process.versions.electron + ' / chrome ' + process.versions.chrome);

    // 一个同源服务同时提供探针页面（仓库文件）和大 PDF，彻底避开 CORS。
    const repoRoot = path.resolve(__dirname, '..', '..');
    const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
    const pdfServer = http.createServer((req, res) => {
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (pathname.startsWith('/pdf/')) {
        const fp = path.join(PDF_DIR, pathname.slice(5));
        if (!path.resolve(fp).startsWith(path.resolve(PDF_DIR)) || !fs.existsSync(fp)) { log('pdf 404: ' + fp); res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return fs.createReadStream(fp).pipe(res);
      }
      const fp = path.join(repoRoot, pathname === '/' ? '/index.html' : pathname);
      if (!path.resolve(fp).startsWith(path.resolve(repoRoot)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found: ' + pathname); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    });
    await new Promise(r => pdfServer.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${pdfServer.address().port}`;
    const pdfBaseUrl = origin + '/pdf/';
    log('serving at ' + origin);

    win = new BrowserWindow({ show: false, width: 1400, height: 1000 });
    win.webContents.on('render-process-gone', (_e, d) => log('[renderer gone] ' + JSON.stringify(d)));
    const pageUrl = origin + '/tests/probe/pdf-attach-ui-probe.html';
    log('loading ' + pageUrl);
    await win.loadURL(pageUrl);
    log('loaded page');
    const ready = await win.webContents.executeJavaScript(
      'new Promise(r => { const t = setInterval(() => { if (window.__probeReady || (window.__probeErrors || []).length) { clearInterval(t); r({ ready: !!window.__probeReady, errors: window.__probeErrors || [] }); } }, 50); setTimeout(() => { clearInterval(t); r({ ready: false, errors: (window.__probeErrors || []).concat(["模块 8s 内未就绪"]) }); }, 8000); })'
    );
    log('ready=' + ready.ready + ' errors=' + JSON.stringify(ready.errors));
    if (!ready.ready) throw new Error('探针模块未就绪；见上方 errors');

    const mainPdf = pdfBaseUrl + encodeURIComponent('离散数学及其应用 第8版 肯尼思 H 罗森 教材 英文版.pdf');
    const raw = await win.webContents.executeJavaScript(`window.probeRawRender(${JSON.stringify(mainPdf)}, 3)`);
    log(`对照（不经 ai-attach 包装）: 打开 ${raw.openMs}ms | 每页 ${raw.perPage.map(p => `p${p.page}:${p.ms}ms@${p.w}x${p.h}`).join(' ')} | 合计 ${raw.totalMs}ms | destroy=${JSON.stringify(raw.destroyErr)}`);

    const render = await win.webContents.executeJavaScript(`window.probeRender(${JSON.stringify(mainPdf)}, 3)`);
    log(`真实渲染路径（3 页）: 进度回调 ${JSON.stringify(render.events)} | 墙钟 ${render.wallMs}ms（内部计时 ${render.internalMs}ms）| ` +
      `canvas 细节 ${JSON.stringify(render.canvasDetail)} | 落盘 ${render.renderedPages} 页 / ${Math.round(render.bytes / 1024)}KB | aborted=${render.aborted}`);

    const abort = await win.webContents.executeJavaScript(`window.probeAbort(${JSON.stringify(mainPdf)}, 2)`);
    log(`取消路径: aborted=${abort.aborted} 已渲染=${abort.renderedPages} 页码=${JSON.stringify(abort.pageNumbers)}`);

    const badge = await win.webContents.executeJavaScript(`window.probeBadge(${JSON.stringify(mainPdf)})`);
    log('debug: ' + JSON.stringify(badge.debug));
    log(`updater 直接调用: 之前存在=${badge.beforeUpdater} 之后存在=${badge.afterUpdater} wrap 含状态类=${badge.wrapHtmlAfterUpdater}`);
    log(`徽标可见=${badge.visible} 初始="${badge.before}"`);
    for (const s of badge.seen) log(`  实时徽标: ${s}`);
    log(`完成徽标="${badge.statusDone}" 颜色=${badge.doneColor} 有进度条=${badge.hasProgressBar} 取消文案=${badge.abortedMarkup}`);
    log(`空闲徽标: display=${badge.idleBadgeDisplay} 文本="${badge.idleBadgeText}"（应为 none / 空，不占位）`);

    const send = await win.webContents.executeJavaScript(`window.probeSend(${JSON.stringify(mainPdf)})`);
    if (send.error) {
      log('端到端发送失败: ' + send.error);
    } else {
      log(`端到端（真实 sendAiMessage）：预览可见=${send.previewVisible}`);
      for (const f of send.badgeFrames) log(`  徽标变化: ${f}`);
      log(`  最终徽标="${send.finalBadge}" 携带图片=${send.hasVisionFiles}(${send.visionCount}) 名称="${send.visionName}"`);
    }
    if (badge.errors && badge.errors.length) log('renderer errors: ' + JSON.stringify(badge.errors));

    clearTimeout(hardStop);
    log('DONE');
    app.exit(0);
  } catch (err) {
    log('probe 失败: ' + (err && err.stack || err));
    try {
      const errs = await win.webContents.executeJavaScript('window.__probeErrors || []');
      log('renderer errors: ' + JSON.stringify(errs, null, 2));
    } catch (e) {}
    clearTimeout(hardStop);
    app.exit(1);
  }
});
