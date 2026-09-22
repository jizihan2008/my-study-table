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
    const unlabelledTree = window.formatMarkdownBase('```\n根节点\n  子节点\n```');
    const code = window.formatMarkdownBase('```javascript\nconst answer = 42;\n```');
    return {
      mindmap,
      unlabelledTree,
      code
    };
  });
  expect(result.mindmap).toContain('bk-mindmap-wrap');
  expect(result.mindmap).toContain('子节点');
  expect(result.unlabelledTree).not.toContain('bk-mindmap-wrap');
  expect(result.unlabelledTree).toContain('<pre><code>');
  expect(result.code).toContain('language-javascript');
  expect(result.code).toContain('hljs-keyword');
});

test('matrix rendering does not collide with mindmap detection', async () => {
  const result = await page.evaluate(() => {
    const render = source => {
      const host = document.createElement('div');
      host.innerHTML = window.formatMarkdownBase(source);
      return {
        math: host.querySelectorAll('.katex').length,
        mindmap: host.querySelectorAll('.bk-mindmap-wrap').length,
        code: host.querySelectorAll('pre code').length
      };
    };
    return {
      latex: render(String.raw`$$\begin{bmatrix}1 & 2 \\ 3 & 4\end{bmatrix}$$`),
      numericFence: render('```\n1  0\n  0  1\n```'),
      mindmap: render('```mindmap\n根节点\n  子节点\n```'),
      combined: render(String.raw`$$\begin{matrix}1 & 0 \\ 0 & 1\end{matrix}$$` + '\n\n```mindmap\n根节点\n  子节点\n```')
    };
  });
  expect(result).toEqual({
    latex: { math: 1, mindmap: 0, code: 0 },
    numericFence: { math: 0, mindmap: 0, code: 1 },
    mindmap: { math: 0, mindmap: 1, code: 0 },
    combined: { math: 1, mindmap: 1, code: 0 }
  });
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
      fold: run('fold', '折叠正文'),
      footnote: run('footnote', '')
    };
  });

  expect(result.buttonCount).toBe(17);
  expect(result.strike).toBe('~~文字~~');
  expect(result.codeblock).toBe('```\nconst x = 1;\n```');
  expect(result.link).toBe('[文字](https://example.com)');
  expect(result.image).toBe('![文字](https://example.com/image.png)');
  expect(result.ordered).toBe('1. 文字');
  expect(result.quote).toBe('> 文字');
  expect(result.task).toBe('- [ ] 文字');
  expect(result.table).toContain('| 列 1 | 列 2 |');
  expect(result.fold).toBe(':::fold 折叠标题\n折叠正文\n:::');
  expect(result.footnote).toContain('[^1]\n\n[^1]: 脚注内容');
});

