'use strict';

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildTestPdf } = require('../fixtures/books-pdf');

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

test('regeneration through real tool loop persists its final answer', async () => {
  let calls = 0;
  await page.route('https://ai-test.invalid/v1/chat/completions', async route => {
    calls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: calls === 1
        ? '<tool_call>{"action":"list_todos","params":{}}</tool_call>'
        : '这是工具查询后的最终回答。' }, finish_reason: 'stop' }] })
    });
  });
  const output = await page.evaluate(async () => {
    window.switchTab('ai');
    window.createNewConv();
    const conv = window.getActiveConv();
    const nodeId = window.appendMessage(conv, { role: 'user', content: '查看待办后总结' });
    await window.regenerateFromUserNode(conv, nodeId, {
      apiKey: 'fake', name: '原始模型', model: 'test-model', baseUrl: 'https://ai-test.invalid/v1', contextBudget: 32768
    });
    return { final: conv.messages.at(-1).content, count: conv.messages.filter(m => m.content === '这是工具查询后的最终回答。').length,
      keyName: conv.messages.at(-1).keyName, loading: window.isAiLoading(conv.id) };
  });
  expect(calls).toBe(2);
  expect(output).toEqual({ final: '这是工具查询后的最终回答。', count: 1, keyName: '原始模型', loading: false });
  await expect(page.locator('#aiMessages')).toContainText('这是工具查询后的最终回答。');
  await expect(page.locator('#aiMessages .ai-tool-status.success')).toContainText('list_todos');
});

test('context budget can be saved and new key form restores its default', async () => {
  const output = await page.evaluate(() => {
    window.showApiKeyForm();
    const set = (id, value) => { document.getElementById(id).value = value; };
    set('apiKeyFormName', '上下文测试');
    set('apiKeyFormKey', 'fake-context-key');
    set('apiKeyFormModel', 'test-model');
    set('apiKeyFormContextBudget', '65536');
    window.submitApiKeyForm();
    const key = window.loadApiKeys().find(k => k.name === '上下文测试');
    window.showApiKeyForm(key.id);
    const edited = document.getElementById('apiKeyFormContextBudget').value;
    const effective = window.getEffectiveApiConfig(key.id).contextBudget;
    window.showApiKeyForm();
    return { edited, effective, reset: document.getElementById('apiKeyFormContextBudget').value };
  });
  expect(output).toEqual({ edited: '65536', effective: 65536, reset: '32768' });
});

test('switching conversations during attachment reading preserves the new draft and attachments', async () => {
  await page.route('https://attachment-test.invalid/v1/chat/completions', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '附件已处理' }, finish_reason: 'stop' }] })
  }));
  const output = await page.evaluate(async () => {
    const OriginalReader = window.FileReader;
    const originalConfig = window.getEffectiveApiConfig;
    const originalTitle = window.isAutoTitleEnabled;
    let release;
    window.FileReader = class { readAsText() { release = () => this.onload({ target: { result: '附件正文' } }); } };
    window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'test', name: '附件测试', baseUrl: 'https://attachment-test.invalid/v1' });
    window.isAutoTitleEnabled = () => false;
    try {
      window.createNewConv();
      const origin = window.getActiveConv();
      window.addAiAttachmentFiles([new File(['first'], 'first.txt', { type: 'text/plain' })]);
      document.getElementById('aiInput').value = '分析附件';
      const sending = window.sendAiMessage();
      const lockedDuringRead = window.isAiLoading(origin.id);
      window.createNewConv();
      const targetId = window.getActiveConvId();
      document.getElementById('aiInput').value = '另一对话的草稿';
      window.addAiAttachmentFiles([new File(['second'], 'second.txt', { type: 'text/plain' })]);
      release();
      await sending;
      return { lockedDuringRead, draft: document.getElementById('aiInput').value,
        retainedAttachment: document.getElementById('aiAttachPreview').textContent.includes('second.txt'),
        stayedInTarget: window.getActiveConvId() === targetId, final: origin.messages.at(-1).content };
    } finally {
      window.FileReader = OriginalReader;
      window.getEffectiveApiConfig = originalConfig;
      window.isAutoTitleEnabled = originalTitle;
    }
  });
  expect(output).toEqual({ lockedDuringRead: true, draft: '另一对话的草稿', retainedAttachment: true, stayedInTarget: true, final: '附件已处理' });
});

