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
  assert.doesNotMatch(body, /Old name|Deleted task|Completed yesterday|No deadline|Invalid deadline|Private details/);
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
