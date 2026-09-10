'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AIStream = require('../js/ai-stream');

function responseFromBytes(bytes, cuts) {
  let offset = 0;
  const chunks = cuts.map(size => {
    const part = bytes.slice(offset, offset + size);
    offset += size;
    return part;
  });
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return {
    body: new ReadableStream({
      start(controller) {
        chunks.forEach(chunk => controller.enqueue(chunk));
        controller.close();
      }
    })
  };
}

function loadAiApi(fetchWithPolicy) {
  const context = {
    AIStream,
    AIClient: {
      confirmSensitiveContent: async () => true,
      fetchWithPolicy,
      recordUsage() {}
    },
    buildDeepThinkParams: () => ({}),
    isKimiModel: () => false,
    getActiveConv: () => null,
    extractToolCalls: text => ({ cleanText: text, toolCalls: [] }),
    appendMessage() {},
    localStorage: { getItem: () => null },
    TextDecoder,
    console
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-api.js'), 'utf8');
  vm.runInContext(code, context);
  return context;
}

test('SSE parser accepts fragmented CRLF frames and ignores comments', () => {
  const received = [];
  const parser = AIStream.createSseParser(data => received.push(data));
  parser.feed(': keep-alive\r\nda');
  parser.feed('ta: {"one":1}\r\n\r\ndata: [DO');
  parser.feed('NE]\n\n');
  parser.flush();
  assert.deepEqual(received, ['{"one":1}', '[DONE]']);
});

test('chat completion stream assembles UTF-8 text, reasoning, tools and usage', async () => {
  const frames = [
    { choices: [{ delta: { reasoning_content: '先想' } }] },
    { choices: [{ delta: { content: '你好，' } }] },
    { choices: [{ delta: { content: [{ type: 'text', text: '世界' }], tool_calls: [{ index: 0, id: 'call_', function: { name: 'get_', arguments: '{"a"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '1', function: { name: 'todo', arguments: ':1}' } }] }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }
  ];
  const payload = frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(payload);
  const snapshots = [];
  const result = await AIStream.consumeChatCompletionStream(responseFromBytes(bytes, [1, 2, 5, 11, 3, 17]), value => snapshots.push(value));

  assert.equal(result.content, '你好，世界');
  assert.equal(result.reasoning, '先想');
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 5 });
  assert.equal(result.toolCalls[0].id, 'call_1');
  assert.equal(result.toolCalls[0].function.name, 'get_todo');
  assert.equal(result.toolCalls[0].function.arguments, '{"a":1}');
  assert.equal(snapshots.at(-1).finishReason, 'stop');
});

test('AI client keeps a streaming request cancellable until the body consumer releases it', async () => {
  const values = new Map();
  const localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value))
  };
  const response = { status: 200, body: null, headers: { get() { return null; } } };
  const window = {};
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai-client.js'), 'utf8');
  vm.runInNewContext(code, {
    window,
    localStorage,
    fetch: async () => response,
    AbortController,
    DOMException,
    setTimeout,
    clearTimeout,
    console
  });

  const returned = await window.AIClient.fetchWithPolicy('/stream', {}, { scope: 'conv-1', keepAlive: true, retries: 0 });
  assert.equal(window.AIClient.cancel('conv-1'), 1);
  assert.equal(returned._aiRequestControl.controller.signal.aborted, true);
  returned._aiRequestControl.release();
  assert.equal(window.AIClient.cancel('conv-1'), 0);
});

test('normal chat API requests stream by default when an incremental callback is supplied', async () => {
  const payload = 'data: {"choices":[{"delta":{"content":"A"}}]}\n\n'
    + 'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n';
  let sentBody;
  const response = responseFromBytes(new TextEncoder().encode(payload), [4, 9, 2]);
  response.ok = true;
  response.status = 200;
  response.headers = { get: () => 'text/event-stream' };
  const context = loadAiApi(async (_url, options, policy) => {
    sentBody = JSON.parse(options.body);
    assert.equal(policy.keepAlive, true);
    return response;
  });
  const deltas = [];
  const result = await context.callAiApi(
    [{ role: 'user', content: 'hello' }],
    { baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'model', temperature: 0.2 },
    { id: 7 },
    { onDelta: snapshot => deltas.push(snapshot.content) }
  );

  assert.equal(sentBody.stream, true);
  assert.equal(result.cleanText, 'AB');
  assert.deepEqual(deltas, ['A', 'AB']);
});

test('an endpoint that explicitly rejects streaming falls back to one non-stream request', async () => {
  const bodies = [];
  const context = loadAiApi(async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: { message: 'streaming is not supported' } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'fallback' }, finish_reason: 'stop' }] })
    };
  });
  const result = await context.callAiApi(
    [{ role: 'user', content: 'hello' }],
    { baseUrl: 'https://legacy.test/v1', apiKey: 'key', model: 'model', temperature: 0.2 },
    { id: 9 },
    { onDelta() {} }
  );

  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].stream, true);
  assert.equal('stream' in bodies[1], false);
  assert.equal(result.cleanText, 'fallback');
});
