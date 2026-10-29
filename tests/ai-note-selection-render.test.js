'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/ai-render.js'), 'utf8');
const ctx = vm.createContext({ escapeHtml: value => String(value).replace(/[&<>"']/g,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]) });
vm.runInContext(source.slice(0, source.indexOf('let _aiForceScrollBottom')), ctx);
const render = ctx.renderAiNoteSelectionMessage;
const location = '选区无法可靠映射到 Markdown 原文，offset 未确定；请根据以下选中文字和上下文定位。';
function prompt(body, asking = false, title = '测试') {
  return `${asking ? '请结合下面的选中内容及上下文回答我的问题' : '请解释下面这段内容'}，它出自笔记「${title}」（笔记ID：123）。\n${location}\n\n${body}`;
}

test('selection cards handle missing offsets, multiline questions and escaped source text', () => {
  const html = render(prompt('<img src=x onerror=alert(1)>\n😀'.repeat(300), false, '<script>'));
  assert.ok(html.includes('请解释这段内容'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('<details class="ai-note-selection-details">'));
  assert.ok(html.includes('offset 未确定'));
  const asked = render(prompt('原文\n\n我的问题：\n第一行\n第二行', true));
  assert.ok(asked.includes('第一行\n第二行</div>'));
  assert.ok(asked.includes('>原文</blockquote>'));
});

test('normal messages and ambiguous generated prompts retain the ordinary rendering path', () => {
  for (const value of [null, [], '请解释这段内容', '普通问题\noffset=1']) assert.equal(render(value), '');
  const ambiguous = prompt('以下是选中内容及其上下文片段（⟪⟫ 内为需要解释的选中内容）：\n前⟪⟫选中⟪⟫冲突⟪⟫后');
  assert.equal(render(ambiguous), '');
  assert.equal(render(prompt('原文但没有问题', true)), '');
});
