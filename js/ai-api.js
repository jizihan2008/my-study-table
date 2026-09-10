// ═══════════════════════════════════════════════
//  AI API 通信：API 调用、消息构建、工具调用循环
// ═══════════════════════════════════════════════

// ═══════════ Core AI call (extracted for tool-call loop reuse) ═══════════
// Returns { cleanText, toolCalls, reasoning } or throws on error
// If conv is provided, raw API request/response are appended to conv._rawLogs
async function callAiApiNonStream(apiMessages, apiCfg, conv, options = {}) {
  if (!options.skipSensitiveCheck && typeof AIClient !== 'undefined') {
    const allowed = await AIClient.confirmSensitiveContent(apiMessages);
    if (!allowed) throw new Error('已取消发送敏感信息');
  }
  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  const deepThinkParams = buildDeepThinkParams(apiCfg);

  // Determine max_tokens: user setting > model default > fallback
  const defaultMaxTokens = isKimiModel() ? 8192 : 2048;
  const maxTokens = apiCfg.maxTokens || defaultMaxTokens;

  const modelLower = (apiCfg.model || '').toLowerCase();
  const requestBody = {
    model: apiCfg.model,
    messages: apiMessages,
    ...deepThinkParams
  };
  // Kimi K3 及之后使用 max_completion_tokens（max_tokens 已弃用）；其余模型用 max_tokens
  if (modelLower.includes('k3') || modelLower.includes('k2.7')) {
    requestBody.max_completion_tokens = maxTokens;
  } else {
    requestBody.max_tokens = maxTokens;
  }
  // Kimi API 不支持 temperature（文档明确"请勿显式传入"，传了会 400），其它模型正常发送
  if (!isKimiModel()) {
    requestBody.temperature = apiCfg.temperature;
  }

  // Kimi builtin web search (native $web_search tool)
  const activeConv = typeof getActiveConv === 'function' ? getActiveConv() : null;
  if (isKimiModel() && activeConv && activeConv._webSearchMode === 'native') {
    requestBody.tools = [{
      type: 'builtin_function',
      function: { name: '$web_search' }
    }];
  }

  const requestTime = new Date().toISOString();

  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiCfg.apiKey
    },
    body: JSON.stringify(requestBody)
  };
  const response = typeof AIClient !== 'undefined'
    ? await AIClient.fetchWithPolicy(baseUrl + '/chat/completions', requestOptions, { scope: conv && conv.id, timeoutMs: apiCfg.timeoutMs })
    : await fetch(baseUrl + '/chat/completions', requestOptions);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const errorMsg = err.error?.message || `请求失败 (HTTP ${response.status})`;
    // Log error too
    if (conv) {
      if (!conv._rawLogs) conv._rawLogs = [];
      conv._rawLogs.push({
        requestTime,
        request: { url: baseUrl + '/chat/completions', model: apiCfg.model, messages: apiMessages, temperature: apiCfg.temperature, max_tokens: maxTokens, ...deepThinkParams },
        response: { error: errorMsg, httpStatus: response.status },
        responseTime: new Date().toISOString()
      });
    }
    throw new Error(errorMsg);
  }

  const responseTime = new Date().toISOString();
  const data = await response.json();
  if (typeof AIClient !== 'undefined') AIClient.recordUsage(apiCfg.model, data.usage);
  const choice = data.choices?.[0]?.message;
  const reply = choice?.content || '';
  const reasoning = (apiCfg.deepThink === true) ? (choice?.reasoning_content || '') : '';

  // Record raw API log
  if (conv) {
    if (!conv._rawLogs) conv._rawLogs = [];
    conv._rawLogs.push({
      requestTime,
      request: {
        url: baseUrl + '/chat/completions',
        model: apiCfg.model,
        messages: apiMessages.map(m => {
          const copy = { role: m.role };
          if (typeof m.content === 'string') {
            if (m.role === 'system' && m.content.length > 5000) {
              copy.content = m.content.slice(0, 5000) + '\n\n[...系统提示词过长，已截断，剩余 ' + (m.content.length - 5000) + ' 字符...]';
            } else {
              copy.content = m.content;
            }
          } else {
            copy.content = m.content;
          }
          if (m.name) copy.name = m.name;
          return copy;
        }),
        temperature: apiCfg.temperature,
        max_tokens: maxTokens
      },
      response: data,
      responseTime
    });
    // 只保留最近 5 条原始日志，防止 localStorage 无限膨胀
    if (conv._rawLogs.length > 5) conv._rawLogs = conv._rawLogs.slice(-5);
  }

  // Handle Kimi native $web_search tool calls
  const kimisearchToolCalls = (choice?.tool_calls || []).filter(tc => tc.function?.name === '$web_search');
  if (kimisearchToolCalls.length > 0 && conv) {
    // Push the assistant message (with tool_calls) to conversation
    appendMessage(conv, { role: 'assistant', content: reply || null, tool_calls: kimisearchToolCalls, _kimiSearch: true });

    // Build tool result messages
    const toolResults = kimisearchToolCalls.map(tc => ({
      role: 'tool',
      content: tc.function?.arguments || '{}',
      tool_call_id: tc.id
    }));

    // Append tool messages to apiMessages and send again
    const followUpMsgs = [
      { role: 'assistant', content: reply || null, tool_calls: kimisearchToolCalls },
      ...toolResults
    ];

    const followUpBody = {
      ...requestBody,
      messages: [...apiMessages, ...followUpMsgs],
      max_tokens: maxTokens
    };

    const followUpOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiCfg.apiKey
      },
      body: JSON.stringify(followUpBody)
    };
    const followUpResp = typeof AIClient !== 'undefined'
      ? await AIClient.fetchWithPolicy(baseUrl + '/chat/completions', followUpOptions, { scope: conv && conv.id, timeoutMs: apiCfg.timeoutMs })
      : await fetch(baseUrl + '/chat/completions', followUpOptions);

    if (followUpResp.ok) {
      const followUpData = await followUpResp.json();
      if (typeof AIClient !== 'undefined') AIClient.recordUsage(apiCfg.model, followUpData.usage);
      const followUpChoice = followUpData.choices?.[0]?.message;
      const finalReply = followUpChoice?.content || '';
      // Push tool messages and final reply to conversation
      toolResults.forEach(tr => appendMessage(conv, tr));
      appendMessage(conv, { role: 'assistant', content: finalReply, _kimiSearchResult: true });
      const { cleanText: ct, toolCalls: tcs } = extractToolCalls(finalReply);
      return { cleanText: ct || finalReply || '（搜索无结果）', toolCalls: tcs, reasoning, rawReply: finalReply, finishReason: data.choices?.[0]?.finish_reason || '' };
    } else {
      // Fallback: return partial result
      appendMessage(conv, { role: 'assistant', content: reply || '（搜索中断）', _kimiSearch: true });
    }
  }

  const { cleanText, toolCalls } = extractToolCalls(reply || '');
  return { cleanText: cleanText || reply || '（未收到回复）', toolCalls, reasoning, rawReply: reply, finishReason: data.choices?.[0]?.finish_reason || '' };
}

