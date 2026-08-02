// ═══════════ AI Long-Term Memory System ═══════════
// Multi-AI collaboration: Conversation AI extracts memory points in real-time,
// Memory AI integrates summaries & user profiles daily.
// Confidence system manages memory lifecycle algorithmically.

const MEMORY_KEY = 'study_ai_memory';
const MAX_AUTO_FACTS = 50;
const MAX_CONV_SUMMARIES = 20;
const MAX_MANUAL_NOTES = 50;
const DAILY_DECAY = 0.02;
const LOW_CONFIDENCE_THRESHOLD = 0.3;
const INITIAL_CONFIDENCE = 0.6;
const REPEAT_BOOST = 0.3;
const SIMILAR_BOOST = 0.15;
const CONTRADICTION_PENALTY = 0.3;

// ── Category definitions ──
const MEMORY_CATEGORIES = {
  fact: { label: '事实', icon: '📌', color: '#3B82F6' },
  preference: { label: '偏好与习惯', icon: '💚', color: '#10B981' },
  goal: { label: '目标', icon: '🎯', color: '#F59E0B' },
  ability: { label: '能力', icon: '🧠', color: '#8B5CF6' },
  behavior: { label: '行为模式', icon: '📊', color: '#06B6D4' },
  mental: { label: '心理模式', icon: '💭', color: '#EC4899' }
};

// ── Negation / polarity word lists for contradiction detection ──
const NEGATION_WORDS = ['不', '没', '不再', '放弃', '停止', '改成', '换成', '取消', '并非', '不是', '错了', '不对', '否认', '收回', '撤销'];
const POSITIVE_WORDS = ['喜欢', '擅长', '掌握', '习惯', '完成', '通过', '进步', '熟悉', '强', '好', '快', '顺利', '轻松', '成功', '满意'];
const NEGATIVE_WORDS = ['不熟', '困难', '不会', '放弃', '拖延', '弱', '差', '慢', '瓶颈', '卡住', '糟糕', '失败', '讨厌', '厌倦', '痛苦'];

// ═══════════ Data Layer ═══════════

function getDefaultMemory() {
  return {
    profileText: '',       // 用户画像：AI 每日生成的全方位总结文字
    manualNotes: [],      // { id, content, detail, createdAt, updatedAt }
    autoFacts: [],         // { id, type, text, detail, confidence, sourceConvId, sourceConvTitle, createdAt, updatedAt }
    convSummaries: [],     // { convId, convTitle, summary, messageCount, extractedAt }
    dailySummary: '',     // Most recent daily integrated summary
    dailySummaryDate: null,
    lastDailyIntegration: null
  };
}

function loadAiMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return getDefaultMemory();
    const parsed = JSON.parse(raw);
    // Merge with defaults to handle schema changes
    const defaults = getDefaultMemory();
    for (const key of Object.keys(defaults)) {
      if (!(key in parsed)) parsed[key] = defaults[key];
    }
    // Ensure arrays
    if (!Array.isArray(parsed.manualNotes)) parsed.manualNotes = [];
    if (!Array.isArray(parsed.autoFacts)) parsed.autoFacts = [];
    if (!Array.isArray(parsed.convSummaries)) parsed.convSummaries = [];
    // Migration: old structured profile -> free text
    if (parsed.profile && typeof parsed.profile === 'object' && !parsed.profileText) {
      const p = parsed.profile;
      const parts = [];
      if (p.nickname) parts.push(`称呼：${p.nickname}`);
      if (p.identity) parts.push(`身份背景：${p.identity}`);
      if (p.goals) parts.push(`学习目标：${p.goals}`);
      if (p.style === 'concise') parts.push('偏好：回复简洁');
      else if (p.style === 'detailed') parts.push('偏好：回复详细');
      parsed.profileText = parts.join('；') || '';
      delete parsed.profile;
    }
    if (typeof parsed.profileText !== 'string') parsed.profileText = '';
    // Migration: autoFacts without detail field
    for (const e of parsed.autoFacts) {
      if (!e.detail) e.detail = '';
    }
    // Migration: manualNotes without detail field
    for (const n of parsed.manualNotes) {
      if (!n.detail) n.detail = '';
    }
    return parsed;
  } catch {
    return getDefaultMemory();
  }
}

