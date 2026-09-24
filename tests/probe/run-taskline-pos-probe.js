// 诊断：任务线画布右键「添加任务」是否落在鼠标位置。
// 真实渲染进程 + 真实仓库文件；用真实 DOM 测量屏幕坐标，不走菜单点击（直接调用菜单动作调用的同一入口）。
//   node_modules/electron/dist/electron.exe tests/probe/run-taskline-pos-probe.js
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
const hardStop = setTimeout(() => { log('TIMEOUT: 探针超过 150s 未完成'); app.exit(2); }, 150000);

// 在页面里按 scenario 摆好画布，然后模拟「右键点 (screenX, screenY) → 添加任务」
const SCENARIOS = {
  '首任务-空章节': `(function () {
    var line = tlAddLine({ name: '定位探针A', type: 'quality' });
    tlRefreshAll();
    tlSwitchLine(line.id);
    window.__probeLineId = line.id;
    return { lineId: line.id, quests: tlGetQuests().filter(function (q) { return q.lineId === line.id; }).length };
  })()`,
  '有任务-全正坐标': `(function () {
    var line = tlAddLine({ name: '定位探针B', type: 'quality' });
    tlAddQuest({ lineId: line.id, title: '甲', status: 'active', pos: { x: 40, y: 40 } });
    tlAddQuest({ lineId: line.id, title: '乙', status: 'active', pos: { x: 420, y: 180 } });
    tlRefreshAll();
    tlSwitchLine(line.id);
    window.__probeLineId = line.id;
    return { lineId: line.id, quests: tlGetQuests().filter(function (q) { return q.lineId === line.id; }).length };
  })()`,
  '有任务-含负坐标': `(function () {
    var line = tlAddLine({ name: '定位探针C', type: 'quality' });
    tlAddQuest({ lineId: line.id, title: '甲', status: 'active', pos: { x: -120, y: -60 } });
    tlAddQuest({ lineId: line.id, title: '乙', status: 'active', pos: { x: 300, y: 160 } });
    tlRefreshAll();
    tlSwitchLine(line.id);
    window.__probeLineId = line.id;
    return { lineId: line.id, quests: tlGetQuests().filter(function (q) { return q.lineId === line.id; }).length };
  })()`
};

