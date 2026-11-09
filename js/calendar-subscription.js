// One-way calendar sharing. Raw bearer tokens live only in this dialog, never backups.
const CalendarSubscription = (() => {
  let context = null;
  let busy = false;
  let generation = 0;
  const el = id => document.getElementById('calSubscription' + id);
  const message = text => { el('Status').textContent = text; };
  const TODO_SCOPE = 'todo-due';
  const scope = () => el('Scope').value;
  const categoryFor = value => value.startsWith('cat:') ? value.slice(4) : '';
  const scopeError = value => value === TODO_SCOPE ? context?.todoError : categoryFor(value) ? context?.categoryError : '';
  const active = () => context?.subscriptions.has(scope());
  const tableFor = value => value === TODO_SCOPE ? 'calendar_todo_due_subscriptions'
    : categoryFor(value) ? 'calendar_category_subscriptions' : 'calendar_subscriptions';
  function setBusy(value) {
    busy = value;
    el('Modal').querySelectorAll('button, input, select').forEach(node => { node.disabled = value; });
    el('Copy').disabled = value || !el('Link').value;
    el('Create').disabled = value || !context || !!scopeError(scope());
    el('Revoke').disabled = value || !active();
  }
  function clearLink() { el('Link').value = ''; el('Copy').disabled = true; }
  function selectScope() {
    if (!context) return;
    const selected = scope();
    const subscription = context.subscriptions.get(selected);
    el('Link').value = context.links.get(selected) || '';
    el('Timezone').value = subscription?.timezone || context.timezone;
    el('Create').textContent = subscription ? '重置订阅链接' : '生成订阅链接';
    setBusy(false);
    if (scopeError(selected)) message(scopeError(selected));
    else if (el('Link').value) message('订阅已开启。请复制当前范围的链接到苹果日历。');
    else if (subscription) message('订阅已开启。链接仅在生成时显示；重置后旧链接失效，需要在苹果日历重新订阅。');
    else message('尚未开启订阅。生成链接前，请开启云同步和自动同步。');
  }
  function endpoint(config) {
    const url = new URL(config.calendarFeedUrl || config.url.replace(/\/$/, '') + '/functions/v1/calendar-feed');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('订阅服务地址必须是 HTTPS 地址，且不含参数或登录信息。');
    return url.href;
  }
  async function checkContext() {
    const expected = context;
    const session = await friendsGetSession();
    const config = getFriendsConfig();
    if (expected !== context) throw new Error('订阅设置已变化，请重新选择订阅范围。');
    if (!expected || session?.user?.id !== expected.userId || getSupabaseClient() !== expected.client || config.url !== expected.config.url) {
      expected?.links.clear();
      clearLink();
      throw new Error('登录账号或云服务已变化，请关闭后重新打开订阅设置。');
    }
  }
  async function open() {
    if (busy) return;
    const ticket = ++generation;
    context = null;
    clearLink();
    el('Scope').replaceChildren(new Option('全部日程', ''), new Option('待办截止日期', TODO_SCOPE));
    el('Scope').disabled = true;
    el('Create').disabled = true;
    el('Revoke').disabled = true;
    el('Modal').classList.add('open');
    message('正在检查订阅状态…');
    try {
      const config = getFriendsConfig();
      if (config.provider === 'cloudbase') throw new Error('此版本需要 Supabase 兼容云服务，暂不支持 CloudBase。');
      const client = getSupabaseClient();
      const session = await friendsGetSession();
      if (ticket !== generation) return;
      if (!client || !session?.user?.id) throw new Error('请先在「好友」页面登录云同步账号。');
      el('Endpoint').value = endpoint(config);
      const userId = session.user.id;
      const [{ data, error }, categoryResult, todoResult] = await Promise.all([
        client.from('calendar_subscriptions').select('timezone').eq('user_id', userId).maybeSingle(),
        client.from('calendar_category_subscriptions').select('category,timezone').eq('user_id', userId),
        client.from('calendar_todo_due_subscriptions').select('timezone').eq('user_id', userId).maybeSingle()
      ]);
      if (ticket !== generation) return;
      if (error?.code === 'PGRST205') throw new Error('云端缺少日历订阅表。请管理员在当前云项目执行日历订阅数据库迁移。');
      if (error) throw new Error('订阅服务尚未配置或无法访问，请联系管理员配置日历订阅服务后重试。');
      const subscriptions = new Map((categoryResult.data || []).map(row => ['cat:' + row.category, row]));
      if (data) subscriptions.set('', data);
      if (todoResult.data) subscriptions.set(TODO_SCOPE, todoResult.data);
      const loaded = { client, userId, config, subscriptions, links: new Map(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        categoryError: categoryResult.error?.code === 'PGRST205' ? '分类订阅尚未部署，请先执行分类订阅数据库迁移。'
          : categoryResult.error ? '无法读取分类订阅，请检查云服务连接后重新打开。' : '',
        todoError: todoResult.error?.code === 'PGRST205' ? '待办截止日期订阅尚未部署，请先执行待办订阅数据库迁移。'
          : todoResult.error ? '无法读取待办截止日期订阅，请检查云服务连接后重新打开。' : '' };
      context = loaded;
      await checkContext();
      if (ticket !== generation) return;
      const categories = new Set([...getCalendarCategories(), ...(categoryResult.data || []).map(row => row.category)]);
      for (const category of categories) el('Scope').add(new Option('分类：' + category, 'cat:' + category));
      selectScope();
    } catch (error) { if (ticket === generation) message(error.message || '无法读取订阅状态，请稍后重试。'); }
  }
  function close() {
    if (busy) return;
    ++generation;
    context = null;
    clearLink();
    el('Modal').classList.remove('open');
  }
  async function create() {
    if (busy || !context) return;
    const owner = context;
    const selected = scope();
    const todoDue = selected === TODO_SCOPE;
    const category = categoryFor(selected);
    if (scopeError(selected)) return;
    if (active() && !await showCustomConfirm('重置后，当前范围的旧链接会失效。需要在苹果日历中删除旧订阅，再添加新链接。继续重置？')) return;
    if (busy || context !== owner || scope() !== selected) return;
    setBusy(true);
    try {
      await checkContext();
      if (!window.Sync?.enabled || !window.Sync?.autoSync) throw new Error('请先在「设置 → 账号与同步」开启云同步和自动同步。');
      const service = endpoint({ ...context.config, calendarFeedUrl: el('Endpoint').value.trim() });
      const timezone = el('Timezone').value.trim();
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
      catch { throw new Error('请输入有效的时区，例如 Asia/Shanghai。'); }
      message('正在检查订阅服务…');
      let health;
      let status;
      try {
        const check = todoDue ? 'todo-due' : category ? 'categories' : '1';
        const response = await fetch(service + '?health=' + check, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
        status = response.status;
        if (response.ok) health = await response.json();
      } catch { /* Report a useful deployment error below. */ }
      if (status === 401) throw new Error('订阅接口要求登录（401）。请管理员关闭 calendar-feed 的网关 JWT 校验，以便苹果日历使用订阅链接。');
      if (status === 503) throw new Error('订阅服务暂不可用（503）。请管理员检查 calendar-feed 的部署状态和数据库连接。');
      if (category && health?.categories !== true) throw new Error('云端订阅接口还未启用分类订阅，请更新 calendar-feed 后重试。');
      if (todoDue && health?.todoDue !== true) throw new Error('云端订阅接口还未启用待办截止日期订阅，请更新 calendar-feed 后重试。');
      if (health?.service !== 'mst-calendar-feed' || health.version !== 1) throw new Error('订阅服务尚未配置或无法访问，请联系管理员配置日历订阅服务后重试。');
      const label = todoDue ? '待办' : '日历';
      message('正在同步' + label + '…');
      const result = await Sync.manualSync({ moduleId: todoDue ? 'todos' : 'calendar' });
      if (result.lastError || result.pendingConflictCount) throw new Error(label + '同步未完成，请在「账号与同步」处理同步错误或冲突后重试。');
      await checkContext();
      const token = (todoDue ? 'due-' : category ? 'cat-' : '') + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const { error } = await owner.client.from(tableFor(selected)).upsert(
        { user_id: owner.userId, token_hash: hash, timezone, ...(category ? { category } : {}) },
        { onConflict: category ? 'user_id,category' : 'user_id' });
      if (error) throw new Error('生成订阅链接失败，请检查云服务连接后重试。');
      owner.links.delete(selected);
      clearLink();
      await checkContext();
      owner.subscriptions.set(selected, { timezone });
      // This is provider configuration, already excluded from data backups and sync.
      saveFriendsConfig({ ...getFriendsConfig(), calendarFeedUrl: service });
      el('Link').value = service + '?token=' + token;
      owner.links.set(selected, el('Link').value);
      el('Create').textContent = '重置订阅链接';
      message('订阅已开启。请复制链接到苹果日历；链接仅在本次窗口中显示。后续日程随云同步更新，苹果端刷新可能延迟。');
    } catch (error) { message(error.message || '生成订阅失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  async function revoke() {
    if (busy || !active()) return;
    const owner = context;
    const selected = scope();
    const category = categoryFor(selected);
    if (!await showCustomConfirm('停用后，当前范围的链接将无法继续获取日程。苹果日历中已缓存的日程需自行取消订阅以移除。')) return;
    if (busy || context !== owner || scope() !== selected) return;
    setBusy(true);
    try {
      await checkContext();
      let deletion = owner.client.from(tableFor(selected)).delete().eq('user_id', owner.userId);
      if (category) deletion = deletion.eq('category', category);
      const { error } = await deletion;
      if (error) throw new Error('停用失败，请检查网络后重试。');
      await checkContext();
      owner.subscriptions.delete(selected);
      owner.links.delete(selected);
      clearLink();
      el('Create').textContent = '生成订阅链接';
      message('订阅已停用，旧链接已失效。可在苹果日历中取消订阅以移除缓存日程。');
    } catch (error) { message(error.message || '停用失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try {
      await checkContext();
      if (!el('Link').value) return;
      await navigator.clipboard.writeText(el('Link').value);
      message('已复制。在 iPhone「日历 → 日历 → 添加日历 → 添加订阅日历」中粘贴链接。');
    } catch { message('无法自动复制，请选中链接手动复制；若账号已变化，请重新打开订阅设置。'); }
  }
  return { open, close, create, revoke, copy, selectScope };
})();
