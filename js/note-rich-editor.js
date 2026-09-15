// Markdown-backed rich note editor.
// The DOM is only an editing surface; note.content remains the canonical Markdown value.
(function (root) {
  'use strict';

  function createRichNoteEditor(options = {}) {

  let host = null;
  let currentMarkdown = '';
  let currentNoteId = null;
  let syncing = false;
  let footnoteLabels = [];
  let footnoteDefinitions = '';

  const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DETAILS']);

  function escapeInline(text) {
    return String(text || '').replace(/([\\`*_[\]$])/g, '\\$1');
  }

  function extractFootnotes(markdown) {
    const labels = [];
    const source = String(markdown || '');
    source.replace(/\[\^([^\]]+)\](?!:)/g, (_, label) => {
      if (!labels.includes(label)) labels.push(label);
      return _;
    });
    const lines = source.split('\n');
    const definitions = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\[\^[^\]]+\]:/.test(lines[i])) continue;
      definitions.push(lines[i]);
      while (i + 1 < lines.length && (/^(?: {2,4}|\t)\S/.test(lines[i + 1]) || lines[i + 1] === '')) {
        definitions.push(lines[++i]);
      }
    }
    return { labels, definitions: definitions.join('\n').trim() };
  }

  function prepareMarkdown(markdown) {
    // Render mindmaps as editable fenced source instead of a canvas-like diagram.
    return String(markdown || '').replace(/```mindmap\b/g, '```mst-mindmap-raw');
  }

  function isSafeUserUrl(value, image) {
    try {
      const parsed = new URL(String(value || '').trim(), location.href);
      const protocols = image ? ['http:', 'https:', 'data:', 'blob:'] : ['http:', 'https:', 'mailto:'];
      return protocols.includes(parsed.protocol) || String(value || '').startsWith('#');
    } catch (_) {
      return false;
    }
  }

  function normalizeRenderedDom(container) {
    container.querySelectorAll('pre code').forEach(code => {
      const languageClass = Array.from(code.classList).find(name => name.startsWith('language-')) || '';
      const text = code.textContent || '';
      code.className = languageClass;
      code.textContent = text;
    });
    container.querySelectorAll('input[type="checkbox"]').forEach(input => {
      input.disabled = false;
      input.setAttribute('contenteditable', 'false');
      input.setAttribute('aria-label', '任务状态');
    });
    container.querySelectorAll('.katex').forEach(math => {
      const annotation = math.querySelector('annotation[encoding="application/x-tex"]');
      if (annotation) math.dataset.latex = annotation.textContent || '';
      math.setAttribute('contenteditable', 'false');
    });
    container.querySelectorAll('.footnotes').forEach(section => section.setAttribute('contenteditable', 'false'));
    container.querySelectorAll('img').forEach(image => image.setAttribute('contenteditable', 'false'));
  }

  function setMarkdown(markdown, noteId) {
    if (!host) init();
    if (!host) return;
    syncing = true;
    currentMarkdown = String(markdown || '');
    currentNoteId = noteId == null ? null : noteId;
    const footnotes = extractFootnotes(currentMarkdown);
    footnoteLabels = footnotes.labels;
    footnoteDefinitions = footnotes.definitions;
    const html = typeof root.formatNoteContent === 'function'
      ? root.formatNoteContent(prepareMarkdown(currentMarkdown))
      : '<p>' + escapeInline(currentMarkdown) + '</p>';
    host.innerHTML = html || '<p><br></p>';
    normalizeRenderedDom(host);
    if (typeof root.applyNoteFoldStates === 'function') root.applyNoteFoldStates(host, currentNoteId);
    syncing = false;
  }

  function inline(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return escapeInline(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const children = () => Array.from(node.childNodes).map(inline).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return '**' + children() + '**';
    if (tag === 'em' || tag === 'i') return '*' + children() + '*';
    if (tag === 'del' || tag === 's' || tag === 'strike') return '~~' + children() + '~~';
    if (tag === 'code') {
      const value = node.textContent || '';
      const ticks = value.includes('`') ? '``' : '`';
      return ticks + value + ticks;
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      return href ? '[' + children() + '](' + href + ')' : children();
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      return src ? '![' + (node.getAttribute('alt') || '') + '](' + src + ')' : '';
    }
    if (tag === 'sup' && node.classList.contains('footnote-ref')) {
      const link = node.querySelector('a');
      const match = (link?.getAttribute('href') || '').match(/fn(\d+)/);
      const index = match ? Number(match[1]) - 1 : 0;
      return '[^' + (footnoteLabels[index] || String(index + 1)) + ']';
    }
    if (node.classList.contains('katex')) {
      const latex = node.dataset.latex || node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || '';
      return latex ? '$' + latex.trim() + '$' : '';
    }
    if (blockTags.has(node.tagName)) return block(node).trim();
    return children();
  }

  function listItem(li, ordered, index, depth) {
    const checkbox = li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    const nested = Array.from(li.children).filter(child => child.tagName === 'UL' || child.tagName === 'OL');
    const mainNodes = Array.from(li.childNodes).filter(child => !(child.nodeType === Node.ELEMENT_NODE && (child.tagName === 'UL' || child.tagName === 'OL')));
    let content = mainNodes.map(inline).join('').replace(/^\s+|\s+$/g, '');
    if (checkbox) content = '[' + (checkbox.checked ? 'x' : ' ') + '] ' + content;
    const marker = ordered ? (index + 1) + '. ' : '- ';
    let result = '  '.repeat(depth) + marker + content;
    nested.forEach(list => {
      result += '\n' + serializeList(list, depth + 1);
    });
    return result;
  }

  function serializeList(list, depth) {
    const ordered = list.tagName === 'OL';
    return Array.from(list.children)
      .filter(child => child.tagName === 'LI')
      .map((li, index) => listItem(li, ordered, index, depth || 0))
      .join('\n');
  }

  function serializeTable(table) {
    const rows = Array.from(table.querySelectorAll('tr')).map(row =>
      Array.from(row.children)
        .filter(cell => cell.tagName === 'TH' || cell.tagName === 'TD')
        .map(cell => Array.from(cell.childNodes).map(inline).join('').trim().replace(/\|/g, '\\|'))
    ).filter(row => row.length);
    if (!rows.length) return '';
    const width = Math.max(...rows.map(row => row.length));
    const normalized = rows.map(row => Array.from({ length: width }, (_, i) => row[i] || ''));
    const output = ['| ' + normalized[0].join(' | ') + ' |'];
    output.push('| ' + normalized[0].map(() => '---').join(' | ') + ' |');
    normalized.slice(1).forEach(row => output.push('| ' + row.join(' | ') + ' |'));
    return output.join('\n');
  }

  function block(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return escapeInline(node.textContent || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'details') {
      const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY');
      const body = Array.from(node.children).find(child => child.classList.contains('note-fold-body'));
      const title = summary
        ? Array.from(summary.childNodes).map(inline).join('').trim()
        : '折叠内容';
      const bodyNodes = body ? Array.from(body.childNodes) : Array.from(node.childNodes).filter(child => child !== summary);
      const bodyMarkdown = bodyNodes
        .map(child => child.nodeType === Node.ELEMENT_NODE && blockTags.has(child.tagName) ? block(child) : inline(child))
        .filter(Boolean)
        .join('\n\n')
        .trim();
      return ':::fold ' + (title || '折叠内容') + '\n' + (bodyMarkdown || '正文内容') + '\n:::';
    }
    if (tag === 'p') return Array.from(node.childNodes).map(inline).join('').replace(/\n+$/g, '');
    if (/^h[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + Array.from(node.childNodes).map(inline).join('').trim();
    if (tag === 'ul' || tag === 'ol') return serializeList(node, 0);
    if (tag === 'pre') {
      const code = node.querySelector('code');
      let language = Array.from(code?.classList || []).find(name => name.startsWith('language-'))?.slice(9) || '';
      if (language === 'mst-mindmap-raw') language = 'mindmap';
      return '```' + language + '\n' + (code?.textContent || node.textContent || '').replace(/\n$/, '') + '\n```';
    }
    if (tag === 'blockquote') {
      const value = Array.from(node.childNodes).map(block).join('\n\n').trim();
      return value.split('\n').map(line => '> ' + line).join('\n');
    }
    if (tag === 'table') return serializeTable(node);
    if (tag === 'hr') return node.classList.contains('footnotes-sep') ? '' : '---';
    if (node.classList.contains('markdown-math-display')) {
      const math = node.querySelector('.katex');
      const latex = math?.dataset.latex || math?.querySelector('annotation[encoding="application/x-tex"]')?.textContent || '';
      return latex ? '$$\n' + latex.trim() + '\n$$' : '';
    }
    if (node.classList.contains('footnotes')) return '';
    return Array.from(node.childNodes).map(child => blockTags.has(child.tagName) ? block(child) : inline(child)).join('');
  }

  function getMarkdown() {
    if (!host) return currentMarkdown;
    let markdown = Array.from(host.childNodes).map(block).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (footnoteDefinitions) markdown += (markdown ? '\n\n' : '') + footnoteDefinitions;
    currentMarkdown = markdown;
    return markdown;
  }

  function assignHeadingIds() {
    if (!host) return;
    const counts = Object.create(null);
    host.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading => {
      const base = (heading.textContent || 'section').normalize('NFKC').trim().toLowerCase()
        .replace(/\s+/g, '-').replace(/[^\p{Letter}\p{Number}\-_:.一-鿿]/gu, '').replace(/-+/g, '-') || 'section';
      const count = counts[base] || 0;
      counts[base] = count + 1;
      heading.id = count ? base + '-' + count : base;
    });
  }

  function notifyChange() {
    if (syncing) return;
    assignHeadingIds();
    const previous = currentMarkdown;
    const markdown = getMarkdown();
    if (typeof root.captureNoteFoldStates === 'function') root.captureNoteFoldStates(host, currentNoteId, false);
    if (typeof options.onChange === 'function') options.onChange(markdown, previous, currentNoteId);
    else if (typeof root.onRichNotesChange === 'function') root.onRichNotesChange(markdown, previous);
  }

  function restoreRange(range) {
    if (!range) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function insertHtml(html) {
    host.focus();
    document.execCommand('insertHTML', false, html);
    notifyChange();
  }

  function rangeContentsHtml(range) {
    if (!range || range.collapsed) return '<p>正文内容</p>';
    const container = document.createElement('div');
    container.appendChild(range.cloneContents());
    const hasBlockContent = Array.from(container.childNodes).some(node =>
      node.nodeType === Node.ELEMENT_NODE && blockTags.has(node.tagName)
    );
    // A selection inside one paragraph contains only its inline descendants.
    // Keep their elements (strong/em/a/code...) and add only the missing block wrapper.
    return hasBlockContent ? container.innerHTML : '<p>' + container.innerHTML + '</p>';
  }

  async function command(type) {
    if (!host) return;
    host.focus();
    const selection = window.getSelection();
    const savedRange = selection && selection.rangeCount && host.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    const simple = { bold: 'bold', italic: 'italic', strikethrough: 'strikeThrough', ul: 'insertUnorderedList', ol: 'insertOrderedList' };
    if (simple[type]) document.execCommand(simple[type], false, null);
    else if (type === 'heading') {
      const heading = selection?.anchorNode?.parentElement?.closest('h1,h2,h3,h4,h5,h6');
      document.execCommand('formatBlock', false, heading ? 'p' : 'h2');
    } else if (type === 'quote') document.execCommand('formatBlock', false, 'blockquote');
    else if (type === 'codeblock') document.execCommand('formatBlock', false, 'pre');
    else if (type === 'code') {
      const text = savedRange ? savedRange.toString() : '';
      if (savedRange) restoreRange(savedRange);
      insertHtml('<code>' + (text || '代码').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code>');
      return;
    } else if (type === 'link') {
      const url = await root.showCustomPrompt?.('输入链接地址', 'https://');
      if (!url) return;
      if (!isSafeUserUrl(url, false)) {
        root.showMiniToast?.('链接地址不安全或格式不正确', 'error');
        return;
      }
      restoreRange(savedRange);
      document.execCommand('createLink', false, url);
    } else if (type === 'image') {
      const url = await root.showCustomPrompt?.('输入图片地址', 'https://');
      if (!url) return;
      if (!isSafeUserUrl(url, true)) {
        root.showMiniToast?.('图片地址不安全或格式不正确', 'error');
        return;
      }
      restoreRange(savedRange);
      insertHtml('<img src="' + String(url).replace(/"/g, '&quot;') + '" alt="图片">');
      return;
    } else if (type === 'task') {
      restoreRange(savedRange);
      const text = savedRange?.toString() || '待办事项';
      insertHtml('<ul class="markdown-task-list"><li class="markdown-task-item"><input type="checkbox" contenteditable="false"> ' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li></ul>');
      normalizeRenderedDom(host);
      return;
    } else if (type === 'table') {
      insertHtml('<table><thead><tr><th>列 1</th><th>列 2</th></tr></thead><tbody><tr><td>内容</td><td>内容</td></tr></tbody></table><p><br></p>');
      return;
    } else if (type === 'fold') {
      restoreRange(savedRange);
      const selectedHtml = rangeContentsHtml(savedRange);
      insertHtml('<details class="note-fold" open><summary>折叠标题</summary><div class="note-fold-body">' + selectedHtml + '</div></details><p><br></p>');
      return;
    } else if (type === 'hr') {
      document.execCommand('insertHorizontalRule', false, null);
    } else if (type === 'latex' || type === 'footnote') {
      // Complex source-oriented nodes keep the existing proven Markdown workflow.
      root.switchNoteView?.('edit');
      setTimeout(() => root.formatText?.(type), 0);
      return;
    } else return;
    notifyChange();
    updateToolbarState();
  }

  function updateToolbarState() {
    if (!host || !host.contains(window.getSelection()?.anchorNode)) return;
    const toolbarSelector = options.toolbarSelector === undefined ? '#notesFormatToolbar' : options.toolbarSelector;
    if (!toolbarSelector) return;
    const states = { bold: 'bold', italic: 'italic', strikethrough: 'strikeThrough', ul: 'insertUnorderedList', ol: 'insertOrderedList' };
    Object.entries(states).forEach(([type, commandName]) => {
      document.querySelectorAll(toolbarSelector + ' .fmt-btn[data-format="' + type + '"]').forEach(button => {
        button.classList.toggle('active', document.queryCommandState(commandName));
      });
    });
  }

  function handlePaste(event) {
    event.preventDefault();
    const clipboard = event.clipboardData;
    const html = clipboard?.getData('text/html') || '';
    if (html && root.DOMPurify) {
      const clean = root.DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary'],
        ALLOWED_ATTR: ['href', 'class', 'open']
      });
      document.execCommand('insertHTML', false, clean);
    } else document.execCommand('insertText', false, clipboard?.getData('text/plain') || '');
    notifyChange();
  }

  function selectFoldSectionAtCaret() {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const element = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
    const section = element?.closest('summary, .note-fold-body');
    if (!section || !section.closest('.note-fold')) return false;

    const range = document.createRange();
    range.selectNodeContents(section);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function exitFoldAtEnd() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    const range = selection.getRangeAt(0);
    if (!range.collapsed) return false;
    const anchor = range.endContainer;
    const element = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    const body = element?.closest('.note-fold-body');
    const fold = body?.closest('details.note-fold');
    if (!body || !fold || !host.contains(fold)) return false;

    // DOM boundaries differ when the caret is at the end of a text node versus
    // after its paragraph. Treat both as the visual end if only empty wrappers or
    // line breaks remain, while keeping Ctrl+Enter untouched before real content.
    const tail = range.cloneRange();
    tail.setEnd(body, body.childNodes.length);
    const fragment = tail.cloneContents();
    const tailContainer = document.createElement('div');
    tailContainer.appendChild(fragment);
    const remainingText = (tailContainer.textContent || '').replace(/\u200b/g, '').trim();
    const remainingContent = tailContainer.querySelector('img,video,audio,table,hr,input,iframe,pre,ul,ol,blockquote,h1,h2,h3,h4,h5,h6');
    if (remainingText || remainingContent) return false;

    let paragraph = fold.nextElementSibling;
    const reusableEmptyParagraph = paragraph?.tagName === 'P'
      && !(paragraph.textContent || '').replace(/\u200b/g, '').trim()
      && !paragraph.querySelector('img,video,audio,table,hr,input,iframe');
    if (!reusableEmptyParagraph) {
      paragraph = document.createElement('p');
      paragraph.appendChild(document.createElement('br'));
      fold.after(paragraph);
    }

    const nextRange = document.createRange();
    nextRange.setStart(paragraph, 0);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    notifyChange();
    return true;
  }

  function init() {
    host = document.getElementById(options.hostId || 'notesRichEditor');
    if (!host || host.dataset.ready === 'true') return;
    host.dataset.ready = 'true';
    host.addEventListener('input', notifyChange);
    host.addEventListener('change', event => {
      if (event.target.matches('input[type="checkbox"]')) notifyChange();
    });
    host.addEventListener('paste', handlePaste);
    if (host.id === 'notesRichEditor' && typeof root.onNotePreviewScroll === 'function') {
      host.addEventListener('scroll', root.onNotePreviewScroll);
    }
    host.addEventListener('click', event => {
      const link = event.target.closest('a');
      if (link && !event.ctrlKey && !event.metaKey) event.preventDefault();
    });
    host.addEventListener('keyup', updateToolbarState);
    host.addEventListener('mouseup', updateToolbarState);
    host.addEventListener('keydown', event => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key === 'Enter' && exitFoldAtEnd()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (modifier) {
        if (event.key.toLowerCase() === 'a' && selectFoldSectionAtCaret()) {
          event.preventDefault();
          return;
        }
        const actions = { b: 'bold', i: 'italic', u: 'strikethrough', k: 'link' };
        const action = actions[event.key.toLowerCase()];
        if (action) {
          event.preventDefault();
          command(action);
          return;
        }
      }
      if (event.key === 'Tab') {
        const item = window.getSelection()?.anchorNode?.parentElement?.closest('li');
        if (item) {
          event.preventDefault();
          document.execCommand(event.shiftKey ? 'outdent' : 'indent', false, null);
          notifyChange();
        }
      }
    });
  }

  return {
    init,
    setMarkdown,
    getMarkdown,
    command,
    isSyncing: () => syncing,
    getCurrentNoteId: () => currentNoteId
  };

  }

  const primaryEditor = createRichNoteEditor();
  root.createRichNoteEditor = createRichNoteEditor;
  root.RichNoteEditor = primaryEditor;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', primaryEditor.init);
  else primaryEditor.init();
})(window);
