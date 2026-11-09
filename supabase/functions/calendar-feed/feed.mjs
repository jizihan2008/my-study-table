// No runtime dependencies: shared by the Edge Function and Node integration tests.
const CALENDAR_KEY = 'study_calendar_events';
const TODO_KEY = 'study_todos_v2';
const itemPrefix = key => 'mst:item:v1:' + key + ':';
const DAY = 86400000;
const encoder = new TextEncoder();
const validToken = value => /^[0-9a-f]{64}$/.test(value || '');

export async function hashToken(token) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}
const dayText = ms => new Date(ms).toISOString().slice(0, 10);
const compact = value => value.replace(/-/g, '');
function time(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  return m && +m[1] < 24 && +m[2] < 60 ? m[1].padStart(2, '0') + ':' + m[2] : '';
}
function text(value) {
  return String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
function fold(line) {
  let result = '', width = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (width + bytes > 75) { result += '\r\n '; width = 1; }
    result += char; width += bytes;
  }
  return result;
}
const stamp = ms => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// Convert wall-clock values in the subscription's IANA zone, independent of server TZ.
function wallClock(formatter, day, clock) {
  const target = Date.parse(day + 'T' + clock + ':00Z');
  const localValue = ms => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  };
  const candidates = [...new Set([-DAY, DAY].map(delta => {
    const probe = target + delta;
    return target - (localValue(probe) - probe);
  }))];
  const matching = candidates.filter(ms => localValue(ms) === target);
  // Ambiguous fall-back times use the first occurrence; spring gaps use the
  // pre-gap offset (later instant), following RFC 5545's DATE-TIME semantics.
  return stamp(matching.length ? Math.min(...matching) : Math.max(...candidates));
}

// Item rows (including tombstones) override the legacy whole-array migration source.
export function calendarRecords(rows, key = CALENDAR_KEY) {
  const prefix = itemPrefix(key);
  const records = new Map();
  const legacy = rows.find(row => row.key === key);
  if (legacy && Array.isArray(legacy.value)) {
    for (const item of legacy.value) if (item && item.id != null) records.set(String(item.id), { item, updated: legacy.updated_at });
  }
  for (const row of rows) {
    if (!row.key.startsWith(prefix)) continue;
    let id;
    try { id = decodeURIComponent(row.key.slice(prefix.length)); } catch { continue; }
    if (row.value?.deleted) records.delete(id);
    else if (row.value?.item && String(row.value.item.id) === id) records.set(id, { item: row.value.item, updated: row.updated_at });
  }
  return [...records.values()].sort((a, b) => String(a.item.id).localeCompare(String(b.item.id)));
}

function todoDueRecords(records, timezone, now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const { year, month, day } = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const today = [year, month, day].join('-');
  return records
    .filter(({ item }) => date(item.dueDate) !== null && (!item.done || item.dueDate >= today))
    .map(({ item, updated }) => ({
      item: { id: 'todo-due-' + item.id, date: item.dueDate, title: item.text || '未命名待办', allDay: true },
      updated
    }));
}