function buildStreamingRequestBody(apiMessages, apiCfg) {
  const maxTokens = apiCfg.maxTokens || (isKimiModel() ? 8192 : 2048);
  const modelLower = String(apiCfg.model || '').toLowerCase();
  const body = {
    model: apiCfg.model,
    messages: apiMessages,
    ...buildDeepThinkParams(apiCfg),
    stream: true
  };
  // Official OpenAI and DeepSeek Chat Completions endpoints support a final
  // usage chunk. Unknown compatible gateways may reject this optional field.
  if (/(?:api\.openai\.com|api\.deepseek\.com)/i.test(String(apiCfg.baseUrl || ''))) {
    body.stream_options = { include_usage: true };
  }
  if (modelLower.includes('k3') || modelLower.includes('k2.7')) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (!isKimiModel()) body.temperature = apiCfg.temperature;
  return { body, maxTokens };
}

function appendStreamingRawLog(conv, apiMessages, apiCfg, maxTokens, requestTime, response) {
  if (!conv) return;
  if (!conv._rawLogs) conv._rawLogs = [];
  conv._rawLogs.push({
    requestTime,
    request: {
      url: apiCfg.baseUrl.replace(/\/+$/, '') + '/chat/completions',
      model: apiCfg.model,
      messages: apiMessages.map(message => ({ role: message.role, content: message.content, ...(message.name ? { name: message.name } : {}) })),
      temperature: apiCfg.temperature,
      max_tokens: maxTokens,
      stream: true
    },
    response,
    responseTime: new Date().toISOString()
  });
  if (conv._rawLogs.length > 5) conv._rawLogs = conv._rawLogs.slice(-5);
}

