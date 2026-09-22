'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadCodegen() {
  const values = new Map();
  const window = {};
  const context = vm.createContext({
    console,
    document: { getElementById: () => null },
    localStorage: {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key)
    },
    setTimeout,
    clearTimeout,
    window
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'codegen.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'js/codegen.js' });
  return window;
}

test('Codex JSONL agent messages expose plugin summaries', () => {
  const window = loadCodegen();
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'agent_message',
        text: '已完成。\n' + JSON.stringify({
          type: 'plugin',
          id: 'focus-helper',
          name: '专注助手',
          description: '增加专注入口',
          summary: '已创建扩展'
        })
      }
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
  ].join('\n');

  assert.deepEqual(
    JSON.parse(JSON.stringify(window.parseAgentSummary(stdout))),
    {
      type: 'plugin',
      id: 'focus-helper',
      name: '专注助手',
      description: '增加专注入口',
      summary: '已创建扩展'
    }
  );
});
