const test = require('node:test');
const assert = require('node:assert/strict');

test('CloudBase adapter exposes the Supabase-shaped database surface without realtime', () => {
  const calls = [];
  const oldCloudbase = global.cloudbase;
  global.cloudbase = {
    init(options) {
      calls.push(options);
      return {
        auth: { getSession() {} },
        rdb: {
          from(table) { return table; },
          rpc(name) { return name; }
        },
        storage: { from() {} }
      };
    }
  };
  delete require.cache[require.resolve('../js/cloud-client.js')];
  const cloud = require('../js/cloud-client.js');
  const client = cloud.createClient({
    provider: 'cloudbase',
    envId: 'example-env',
    accessKey: 'public-key',
    region: 'ap-shanghai'
  });
  assert.equal(client.provider, 'cloudbase');
  assert.equal(client.from('profiles'), 'profiles');
  assert.equal(client.rpc('hello'), 'hello');
  assert.equal(typeof client.channel, 'undefined');
  assert.deepEqual(calls[0], {
    env: 'example-env',
    region: 'ap-shanghai',
    accessKey: 'public-key'
  });
  global.cloudbase = oldCloudbase;
});

test('Supabase auth storage falls back when iPad Safari rejects localStorage writes', () => {
  const oldLocalStorage = global.localStorage;
  const oldSessionStorage = global.sessionStorage;
  const sessionValues = new Map();
  global.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); }
  };
  global.sessionStorage = {
    getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
    setItem(key, value) { sessionValues.set(key, value); },
    removeItem(key) { sessionValues.delete(key); }
  };

  delete require.cache[require.resolve('../js/cloud-client.js')];
  const cloud = require('../js/cloud-client.js');
  const storage = cloud.createResilientAuthStorage();
  storage.setItem('sb-test-auth-token', '{"access_token":"token"}');
  assert.equal(storage.getItem('sb-test-auth-token'), '{"access_token":"token"}');
  assert.equal(sessionValues.get('sb-test-auth-token'), '{"access_token":"token"}');
  storage.removeItem('sb-test-auth-token');
  assert.equal(storage.getItem('sb-test-auth-token'), null);

  global.localStorage = oldLocalStorage;
  global.sessionStorage = oldSessionStorage;
});
