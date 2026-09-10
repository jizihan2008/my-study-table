'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let electronApp;
let page;
let userDataPath;

test.beforeAll(async () => {
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-markdown-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading' && !!window.StudyMarkdown && typeof window.formatMarkdownBase === 'function');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('browser renderer sanitizes hostile input and preserves rich markdown', async () => {
  const result = await page.evaluate(() => {
    const source = [
      '# 标题',
      '',
      '<svg><script>window.__markdownXss = true</script></svg>',
      '',
      '[危险](javascript:alert(1)) [安全](https://example.com)',
      '',
      '- [x] 完成',
      '',
      '| 左 | 空 |',
      '| :-- | --: |',
      '| 1 |  |',
      '',
      '$$x^2$$'
    ].join('\n');
    const host = document.createElement('div');
    host.innerHTML = window.StudyMarkdown.render(source, {
      transformHtml: html => html + '<span data-todo-id="42" role="button" tabindex="0" onclick="window.__markdownXss=true">受控扩展</span>'
    });
    document.body.appendChild(host);
    const safeLink = host.querySelector('a[href="https://example.com"]');
    const checkbox = host.querySelector('input[type="checkbox"]');
    const cells = host.querySelectorAll('tbody td');
    window.switchTab('todo');
    const todoInput = document.getElementById('todoInput');
    todoInput.value = 'Markdown 动作链接测试';
    window.addTodo();
    const savedTodo = window.loadData('study_todos_v2').find(item => item.text === 'Markdown 动作链接测试');
    const actionHost = document.createElement('div');
    actionHost.innerHTML = window.formatAiContent('[ID:' + savedTodo.id + ']');
    const todoAction = actionHost.querySelector('.ai-action-link');
    const output = {
      xss: window.__markdownXss === true,
      scripts: host.querySelectorAll('script, iframe, object, embed').length,
      dangerousHref: host.querySelector('a[href^="javascript:"]') !== null,
      inlineHandler: host.querySelector('[onclick]') !== null,
      todoData: host.querySelector('[data-todo-id]')?.getAttribute('data-todo-id') || null,
      aiTodoAction: todoAction ? {
        id: todoAction.getAttribute('data-todo-id'),
        onclick: todoAction.hasAttribute('onclick'),
        role: todoAction.getAttribute('role')
      } : null,
      safeLink: safeLink ? { target: safeLink.target, rel: safeLink.rel } : null,
      checkbox: checkbox ? { checked: checkbox.checked, disabled: checkbox.disabled } : null,
      cells: cells.length,
      emptyCell: cells[1] ? cells[1].textContent : null,
      alignments: Array.from(cells, cell => cell.style.textAlign),
      hasKatex: !!host.querySelector('.katex'),
      headingId: host.querySelector('h1')?.id || ''
    };
    host.remove();
    return output;
  });

  expect(result).toEqual({
    xss: false,
    scripts: 0,
    dangerousHref: false,
    inlineHandler: false,
    todoData: '42',
    aiTodoAction: { id: expect.any(String), onclick: false, role: 'button' },
    safeLink: { target: '_blank', rel: 'noopener noreferrer' },
    checkbox: { checked: true, disabled: true },
    cells: 2,
    emptyCell: '',
    alignments: ['left', 'right'],
    hasKatex: true,
    headingId: '标题'
  });
});

test('mindmap extension and syntax highlighting remain available', async () => {
  const result = await page.evaluate(() => {
    const mindmap = window.formatMarkdownBase('```mindmap\n根节点\n  子节点\n```');
    const code = window.formatMarkdownBase('```javascript\nconst answer = 42;\n```');
    return {
      mindmap,
      code
    };
  });
  expect(result.mindmap).toContain('bk-mindmap-wrap');
  expect(result.mindmap).toContain('子节点');
  expect(result.code).toContain('language-javascript');
  expect(result.code).toContain('hljs-keyword');
});

