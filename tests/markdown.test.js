'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const StudyMarkdown = require('../js/markdown');
const markdownit = require('../lib/markdown/markdown-it.min.js');
const footnote = require('../lib/markdown/markdown-it-footnote.min.js');
const hljs = require('../lib/markdown/highlight.min.js');
const katex = require('../lib/katex/katex.min.js');

function createRenderer() {
  return StudyMarkdown.createRenderer({ markdownit, footnote, hljs, katex });
}

test('source maps are opt-in and retain absolute lines inside nested folds', () => {
  const renderer = createRenderer();
  const source = '# 顶部\n\n:::fold 外层\n前文\n\n:::fold 内层\n## 内部标题\n\n> 引用内容\n:::\n:::';
  assert.doesNotMatch(renderer.render(source), /data-source-line/);
  const html = renderer.render(source, { sourceMap: true });
  assert.match(html, /<h2 data-source-line="6" data-source-end="7"/);
  assert.match(html, /<p data-source-line="8" data-source-end="9">引用内容/);
  const plan = renderer.createReadingPlan(source);
  assert.match(plan.renderFold(1), /<h2 data-source-line="6" data-source-end="7"/);
});

test('shared markdown renderer covers CommonMark and GFM structures', () => {
  const html = createRenderer().render([
    '# 一级',
    '##### 五级',
    '',
    '***粗斜体***、~~删除~~、__下划线粗体__',
    '',
    '> 引用',
    '',
    '3. 三',
    '4. 四',
    '',
    '- 父级',
    '  - 子级',
    '',
    '- [ ] 未完成',
    '- [x] 已完成'
  ].join('\n'));

  assert.match(html, /<h1 id="一级">一级<\/h1>/);
  assert.match(html, /<h5 id="五级">五级<\/h5>/);
  assert.match(html, /<em><strong>粗斜体<\/strong><\/em>/);
  assert.match(html, /<s>删除<\/s>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<ul[^>]*>[\s\S]*<ul>/);
  assert.match(html, /class="markdown-task-list"/);
  assert.match(html, /type="checkbox" disabled checked/);
});

test('tables preserve empty cells and alignment while fenced code keeps its language', () => {
  const html = createRenderer().render([
    '| A |  | C |',
    '| :--- | ---: | :---: |',
    '| 1 |  | 3 |',
    '',
    '```c++',
    'int value = 1;',
    '```'
  ].join('\n'));

  assert.match(html, /<th style="text-align:right"><\/th>/);
  assert.match(html, /<td style="text-align:right"><\/td>/);
  assert.match(html, /class="language-c\+\+ hljs"/);
  assert.match(html, /hljs-type/);
  assert.doesNotMatch(html, />\+\+\nint/);
});

test('links, images, references, heading anchors and footnotes are rendered safely', () => {
  const renderer = createRenderer();
  const html = renderer.render([
    '## 重复',
    '## 重复',
    '',
    '[官网][site] ![图](https://example.com/a.png)',
    '',
    '[site]: https://example.com "官网"',
    '',
    '脚注[^note]',
    '',
    '[^note]: 说明'
  ].join('\n'));

  assert.match(html, /id="重复"/);
  assert.match(html, /id="重复-1"/);
  assert.match(html, /href="https:\/\/example\.com"[^>]*data-markdown-external="true"/);
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png"[^>]*referrerpolicy="no-referrer">/);
  assert.match(html, /class="footnotes"/);
  assert.match(html, /href="#fn-md\d+-1"/);
  const anotherFootnote = renderer.render('另一个[^1]\n\n[^1]: 内容');
  assert.notEqual(/id="(fn-md\d+-1)"/.exec(html)?.[1], /id="(fn-md\d+-1)"/.exec(anotherFootnote)?.[1]);
  assert.equal(StudyMarkdown.isSafeUrl('javascript:alert(1)', 'link'), false);
  assert.equal(StudyMarkdown.isSafeUrl('file:///C:/secret.txt', 'image'), false);
});