function saveAiMemory(memory) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch (e) {
    console.warn('[Memory] Failed to save:', e);
  }
}

// ═══════════ Text Analysis (no AI needed) ═══════════

// Simple Chinese word segmentation: extract meaningful tokens (2-char bigrams + key chars)
function tokenize(text) {
  text = text.toLowerCase().trim();
  // Remove punctuation, keep Chinese chars + alphanumeric
  const cleaned = text.replace(/[，。！？、；：""''（）【】《》\s\-\.\,\!\?\:\;\(\)\[\]\{\}\"\'\/\\@#\$%\^&\*\+\=]+/g, ' ');
  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  // For Chinese text, also extract bigrams
  const tokens = new Set();
  for (const w of words) {
    tokens.add(w);
    if (/[\u4e00-\u9fff]/.test(w)) {
      // Chinese: extract bigrams
      for (let i = 0; i < w.length - 1; i++) {
        tokens.add(w.slice(i, i + 2));
      }
    }
  }
  return [...tokens];
}

// Jaccard similarity
function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) { if (setB.has(t)) intersection++; }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Detect if text contains negation/contradiction markers
function hasNegationMarkers(text) {
  return NEGATION_WORDS.some(w => text.includes(w));
}

// Detect sentiment polarity (simple)
function getPolarityScore(text) {
  let score = 0;
  for (const w of POSITIVE_WORDS) { if (text.includes(w)) score++; }
  for (const w of NEGATIVE_WORDS) { if (text.includes(w)) score--; }
  return score;
}

// Check if two entries are semantically contradictory
function detectContradiction(existingText, newText) {
  // Method A: Negation markers
  const newHasNegation = hasNegationMarkers(newText);
  const oldHasNegation = hasNegationMarkers(existingText);
  if (newHasNegation !== oldHasNegation) return true;

  // Method B: Polarity direction
  const oldPolarity = getPolarityScore(existingText);
  const newPolarity = getPolarityScore(newText);
  // Big polarity shift in opposite directions suggests contradiction
  if (Math.abs(oldPolarity - newPolarity) > 2) {
    return (oldPolarity > 0 && newPolarity < 0) || (oldPolarity < 0 && newPolarity > 0);
  }

  return false;
}

// ═══════════ Confidence Algorithm ═══════════

// Insert or update an auto fact with confidence management
// text = 简略信息（语音级别，prompt/list_memories 看到）
// detail = 详细内容（get_memory_detail 看到）
function upsertAutoFact(memory, type, text, sourceConvId, sourceConvTitle, detail) {
  if (!type || !text || !MEMORY_CATEGORIES[type]) return null;

  const existingEntries = memory.autoFacts;
  const newTokens = tokenize(text);

  // Stage 1: Exact match check
  const exactMatch = existingEntries.find(e =>
    e.type === type && e.text.trim() === text.trim()
  );
  if (exactMatch) {
    exactMatch.confidence = Math.min(1.0, exactMatch.confidence + REPEAT_BOOST);
    exactMatch.updatedAt = Date.now();
    if (detail && detail.trim()) exactMatch.detail = detail.trim();
    if (!exactMatch.sourceConvIds) exactMatch.sourceConvIds = [exactMatch.sourceConvId];
    if (!exactMatch.sourceConvIds.includes(sourceConvId)) exactMatch.sourceConvIds.push(sourceConvId);
    return exactMatch;
  }

  // Stage 2: Jaccard similarity check (compare titles only)
  let bestMatch = null;
  let bestScore = 0;
  for (const e of existingEntries) {
    if (e.type !== type) continue;
    const eTokens = tokenize(e.text);
    const sim = jaccardSimilarity(newTokens, eTokens);
    if (sim > 0.5 && sim > bestScore) {
      bestScore = sim;
      bestMatch = e;
    }
  }

  if (bestMatch) {
    // Stage 3: Semantic direction check
    if (detectContradiction(bestMatch.text, text)) {
      // Contradiction: penalize both
      bestMatch.confidence = Math.max(LOW_CONFIDENCE_THRESHOLD - 0.05, bestMatch.confidence - CONTRADICTION_PENALTY);
      bestMatch.updatedAt = Date.now();
      // Also add new entry with low confidence as a potential replacement
      const newEntry = {
        id: genId(),
        type, text, detail: (detail && detail.trim()) || '',
        confidence: Math.max(0.1, INITIAL_CONFIDENCE - CONTRADICTION_PENALTY),
        sourceConvId, sourceConvTitle, sourceConvIds: [sourceConvId],
        createdAt: Date.now(), updatedAt: Date.now()
      };
      existingEntries.push(newEntry);
      return newEntry;
    } else {
      // Consistent: merge - update existing with higher confidence
      bestMatch.confidence = Math.min(1.0, Math.max(bestMatch.confidence, INITIAL_CONFIDENCE) + SIMILAR_BOOST);
      // Update text to the newer version if it adds info
      if (text.length > bestMatch.text.length) bestMatch.text = text;
      if (detail && detail.trim()) bestMatch.detail = detail.trim();
      bestMatch.updatedAt = Date.now();
      if (!bestMatch.sourceConvIds) bestMatch.sourceConvIds = [bestMatch.sourceConvId];
      if (!bestMatch.sourceConvIds.includes(sourceConvId)) bestMatch.sourceConvIds.push(sourceConvId);
      return bestMatch;
    }
  }

  // No match: create new entry
  const newEntry = {
    id: genId(),
    type, text, detail: (detail && detail.trim()) || '',
    confidence: INITIAL_CONFIDENCE,
    sourceConvId, sourceConvTitle, sourceConvIds: [sourceConvId],
    createdAt: Date.now(), updatedAt: Date.now()
  };
  existingEntries.push(newEntry);
  return newEntry;
}

// Apply daily decay to all auto facts
function applyDailyDecay(memory) {
  const now = Date.now();
  for (const entry of memory.autoFacts) {
    // Only decay if last decay was more than 12 hours ago
    if (!entry._lastDecay) entry._lastDecay = now;
    const hoursSinceLastDecay = (now - entry._lastDecay) / (1000 * 60 * 60);
    if (hoursSinceLastDecay > 12) {
      entry.confidence = Math.max(0, entry.confidence - DAILY_DECAY);
      entry._lastDecay = now;
    }
  }
  return memory;
}

// Cleanup low-confidence entries
function cleanupLowConfidence(memory) {
  const before = memory.autoFacts.length;
  memory.autoFacts = memory.autoFacts.filter(e => e.confidence >= LOW_CONFIDENCE_THRESHOLD);
  // Also enforce max count
  if (memory.autoFacts.length > MAX_AUTO_FACTS) {
    memory.autoFacts.sort((a, b) => b.confidence - a.confidence);
    memory.autoFacts = memory.autoFacts.slice(0, MAX_AUTO_FACTS);
  }
  return before - memory.autoFacts.length;
}

// ═══════════ Manual Notes Management ═══════════

function addManualNote(memory, content, detail) {
  if (!content || !content.trim()) return -1;
  const note = {
    id: genId(),
    content: content.trim(),
    detail: (detail && detail.trim()) || '',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  memory.manualNotes.push(note);
  if (memory.manualNotes.length > MAX_MANUAL_NOTES) {
    memory.manualNotes = memory.manualNotes.slice(-MAX_MANUAL_NOTES);
  }
  return note.id;
}

function updateManualNote(memory, id, content, detail) {
  const note = memory.manualNotes.find(n => n.id === id);
  if (!note) return false;
  if (content && content.trim()) note.content = content.trim();
  if (detail !== undefined) note.detail = detail.trim();
  note.updatedAt = Date.now();
  return true;
}

function deleteManualNote(memory, id) {
  const idx = memory.manualNotes.findIndex(n => n.id === id);
  if (idx === -1) return false;
  memory.manualNotes.splice(idx, 1);
  return true;
}

// ═══════════ Conversation Summaries ═══════════

function addConvSummary(memory, convId, convTitle, summary, messageCount) {
  // Remove existing summary for this conv if any
  memory.convSummaries = memory.convSummaries.filter(s => s.convId !== convId);
  memory.convSummaries.push({
    convId, convTitle, summary, messageCount, extractedAt: Date.now()
  });
  // Enforce max
  if (memory.convSummaries.length > MAX_CONV_SUMMARIES) {
    memory.convSummaries.sort((a, b) => b.extractedAt - a.extractedAt);
    memory.convSummaries = memory.convSummaries.slice(0, MAX_CONV_SUMMARIES);
  }
}

function deleteConvSummary(memory, convId) {
  memory.convSummaries = memory.convSummaries.filter(s => s.convId !== convId);
}

function updateAutoFact(memory, id, type, text, detail) {
  const entry = memory.autoFacts.find(e => e.id === id);
  if (!entry) return false;
  if (type && MEMORY_CATEGORIES[type]) entry.type = type;
  if (text && text.trim()) entry.text = text.trim();
  if (detail !== undefined) entry.detail = detail.trim();
  entry.updatedAt = Date.now();
  return true;
}

function updateConvSummary(memory, convId, summary) {
  const s = memory.convSummaries.find(s => s.convId === convId);
  if (!s) return false;
  if (summary && summary.trim()) s.summary = summary.trim();
  s.extractedAt = Date.now();
  return true;
}

// ═══════════ Prompt Formatting ═══════════

function formatMemoryForPrompt() {
  const memory = loadAiMemory();
  // Apply decay first
  applyDailyDecay(memory);
  // Cleanup
  const cleaned = cleanupLowConfidence(memory);
  if (cleaned > 0) saveAiMemory(memory);

  let section = '\n\n═══ 长期记忆 ═══\n';

  // ── User Profile (free-text, AI-generated summary) ──
  if (memory.profileText && memory.profileText.trim()) {
    section += '\n【用户画像】\n';
    section += memory.profileText.trim() + '\n';
  }

  // ── Manual Notes (show title only) ──
  if (memory.manualNotes.length > 0) {
    section += '\n【用户设置的事实】（用户手动添加）\n';
    for (const note of memory.manualNotes) {
      section += `• ${note.content}\n`;
    }
  }

  // ── Auto Facts (by category, top entries per category) ──
  if (memory.autoFacts.length > 0) {
    section += '\n【AI 从过往对话中了解到的】\n';
    // Group by type
    const byType = {};
    for (const e of memory.autoFacts) {
      if (!byType[e.type]) byType[e.type] = [];
      byType[e.type].push(e);
    }
    for (const [type, entries] of Object.entries(byType)) {
      // Sort by confidence desc
      entries.sort((a, b) => b.confidence - a.confidence);
      // Rule: max(top 5, above threshold entries)
      const top5 = entries.slice(0, 5);
      const aboveThreshold = entries.filter(e => e.confidence >= 0.5);
      const displayEntries = aboveThreshold.length >= top5.length ? aboveThreshold : top5;

      const cat = MEMORY_CATEGORIES[type];
      if (!displayEntries.length) continue;
      section += `  ${cat.icon} ${cat.label}：\n`;
      for (const e of displayEntries) {
        const pct = Math.round(e.confidence * 100);
        const sourceLabel = e.sourceConvTitle ? ` ↑${e.sourceConvTitle}` : '';
        section += `    • ${e.text} (置信度 ${pct}%)${sourceLabel}\n`;
      }
    }
  }

  // ── Daily Summary ──
  if (memory.dailySummary && memory.dailySummaryDate) {
    section += `\n【近期对话总摘要】（${memory.dailySummaryDate}）\n${memory.dailySummary}\n`;
  }

  // ── Tool guidance for memory extraction ──
  section += `\n【记忆提取指引】\n`;
  section += `你可以通过以下工具来管理长期记忆：\n`;
  section += `- list_memories：列出记忆条目（显示简略信息）\n`;
  section += `- get_memory_detail：查看特定记忆条目的详细内容\n`;
  section += `你也可以通过 <memory> 标签在回复中提交值得记住的关键信息。\n`;
  section += `格式：<memory>{"type":"fact|preference|goal|ability|behavior|mental","text":"简略信息（一句话）","detail":"详细内容（可选，更多细节）"}</memory>\n`;
  section += `六种记忆类型：\n`;
  for (const [type, cat] of Object.entries(MEMORY_CATEGORIES)) {
    section += `  - ${cat.icon} ${cat.label}：${getTypeDescription(type)}\n`;
  }
  section += `你可以在任何回复中嵌入一个或多个 <memory> 标签来提交记忆。\n`;
  section += `如果用户提供了值得长期记住的信息，请主动使用 <memory> 标签提取。\n`;
  section += `提示：text 字段填写简洁的一句话扼要，detail 字段（可选）填写补充细节，\n`;
  section += `prompt 和列表只显示 text，get_memory_detail 可查看完整 detail。\n`;

  return section;
}

function getTypeDescription(type) {
  const descs = {
    fact: '用户明确提供的客观信息，如日期、数据、状态',
    preference: '用户的喜好、习惯、期望的互动方式',
    goal: '用户的短期或长期目标',
    ability: '用户已掌握或未掌握的知识技能',
    behavior: '用户稳定的行为规律，用于优化提醒和规划',
    mental: '用户的思维或学习特点，仅作辅助理解'
  };
  return descs[type] || '';
}

// ═══════════ Memory Extraction from Conversation ═══════════

// Extract summary and facts from a conversation (called when user leaves a conv)
async function extractMemoryFromConv(conv) {
  if (!conv || !conv.messages || conv.messages.length < 3) return;
  // Check if already extracted up to current message count
  const currentCount = conv.messages.length;
  if (conv._memoryExtractedVersion && conv._memoryExtractedVersion >= currentCount) return;

  const apiCfg = getEffectiveApiConfig_B();
  if (!apiCfg || !apiCfg.apiKey) {
    if (isDebugMode()) console.log('[Memory] No API key configured, skip extraction');
    return;
  }

  // Build conversation context (last 30 messages max)
  const recentMsgs = conv.messages.slice(-30);
  const convContext = recentMsgs.map(m => {
    const roleLabel = m.role === 'user' ? '用户' : (m.role === 'assistant' ? 'AI' : '系统');
    return `${roleLabel}：${String(m.content || '').slice(0, 500)}`;
  }).join('\n');

  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');

  try {
    // Request 1: Extract summary
    const summaryResp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiCfg.apiKey
      },
      body: JSON.stringify({
        model: apiCfg.model,
        messages: [
          { role: 'system', content: '你是一个对话摘要助手。用一句话（不超过80字）概括这段对话的核心内容和结论。只输出摘要文本，不加任何前缀或引号。' },
          { role: 'user', content: convContext + '\n\n请为以上对话生成一句话摘要。' }
        ],
        temperature: 0.3,
        max_tokens: 150,
        stream: false
      })
    });

    const memory = loadAiMemory();
    let summaryText = '';

    if (summaryResp.ok) {
      const data = await summaryResp.json();
      summaryText = (data.choices?.[0]?.message?.content || '').trim();
      if (summaryText) {
        addConvSummary(memory, conv.id, conv.title, summaryText, currentCount);
      }
    }

    // Request 2: Extract key memory points (6 categories)
    const factResp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiCfg.apiKey
      },
      body: JSON.stringify({
        model: apiCfg.model,
        messages: [
          {
            role: 'system',
            content: `你是一个记忆提取助手。分析对话，提取用户值得长期记住的信息（1-3条）。每条输出一行JSON格式。

记忆类型：
- fact：客观事实
- preference：偏好习惯
- goal：目标
- ability：能力水平
- behavior：行为模式
- mental：思维特点

输出格式（每行一条）：
{"type":"fact","text":"简略信息（一句话扼要）","detail":"详细内容（可选，更多细节描述）"}
{"type":"preference","text":"喜欢简短回复"}

text 字段填写简洁扼要的一句话，detail 字段可选，补充更多细节。
如果没有值得长期记忆的信息，输出空数组 []。
只输出JSON行，不要其他文字。`
          },
          { role: 'user', content: convContext + '\n\n请提取以上对话中值得长期记忆的关键信息。' }
        ],
        temperature: 0.3,
        max_tokens: 500,
        stream: false
      })
    });

    if (factResp.ok) {
      const data = await factResp.json();
      const rawText = (data.choices?.[0]?.message?.content || '').trim();
      // Parse JSON lines
      const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (Array.isArray(parsed)) continue; // skip empty array
          if (parsed.type && parsed.text && MEMORY_CATEGORIES[parsed.type]) {
            upsertAutoFact(memory, parsed.type, parsed.text, conv.id, conv.title, parsed.detail);
          }
        } catch {
          // Try to parse as non-JSON text (fallback)
          if (line.length > 5 && line.length < 200 && !line.startsWith('[') && !line.startsWith('{')) {
            // Assume it's a fact
            upsertAutoFact(memory, 'fact', line, conv.id, conv.title);
          }
        }
      }
    }

    conv._memoryExtractedVersion = currentCount;
    saveAiMemory(memory);
    if (typeof safeSaveAiConvs === 'function') safeSaveAiConvs();

    if (isDebugMode()) console.log('[Memory] Extracted from conv:', conv.title, 'summary:', summaryText);
  } catch (err) {
    if (isDebugMode()) console.warn('[Memory] Extract error:', err.message);
  }
}

