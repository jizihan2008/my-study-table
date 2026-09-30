'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('@playwright/test');

test('sync DOM patches changed records while retaining drafts, listeners and unchanged nodes', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  } catch (error) {
    if (/Executable doesn't exist|distribution.*not found/.test(error.message)) {
      t.skip('Browser runtime unavailable');
      return;
    }
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<ul id="list"><li data-id="1"><span>one</span><input id="draft"></li><li data-id="2">two</li></ul>');
    await page.addScriptTag({ path: path.join(__dirname, '..', 'js', 'sync-dom.js') });
    const result = await page.evaluate(async () => {
      const list = document.getElementById('list');
      const first = list.children[0];
      const second = list.children[1];
      const draft = document.getElementById('draft');
      let clicks = 0;
      second.addEventListener('click', () => clicks++);
      draft.focus(); draft.value = '中文草稿'; draft.setSelectionRange(1, 3);
      let html = '<li data-id="1"><span>one</span><input id="draft"></li><li data-id="2">changed</li><li data-id="3">new</li>';
      const render = () => { list.innerHTML = html; };
      SyncDOM.run(render);
      second.click();
      const preserved = list.children[0] === first && list.children[1] === second && document.activeElement === draft && draft.value === '中文草稿' && draft.selectionStart === 1 && draft.selectionEnd === 3;
      const changed = second.textContent === 'changed' && list.children.length === 3 && clicks === 1;
      // 远端删除正在输入的条目，必须等失焦；补刷新读取最新状态。
      html = '<li data-id="2">changed</li><li data-id="3">new</li>';
      SyncDOM.run(render);
      const deletionDeferred = draft.isConnected && document.activeElement === draft;
      html = '<li data-id="2">saved after blur</li><li data-id="3">new</li>';
      draft.blur();
      await new Promise(resolve => setTimeout(resolve, 20));
      const deletionApplied = !draft.isConnected && list.children[0] === second && second.textContent === 'saved after blur';
      // 移动条目沿用原节点；异常后恢复原生 setter。
      html = '<li data-id="3">new</li><li data-id="2">saved after blur</li>';
      SyncDOM.run(render);
      const reordered = list.children[1] === second;
      const setter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set;
      try { SyncDOM.run(() => { throw new Error('test'); }); } catch {}
      return { preserved, changed, deletionDeferred, deletionApplied, reordered,
        restored: setter === Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML').set };
    });
    for (const [name, passed] of Object.entries(result)) assert.equal(passed, true, name);
  } finally { await browser.close(); }
});
