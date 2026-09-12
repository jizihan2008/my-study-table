// ═══════════════════════════════════════════════
//  AI API 通信：API 调用、消息构建、工具调用循环
// ═══════════════════════════════════════════════

// ═══════════ Core AI call (extracted for tool-call loop reuse) ═══════════
// Returns { cleanText, toolCalls, reasoning } or throws on error
// If conv is provided, raw API request/response are appended to conv._rawLogs
async function readAiResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    const reason = response._aiRequestControl?.controller.signal.reason;
    if (reason?.name === 'TimeoutError') throw new Error('AI 请求超时，请检查网络或调高超时时间');
    if (reason?.name === 'AbortError') throw new Error('AI 请求已取消');
    throw error;
  } finally {
    response._aiRequestControl?.release();
  }
}

// Conservative estimate, not a provider tokenizer. Images reserve a fixed allowance.
function estimateAiTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  const nonAscii = (text.match(/[^\x00-\x7f]/g) || []).length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii);
}

function getAiContextBudget(apiCfg) {
  return Math.max(2048, Number(apiCfg.contextBudget) || 32768);
}

function getAiOutputReserve(apiCfg) {
  return Number(apiCfg.maxTokens) || (isKimiModel(apiCfg) ? 8192 : 2048);
}

function truncateAiTextToTokens(text, maxTokens) {
  if (estimateAiTokens(text) <= maxTokens) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateAiTokens(text.slice(0, mid)) <= maxTokens) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low).replace(/\s+$/, '');
}

function fitAiSystemPrompt(systemPrompt, apiCfg) {
  const budget = getAiContextBudget(apiCfg);
  const outputReserve = getAiOutputReserve(apiCfg);
  const maxSystemTokens = budget - outputReserve - 1536;
  if (maxSystemTokens < 1024) {
    throw new Error('模型的上下文预算小于回复预留，请调大上下文预算或调低 Max Tokens。');
  }
  if (estimateAiTokens(systemPrompt) <= maxSystemTokens) return systemPrompt;
  const marker = '═══ 当前数据快照（只读参考） ═══';
  const markerIndex = systemPrompt.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error('系统提示词超过上下文预算，请调大上下文预算或精简自定义角色提示词。');
  }
  const core = systemPrompt.slice(0, markerIndex);
  const notice = marker + '\n⚠️ 数据快照已按上下文预算精简；需要具体数据时请调用对应查询工具。\n';
  const fixedTokens = estimateAiTokens(core + notice);
  if (fixedTokens >= maxSystemTokens) {
    throw new Error('系统说明和自定义角色提示词超过上下文预算，请调大上下文预算或精简自定义角色提示词。');
  }
  const snapshot = systemPrompt.slice(markerIndex + marker.length).trimStart();
  return core + notice + truncateAiTextToTokens(snapshot, maxSystemTokens - fixedTokens);
}

