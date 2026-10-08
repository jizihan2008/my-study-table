'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { _electron } = require('playwright');
const { extractionScript } = require('../../electron/web-reader');

test('real Chromium extraction preserves the live DOM and article structure', { timeout: 45000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: [path.join(__dirname, '../fixtures/web-reader-electron.cjs')], env, timeout: 20000 });
  try {
    await app.firstWindow();
    const html = `<html><head><title>测试标题</title><style>.contents{display:contents}.hide{display:none}</style></head><body><nav>导航噪声</nav><article><header><h1>文章标题</h1></header><div class="contents">容器内正文</div><div class="downloads">下载说明</div><p>${'有效正文'.repeat(40)}<a href="https://example.com/reference">引用来源</a></p><aside>补充说明</aside><form>表单说明</form><pre>line one\n  line two\n\nline four</pre><table><tr><th>项目</th><th>数量</th></tr><tr><td>书籍</td><td>3</td></tr></table><p class="hide">隐藏噪声</p><div class="ads">广告噪声</div></article></body></html>`;
    const result = await app.evaluate(async ({ BrowserWindow }, { html, script }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const before = await wc.executeJavaScript('document.documentElement.outerHTML');
      const data = await wc.executeJavaScriptInIsolatedWorld(999, [{ code: script }]);
      const after = await wc.executeJavaScript('document.documentElement.outerHTML');
      return { before, after, data };
    }, { html, script: extractionScript() });
    assert.equal(result.before, result.after);
    assert.equal(result.data.title, '测试标题');
    for (const text of ['# 文章标题', '容器内正文', '下载说明', '补充说明', '表单说明', '[引用来源](https://example.com/reference)', 'line one\n  line two\n\nline four', '| 项目 | 数量 |', '| 书籍 | 3 |']) assert.ok(result.data.text.includes(text), text);
    assert.doesNotMatch(result.data.text, /导航噪声|隐藏噪声|广告噪声/);
    assert.equal(result.data.links[0].url, 'https://example.com/reference');
    assert.equal(result.data.headings[0].level, 1);
    for (const [html, status] of [['<title>Sign in</title><form><input type="password">登录</form>', 'login_required'], ['<title>Just a moment...</title><p>Verify you are human</p>', 'challenge'], ['<title>如何实现验证码和登录功能</title><article><h1>验证码说明</h1><p>这里介绍 captcha 的实现。</p></article>', 'ok']]) {
      const data = await app.evaluate(async ({ BrowserWindow }, { html, script }) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents;
        await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        return wc.executeJavaScriptInIsolatedWorld(999, [{ code: script }]);
      }, { html, script: extractionScript() });
      assert.equal(data.status, status);
    }
  } finally { await app.close(); }
});
