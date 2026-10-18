'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
let app, page, profile, outputRoot, imageFile, chatId;
const date = '2026-10-17';

test.beforeAll(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-qq-images-'));
  outputRoot = path.join(profile, 'exports');
  imageFile = path.join(outputRoot, 'resources', 'images', 'notice.png');
  await fs.mkdir(path.dirname(imageFile), { recursive: true });
  app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'], env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: profile } });
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 }).toPNG().toString('base64'));
  await fs.writeFile(imageFile, Buffer.from(png, 'base64'));
  const raw = (id, text) => ({ id, timestamp: Date.UTC(2026, 9, 17, 9), sender: { uin: '200', name: '同学' }, type: 'image', content: { text } });
  const json = { chatInfo: { type: 'group', name: '图片测试群', peerUin: 'media-test' }, messages: [raw('notice', '[图片:notice.png]'), raw('missing', '[图片:missing.png]')] };
  json.messages[0].content.resources = [{ type: 'image', filename: 'notice.png', localPath: 'images/notice.png', url: 'resources/images/notice.png', width: 1, height: 1 }];
  json.messages[0].content.elements = [{ type: 'image', data: { ...json.messages[0].content.resources[0], md5: 'image-hash' } }];
  json.messages[1].content.resources = [{ type: 'image', filename: 'missing.png', localPath: 'images/missing.png' }];
  await fs.writeFile(path.join(outputRoot, 'chat.json'), JSON.stringify(json));
  const old = new Date(Date.now() - 10000);
  await fs.utimes(path.join(outputRoot, 'chat.json'), old, old);
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.QQChats && !!window.Inbox);
  await expect(page.locator('#section-today')).toBeVisible();
  chatId = await page.evaluate(async data => {
    const legacy = JSON.parse(JSON.stringify(data));
    legacy.messages.forEach(m => { delete m.content.resources; delete m.content.elements; });
    const result = await QQChats.importJsonData(legacy);
    await QQChats.setDailyReport(result.chatId, '2026-10-17', { report: '- 旧的文字日报 (m0)', items: [] });
    switchTab('inbox');
    return result.chatId;
  }, json);
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, outputRoot);
  const selected = await page.evaluate(() => electronAPI.qqchatQCEPickRoot());
  expect(selected.ok).toBe(true);
});
test.afterAll(async () => {
  if (app) await app.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});

test('automatic export backfills image metadata without duplicate messages and preserves managed copies', async () => {
  const configured = await page.evaluate(root => electronAPI.qqchatQCEConfigure({ enabled: true, mode: 'native', outputRoot: root }), outputRoot);
  expect(configured.ok).toBe(true);
  await page.evaluate(() => electronAPI.qqchatQCERescanImages());
  await expect.poll(() => page.evaluate(async id => {
    const m = await QQChats.getMessage(id, 0);
    return m && m.images && m.images[0] && m.images[0].cacheKey || '';
  }, chatId)).toMatch(/^[a-f0-9]{64}$/);
  const stored = await page.evaluate(async id => ({ messages: await QQChats.getAllMessages(id), chat: (await QQChats.listChats()).find(c => c.chatId === id) }), chatId);
  expect(stored.messages).toHaveLength(2);
  expect(stored.messages[0].images).toHaveLength(1);
  expect(stored.messages[0].resources).toHaveLength(1);
  expect(stored.messages[0].elements).toHaveLength(1);
  expect(stored.chat.dailyReports[0].stale).toBe(true);
  await fs.unlink(imageFile);
  await page.evaluate(id => Inbox.openChat(id), chatId);
  await expect(page.locator('.chat-image-thumb img').first()).toHaveJSProperty('naturalWidth', 1);
  await expect(page.locator('.chat-image-missing')).toHaveCount(1);
  await page.locator('.chat-image-thumb').first().click();
  await expect(page.locator('.chat-image-original')).toHaveJSProperty('naturalWidth', 1);
  await page.evaluate(() => Inbox.closeModal());
  const reloaded = await page.evaluate(async id => {
    const image = (await QQChats.getMessage(id, 0)).images[0];
    return electronAPI.qqchatReadImage(image, 0);
  }, chatId);
  expect(reloaded.ok).toBe(true);
  await fs.mkdir('test-results/qq-images', { recursive: true });
  await page.locator('#inboxApp').screenshot({ path: 'test-results/qq-images/chat-images.png' });
});