test('collapsible note blocks fold in reading mode and round-trip through rich editing', async () => {
  const result = await page.evaluate(async () => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = ':::fold 复习提示\n正文包含 **重点知识**。\n\n- 要点一\n- 要点二\n:::';
    window.renderNotes();
    window.switchNoteView('preview');
    const previewFold = document.querySelector('#notesPreview details.note-fold');
    const collapsed = previewFold && !previewFold.open;
    const title = previewFold?.querySelector(':scope > summary')?.textContent;
    const hiddenBodyText = previewFold?.querySelector('.note-fold-body')?.textContent;
    previewFold.querySelector(':scope > summary').click();
    const expanded = previewFold.open;

    window.switchNoteView('rich');
    const richFold = document.querySelector('#notesRichEditor details.note-fold');
    richFold.open = true;
    richFold.querySelector(':scope > summary').textContent = '新的标题';
    richFold.querySelector('.note-fold-body p').appendChild(document.createTextNode(' 已编辑'));
    richFold.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' 已编辑' }));
    const markdown = window.RichNoteEditor.getMarkdown();

    window.RichNoteEditor.setMarkdown('', note.id);
    await window.RichNoteEditor.command('fold');
    const insertedFold = document.querySelector('#notesRichEditor details.note-fold');
    const insertedMarkdown = window.RichNoteEditor.getMarkdown();

    window.RichNoteEditor.setMarkdown('普通 **粗体**、*斜体*和[链接](https://example.com)', note.id);
    const formattedParagraph = document.querySelector('#notesRichEditor p');
    const range = document.createRange();
    range.selectNodeContents(formattedParagraph);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    await window.RichNoteEditor.command('fold');
    const formattedFold = document.querySelector('#notesRichEditor details.note-fold');
    const formattedMarkdown = window.RichNoteEditor.getMarkdown();
    const preservedFormatting = {
      bold: formattedFold?.querySelector('.note-fold-body strong')?.textContent,
      italic: formattedFold?.querySelector('.note-fold-body em')?.textContent,
      link: formattedFold?.querySelector('.note-fold-body a')?.getAttribute('href')
    };
    return { collapsed, expanded, title, hiddenBodyText, markdown, insertedOpen: insertedFold?.open, insertedMarkdown, formattedMarkdown, preservedFormatting };
  });

  expect(result.collapsed).toBe(true);
  expect(result.expanded).toBe(true);
  expect(result.title).toBe('复习提示');
  expect(result.hiddenBodyText).toContain('重点知识');
  expect(result.markdown).toContain(':::fold 新的标题');
  expect(result.markdown).toContain('**重点知识**');
  expect(result.markdown).toContain('已编辑');
  expect(result.markdown).toContain('- 要点一');
  expect(result.markdown).toContain(':::');
  expect(result.insertedOpen).toBe(true);
  expect(result.insertedMarkdown).toContain(':::fold 折叠标题');
  expect(result.insertedMarkdown).toContain('正文内容');
  expect(result.preservedFormatting).toEqual({ bold: '粗体', italic: '斜体', link: 'https://example.com' });
  expect(result.formattedMarkdown).toContain('普通 **粗体**、*斜体*和[链接](https://example.com)');
});

test('Ctrl+A in a rich-text fold selects only its title or body', async () => {
  const result = await page.evaluate(() => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = ':::fold 折叠标题\n折叠正文\n:::\n\n块外文字';
    window.renderNotes();
    window.switchNoteView('rich');
    const editor = document.getElementById('notesRichEditor');
    const fold = editor.querySelector('details.note-fold');
    fold.open = true;
    const selectAt = node => {
      const range = document.createRange();
      range.setStart(node, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
      editor.dispatchEvent(event);
      return { selected: selection.toString(), prevented: event.defaultPrevented };
    };
    return {
      title: selectAt(fold.querySelector('summary').firstChild),
      body: selectAt(fold.querySelector('.note-fold-body p').firstChild)
    };
  });

  expect(result.title).toEqual({ selected: '折叠标题', prevented: true });
  expect(result.body).toEqual({ selected: '折叠正文', prevented: true });
});

test('Ctrl+Enter at the end of a rich-text fold creates a line below the fold', async () => {
  const result = await page.evaluate(() => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = ':::fold 折叠标题\n折叠正文\n:::\n\n下面内容';
    window.renderNotes();
    window.switchNoteView('rich');
    const editor = document.getElementById('notesRichEditor');
    const fold = editor.querySelector('details.note-fold');
    fold.open = true;
    const bodyText = fold.querySelector('.note-fold-body p').firstChild;
    const range = document.createRange();
    range.setStart(bodyText, bodyText.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const event = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    const insertedLine = fold.nextElementSibling;
    const contentAfterLine = insertedLine?.nextElementSibling;
    return {
      prevented: event.defaultPrevented,
      insertedTag: insertedLine?.tagName,
      insertedEmpty: !(insertedLine?.textContent || '').trim(),
      belowText: contentAfterLine?.textContent,
      caretInsideInsertedLine: !!insertedLine && insertedLine.contains(selection.anchorNode)
    };
  });

  expect(result).toEqual({
    prevented: true,
    insertedTag: 'P',
    insertedEmpty: true,
    belowText: '下面内容',
    caretInsideInsertedLine: true
  });
});

