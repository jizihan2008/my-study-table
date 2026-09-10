// OpenAI-compatible Chat Completions streaming helpers.
(function createAiStream(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AIStream = api;
})(typeof window !== 'undefined' ? window : globalThis, function buildAiStream() {
  'use strict';

  function readTextParts(value) {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      return typeof part.text === 'string' ? part.text : (typeof part.content === 'string' ? part.content : '');
    }).join('');
  }

  function mergeToolCalls(target, deltas) {
    for (const delta of deltas || []) {
      if (!delta) continue;
      const index = Number.isInteger(delta.index) ? delta.index : target.length;
      const current = target[index] || { id: '', type: delta.type || 'function', function: { name: '', arguments: '' } };
      if (delta.id) current.id += delta.id;
      if (delta.type) current.type = delta.type;
      if (delta.function) {
        current.function = current.function || { name: '', arguments: '' };
        if (delta.function.name) current.function.name += delta.function.name;
        if (delta.function.arguments) current.function.arguments += delta.function.arguments;
      }
      target[index] = current;
    }
  }

  function parseEventBlock(block, onData) {
    const data = String(block || '').split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => {
      const value = line.slice(5);
      return value.startsWith(' ') ? value.slice(1) : value;
    }).join('\n');
    if (data) onData(data);
  }

  function createSseParser(onData) {
    let buffer = '';
    return Object.freeze({
      feed(text) {
        buffer += String(text || '');
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          parseEventBlock(block, onData);
        }
      },
      flush() {
        if (buffer.trim()) parseEventBlock(buffer, onData);
        buffer = '';
      }
    });
  }

  async function consumeChatCompletionStream(response, onDelta) {
    if (!response || !response.body || typeof response.body.getReader !== 'function') {
      throw new Error('当前运行环境不支持流式响应读取');
    }
    const state = { content: '', reasoning: '', toolCalls: [], finishReason: '', usage: null };
    const emit = (contentDelta, reasoningDelta) => {
      if (typeof onDelta === 'function') {
        onDelta({
          content: state.content,
          reasoning: state.reasoning,
          contentDelta,
          reasoningDelta,
          toolCalls: state.toolCalls,
          finishReason: state.finishReason,
          usage: state.usage
        });
      }
    };
    const parser = createSseParser(data => {
      if (data === '[DONE]') return;
      let chunk;
      try { chunk = JSON.parse(data); }
      catch (error) { throw new Error('流式响应包含无效 JSON：' + error.message); }
      if (chunk && chunk.error) throw new Error(chunk.error.message || 'AI 流式响应失败');
      if (chunk && chunk.usage) state.usage = chunk.usage;
      const choice = chunk && chunk.choices && chunk.choices[0];
      if (!choice) return;
      const delta = choice.delta || choice.message || {};
      const contentDelta = readTextParts(delta.content);
      const reasoningDelta = readTextParts(delta.reasoning_content || delta.reasoning || delta.thinking);
      state.content += contentDelta;
      state.reasoning += reasoningDelta;
      mergeToolCalls(state.toolCalls, delta.tool_calls);
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
      if (contentDelta || reasoningDelta || choice.finish_reason || (delta.tool_calls && delta.tool_calls.length)) {
        emit(contentDelta, reasoningDelta);
      }
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (response._aiRequestControl && typeof response._aiRequestControl.touch === 'function') {
          response._aiRequestControl.touch();
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.flush();
      return state;
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  }

  return Object.freeze({ createSseParser, consumeChatCompletionStream, mergeToolCalls, readTextParts });
});