test('daily report sends actual image bytes and uses their understanding with source markers', async () => {
  await page.evaluate(() => {
    window.__imageCalls = [];
    window.getEffectiveApiConfig = () => ({ apiKey: 'test-only', model: 'vision-fixture' });
    window.isMultimodalModel = () => true;
    window.callAiApi = async (messages, cfg, unused, opts) => {
      window.__imageCalls.push({ messages, feature: opts.feature });
      if (opts.feature === 'inbox_image_understanding') {
        const keys = messages[1].content.filter(p => p.type === 'text').map(p => (p.text.match(/图片标识 (m\d+-img\d+)/) || [])[1]).filter(Boolean);
        return { cleanText: JSON.stringify({ captions: keys.map(key => ({ key, text: '明天上午九点物理课，携带实验报告' })) }) };
      }
      return { cleanText: '- 明天九点物理课，携带实验报告 (m0)' };
    };
  });
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(id => Inbox.chatRegenerateDaily(id, '2026-10-17'), chatId);
  const result = await page.evaluate(async id => ({ report: (await QQChats.listChats()).find(c => c.chatId === id).dailyReports[0], calls: window.__imageCalls }), chatId);
  expect(result.report.imageAnalysis).toMatchObject({ total: 2, understood: 1, missing: 1, failed: 0 });
  const vision = result.calls.find(c => c.feature === 'inbox_image_understanding');
  expect(vision.messages[1].content.find(p => p.type === 'image_url').image_url.url).toMatch(/^data:image\/png;base64,/);
  const reportCall = result.calls.find(c => c.feature === 'inbox_daily_report');
  expect(reportCall.messages[1].content).toContain('明天上午九点物理课，携带实验报告');
  expect(reportCall.messages[1].content).toContain('(m0)');
  await expect(page.locator('.chat-image-analysis')).toContainText('已理解 1/2 张图片');
  await expect(page.locator('.chat-image-analysis')).toContainText('缺图 1 张');
});

test('unsupported models and disabled vision report their actual coverage and preserve settings', async () => {
  await page.evaluate(() => { window.__imageCalls = []; window.isMultimodalModel = () => false; });
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(id => Inbox.chatRegenerateDaily(id, '2026-10-17'), chatId);
  await expect(page.locator('.chat-image-analysis')).toContainText('当前模型不支持看图');
  expect(await page.evaluate(() => window.__imageCalls.some(c => c.feature === 'inbox_image_understanding'))).toBe(false);
  await page.locator('.chat-image-settings summary').click();
  await page.locator('.chat-image-settings input[type=checkbox]').uncheck();
  await page.locator('.chat-image-settings input[type=number]').fill('2');
  await page.locator('.chat-image-settings input[type=number]').blur();
  await page.evaluate(() => Inbox.render());
  await page.locator('.chat-image-settings summary').click();
  await expect(page.locator('.chat-image-settings input[type=checkbox]')).not.toBeChecked();
  await expect(page.locator('.chat-image-settings input[type=number]')).toHaveValue('2');
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(id => Inbox.chatRegenerateDaily(id, '2026-10-17'), chatId);
  await expect(page.locator('.chat-image-analysis')).toContainText('图片理解已关闭');
});

test('staged JSONL media backfills are atomic and backups retain image metadata', async () => {
  const result = await page.evaluate(async () => {
    const source = { chatInfo: { name: '分片图片', peerUin: 'chunk-images', type: 'group' }, messages: [{ id: 'img', timestamp: 1792227600000, content: { text: '[图片]' } }] };
    const first = await QQChats.importJsonData(source);
    source.messages[0].content.resources = [{ type: 'image', filename: 'chunk.png', url: 'resources/images/chunk.png' }];
    const stage = await QQChats.beginChunkedImport(source, { merge: true });
    await QQChats.appendChunkedImport(stage.sessionId, source.messages);
    const before = await QQChats.getMessage(first.chatId, 0);
    await QQChats.abortChunkedImport(stage.sessionId);
    const afterAbort = await QQChats.getMessage(first.chatId, 0);
    const stage2 = await QQChats.beginChunkedImport(source, { merge: true });
    await QQChats.appendChunkedImport(stage2.sessionId, source.messages);
    const commit = await QQChats.finishChunkedImport(stage2.sessionId);
    const backup = await QQChats.exportDatabase();
    await QQChats.restoreDatabase(backup);
    return { before: before.images, aborted: afterAbort.images, commit, restored: await QQChats.getAllMessages(first.chatId) };
  });
  expect(result.before).toEqual([]);
  expect(result.aborted).toEqual([]);
  expect(result.commit.added).toBe(0);
  expect(result.commit.updatedImages).toBe(1);
  expect(result.restored).toHaveLength(1);
  expect(result.restored[0].images[0].filename).toBe('chunk.png');
});