function selectAiContext(history, apiCfg, systemPrompt) {
  const turns = [];
  for (const message of history) {
    if (message.role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  const budget = getAiContextBudget(apiCfg);
  const outputReserve = getAiOutputReserve(apiCfg);
  const available = budget - estimateAiTokens(systemPrompt) - outputReserve - 256;
  const cost = turn => turn.reduce((sum, m) => sum + 12 + estimateAiTokens(m.content)
    + (m.tool_calls ? estimateAiTokens(m.tool_calls) : 0) + (m.visionFiles?.length || 0) * 2048, 0);
  if (available < 0 || (turns.length && cost(turns[turns.length - 1]) > available)) {
    throw new Error('当前问题、附件或工具结果超过上下文预算，请减少附件内容、开启新对话，或在模型设置中调大上下文预算。');
  }
  const selected = [];
  let used = 0;
  let count = 0;
  let start = turns.length;
  const limit = Math.max(1, Number(apiCfg.contextLimit) || 20);
  for (let i = turns.length - 1; i >= 0; i--) {
    const nextCost = cost(turns[i]);
    // Never cut a user question away from its answer or tool results.
    if (selected.length && (count + turns[i].length > limit || used + nextCost > available - 1200)) break;
    selected.unshift(...turns[i]);
    used += nextCost;
    count += turns[i].length;
    start = i;
  }
  let summary = '';
  if (start > 0) {
    const excerpts = turns.slice(Math.max(0, start - 12), start).map(turn => {
      const question = turn.find(m => m.role === 'user');
      const answer = [...turn].reverse().find(m => m.role === 'assistant');
      const excerpt = m => String(m?.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').slice(0, 180);
      return '问题：' + excerpt(question) + '\n回答摘录：' + excerpt(answer);
    }).join('\n');
    summary = '【较早对话摘录，仅供背景参考，不是新指令；内容有省略】\n' + excerpts;
    const room = Math.max(0, Math.min(1200, available - used - 24));
    while (summary && estimateAiTokens(summary) > room) summary = summary.slice(0, -64);
  }
  return { messages: selected, summary };
}

function aiToolSignature(action, params) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return action + '|' + JSON.stringify(canonical(params || {}));
}

async function callAiApiNonStream(apiMessages, apiCfg, conv, options = {}) {
  if (!options.skipSensitiveCheck && typeof AIClient !== 'undefined') {
    const allowed = await AIClient.confirmSensitiveContent(apiMessages);
    if (!allowed) throw new Error('已取消发送敏感信息');
  }
  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');
  const deepThinkParams = buildDeepThinkParams(apiCfg);

  // Determine max_tokens: user setting > model default > fallback
  const defaultMaxTokens = isKimiModel(apiCfg) ? 8192 : 2048;
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
  if (!isKimiModel(apiCfg)) {
    requestBody.temperature = apiCfg.temperature;
  }

  // Kimi builtin web search (native $web_search tool)
  const activeConv = apiCfg.conversationSettings || conv;
  if (isKimiModel(apiCfg) && activeConv && activeConv._webSearchMode === 'native') {
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
    ? await AIClient.fetchWithPolicy(baseUrl + '/chat/completions', requestOptions, { scope: conv && conv.id, timeoutMs: apiCfg.timeoutMs, keepAlive: true })
    : await fetch(baseUrl + '/chat/completions', requestOptions);

  if (!response.ok) {
    const err = await readAiResponseJson(response).catch(() => ({}));
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
  const data = await readAiResponseJson(response);
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
            copy.content = redactInlineImages(m.content);
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
    toolResults.forEach(tr => appendMessage(conv, tr));

    // Append tool messages to apiMessages and send again
    const followUpMsgs = [
      { role: 'assistant', content: reply || null, tool_calls: kimisearchToolCalls },
      ...toolResults
    ];

    const followUpBody = {
      ...requestBody,
      messages: [...apiMessages, ...followUpMsgs]
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
      ? await AIClient.fetchWithPolicy(baseUrl + '/chat/completions', followUpOptions, { scope: conv && conv.id, timeoutMs: apiCfg.timeoutMs, keepAlive: true })
      : await fetch(baseUrl + '/chat/completions', followUpOptions);

    if (followUpResp.ok) {
      const followUpData = await readAiResponseJson(followUpResp);
      if (typeof AIClient !== 'undefined') AIClient.recordUsage(apiCfg.model, followUpData.usage);
      const followUpChoice = followUpData.choices?.[0]?.message;
      const finalReply = followUpChoice?.content || '';
      const { cleanText: ct, toolCalls: tcs } = extractToolCalls(finalReply);
      return { cleanText: ct || finalReply || '（搜索无结果）', toolCalls: tcs, reasoning, rawReply: finalReply, finishReason: followUpData.choices?.[0]?.finish_reason || '' };
    } else {
      const error = await readAiResponseJson(followUpResp).catch(() => ({}));
      throw new Error(error.error?.message || `原生搜索后续请求失败 (HTTP ${followUpResp.status})`);
    }
  }

  const { cleanText, toolCalls } = extractToolCalls(reply || '');
  return { cleanText: cleanText || reply || '（未收到回复）', toolCalls, reasoning, rawReply: reply, finishReason: data.choices?.[0]?.finish_reason || '' };
}

function buildStreamingRequestBody(apiMessages, apiCfg) {
  const maxTokens = apiCfg.maxTokens || (isKimiModel(apiCfg) ? 8192 : 2048);
  const modelLower = String(apiCfg.model || '').toLowerCase();
  const body = {
    model: apiCfg.model,
    messages: apiMessages,
    ...buildDeepThinkParams(apiCfg),
    stream: true
  };
  // Official OpenAI and DeepSeek Chat Completions endpoints support a final
  // usage chunk. Unknown compatible gateways may reject this optional field.
  // 用主机名判断，避免 baseUrl 带路径/端口时误判（getApiHostname 定义在 js/ai-attach.js）
  const host = (typeof getApiHostname === 'function') ? getApiHostname(apiCfg.baseUrl) : '';
  if (host === 'api.openai.com' || host === 'api.deepseek.com') {
    body.stream_options = { include_usage: true };
  }
  if (modelLower.includes('k3') || modelLower.includes('k2.7')) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (!isKimiModel(apiCfg)) body.temperature = apiCfg.temperature;
  return { body, maxTokens };
}

// 原始日志里的图片体积很大（一张图 base64 常 1MB+），而 _rawLogs 会写进本地存储，
// 直接记录会迅速吃满配额。这里把内联图片替换为占位说明，只保留「有没有图、多大」。
function redactInlineImages(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  return content.map(part => {
    if (!part || typeof part !== 'object') return part;
    const url = part.image_url && part.image_url.url;
    if (part.type === 'image_url' && typeof url === 'string' && url.startsWith('data:')) {
      const mime = url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : url.indexOf(','));
      return Object.assign({}, part, {
        image_url: Object.assign({}, part.image_url, { url: `<内联图片 ${mime || 'image'}，约 ${Math.round(url.length / 1365)}KB>` })
      });
    }
    // Files API 的 file_data 同样是 base64，同样需要脱敏
    if (part.type === 'file' && typeof part.file_data === 'string' && part.file_data.startsWith('data:')) {
      return Object.assign({}, part, { file_data: `<内联图片数据，约 ${Math.round(part.file_data.length / 1365)}KB>` });
    }
    return part;
  });
}

function appendStreamingRawLog(conv, apiMessages, apiCfg, maxTokens, requestTime, response) {
  if (!conv) return;
  if (!conv._rawLogs) conv._rawLogs = [];
  conv._rawLogs.push({
    requestTime,
    request: {
      url: apiCfg.baseUrl.replace(/\/+$/, '') + '/chat/completions',
      model: apiCfg.model,
      messages: apiMessages.map(message => ({ role: message.role, content: redactInlineImages(message.content), ...(message.name ? { name: message.name } : {}) })),
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
      const errorData = await readAiResponseJson(response).catch(() => ({}));
      const errorMsg = errorData.error?.message || `请求失败 (HTTP ${response.status})`;
      if (isStreamingUnsupported(response.status, errorMsg)) {
        return callAiApiNonStream(apiMessages, apiCfg, conv, { skipSensitiveCheck: true });
      }
      appendStreamingRawLog(conv, apiMessages, apiCfg, maxTokens, requestTime, { error: errorMsg, httpStatus: response.status, stream: true });
      throw new Error(errorMsg);
    }

    const contentType = String(response.headers?.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      const data = await readAiResponseJson(response);
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
  const activeConv = apiCfg.conversationSettings || conv;
  const kimiNativeSearch = isKimiModel(apiCfg) && activeConv && activeConv._webSearchMode === 'native';
  const streamEnabled = localStorage.getItem('study_ai_streaming') !== 'false';
  if (streamEnabled && !kimiNativeSearch && typeof options.onDelta === 'function') {
    return callAiApiStream(apiMessages, apiCfg, conv, options);
  }
  return callAiApiNonStream(apiMessages, apiCfg, conv, { skipSensitiveCheck: true });
}

// Build the apiMessages array from conversation history.
// 树状对话：conv.messages 已是活跃路径的扁平视图（由树引擎同步），
// 因此直接遍历即可，无需旧的 _candidates 展开 / skipUntilNextUser 逻辑。
function buildApiMessages(conv, extraSystemMsgs, apiCfg = getEffectiveApiConfig()) {
  const rawSystemPrompt = conv.systemPrompt
    ? buildToolsSystemPrompt(apiCfg.conversationSettings || conv, apiCfg) + '\n\n【用户自定义角色】' + conv.systemPrompt
    : buildToolsSystemPrompt(apiCfg.conversationSettings || conv, apiCfg);
  const systemPrompt = fitAiSystemPrompt(rawSystemPrompt, apiCfg);

  const msgs = [{ role: 'system', content: systemPrompt }];

  // Inject extra system messages (e.g. tool results) right after system prompt
  if (extraSystemMsgs && extraSystemMsgs.length > 0) {
    for (const sm of extraSystemMsgs) {
      msgs.push({ role: 'system', content: sm });
    }
  }

  // Use per-key context limit (default 20)
  const selection = selectAiContext(conv.messages || [], apiCfg, systemPrompt + (extraSystemMsgs || []).join('\n'));
  const recentMsgs = selection.messages;
  if (selection.summary) msgs.push({ role: 'user', content: selection.summary });

  for (let mi = 0; mi < recentMsgs.length; mi++) {
    const m = recentMsgs[mi];
    if (m.role === 'system') {
      msgs.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      // Build multimodal content if vision files are present
      let userContent;
      if (m.visionFiles && m.visionFiles.length > 0 && isMultimodalModel(apiCfg)) {
        userContent = [];
        // Add text part first
        if (m.content && m.content.trim()) {
          userContent.push({ type: 'text', text: m.content });
        }
        // Add vision file references
        for (const vf of m.visionFiles) {
          if (vf.type === 'file' && vf.fileId) {
            // Files API：用 file_id 引用（同一张图后续轮次不再重复上传）。
            // 紧跟一个极小的 file_data 缩略图，让模型在后续轮次仍"看得到"这张图；
            // file 与 file_data 互斥，故拆成两个内容块。
            userContent.push({ type: 'file', file_id: vf.fileId });
            if (typeof vf.dataUrl === 'string' && vf.dataUrl.startsWith('data:image/')) {
              userContent.push({ type: 'file', file_data: vf.dataUrl, filename: vf.name || 'image.png' });
            }
          } else if (vf.type === 'video_url' && vf.fileId) {
            // Video: use ms:// protocol (uploaded to Kimi server)
            userContent.push({
              type: 'video_url',
              video_url: { url: 'ms://' + vf.fileId }
            });
          } else if (vf.dataUrl) {
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
    } else if (m.role === 'tool' && m.tool_call_id) {
      msgs.push({ role: 'tool', content: m.content, tool_call_id: m.tool_call_id });
    } else if (m.role === 'assistant') {
      // NOTE: Do NOT include reasoning in API history. Including it can make the
      // API think the conversation is still in thinking mode, causing it to return
      // reasoning_content even when thinking is explicitly disabled.
      const assistantContent = typeof m.content === 'string' ? m.content : (m.content_text || '');
      const assistantMsg = { role: 'assistant', content: assistantContent };
      if (m.tool_calls) assistantMsg.tool_calls = m.tool_calls;
      msgs.push(assistantMsg);
    }
  }
  return msgs;
}

// ═══════════ Tool call loop: keep calling AI until no more tool_calls ═══════════
// Executes tools internally, injects results as system context, re-calls AI.
// Returns the final assistant message ready for display.
async function runToolCallLoop(apiCfg, conv, onIntermediate, onStreamDelta) {
  const settings = apiCfg.conversationSettings || conv;
  apiCfg = { ...apiCfg, conversationSettings: { id: conv.id, _webSearchMode: settings._webSearchMode, _webSearchEnabled: settings._webSearchEnabled } };
  // Bound both the minimum and maximum number of tool rounds.
  const userMax = parseInt(localStorage.getItem('study_max_tool_loops')) || 0;
  const MAX_LOOPS = Math.min(50, Math.max(3, userMax));
  let finalCleanText = '';
  let finalRawReply = ''; // Keep original AI reply for memory parsing
  let finalReasoning = '';
  let allToolResults = [];
  let finalFinishReason = ''; // 最后一次 API 调用的 finish_reason（'length' 表示被 max_tokens 截断）
  let stopped = false;
  let streamError = '';
  const executedWrites = new Map();
  const outcomes = [];
  let incompleteReason = '';

  // Track previous tool calls to detect repeated identical queries
  // Stores per-action signatures so we can detect when AI keeps calling
  // the same tool with the same params across multiple loop iterations
  let prevToolCallMap = {}; // { action+'|'+paramSig: count }
  let repeatCount = 0;

  let apiMessages = buildApiMessages(conv, null, apiCfg);

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    if (loop > 0) {
      // Rebuild messages with the latest conversation state (including tool results)
      apiMessages = buildApiMessages(conv, null, apiCfg);
    }

    // Check if user requested stop (per-conversation)
    const convId = conv.id;
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
      const sig = aiToolSignature(tc.action, tc.params);
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

    // Execute in order: later writes may depend on earlier results. Cache writes
    // before any repeat can run, including failures whose effects may be partial.
    const toolResults = [];
    const roundOutcomes = [];
    for (const [index, tc] of toolCalls.entries()) {
      const sig = aiToolSignature(tc.action, tc.params);
      const readOnly = /^(?:get_|list_|search_)/.test(tc.action) || ['web_search', 'read_webpage', 'quest_get', 'quest_review'].includes(tc.action);
      let result;
      let status;
      if (isAiStopRequested(conv.id) || index >= 32) {
        stopped = isAiStopRequested(conv.id);
        result = '⏹️ 未执行：' + tc.action + (stopped ? '（已停止）' : '（单轮工具数量达到上限）');
        status = 'skipped';
      } else if (!readOnly && executedWrites.has(sig)) {
        result = '已拦截重复操作，沿用本次请求的执行结果：' + executedWrites.get(sig);
        status = 'duplicate';
      } else {
        try {
          result = String(await executeToolCall(tc.action, tc.params || {}, { conv, apiCfg }));
          status = /^(?:❌|错误|⚠️)/.test(result.trim()) ? 'failed' : 'success';
        } catch (error) {
          result = '❌ ' + tc.action + ' 执行失败：' + error.message;
          status = 'failed';
        }
        if (!readOnly) executedWrites.set(sig, result);
      }
      toolResults.push(result);
      roundOutcomes.push({ action: tc.action, status });
    }
    outcomes.push(...roundOutcomes);
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
      _toolInfo: { toolNames, toolLabel, results: toolResults, outcomes: roundOutcomes }
    });
    // 持久化中间工具调用，刷新/重启后已完成的工具结果不丢失（配合 study_ai_pending 自动续传）
    if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();
    if (stopped || roundOutcomes.some(item => item.status === 'skipped')) {
      incompleteReason = stopped ? '已停止，部分操作未执行。' : '单轮工具数量达到上限，部分操作未执行。';
      break;
    }

    // Check safety limit (repeatCount was already incremented above)
    if (anyRepeated) {
      // Only break if the same tool call has repeated for more than half of MAX_LOOPS
      // This gives the AI enough chances to eventually produce a final reply
      if (repeatCount >= Math.ceil(MAX_LOOPS / 2)) {
        incompleteReason = '检测到重复工具调用，已结束本次生成；任务尚未确认完成。';
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
    incompleteReason = incompleteReason || '已达到工具调用轮次上限，任务尚未确认完成。';
    finalCleanText = '⚠️ ' + incompleteReason;
  }
  const failedCount = outcomes.filter(item => item.status === 'failed').length;
  const successCount = outcomes.filter(item => item.status === 'success').length;
  const skippedCount = outcomes.filter(item => item.status === 'skipped').length;
  if (failedCount || incompleteReason) finalCleanText += `\n\n执行记录：成功 ${successCount} 项，失败 ${failedCount} 项，未执行 ${skippedCount} 项。详情见工具结果。`;

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
    streamError,
    outcomes,
    incompleteReason
  };
}

// ═══════════ 截断回复续写 ═══════════
// 当 API 因 max_tokens 截断（finish_reason='length'）时，追加断点继续指令再调用一次，
// 把续写内容拼回原文，避免「戛然而止」。返回续写文本，失败返回 ''。
async function continueTruncatedReply(apiCfg, conv, partialText) {
  if (!partialText) return '';
  try {
    const msgs = buildApiMessages(conv, null, apiCfg);
    msgs.push({ role: 'assistant', content: partialText });
    msgs.push({ role: 'user', content: '（上一条回复因长度限制被截断）请从上次中断处无缝继续输出，不要重复已经写过的内容，直接从断点接着往下写。' });
    const { cleanText } = await callAiApi(msgs, apiCfg, conv);
    return cleanText || '';
  } catch (e) {
    console.warn('[AI] 续写截断回复失败:', e);
    return '';
  }
}
