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
  let mathPointerStart = null;
  let closeMathEditor = null;

  const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DETAILS']);

  function escapeInline(text) {
    return String(text || '').replace(/\u200b/g, '').replace(/([\\`*_[\]$])/g, '\\$1');
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

  function getLatexSource(node) {
    if (!node) return '';
    const stored = node.dataset?.latex
      || node.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent;
    if (stored) return stored.trim();

    // DOMPurify keeps MathML but flattens KaTeX's <semantics>/<annotation>
    // wrapper. The TeX source then survives as a direct text node of <math>.
    const math = node.matches?.('math') ? node : node.querySelector?.('math');
    return Array.from(math?.childNodes || [])
      .filter(child => child.nodeType === Node.TEXT_NODE)
      .map(child => child.textContent || '')
      .join('')
      .trim();
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
      const latex = getLatexSource(math);
      if (latex) math.dataset.latex = latex;
      math.setAttribute('contenteditable', 'false');
      math.title = '双击编辑公式';
      const display = math.closest('.markdown-math-display');
      const atomic = display || math.closest('.katex-display') || math;
      atomic.setAttribute('contenteditable', 'false');
      if (display) {
        for (const side of ['previousSibling', 'nextSibling']) {
          const sibling = display[side];
          if (sibling?.nodeType === Node.ELEMENT_NODE && blockTags.has(sibling.tagName)) continue;
          const paragraph = document.createElement('p');
          paragraph.textContent = '\u200b';
          if (side === 'previousSibling') display.before(paragraph);
          else display.after(paragraph);
        }
      } else {
        for (const side of ['previousSibling', 'nextSibling']) {
          const sibling = atomic[side];
          if (sibling?.nodeType === Node.TEXT_NODE && sibling.textContent.length) continue;
          const boundary = document.createTextNode('\u200b');
          if (side === 'previousSibling') atomic.before(boundary);
          else atomic.after(boundary);
        }
      }
    });
    container.querySelectorAll('.footnotes').forEach(section => section.setAttribute('contenteditable', 'false'));
    container.querySelectorAll('img').forEach(image => image.setAttribute('contenteditable', 'false'));
  }

  function setMarkdown(markdown, noteId) {
    closeMathEditor?.(false);
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
    const emphasis = (marker, selector) => {
      const value = children();
      if (node.parentElement?.closest(selector)) return value;
      // Delimiters adjoining whitespace render as literal stars in CommonMark.
      const content = value.trim();
      if (!content) return value;
      const start = value.length - value.trimStart().length;
      const leading = value.slice(0, start), trailing = value.slice(start + content.length);
      const previous = node.previousSibling?.textContent?.slice(-1) || '';
      const next = node.nextSibling?.textContent?.slice(0, 1) || '';
      const punctuation = char => /[\p{P}\p{S}]/u.test(char);
      const word = char => !!char && !/\s/u.test(char) && !punctuation(char);
      // CommonMark cannot close punctuation-ending emphasis before a word
      // (e.g. Chinese text after a bold colon). Inline HTML is lossless here.
      if ((!leading && punctuation(content[0]) && word(previous))
        || (!trailing && punctuation(content.slice(-1)) && word(next))) {
        const semanticTag = marker === '**' ? 'strong' : marker === '*' ? 'em' : 'del';
        return leading + '<' + semanticTag + '>' + content + '</' + semanticTag + '>' + trailing;
      }
      return leading + marker + content + marker + trailing;
    };
    if (tag === 'strong' || tag === 'b') return emphasis('**', 'strong, b');
    if (tag === 'em' || tag === 'i') return emphasis('*', 'em, i');
    if (tag === 'del' || tag === 's' || tag === 'strike') return emphasis('~~', 'del, s, strike');
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
      const latex = getLatexSource(node);
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
    // Native paste may place an atomic inline formula directly inside a quote.
    // Keep it as TeX instead of serializing its MathML and visual DOM separately.
    if (node.classList.contains('katex')) return inline(node);
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
      // An empty body is real document content (including in history), not a
      // request to create a fold. Never inject the new-fold placeholder here.
      return ':::fold ' + (title || '折叠内容') + '\n' + bodyMarkdown + '\n:::';
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
    if (node.classList.contains('markdown-math-display') || node.classList.contains('katex-display')) {
      const math = node.querySelector('.katex');
      const latex = getLatexSource(math);
      return latex ? '$$\n' + latex.trim() + '\n$$' : '';
    }
    if (node.classList.contains('footnotes')) return '';
    return Array.from(node.childNodes).map(child => blockTags.has(child.tagName) ? block(child) : inline(child)).join('');
  }

  function focusHistoryChange(before, after) {
    const render = markdown => {
      const container = document.createElement('div');
      container.innerHTML = root.formatNoteContent(prepareMarkdown(markdown || ''));
      normalizeRenderedDom(container);
      return container;
    };
    const oldDom = render(before), newDom = render(after);
    let index = 0;
    while (index < oldDom.childNodes.length && index < newDom.childNodes.length
      && oldDom.childNodes[index].isEqualNode(newDom.childNodes[index])) index++;
    const oldText = oldDom.childNodes[index]?.textContent || '';
    const newText = newDom.childNodes[index]?.textContent || '';
    let offset = 0;
    if (oldText !== newText) {
      while (offset < oldText.length && offset < newText.length && oldText[offset] === newText[offset]) offset++;
    }
    const range = document.createRange();
    const node = host.childNodes[index];
    if (!node) {
      range.selectNodeContents(host.lastChild || host);
      range.collapse(false);
    } else {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let text = node.nodeType === Node.TEXT_NODE ? node : walker.nextNode();
      let last = null;
      while (text && offset > text.length) {
        offset -= text.length;
        last = text;
        text = walker.nextNode();
      }
      text = text || last;
      const atomic = text?.parentElement?.closest('[contenteditable="false"]');
      if (atomic) range.setStartBefore(atomic);
      else if (text) range.setStart(text, Math.min(offset, text.length));
      else range.setStartBefore(node);
      range.collapse(true);
    }
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer : range.startContainer.parentElement;
    // Opening ancestors makes changes inside a folded section visible.
    for (let fold = element.closest('details'); fold && host.contains(fold); fold = fold.parentElement?.closest('details')) fold.open = true;
    host.focus({ preventScroll: true });
    restoreRange(range);
    let rect = range.getBoundingClientRect();
    const fallback = node?.nodeType === Node.ELEMENT_NODE ? node : host.lastElementChild || element;
    if (!rect.height) rect = fallback.getBoundingClientRect();
    for (let parent = element; parent; parent = parent.parentElement) {
      if (parent.scrollHeight <= parent.clientHeight || parent.clientHeight <= 0) continue;
      const bounds = parent.getBoundingClientRect();
      const delta = rect.top - bounds.top - parent.clientHeight / 3;
      parent.scrollTop += delta;
      rect = range.getBoundingClientRect();
      if (!rect.height) rect = fallback.getBoundingClientRect();
    }
  }

  function getMarkdown() {
    if (!host) return currentMarkdown;
    const source = host.cloneNode(true);
    const mergeFormatting = container => {
      const aliases = { B: 'strong', I: 'em', S: 'del', STRIKE: 'del' };
      Array.from(container.children).forEach(child => {
        const tag = aliases[child.tagName];
        if (tag) {
          const replacement = document.createElement(tag);
          while (child.firstChild) replacement.appendChild(child.firstChild);
          child.replaceWith(replacement);
          child = replacement;
        }
        mergeFormatting(child);
      });
      for (let child = container.firstChild; child; child = child.nextSibling) {
        if (!child.matches?.('strong, em, del')) continue;
        // **one****two** has ambiguous delimiters; serialize one formatted run.
        while (child.nextSibling?.nodeName === child.nodeName) {
          const next = child.nextSibling;
          while (next.firstChild) child.appendChild(next.firstChild);
          next.remove();
        }
      }
    };
    mergeFormatting(source);
    let markdown = Array.from(source.childNodes).map(block).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
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

  function notifyChange(change = {}) {
    if (syncing) return;
    assignHeadingIds();
    const previous = currentMarkdown;
    const markdown = getMarkdown();
    if (typeof root.captureNoteFoldStates === 'function') root.captureNoteFoldStates(host, currentNoteId, false);
    if (typeof options.onChange === 'function') options.onChange(markdown, previous, currentNoteId, change);
    else if (typeof root.onRichNotesChange === 'function') root.onRichNotesChange(markdown, previous, change);
  }

  function editMath(math) {
    const latex = getLatexSource(math);
    if (!latex || !root.katex?.renderToString || !root.DOMPurify) return;
    closeMathEditor?.(false);
    const noteId = currentNoteId;
    const displayMode = !!math.closest('.markdown-math-display, .katex-display');
    const dialog = document.createElement('dialog');
    dialog.className = 'note-math-dialog';
    dialog.setAttribute('aria-labelledby', 'noteMathEditorTitle');
    dialog.innerHTML = '<div class="modal-header"><span class="modal-title" id="noteMathEditorTitle">编辑公式</span>'
      + '<button type="button" class="modal-close" aria-label="关闭公式编辑器">✕</button></div>'
      + '<div class="note-math-editor-body"><label for="noteMathSource">LaTeX 源码</label>'
      + '<textarea id="noteMathSource" spellcheck="false" aria-describedby="noteMathHint noteMathError"></textarea>'
      + '<p id="noteMathHint" class="hint">只填写公式内容，无需添加外层 $ 或 $$。Ctrl+Enter 保存，Esc 取消。</p>'
      + '<label>实时预览</label><div class="note-math-preview" aria-label="公式预览"></div>'
      + '<p id="noteMathError" class="note-math-error" role="status"></p></div>'
      + '<div class="note-math-actions"><button type="button" class="note-math-cancel">取消</button>'
      + '<button type="button" class="note-math-save">保存</button></div>';
    const input = dialog.querySelector('textarea');
    const preview = dialog.querySelector('.note-math-preview');
    const error = dialog.querySelector('.note-math-error');
    const save = dialog.querySelector('.note-math-save');
    input.value = latex;
    let replacement = null;
    function renderPreview() {
      replacement = null;
      error.textContent = '';
      preview.replaceChildren();
      try {
        if (!input.value.trim()) throw new Error('请输入公式内容。');
        preview.innerHTML = root.DOMPurify.sanitize(root.katex.renderToString(
          root.StudyMarkdown?.normalizeLatex ? root.StudyMarkdown.normalizeLatex(input.value.trim()) : input.value.trim(),
          { displayMode, throwOnError: true, trust: false, strict: 'warn', output: 'htmlAndMathml' }
        ), { USE_PROFILES: { html: true, mathMl: true } });
        replacement = preview.querySelector('.katex');
      } catch (reason) {
        error.textContent = reason.message || '公式暂时无法渲染，请检查源码。';
      }
      save.disabled = !replacement;
      input.setAttribute('aria-invalid', String(!replacement));
    }
    const close = (restoreFocus = true) => {
      closeMathEditor = null;
      dialog.close();
      dialog.remove();
      if (restoreFocus && host.contains(math)) {
        const atomic = math.closest('.markdown-math-display, .katex-display') || math;
        const range = document.createRange();
        range.setStartAfter(atomic);
        range.collapse(true);
        host.focus({ preventScroll: true });
        restoreRange(range);
      }
    };
    closeMathEditor = close;
    function commit() {
      renderPreview();
      if (!replacement || noteId !== currentNoteId || !host.contains(math)) return;
      const source = input.value.trim();
      if (source === latex) { close(); return; }
      const updated = replacement.cloneNode(true);
      updated.dataset.latex = source;
      updated.setAttribute('contenteditable', 'false');
      updated.title = '双击编辑公式';
      math.replaceWith(updated);
      math = updated;
      notifyChange({ historyBoundary: true });
      close();
    }
    dialog.querySelector('.modal-close').addEventListener('click', () => close());
    dialog.querySelector('.note-math-cancel').addEventListener('click', () => close());
    save.addEventListener('click', commit);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      // Keep textarea undo and formatting keys local to the formula draft.
      event.stopPropagation();
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); commit(); }
    });
    input.addEventListener('input', event => { if (!event.isComposing) renderPreview(); });
    input.addEventListener('compositionend', renderPreview);
    document.body.appendChild(dialog);
    renderPreview();
    dialog.showModal();
    input.focus({ preventScroll: true });
    input.select();
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

  const foldWrappingBlocks = 'blockquote, ul, ol, pre, table, p, h1, h2, h3, h4, h5, h6';

  function expandWholeBlockSelection(range) {
    if (!range || range.collapsed) return range;
    const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    let block = element.closest(foldWrappingBlocks);
    const expanded = range.cloneRange();
    const hasContent = fragment => {
      const container = document.createElement('div');
      container.appendChild(fragment);
      return !!(container.textContent || '').replace(/\u200b/g, '').trim()
        || !!container.querySelector('img, input:not([type="checkbox"]), hr, video, audio, .katex');
    };
    while (block && host.contains(block)) {
      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(expanded.startContainer, expanded.startOffset);
      const after = document.createRange();
      after.selectNodeContents(block);
      after.setStart(expanded.endContainer, expanded.endOffset);
      if (hasContent(before.cloneContents()) || hasContent(after.cloneContents())) break;
      // Selecting all text usually omits its enclosing structural block. Include the
      // block itself so insertHTML replaces it instead of nesting a fold in it.
      expanded.selectNode(block);
      block = block.parentElement.closest(foldWrappingBlocks);
    }
    return expanded;
  }

  async function command(type) {
    if (!host) return;
    const selection = window.getSelection();
    const savedRange = selection && selection.rangeCount && host.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    host.focus({ preventScroll: true });
    if (savedRange) restoreRange(savedRange);
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
      const foldRange = expandWholeBlockSelection(savedRange);
      restoreRange(foldRange);
      const selectedHtml = rangeContentsHtml(foldRange);
      const html = '<details class="note-fold" open><summary>折叠标题</summary><div class="note-fold-body">' + selectedHtml + '</div></details><p><br></p>';
      const selectedBlockNode = foldRange && foldRange.startContainer === foldRange.endContainer
        && foldRange.endOffset === foldRange.startOffset + 1
        && foldRange.startContainer.childNodes[foldRange.startOffset]?.matches?.(foldWrappingBlocks);
      if (selectedBlockNode || (foldRange && savedRange && (foldRange.startContainer !== savedRange.startContainer
        || foldRange.startOffset !== savedRange.startOffset || foldRange.endContainer !== savedRange.endContainer
        || foldRange.endOffset !== savedRange.endOffset))) {
        // Chromium insertHTML can reapply the enclosing structure even when its
        // entire node is selected. Replace at the promoted DOM boundary.
        const fragment = foldRange.createContextualFragment(html);
        const paragraph = fragment.lastChild;
        foldRange.deleteContents();
        foldRange.insertNode(fragment);
        const caret = document.createRange();
        caret.setStart(paragraph, 0);
        caret.collapse(true);
        restoreRange(caret);
        notifyChange();
      } else insertHtml(html);
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

  function foldTitleRange() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const summary = element.closest('summary');
    return summary && host.contains(summary) && summary.parentElement.matches('details.note-fold')
      && summary.contains(range.endContainer) ? range : null;
  }

  function insertTitleContent(range, fragment) {
    const last = fragment.lastChild;
    if (!last) return;
    range.deleteContents();
    range.insertNode(fragment);
    range.setStartAfter(last);
    range.collapse(true);
    restoreRange(range);
  }

  function enterFoldBodyFromTitle() {
    const range = foldTitleRange();
    if (!range) return false;
    const element = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const fold = element.closest('summary').parentElement;
    let body = Array.from(fold.children).find(child => child.classList.contains('note-fold-body'));
    if (!body) {
      body = document.createElement('div');
      body.className = 'note-fold-body';
      fold.appendChild(body);
    }
    const paragraph = emptyParagraph();
    body.prepend(paragraph);
    fold.open = true;
    focusParagraph(paragraph);
    return true;
  }

  function handlePaste(event) {
    event.preventDefault();
    const clipboard = event.clipboardData;
    const html = clipboard?.getData('text/html') || '';
    const titleRange = foldTitleRange();
    if (html && root.DOMPurify) {
      // Keep the renderer's spans, MathML, images and task checkboxes.
      // DOMPurify's default HTML/MathML profiles still remove executable content.
      const container = document.createElement('div');
      container.innerHTML = root.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true, mathMl: true },
        ADD_ATTR: ['contenteditable']
      });
      container.querySelectorAll('input').forEach(input => {
        if (input.type !== 'checkbox') input.remove();
      });
      container.querySelectorAll('img, a').forEach(node => {
        const attr = node.tagName === 'IMG' ? 'src' : 'href';
        if (!isSafeUserUrl(node.getAttribute(attr), attr === 'src')) node.removeAttribute(attr);
      });
      // Clipboard HTML can include the source surface's computed background and
      // text colors. Rebuild math from TeX so only formula-authored styles remain,
      // including deliberate \color or \colorbox, alongside KaTeX's layout styles.
      container.querySelectorAll('.katex').forEach(math => {
        const latex = getLatexSource(math);
        if (latex && root.katex?.renderToString) {
          try {
            const rendered = document.createElement('div');
            rendered.innerHTML = root.DOMPurify.sanitize(root.katex.renderToString(
              root.StudyMarkdown?.normalizeLatex ? root.StudyMarkdown.normalizeLatex(latex) : latex,
              {
                displayMode: !!math.closest('.katex-display, .markdown-math-display'),
                throwOnError: false, trust: false, strict: 'warn', output: 'htmlAndMathml'
              }
            ), { USE_PROFILES: { html: true, mathMl: true } });
            const replacement = rendered.querySelector('.katex');
            if (replacement) {
              replacement.dataset.latex = latex;
              math.replaceWith(replacement);
              return;
            }
          } catch (_) {
            // Malformed external TeX must not prevent the rest of the paste.
          }
        }
        // Still discard copied backgrounds when the clipboard has no TeX source
        // or the renderer is unavailable, preserving positioning and font metrics.
        [math, ...math.querySelectorAll('[style]')].forEach(node => {
          Array.from(node.style).filter(name => name.startsWith('background'))
            .forEach(name => node.style.removeProperty(name));
        });
      });
      // Chromium can express copied bold/italic text as styled spans.
      // Convert those styles to the semantic tags our Markdown serializer uses.
      container.querySelectorAll('[style]').forEach(node => {
        if (node.closest('.katex')) return;
        const style = node.style;
        const tags = [];
        if (!node.matches('strong, b') && (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600)) tags.push('strong');
        if (!node.matches('em, i') && style.fontStyle === 'italic') tags.push('em');
        if (!node.matches('del, s, strike') && style.textDecorationLine.includes('line-through')) tags.push('del');
        tags.forEach(tag => {
          const wrapper = document.createElement(tag);
          while (node.firstChild) wrapper.appendChild(node.firstChild);
          node.appendChild(wrapper);
        });
        node.removeAttribute('style');
      });
      normalizeRenderedDom(container);
      if (titleRange) {
        // A summary is a single inline title. Strip clipboard block wrappers,
        // keeping inline formatting and separating pasted paragraphs with spaces.
        container.querySelectorAll('input, .footnotes').forEach(node => node.remove());
        container.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode(' ')));
        Array.from(container.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, pre, blockquote, table, thead, tbody, tr, th, td, details, summary, hr')).reverse().forEach(node => {
          node.replaceWith(...node.childNodes, document.createTextNode(' '));
        });
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          node.textContent = node.textContent.replace(/[\r\n]+/g, ' ');
          textNodes.push(node);
        }
        for (const node of textNodes.reverse()) {
          node.textContent = node.textContent.trimEnd();
          if (node.textContent) break;
          node.remove();
        }
        const fragment = document.createDocumentFragment();
        while (container.firstChild) fragment.appendChild(container.firstChild);
        insertTitleContent(titleRange, fragment);
      } else document.execCommand('insertHTML', false, container.innerHTML);
    } else if (titleRange) {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(document.createTextNode((clipboard?.getData('text/plain') || '').replace(/[\r\n]+/g, ' ')));
      insertTitleContent(titleRange, fragment);
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

  function caretElement() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const node = selection.anchorNode;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return host.contains(element) ? element : null;
  }

  function focusParagraph(paragraph) {
    const range = document.createRange();
    range.setStart(paragraph, 0);
    range.collapse(true);
    restoreRange(range);
    notifyChange();
  }

  function emptyParagraph() {
    const paragraph = document.createElement('p');
    paragraph.appendChild(document.createElement('br'));
    return paragraph;
  }

  function exitEditingBlock() {
    const element = caretElement();
    let target = element?.closest('pre, ul, ol, table, blockquote, details.note-fold');
    if (!target || !host.contains(target)) return false;
    // Exit all levels of the same structure, while staying in a containing fold
    // or quote when leaving a different structure such as a list or code block.
    const selector = target.matches('ul, ol') ? 'ul, ol' : target.tagName.toLowerCase();
    let parent = target.parentElement?.closest(selector);
    while (parent && host.contains(parent)) {
      target = parent;
      parent = target.parentElement?.closest(selector);
    }
    const paragraph = emptyParagraph();
    target.after(paragraph);
    focusParagraph(paragraph);
    return true;
  }

  function isEmptyEditingNode(node) {
    return !(node.textContent || '').replace(/\u200b/g, '').trim()
      && !node.querySelector('img, video, audio, table, hr, iframe, pre, ul, ol, .katex');
  }

  function exitEmptyItem() {
    const element = caretElement();
    if (!element || element.closest('pre, table')) return false;
    const item = element.closest('li');
    const quote = element.closest('blockquote');
    const node = item || (quote && element.closest('p, div'));
    const container = item ? item.parentElement : quote;
    if (!node || !container || !host.contains(container)
      || !container.contains(node) || !isEmptyEditingNode(node)) return false;
    // Split at the empty item so following items/paragraphs keep their order.
    const tailRange = document.createRange();
    tailRange.setStartAfter(node);
    tailRange.setEnd(container, container.childNodes.length);
    const trailing = container.cloneNode(false);
    trailing.removeAttribute('id');
    trailing.appendChild(tailRange.extractContents());
    node.remove();
    const paragraph = emptyParagraph();
    container.after(paragraph);
    if (trailing.children.length || trailing.textContent.trim()) paragraph.after(trailing);
    if (!container.children.length && !container.textContent.trim()) container.remove();
    focusParagraph(paragraph);
    return true;
  }

  function enterTaskItem() {
    const element = caretElement();
    const item = element?.closest('li');
    const checkbox = item?.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    if (!checkbox || element.closest('pre, table')) return false;
    document.execCommand('insertParagraph', false, null);
    const newItem = caretElement()?.closest('li');
    if (newItem && newItem !== item) {
      const inputs = newItem.querySelectorAll(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
      inputs.forEach(input => input.remove());
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = false;
      input.setAttribute('contenteditable', 'false');
      input.setAttribute('aria-label', '任务状态');
      const body = newItem.querySelector(':scope > p') || newItem;
      body.prepend(input, document.createTextNode(' '));
      newItem.classList.add('markdown-task-item');
      // Put the caret after the noneditable checkbox, before the new item's text.
      const range = document.createRange();
      range.setStartAfter(input.nextSibling);
      range.collapse(true);
      restoreRange(range);
    }
    notifyChange();
    return true;
  }

  function removeSingleEmptyQuote() {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const anchor = selection.anchorNode;
    const element = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
    const quote = element?.closest('blockquote');
    if (!quote || !host.contains(quote) || !quote.contains(selection.focusNode)
      || !isEmptyEditingNode(quote) || quote.querySelector('input, blockquote, details')) return false;
    const lines = Array.from(quote.querySelectorAll('p, div')).filter(node => !node.querySelector('p, div'));
    if (lines.length > 1 || quote.querySelectorAll('br').length > 1) return false;
    const paragraph = emptyParagraph();
    quote.replaceWith(paragraph);
    focusParagraph(paragraph);
    return true;
  }

  function getEditableFoldSummary(event) {
    const summary = event.target?.closest?.('summary');
    const fold = summary?.parentElement;
    if (!summary || !fold?.matches('details.note-fold') || !host.contains(fold)) return null;
    return summary;
  }

  function isFoldToggleClick(event, summary) {
    // The disclosure marker is a pseudo-element, so it cannot be targeted
    // directly. Treat the marker and its surrounding padding as one control.
    const rect = summary.getBoundingClientRect();
    const titleRange = document.createRange();
    titleRange.selectNodeContents(summary);
    const textRect = Array.from(titleRange.getClientRects()).find(rect => rect.width > 0);
    return event.clientX < Math.min(rect.left + 36, textRect?.left ?? rect.left + 36);
  }

  function placeEditingCaretAtPoint(x, y, summary) {
    host.focus({ preventScroll: true });
    const point = document.caretPositionFromPoint?.(x, y);
    const range = document.createRange();
    if (point) range.setStart(point.offsetNode, point.offset);
    else {
      const legacyRange = document.caretRangeFromPoint?.(x, y);
      if (legacyRange) range.setStart(legacyRange.startContainer, legacyRange.startOffset);
      else range.selectNodeContents(summary);
    }
    // Flex summary hit testing can return the summary's start in the blank
    // space after its text. Resolve that space to the visible title's end.
    const titleRange = document.createRange();
    titleRange.selectNodeContents(summary);
    const textRects = Array.from(titleRange.getClientRects());
    const lineRects = textRects.filter(rect => y >= rect.top && y <= rect.bottom);
    if (!summary.contains(range.startContainer)
      || (lineRects.length && x >= Math.max(...lineRects.map(rect => rect.right)))) {
      range.selectNodeContents(summary);
      range.collapse(false);
    }
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
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
    host.addEventListener('dblclick', event => {
      const math = event.target.closest('.katex');
      if (!math) return;
      event.preventDefault();
      event.stopPropagation();
      editMath(math);
    });
    host.addEventListener('beforeinput', event => {
      if (!event.isComposing && event.inputType === 'insertParagraph' && enterFoldBodyFromTitle()) {
        event.preventDefault();
        return;
      }
      if (!event.isComposing && ['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)
        && removeSingleEmptyQuote()) event.preventDefault();
    });
    if (host.id === 'notesRichEditor' && typeof root.onNotePreviewScroll === 'function') {
      host.addEventListener('scroll', root.onNotePreviewScroll);
    }
    host.addEventListener('pointerdown', event => {
      mathPointerStart = event.target.closest('.katex') && event.button === 0
        ? { x: event.clientX, y: event.clientY } : null;
      const summary = getEditableFoldSummary(event);
      if (summary && isFoldToggleClick(event, summary)) {
        // Keep clicking the disclosure control from moving the editing caret
        // into the title. The following click still performs the native toggle.
        event.preventDefault();
      }
    });
    host.addEventListener('click', event => {
      const math = event.target.closest('.katex');
      if (math && !event.shiftKey && event.detail === 1 && mathPointerStart
        && Math.abs(event.clientX - mathPointerStart.x) < 5 && Math.abs(event.clientY - mathPointerStart.y) < 5) {
        const atomic = math.closest('.markdown-math-display') || math.closest('.katex-display') || math;
        const after = event.clientX >= math.getBoundingClientRect().left + math.getBoundingClientRect().width / 2;
        const range = document.createRange();
        const boundary = atomic[after ? 'nextSibling' : 'previousSibling'];
        if (atomic.matches('.markdown-math-display') && boundary?.nodeType === Node.ELEMENT_NODE) {
          range.selectNodeContents(boundary);
          range.collapse(!after);
        } else if (after) range.setStartAfter(atomic);
        else range.setStartBefore(atomic);
        range.collapse(true);
        host.focus({ preventScroll: true });
        restoreRange(range);
        event.preventDefault();
        return;
      }
      const summary = getEditableFoldSummary(event);
      if (summary && !isFoldToggleClick(event, summary)) {
        // In editing mode the title is editable text. Cancel the native
        // <summary> activation everywhere except around the disclosure marker.
        event.preventDefault();
        // Mouseup has already established drag, Shift-click and multi-click
        // selections. Do not replace those selections with a collapsed caret.
        const selection = window.getSelection();
        if (event.detail === 1 && !event.shiftKey && selection?.isCollapsed) {
          placeEditingCaretAtPoint(event.clientX, event.clientY, summary);
        }
      }
      const link = event.target.closest('a');
      if (link && !event.ctrlKey && !event.metaKey) event.preventDefault();
    });
    host.addEventListener('keyup', updateToolbarState);
    host.addEventListener('mouseup', updateToolbarState);
    host.addEventListener('keydown', event => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier && !event.shiftKey && !event.altKey && !event.isComposing
        && event.key === 'Enter' && enterFoldBodyFromTitle()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!modifier && !event.altKey && !event.shiftKey && !event.isComposing
        && (event.key === 'Backspace' || event.key === 'Delete') && removeSingleEmptyQuote()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (modifier && event.key === 'Enter' && exitEditingBlock()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!modifier && !event.shiftKey && !event.altKey && !event.isComposing
        && event.key === 'Enter' && (exitEmptyItem() || enterTaskItem())) {
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
    focusHistoryChange,
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