test('every advanced note toolbar action inserts renderable markdown', async () => {
  const result = await page.evaluate(() => {
    window.switchTab('notes');
    window.switchNoteView('edit');
    const textarea = document.getElementById('notesTextarea');
    const run = (type, value = '文字') => {
      textarea.value = value;
      textarea.selectionStart = 0;
      textarea.selectionEnd = value.length;
      window.formatText(type);
      return textarea.value;
    };
    return {
      buttonCount: document.querySelectorAll('#notesFormatToolbar .fmt-btn').length,
      strike: run('strikethrough'),
      codeblock: run('codeblock', 'const x = 1;'),
      link: run('link'),
      image: run('image'),
      ordered: run('ol'),
      quote: run('quote'),
      task: run('task'),
      table: run('table', ''),
      footnote: run('footnote', '')
    };
  });

  expect(result.buttonCount).toBe(16);
  expect(result.strike).toBe('~~文字~~');
  expect(result.codeblock).toBe('```\nconst x = 1;\n```');
  expect(result.link).toBe('[文字](https://example.com)');
  expect(result.image).toBe('![文字](https://example.com/image.png)');
  expect(result.ordered).toBe('1. 文字');
  expect(result.quote).toBe('> 文字');
  expect(result.task).toBe('- [ ] 文字');
  expect(result.table).toContain('| 列 1 | 列 2 |');
  expect(result.footnote).toContain('[^1]\n\n[^1]: 脚注内容');
});

test('formatted AI selections round-trip back to markdown without losing structure', async () => {
  const markdown = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = [
      '<h5>五级标题</h5>',
      '<p><del>删除</del> <a href="https://example.com">链接</a></p>',
      '<pre><code class="language-javascript">const x = `值`;</code></pre>',
      '<ul><li><input type="checkbox" checked disabled>完成</li></ul>',
      '<table><thead><tr><th>A|B</th></tr></thead><tbody><tr><td>值</td></tr></tbody></table>'
    ].join('');
    return Array.from(host.childNodes).map(window.nodeToMarkdown).join('').replace(/\n{3,}/g, '\n\n').trim();
  });

  expect(markdown).toContain('##### 五级标题');
  expect(markdown).toContain('~~删除~~ [链接](https://example.com)');
  expect(markdown).toContain('```javascript\nconst x = `值`;\n```');
  expect(markdown).toContain('- [x] 完成');
  expect(markdown).toContain('| A\\|B |');
});

test('note preview builds a hierarchical TOC and jumps to the selected heading', async () => {
  const initial = await page.evaluate(() => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = [
      '# 总览',
      '',
      ...Array.from({ length: 35 }, (_, index) => '总览内容第 ' + (index + 1) + ' 段。\n'),
      '## 第一部分',
      '',
      ...Array.from({ length: 35 }, (_, index) => '第一部分内容第 ' + (index + 1) + ' 段。\n'),
      '### 详细说明',
      '',
      ...Array.from({ length: 35 }, (_, index) => '详细说明内容第 ' + (index + 1) + ' 段。\n'),
      '',
      '## 第一部分'
    ].join('\n');
    window.switchNoteView('preview');
    const panel = document.getElementById('notesTocPanel');
    return {
      panelDisplay: getComputedStyle(panel).display,
      labels: Array.from(document.querySelectorAll('#notesTocList .notes-toc-item'), item => item.textContent),
      targets: Array.from(document.querySelectorAll('#notesTocList .notes-toc-item'), item => item.dataset.target),
      indents: Array.from(document.querySelectorAll('#notesTocList .notes-toc-item'), item => item.style.getPropertyValue('--toc-indent'))
    };
  });

  expect(initial.panelDisplay).toBe('flex');
  expect(initial.labels).toEqual(['总览', '第一部分', '详细说明', '第一部分']);
  expect(initial.targets).toEqual(['总览', '第一部分', '详细说明', '第一部分-1']);
  expect(initial.indents).toEqual(['0px', '12px', '24px', '12px']);

  const jumped = await page.evaluate(async () => {
    window.jumpToNoteHeading('详细说明');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const preview = document.getElementById('notesPreview');
    return {
      scrollTop: preview.scrollTop,
      clientHeight: preview.clientHeight,
      scrollHeight: preview.scrollHeight,
      activeTarget: document.querySelector('#notesTocList .notes-toc-item.active')?.dataset.target,
      previewTop: Math.round(preview.getBoundingClientRect().top),
      headingTops: window.getNotePreviewHeadings().map(heading => ({ id: heading.id, top: Math.round(heading.getBoundingClientRect().top) })),
      sectionClass: document.getElementById('section-notes').className,
      notesView: document.getElementById('section-notes').dataset.notesview,
      innerWidth: window.innerWidth
    };
  });
  console.log(JSON.stringify(jumped));
  expect(jumped.scrollTop).toBeGreaterThan(0);
  expect(jumped).toEqual(expect.objectContaining({ activeTarget: '详细说明' }));

  await page.locator('.notes-toc-close').click();
  await expect(page.locator('#notesTocPanel')).not.toHaveClass(/visible/);
  await page.locator('#notesTocToggleBtn').click();
  await expect(page.locator('#notesTocPanel')).toHaveClass(/visible/);
});