function resultFromChatCompletionData(data, apiCfg, onDelta) {
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  const reply = typeof AIStream !== 'undefined' ? AIStream.readTextParts(message.content) : (message.content || '');
  const reasoning = apiCfg.deepThink === true
    ? (message.reasoning_content || message.reasoning || message.thinking || '')
    : '';
  if (typeof onDelta === 'function') onDelta({ content: reply, reasoning, contentDelta: reply, reasoningDelta: reasoning });
  const { cleanText, toolCalls } = extractToolCalls(reply);
  return {
    cleanText: cleanText || reply || '（未收到回复）',
    toolCalls,
    reasoning,
    rawReply: reply,
    finishReason: choice?.finish_reason || ''
  };
}

function isStreamingUnsupported(status, message) {
  return [400, 404, 415, 422].includes(status)
    && /(?:stream|streaming|server.sent|sse|流式).*(?:unsupported|not support|invalid|unknown|不支持|无效)|(?:unsupported|not support|invalid|unknown|不支持|无效).*(?:stream|streaming|sse|流式)/i.test(String(message || ''));
}

async function callAiApiStream(apiMessages, apiCfg, conv, options) {
  if (typeof AIStream === 'undefined') return callAiApiNonStream(apiMessages, apiCfg, conv, { skipSensitiveCheck: true });
  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  const { body, maxTokens } = buildStreamingRequestBody(apiMessages, apiCfg);
  const requestTime = new Date().toISOString();
  let response;
  let latest = { content: '', reasoning: '' };
  try {
    const requestOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiCfg.apiKey },
      body: JSON.stringify(body)
    };
    response = typeof AIClient !== 'undefined'
      ? await AIClient.fetchWithPolicy(baseUrl + '/chat/completions', requestOptions, {
          scope: conv && conv.id,
          timeoutMs: apiCfg.timeoutMs,
          keepAlive: true
        })
      : await fetch(baseUrl + '/chat/completions', requestOptions);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || `请求失败 (HTTP ${response.status})`;
      if (isStreamingUnsupported(response.status, errorMsg)) {
        return callAiApiNonStream(apiMessages, apiCfg, conv, { skipSensitiveCheck: true });
      }
      appendStreamingRawLog(conv, apiMessages, apiCfg, maxTokens, requestTime, { error: errorMsg, httpStatus: response.status, stream: true });
      throw new Error(errorMsg);
    }

    const contentType = String(response.headers?.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const data = await response.json();
      if (typeof AIClient !== 'undefined') AIClient.recordUsage(apiCfg.model, data.usage);
      const result = resultFromChatCompletionData(data, apiCfg, options.onDelta);
      appendStreamingRawLog(conv, apiMessages, apiCfg, maxTokens, requestTime, { stream: false, compatibilityResponse: data });
      return result;
    }

    const streamed = await AIStream.consumeChatCompletionStream(response, snapshot => {
      latest = apiCfg.deepThink === true ? snapshot : { ...snapshot, reasoning: '', reasoningDelta: '' };
      if (typeof options.onDelta === 'function') options.onDelta(latest);
    });
    if (typeof AIClient !== 'undefined') AIClient.recordUsage(apiCfg.model, streamed.usage);
    const reply = streamed.content || '';
    const reasoning = apiCfg.deepThink === true ? (streamed.reasoning || '') : '';
    const { cleanText, toolCalls } = extractToolCalls(reply);
    const result = {
      cleanText: cleanText || reply || '（未收到回复）',
      toolCalls,
      reasoning,
      rawReply: reply,
      finishReason: streamed.finishReason || ''
    };
    appendStreamingRawLog(conv, apiMessages, apiCfg, maxTokens, requestTime, {
      stream: true,
      content: reply,
      reasoning,
      tool_calls: streamed.toolCalls,
      finish_reason: streamed.finishReason,
      usage: streamed.usage
    });
    return result;
  } catch (error) {
    const abortReason = response?._aiRequestControl?.controller?.signal?.reason;
    if (abortReason?.name === 'TimeoutError') {
      error = new Error('AI 请求超时，请检查网络或调高超时时间');
    }
    if (latest.content || latest.reasoning) {
      const { cleanText, toolCalls } = extractToolCalls(latest.content || '');
      error.partialResult = {
        cleanText: cleanText || latest.content,
        toolCalls,
        reasoning: latest.reasoning || '',
        rawReply: latest.content || '',
        finishReason: ''
      };
    }
    if (abortReason?.name === 'AbortError' || error.message === 'AI 请求已取消' || (conv && isAiStopRequested(conv.id))) error.isAiAbort = true;
    throw error;
  } finally {
    if (response?._aiRequestControl) response._aiRequestControl.release();
  }
}