test('large daily reports understand every image batch before map/reduce and expose vision failures', async () => {
  const id = await page.evaluate(async originalId => {
    const image = (await QQChats.getMessage(originalId, 0)).images[0];
    const source = await electronAPI.qqchatReadImage(image, 0);
    const result = await QQChats.importJsonData({ chatInfo: { name: '长记录图片', peerUin: 'long-image-fixture', type: 'group' }, messages: Array.from({ length: 6 }, (_, i) => ({
      id: 'long-' + i, timestamp: Date.UTC(2026, 9, 17, 9) + i * 1000, content: {
        text: i === 0 ? '讨论背景'.repeat(12000) : '通知图片 ' + i,
        resources: [{ type: 'image', filename: 'batch-' + i + '.png', url: source.dataUrl }]
      }
    })) });
    window.isMultimodalModel = () => true;
    window.__imageCalls = [];
    Inbox.updateImageSetting('enabled', true);
    Inbox.updateImageSetting('batchSize', 2);
    Inbox.openChat(result.chatId);
    return result.chatId;
  }, chatId);
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(id => Inbox.chatRegenerateDaily(id, '2026-10-17'), id);
  const result = await page.evaluate(async id => ({ report: (await QQChats.listChats()).find(c => c.chatId === id).dailyReports[0], calls: window.__imageCalls }), id);
  expect(result.report.imageAnalysis).toMatchObject({ total: 6, understood: 6, missing: 0, failed: 0 });
  expect(result.calls.filter(c => c.feature === 'inbox_image_understanding')).toHaveLength(3);
  expect(result.calls.filter(c => c.feature === 'inbox_daily_report').length).toBeGreaterThanOrEqual(3);
  for (let index = 0; index < 6; index++) {
    const visionCalls = result.calls.filter(c => c.feature === 'inbox_image_understanding');
    expect(JSON.stringify(visionCalls)).toContain('m' + index + '-img0');
  }
  expect(result.calls.filter(c => c.feature === 'inbox_daily_report').some(c => c.messages[1].content.includes('【图片信息】明天上午九点物理课'))).toBe(true);
  await page.evaluate(() => {
    const success = window.callAiApi;
    window.callAiApi = (...args) => args[3].feature === 'inbox_image_understanding' ? Promise.reject(new Error('vision quota exceeded')) : success(...args);
  });
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(id => Inbox.chatRegenerateDaily(id, '2026-10-17'), id);
  await expect(page.locator('.chat-image-analysis')).toContainText('识别失败 6 张');
  await expect(page.locator('.chat-image-analysis')).toContainText('vision quota exceeded');
});

test('native JSONL imports copy sibling image resources before importing messages', async () => {
  const dir = path.join(profile, 'jsonl-media');
  await fs.mkdir(path.join(dir, 'chunks'), { recursive: true });
  await fs.mkdir(path.join(dir, 'resources', 'images'), { recursive: true });
  const png = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(Buffer.from([255, 0, 0, 255]), { width: 1, height: 1 }).toPNG().toString('base64'));
  await fs.writeFile(path.join(dir, 'resources', 'images', 'jsonl.png'), Buffer.from(png, 'base64'));
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ chatInfo: { type: 'group', name: 'JSONL 原图', peerUin: 'jsonl-native' }, chunked: { chunks: [{ relativePath: 'chunks/part.jsonl' }] } }));
  await fs.writeFile(path.join(dir, 'chunks', 'part.jsonl'), JSON.stringify({ id: 'jsonl-picture', timestamp: Date.UTC(2026, 9, 17, 10), content: { text: '[图片]', resources: [{ type: 'image', filename: 'jsonl.png', localPath: 'images/jsonl.png', url: 'resources/images/jsonl.png' }] } }) + '\n');
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, dir);
  const result = await page.evaluate(async () => {
    const pick = await electronAPI.qqchatPickDir();
    const manifest = await electronAPI.qqchatReadManifest(pick.dir);
    if (!manifest.ok) throw new Error(manifest.reason);
    const chunk = await electronAPI.qqchatReadChunk(manifest.chunkFiles[0]);
    if (!chunk.ok) throw new Error(chunk.reason);
    const imported = await QQChats.importChunkedJsonl(manifest.manifest, chunk.items);
    return { media: chunk.media, image: (await QQChats.getMessage(imported.chatId, 0)).images[0] };
  });
  expect(result.media).toEqual({ cached: 1, missing: 0 });
  expect(result.image.cacheKey).toMatch(/^[a-f0-9]{64}$/);
  await fs.unlink(path.join(dir, 'resources', 'images', 'jsonl.png'));
  const cached = await page.evaluate(image => electronAPI.qqchatReadImage(image, 0), result.image);
  expect(cached.ok).toBe(true);
});