// Get API config for background tasks (memory extraction, daily integration)
function getEffectiveApiConfig_B() {
  // Reuse the main API config lookup - access via window to avoid circular dependency
  if (typeof getEffectiveApiConfig === 'function') {
    return getEffectiveApiConfig();
  }
  // Fallback: direct localStorage read
  try {
    const keys = JSON.parse(localStorage.getItem('study_api_keys') || '[]');
    const activeId = localStorage.getItem('study_active_api_key_id');
    const active = keys.find(k => k.id === activeId);
    if (active) return active;
    return keys.length > 0 ? keys[0] : null;
  } catch {
    return null;
  }
}

// ═══════════ Daily Integration (runs once per day) ═══════════

// 本地时区日期字符串（toISOString 是 UTC，跨时区会导致"今天"判断错位）
function getLocalDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function runDailyMemoryIntegration() {
  const memory = loadAiMemory();
  const today = getLocalDateStr();

  // Check if already run today
  if (memory.lastDailyIntegration === today) return;

  // Apply decay
  applyDailyDecay(memory);
  const cleaned = cleanupLowConfidence(memory);
  if (cleaned > 0 && isDebugMode()) console.log('[Memory] Daily cleanup: removed', cleaned, 'low-confidence entries');

  const apiCfg = getEffectiveApiConfig_B();
  if (!apiCfg || !apiCfg.apiKey) {
    memory.lastDailyIntegration = today;
    saveAiMemory(memory);
    return;
  }

  // Build context for the memory AI
  let context = '';

  // User profile (free-text)
  context += '【当前用户画像】\n';
  context += (memory.profileText && memory.profileText.trim()) ? memory.profileText.trim() + '\n\n' : '（暂无）\n\n';

  // Recent conv summaries
  if (memory.convSummaries.length > 0) {
    context += '【近期对话摘要】\n';
    const recent = memory.convSummaries.slice(-10);
    for (const s of recent) {
      const d = new Date(s.extractedAt);
      const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      context += `- [${ds}] ${s.convTitle}：${s.summary}\n`;
    }
    context += '\n';
  }

  // Current memory entries
  if (memory.autoFacts.length > 0) {
    context += '【当前记忆条目】\n';
    const sorted = [...memory.autoFacts].sort((a, b) => b.confidence - a.confidence);
    for (const e of sorted.slice(0, 30)) {
      const cat = MEMORY_CATEGORIES[e.type];
      context += `- ${cat.icon} ${cat.label}：${e.text} (置信度${Math.round(e.confidence*100)}%)\n`;
    }
    context += '\n';
  }

  // Recent focus / todo completion
  try {
    if (typeof loadCheckinData === 'function' && typeof getTodayFocusItems === 'function') {
      const checkinData = loadCheckinData();
      const focusData = getTodayFocusItems();
      context += `【近期状态】\n`;
      context += `打卡连续：${checkinData.streak || 0}天\n`;
      if (focusData.items && focusData.items.length > 0) {
        context += `今日聚焦：${focusData.items.filter(i => i.done).length}/${focusData.items.length}完成\n`;
      }
      if (typeof todos !== 'undefined') {
        const doneCount = todos.filter(t => t.done).length;
        context += `待办完成：${doneCount}/${todos.length}\n`;
      }
    }
  } catch {}

  const baseUrl = apiCfg.baseUrl.replace(/\/+$/, '');

  try {
    // Task 1: Generate daily summary from recent conv summaries
    const summaryResp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiCfg.apiKey
      },
      body: JSON.stringify({
        model: apiCfg.model,
        messages: [
          {
            role: 'system',
            content: `你是记忆整合AI。根据近期对话摘要，生成一段综合摘要（100-200字），概括用户近期的关注点、进展和重要话题。以"近期用户关注了..."开头。只输出摘要文本。`
          },
          { role: 'user', content: context + '\n请生成近期对话总摘要。' }
        ],
        temperature: 0.3,
        max_tokens: 300,
        stream: false
      })
    });

    if (summaryResp.ok) {
      const data = await summaryResp.json();
      const summary = (data.choices?.[0]?.message?.content || '').trim();
      if (summary) {
        memory.dailySummary = summary;
        memory.dailySummaryDate = today;
        // Clean old summaries (> 7 days) replaced by daily summary
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        memory.convSummaries = memory.convSummaries.filter(s => s.extractedAt > cutoff);
      }
    }

    // Task 2: Update user profile (generate holistic summary)
    const profileResp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiCfg.apiKey
      },
      body: JSON.stringify({
        model: apiCfg.model,
        messages: [
          {
            role: 'system',
            content: `你是用户画像更新AI。根据提供的上下文，生成或更新用户的一份全方位画像描述。

要求：
- 综合用户的身份背景、学习目标、兴趣偏好、能力水平、行为习惯、典型状态等各个方面
- 使用自然、流畅的一段话
- 保留已有画像中有价值的信息，仅在有新发现时补充或修正
- 不要用列表格式，用一段连贯的文字
- 字数控制在 100-200 字
- 只输出画像文字，不要解释或前缀`
          },
          { role: 'user', content: context + '\n请根据以上信息，生成一份完整的用户画像。' }
        ],
        temperature: 0.3,
        max_tokens: 400,
        stream: false
      })
    });

    if (profileResp.ok) {
      const data = await profileResp.json();
      const rawProfile = (data.choices?.[0]?.message?.content || '').trim();
      if (rawProfile && rawProfile.length > 10) {
        // Remove any leading/trailing quotes
        memory.profileText = rawProfile.replace(/^["']|["']$/g, '').trim();
      }
    }

  } catch (err) {
    if (isDebugMode()) console.warn('[Memory] Daily integration error:', err.message);
  }

  memory.lastDailyIntegration = today;
  saveAiMemory(memory);

  if (isDebugMode()) console.log('[Memory] Daily integration completed for', today);
}