// Normal chat uses SSE by default. Structured/background callers stay non-streaming
// unless they explicitly provide an onDelta callback.
async function callAiApi(apiMessages, apiCfg, conv, options = {}) {
  if (typeof AIClient !== 'undefined') {
    const allowed = await AIClient.confirmSensitiveContent(apiMessages);
    if (!allowed) throw new Error('已取消发送敏感信息');
  }
  const activeConv = conv || (typeof getActiveConv === 'function' ? getActiveConv() : null);
  const kimiNativeSearch = isKimiModel() && activeConv && activeConv._webSearchMode === 'native';
  const streamEnabled = localStorage.getItem('study_ai_streaming') !== 'false';
  if (streamEnabled && !kimiNativeSearch && typeof options.onDelta === 'function') {
    return callAiApiStream(apiMessages, apiCfg, conv, options);
  }
  return callAiApiNonStream(apiMessages, apiCfg, conv, { skipSensitiveCheck: true });
}

// Build the apiMessages array from conversation history.
// 树状对话：conv.messages 已是活跃路径的扁平视图（由树引擎同步），
// 因此直接遍历即可，无需旧的 _candidates 展开 / skipUntilNextUser 逻辑。
function buildApiMessages(conv, extraSystemMsgs) {
  const systemPrompt = conv.systemPrompt
    ? buildToolsSystemPrompt() + '\n\n【用户自定义角色】' + conv.systemPrompt
    : buildToolsSystemPrompt();

  const msgs = [{ role: 'system', content: systemPrompt }];

  // Inject extra system messages (e.g. tool results) right after system prompt
  if (extraSystemMsgs && extraSystemMsgs.length > 0) {
    for (const sm of extraSystemMsgs) {
      msgs.push({ role: 'system', content: sm });
    }
  }

  // Use per-key context limit (default 20)
  const apiCfg = getEffectiveApiConfig();
  const contextLimit = apiCfg.contextLimit || 20;
  const recentMsgs = (conv.messages || []).slice(-contextLimit);

  for (let mi = 0; mi < recentMsgs.length; mi++) {
    const m = recentMsgs[mi];
    if (m.role === 'system') {
      msgs.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      // Build multimodal content if vision files are present
      let userContent;
      if (m.visionFiles && m.visionFiles.length > 0 && isMultimodalModel()) {
        userContent = [];
        // Add text part first
        if (m.content && m.content.trim()) {
          userContent.push({ type: 'text', text: m.content });
        }
        // Add vision file references
        for (const vf of m.visionFiles) {
          if (vf.type === 'video_url' && vf.fileId) {
            // Video: use ms:// protocol (uploaded to Kimi server)
            userContent.push({
              type: 'video_url',
              video_url: { url: 'ms://' + vf.fileId }
            });
          } else {
            // Image: use base64 data URL inline
            userContent.push({
              type: vf.type,
              [vf.type]: { url: vf.dataUrl }
            });
          }
        }
      } else {
        userContent = m.content;
      }
      const userApiMsg = { role: 'user', content: userContent };
      if (m.time) {
        // Prepend time info to text content (handle both string and array format)
        if (typeof userContent === 'string') {
          userApiMsg.content = `[当前时间：${m.time}]\n` + userContent;
        } else if (Array.isArray(userContent) && userContent.length > 0 && userContent[0].type === 'text') {
          userContent[0].text = `[当前时间：${m.time}]\n` + userContent[0].text;
        }
      }
      if (Array.isArray(userApiMsg.content)) {
        if (isDebugMode()) console.log('[DEBUG buildApiMessages] multimodal content:', JSON.stringify(userApiMsg.content, null, 2));
      }
      msgs.push(userApiMsg);
    } else if (m.role === 'assistant') {
      // NOTE: Do NOT include reasoning in API history. Including it can make the
      // API think the conversation is still in thinking mode, causing it to return
      // reasoning_content even when thinking is explicitly disabled.
      const assistantContent = typeof m.content === 'string' ? m.content : (m.content_text || '');
      const assistantMsg = { role: 'assistant', content: assistantContent };
      if (m.keyName) assistantMsg.name = m.keyName;
      msgs.push(assistantMsg);
    }
  }
  return msgs;
}

