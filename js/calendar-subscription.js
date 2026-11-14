// One-way calendar sharing. Raw bearer tokens live only in this dialog, never backups.
const CalendarSubscription = (() => {
  let context = null;
  let busy = false;
  let generation = 0;
  const el = id => document.getElementById('calSubscription' + id);
  const message = text => { el('Status').textContent = text; el('ManagerStatus').textContent = text; };
  const TODO_SCOPE = 'todo-due';
  const NEW_CUSTOM = 'custom:new';
  const isCustom = value => value.startsWith('custom:');
  const scope = () => el('Scope').value;
  const categoryFor = value => value.startsWith('cat:') ? value.slice(4) : '';
  const scopeError = value => isCustom(value) ? context?.customError : value === TODO_SCOPE ? context?.todoError : categoryFor(value) ? context?.categoryError : '';
  const active = () => context?.subscriptions.has(scope());
  const tableFor = value => isCustom(value) ? 'calendar_custom_subscriptions' : value === TODO_SCOPE ? 'calendar_todo_due_subscriptions'
    : categoryFor(value) ? 'calendar_category_subscriptions' : 'calendar_subscriptions';
  function setBusy(value) {
    busy = value;
    el('Modal').querySelectorAll('button, input, select').forEach(node => { node.disabled = value; });
    el('Copy').disabled = value || !el('Link').value;
    el('Create').disabled = value || !context || !!scopeError(scope());
    el('Revoke').disabled = value || !active();
    el('Save').hidden = !isCustom(scope()) || !active();
    el('Save').disabled = value || !context || !!scopeError(scope());
    el('Sources').querySelectorAll('input[data-category]').forEach(input => { input.disabled = value || el('AllEvents').checked; });
  }
  function clearLink() { el('Link').value = ''; el('Copy').disabled = true; }
  function selectScope() {
    if (!context) return;
    const selected = scope();
    const subscription = context.subscriptions.get(selected);
    el('Custom').hidden = !isCustom(selected);
    if (isCustom(selected)) renderCustom(subscription);
    el('Link').value = context.links.get(selected) || '';
    el('Timezone').value = subscription?.timezone || context.timezone;
    el('Create').textContent = subscription ? '重置订阅链接' : '生成订阅链接';
    setBusy(false);
    if (scopeError(selected)) message(scopeError(selected));
    else if (el('Link').value) message('订阅已开启。请复制当前范围的链接到苹果日历。');
    else if (subscription) message('订阅已开启。链接仅在生成时显示；重置后旧链接失效，需要在苹果日历重新订阅。');
    else message('尚未开启订阅。生成链接前，请开启云同步和自动同步。');
  }
  function renderCustom(subscription) {
    el('Name').value = subscription?.name || '';
    el('AllEvents').checked = subscription?.include_events === true;
    el('IncludeTodo').checked = subscription?.include_todo_due === true;
    const selected = new Set(subscription?.categories || []);
    const categories = new Set([...context.categories, ...selected]);
    categories.delete('');
    const sources = el('CategorySources');
    sources.replaceChildren();
    for (const category of ['', ...categories]) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.category = category;
      input.checked = selected.has(category);
      input.onchange = customChanged;
      label.append(input, document.createTextNode(category ? '分类：' + category : '未分类日程'));
      sources.append(label);
    }
  }
  function customChanged() {
    if (busy || !context) return;
    setBusy(false);
    message(active() ? '组合配置已修改。点击「保存更改」更新现有订阅。' : '勾选需要订阅的内容，再生成链接。');
  }
  function customRows() {
    return [...context.subscriptions.entries()].filter(([key]) => isCustom(key))
      .sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh-CN'));
  }
  function renderManager() {
    const list = el('List');
    list.replaceChildren();
    if (!context) return;
    if (context.customError) { el('ManagerStatus').textContent = context.customError; return; }
    const rows = customRows();
    el('ManagerStatus').textContent = rows.length ? '共 ' + rows.length + ' 个已启用的自定义订阅。' : '还没有自定义订阅。';
    for (const [key, row] of rows) {
      const card = document.createElement('article');
      card.className = 'cal-subscription-card';
      const name = document.createElement('strong');
      name.textContent = row.name;
      const sources = [];
      if (row.include_events) sources.push('全部日历事件');
      else for (const category of row.categories || []) sources.push(category ? '分类：' + category : '未分类日程');
      if (row.include_todo_due) sources.push('待办截止日期');
      const detail = document.createElement('p');
      detail.textContent = sources.join('、');
      const status = document.createElement('p');
      status.className = 'hint';
      status.textContent = '已启用 · ' + row.timezone;
      const actions = document.createElement('div');
      actions.className = 'cal-subscription-manager-actions';
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'calendar-today-btn'; edit.textContent = '查看 / 编辑';
      edit.onclick = () => editCustom(key);
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'calendar-today-btn'; remove.textContent = '停用并移除';
      remove.onclick = () => revoke(key);
      actions.append(edit, remove);
      card.append(name, detail, status, actions);
      list.append(card);
    }
  }
  function showManager() {
    if (busy) return;
    el('Manager').hidden = false;
    el('Editor').hidden = true;
    el('Title').textContent = '管理自定义订阅';
    renderManager();
  }
  function editCustom(key = NEW_CUSTOM) {
    if (busy || !context) return;
    el('Scope').value = key;
    selectScope();
    el('Manager').hidden = true;
    el('Editor').hidden = false;
    el('Title').textContent = key === NEW_CUSTOM ? '新建自定义订阅' : '编辑自定义订阅';
  }
  async function refreshCustom() {
    if (busy || !context) return;
    const owner = context;
    setBusy(true);
    message('正在刷新自定义订阅…');
    try {
      await checkContext();
      const { data, error } = await owner.client.from('calendar_custom_subscriptions')
        .select('id,name,timezone,include_events,categories,include_todo_due').eq('user_id', owner.userId);
      if (error) throw new Error('无法刷新自定义订阅，请检查云服务连接后重试。');
      await checkContext();
      for (const [key] of customRows()) {
        owner.subscriptions.delete(key);
        owner.links.delete(key);
        [...el('Scope').options].find(option => option.value === key)?.remove();
      }
      for (const row of data || []) {
        const key = 'custom:' + row.id;
        owner.subscriptions.set(key, row);
        el('Scope').add(new Option('自定义：' + row.name, key));
      }
      owner.customError = '';
      renderManager();
    } catch (error) { message(error.message); }
    finally { setBusy(false); }
  }
  async function saveCustom() {
    if (busy || !context || !active() || !isCustom(scope())) return;
    const owner = context;
    const selected = scope();
    setBusy(true);
    try {
      await checkContext();
      const config = readCustom();
      const timezone = el('Timezone').value.trim();
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
      if (!window.Sync?.enabled || !window.Sync?.autoSync) throw new Error('请先开启云同步和自动同步。');
      message('正在保存订阅更改…');
      const id = selected.slice(7);
      const { data, error } = await owner.client.from('calendar_custom_subscriptions').update({ ...config, timezone })
        .eq('user_id', owner.userId).eq('id', id).select('id').maybeSingle();
      if (error) throw new Error(error.code === '23505' ? '已有同名订阅，请换一个名称。' : '保存失败，请检查云服务连接后重试。');
      if (!data) throw new Error('该订阅已被移除，请返回列表刷新后再操作。');
      await checkContext();
      owner.subscriptions.set(selected, { id, ...config, timezone });
      [...el('Scope').options].find(option => option.value === selected).textContent = '自定义：' + config.name;
      renderManager();
      message('已保存更改，原订阅链接继续有效。苹果日历刷新后会显示更新。');
    } catch (error) { message(error.message || '保存失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  function readCustom() {
    const name = el('Name').value.trim();
    const includeEvents = el('AllEvents').checked;
    const includeTodo = el('IncludeTodo').checked;
    const categories = includeEvents ? [] : [...el('CategorySources').querySelectorAll('input:checked')].map(input => input.dataset.category);
    if (!name || Array.from(name).length > 80) throw new Error('请输入 1~80 字的订阅名称。');
    if (!includeEvents && !includeTodo && !categories.length) throw new Error('请至少勾选一项订阅内容。');
    if (categories.length > 100) throw new Error('一个组合最多选择 100 个分类。');
    return { name, include_events: includeEvents, categories, include_todo_due: includeTodo };
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
  async function open(manage = false) {
    if (busy) return;
    const ticket = ++generation;
    context = null;
    clearLink();
    el('Scope').replaceChildren(new Option('全部日程', ''), new Option('待办截止日期', TODO_SCOPE), new Option('＋ 添加自定义订阅', NEW_CUSTOM));
    el('Custom').hidden = true;
    el('Manager').hidden = !manage;
    el('Editor').hidden = manage;
    el('Title').textContent = manage ? '管理自定义订阅' : '订阅 MST 日程';
    el('List').replaceChildren();
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
      const [{ data, error }, categoryResult, todoResult, customResult] = await Promise.all([
        client.from('calendar_subscriptions').select('timezone').eq('user_id', userId).maybeSingle(),
        client.from('calendar_category_subscriptions').select('category,timezone').eq('user_id', userId),
        client.from('calendar_todo_due_subscriptions').select('timezone').eq('user_id', userId).maybeSingle(),
        client.from('calendar_custom_subscriptions').select('id,name,timezone,include_events,categories,include_todo_due').eq('user_id', userId)
      ]);
      if (ticket !== generation) return;
      if (error?.code === 'PGRST205') throw new Error('云端缺少日历订阅表。请管理员在当前云项目执行日历订阅数据库迁移。');
      if (error) throw new Error('订阅服务尚未配置或无法访问，请联系管理员配置日历订阅服务后重试。');
      const subscriptions = new Map((categoryResult.data || []).map(row => ['cat:' + row.category, row]));
      if (data) subscriptions.set('', data);
      if (todoResult.data) subscriptions.set(TODO_SCOPE, todoResult.data);
      for (const row of customResult.data || []) subscriptions.set('custom:' + row.id, row);
      const loaded = { client, userId, config, subscriptions, links: new Map(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
        categoryError: categoryResult.error?.code === 'PGRST205' ? '分类订阅尚未部署，请先执行分类订阅数据库迁移。'
          : categoryResult.error ? '无法读取分类订阅，请检查云服务连接后重新打开。' : '',
        todoError: todoResult.error?.code === 'PGRST205' ? '待办截止日期订阅尚未部署，请先执行待办订阅数据库迁移。'
          : todoResult.error ? '无法读取待办截止日期订阅，请检查云服务连接后重新打开。' : '',
        customError: customResult.error?.code === 'PGRST205' ? '自定义订阅尚未部署，请先完成自定义订阅服务配置。'
          : customResult.error ? '无法读取自定义订阅，请检查云服务连接后重新打开。' : '' };
      context = loaded;
      await checkContext();
      if (ticket !== generation) return;
      const categories = new Set([...getCalendarCategories(), ...(categoryResult.data || []).map(row => row.category)]);
      context.categories = [...categories];
      for (const category of categories) el('Scope').add(new Option('分类：' + category, 'cat:' + category));
      for (const row of customResult.data || []) el('Scope').add(new Option('自定义：' + row.name, 'custom:' + row.id));
      selectScope();
      renderManager();
      if (!manage) el('ManagerStatus').textContent = '';
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
    const custom = isCustom(selected);
    const category = categoryFor(selected);
    if (scopeError(selected)) return;
    if (active() && !await showCustomConfirm('重置后，当前范围的旧链接会失效。需要在苹果日历中删除旧订阅，再添加新链接。继续重置？')) return;
    if (busy || context !== owner || scope() !== selected) return;
    setBusy(true);
    try {
      await checkContext();
      const customConfig = custom ? readCustom() : null;
      if (!window.Sync?.enabled || !window.Sync?.autoSync) throw new Error('请先在「设置 → 账号与同步」开启云同步和自动同步。');
      const service = endpoint({ ...context.config, calendarFeedUrl: el('Endpoint').value.trim() });
      const timezone = el('Timezone').value.trim();
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
      catch { throw new Error('请输入有效的时区，例如 Asia/Shanghai。'); }
      message('正在检查订阅服务…');
      let health;
      let status;
      try {
        const check = custom ? 'custom' : todoDue ? 'todo-due' : category ? 'categories' : '1';
        const response = await fetch(service + '?health=' + check, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000) });
        status = response.status;
        if (response.ok) health = await response.json();
      } catch { /* Report a useful deployment error below. */ }
      if (status === 401) throw new Error('订阅接口要求登录（401）。请管理员关闭 calendar-feed 的网关 JWT 校验，以便苹果日历使用订阅链接。');
      if (status === 503) throw new Error('订阅服务暂不可用（503）。请管理员检查 calendar-feed 的部署状态和数据库连接。');
      if (category && health?.categories !== true) throw new Error('云端订阅接口还未启用分类订阅，请更新 calendar-feed 后重试。');
      if (todoDue && health?.todoDue !== true) throw new Error('云端订阅接口还未启用待办截止日期订阅，请更新 calendar-feed 后重试。');
      if (custom && health?.custom !== true) throw new Error('云端订阅接口还未启用自定义订阅，请更新 calendar-feed 后重试。');
      if (health?.service !== 'mst-calendar-feed' || health.version !== 1) throw new Error('订阅服务尚未配置或无法访问，请联系管理员配置日历订阅服务后重试。');
      await checkContext();
      message('正在生成订阅链接…');
      const token = (custom ? 'mix-' : todoDue ? 'due-' : category ? 'cat-' : '') + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const customId = custom ? selected === NEW_CUSTOM ? crypto.randomUUID() : selected.slice(7) : null;
      const savedScope = custom ? 'custom:' + customId : selected;
      const row = { user_id: owner.userId, token_hash: hash, timezone,
        ...(category ? { category } : {}), ...(custom ? { id: customId, ...customConfig } : {}) };
      const { error } = await owner.client.from(tableFor(selected)).upsert(row,
        { onConflict: custom ? 'id' : category ? 'user_id,category' : 'user_id' });
      if (error) throw new Error(error.code === '23505' && custom ? '已有同名订阅，请换一个名称。' : '生成订阅链接失败，请检查云服务连接后重试。');
      owner.links.delete(selected);
      clearLink();
      await checkContext();
      owner.subscriptions.set(savedScope, custom ? { id: customId, timezone, ...customConfig } : { timezone });
      if (custom) {
        let option = [...el('Scope').options].find(option => option.value === savedScope);
        if (!option) { option = new Option('', savedScope); el('Scope').add(option); }
        option.textContent = '自定义：' + customConfig.name;
        el('Scope').value = savedScope;
      }
      // This is provider configuration, already excluded from data backups and sync.
      saveFriendsConfig({ ...getFriendsConfig(), calendarFeedUrl: service });
      el('Link').value = service + '?token=' + token;
      owner.links.set(savedScope, el('Link').value);
      renderManager();
      el('Create').textContent = '重置订阅链接';
      message('订阅已开启。请复制链接到苹果日历；链接仅在本次窗口中显示。后续日程随云同步更新，苹果端刷新可能延迟。');
    } catch (error) { message(error.message || '生成订阅失败，请稍后重试。'); }
    finally { setBusy(false); }
  }
  async function revoke(selected = scope()) {
    if (busy || !context?.subscriptions.has(selected)) return;
    const owner = context;
    const category = categoryFor(selected);
    if (!await showCustomConfirm('停用后，当前范围的链接将无法继续获取日程。苹果日历中已缓存的日程需自行取消订阅以移除。')) return;
    if (busy || context !== owner || !owner.subscriptions.has(selected)) return;
    setBusy(true);
    try {
      await checkContext();
      let deletion = owner.client.from(tableFor(selected)).delete().eq('user_id', owner.userId);
      if (category) deletion = deletion.eq('category', category);
      if (isCustom(selected)) deletion = deletion.eq('id', selected.slice(7));
      const { error } = await deletion;
      if (error) throw new Error('停用失败，请检查网络后重试。');
      await checkContext();
      owner.subscriptions.delete(selected);
      owner.links.delete(selected);
      if (isCustom(selected)) {
        const editing = scope() === selected;
        [...el('Scope').options].find(option => option.value === selected)?.remove();
        if (editing) { el('Scope').value = NEW_CUSTOM; renderCustom(); }
      }
      if (!isCustom(selected) || scope() === NEW_CUSTOM) clearLink();
      renderManager();
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
  return { open, openManager: () => open(true), close, create, revoke, copy, selectScope, customChanged,
    showManager, editCustom, refreshCustom, saveCustom };
})();
