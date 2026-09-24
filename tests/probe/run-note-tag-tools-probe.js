// 诊断：在真实渲染进程里验证「AI 给笔记挂标签」的新接口。
// 走真实路径：validateAiToolCall → executeToolCallStructured（唯一入口，含事务与结果归一化）。
//   node_modules/electron/dist/electron.exe tests/probe/run-note-tag-tools-probe.js
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
const hardStop = setTimeout(() => { log('TIMEOUT: 探针超过 120s 未完成'); app.exit(2); }, 120000);

const SEED = `(async function () {
  var iso = function (d) { return new Date(Date.now() - d * 86400000).toISOString(); };
  var seeded = [
    { id: 9101, type: 'note', title: '动态规划基础', content: 'DP 的内容', summary: '', tags: [], keywords: [], parentId: null, createdAt: iso(10), updatedAt: iso(3), _reviewHistory: [iso(3)], _skipReview: false },
    { id: 9102, type: 'note', title: '背包 DP', content: '背包的内容', summary: '', tags: [], keywords: [], parentId: null, createdAt: iso(10), updatedAt: iso(1), _reviewHistory: [iso(1)], _skipReview: false },
    { id: 9103, type: 'folder', title: '算法', tags: [], keywords: [], parentId: null }
  ];
  var raw = JSON.stringify(seeded);
  localStorage.clear();
  localStorage.setItem('study_notes_v2', raw);
  await window.StudyData.initialize();
  await window.StudyData.put('study_notes_v2', raw);
  window.__seedResult = { count: seeded.length };
})();`;

const VERIFY = `(async function () {
  var out = {};
  var notesIn = function () { return JSON.parse(JSON.stringify(notes)); };
  var find = function (id) { return notesIn().find(function (n) { return n.id === id; }); };

  // 1) tags 参数必须出现在下发给模型的原生工具 schema 里
  var schemas = {};
  ['update_note','add_note','batch_set_note_tags'].forEach(function (name) {
    var s = getAiToolJsonSchema(name);
    schemas[name] = s && s.properties ? Object.keys(s.properties) : null;
  });
  out.schemas = schemas;
  out.modelToolSpec = buildNativeAiTools(['update_note','batch_set_note_tags']).map(function (t) {
    return t.function.name + ':' + Object.keys(t.function.parameters.properties).join('/');
  });

  // 2) 未知参数拦截仍然有效（防止 AI 乱传字段）
  out.unknownParamRejected = validateAiToolCall('update_note', { id: 9101, tagList: 'x' }).ok === false;

  // 3) 真实执行入口：单篇打标签
  var one = await executeToolCallStructured('update_note', { id: 9101, tags: '动态规划, 算法' });
  out.updateNote = { ok: one.ok, text: one.text };
  out.afterUpdate = find(9101).tags;

  // 4) 批量 replace
  var batch = await executeToolCallStructured('batch_set_note_tags', { ids: [9101, 9102], tags: '动态规划', mode: 'replace' });
  out.batchReplace = { ok: batch.ok, text: batch.text };
  out.afterReplace = [find(9101).tags, find(9102).tags];

  // 5) 批量 add + 跳过文件夹/不存在 ID
  var add = await executeToolCallStructured('batch_set_note_tags', { ids: [9102, 9103, 9999], tags: '重点', mode: 'add' });
  out.batchAdd = { ok: add.ok, text: add.text };
  out.afterAdd = find(9102).tags;

  // 6) 新建笔记直接带标签
  var created = await executeToolCallStructured('add_note', { title: '斜率优化', content: '内容', tags: '动态规划' });
  var newNote = notesIn().find(function (n) { return n.title === '斜率优化'; });
  out.addNote = { ok: created.ok, text: created.text, tags: newNote ? newNote.tags : null };

  // 7) 读回显
  out.detail = (await executeToolCallStructured('get_note_detail', { id: 9101 })).text.split('\\n').slice(0, 4);
  out.listLine = (await executeToolCallStructured('list_notes', {})).text.split('\\n').filter(function (l) { return l.indexOf('动态规划基础') !== -1; });

  // 8) 落盘 + 「今天」页标签筛选是否跟着可用
  out.persisted = JSON.parse(localStorage.getItem('study_notes_v2')).map(function (n) { return n.title + ':' + JSON.stringify(n.tags || []); });
  renderReviewCard();
  var select = document.getElementById('todayReviewTagFilter');
  out.todayFilter = {
    disabled: select.disabled,
    options: Array.prototype.map.call(select.options, function (o) { return o.value + '|' + o.textContent; }),
    rowDisplay: getComputedStyle(document.querySelector('.today-review-filter-row')).display,
    hintDisplay: getComputedStyle(document.getElementById('todayReviewFilterHint')).display,
    countText: document.getElementById('todayReviewCount').textContent
  };

  // 9) get_note_tags：全集 + 每个标签挂几篇
  var tagReport = await executeToolCallStructured('get_note_tags', {});
  out.getNoteTags = { ok: tagReport.ok, text: tagReport.text, meta: getAiToolMetadata('get_note_tags') };
  out.getNoteTagsFiltered = (await executeToolCallStructured('get_note_tags', { search: '动态', includeNotes: false })).text;
  out.getNoteTagsNoMatch = (await executeToolCallStructured('get_note_tags', { search: '不存在的标签' })).text;
  // 用户当前数据形态：所有笔记都没有标签
  var cleared = await executeToolCallStructured('batch_set_note_tags', { ids: [9101, 9102], tags: '' });
  out.clearAll = { ok: cleared.ok, text: cleared.text };
  out.getNoteTagsWhenEmpty = (await executeToolCallStructured('get_note_tags', {})).text;
  out.getNoteTagsSchema = Object.keys(getAiToolJsonSchema('get_note_tags').properties);
  out.nativeSpec = buildNativeAiTools(['get_note_tags']).map(function (t) { return t.function.name + ':' + Object.keys(t.function.parameters.properties).join('/'); })[0];

  // 10) 系统提示词快照里是否出现标签词表（只在 note 接口组开放时出现）
  var snapshotNoteConv = { id: 'probe-note', systemPrompt: '', _toolGroups: ['note'] };
  var snapshotNoNoteConv = { id: 'probe-nonote', systemPrompt: '', _toolGroups: ['todo'] };
  out.snapshotWithNoteGroup = buildToolsSystemPrompt(snapshotNoteConv, getEffectiveApiConfig())
    .split('\\n').filter(function (l) { return l.indexOf('🏷️') !== -1; });
  out.snapshotWithoutNoteGroup = buildToolsSystemPrompt(snapshotNoNoteConv, getEffectiveApiConfig())
    .split('\\n').filter(function (l) { return l.indexOf('🏷️') !== -1; });
  return out;
})()`;