// ═══════════ Memory Tools (callable from AI) ═══════════

function toolListMemories(params) {
  const memory = loadAiMemory();
  const { type, search, sort } = params || {};
  let entries = [...memory.autoFacts];

  if (type && MEMORY_CATEGORIES[type]) {
    entries = entries.filter(e => e.type === type);
  }
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter(e => e.text.toLowerCase().includes(q));
  }
  if (sort === 'confidence') {
    entries.sort((a, b) => b.confidence - a.confidence);
  } else if (sort === 'recent') {
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
  } else {
    // Default: by type then confidence
    entries.sort((a, b) => a.type.localeCompare(b.type) || b.confidence - a.confidence);
  }

  if (entries.length === 0) return '暂无记忆条目。';

  let result = `共 ${entries.length} 条记忆条目：\n`;
  for (const e of entries) {
    const cat = MEMORY_CATEGORIES[e.type];
    // Show title only (text field)
    result += `[${e.id}] ${cat.icon} ${e.text} | 置信度${Math.round(e.confidence*100)}%`;
    if (e.sourceConvTitle) result += ` | 来源：${e.sourceConvTitle}`;
    result += '\n';
  }
  return result;
}

function toolGetMemoryDetail(params) {
  const memory = loadAiMemory();
  const id = params.id;
  const entry = memory.autoFacts.find(e => e.id === id);
  if (!entry) {
    // 也支持查询手动记忆（原实现中该分支永远不可达）
    const manualEntry = memory.manualNotes.find(n => n.id === id);
    if (manualEntry) {
      let result = `【📝 手动记忆】\n`;
      result += `简略：${manualEntry.content}\n`;
      if (manualEntry.detail) result += `详细：${manualEntry.detail}\n`;
      result += `创建时间：${new Date(manualEntry.createdAt).toLocaleString('zh-CN')}\n`;
      result += `更新时间：${new Date(manualEntry.updatedAt).toLocaleString('zh-CN')}\n`;
      return result;
    }
    return '❌ 未找到该记忆条目。';
  }

  const cat = MEMORY_CATEGORIES[entry.type];
  let result = `【${cat.icon} ${cat.label}】\n`;
  result += `简略信息：${entry.text}\n`;
  if (entry.detail) result += `详细内容：${entry.detail}\n`;
  result += `置信度：${Math.round(entry.confidence * 100)}%\n`;
  result += `创建时间：${new Date(entry.createdAt).toLocaleString('zh-CN')}\n`;
  result += `更新时间：${new Date(entry.updatedAt).toLocaleString('zh-CN')}\n`;
  if (entry.sourceConvTitle) {
    result += `来源对话：${entry.sourceConvTitle}\n`;
  }
  return result;
}

