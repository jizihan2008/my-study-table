'use strict';

const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-other-perf-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile }
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => typeof renderNoteList === 'function' && typeof renderAiMessages === 'function' && typeof escapeHtml === 'function');
    await page.waitForFunction(() => document.getElementById('section-today')?.classList.contains('active') && document.getElementById('todayWelcomeDate')?.textContent.length > 0);
    const result = await page.evaluate(async () => {
      const median = values => {
        const sorted = values.slice().sort((a, b) => a - b);
        return Number(sorted[Math.floor(sorted.length / 2)].toFixed(1));
      };
      const originalNotes = notes;
      const originalSearch = notesSearchQuery;
      const originalConvs = aiConvs;
      const originalConvId = activeConvId;
      const noteDurations = [];
      const aiDurations = [];
      try {
        const sampleNotes = [];
        for (let folder = 0; folder < 30; folder++) {
          const folderId = folder * 21 + 1;
          sampleNotes.push({ id: folderId, type: 'folder', title: `课程 ${folder}`, parentId: null });
          for (let child = 1; child <= 20; child++) {
            sampleNotes.push({ id: folderId + child, type: 'note', title: `Topic ${folder}-${child}`, content: 'Topic 课堂笔记内容。'.repeat(20), parentId: folderId, tags: [] });
          }
        }
        notes = sampleNotes;
        notesSearchQuery = 'topic';
        renderNoteList();
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          renderNoteList();
          noteDurations.push(performance.now() - start);
        }

        switchTab('ai');
        const messages = [];
        for (let i = 0; i < 300; i++) {
          messages.push({ role: i % 2 ? 'assistant' : 'user', content: `历史消息 ${i}：这是测试用的 Markdown 内容。`, time: '10:00' });
        }
        aiConvs = [{ id: 987654, title: '性能测试', messages, systemPrompt: '' }];
        activeConvId = 987654;
        renderAiChat();
        for (let i = 0; i < 5; i++) {
          const start = performance.now();
          renderAiMessages();
          aiDurations.push(performance.now() - start);
        }
        return {
          notes: sampleNotes.length,
          noteSearchMedianMs: median(noteDurations),
          aiMessages: messages.length,
          aiRenderMedianMs: median(aiDurations)
        };
      } finally {
        notes = originalNotes;
        notesSearchQuery = originalSearch;
        aiConvs = originalConvs;
        activeConvId = originalConvId;
        renderNoteList();
        renderAiChat();
      }
    });
    const storage = await page.evaluate(async () => {
      for (let i = 0; i < 120; i++) localStorage.setItem(`perf-data-${i}`, 'x'.repeat(10000));
      const coldStart = performance.now();
      const cold = await StudyData.initialize();
      const coldMs = performance.now() - coldStart;
      const warmStart = performance.now();
      const warm = await StudyData.initialize();
      return { keys: 120, coldCopied: cold.copied, warmCopied: warm.copied, coldMs: Number(coldMs.toFixed(1)), warmMs: Number((performance.now() - warmStart).toFixed(1)) };
    });
    console.log(JSON.stringify({ ...result, storage }));
  } finally {
    if (app) await app.close();
    const realProfile = await fs.realpath(profile);
    const realTemp = await fs.realpath(os.tmpdir());
    if (path.dirname(realProfile) !== realTemp || !path.basename(realProfile).startsWith('mst-other-perf-')) {
      throw new Error('Refusing to remove an unexpected benchmark profile path');
    }
    await fs.rm(realProfile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
