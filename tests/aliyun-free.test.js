const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('shared schema avoids SECURITY DEFINER and lets authenticated users create their own profile', () => {
  const sql = fs.readFileSync(path.join(root, 'cloudbase', 'schema.sql'), 'utf8');
  const executable = sql.replace(/^\s*--.*$/gm, '');
  assert.doesNotMatch(executable, /security\s+definer/i);
  assert.match(sql, /create policy "profiles_self_insert"[\s\S]*for insert to authenticated[\s\S]*auth\.uid\(\)::text = id/i);
  assert.match(sql, /create or replace function public\.is_friend[\s\S]*security invoker/i);
});

test('Alibaba free configuration uses the ordinary Supabase client surface', () => {
  const oldSupabase = global.supabase;
  const calls = [];
  global.supabase = {
    createClient(url, key, options) {
      calls.push({ url, key, options });
      return { auth: {}, from() {} };
    }
  };
  delete require.cache[require.resolve('../js/cloud-client.js')];
  const cloud = require('../js/cloud-client.js');
  const client = cloud.createClient({
    provider: 'supabase',
    platform: 'aliyun-free',
    url: 'https://example.supabase.test',
    anonKey: 'anon-public-key'
  });
  assert.equal(client.provider, 'supabase');
  assert.equal(calls[0].url, 'https://example.supabase.test');
  assert.equal(calls[0].key, 'anon-public-key');
  assert.equal(calls[0].options.auth.persistSession, true);
  global.supabase = oldSupabase;
});

test('the built-in cloud endpoint is Alibaba Supabase and contains a valid public JWT shape', () => {
  const friends = fs.readFileSync(path.join(root, 'js', 'friends.js'), 'utf8');
  assert.match(friends, /platform: 'aliyun-free'/);
  assert.match(friends, /url: 'https:\/\/spb-shxqp0mq19i5l1ln\.supabase\.opentrust\.net'/);
  assert.match(friends, /anonKey: 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'/);
  assert.doesNotMatch(friends.match(/anonKey: '([^']+)'/)[1], /\\/);
});

test('settings expose only built-in Alibaba and custom Supabase choices', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'js', 'settings.js'), 'utf8');
  const select = html.match(/<select id="supabaseProvider"[\s\S]*?<\/select>/)[0];
  assert.match(select, /value="aliyun"/);
  assert.match(select, /value="custom"/);
  assert.doesNotMatch(select, /value="cloudbase"|value="aliyun-free"/);
  assert.match(settings, /fields\.style\.display = builtIn \? 'none' : 'block'/);
  assert.match(settings, /builtIn\s*\? cloneBuiltinCloudConfig\(\)/);
});

test('Supabase logout is local-scoped in both friends and plugin store flows', () => {
  const friends = fs.readFileSync(path.join(root, 'js', 'friends.js'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'js', 'store.js'), 'utf8');
  assert.match(friends, /signOut\(client\.provider === 'cloudbase' \? undefined : \{ scope: 'local' \}\)/);
  assert.match(store, /signOut\(sb\.provider === 'cloudbase' \? undefined : \{ scope: 'local' \}\)/);
});

test('successful login renders from the returned session instead of immediately rereading mobile storage', () => {
  const friends = fs.readFileSync(path.join(root, 'js', 'friends.js'), 'utf8');
  assert.match(friends, /return \{ ok: true, data, profile \}/);
  assert.match(friends, /friendsAuthUser = res\.profile/);
  assert.match(friends, /await renderFriends\(res\.data && res\.data\.session\)/);
  assert.match(friends, /const session = sessionHint \|\| await friendsGetSession\(\)/);
  assert.match(friends, /friendsGetMyProfile\(session\.user\)/);
});