app.whenReady().then(async () => {
  let win = null;
  try {
    fs.writeFileSync(LOG, '');
    log('electron ' + process.versions.electron + ' / chrome ' + process.versions.chrome);
    const repoRoot = path.resolve(__dirname, '..', '..');
    const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
    const aiToolsSrc = (indexHtml.match(/src="(js\/ai-tools\.js[^"]*)"/) || [])[1];
    if (!aiToolsSrc) throw new Error('index.html 里找不到 ai-tools.js 引用');
    log('ai-tools 引用: ' + aiToolsSrc);

    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
      '.webmanifest': 'application/manifest+json; charset=utf-8'
    };
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      if (pathname === '/__probe/bootstrap') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
          + '<script src="/js/secrets.js"></script><script src="/js/platform.js"></script>'
          + '<script src="/js/data-store.js"></script><script>' + SEED + '</script></body></html>');
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

    win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });

    await win.loadURL(origin + '/__probe/bootstrap');
    await new Promise(r => setTimeout(r, 700));
    log('seed: ' + JSON.stringify(await win.webContents.executeJavaScript('window.__seedResult')));
    await win.loadURL(origin + '/index.html');
    await new Promise(r => setTimeout(r, 1800));

    log('=== 真实工具路径验证 ===');
    log(JSON.stringify(await win.webContents.executeJavaScript(VERIFY), null, 2));
    log('renderer errors: ' + JSON.stringify(errors.filter(e => !/Security Warning|module script/.test(e))));
    log('DONE');
    clearTimeout(hardStop);
    app.exit(0);
  } catch (err) {
    log('probe 失败: ' + (err && err.stack || err));
    clearTimeout(hardStop);
    app.exit(1);
  }
});