export function serializeCalendar(records, { timezone = 'Asia/Shanghai', now = Date.now(), category = '', todoDue = false } = {}) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const today = Date.parse(dayText(now) + 'T00:00:00Z');
  const from = today - 365 * DAY, until = today + 730 * DAY;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//My Study Table//Calendar Subscription//ZH',
    'CALSCALE:GREGORIAN', 'X-WR-CALNAME:' + (todoDue ? 'MST · 待办截止日期' : category ? 'MST · ' + text(category) : 'MST 日程'),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  let count = 0;
  for (const { item: ev, updated } of records) {
    const anchor = date(ev.date);
    if (anchor === null || ev.id == null) continue;
    const end = date(ev.endDate);
    const duration = end !== null && end >= anchor ? end - anchor : 0;
    const startTime = time(ev.startTime || ev.time), endTime = time(ev.endTime);
    const allDay = ev.allDay || !startTime;
    const weekly = ev.repeat === 'weekly';
    const weekdays = Array.isArray(ev.weekdays) ? [...new Set(ev.weekdays.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))] : [];
    if (!weekdays.length) weekdays.push(new Date(anchor).getUTCDay());
    const weekStart = anchor - new Date(anchor).getUTCDay() * DAY;
    const dates = [];
    if (weekly) {
      for (let d = Math.max(weekStart, from - duration); d <= until; d += DAY) {
        if (weekdays.includes(new Date(d).getUTCDay()) && !(ev.skippedDates || []).includes(dayText(d))) dates.push(d);
      }
    } else dates.push(anchor);
    for (const occurrence of dates) {
      if (++count > 50000) throw new Error('Calendar too large');
      const startDay = dayText(occurrence);
      // Separate instances give correct local times across DST changes and stable IDs on refresh.
      const uid = encodeURIComponent(String(ev.id)) + (weekly ? '-' + compact(startDay) : '') + '@mst';
      const modified = Number.isFinite(Date.parse(updated)) ? Date.parse(updated) : Number(ev.createdAt) || 0;
      lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp(modified), 'LAST-MODIFIED:' + stamp(modified),
        'SUMMARY:' + text(ev.title));
      if (allDay) {
        lines.push('DTSTART;VALUE=DATE:' + compact(startDay), 'DTEND;VALUE=DATE:' + compact(dayText(occurrence + duration + DAY)));
      } else {
        lines.push('DTSTART:' + wallClock(formatter, startDay, startTime));
        if (endTime) {
          const endDay = occurrence + duration + (duration === 0 && endTime <= startTime ? DAY : 0);
          lines.push('DTEND:' + wallClock(formatter, dayText(endDay), endTime));
        }
      }
      if (ev.note) lines.push('DESCRIPTION:' + text(ev.note));
      if (ev.location) lines.push('LOCATION:' + text(ev.location));
      lines.push('END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function createFeedHandler({ url, serviceKey, fetcher = fetch, now = () => Date.now() }) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
  const reply = (body, status = 200, extra = {}) => new Response(body, { status, headers: { ...headers, ...extra } });
  async function query(table, params) {
    const response = await fetcher(url.replace(/\/$/, '') + '/rest/v1/' + table + '?' + new URLSearchParams(params), {
      headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey }, signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Database unavailable');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid database result');
    return rows;
  }
  return async request => {
    if (request.method === 'OPTIONS') return reply(null, 204);
    if (!['GET', 'HEAD'].includes(request.method)) return reply('Method not allowed', 405, { Allow: 'GET, HEAD, OPTIONS' });
    if (!url || !serviceKey) return reply('Calendar service not configured', 503);
    const params = new URL(request.url).searchParams;
    try {
      const health = params.get('health');
      if (health === '1' || health === 'categories' || health === 'todo-due') {
        // Check the migration as well as the function deployment, without disclosing users.
        await query('calendar_subscriptions', { select: 'user_id', limit: '0' });
        if (health === 'categories') await query('calendar_category_subscriptions', { select: 'category', limit: '0' });
        if (health === 'todo-due') await query('calendar_todo_due_subscriptions', { select: 'user_id', limit: '0' });
        return reply(JSON.stringify({ service: 'mst-calendar-feed', version: 1,
          ...(health === 'categories' ? { categories: true } : health === 'todo-due' ? { todoDue: true } : {}) }), 200,
          { 'Content-Type': 'application/json' });
      }
      const token = params.get('token') || '';
      const scoped = token.startsWith('cat-');
      const todoDue = token.startsWith('due-');
      if (!validToken(scoped || todoDue ? token.slice(4) : token)) return reply('Calendar not found', 404);
      const table = todoDue ? 'calendar_todo_due_subscriptions' : scoped ? 'calendar_category_subscriptions' : 'calendar_subscriptions';
      const key = todoDue ? TODO_KEY : CALENDAR_KEY;
      const prefix = itemPrefix(key);
      const tokenHash = 'eq.' + await hashToken(token);
      const lookup = { select: scoped ? 'user_id,timezone,category' : 'user_id,timezone', token_hash: tokenHash, limit: '1' };
      const subscriptions = await query(table, lookup);
      const subscription = subscriptions[0];
      if (!subscription || (scoped && !subscription.category)) return reply('Calendar not found', 404);
      const rows = await query('user_data', { select: 'key,value,updated_at', user_id: 'eq.' + subscription.user_id, key: 'eq.' + key });
      // Keyset pagination respects even a server row cap below the requested page size.
      let cursor = '';
      for (;;) {
        const page = await query('user_data', { select: 'key,value,updated_at', user_id: 'eq.' + subscription.user_id,
          and: `(key.like.${prefix.replace(/_/g, '\\_')}*)`, ...(cursor ? { key: 'gt.' + cursor } : {}), order: 'key.asc', limit: '500' });
        if (!page.length) break;
        const next = page[page.length - 1].key;
        if (next <= cursor || rows.length + page.length > 50000) throw new Error('Calendar too large');
        rows.push(...page); cursor = next;
      }
      // Recheck after reading so a concurrent reset/revoke cannot serve an old token.
      const [active] = await query(table, lookup);
      if (!active || active.user_id !== subscription.user_id || active.category !== subscription.category) return reply('Calendar not found', 404);
      const records = calendarRecords(rows, key);
      const timestamp = now();
      const matching = todoDue ? todoDueRecords(records, subscription.timezone, timestamp)
        : scoped ? records.filter(({ item }) => item.category === subscription.category) : records;
      const body = serializeCalendar(matching, { timezone: subscription.timezone, now: timestamp, category: subscription.category, todoDue });
      return reply(request.method === 'HEAD' ? null : body, 200, { 'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="mst-calendar.ics"' });
    } catch {
      // Never return a partial/empty successful calendar on a database or conversion error.
      return reply('Calendar temporarily unavailable', 503);
    }
  };
}
