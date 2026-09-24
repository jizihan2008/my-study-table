'use strict';

const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-perf-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile }
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderTodos === 'function' && typeof escapeHtml === 'function' && document.getElementById('todoTree'));
    const result = await page.evaluate(() => {
      const originalTodos = todos;
      const originalExpanded = expandedTodoIds;
      const originalRoot = currentTodoRoot;
      const originalHideDone = todoHideDone;
      const originalRecords = localStorage.getItem('study_timer_records');
      try {
        const sample = [];
        for (let root = 0; root < 30; root++) {
          const rootId = root * 21 + 1;
          sample.push({ id: rootId, text: `课程 ${root}`, parentId: null, done: false });
          for (let child = 1; child <= 20; child++) {
            sample.push({ id: rootId + child, text: `任务 ${root}-${child}`, parentId: rootId, done: child % 3 === 0 });
          }
        }
        const records = sample.map(todo => ({ todoId: todo.id, totalMs: 60000 }));
        todos = sample;
        expandedTodoIds = new Set(sample.filter(todo => todo.parentId === null).map(todo => todo.id));
        currentTodoRoot = null;
        todoHideDone = false;
        localStorage.setItem('study_timer_records', JSON.stringify(records));
        renderTodos();
        const durations = [];
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          renderTodos();
          durations.push(performance.now() - start);
        }
        durations.sort((a, b) => a - b);
        return { todos: sample.length, timerRecords: records.length, medianMs: Number(durations[2].toFixed(1)), durationsMs: durations.map(n => Number(n.toFixed(1))) };
      } finally {
        todos = originalTodos;
        expandedTodoIds = originalExpanded;
        currentTodoRoot = originalRoot;
        todoHideDone = originalHideDone;
        if (originalRecords === null) localStorage.removeItem('study_timer_records');
        else localStorage.setItem('study_timer_records', originalRecords);
        renderTodos();
      }
    });
    console.log(JSON.stringify(result));
  } finally {
    if (app) await app.close();
    const realProfile = await fs.realpath(profile);
    const realTemp = await fs.realpath(os.tmpdir());
    if (path.dirname(realProfile) !== realTemp || !path.basename(realProfile).startsWith('mst-perf-')) {
      throw new Error('Refusing to remove an unexpected benchmark profile path');
    }
    await fs.rm(realProfile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