// 把「鼠标在画布 inner 内的屏幕点」换算成 canvasPos（与 tlShowGraphContextMenu 完全相同的公式），
// 调 tlOpenQuestForm 建任务，最后用 getBoundingClientRect 量它到底落在屏幕哪里。
function RUN(pointXRatio, pointYRatio, scale, panLeft, panTop) {
  return `(function () {
    var app2 = document.getElementById('tasklineApp');
    var wrap = document.getElementById('tlGraphWrap');
    var canvas = wrap ? wrap.querySelector('.tl-graph-canvas') : null;
    var inner = wrap ? wrap.querySelector('.tl-graph-inner') : null;
    // 空章节时画布整块被空状态替换：以任务线主区域为参照（用户看到的就是这块）
    var refEl = canvas || app2;
    if (!refEl) return { error: 'no 参照区域' };
    // 人为设置视图：缩放 + 平移
    tlGraphView.scale = ${scale};
    tlGraphView.left = ${panLeft};
    tlGraphView.top = ${panTop};
    tlApplyGraphView();
    var cRect = refEl.getBoundingClientRect();
    // 目标：参照区域内相对位置的一点（空章节时参照区 = 任务线主区域）
    var screenX = cRect.left + cRect.width * ${pointXRatio};
    var screenY = cRect.top + cRect.height * ${pointYRatio};
    // 走真实生产代码的换算入口（右键菜单里用的就是它）
    var canvasPos = tlScreenToCanvasPos(screenX, screenY);
    if (!canvasPos) {
      // 空章节：还没有画布（空状态），右键菜单也打不开。此时新任务只能落到自动布局位置，
      // 这里如实记录真实落点，便于判断是否需要额外的产品处理。
      var lineId0 = window.__probeLineId;
      tlOpenQuestForm(lineId0, null);
      document.getElementById('tlQuestTitle').value = '落点检查';
      tlSubmitQuestForm(lineId0);
      var q0 = tlGetQuests().filter(function (x) { return x.title === '落点检查'; }).slice(-1)[0];
      var wrap3 = document.getElementById('tlGraphWrap');
      var node0 = wrap3 ? document.querySelector('.tl-node[data-qid="' + q0.id + '"]') : null;
      return {
        note: '空章节没有画布（空状态），右键菜单不可用；此处记录「无位置」时任务落在哪',
        canvasAvailable: false,
        questPos: q0.pos || null,
        renderedAt: node0 ? { x: Math.round(node0.getBoundingClientRect().left), y: Math.round(node0.getBoundingClientRect().top) } : null,
        want: { x: Math.round(screenX), y: Math.round(screenY) }
      };
    }
    var lineId = window.__probeLineId;
    tlOpenQuestForm(lineId, canvasPos);
    document.getElementById('tlQuestTitle').value = '落点检查';
    tlSubmitQuestForm(lineId);
    var q = tlGetQuests().filter(function (x) { return x.title === '落点检查'; }).slice(-1)[0];
    var node = document.querySelector('.tl-node[data-qid="' + q.id + '"]');
    if (!node) return { error: '新任务节点未渲染', questPos: q.pos };
    var nRect = node.getBoundingClientRect();
    var wrap2 = document.getElementById('tlGraphWrap');
    var inner2 = wrap2 ? wrap2.querySelector('.tl-graph-inner') : null;
    var nodesEl = inner2 ? inner2.querySelector('.tl-graph-nodes') : null;
    var iRect2 = inner2 ? inner2.getBoundingClientRect() : { left: 0, top: 0 };
    var nodesRect = nodesEl ? nodesEl.getBoundingClientRect() : { left: 0, top: 0 };
    var s = tlGraphView.scale;
    var nodePosInCanvas = tlNodeClientToQuestPos(node, 0);
    return {
      questPos: q.pos,
      canvasPos: { x: Math.round(canvasPos.x), y: Math.round(canvasPos.y) },
      // 不变量：节点在画布中的布局位置 = 换算得到的落点坐标（两个换算入口语义一致）
      posMatchesCanvas: nodePosInCanvas.x === Math.round(canvasPos.x) && nodePosInCanvas.y === Math.round(canvasPos.y),
      // 鼠标点在屏幕上的位置
      want: { x: Math.round(screenX), y: Math.round(screenY) },
      // 新节点实际左上角在屏幕上的位置
      got: { x: Math.round(nRect.left), y: Math.round(nRect.top) },
      // 差值：节点左上角应正好落在鼠标点（误差来自节点宽度量化/整数取整）
      delta: { x: Math.round(nRect.left - screenX), y: Math.round(nRect.top - screenY) },
      view: { scale: s, left: tlGraphView.left, top: tlGraphView.top },
      geometry: {
        innerLeft: Math.round(iRect2.left), innerTop: Math.round(iRect2.top),
        nodesLeft: Math.round(nodesRect.left), nodesTop: Math.round(nodesRect.top),
        nodesShift: nodesEl ? (nodesEl.style.left + ',' + nodesEl.style.top) : null,
        nodeInNodesLeft: node.offsetLeft, nodeInNodesTop: node.offsetTop,
        TL_PAD: TL_PAD,
        nodeW: Math.round(nRect.width), nodeH: Math.round(nRect.height)
      }
    };
  })()`;
}