test('math parsing skips code and no longer uses collidable placeholders', () => {
  const html = createRenderer().render([
    '`$not_math$` and $x^2$',
    '',
    '```text',
    '%%MATH_INLINE_0%% and $still_not_math$',
    '```',
    '',
    '$$\\frac{1}{2}$$'
  ].join('\n'));

  assert.match(html, /<code>\$not_math\$<\/code>/);
  assert.match(html, /annotation encoding="application\/x-tex">x\^2<\/annotation>/);
  assert.match(html, /%%MATH_INLINE_0%% and \$still_not_math\$/);
  assert.match(html, /markdown-math-display/);
  assert.match(html, /\\frac\{1\}\{2\}/);
});

test('LaTeX correction restores missing matrix row slashes without damaging valid rows', () => {
  const damaged = String.raw`\boldsymbol{\beta}_1=\begin{pmatrix}a_{11}\a_{21}\\vdots\a_{m1}\end{pmatrix}`;
  const corrected = StudyMarkdown.normalizeLatex(damaged);
  assert.equal(
    corrected,
    String.raw`\boldsymbol{\beta}_1=\begin{pmatrix}a_{11}\\a_{21}\\\vdots\\a_{m1}\end{pmatrix}`
  );

  const valid = String.raw`\begin{pmatrix}a_{11}\\a_{21}\\\vdots\\a_{m1}\end{pmatrix}`;
  assert.equal(StudyMarkdown.normalizeLatex(valid), valid);

  const html = createRenderer().render('$$' + damaged + '$$');
  assert.doesNotMatch(html, /katex-error|color:#cc0000/);
  assert.match(html, /a_\{21\}/);
  assert.match(html, /\\vdots/);
});

test('raw HTML and dangerous URL schemes never become executable markup', () => {
  const html = createRenderer().render([
    '<img src=x onerror=alert(1)>',
    '',
    '[危险](javascript:alert(1))',
    '',
    '![本地](file:///C:/secret.png)'
  ].join('\n'));

  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /src="file:/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('collapsible note blocks render a title and Markdown body safely', () => {
  const renderer = createRenderer();
  const html = renderer.render([
    ':::fold **核心概念**',
    '这里是正文，包含 **重点**。',
    '',
    '- 第一项',
    '- 第二项',
    ':::'
  ].join('\n'));

  assert.match(html, /<details class="note-fold">/);
  assert.match(html, /<summary><strong>核心概念<\/strong><\/summary>/);
  assert.match(html, /class="note-fold-body"/);
  assert.match(html, /这里是正文，包含 <strong>重点<\/strong>/);
  assert.match(html, /<ul>[\s\S]*第一项[\s\S]*第二项/);

  const unsafeTitle = renderer.render(':::fold <img src=x onerror=alert(1)>\n正文\n:::');
  assert.doesNotMatch(unsafeTitle, /<img src=x/);
  assert.match(unsafeTitle, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('nested folds and fenced delimiter text do not terminate the outer fold', () => {
  const renderer = createRenderer();
  const source = [
    ':::fold Outer', 'Before', '', ':::fold Inner', 'Actual **body**', ':::', '',
    '```text', ':::', ':::fold This is code', '```', '', 'After', ':::'
  ].join('\n');
  const html = renderer.render(source);
  assert.equal((html.match(/<details class="note-fold">/g) || []).length, 2);
  assert.match(html, /<summary>Inner<\/summary>[\s\S]*Actual <strong>body<\/strong>/);
  assert.match(html, /<code class="language-text[^"]*">[\s\S]*:::fold This is code/);
  assert.match(html, /<p>After<\/p>\s*<\/div><\/details>/);
  const plan = renderer.createReadingPlan(source);
  assert.equal(plan.blocks.length, 1);
  assert.match(plan.renderFold(0), /data-lazy-fold="1"/);
  assert.match(plan.renderFold(1), /Actual <strong>body<\/strong>/);
});