// ═══════════ Parse <memory> tags from AI response ═══════════

function parseMemoryTags(assistantContent, convId, convTitle) {
  const memory = loadAiMemory();
  const regex = /<memory>\s*(\{[\s\S]*?\})\s*<\/memory>/g;
  let match;
  let count = 0;

  while ((match = regex.exec(assistantContent)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.type && parsed.text && MEMORY_CATEGORIES[parsed.type]) {
        const entry = upsertAutoFact(memory, parsed.type, parsed.text.trim(), convId, convTitle, parsed.detail);
        if (entry) count++;
      }
    } catch {
      // Skip malformed tags
    }
  }

  if (count > 0) {
    saveAiMemory(memory);
    if (isDebugMode()) console.log('[Memory] Parsed', count, 'memory tags from AI response');
  }
  return count;
}

// ═══════════ Conversation leave handler (with debounce) ═══════════

let _memoryExtractTimers = {};

function scheduleMemoryExtract(conv) {
  if (!conv || !conv.id) return;

  // Clear existing timer for this conv
  if (_memoryExtractTimers[conv.id]) {
    clearTimeout(_memoryExtractTimers[conv.id]);
  }

  // Set debounce: 500ms delay
  _memoryExtractTimers[conv.id] = setTimeout(() => {
    delete _memoryExtractTimers[conv.id];
    extractMemoryFromConv(conv);
  }, 500);
}