test('one-time reminder date and reason can be viewed and edited', async ({}, testInfo) => {
  const output = await page.evaluate(async () => {
    const conv = window.getActiveConv();
    await window.executeToolCall('schedule_automation', { at: '09:30', date: '2099-09-12', prompt: '提醒提交作业', reason: '用户要求提交前提醒' }, { conv });
    window.openSettingsModal();
    window.switchSettingsTab('automation');
    window.renderAutomationList();
    const created = JSON.parse(localStorage.getItem('study_automations')).at(-1);
    window.showAutomationForm(created.id);
    const before = { date: document.getElementById('autoFormDate').value, reason: document.getElementById('autoFormReason').value };
    document.getElementById('autoFormDate').value = '2099-09-13';
    document.getElementById('autoFormReason').value = '作业延期一天';
    window.submitAutomationForm();
    const saved = JSON.parse(localStorage.getItem('study_automations')).find(a => a.id === created.id);
    return { before, date: saved.date, reason: saved.reason, repeat: saved.repeat, list: document.getElementById('automationList').textContent };
  });
  expect(output.before).toEqual({ date: '2099-09-12', reason: '用户要求提交前提醒' });
  expect(output).toMatchObject({ date: '2099-09-13', reason: '作业延期一天', repeat: 'once' });
  expect(output.list).toContain('2099-09-13');
  expect(output.list).toContain('作业延期一天');
  await page.screenshot({ path: testInfo.outputPath('automation-settings.png') });
});

