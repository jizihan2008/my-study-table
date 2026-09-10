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
  userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-ai-stream-e2e-'));
  electronApp = await electron.launch({
    args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath }
  });
  page = await electronApp.firstWindow();
  await page.waitForFunction(() => document.readyState !== 'loading' && !!window.AIStream && typeof window.setAiStreamingDraft === 'function');
});

test.afterAll(async () => {
  if (electronApp) await electronApp.close();
  if (userDataPath) await fs.rm(userDataPath, { recursive: true, force: true });
});

test('streaming draft batches incremental updates and becomes Markdown only after completion', async () => {
  const result = await page.evaluate(async () => {
    window.switchTab('ai');
    const conv = window.getActiveConv();
    window.setAiLoading(conv.id, true);
    window.setAiStreamingDraft(conv.id, { content: '# 尚未完成', reasoning: '正在分析', keyName: '测试 Key' });
    window.setAiStreamingDraft(conv.id, { content: '# 尚未完成\n第二段', reasoning: '分析完成', keyName: '测试 Key' });
    const immediateText = document.querySelector('#aiStreamingDraft .ai-streaming-content')?.textContent;
    await new Promise(resolve => setTimeout(resolve, 60));
    const draft = document.getElementById('aiStreamingDraft');
    const output = {
      text: draft?.querySelector('.ai-streaming-content')?.textContent,
      immediateText,
      reasoning: draft?.querySelector('.ai-streaming-reasoning-text')?.textContent,
      renderedHeadingDuringStream: !!draft?.querySelector('h1'),
      live: draft?.getAttribute('aria-live')
    };
    window.clearAiStreamingDraft(conv.id);
    window.setAiLoading(conv.id, false);
    output.cleared = !document.getElementById('aiStreamingDraft');
    return output;
  });

  expect(result).toEqual({
    text: '# 尚未完成\n第二段',
    immediateText: '# 尚未完成',
    reasoning: '分析完成',
    renderedHeadingDuringStream: false,
    live: 'polite',
    cleared: true
  });
});

test('browser API client consumes OpenAI-compatible SSE deltas', async () => {
  await page.route('https://api.openai.com/v1/chat/completions', async route => {
    const requestBody = route.request().postDataJSON();
    expect(requestBody.stream).toBe(true);
    expect(requestBody.stream_options).toEqual({ include_usage: true });
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'data: {"choices":[{"delta":{"content":"流"}}]}',
        '',
        'data: {"choices":[{"delta":{"content":"式"},"finish_reason":"stop"}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}',
        '',
        'data: [DONE]',
        ''
      ].join('\n')
    });
  });

  const result = await page.evaluate(async () => {
    const seen = [];
    const output = await window.callAiApi(
      [{ role: 'user', content: '测试' }],
      { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-key', model: 'gpt-4o-mini', temperature: 0.2, timeoutMs: 5000 },
      null,
      { onDelta: snapshot => seen.push(snapshot.content) }
    );
    return { text: output.cleanText, finishReason: output.finishReason, seen };
  });

  expect(result).toEqual({ text: '流式', finishReason: 'stop', seen: ['流', '流式'] });
});
