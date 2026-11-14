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
      window.__calMock = { record: null, todo: null, categories: new Map(), custom: new Map(), customMissing: false, failUpdate: false,
        syncedModules: [], health: true, schemaFailure: false, writes: 0, userId: 'owner' };
      const mock = window.__calMock;
      const client = { from: table => table === 'calendar_custom_subscriptions' ? {
        select: () => ({ eq: async () => ({ data: [...mock.custom.values()], error: mock.customMissing ? { code: 'PGRST205' } : null }) }),
        upsert: async value => {
          if ([...mock.custom.values()].some(row => row.id !== value.id && row.name === value.name)) return { error: { code: '23505' } };
          mock.custom.set(value.id, value); return { error: null };
        },
        update: value => ({ eq: () => ({ eq: (_, id) => ({ select: () => ({ maybeSingle: async () => {
          if (mock.failUpdate) return { data: null, error: { message: 'offline' } };
          if (!mock.custom.has(id)) return { data: null, error: null };
          mock.custom.set(id, { ...mock.custom.get(id), ...value });
          return { data: { id }, error: null };
        } }) }) }) }),
        delete: () => ({ eq: () => ({ eq: async (_, id) => { mock.custom.delete(id); return { error: null }; } }) })
      } : table === 'calendar_category_subscriptions' ? {
        select: () => ({ eq: async () => ({ data: [...mock.categories.values()], error: null }) }),
        upsert: async value => { mock.categories.set(value.category, value); return { error: null }; },
        delete: () => ({ eq: () => ({ eq: async (_, category) => { mock.categories.delete(category); return { error: null }; } }) })
      } : table === 'calendar_todo_due_subscriptions' ? {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mock.todo, error: null }) }) }),
        upsert: async value => { mock.todo = value; return { error: null }; },
        delete: () => ({ eq: async () => { mock.todo = null; return { error: null }; } })
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
      window.Sync = { enabled: true, autoSync: true, manualSync: async options => {
        mock.syncedModules.push(options.moduleId);
        throw new Error('Subscription management must not trigger a full content sync');
      } };
      const originalFetch = window.fetch;
      window.fetch = (address, init) => String(address).startsWith('https://db.example/functions/v1/calendar-feed')
        ? Promise.resolve(new Response(mock.health ? JSON.stringify({ service: 'mst-calendar-feed', version: 1, categories: true, todoDue: true, custom: true }) : 'missing', { status: mock.health ? 200 : 404 }))
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
    await page.evaluate(() => { window.__calMock.health = true; });
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
    await scope.selectOption('cat:课程');
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=cat-[0-9a-f]{64}$/);
    const course = await link.inputValue();
    await scope.selectOption('cat:考试');
    await expect(link).toHaveValue('');
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=cat-[0-9a-f]{64}$/);
    expect(await link.inputValue()).not.toBe(course);
    await page.locator('#calSubscriptionRevoke').click();
    await expect(link).toHaveValue('');
    await scope.selectOption('cat:课程');
    await expect(link).toHaveValue(course);
    await scope.selectOption('custom:new');
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅名称');
    await page.getByPlaceholder('例如：课程与待办').fill('课程与待办');
    await page.locator('#calSubscriptionCreate').click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('至少勾选一项');
    await page.locator('#calSubscriptionSources').getByRole('checkbox', { name: '分类：课程', exact: true }).check();
    await page.getByRole('checkbox', { name: '待办截止日期', exact: true }).check();
    await page.evaluate(() => { window.__calMock.syncedModules = []; });
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=mix-[0-9a-f]{64}$/);
    const firstCustomLink = await link.inputValue();
    const firstCustomScope = await scope.inputValue();
    const config = await page.evaluate(() => [...window.__calMock.custom.values()][0]);
    expect(config).toMatchObject({ name: '课程与待办', include_events: false, categories: ['课程'], include_todo_due: true });
    expect(await page.evaluate(() => window.__calMock.syncedModules)).toEqual([]);
    await scope.selectOption('custom:new');
    await page.getByPlaceholder('例如：课程与待办').fill('全部事件');
    await page.getByRole('checkbox', { name: '全部日历事件', exact: true }).check();
    await expect(page.locator('#calSubscriptionCategorySources input').first()).toBeDisabled();
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=mix-[0-9a-f]{64}$/);
    const secondCustomScope = await scope.inputValue();
    await scope.selectOption(firstCustomScope);
    await expect(link).toHaveValue(firstCustomLink);
    await expect(page.getByRole('checkbox', { name: '待办截止日期', exact: true })).toBeChecked();
    await page.locator('#calSubscriptionSources').getByRole('checkbox', { name: '分类：考试', exact: true }).check();
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).not.toHaveValue(firstCustomLink);
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已开启');
    await page.screenshot({ path: test.info().outputPath('custom-subscription-mobile.png'), animations: 'disabled' });
    await page.locator('#calSubscriptionRevoke').click();
    await expect(link).toHaveValue('');
    expect(await page.evaluate(() => window.__calMock.custom.size)).toBe(1);
    await page.getByRole('button', { name: '关闭订阅设置' }).click();
    await page.getByRole('button', { name: '订阅到苹果日历' }).click();
    await scope.selectOption(secondCustomScope);
    await expect(page.getByPlaceholder('例如：课程与待办')).toHaveValue('全部事件');
    await expect(link).toHaveValue('');
    await page.getByRole('button', { name: '关闭订阅设置' }).click();
    await page.getByRole('button', { name: '管理订阅', exact: true }).click();
    const manager = page.locator('#calSubscriptionManager');
    await expect(manager).toBeVisible();
    await expect(manager.locator('.cal-subscription-card')).toHaveCount(1);
    await expect(manager).toContainText('全部事件');
    await expect(manager).toContainText('全部日历事件');
    const hashBeforeSave = await page.evaluate(() => [...window.__calMock.custom.values()][0].token_hash);
    await manager.getByRole('button', { name: '查看 / 编辑' }).click();
    await page.getByPlaceholder('例如：课程与待办').fill('课程与截止日期');
    await page.getByRole('checkbox', { name: '全部日历事件', exact: true }).uncheck();
    await page.locator('#calSubscriptionSources').getByRole('checkbox', { name: '分类：课程', exact: true }).check();
    await page.getByRole('checkbox', { name: '待办截止日期', exact: true }).check();
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('原订阅链接继续有效');
    expect(await page.evaluate(() => [...window.__calMock.custom.values()][0].token_hash)).toBe(hashBeforeSave);
    expect(await page.evaluate(() => window.__calMock.custom.size)).toBe(1);
    await page.getByRole('button', { name: '查看已有自定义订阅' }).click();
    await expect(manager).toContainText('课程与截止日期');
    await expect(manager).toContainText('分类：课程、待办截止日期');
    await page.screenshot({ path: test.info().outputPath('subscription-manager-mobile.png'), animations: 'disabled' });
    await manager.getByRole('button', { name: '查看 / 编辑' }).click();
    await page.getByPlaceholder('例如：课程与待办').fill('未保存的名称');
    await page.evaluate(() => { window.__calMock.failUpdate = true; });
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('保存失败');
    expect(await page.evaluate(() => [...window.__calMock.custom.values()][0].name)).toBe('课程与截止日期');
    await page.evaluate(() => { window.__calMock.failUpdate = false; });
    await page.getByRole('button', { name: '查看已有自定义订阅' }).click();
    await manager.getByRole('button', { name: '停用并移除' }).click();
    await expect(manager.locator('.cal-subscription-card')).toHaveCount(0);
    await expect(manager).toContainText('订阅已停用');
    expect(await page.evaluate(() => window.__calMock.custom.size)).toBe(0);
    await page.evaluate(() => {
      const id = crypto.randomUUID();
      window.__calMock.custom.set(id, { id, name: '另一设备的订阅', timezone: 'Asia/Shanghai',
        include_events: true, categories: [], include_todo_due: false, token_hash: 'abc' });
    });
    await manager.getByRole('button', { name: '刷新列表' }).click();
    await expect(manager).toContainText('另一设备的订阅');
    await manager.getByRole('button', { name: '查看 / 编辑' }).click();
    await page.evaluate(() => { window.__calMock.custom.clear(); });
    await page.getByRole('button', { name: '保存更改', exact: true }).click();
    await expect(page.locator('#calSubscriptionStatus')).toContainText('该订阅已被移除');
    expect(await page.evaluate(() => window.__calMock.custom.size)).toBe(0);
    await page.getByRole('button', { name: '关闭订阅设置' }).click();
    await page.evaluate(() => { window.__calMock.customMissing = true; });
    await page.getByRole('button', { name: '订阅到苹果日历' }).click();
    await scope.selectOption('custom:new');
    await expect(page.locator('#calSubscriptionStatus')).toContainText('自定义订阅尚未部署');
    await expect(page.locator('#calSubscriptionCreate')).toBeDisabled();
    expect(await page.evaluate(() => [...window.__calMock.categories.keys()])).toEqual(['课程']);
    expect(await page.evaluate(() => !!window.__calMock.record)).toBe(true);
    await scope.selectOption({ label: '待办截止日期' });
    await page.locator('#calSubscriptionCreate').click();
    await expect(link).toHaveValue(/token=due-[0-9a-f]{64}$/);
    expect(await page.evaluate(() => window.__calMock.syncedModules)).toEqual([]);
    await page.locator('#calSubscriptionRevoke').click();
    await expect(link).toHaveValue('');
    expect(await page.evaluate(() => window.__calMock.todo)).toBe(null);
    await scope.selectOption('cat:课程');
    await expect(link).toHaveValue('');
    await expect(page.locator('#calSubscriptionStatus')).toContainText('订阅已开启');
  } finally {
    if (app) await app.close();
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
