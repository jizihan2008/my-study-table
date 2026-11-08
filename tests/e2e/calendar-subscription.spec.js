const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('calendar subscription creates private links, resets and revokes, and reports missing deployment', async () => {
  test.setTimeout(60000);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-cal-subscription-'));
  let app;
  try {
    app = await electron.launch({ args: [path.resolve('.'), '--no-sandbox', '--disable-gpu'],
      env: { ...process.env, MST_E2E: '1', MST_USER_DATA_PATH: userDataPath } });
    const page = await app.firstWindow();
    await page.locator('#section-today').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      switchTab('calendar');
      window.__calMock = { record: null, categories: new Map(), health: true, failSync: false, schemaFailure: false, writes: 0, userId: 'owner' };
      const mock = window.__calMock;
      const client = { from: table => table === 'calendar_category_subscriptions' ? {
        select: () => ({ eq: async () => ({ data: [...mock.categories.values()], error: null }) }),
        upsert: async value => { mock.categories.set(value.category, value); return { error: null }; },
        delete: () => ({ eq: () => ({ eq: async (_, category) => { mock.categories.delete(category); return { error: null }; } }) })
      } : ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mock.record, error: mock.schemaFailure ? { message: 'missing relation' } : null }) }) }),
        upsert: async value => { mock.record = value; mock.writes++; return { error: null }; },
        delete: () => ({ eq: async () => { mock.record = null; return { error: null }; } })
      }) };
      getSupabaseClient = () => client;
      friendsGetSession = async () => ({ user: { id: mock.userId } });
      getFriendsConfig = () => ({ url: 'https://db.example', provider: 'supabase' });
      saveFriendsConfig = () => {};
      showCustomConfirm = async () => true;
      window.Sync = { enabled: true, autoSync: true, manualSync: async () => ({ lastError: mock.failSync ? 'offline' : '', pendingConflictCount: 0 }) };
      const originalFetch = window.fetch;
      window.fetch = (address, init) => String(address).startsWith('https://db.example/functions/v1/calendar-feed')
        ? Promise.resolve(new Response(mock.health ? JSON.stringify({ service: 'mst-calendar-feed', version: 1, categories: true }) : 'missing', { status: mock.health ? 200 : 404 }))
        : originalFetch(address, init);
    });
    await page.getByRole('button', { name: '订阅到苹果日历' }).click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('尚未开启');
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已开启');
    const first = await page.locator('#calSubscriptionLink').inputValue();
    expect(first).toMatch(/^https:\/\/db.example\/functions\/v1\/calendar-feed\?token=[0-9a-f]{64}$/);
    const persisted = await page.evaluate(() => JSON.stringify({ record: window.__calMock.record, storage: { ...localStorage } }));
    expect(persisted).not.toContain(first.split('token=')[1]);
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionLink')).not.toHaveValue(first);
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已开启');
    await page.locator('#calSubscriptionRevoke').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已停用');
    await expect(page.locator('#calSubscriptionLink')).toHaveValue('');
    expect(await page.evaluate(() => window.__calMock.record)).toBe(null);
    await page.evaluate(() => { window.__calMock.health = false; });
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('尚未配置或无法访问');
    expect(await page.evaluate(() => window.__calMock.writes)).toBe(2);
    await page.evaluate(() => { window.__calMock.health = true; window.__calMock.failSync = true; });
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('日历同步未完成');
    expect(await page.evaluate(() => window.__calMock.writes)).toBe(2);
    await page.evaluate(() => { window.__calMock.failSync = false; });
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已开启');
    await page.locator('#calSubscriptionModal').getByRole('button', { name: '关闭订阅设置' }).click();
    await expect(page.locator('#calSubscriptionLink')).toHaveValue('');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '订阅到苹果日历' }).click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已开启');
    await expect(page.locator('#calSubscriptionLink')).toHaveValue('');
    await expect(page.locator('#calSubscriptionStatus')).toBeInViewport();
    await expect(page.locator('#calSubscriptionLink')).toBeInViewport();
    expect(await page.locator('#calSubscriptionModal .modal').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('subscription-mobile.png'), animations: 'disabled' });
    // Account changes must clear an exposed link and prevent a write under the previous owner.
    await page.evaluate(() => { window.__calMock.userId = 'different-account'; });
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('账号或云服务已变化');
    expect(await page.evaluate(() => window.__calMock.writes)).toBe(3);
    await page.locator('#calSubscriptionModal').getByRole('button', { name: '关闭订阅设置' }).click();
    await page.evaluate(() => { window.__calMock.schemaFailure = true; });
    await page.getByRole('button', { name: '订阅到苹果日历' }).click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('尚未配置或无法访问');
    await expect(page.locator('#calSubscriptionCreate')).toBeDisabled();
    await page.getByRole('button', { name: '关闭订阅设置' }).click();
    await page.evaluate(() => { window.__calMock.schemaFailure = false; });
    await page.locator('#section-calendar').getByRole('button', { name: '管理分类', exact: true }).click();
    for (const category of ['课程', '考试', '临时']) {
      await page.getByLabel('新分类名称').fill(category);
      await page.getByRole('button', { name: '添加分类', exact: true }).click();
      await expect(page.locator('#calCategoryList')).toContainText(category);
    }
    await page.getByRole('button', { name: '移除分类 临时' }).click();
    await expect(page.locator('#calCategoryList')).not.toContainText('临时');
    await page.getByRole('button', { name: '关闭分类管理' }).click();
    for (const category of ['课程', '考试']) {
      await page.evaluate(() => openCalEventModal(formatDate(new Date()), null));
      await page.locator('#calEventTitle').fill(category + '事件');
      await page.locator('#calEventCategory').selectOption(category);
      await page.locator('#calEventModal').getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.locator('#calEventModal')).not.toHaveClass(/open/);
    }
    await page.getByRole('button', { name: '订阅到苹果日历' }).click();
    const scope = page.locator('#calSubscriptionScope');
    const link = page.locator('#calSubscriptionLink');
    await scope.selectOption('课程');
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=cat-[0-9a-f]{64}$/);
    const course = await link.inputValue();
    await scope.selectOption('考试');
    await expect(link).toHaveValue('');
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=cat-[0-9a-f]{64}$/);
    expect(await link.inputValue()).not.toBe(course);
    await page.locator('#calSubscriptionRevoke').click();
    await expect(link).toHaveValue('');
    await scope.selectOption('课程');
    await expect(link).toHaveValue(course);
    expect(await page.evaluate(() => [...window.__calMock.categories.keys()])).toEqual(['课程']);
    expect(await page.evaluate(() => !!window.__calMock.record)).toBe(true);
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