// 真实右键路径：在画布上派发 contextmenu → 点菜单里的「添加任务」→ 填标题 → 提交
function RUN_CONTEXT_MENU(pointXRatio, pointYRatio, scale, panLeft, panTop) {
  return `(function () {
    var wrap = document.getElementById('tlGraphWrap');
    if (!wrap) return { error: 'no wrap' };
    var canvas = wrap.querySelector('.tl-graph-canvas');
    if (!canvas) return { error: 'no canvas' };
    tlGraphView.scale = ${scale};
    tlGraphView.left = ${panLeft};
    tlGraphView.top = ${panTop};
    tlApplyGraphView();
    var cRect = canvas.getBoundingClientRect();
    var screenX = cRect.left + cRect.width * ${pointXRatio};
    var screenY = cRect.top + cRect.height * ${pointYRatio};
    // 真实右键：tl-graph-wrap 上有 inline oncontextmenu
    var ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: screenX, clientY: screenY, button: 2 });
    wrap.dispatchEvent(ev);
    var menu = document.getElementById('tlTaskContextMenu');
    var menuVisible = !!(menu && menu.classList.contains('visible'));
    // 菜单项是 <div class="context-menu-item"><i>…</i> 添加任务</div>
    var addItem = menu ? Array.prototype.find.call(menu.querySelectorAll('.context-menu-item'), function (el) { return el.textContent.trim() === '添加任务'; }) : null;
    if (!addItem) {
      return {
        error: '菜单里没找到「添加任务」项',
        menuVisible: menuVisible,
        ctxPos: tlGraphCtxPos,
        items: menu ? Array.prototype.map.call(menu.querySelectorAll('.context-menu-item'), function (el) { return JSON.stringify(el.textContent.trim()); }) : null
      };
    }
    addItem.click(); // tlCtxAddQuest → tlOpenQuestForm(lineId, tlGraphCtxPos)
    document.getElementById('tlQuestTitle').value = '右键落点';
    var lineId = window.__probeLineId;
    tlSubmitQuestForm(lineId);
    var q = tlGetQuests().filter(function (x) { return x.title === '右键落点'; }).slice(-1)[0];
    var node = document.querySelector('.tl-node[data-qid="' + q.id + '"]');
    if (!node) return { error: '节点未渲染', questPos: q.pos };
    var nRect = node.getBoundingClientRect();
    return {
      menuWasVisible: menuVisible,
      questPos: q.pos,
      want: { x: Math.round(screenX), y: Math.round(screenY) },
      got: { x: Math.round(nRect.left), y: Math.round(nRect.top) },
      delta: { x: Math.round(nRect.left - screenX), y: Math.round(nRect.top - screenY) }
    };
  })()`;
}

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
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(req.url.split('?')[0]);
      const fp = path.join(repoRoot, pathname === '/' ? '/index.html' : pathname);
      if (!path.resolve(fp).startsWith(path.resolve(repoRoot)) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); return res.end('not found: ' + pathname);
      }
      res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(fp).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origin = 'http://127.0.0.1:' + server.address().port;

    win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
    await win.loadURL(origin + '/index.html');
    await new Promise(r => setTimeout(r, 1500));
    await win.webContents.executeJavaScript(`(function () {
      localStorage.removeItem('study_taskline_v1');
      if (typeof Sync !== 'undefined' && Sync.onLocalChange) { /* noop */ }
      switchTab('taskline');
      return true;
    })()`);
    await new Promise(r => setTimeout(r, 400));

    const cases = [
      ['首任务-空章节', 0.5, 0.5, 1, 0, 0],
      ['有任务-全正坐标', 0.5, 0.5, 1, 0, 0],
      ['有任务-全正坐标', 0.35, 0.7, 1, 0, 0],
      ['有任务-含负坐标', 0.5, 0.5, 1, 0, 0],
      ['有任务-全正坐标', 0.5, 0.5, 1.5, 0, 0],
      ['有任务-全正坐标', 0.5, 0.5, 1, -220, -120]
    ];
    for (const [scenario, rx, ry, scale, panL, panT] of cases) {
      log('=== 场景：' + scenario + ' 缩放 ' + scale + ' 平移 ' + panL + ',' + panT + ' 点击(' + rx + ',' + ry + ') ===');
      log('  准备: ' + JSON.stringify(await win.webContents.executeJavaScript(SCENARIOS[scenario])));
      await new Promise(r => setTimeout(r, 500));
      const out = await win.webContents.executeJavaScript(RUN(rx, ry, scale, panL, panT));
      log('  ' + JSON.stringify(out));
    }

    // 真实右键菜单路径（含菜单点击，端到端）
    for (const [scenario, rx, ry, scale, panL, panT] of [
      ['有任务-全正坐标', 0.55, 0.45, 1, 0, 0],
      ['有任务-含负坐标', 0.45, 0.6, 1, 0, 0],
      ['有任务-全正坐标', 0.5, 0.5, 1.25, -80, -40]
    ]) {
      log('=== 右键菜单路径：' + scenario + ' 缩放 ' + scale + ' 平移 ' + panL + ',' + panT + ' ===');
      log('  准备: ' + JSON.stringify(await win.webContents.executeJavaScript(SCENARIOS[scenario])));
      await new Promise(r => setTimeout(r, 500));
      log('  ' + JSON.stringify(await win.webContents.executeJavaScript(RUN_CONTEXT_MENU(rx, ry, scale, panL, panT))));
    }

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
