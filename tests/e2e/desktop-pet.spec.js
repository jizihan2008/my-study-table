'use strict';
const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('desktop pet is isolated, interactive, movable and survives hiding the main window', async () => {
  test.setTimeout(90000);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-pet-e2e-'));
  let app;
  try {
    app = await electron.launch({
      args: [path.resolve('.'), '--no-sandbox', '--disable-gpu', '--pet-only', '--show-pet'],
      env: { ...process.env, MST_E2E: '1', MST_PET_E2E: '1', MST_USER_DATA_PATH: userDataPath }
    });
    const main = await app.firstWindow();
    await expect.poll(() => app.windows().length).toBe(2);
    const pet = app.windows().find(page => page !== main);
    await pet.waitForLoadState('domcontentloaded');
    await expect(pet).toHaveTitle('时芽 · 专注精灵');
    const properties = await app.evaluate(({ BrowserWindow }) => {
      const petWin = BrowserWindow.getAllWindows().find(win => win.getTitle().startsWith('时芽'));
      return {
        top: petWin.isAlwaysOnTop(), preferences: petWin.webContents.getLastWebPreferences(),
        mainVisible: BrowserWindow.getAllWindows().find(win => win !== petWin).isVisible(),
        transparent: petWin.isVisible(), size: petWin.getSize()
      };
    });
    expect(properties.top).toBe(true);
    expect(properties.mainVisible).toBe(false);
    expect(properties.preferences.contextIsolation).toBe(true);
    expect(properties.preferences.nodeIntegration).toBe(false);
    expect(properties.preferences.sandbox).toBe(true);
    // DIP rounding and native transparent-window borders vary with Windows scaling.
    expect(properties.size[0]).toBeGreaterThanOrEqual(240);
    expect(properties.size[0]).toBeLessThanOrEqual(260);
    expect(properties.size[1]).toBe(320);
    await expect.poll(() => pet.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(pet.locator('#sprite')).toHaveAttribute('data-ready', 'true');
    await expect(pet.locator('#sprite')).toBeVisible();
    await expect(pet.locator('img')).toBeHidden();
    for (const action of ['idle', 'walk', 'wave', 'read', 'sleep', 'celebrate']) {
      await pet.evaluate(action => petAPI.action('animate:' + action), action);
      await expect(pet.locator('#sprite')).toHaveAttribute('data-action', action);
      const first = await pet.locator('#sprite').evaluate(canvas => ({ frame: canvas.dataset.frame, pixels: canvas.toDataURL() }));
      // Sample faster than the blink, so a coarse polling interval cannot miss it.
      await expect.poll(() => pet.locator('#sprite').getAttribute('data-frame'), { timeout: 3000, intervals: [50] }).not.toBe(first.frame);
      const second = await pet.locator('#sprite').evaluate(canvas => canvas.toDataURL());
      expect(second).not.toBe(first.pixels);
    }
    await pet.evaluate(() => petAPI.action('animate:idle'));
    expect(await pet.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await pet.evaluate(() => window.electronAPI)).toBeUndefined();
    expect(await pet.locator('img').evaluate(img => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      return context.getImageData(0, 0, 1, 1).data[3];
    })).toBe(0);

    await pet.locator('#character').click();
    await expect(pet.locator('#bubble')).toContainText('今天也一起');
    const originalCharacter = await pet.locator('#character').boundingBox();
    const assertStableSize = async () => {
      const nativeSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle().startsWith('时芽')).getSize());
      // Windows may remove its initial border allowance when explicitly sized.
      // Movement must never accumulate growth; the rendered character is exact.
      expect(nativeSize[0]).toBeLessThanOrEqual(properties.size[0] + 1);
      expect(nativeSize[0]).toBeGreaterThanOrEqual(240);
      expect(nativeSize[1]).toBe(properties.size[1]);
      const characterSize = await pet.locator('#character').boundingBox();
      expect(characterSize.width).toBe(originalCharacter.width);
      expect(characterSize.height).toBe(originalCharacter.height);
    };
    const position = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle().startsWith('时芽')).getPosition());
    const before = await position();
    await pet.locator('#character').press('ArrowLeft');
    await expect.poll(async () => (await position())[0]).toBe(before[0] - 12);
    await assertStableSize();
    const saved = JSON.parse(await fs.readFile(path.join(userDataPath, 'desktop-pet.json'), 'utf8'));
    expect(saved.x).toBe(before[0] - 12);
    const dragStart = await position();
    const characterBounds = await pet.locator('#character').boundingBox();
    await pet.mouse.move(characterBounds.x + characterBounds.width / 2, characterBounds.y + characterBounds.height / 2);
    await pet.mouse.down();
    await pet.mouse.move(characterBounds.x + characterBounds.width / 2 - 28, characterBounds.y + characterBounds.height / 2, { steps: 4 });
    await pet.mouse.up();
    await expect.poll(async () => (await position())[0]).toBeLessThan(dragStart[0]);
    await assertStableSize();
    for (let i = 0; i < 12; i++) {
      const box = await pet.locator('#character').boundingBox();
      await pet.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await pet.mouse.down();
      await pet.mouse.move(box.x + box.width / 2 + (i % 2 ? 20 : -20), box.y + box.height / 2, { steps: 5 });
      await pet.mouse.up();
      await assertStableSize();
    }

    await main.waitForFunction(() => typeof notifyDesktopPet === 'function');
    await pet.locator('#name').click();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.getTitle().startsWith('时芽')).isVisible())).toBe(true);
    await main.evaluate(() => { openSettingsModal(); switchSettingsTab('appearance'); });
    await expect(main.locator('#desktopPetToggle')).toBeVisible();
    await expect(main.getByRole('switch', { name: '启用桌宠' })).toBeChecked();
    await main.getByRole('switch', { name: '启用桌宠' }).uncheck();
    await expect.poll(() => main.evaluate(() => electronAPI.petStatus().then(state => state.enabled))).toBe(false);
    await main.getByRole('switch', { name: '启用桌宠' }).check();
    await expect.poll(() => main.evaluate(() => electronAPI.petStatus().then(state => state.enabled))).toBe(true);
    await main.evaluate(() => timerStart());
    await expect(pet.locator('#bubble')).toContainText('专注开始');
    await expect(pet.locator('#sprite')).toHaveAttribute('data-action', 'read');
    await main.evaluate(() => timerPause());
    await expect(pet.locator('#bubble')).toContainText('休息一下');
    await expect(pet.locator('#sprite')).toHaveAttribute('data-action', 'sleep');
    await main.evaluate(() => {
      const item = { id: 'pet-test-task', text: '桌宠测试', done: false, parentId: null };
      todos.push(item);
      toggleTodo(item.id);
    });
    await expect(pet.locator('#bubble')).toContainText('又完成一件事');
    await expect(pet.locator('#sprite')).toHaveAttribute('data-action', 'celebrate');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.getTitle().startsWith('时芽')).hide());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle().startsWith('时芽')).isVisible())).toBe(true);

    await pet.locator('#hide').click({ force: true });
    await expect.poll(() => main.evaluate(() => electronAPI.petStatus().then(state => state.enabled))).toBe(false);
    await expect(main.locator('#desktopPetToggle')).not.toBeChecked();
    expect(JSON.parse(await fs.readFile(path.join(userDataPath, 'desktop-pet.json'), 'utf8')).enabled).toBe(false);
    await main.evaluate(() => electronAPI.petToggle());
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle().startsWith('时芽')).isVisible())).toBe(true);
    await fs.mkdir(path.resolve('test-results', 'desktop-pet'), { recursive: true });
    await pet.screenshot({ path: path.resolve('test-results', 'desktop-pet', 'shiya.png'), omitBackground: true });
    await main.evaluate(() => electronAPI.petToggle());
    await app.close();
    app = await electron.launch({
      args: [path.resolve('.'), '--no-sandbox', '--disable-gpu', '--pet-only'],
      env: { ...process.env, MST_E2E: '1', MST_PET_E2E: '1', MST_USER_DATA_PATH: userDataPath }
    });
    const restartedMain = await app.firstWindow();
    await restartedMain.waitForLoadState('domcontentloaded');
    expect(await restartedMain.evaluate(() => electronAPI.petStatus().then(state => state.enabled))).toBe(false);
    expect(app.windows()).toHaveLength(1);
    await restartedMain.evaluate(() => localStorage.setItem('desktop_pet_instance_probe', 'original-main'));
    const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id);
    // Exercise the OS single-instance activation event without a second
    // debugger-managed Electron process competing with the test harness.
    await app.evaluate(({ app }) => app.emit('second-instance', {}, ['electron', '.', '--pet-only', '--show-pet']));
    await expect.poll(() => app.windows().length).toBe(2);
    const attachedPet = app.windows().find(page => page !== restartedMain);
    await attachedPet.waitForLoadState('domcontentloaded');
    await attachedPet.locator('#name').click();
    expect(await restartedMain.evaluate(() => localStorage.getItem('desktop_pet_instance_probe'))).toBe('original-main');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(win => !win.getTitle().startsWith('时芽')).map(win => win.id))).toEqual([mainId]);
  } finally {
    if (app) await app.close();
    // Only remove the uniquely created test directory under the OS temp root.
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(userDataPath)) === tempRoot && path.basename(userDataPath).startsWith('mst-pet-e2e-')) {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  }
});
