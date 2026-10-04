// Reading-only rendering. Markdown remains authoritative; the rich editor never
// serializes placeholders or deferred fold bodies.
(function (root) {
  'use strict';
  const controllers = new WeakMap();

  function mount(container, source, note) {
    const previous = controllers.get(container);
    if (previous?.source === source && previous.noteId === note.id && !note._annotations?.length) {
      Object.assign(previous.plan.foldStates, note._foldStates || {});
      container.querySelectorAll('details.note-fold').forEach(fold => { fold.open = !!previous.plan.foldStates[fold.dataset.foldIndex]; });
      previous.refresh();
      return previous;
    }
    previous?.dispose();
    // Footnotes and annotation offsets need whole-document processing.
    if (!root.StudyMarkdown?.createReadingPlan || /\[\^[^\]]+\]/.test(source) || note._annotations?.length) {
      controllers.delete(container);
      delete container.dataset.readingVirtual;
      container.innerHTML = root.formatNoteContent(source, note);
      root.applyNoteFoldStates?.(container, note.id);
      return null;
    }
    const plan = root.StudyMarkdown.createReadingPlan(source, { foldStates: { ...(note._foldStates || {}) } });
    if (!plan) return null;
    const virtual = plan.blocks.length > 60;
    let frame = 0, disposed = false, pinned = false;
    const cache = new Map();
    container.dataset.noteId = String(note.id);
    container.tabIndex = 0;
    container.dataset.readingVirtual = String(virtual);
    container.style.overflowAnchor = 'none';
    container.replaceChildren();
    const slots = virtual ? plan.blocks.map((block, index) => {
      const slot = document.createElement('div');
      slot.dataset.readingBlock = String(index);
      const maps = block.tokens.filter(token => token.map);
      slot.dataset.sourceLine = Math.min(...maps.map(token => token.map[0]));
      slot.dataset.sourceEnd = Math.max(...maps.map(token => token.map[1]));
      slot.style.display = 'flow-root';
      container.appendChild(slot);
      return slot;
    }) : [];

    function estimate(index) {
      const block = plan.blocks[index];
      const fold = block.tokens.find(token => token.type === 'collapsible_block');
      if (fold && !plan.foldStates[fold.meta.readingFoldId]) return 52;
      const style = getComputedStyle(container);
      const fontSize = parseFloat(style.fontSize) || 15;
      const width = Math.max(200, container.clientWidth - 48);
      const chars = Math.max(16, Math.floor(width / fontSize));
      const lines = block.text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / chars)), 0);
      return Math.max(42, lines * (parseFloat(style.lineHeight) || fontSize * 1.8) + 20);
    }

    function placeholder(index, height) {
      const slot = slots[index];
      slot.style.height = Math.max(1, height) + 'px';
      slot.style.overflow = 'hidden';
      slot.style.color = 'transparent';
      slot.textContent = plan.blocks[index].text;
      delete slot.dataset.rendered;
    }

    function hydrateFold(fold) {
      if (!fold?.hasAttribute('data-lazy-fold')) return;
      fold.querySelector(':scope > .note-fold-body').innerHTML = plan.renderFold(fold.dataset.lazyFold);
      fold.removeAttribute('data-lazy-fold');
      hydrateOpenFolds(fold);
    }

    function hydrateOpenFolds(parent) {
      parent.querySelectorAll('details.note-fold[open][data-lazy-fold]').forEach(hydrateFold);
    }

    function rememberStates(parent) {
      parent.querySelectorAll('details.note-fold').forEach(fold => { plan.foldStates[fold.dataset.foldIndex] = fold.open; });
    }

    function render(index) {
      const slot = slots[index];
      if (slot.dataset.rendered) return;
      slot.style.height = '';
      slot.style.overflow = '';
      slot.style.color = '';
      slot.innerHTML = cache.get(index) || plan.renderBlock(index);
      slot.querySelectorAll('details.note-fold').forEach(fold => { fold.open = !!plan.foldStates[fold.dataset.foldIndex]; });
      slot.dataset.rendered = 'true';
      hydrateOpenFolds(slot);
    }

    function refresh() {
      if (disposed || frame) return;
      frame = requestAnimationFrame(update);
    }

    function update() {
      frame = 0;
      if (disposed || !container.clientHeight) return;
      if (!virtual) { hydrateOpenFolds(container); return; }
      const bounds = container.getBoundingClientRect();
      const buffer = container.clientHeight;
      // Read geometry before changing DOM to avoid repeated layout work.
      const rects = slots.map(slot => slot.getBoundingClientRect());
      const anchor = rects.findIndex(rect => rect.bottom > bounds.top && rect.top < bounds.bottom);
      const anchorTop = anchor >= 0 ? rects[anchor].top : 0;
      const selection = getSelection();
      const selecting = selection && !selection.isCollapsed && container.contains(selection.anchorNode);
      rects.forEach((rect, index) => {
        if (pinned || (rect.bottom >= bounds.top - buffer && rect.top <= bounds.bottom + buffer)) render(index);
        else if (!selecting && slots[index].dataset.rendered) {
          rememberStates(slots[index]);
          cache.set(index, slots[index].innerHTML);
          if (cache.size > 24) cache.delete(cache.keys().next().value);
          placeholder(index, rect.height);
        }
      });
      if (anchor >= 0) container.scrollTop += slots[anchor].getBoundingClientRect().top - anchorTop;
    }

    function materializeAll(includeClosed = false) {
      pinned = true;
      const bounds = container.getBoundingClientRect();
      const anchor = virtual ? slots.find(slot => slot.getBoundingClientRect().bottom > bounds.top) : null;
      const anchorTop = anchor?.getBoundingClientRect().top;
      if (virtual) slots.forEach((_, index) => render(index));
      hydrateOpenFolds(container);
      if (includeClosed) container.querySelectorAll('[data-lazy-fold]').forEach(hydrateFold);
      if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }

    function ensureHeading(id) {
      const heading = plan.headings.find(item => item.id === id);
      if (!heading) return null;
      if (virtual) {
        // Resolve nearby heights before computing a jump destination; replacing
        // an estimated paragraph above the heading must not hide its first line.
        for (let index = Math.max(0, heading.blockIndex - 12); index <= Math.min(slots.length - 1, heading.blockIndex + 12); index++) render(index);
      }
      heading.ancestors.forEach(index => {
        const fold = container.querySelector('details[data-fold-index="' + index + '"]');
        if (fold) { fold.open = true; plan.foldStates[index] = true; hydrateFold(fold); }
      });
      return container.querySelector('#' + CSS.escape(id));
    }

    function getHeadings() {
      return plan.headings.map(heading => ({ ...heading,
        get offsetTop() {
          const element = container.querySelector('#' + CSS.escape(heading.id));
          const rect = (element || slots[heading.blockIndex] || container).getBoundingClientRect();
          return container.scrollTop + rect.top - container.getBoundingClientRect().top;
        },
        getBoundingClientRect: () => {
          const element = container.querySelector('#' + CSS.escape(heading.id));
          return (element || slots[heading.blockIndex] || container).getBoundingClientRect();
        }
      }));
    }

    function ensureSourceLine(line) {
      if (virtual) {
        const index = slots.findIndex(slot => Number(slot.dataset.sourceLine) <= line && Number(slot.dataset.sourceEnd) > line);
        if (index >= 0) {
          for (let nearby = Math.max(0, index - 12); nearby <= Math.min(slots.length - 1, index + 12); nearby++) render(nearby);
        }
      }
      // Hydrate ancestors one level at a time, including nested closed folds.
      let changed;
      do {
        changed = false;
        container.querySelectorAll('details[data-source-line]').forEach(fold => {
          if (line > Number(fold.dataset.sourceLine) && line < Number(fold.dataset.sourceEnd) - 1 && !fold.open) {
            fold.open = true;
            plan.foldStates[fold.dataset.foldIndex] = true;
            hydrateFold(fold);
            changed = true;
          }
        });
      } while (changed);
      refresh();
    }

    function onToggle(event) {
      if (!event.target.matches('details.note-fold')) return;
      const fold = event.target;
      plan.foldStates[fold.dataset.foldIndex] = fold.open;
      if (fold.open) hydrateFold(fold);
      refresh();
    }
    function onClick(event) {
      const summary = event.target.closest('summary');
      if (summary && container.contains(summary) && !summary.parentElement.open) hydrateFold(summary.parentElement);
      const anchor = event.target.closest('a[href^="#"]');
      if (anchor) {
        const target = ensureHeading(decodeURIComponent(anchor.hash.slice(1)));
        if (target) { event.preventDefault(); target.scrollIntoView({ block: 'start' }); }
      }
    }
    function onPointerDown(event) {
      // Text selection/copy needs every selected paragraph, not placeholders.
      if (!event.target.closest('summary, a, button, input')) materializeAll();
    }
    function onKeyDown(event) {
      if ((event.ctrlKey || event.metaKey) && ['a', 'f'].includes(event.key.toLowerCase())) materializeAll();
    }
    function onDocumentKeyDown(event) {
      if (container.clientHeight && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') materializeAll(true);
    }
    function onPrint() { if (container.clientHeight) materializeAll(true); }
    function onSelectionChange() {
      if (getSelection()?.isCollapsed) { pinned = false; refresh(); }
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
    observer?.observe(container);
    container.addEventListener('scroll', refresh, { passive: true });
    container.addEventListener('toggle', onToggle, true);
    container.addEventListener('click', onClick);
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('keydown', onKeyDown);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('beforeprint', onPrint);
    if (virtual) {
      slots.forEach((_, index) => placeholder(index, estimate(index)));
      // Render only the first window synchronously; layout after activation
      // fills the real viewport, including a restored scroll position.
      for (let index = 0; index < Math.min(8, slots.length); index++) render(index);
    } else container.innerHTML = plan.blocks.map((_, index) => plan.renderBlock(index)).join('');
    hydrateOpenFolds(container);
    refresh();
    const controller = { source, noteId: note.id, plan, refresh, ensureHeading, ensureSourceLine, getHeadings, materializeAll,
      dispose() {
        disposed = true;
        cancelAnimationFrame(frame);
        observer?.disconnect();
        container.removeEventListener('scroll', refresh);
        container.removeEventListener('toggle', onToggle, true);
        container.removeEventListener('click', onClick);
        container.removeEventListener('pointerdown', onPointerDown);
        container.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('selectionchange', onSelectionChange);
        document.removeEventListener('keydown', onDocumentKeyDown, true);
        window.removeEventListener('beforeprint', onPrint);
      }
    };
    controllers.set(container, controller);
    return controller;
  }
  root.NoteReadingRenderer = { mount, get: container => controllers.get(container) };
})(window);
