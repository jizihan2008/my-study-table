// 诊断：「今天」页 待复习笔记 标签筛选两种场景的真实渲染结果。
// 场景 A：到期笔记全都没有标签（用户当前真实数据形态）→ 筛选行应可见但置灰 + 提示。
// 场景 B：到期笔记里既有带标签的也有无标签的 → 筛选行可用，选择后列表联动。
//   node_modules/electron/dist/electron.exe tests/probe/run-today-review-filter-probe.js
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
const hardStop = setTimeout(() => { log('TIMEOUT: 探针超过 180s 未完成'); app.exit(2); }, 180000);

// 种子脚本由主进程注入到 bootstrap 页，scenario 决定这轮种什么数据
function seedScript(scenario) {
  const tagged = scenario === 'tagged';
  const notes = [
    { id: 9001, title: '数学-导数', tags: tagged ? ['数学'] : [], content: '导数的定义', summary: '导数摘要', ago: 3 },
    { id: 9002, title: '英语-从句', tags: tagged ? ['英语'] : [], content: '定语从句', summary: '从句摘要', ago: 1 },
    { id: 9003, title: '无标签笔记', tags: [], content: '随便写点', summary: '', ago: 1 },
    { id: 9004, title: '未来才复习', tags: ['数学'], content: '还没到期', summary: '', ago: 0, noHistory: true }
  ];
  return `(async function () {
    var tagged = ${tagged};
    var models = ${JSON.stringify(notes)};
    var iso = function (d) { return new Date(Date.now() - d * 86400000).toISOString(); };
    var seeded = models.map(function (m) {
      return { id: m.id, type: 'note', title: m.title, content: m.content, summary: m.summary, tags: m.tags,
               keywords: [], parentId: null, createdAt: iso(10), updatedAt: iso(m.ago),
               _reviewHistory: m.noHistory ? [] : [iso(m.ago)], _skipReview: false };
    });
    var raw = JSON.stringify(seeded);
    localStorage.clear();
    localStorage.setItem('study_notes_v2', raw);
    await window.StudyData.initialize();
    await window.StudyData.put('study_notes_v2', raw);
    window.__seedResult = { scenario: tagged ? 'B-tagged' : 'A-untagged', count: seeded.length };
  })();`;
}

function bootstrapHtml(seed) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<script src="/js/secrets.js"></script>
<script src="/js/platform.js"></script>
<script src="/js/data-store.js"></script>
<script>${seed}</script>
</body></html>`;
}

const REPORT = `(function () {
  var row = document.querySelector('.today-review-filter-row');
  var select = document.getElementById('todayReviewTagFilter');
  var hint = document.getElementById('todayReviewFilterHint');
  var summary = getReviewSummary();
  return {
    totalDue: summary.totalDue,
    rowDisplay: row ? getComputedStyle(row).display : null,
    selectDisabled: select ? select.disabled : null,
    selectOptions: select ? Array.prototype.map.call(select.options, function (o) { return o.value + '|' + o.textContent; }) : null,
    selectValue: select ? select.value : null,
    hintDisplay: hint ? getComputedStyle(hint).display : null,
    hintText: hint ? hint.textContent : null,
    countText: document.getElementById('todayReviewCount').textContent,
    visibleTitles: Array.prototype.map.call(document.querySelectorAll('#todayReviewList .review-item-title'), function (e) { return e.textContent; })
  };
})()`;

const PICK = (value) => `(function () {
  var select = document.getElementById('todayReviewTagFilter');
  select.value = ${JSON.stringify(value)};
  select.dispatchEvent(new Event('change'));
  return {
    selectValue: select.value,
    stored: localStorage.getItem('study_today_review_tag_filter'),
    titles: Array.prototype.map.call(document.querySelectorAll('#todayReviewList .review-item-title'), function (e) { return e.textContent; }),
    countText: document.getElementById('todayReviewCount').textContent,
    requestStillEnabled: select.disabled
  };
})()`;

app.whenReady().then(async () => {
  let win = null;
  try {
    fs.writeFileSync(LOG, '');
    log('electron ' + process.versions.electron + ' / chrome ' + process.versions.chrome);
    const repoRoot = path.resolve(__dirname, '..', '..');
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
      '.webmanifest': 'application/manifest+json; charset=utf-8'
    };
    let scenario = 'untagged';
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (pathname === '/__probe/bootstrap') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(bootstrapHtml(seedScript(scenario)));
      }
      const fp = path.join(repoRoot, pathname === '/' ? '/index.html' : pathname);
      if (!path.resolve(fp).startsWith(path.resolve(repoRoot)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); return res.end('not found: ' + pathname);
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;
    log('serving ' + origin);

    win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });

    for (const s of ['untagged', 'tagged']) {
      scenario = s;
      await win.loadURL(origin + '/__probe/bootstrap');
      await new Promise(r => setTimeout(r, 700));
      log('--- 种子: ' + JSON.stringify(await win.webContents.executeJavaScript('window.__seedResult')));
      await win.loadURL(origin + '/index.html');
      await new Promise(r => setTimeout(r, 1800));
      log('=== 场景 ' + (s === 'untagged' ? 'A：到期笔记全无标签' : 'B：到期笔记含标签') + ' ===');
      log(JSON.stringify(await win.webContents.executeJavaScript(REPORT), null, 2));
      if (s === 'tagged') {
        for (const value of ['tag:数学', 'untagged', 'all']) {
          log('  → 选择 ' + value + ': ' + JSON.stringify(await win.webContents.executeJavaScript(PICK(value))));
        }
      }
    }

    log('renderer errors: ' + JSON.stringify(errors.filter(e => e.indexOf('Security Warning') === -1 && e.indexOf('module script') === -1)));
    log('DONE');
    clearTimeout(hardStop);
    app.exit(0);
  } catch (err) {
    log('probe 失败: ' + (err && err.stack || err));
    clearTimeout(hardStop);
    app.exit(1);
  }
});
