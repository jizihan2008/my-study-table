const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ browserName: process.env.MST_TEST_BROWSER ? 'chromium' : 'webkit',
  channel: process.env.MST_TEST_BROWSER || undefined, hasTouch: true });

// Exercise the menu action without booting Electron so it also runs in WebKit.
const notesSource = fs.readFileSync(path.resolve('js/notes.js'), 'utf8');
const copyAction = notesSource.slice(notesSource.indexOf('async function copyNoteFoldFromMenu('),
  notesSource.indexOf('\nfunction editNoteFold(', notesSource.indexOf('async function copyNoteFoldFromMenu(')));
const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ZkAAAAASUVORK5CYII=';
const source = ':::fold 外层\n完整正文\n\n:::fold 内层\n嵌套正文\n\n'
  + `![缩放图](${imageUrl} "mst-image:37:right")\n:::\n:::`;

for (const secondary of [false, true]) {
  for (const cut of [false, true]) {
    test(`${secondary ? 'split' : 'main'} ${cut ? 'cut' : 'copy'} exposes all fold bodies to the system clipboard`, async ({ page }) => {
      const hostId = secondary ? 'notesSplitRichEditor' : 'notesRichEditor';
      await page.setContent(`<div id="${hostId}" contenteditable="true"></div>`);
      for (const file of ['lib/markdown/purify.min.js', 'lib/markdown/markdown-it.min.js', 'js/markdown.js', 'js/note-rich-editor.js']) {
        await page.addScriptTag({ path: path.resolve(file) });
      }
      await page.addScriptTag({ content: copyAction });
      const result = await page.evaluate(async ({ source, hostId, secondary, cut }) => {
        window.formatNoteContent = value => StudyMarkdown.render(value);
        const editor = secondary ? createRichNoteEditor({ hostId }) : RichNoteEditor;
        editor.init(); editor.setMarkdown(source, 'clipboard-test');
        const host = document.getElementById(hostId);
        window.noteFoldMenuTarget = { fold: host.querySelector('details') };
        window.closeNoteAiExplainMenu = () => {};
        window.getNoteFoldTargetEditor = () => editor;
        window.editNoteFold = target => editor.deleteFold(target.fold);
        window.showMiniToast = () => {};
        let payload;
        window.ClipboardItem = class { constructor(data) { this.data = data; } };
        Object.defineProperty(navigator, 'clipboard', { configurable: true,
          value: { write: async items => { payload = items[0].data; } } });
        await copyNoteFoldFromMenu(cut);
        const html = await payload['text/html'].text();
        const plain = await payload['text/plain'].text();
        const container = document.createElement('div'); container.innerHTML = html;
        const bodiesVisible = Array.from(container.querySelectorAll('details')).every(fold => fold.open);
        const sourceOpen = Array.from(host.querySelectorAll('details')).some(fold => fold.open);
        const remaining = host.querySelectorAll('details').length;
        // Model HTML wrappers added by system clipboards, with closed nested
        // folds as may be supplied by older app versions or native copying.
        container.querySelectorAll('details').forEach(fold => { fold.open = false; });
        host.innerHTML = '<p>前后</p>'; host.focus();
        const range = document.createRange(); range.setStart(host.firstChild.firstChild, 1); range.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        const clipboardData = { getData: type => type === 'text/html'
          ? '<div>' + container.innerHTML + '</div><p>附加段落</p>' : plain };
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: clipboardData });
        host.dispatchEvent(event);
        const image = host.querySelector('.note-fold .note-fold img');
        const imageLayout = image && {
          width: image.style.width,
          zoomWidth: image.style.getPropertyValue('--note-image-width'),
          marginLeft: image.style.marginLeft,
          marginRight: image.style.marginRight
        };
        return { bodiesVisible, sourceOpen, remaining, plain, pasted: editor.getMarkdown(), imageLayout };
      }, { source, hostId, secondary, cut });
      expect(result.bodiesVisible).toBe(true);
      expect(result.sourceOpen).toBe(false);
      expect(result.remaining).toBe(cut ? 0 : 2);
      expect(result.plain).toBe(source);
      expect(result.pasted).toContain(source);
      expect(result.pasted).toContain('附加段落');
      expect(result.pasted).toContain('前');
      expect(result.pasted).toContain('后');
      expect(result.imageLayout).toEqual({ width: '37%', zoomWidth: '37%', marginLeft: 'auto', marginRight: '0px' });
    });
  }
}