// ═══════════ Tool call loop: keep calling AI until no more tool_calls ═══════════
// Executes tools internally, injects results as system context, re-calls AI.
// Returns the final assistant message ready for display.
async function runToolCallLoop(apiCfg, conv, onIntermediate, onStreamDelta) {
  // Read max loops from user setting, minimum 5
  const userMax = parseInt(localStorage.getItem('study_max_tool_loops')) || 0;
  const MAX_LOOPS = Math.max(3, userMax); // safety limit to prevent infinite loops
  let finalCleanText = '';
  let finalRawReply = ''; // Keep original AI reply for memory parsing
  let finalReasoning = '';
  let allToolResults = [];
  let finalFinishReason = ''; // 最后一次 API 调用的 finish_reason（'length' 表示被 max_tokens 截断）
  let stopped = false;
  let streamError = '';

  // Track previous tool calls to detect repeated identical queries
  // Stores per-action signatures so we can detect when AI keeps calling
  // the same tool with the same params across multiple loop iterations
  let prevToolCallMap = {}; // { action+'|'+paramSig: count }
  let repeatCount = 0;

  let apiMessages = buildApiMessages(conv, null);

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    if (loop > 0) {
      // Rebuild messages with the latest conversation state (including tool results)
      apiMessages = buildApiMessages(conv, null);
    }

    // Check if user requested stop (per-conversation)
    const convId = getActiveConvId();
    if (isAiStopRequested(convId)) {
      finalCleanText = '⏹️ 已手动停止。';
      finalReasoning = '';
      finalFinishReason = '';
      stopped = true;
      break;
    }

    if (typeof onStreamDelta === 'function') onStreamDelta({ reset: true, loop });
    let apiResult;
    try {
      apiResult = await callAiApi(apiMessages, apiCfg, conv, {
        onDelta: typeof onStreamDelta === 'function'
          ? snapshot => onStreamDelta({ ...snapshot, loop })
          : undefined
      });
    } catch (error) {
      if (error.partialResult) {
        finalCleanText = error.partialResult.cleanText || '';
        finalRawReply = error.partialResult.rawReply || finalCleanText;
        finalReasoning = error.partialResult.reasoning || '';
        stopped = !!error.isAiAbort || isAiStopRequested(convId);
        streamError = stopped ? '' : error.message;
        break;
      }
      if (error.isAiAbort || isAiStopRequested(convId)) {
        finalCleanText = '⏹️ 已手动停止。';
        stopped = true;
        break;
      }
      throw error;
    }
    const { cleanText, toolCalls, reasoning, rawReply, finishReason } = apiResult;
    finalFinishReason = finishReason || '';

    // Check stop again after API call (in case it took a long time)
    if (isAiStopRequested(convId)) {
      finalCleanText = cleanText || '⏹️ 已手动停止。';
      finalRawReply = rawReply || finalCleanText;
      finalReasoning = reasoning || '';
      finalFinishReason = '';
      stopped = true;
      break;
    }

    if (toolCalls.length === 0) {
      // No more tool calls — this is the final reply
      finalCleanText = cleanText;
      finalRawReply = rawReply; // Keep original for memory parsing
      finalReasoning = reasoning || '';
      break;
    }

    // Tool tags are an internal protocol. Remove the transient draft before
    // showing the persisted tool-call/result messages for this round.
    if (typeof onStreamDelta === 'function') onStreamDelta({ reset: true, loop });

    // Track repeated identical tool calls (per-action, per-params)
    // Only count when the exact same action + params appears across consecutive loops
    let anyRepeated = false;
    const curToolCallMap = {};
    for (const tc of toolCalls) {
      const sig = tc.action + '|' + JSON.stringify(tc.params);
      curToolCallMap[sig] = (curToolCallMap[sig] || 0) + 1;
      // If this exact sig appeared in the previous loop, it's a repeat
      if (prevToolCallMap[sig]) {
        anyRepeated = true;
      }
    }
    prevToolCallMap = curToolCallMap;

    if (anyRepeated) {
      repeatCount++;
    } else {
      repeatCount = 0;
    }

    // Execute tools
    const toolResults = await Promise.all(toolCalls.map(tc => executeToolCall(tc.action, tc.params)));
    const resultsText = toolResults.join('\n');
    allToolResults.push(resultsText);

    // Store AI's original reply (with tool_call tags) as assistant message in conversation
    // Include the reasoning specific to this call, so each assistant message
    // has its own reasoning attached (not just the first one)
    const assistantMsg = { role: 'assistant', content: rawReply };
    if (reasoning) assistantMsg.reasoning = reasoning;
    appendMessage(conv, assistantMsg);

    // Store tool call results as system messages with metadata for UI rendering
    const toolNames = toolCalls.map(tc => tc.action).join('、');
    const toolLabel = toolCalls.length === 1 ? toolCalls[0].action : toolNames;
    // 压缩工具结果里的多余空行，避免 UI 中留大片空白
    const compactResults = String(resultsText || '').replace(/\n{3,}/g, '\n\n').trim();
    appendMessage(conv, {
      role: 'system',
      content: '【工具执行结果】\n' + compactResults,
      _toolInfo: { toolNames, toolLabel, results: toolResults }
    });
    // 持久化中间工具调用，刷新/重启后已完成的工具结果不丢失（配合 study_ai_pending 自动续传）
    if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();

    // Check safety limit (repeatCount was already incremented above)
    if (anyRepeated) {
      // Only break if the same tool call has repeated for more than half of MAX_LOOPS
      // This gives the AI enough chances to eventually produce a final reply
      if (repeatCount >= Math.ceil(MAX_LOOPS / 2)) {
        finalCleanText = cleanText || '✅ 已执行所有操作。';
        finalReasoning = reasoning || '';
        break;
      }
    }

    // Notify intermediate state: refresh UI after each tool execution round
    if (onIntermediate) {
      onIntermediate(resultsText);
    } else {
      // For normal chat (not automation): re-render messages immediately
      // so user sees each step as it happens (assistant msg → tool result → next msg)
      renderAiMessages();
    }

    // If cleanText is empty (pure tool call), continue loop
    // If cleanText has content AND tool calls exist, we still continue —
    // the AI might be doing "talk + act" pattern, so let it finish
  }

  // If we hit max loops without a final reply, use last cleanText or a fallback
  if (!finalCleanText && allToolResults.length > 0) {
    finalCleanText = '✅ 已执行所有操作。';
  }

  // Refresh views after all tool calls are done
  // 逐个 try 保护：任一视图 DOM 未就绪（如 builtin-links 扩展未加载）不拖垮整个 AI 流程
  if (allToolResults.length > 0) {
    try { renderTodos(); } catch (e) { console.warn('[AI] renderTodos 失败:', e); }
    try { renderLinks(); } catch (e) { console.warn('[AI] renderLinks 失败:', e); }
    try { renderNotes(); } catch (e) { console.warn('[AI] renderNotes 失败:', e); }
    try { renderToday(); } catch (e) { console.warn('[AI] renderToday 失败:', e); }
  }

  return {
    finalCleanText,
    finalRawReply,
    finalReasoning,
    allToolResults,
    finishReason: finalFinishReason,
    stopped,
    streamError
  };
}

// ═══════════ 截断回复续写 ═══════════
// 当 API 因 max_tokens 截断（finish_reason='length'）时，追加断点继续指令再调用一次，
// 把续写内容拼回原文，避免「戛然而止」。返回续写文本，失败返回 ''。
async function continueTruncatedReply(apiCfg, conv, partialText) {
  if (!partialText) return '';
  try {
    const msgs = buildApiMessages(conv, null);
    msgs.push({ role: 'assistant', content: partialText });
    msgs.push({ role: 'user', content: '（上一条回复因长度限制被截断）请从上次中断处无缝继续输出，不要重复已经写过的内容，直接从断点接着往下写。' });
    const { cleanText } = await callAiApi(msgs, apiCfg, conv);
    return cleanText || '';
  } catch (e) {
    console.warn('[AI] 续写截断回复失败:', e);
    return '';
  }
}
