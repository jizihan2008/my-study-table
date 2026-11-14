const test = require('node:test');
const assert = require('node:assert/strict');
const api = import('../supabase/functions/calendar-feed/feed.mjs');
const now = Date.parse('2026-11-07T00:00:00Z');
const prefix = 'mst:item:v1:study_calendar_events:';
const row = (id, item) => ({ key: prefix + encodeURIComponent(id), value: { item: { id, ...item }, deleted: false }, updated_at: '2026-11-06T00:00:00Z' });
const unfold = value => value.replace(/\r\n /g, '');

test('calendar migration uses item edits and tombstones, without sharing unrelated data', async () => {
  const { calendarRecords } = await api;
  const rows = [{ key: 'study_calendar_events', value: [{ id: 1, title: 'old' }, { id: 2 }, { id: 3 }] },
    row(1, { title: 'edited' }), { key: prefix + '2', value: { deleted: true } },
    { key: 'study_notes_v2', value: [{ id: 4, title: 'secret' }] }, row(5, { title: 'new' })];
  assert.deepEqual(calendarRecords(rows).map(r => [r.item.id, r.item.title]), [[1, 'edited'], [3, undefined], [5, 'new']]);
});

test('iCalendar escapes untrusted text and folds UTF-8 at 75 bytes without splitting characters', async () => {
  const { serializeCalendar, calendarRecords } = await api;
  const result = serializeCalendar(calendarRecords([row('a', { date: '2026-11-07', title: '学习😀'.repeat(50),
    note: 'x\\y;z,1\r\nBEGIN:VEVENT', location: '教室,301' })]), { now });
  assert.ok(result.endsWith('END:VCALENDAR\r\n'));
  for (const line of result.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.ok(!result.includes('\ufffd'));
  assert.ok(unfold(result).includes('DESCRIPTION:x\\\\y\\;z\\,1\\nBEGIN:VEVENT\r\n'));
  assert.equal(result.match(/\r\nBEGIN:VEVENT\r\n/g).length, 1);
});

test('all-day inclusive MST end becomes exclusive DTEND; timed overnight values use UTC', async () => {
  const { serializeCalendar, calendarRecords } = await api;
  const result = unfold(serializeCalendar(calendarRecords([
    row('all', { date: '2026-11-07', endDate: '2026-11-09', allDay: true, startTime: '10:00' }),
    row('night', { date: '2026-11-07', startTime: '23:00', endTime: '01:00' }),
    row('multi', { date: '2026-11-07', endDate: '2026-11-09', startTime: '9:00', endTime: '10:00' }),
    row('point', { date: '2026-11-07', startTime: '12:00' }),
    row('invalid', { date: '2026-02-30' })
  ]), { now, timezone: 'Asia/Shanghai' }));
  assert.match(result, /DTSTART;VALUE=DATE:20261107\r\nDTEND;VALUE=DATE:20261110/);
  assert.match(result, /DTSTART:20261107T150000Z\r\nDTEND:20261107T170000Z/);
  assert.match(result, /DTSTART:20261107T010000Z\r\nDTEND:20261109T020000Z/);
  const point = result.split('BEGIN:VEVENT').find(v => v.includes('UID:point@mst'));
  assert.ok(!point.includes('DTEND'));
  assert.ok(!result.includes('UID:invalid'));
});

test('weekly occurrences match MST anchor week, skip dates, and remain stable across refreshes', async () => {
  const { serializeCalendar, calendarRecords } = await api;
  const records = calendarRecords([row('weekly', { date: '2026-11-07', repeat: 'weekly', weekdays: [1, 4],
    startTime: '10:00', endTime: '11:00', skippedDates: ['2026-11-05'] })]);
  const first = unfold(serializeCalendar(records, { now }));
  const next = unfold(serializeCalendar(records, { now: now + 86400000 }));
  assert.ok(first.includes('UID:weekly-20261102@mst'));
  assert.ok(!first.includes('UID:weekly-20261105@mst'));
  assert.ok(!first.includes('UID:weekly-20261029@mst'));
  assert.ok(first.includes('UID:weekly-20261109@mst'));
  assert.equal(first.split('BEGIN:VEVENT').find(v => v.includes('UID:weekly-20261109@mst')),
    next.split('BEGIN:VEVENT').find(v => v.includes('UID:weekly-20261109@mst')));
});

test('weekly wall-clock schedules retain their time across daylight savings changes', async () => {
  const { serializeCalendar, calendarRecords } = await api;
  const value = unfold(serializeCalendar(calendarRecords([row('dst', { date: '2026-10-25', repeat: 'weekly', weekdays: [0],
    startTime: '09:00', endTime: '10:00' })]), { now, timezone: 'America/New_York' }));
  assert.match(value, /DTSTART:20261025T130000Z/);
  assert.match(value, /DTSTART:20261101T140000Z/);
});

test('DST missing and ambiguous times use RFC first-occurrence/pre-gap semantics', async () => {
  const { serializeCalendar, calendarRecords } = await api;
  const value = serializeCalendar(calendarRecords([
    row('gap', { date: '2026-03-08', startTime: '02:30' }),
    row('overlap', { date: '2026-11-01', startTime: '01:30' })
  ]), { now, timezone: 'America/New_York' });
  assert.match(value, /DTSTART:20260308T073000Z/);
  assert.match(value, /DTSTART:20261101T053000Z/);
});

async function service(options = {}) {
  const { createFeedHandler, hashToken } = await api;
  const token = 'a'.repeat(64), hash = await hashToken(token);
  const requests = [];
  let active = true, lookups = 0;
  const items = [row('a', { date: '2026-11-07', title: 'A' }), row('b', { date: '2026-11-08', title: 'B' }),
    { key: prefix + 'gone', value: { deleted: true } }];
  const handler = createFeedHandler({ url: 'https://db.example', serviceKey: 'server-only', now: () => now,
    fetcher: async (address, init) => {
      const url = new URL(address), p = url.searchParams;
      requests.push({ url, init });
      if (options.fail) return new Response('private database details', { status: 500 });
      let data;
      if (url.pathname.endsWith('calendar_subscriptions')) {
        if (p.get('limit') === '0') data = [];
        else {
          lookups++;
          if (options.revokeDuringRead && lookups === 2) active = false;
          data = active && p.get('token_hash') === 'eq.' + hash ? [{ user_id: 'owner-id', timezone: 'Asia/Shanghai' }] : [];
        }
      } else {
        assert.equal(p.get('user_id'), 'eq.owner-id');
        if (p.get('key') === 'eq.study_calendar_events') data = [{ key: 'study_calendar_events', value: [{ id: 'gone', date: '2026-11-07', title: 'deleted' }] }];
        else {
          assert.equal(p.get('and'), '(key.like.' + prefix.replace(/_/g, '\\_') + '*)');
          // A server cap of one row exercises keyset pagination despite limit=500.
          const cursor = p.get('key')?.slice(3) || '';
          data = items.filter(row => row.key > cursor).slice(0, 1);
        }
      }
      return Response.json(data);
    }
  });
  return { handler, token, requests, revoke: () => { active = false; } };
}

test('HTTP feed scopes owner, paginates, sets MIME and rejects revoked or malformed tokens', async () => {
  const { handler, token, requests, revoke } = await service();
  const response = await handler(new Request('https://feed.example?token=' + token));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.match(body, /SUMMARY:A/); assert.match(body, /SUMMARY:B/);
  assert.ok(!body.includes('deleted'));
  assert.ok(requests.every(r => r.init.headers.apikey === 'server-only'));
  assert.ok(requests.every(r => !r.url.href.includes(token)));
  revoke();
  assert.equal((await handler(new Request('https://feed.example?token=' + token))).status, 404);
  const before = requests.length;
  assert.equal((await handler(new Request('https://feed.example?token=bad'))).status, 404);
  assert.equal(requests.length, before);
  assert.equal((await handler(new Request('https://feed.example', { method: 'POST' }))).status, 405);
});

test('backend health, HEAD, database failure, and concurrent revocation do not expose data', async () => {
  const normal = await service();
  const health = await normal.handler(new Request('https://feed.example?health=1'));
  assert.deepEqual(await health.json(), { service: 'mst-calendar-feed', version: 1 });
  const head = await normal.handler(new Request('https://feed.example?token=' + normal.token, { method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const failing = await service({ fail: true });
  const error = await failing.handler(new Request('https://feed.example?token=' + failing.token));
  assert.equal(error.status, 503); assert.equal(await error.text(), 'Calendar temporarily unavailable');
  const racing = await service({ revokeDuringRead: true });
  assert.equal((await racing.handler(new Request('https://feed.example?token=' + racing.token))).status, 404);
});

test('category tokens isolate event membership and can be revoked independently of the all-events token', async () => {
  const { createFeedHandler, hashToken } = await api;
  const allToken = 'a'.repeat(64);
  const courseToken = 'cat-' + 'b'.repeat(64);
  const examToken = 'cat-' + 'c'.repeat(64);
  const user = { user_id: 'owner', timezone: 'Asia/Shanghai' };
  const scoped = new Map([[await hashToken(courseToken), { ...user, category: '课程' }],
    [await hashToken(examToken), { ...user, category: '考试' }]]);
  const allHash = await hashToken(allToken);
  const items = [row('a', { date: '2026-11-08', title: 'Course', category: '课程' }),
    row('b', { date: '2026-11-08', title: 'Exam', category: '考试' }), row('c', { date: '2026-11-08', title: 'Personal' })];
  const handler = createFeedHandler({ url: 'https://db.example', serviceKey: 'server-only', now: () => now,
    fetcher: async address => {
      const url = new URL(address);
      const params = url.searchParams;
      if (params.get('limit') === '0') return Response.json([]);
      const hash = params.get('token_hash')?.slice(3);
      if (url.pathname.endsWith('/calendar_category_subscriptions')) return Response.json(scoped.has(hash) ? [scoped.get(hash)] : []);
      if (url.pathname.endsWith('/calendar_subscriptions')) return Response.json(hash === allHash ? [user] : []);
      assert.equal(params.get('user_id'), 'eq.owner');
      return Response.json(params.has('key') ? [] : items);
    }
  });
  const read = token => handler(new Request('https://feed.example?category=考试&token=' + token));
  const course = await (await read(courseToken)).text();
  assert.match(course, /X-WR-CALNAME:MST · 课程/);
  assert.match(course, /SUMMARY:Course/);
  assert.doesNotMatch(course, /SUMMARY:(Exam|Personal)/);
  assert.match(await (await read(examToken)).text(), /SUMMARY:Exam/);
  assert.match(await (await read(allToken)).text(), /SUMMARY:Personal/);
  items[0].value.item.category = '考试';
  assert.doesNotMatch(await (await read(courseToken)).text(), /SUMMARY:Course/);
  assert.match(await (await read(examToken)).text(), /SUMMARY:Course/);
  scoped.delete(await hashToken(courseToken));
  assert.equal((await read(courseToken)).status, 404);
  assert.equal((await read(examToken)).status, 200);
  assert.equal((await read(allToken)).status, 200);
  const health = await handler(new Request('https://feed.example?health=categories'));
  assert.equal((await health.json()).categories, true);
});

test('todo deadline tokens serve only that owner’s active deadlines as stable all-day events', async () => {
  const { createFeedHandler, hashToken } = await api;
  const token = 'due-' + 'a'.repeat(64);
  const hash = await hashToken(token);
  const key = 'study_todos_v2';
  const todoPrefix = 'mst:item:v1:' + key + ':';
  const task = (id, text, dueDate, done = false) => ({ id, text, dueDate, done, content: 'Private details' });
  const legacy = [task('a', 'Old name', '2026-11-05'), task('b', 'Deleted task', '2026-11-07'),
    task('c', 'Completed yesterday', '2026-11-07', true), task('d', 'Completed today', '2026-11-08', true),
    task('e', 'No deadline', ''), task('f', 'Invalid deadline', '2026-02-30')];
  const changed = task('a', 'Renamed overdue task', '2026-11-06');
  const items = [
    { key: todoPrefix + 'a', value: { item: changed } },
    { key: todoPrefix + 'b', value: { deleted: true } }
  ];
  let active = true;
  const handler = createFeedHandler({ url: 'https://db.example', serviceKey: 'server-only',
    now: () => Date.parse('2026-11-07T16:15:00Z'),
    fetcher: async address => {
      const url = new URL(address);
      const params = url.searchParams;
      if (params.get('limit') === '0') return Response.json([]);
      if (url.pathname.endsWith('/calendar_todo_due_subscriptions')) {
        return Response.json(active && params.get('token_hash') === 'eq.' + hash ? [{ user_id: 'owner', timezone: 'Asia/Shanghai' }] : []);
      }
      assert.equal(url.pathname, '/rest/v1/user_data');
      assert.equal(params.get('user_id'), 'eq.owner');
      if (params.get('key') === 'eq.' + key) return Response.json([{ key, value: legacy }]);
      assert.ok(params.get('and')?.includes('study\\_todos\\_v2'));
      return Response.json(params.has('key') ? [] : items);
    }
  });
  const read = () => handler(new Request('https://feed.example?token=' + token));
  const response = await read();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  const body = await response.text();
  assert.match(body, /X-WR-CALNAME:MST · 待办截止日期/);
  assert.match(body, /UID:todo-due-a@mst/);
  assert.match(body, /SUMMARY:Renamed overdue task\r\nDTSTART;VALUE=DATE:20261106\r\nDTEND;VALUE=DATE:20261107/);
  assert.match(body, /SUMMARY:Completed today/);
  assert.doesNotMatch(body, /Old name|Deleted task|Completed yesterday|No deadline|Invalid deadline/);
  assert.match(body, /DESCRIPTION:路径：Renamed overdue task\\n\\n正文：\\nPrivate details/);
  changed.dueDate = '2026-11-10';
  const moved = await (await read()).text();
  assert.match(moved, /UID:todo-due-a@mst/);
  assert.match(moved, /SUMMARY:Renamed overdue task\r\nDTSTART;VALUE=DATE:20261110/);
  changed.dueDate = '';
  assert.doesNotMatch(await (await read()).text(), /UID:todo-due-a@mst/);
  active = false;
  assert.equal((await read()).status, 404);
  const health = await handler(new Request('https://feed.example?health=todo-due'));
  assert.equal((await health.json()).todoDue, true);
});

test('deadline feeds include complete ancestor paths and full body in standalone and custom subscriptions', async () => {
  const { createFeedHandler, hashToken } = await api;
  const dueToken = 'due-' + 'e'.repeat(64);
  const mixToken = 'mix-' + 'f'.repeat(64);
  const hashes = new Map([[await hashToken(dueToken), false], [await hashToken(mixToken), true]]);
  const key = 'study_todos_v2';
  const content = '# 练习说明\n分号;逗号,反斜线\\\n' + '完整正文😀\n'.repeat(1500) + '正文末尾';
  const root = { id: 1, text: '课程', content: '父级正文不属于子任务正文' };
  const parent = { id: 2, text: '数学', parentId: '1', done: true };
  const child = { id: 3, text: '完成练习', parentId: 2, dueDate: '2026-11-09', content };
  const orphan = { id: 4, text: '孤立任务', parentId: 999, dueDate: '2026-11-09' };
  const cycle = { id: 5, text: '循环任务', parentId: 5, dueDate: '2026-11-09' };
  const updated = '2026-11-08T00:00:00Z';
  const subscription = { user_id: 'owner', timezone: 'Asia/Shanghai', name: '完整待办',
    include_events: false, categories: [], include_todo_due: true };
  let parentUpdated = updated;
  const handler = createFeedHandler({ url: 'https://db.example', serviceKey: 'server-only', now: () => now,
    fetcher: async address => {
      const url = new URL(address);
      const params = url.searchParams;
      if (url.pathname.endsWith('_subscriptions')) {
        const isCustom = url.pathname.endsWith('/calendar_custom_subscriptions');
        const hash = params.get('token_hash')?.slice(3);
        return Response.json(hashes.has(hash) && hashes.get(hash) === isCustom ? [subscription] : []);
      }
      assert.equal(params.get('user_id'), 'eq.owner');
      if (params.get('key') === 'eq.' + key) return Response.json([{ key, value: [root, parent, child, orphan, cycle], updated_at: updated }]);
      if (params.has('key')) return Response.json([]);
      return Response.json([{ key: 'mst:item:v1:study_todos_v2:2', value: { item: parent }, updated_at: parentUpdated }]);
    }
  });
  const read = async token => unfold(await (await handler(new Request('https://feed.example?token=' + token))).text());
  const due = await read(dueToken);
  assert.match(due, /SUMMARY:完成练习\r\n/);
  assert.doesNotMatch(due, /SUMMARY:课程/);
  const escaped = content.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  assert.ok(due.includes('DESCRIPTION:路径：课程 › 数学 › 完成练习\\n\\n正文：\\n' + escaped + '\r\n'));
  assert.doesNotMatch(due, /父级正文不属于子任务正文/);
  assert.match(due, /SUMMARY:孤立任务/);
  assert.match(due, /SUMMARY:循环任务/);
  assert.match(await read(mixToken), /SUMMARY:完成练习\r\n/);
  assert.ok((await read(mixToken)).includes(escaped));
  parent.text = '高等数学';
  parentUpdated = '2026-11-09T10:00:00Z';
  const renamed = await read(dueToken);
  const entry = renamed.split('BEGIN:VEVENT').find(value => value.includes('UID:todo-due-3@mst'));
  assert.match(entry, /SUMMARY:完成练习\r\n/);
  assert.match(entry, /DESCRIPTION:路径：课程 › 高等数学 › 完成练习/);
  assert.match(entry, /LAST-MODIFIED:20261109T100000Z/);
});

test('custom subscriptions combine selected categories and deadlines, deduplicate events, and fail closed on config changes', async () => {
  const { createFeedHandler, hashToken } = await api;
  const token = 'mix-' + 'd'.repeat(64);
  const tokenHash = await hashToken(token);
  let active = true;
  let lookupCount = 0;
  let changeDuringRead = false;
  const configuration = { user_id: 'owner', timezone: 'Asia/Shanghai', name: '课程与截止日期',
    include_events: false, categories: ['课程'], include_todo_due: true };
  const events = [row('a', { date: '2026-11-08', title: 'Course', category: '课程' }),
    row('b', { date: '2026-11-08', title: 'Exam', category: '考试' }), row('c', { date: '2026-11-08', title: 'Personal' })];
  const todos = [{ key: 'mst:item:v1:study_todos_v2:a',
    value: { item: { id: 'a', text: 'Deadline', dueDate: '2026-11-09' } } }];
  const handler = createFeedHandler({ url: 'https://db.example', serviceKey: 'server-only', now: () => now,
    fetcher: async address => {
      const url = new URL(address);
      const params = url.searchParams;
      if (params.get('limit') === '0') return Response.json([]);
      if (url.pathname.endsWith('/calendar_custom_subscriptions')) {
        lookupCount++;
        if (changeDuringRead && lookupCount === 2) configuration.categories = ['考试'];
        return Response.json(active && params.get('token_hash') === 'eq.' + tokenHash ? [configuration] : []);
      }
      assert.equal(url.pathname, '/rest/v1/user_data');
      assert.equal(params.get('user_id'), 'eq.owner');
      if (params.get('key')?.startsWith('eq.') || params.get('key')?.startsWith('gt.')) return Response.json([]);
      return Response.json(params.get('and').includes('study\\_todos') ? todos : events);
    }
  });
  const read = async () => {
    lookupCount = 0;
    return handler(new Request('https://feed.example?token=' + token + '&include_events=true'));
  };
  const selected = await (await read()).text();
  assert.match(selected, /X-WR-CALNAME:MST · 课程与截止日期/);
  assert.match(selected, /SUMMARY:Course/);
  assert.match(selected, /SUMMARY:Deadline/);
  assert.doesNotMatch(selected, /SUMMARY:Exam|SUMMARY:Personal/);
  configuration.categories = ['课程', '考试', '课程'];
  configuration.include_events = true;
  const all = await (await read()).text();
  assert.equal(all.match(/SUMMARY:Course/g).length, 1);
  assert.match(all, /SUMMARY:Exam/);
  assert.match(all, /SUMMARY:Personal/);
  configuration.include_events = false;
  configuration.include_todo_due = false;
  configuration.categories = [''];
  const unclassified = await (await read()).text();
  assert.match(unclassified, /SUMMARY:Personal/);
  assert.doesNotMatch(unclassified, /SUMMARY:Course|SUMMARY:Exam|SUMMARY:Deadline/);
  configuration.categories = [];
  assert.equal((await read()).status, 503);
  configuration.categories = ['课程'];
  changeDuringRead = true;
  const raced = await read();
  assert.equal(raced.status, 503);
  assert.doesNotMatch(await raced.text(), /Course|Exam/);
  changeDuringRead = false;
  active = false;
  assert.equal((await read()).status, 404);
  const health = await handler(new Request('https://feed.example?health=custom'));
  assert.equal((await health.json()).custom, true);
});
