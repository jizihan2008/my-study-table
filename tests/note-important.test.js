'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const StudyMarkdown = require('../js/markdown');
const markdownit = require('../lib/markdown/markdown-it.min.js');
const footnote = require('../lib/markdown/markdown-it-footnote.min.js');
const renderer = () => StudyMarkdown.createRenderer({ markdownit, footnote });

test('important labels are escaped text; inline bodies preserve formatting and code stays literal', () => {
  const md = renderer();
  const html = md.render('前文 =={易错点}这是**正文**== 后文\n\n`=={重点}代码==`\n\n=={<img src=x onerror=alert(1)>}安全==');
  assert.match(html, /前文 <span class="note-important note-important-inline">/);
  assert.match(html, /<strong>正文<\/strong>/);
  assert.match(html, /<code>==\{重点\}代码==<\/code>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(md.render('=={括号\\}标题}a\\=\\=b=='), /括号}标题/);
  assert.match(md.render('=={括号\\}标题}a\\=\\=b=='), /a==b/);
});

test('important blocks retain nested folds, lists, references and source lines in reading plans', () => {
  const md = renderer();
  const source = ':::important 易错点\n## 定义\n\n- [引用][r]\n\n:::fold 细节\n:::important 内层\n正文\n:::\n:::\n\n```text\n:::\n```\n:::\n\n[r]: https://example.com';
  const html = md.render(source);
  assert.equal((html.match(/note-important-block/g) || []).length, 2);
  assert.match(html, /<details class="note-fold">/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /<code class="language-text">:::/);
  const plan = md.createReadingPlan(source);
  assert.equal(plan.blocks.length, 1);
  assert.equal(plan.headings[0].textContent, '定义');
  assert.match(plan.renderBlock(0), /note-important-block/);
  assert.match(plan.renderFold(0), /内层/);
  assert.doesNotMatch(md.render(':::important 未闭合\n正文'), /note-important-block/);
});