// ═══════════ Initialization ═══════════

// Trigger daily integration check
function checkDailyIntegration() {
  const memory = loadAiMemory();
  const today = getLocalDateStr();
  if (memory.lastDailyIntegration !== today) {
    // Run asynchronously
    runDailyMemoryIntegration().catch(err => {
      if (isDebugMode()) console.warn('[Memory] Daily integration failed:', err);
    });
  }
}

// Add to MIGRATION_KEYS for backup compatibility
if (typeof MIGRATION_KEYS !== 'undefined' && Array.isArray(MIGRATION_KEYS)) {
  if (!MIGRATION_KEYS.includes('study_ai_memory')) {
    MIGRATION_KEYS.push('study_ai_memory');
  }
}

// Expose to global scope
window.loadAiMemory = loadAiMemory;
window.saveAiMemory = saveAiMemory;
window.formatMemoryForPrompt = formatMemoryForPrompt;
window.extractMemoryFromConv = extractMemoryFromConv;
window.parseMemoryTags = parseMemoryTags;
window.scheduleMemoryExtract = scheduleMemoryExtract;
window.runDailyMemoryIntegration = runDailyMemoryIntegration;
window.checkDailyIntegration = checkDailyIntegration;
window.upsertAutoFact = upsertAutoFact;
window.addManualNote = addManualNote;
window.updateManualNote = updateManualNote;
window.deleteManualNote = deleteManualNote;
window.addConvSummary = addConvSummary;
window.deleteConvSummary = deleteConvSummary;
window.updateAutoFact = updateAutoFact;
window.updateConvSummary = updateConvSummary;
window.toolListMemories = toolListMemories;
window.toolGetMemoryDetail = toolGetMemoryDetail;
window.MEMORY_CATEGORIES = MEMORY_CATEGORIES;