test('images attach to deepseek-flash and reach the API as base64 image_url blocks', async () => {
  // 1×1 红色 PNG：真实可解码，用于验证「预处理 → 内联 base64 → 内容块」整条链路
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  let requestBody = null;
  await page.route('https://vision-test.invalid/v1/chat/completions', route => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '图中是一个红色像素' }, finish_reason: 'stop' }] })
    });
  });
  const output = await page.evaluate(async ({ pngBase64 }) => {
    const originalConfig = window.getEffectiveApiConfig;
    const originalTitle = window.isAutoTitleEnabled;
    const bin = atob(pngBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    window.getEffectiveApiConfig = () => ({
      apiKey: 'fake', model: 'deepseek-flash', name: '视觉测试',
      baseUrl: 'https://vision-test.invalid/v1', contextLimit: 20, contextBudget: 32768
    });
    window.isAutoTitleEnabled = () => false;
    try {
      window.createNewConv();
      // 清掉前面用例残留的待发附件，保证本用例断言的是这一张图
      while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
      const conv = window.getActiveConv();
      window.addAiAttachmentFiles([new File([bytes], 'shot.png', { type: 'image/png' })]);
      // 等本地图片预处理完成（轮询而不是固定等待，避免机器忙时假失败）
      for (let i = 0; i < 60; i++) {
        const s = window.getAiAttachmentsSnapshot()[0];
        if (s && !s.imageProcessing) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const pending = window.getAiAttachmentsSnapshot();
      const preview = document.getElementById('aiAttachPreview');
      const accepted = {
        count: pending.length,
        hasDataUrl: pending.length === 1 && pending[0].hasDataUrl,
        processed: pending.length === 1 && pending[0].imageProcessing === false,
        inlineHint: preview.textContent.includes('内联'),
        hasThumb: !!preview.querySelector('img.preview-thumb')
      };
      document.getElementById('aiInput').value = '这张图里有什么？';
      await window.sendAiMessage();
      const node = conv.messages.find(m => m.role === 'user' && m.visionFiles && m.visionFiles.length);
      return {
        accepted,
        visionFiles: node ? node.visionFiles.map(v => ({ type: v.type, prefix: v.dataUrl.slice(0, 22) })) : null,
        thumbnailInBubble: !!document.querySelector('#aiMessages .msg-attachment-img img')
      };
    } finally {
      window.getEffectiveApiConfig = originalConfig;
      window.isAutoTitleEnabled = originalTitle;
    }
  }, { pngBase64: PNG_BASE64 });

  expect(output.accepted).toEqual({ count: 1, hasDataUrl: true, processed: true, inlineHint: true, hasThumb: true });
  expect(output.visionFiles).toEqual([{ type: 'image_url', prefix: 'data:image/png;base64,' }]);
  expect(output.thumbnailInBubble).toBe(true);
  // 真正发出去的请求体：user 消息为内容块数组，含 text + image_url(base64)
  const userMessage = requestBody.messages.find(m => m.role === 'user' && Array.isArray(m.content));
  expect(Array.isArray(userMessage.content)).toBe(true);
  expect(userMessage.content[0].type).toBe('text');
  expect(userMessage.content[0].text).toContain('这张图里有什么？');
  expect(userMessage.content[1].type).toBe('image_url');
  expect(userMessage.content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
  expect(requestBody.model).toBe('deepseek-flash');
});

test('pasting files into the chat area attaches them, while plain text paste stays native', async () => {
  const output = await page.evaluate(async () => {
    const originalConfig = window.getEffectiveApiConfig;
    const previousKeys = window.loadApiKeys();
    // 未配置 API Key 时输入框整体只读（粘贴入口主动让行）→ 这里先补一个 Key 再重渲染，结束后还原
    window.saveApiKeys([{ id: 'e2e-paste', name: '粘贴测试', apiKey: 'fake', baseUrl: 'https://paste-test.invalid/v1', model: 'deepseek-flash' }]);
    window.switchTab('ai');
    window.createNewConv();
    while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
    window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash', name: '粘贴测试', baseUrl: 'https://paste-test.invalid/v1' });
    window.renderAiChat();
    const input = document.getElementById('aiInput');

    const firePaste = (target, dataTransfer) => {
      const event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const filesTransfer = files => {
      const dt = new DataTransfer();
      files.forEach(file => dt.items.add(file));
      return dt;
    };

    const out = { inputEnabled: !input.disabled };
    try {
      // ① 从文件管理器复制的普通文件（非图片）→ 与文件选择框同一条附件路径
      out.textPrevented = firePaste(input, filesTransfer([new File(['粘贴的文本附件'], 'pasted-note.txt', { type: 'text/plain' })]));
      out.textNames = window.getAiAttachmentsSnapshot().map(a => a.name);
      out.previewHasName = document.getElementById('aiAttachPreview').textContent.includes('pasted-note.txt');

      // ② 截图（无文件名）→ 按 MIME 补出扩展名正确的名字，不能一律补 .png
      out.imagePrevented = firePaste(input, filesTransfer([new File([new Uint8Array([1, 2, 3, 4])], '', { type: 'image/jpeg' })]));
      const names = window.getAiAttachmentsSnapshot().map(a => a.name);
      out.pastedImageName = names[names.length - 1];

      // ③ 纯文本粘贴（无文件）→ 完全走原生，不接管、不加附件
      const textOnly = new DataTransfer();
      textOnly.setData('text/plain', '纯文本粘贴');
      out.textOnlyPrevented = firePaste(input, textOnly);
      out.countAfterTextOnly = window.getAiAttachmentsSnapshot().length;

      // ④ 文件 + 文本同时存在（网页 / Office 复制）→ 文件进附件，文字照常进输入框
      const combo = filesTransfer([new File(['x'], 'combo.txt', { type: 'text/plain' })]);
      combo.setData('text/plain', '同时粘贴的文字');
      out.comboPrevented = firePaste(input, combo);
      out.comboInputValue = input.value;
      out.comboNames = window.getAiAttachmentsSnapshot().map(a => a.name);

      // ⑤ 焦点不在输入框（body 拿到焦点）但 AI 栏目激活 → 仍然接管
      const beforeBodyPaste = window.getAiAttachmentsSnapshot().length;
      out.bodyPrevented = firePaste(document.body, filesTransfer([new File(['y'], 'body-paste.txt', { type: 'text/plain' })]));
      out.bodyAdded = window.getAiAttachmentsSnapshot().length - beforeBodyPaste;

      // ⑥ 切到别的栏目后，body 上的粘贴不该被 AI 抢走
      window.switchTab('todo');
      const beforeOutside = window.getAiAttachmentsSnapshot().length;
      out.outsidePrevented = firePaste(document.body, filesTransfer([new File(['z'], 'outside.txt', { type: 'text/plain' })]));
      out.outsideAdded = window.getAiAttachmentsSnapshot().length - beforeOutside;
      return out;
    } finally {
      window.switchTab('ai');
      window.getEffectiveApiConfig = originalConfig;
      window.saveApiKeys(previousKeys);
      window.renderAiChat();
      while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
    }
  });

  expect(output.inputEnabled).toBe(true);
  // 文件粘贴：接管（阻止默认的二进制/文件名插入）并进入附件列表
  expect(output.textPrevented).toBe(true);
  expect(output.textNames).toEqual(['pasted-note.txt']);
  expect(output.previewHasName).toBe(true);
  // 截图：JPEG 补 .jpg（补成 .png 会让 data URL 的 MIME 与实际字节不符）
  expect(output.imagePrevented).toBe(true);
  expect(output.pastedImageName).toMatch(/^粘贴图片-\d+\.jpg$/);
  // 纯文本 / 其他栏目：不接管
  expect(output.textOnlyPrevented).toBe(false);
  expect(output.countAfterTextOnly).toBe(2);
  expect(output.outsidePrevented).toBe(false);
  expect(output.outsideAdded).toBe(0);
  // 文件 + 文本：附件与文字都不丢
  expect(output.comboPrevented).toBe(true);
  expect(output.comboInputValue).toContain('同时粘贴的文字');
  expect(output.comboNames).toEqual(['pasted-note.txt', output.pastedImageName, 'combo.txt']);
  // AI 栏目激活时，即使焦点不在输入框也能粘贴成附件
  expect(output.bodyPrevented).toBe(true);
  expect(output.bodyAdded).toBe(1);
});

test('large plain-text paste can become a named txt attachment or stay in the input', async () => {
  const previousKeys = await page.evaluate(() => {
    const keys = window.loadApiKeys();
    window.saveApiKeys([{ id: 'e2e-large-paste', name: '长文本粘贴测试', apiKey: 'fake', baseUrl: 'https://paste-test.invalid/v1', model: 'deepseek-chat' }]);
    window.switchTab('ai');
    window.createNewConv();
    window.renderAiChat();
    document.getElementById('aiInput').value = '';
    while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
    return keys;
  });

  try {
    const longText = '长文本内容'.repeat(500);
    const prevented = await page.evaluate(text => {
      const input = document.getElementById('aiInput');
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    }, longText);
    expect(prevented).toBe(true);
    await expect(page.locator('#aiLargePasteOverlay')).toHaveClass(/open/);
    await expect(page.locator('.ai-large-paste-summary')).toContainText(longText.length.toLocaleString());
    await page.locator('#aiLargePasteFileName').fill('课程笔记');
    await page.getByRole('button', { name: '作为 .txt 附件' }).click();
    await expect(page.locator('#aiLargePasteOverlay')).not.toHaveClass(/open/);

    const attached = await page.evaluate(() => ({
      items: window.getAiAttachmentsSnapshot(),
      input: document.getElementById('aiInput').value
    }));
    expect(attached.items).toHaveLength(1);
    expect(attached.items[0].name).toBe('课程笔记.txt');
    expect(attached.items[0].size).toBe(new Blob([longText]).size);
    expect(attached.input).toBe('');

    await page.evaluate(() => {
      window.removeAttachment(0);
      const input = document.getElementById('aiInput');
      input.value = '开头结尾';
      input.setSelectionRange(2, 2);
      const dt = new DataTransfer();
      dt.setData('text/plain', '甲'.repeat(2000));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.getByRole('button', { name: '直接粘贴' }).click();
    await expect.poll(() => page.locator('#aiInput').inputValue()).toBe('开头' + '甲'.repeat(2000) + '结尾');
    expect(await page.evaluate(() => window.getAiAttachmentsSnapshot().length)).toBe(0);
  } finally {
    await page.evaluate(keys => {
      window.saveApiKeys(keys);
      window.renderAiChat();
      while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
    }, previousKeys);
  }
});

test('PDF compatibility lets the user choose extracted text or rendered page images', async () => {
  const pdfBase64 = buildTestPdf(3).toString('base64');
  const output = await page.evaluate(async ({ pdfBase64 }) => {
    const originalConfig = window.getEffectiveApiConfig;
    window.getEffectiveApiConfig = () => ({ apiKey: 'fake', model: 'deepseek-flash', name: 'PDF 测试' });
    try {
      window.switchTab('ai');
      while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
      const bin = atob(pdfBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'test.pdf', { type: 'application/pdf' });
      window.addAiAttachmentFiles([file]);
      const defaultMode = window.getAiAttachmentsSnapshot()[0].pdfMode;
      const defaultPreview = document.getElementById('aiAttachPreview').textContent;
      const extracted = await window.extractPdfAttachmentText(file);
      window.toggleAttachPdfMode(0);
      const imageMode = window.getAiAttachmentsSnapshot()[0].pdfMode;
      const imagePreview = document.getElementById('aiAttachPreview').textContent;
      const rendered = await window.renderPdfAttachmentPages(file, { maxPages: 2, maxWidth: 600 });
      return {
        defaultMode,
        defaultPreview,
        extracted: extracted.text,
        pageCount: extracted.pageCount,
        imageMode,
        imagePreview,
        renderedPages: rendered.renderedPages,
        imagePrefixes: rendered.dataUrls.map(url => url.slice(0, 23))
      };
    } finally {
      window.getEffectiveApiConfig = originalConfig;
      while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
    }
  }, { pdfBase64 });

  expect(output.defaultMode).toBe('text');
  expect(output.defaultPreview).toContain('提取文字');
  expect(output.extracted).toContain('[第 1 页]');
  expect(output.extracted).toContain('Test Page 3');
  expect(output.pageCount).toBe(3);
  expect(output.imageMode).toBe('image');
  expect(output.imagePreview).toContain('页面图片');
  expect(output.renderedPages).toBe(2);
  expect(output.imagePrefixes).toEqual(['data:image/jpeg;base64,', 'data:image/jpeg;base64,']);
});

test('deepseek files api uploads a photo once and later turns reference the same file_id', async () => {
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  let uploads = 0;
  const chatBodies = [];
  await page.route('https://files-test.invalid/v1/files', route => {
    if (route.request().method() === 'POST') {
      uploads++;
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 'file-api-test1', object: 'file', bytes: 70, created_at: 1700000000, filename: 'photo.png', purpose: 'user_data' })
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ object: 'list', data: [] }) });
  });
  await page.route('https://files-test.invalid/v1/chat/completions', route => {
    chatBodies.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: '收到图片' }, finish_reason: 'stop' }] })
    });
  });
  const output = await page.evaluate(async ({ pngBase64 }) => {
    const originalConfig = window.getEffectiveApiConfig;
    const originalTitle = window.isAutoTitleEnabled;
    const bin = atob(pngBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // 让 Files API 判定把测试主机视为官方端点（真实环境只认 deepseek.com）
    window.__MST_FILE_API_TEST_HOSTS__ = ['files-test.invalid'];
    window.getEffectiveApiConfig = () => ({
      apiKey: 'fake', keyId: 'key-files', model: 'deepseek-flash', name: '文件服务测试',
      // Earlier E2E cases intentionally populate the live data snapshot. Give this
      // transport/reuse test enough room to retain the prior multimodal turn instead
      // of accidentally testing context eviction.
      baseUrl: 'https://files-test.invalid/v1', contextLimit: 20, contextBudget: 131072
    });
    window.isAutoTitleEnabled = () => false;
    try {
      window.setAiImageUploadMode('always'); // 小图也走上传，便于验证复用
      window.createNewConv();
      while (window.getAiAttachmentsSnapshot().length > 0) window.removeAttachment(0);
      window.addAiAttachmentFiles([new File([bytes], 'photo.png', { type: 'image/png' })]);
      for (let i = 0; i < 60; i++) {
        const s = window.getAiAttachmentsSnapshot()[0];
        if (s && !s.imageProcessing) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const afterAttach = window.getAiAttachmentsSnapshot()[0];
      const mode = window.getAiImageUploadMode();
      const support = window.supportsDeepSeekFilesApi(window.getEffectiveApiConfig());
      document.getElementById('aiInput').value = '第一次提问';
      await window.sendAiMessage();
      const firstNode = window.getActiveConv().messages.filter(m => m.role === 'user' && m.visionFiles && m.visionFiles.length).at(-1);
      // 第二轮：这次不带附件，但历史里的图片应继续以 file_id 发送
      document.getElementById('aiInput').value = '再详细说说';
      await window.sendAiMessage();
      return {
        strategy: afterAttach.imageStrategy,
        uploadFileId: afterAttach.uploadFileId,
        uploadError: afterAttach.uploadError,
        mode,
        support,
        previewText: document.getElementById('aiAttachPreview').textContent,
        firstTurn: firstNode.visionFiles.map(v => ({ type: v.type, fileId: v.fileId || null }))
      };
    } finally {
      window.setAiImageUploadMode('auto');
      window.__MST_FILE_API_TEST_HOSTS__ = [];
      window.getEffectiveApiConfig = originalConfig;
      window.isAutoTitleEnabled = originalTitle;
    }
  }, { pngBase64: PNG_BASE64 });

  expect(uploads).toBe(1); // 只在添加附件时上传一次
  expect(output.strategy).toBe('file');
  expect(output.uploadFileId).toBe('file-api-test1');
  expect(output.firstTurn).toEqual([{ type: 'file', fileId: 'file-api-test1' }]);

  const fileBlocks = body => body.messages
    .filter(m => Array.isArray(m.content))
    .flatMap(m => m.content.filter(part => part.type === 'file'));
  // 第一轮：file_id 引用 + 极小缩略图
  const first = fileBlocks(chatBodies[0]);
  expect(first.some(p => p.file_id === 'file-api-test1')).toBe(true);
  expect(first.some(p => typeof p.file_data === 'string' && p.file_data.startsWith('data:image/'))).toBe(true);
  // 第二轮：仍以同一个 file_id 引用，且没有任何整图 base64 被重发
  const second = fileBlocks(chatBodies[1]);
  expect(second.some(p => p.file_id === 'file-api-test1')).toBe(true);
  const allInline = chatBodies[1].messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(part => part.type === 'image_url');
  expect(allInline.length).toBe(0);
});
