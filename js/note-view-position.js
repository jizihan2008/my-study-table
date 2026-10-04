// Map viewports through document content, independently of each view's layout.
(function(root) {
  'use strict';
  const bindings = new WeakMap();
  const margin = 12;
  const lineAt = (source, index) => source.slice(0, index).split('\n').length - 1;
  const lineIndex = (source, line) => {
    let index = 0;
    for (let count = 0; count < line && index < source.length; count++) {
      const next = source.indexOf('\n', index);
      index = next < 0 ? source.length : next + 1;
    }
    return index;
  };

  function withMirror(textarea, callback) {
    const mirror = document.createElement('div');
    const style = getComputedStyle(textarea);
    for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'padding', 'border', 'boxSizing', 'tabSize', 'textIndent']) mirror.style[name] = style[name];
    Object.assign(mirror.style, { position: 'fixed', left: '0', top: '0', width: (textarea.clientWidth + parseFloat(style.borderLeftWidth || 0) + parseFloat(style.borderRightWidth || 0)) + 'px',
      visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' });
    mirror.textContent = textarea.value + '\u200b';
    document.body.appendChild(mirror);
    try { return callback(mirror, mirror.firstChild); }
    finally { mirror.remove(); }
  }

  function charRect(node, index) {
    const range = document.createRange();
    range.setStart(node, Math.min(index, node.length));
    range.setEnd(node, Math.min(index + 1, node.length));
    return range.getBoundingClientRect();
  }

  function firstCharAt(node, top) {
    let low = 0, high = Math.max(0, node.length - 1);
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (charRect(node, mid).bottom <= top) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  function textNodes(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.textContent.trim() && !node.parentElement.closest('.katex, .footnotes, [data-lazy-fold] > .note-fold-body')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  function mappedElements(container) {
    return Array.from(container.querySelectorAll('[data-source-line]')).filter(element => element.getBoundingClientRect().height > 0);
  }

  function capture(container, source, noteId) {
    const binding = container && bindings.get(container);
    if (!container?.clientHeight || binding?.noteId !== String(noteId)) return null;
    source = String(source || '');
    // Syntax lines and rendered margins differ. Reuse the content anchor until
    // the user scrolls or edits, avoiding drift on repeated mode switches.
    if (binding.anchor && binding.source === source && Math.abs(binding.scrollTop - container.scrollTop) < 1) return binding.anchor;
    if (container.tagName === 'TEXTAREA') return withMirror(container, (mirror, text) => {
      let index = Math.min(source.length, firstCharAt(text, container.scrollTop + margin));
      while (index < source.length && /\s/.test(source[index])) index++;
      const line = lineAt(source, index);
      return { index, line, quote: source.slice(index, index + 32).split('\n')[0], offset: charRect(text, index).top - container.scrollTop };
    });
    const top = container.getBoundingClientRect().top + margin;
    const visible = mappedElements(container).filter(element => {
      const bounds = element.getBoundingClientRect();
      if (bounds.bottom <= top || bounds.top >= container.getBoundingClientRect().bottom) return false;
      const nodes = textNodes(element);
      return nodes.some(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > top;
      }) || (!nodes.length && !element.hasAttribute('data-reading-block'));
    });
    // Choose the smallest visible source range, so a quote/list/fold doesn't
    // replace the paragraph or nested heading actually being read.
    visible.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      const at = Math.max(top, ar.top), bt = Math.max(top, br.top);
      return at - bt || (Number(a.dataset.sourceEnd) - Number(a.dataset.sourceLine)) - (Number(b.dataset.sourceEnd) - Number(b.dataset.sourceLine));
    });
    const element = visible[0];
    if (!element) return null;
    let line = Number(element.dataset.sourceLine);
    let index = lineIndex(source, line);
    let quote = '', offset = Math.max(0, element.getBoundingClientRect().top - container.getBoundingClientRect().top);
    for (const node of textNodes(element)) {
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!range.getBoundingClientRect().height || range.getBoundingClientRect().bottom <= top) continue;
      const char = firstCharAt(node, top);
      quote = node.textContent.slice(char, char + 32).trimEnd();
      // Search nearest the mapped line; also repairs stale DOM line metadata
      // after rich edits insert/remove text before this paragraph.
      if (quote) {
        const matches = [];
        for (let found = source.indexOf(quote); found >= 0; found = source.indexOf(quote, found + 1)) matches.push(found);
        if (matches.length) index = matches.reduce((best, value) => Math.abs(value - index) < Math.abs(best - index) ? value : best);
      }
      line = lineAt(source, index);
      offset = charRect(node, char).top - container.getBoundingClientRect().top;
      break;
    }
    return { index, line, quote, offset };
  }

  function restore(container, source, noteId, anchor) {
    if (!container) return;
    const binding = { noteId: String(noteId), source: String(source || ''), anchor, scrollTop: container.scrollTop };
    bindings.set(container, binding);
    if (!anchor || !container.clientHeight) return;
    source = String(source || '');
    if (container.tagName === 'TEXTAREA') {
      withMirror(container, (_, text) => {
        container.scrollTop = Math.max(0, charRect(text, Math.min(anchor.index, source.length)).top - anchor.offset);
      });
      binding.scrollTop = container.scrollTop;
      return;
    }
    root.NoteReadingRenderer?.get(container)?.ensureSourceLine(anchor.line);
    // In eager editing, bodies already exist; reveal the target's ancestors.
    container.querySelectorAll('details[data-source-line]').forEach(fold => {
      if (anchor.line > Number(fold.dataset.sourceLine) && anchor.line < Number(fold.dataset.sourceEnd) - 1) fold.open = true;
    });
    const matches = mappedElements(container).filter(element => Number(element.dataset.sourceLine) <= anchor.line && Number(element.dataset.sourceEnd) > anchor.line);
    matches.sort((a, b) => (Number(a.dataset.sourceEnd) - Number(a.dataset.sourceLine)) - (Number(b.dataset.sourceEnd) - Number(b.dataset.sourceLine)));
    const element = matches[0];
    if (!element) return;
    let top = element.getBoundingClientRect().top;
    if (anchor.quote) {
      for (const node of textNodes(element)) {
        const index = node.textContent.indexOf(anchor.quote);
        if (index >= 0) { top = charRect(node, index).top; break; }
      }
    }
    container.scrollTop += top - container.getBoundingClientRect().top - anchor.offset;
    binding.scrollTop = container.scrollTop;
    root.NoteReadingRenderer?.get(container)?.refresh();
  }

  root.NoteViewPosition = { capture, restore };
})(window);