test('each note remembers the open state of every fold across view changes', async () => {
  const result = await page.evaluate(async () => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = ':::fold 第一块\n第一段\n:::\n\n:::fold 第二块\n第二段\n:::';
    note._foldStates = {};
    window.renderNotes();
    window.switchNoteView('rich');
    let folds = document.querySelectorAll('#notesRichEditor details.note-fold');
    folds[0].open = true;
    folds[0].dispatchEvent(new Event('toggle'));
    await new Promise(resolve => setTimeout(resolve, 0));

    window.switchNoteView('preview');
    folds = document.querySelectorAll('#notesPreview details.note-fold');
    const previewStates = Array.from(folds, fold => fold.open);
    folds[1].open = true;
    folds[1].dispatchEvent(new Event('toggle'));
    await new Promise(resolve => setTimeout(resolve, 0));

    window.switchNoteView('rich');
    const richStates = Array.from(document.querySelectorAll('#notesRichEditor details.note-fold'), fold => fold.open);
    const saved = window.loadData('study_notes_v2').find(item => String(item.id) === String(note.id));
    return { previewStates, richStates, savedStates: saved?._foldStates };
  });

  expect(result.previewStates).toEqual([true, false]);
  expect(result.richStates).toEqual([true, true]);
  expect(result.savedStates).toEqual({ 0: true, 1: true });
});

test('rich note editor edits formatted content while preserving Markdown storage', async () => {
  const result = await page.evaluate(async () => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.title = '富文本测试';
    note.content = '# 标题\n\n这是 **粗体** 和 - [ ] 任务';
    window.renderNotes();
    window.switchNoteView('rich');
    const editor = document.getElementById('notesRichEditor');
    const paragraph = editor.querySelector('p');
    paragraph.appendChild(document.createTextNode('，可直接编辑'));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '，可直接编辑' }));
    await new Promise(resolve => setTimeout(resolve, 650));
    return {
      modeVisible: getComputedStyle(editor).display,
      sourceHidden: getComputedStyle(document.getElementById('notesTextarea')).display,
      hasHeading: !!editor.querySelector('h1'),
      hasBold: !!editor.querySelector('strong'),
      saved: window.getActiveNote().content,
      persisted: window.loadData('study_notes_v2').find(item => item.id === note.id)?.content || ''
    };
  });
  expect(result.modeVisible).toBe('block');
  expect(result.sourceHidden).toBe('none');
  expect(result.hasHeading).toBe(true);
  expect(result.hasBold).toBe(true);
  expect(result.saved).toContain('# 标题');
  expect(result.saved).toContain('**粗体**');
  expect(result.saved).toContain('可直接编辑');
  expect(result.persisted).toBe(result.saved);
});

test('note reading progress remains visible and updates in rich editing mode', async () => {
  const result = await page.evaluate(async () => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行笔记内容`).join('\n\n');
    window.switchNoteView('rich');
    const editor = document.getElementById('notesRichEditor');
    editor.style.height = '120px';
    editor.style.overflowY = 'auto';
    await new Promise(resolve => requestAnimationFrame(resolve));
    editor.scrollTop = Math.max(1, (editor.scrollHeight - editor.clientHeight) / 2);
    editor.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const progress = document.getElementById('notesReadingProgress');
    const richState = {
      visible: progress.classList.contains('visible'),
      hidden: progress.getAttribute('aria-hidden'),
      value: Number(progress.getAttribute('aria-valuenow'))
    };
    editor.style.height = '';
    editor.style.overflowY = '';
    window.switchNoteView('edit');
    return { richState, hiddenInSource: !progress.classList.contains('visible') };
  });

  expect(result.richState.visible).toBe(true);
  expect(result.richState.hidden).toBe('false');
  expect(result.richState.value).toBeGreaterThan(0);
  expect(result.hiddenInSource).toBe(true);
});

test('rich and source modes round-trip common structured Markdown', async () => {
  const result = await page.evaluate(() => {
    const note = window.getActiveNote();
    note.content = '## 章节\n\n- 项目 A\n- 项目 B\n\n> 引用\n\n```js\nconst n = 1;\n```';
    window.switchNoteView('rich');
    const richMarkdown = window.RichNoteEditor.getMarkdown();
    window.switchNoteView('edit');
    return {
      richMarkdown,
      source: document.getElementById('notesTextarea').value,
      richVisible: getComputedStyle(document.getElementById('notesRichEditor')).display
    };
  });
  expect(result.richMarkdown).toContain('## 章节');
  expect(result.richMarkdown).toContain('- 项目 A');
  expect(result.richMarkdown).toContain('> 引用');
  expect(result.richMarkdown).toContain('```js');
  expect(result.source).toBe(result.richMarkdown);
  expect(result.richVisible).toBe('none');
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

  await page.evaluate(() => {
    const preview = document.getElementById('notesPreview');
    const heading = window.getNotePreviewHeadings().find(item => item.id === '第一部分');
    preview.scrollTop = Math.max(0, heading.offsetTop - 12);
    preview.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.locator('#notesTocList .notes-toc-item.active').getAttribute('data-target')).toBe('第一部分');

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

test('immersive note editing fills the app window and reveals edge controls', async () => {
  await page.setViewportSize({ width: 1186, height: 720 });
  await page.evaluate(() => {
    window.switchTab('notes');
    window.switchNoteView('rich');
    window.setNotesImmersive(true);
  });

  const section = page.locator('#section-notes');
  await expect(section).toHaveClass(/notes-immersive/);
  const state = await page.evaluate(() => {
    const bounds = document.getElementById('section-notes').getBoundingClientRect();
    const display = selector => getComputedStyle(document.querySelector(selector)).display;
    return {
      bounds: [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round),
      editorVisible: display('#notesRichEditor') !== 'none',
      title: display('.notes-editor-header'),
      tags: display('#notesTagBar'),
      keywords: display('#notesKeywordsBar')
    };
  });
  expect(state).toEqual({
    bounds: [0, 0, 1186, 720],
    editorVisible: true,
    title: 'none',
    tags: 'none',
    keywords: 'none'
  });

  const toolbar = page.locator('#notesFormatToolbar');
  const footer = page.locator('#section-notes .notes-editor-footer');
  await page.mouse.move(500, 360);
  await expect(toolbar).toHaveCSS('visibility', 'hidden');
  await expect(footer).toHaveCSS('visibility', 'hidden');
  await page.mouse.move(500, 1);
  await expect(toolbar).toHaveCSS('visibility', 'visible');
  await page.mouse.move(500, 360);
  await expect(toolbar).toHaveCSS('visibility', 'hidden');
  await page.mouse.move(500, 719);
  await expect(footer).toHaveCSS('visibility', 'visible');

  await page.keyboard.press('Escape');
  await expect(section).not.toHaveClass(/notes-immersive/);
  await expect(page.locator('body')).not.toHaveClass(/notes-immersive/);
});

test('immersive split opens two independent notes for reading and editing', async () => {
  await page.setViewportSize({ width: 1186, height: 720 });
  const ids = await page.evaluate(() => {
    window.switchTab('notes');
    window.setNotesImmersive(false);
    window.setNotesImmersiveSplit(false);
    const left = window.getActiveNote();
    left.title = '分屏左侧笔记';
    left.content = '# 左侧内容\n\n保持不变';
    window.createNewNote();
    const right = window.getActiveNote();
    right.title = '分屏右侧笔记';
    right.content = '# 右侧内容\n\n可以**编辑**';
    window.selectNote(left.id);
    window.switchNoteView('rich');
    window.setNotesImmersive(true);
    window.setNotesImmersiveSplit(true);
    window.selectNotesSplitNote(right.id);
    return { leftId: left.id, rightId: right.id };
  });

  const section = page.locator('#section-notes');
  const pane = page.locator('#notesSplitPane');
  await expect(section).toHaveClass(/notes-split/);
  await expect(pane).toBeVisible();
  await expect(page.locator('#notesSplitPrimarySelect')).toHaveValue(String(ids.leftId));
  await expect(page.locator('#notesSplitSecondarySelect')).toHaveValue(String(ids.rightId));
  await expect(page.locator('#notesRichEditor')).toContainText('左侧内容');
  await expect(page.locator('#notesSplitPreview')).toContainText('右侧内容');

  const geometry = await page.evaluate(() => {
    const left = document.querySelector('.notes-document-workspace').getBoundingClientRect();
    const right = document.getElementById('notesSplitPane').getBoundingClientRect();
    return { leftX: Math.round(left.x), leftWidth: Math.round(left.width), rightX: Math.round(right.x), rightWidth: Math.round(right.width) };
  });
  expect(geometry.rightX).toBeGreaterThanOrEqual(geometry.leftX + geometry.leftWidth - 1);
  expect(Math.abs(geometry.leftWidth - geometry.rightWidth)).toBeLessThan(4);

  await page.locator('#notesSplitSecondaryEdit').click();
  const editor = page.locator('#notesSplitRichEditor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('h1')).toHaveText('右侧内容');
  await expect(editor.locator('strong')).toHaveText('编辑');
  await expect(editor).not.toContainText('# 右侧内容');
  await editor.evaluate(element => {
    element.innerHTML = '<h1>修改后的右侧</h1><p>只写入<strong>第二篇笔记</strong></p>';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
  });
  await expect(page.locator('#notesSplitStatus')).toHaveText('保存中…');
  await expect(page.locator('#notesSplitStatus')).toHaveText('已保存', { timeout: 1500 });

  const saved = await page.evaluate(({ leftId, rightId }) => ({
    activeId: window.getActiveNote().id,
    left: window.findNoteByLooseId(leftId).content,
    right: window.findNoteByLooseId(rightId).content
  }), ids);
  expect(String(saved.activeId)).toBe(String(ids.leftId));
  expect(saved.left).toContain('保持不变');
  expect(saved.left).not.toContain('只写入第二篇笔记');
  expect(saved.right).toContain('只写入**第二篇笔记**');
  expect(saved.right).toContain('**第二篇笔记**');

  await page.locator('#notesSplitSecondaryRead').click();
  await expect(page.locator('#notesSplitPreview')).toContainText('修改后的右侧');
  await page.locator('#notesImmersiveSplit').click();
  await expect(section).not.toHaveClass(/notes-split/);
  await expect(section).toHaveClass(/notes-immersive/);
  await expect(page.locator('#notesSplitPrimaryBar')).not.toBeVisible();
  await expect(page.locator('#notesSplitPane')).not.toBeVisible();
  await expect(page.locator('#notesSplitSecondarySelect')).not.toBeVisible();
  await expect(page.locator('#notesSplitSecondaryRead')).not.toBeVisible();
  await expect(page.locator('#notesSplitSecondaryEdit')).not.toBeVisible();
  await expect(page.locator('#notesSplitRichEditor')).not.toBeVisible();
  await page.keyboard.press('Escape');
});

test('reading and editing keep their mode in immersive view and expose the TOC', async () => {
  await page.setViewportSize({ width: 1186, height: 720 });
  const section = page.locator('#section-notes');
  const toc = page.locator('#notesTocPanel');
  const immersiveToc = page.locator('#notesImmersiveToc');

  await page.evaluate(() => {
    const note = window.getActiveNote();
    note.content = '# 沉浸阅读\n\n正文\n\n## 第二节\n\n内容';
    window.switchNoteView('preview');
    window.toggleNoteToc(true);
    window.setNotesImmersive(true);
  });
  await expect(section).toHaveAttribute('data-note-mode', 'preview');
  await expect(page.locator('#notesPreview')).toHaveClass(/active/);
  await expect(toc).toHaveClass(/visible/);
  await expect(immersiveToc).toBeVisible();

  await immersiveToc.click();
  await expect(toc).not.toHaveClass(/visible/);
  await immersiveToc.click();
  await expect(toc).toHaveClass(/visible/);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.switchNoteView('rich');
    window.setNotesImmersive(true);
  });
  await expect(section).toHaveAttribute('data-note-mode', 'rich');
  await expect(page.locator('#notesRichEditor')).toHaveClass(/active/);
  await expect(toc).toHaveClass(/visible/);
  await expect(immersiveToc).toBeVisible();
  await page.keyboard.press('Escape');
});

test('immersive display zoom changes reading and editing size without changing Markdown', async () => {
  await page.setViewportSize({ width: 1186, height: 720 });
  const original = await page.evaluate(() => {
    window.switchTab('notes');
    const note = window.getActiveNote();
    note.content = '# 缩放测试\n\n正文保持不变。';
    window.setNotesImmersiveZoom(100);
    window.switchNoteView('preview');
    window.setNotesImmersive(true);
    return note.content;
  });

  const zoom = page.locator('#notesImmersiveZoom');
  await expect(zoom).toBeVisible();
  await expect(page.locator('#notesImmersiveZoomValue')).toHaveText('100%');
  await zoom.getByRole('button', { name: '放大显示' }).click();
  await expect(page.locator('#notesImmersiveZoomValue')).toHaveText('110%');
  await expect(page.locator('#notesPreview')).toHaveCSS('font-size', '16.5px');

  const editState = await page.evaluate(() => {
    window.switchNoteView('rich');
    return {
      fontSize: getComputedStyle(document.getElementById('notesRichEditor')).fontSize,
      markdown: window.getActiveNote().content,
      storedZoom: localStorage.getItem('study_notes_immersive_zoom')
    };
  });
  expect(editState).toEqual({ fontSize: '16.5px', markdown: original, storedZoom: '110' });

  await page.keyboard.press('Control+0');
  await expect(page.locator('#notesImmersiveZoomValue')).toHaveText('100%');
  await expect(page.locator('#notesRichEditor')).toHaveCSS('font-size', '15px');
  expect(await page.evaluate(() => window.getActiveNote().content)).toBe(original);
  await page.keyboard.press('Escape');
});

test('an AI reply can be opened as an immersive, zoomable document with a TOC', async () => {
  const sourceState = await page.evaluate(() => {
    window.switchTab('ai');
    const firstSection = Array.from({ length: 45 }, (_, index) => '总览内容第 ' + (index + 1) + ' 段。').join('\n\n');
    const secondSection = Array.from({ length: 45 }, (_, index) => '详细内容第 ' + (index + 1) + ' 段。').join('\n\n');
    const markdown = '# 回答总览\n\n' + firstSection + '\n\n## 详细说明\n\n' + secondSection;
    const row = document.createElement('div');
    row.className = 'ai-chat-msg assistant';
    row.innerHTML = `
      <div class="ai-chat-msg-body">
        <div class="ai-chat-bubble">${window.formatAiContent(markdown)}</div>
        <button type="button" id="e2eAiImmersiveTrigger">沉浸查看</button>
      </div>`;
    document.getElementById('aiMessages').appendChild(row);
    const bubble = row.querySelector('.ai-chat-bubble');
    const before = bubble.innerHTML;
    window.openAiMessageImmersive(row.querySelector('#e2eAiImmersiveTrigger'));
    return { before, fontSize: getComputedStyle(bubble).fontSize };
  });

  const overlay = page.locator('#aiMessageImmersive');
  await expect(overlay).toBeVisible();
  await expect(page.locator('#aiMessageImmersiveArticle')).toContainText('总览内容第 1 段');
  await expect(page.locator('#aiMessageImmersiveTocList button')).toHaveCount(2);
  await expect(page.locator('#aiMessageImmersiveToc')).toBeVisible();
  await expect(page.locator('#aiMessageImmersiveTocList button.active')).toHaveText('回答总览');

  await page.evaluate(() => {
    const article = document.getElementById('aiMessageImmersiveArticle');
    const heading = document.getElementById('ai-message-immersive-heading-1');
    article.scrollTop = Math.max(0, heading.offsetTop - 24);
    article.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.locator('#aiMessageImmersiveTocList button.active').getAttribute('data-target')).toBe('ai-message-immersive-heading-1');

  await overlay.getByRole('button', { name: '放大' }).click();
  await expect(page.locator('#aiMessageImmersiveZoomValue')).toHaveText('110%');
  await expect(page.locator('#aiMessageImmersiveArticle')).toHaveCSS('font-size', '17.6px');
  const unchanged = await page.evaluate(() => {
    const bubble = document.querySelector('#e2eAiImmersiveTrigger').closest('.ai-chat-msg-body').querySelector('.ai-chat-bubble');
    return { html: bubble.innerHTML, fontSize: getComputedStyle(bubble).fontSize };
  });
  expect(unchanged).toEqual({ html: sourceState.before, fontSize: sourceState.fontSize });

  await page.locator('#aiMessageImmersiveTocToggle').click();
  await expect(page.locator('#aiMessageImmersiveToc')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveClass(/ai-message-immersive-open/);
});

test('note search, sorting, and compact metadata controls work together', async () => {
  await page.setViewportSize({ width: 1186, height: 720 });
  const fixture = await page.evaluate(() => {
    window.switchTab('notes');
    window.clearTagFilter();
    window.changeNotesSort('manual');
    window.handleNotesSearchInput('');

    const first = window.getActiveNote();
    first.title = 'Sort B · 量子旧笔记';
    first.content = '这里记录量子纠缠的课堂重点。';
    first.createdAt = '2024-01-01T00:00:00.000Z';
    first.updatedAt = '2024-02-01T00:00:00.000Z';

    window.createNewNote();
    const second = window.getActiveNote();
    second.title = 'Sort A · 最近编辑';
    second.content = '这是一篇与搜索词无关的普通笔记。';
    second.createdAt = '2024-03-01T00:00:00.000Z';
    second.updatedAt = '2024-04-01T00:00:00.000Z';

    const folder = window.createNoteFolder('课程资料');
    window.createNewNote(folder.id);
    const child = window.getActiveNote();
    child.title = '文件夹子项';
    child.content = '文件夹下的普通内容。';
    window.renderNotes();
    return { firstTitle: first.title, secondTitle: second.title, childTitle: child.title };
  });

  const search = page.locator('#notesSearchInput');
  await search.fill('量子');
  await expect(page.locator('#notesList')).toContainText(fixture.firstTitle);
  await expect(page.locator('#notesList')).not.toContainText(fixture.secondTitle);
  await expect(page.locator('#notesSearchCount')).toHaveText('1');
  await expect(page.locator('.notes-search-mark').first()).toContainText('量子');
  await expect(page.locator('.ns-search-snippet')).toContainText('量子纠缠');

  await search.fill('课程资料');
  await expect(page.locator('#notesList')).toContainText('课程资料');
  await expect(page.locator('#notesList')).toContainText(fixture.childTitle);

  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.locator('#notesSearchCount')).toHaveText('');

  await page.locator('#notesSortSelect').selectOption('updated-desc');
  let rootTitles = await page.locator('#notesList .ns-root > .ns-note .ns-note-title').allTextContents();
  expect(rootTitles.indexOf(fixture.secondTitle)).toBeLessThan(rootTitles.indexOf(fixture.firstTitle));
  await expect(page.locator('#notesList .ns-root > .ns-note').first()).toHaveAttribute('draggable', 'false');

  await page.locator('#notesSortSelect').selectOption('title-asc');
  rootTitles = await page.locator('#notesList .ns-root > .ns-note .ns-note-title').allTextContents();
  expect(rootTitles.indexOf(fixture.secondTitle)).toBeLessThan(rootTitles.indexOf(fixture.firstTitle));

  const density = await page.evaluate(() => {
    const meta = document.getElementById('notesMetaBar').getBoundingClientRect();
    const tags = document.getElementById('notesTagBar').getBoundingClientRect();
    const keywords = document.getElementById('notesKeywordsBar').getBoundingClientRect();
    return {
      height: Math.round(meta.height),
      rowDelta: Math.abs(Math.round(tags.top - keywords.top)),
      overflow: getComputedStyle(document.getElementById('notesMetaBar')).overflow
    };
  });
  expect(density.height).toBeLessThanOrEqual(42);
  expect(density.rowDelta).toBeLessThanOrEqual(2);
  expect(density.overflow).toBe('hidden');

  await page.locator('#notesSortSelect').selectOption('manual');
  await expect(page.locator('#notesList .ns-root > .ns-note').first()).toHaveAttribute('draggable', 'true');
});
