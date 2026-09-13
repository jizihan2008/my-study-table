// ═══════════════════════════════════════════════
//  AI 树状对话引擎：把「线性消息数组 + _candidates 平级候选」
//  重构为「真正的树（节点 + 父子链接 + 分支）」。
//  - conv.tree      : { nodeId: node }  节点字典（唯一数据源）
//  - conv.activePath: [nodeId,...]      当前活跃路径（根 → 当前）
//  - conv.messages  : 活跃路径的扁平缓存视图，由树引擎同步维护，
//                    保证外部读路径（记忆提取/标题/导出/日报）零改动。
//  多对话（每个是树）合起来即森林。
// ═══════════════════════════════════════════════

// 判断某 conv 是否已采用树结构（迁移过）
function isTreeConv(conv) {
  return !!(conv && conv.tree && conv.activePath);
}

// 相同内容的“编辑后发送”在旧版本中会创建两个一模一样的 user 兄弟节点。
// 这会把后续回复藏到另一个消息版本里，看起来像聊天记录丢失。
// 将这类无意义的重复 user 节点合并为一个节点，其各自的回复链仍作为候选分支保留。
function mergeDuplicateUserBranches(conv) {
  if (!conv || !conv.tree) return false;
  const tree = conv.tree;
  let changed = false;
  let activeEndpoint = Array.isArray(conv.activePath) ? conv.activePath[conv.activePath.length - 1] : null;

  const signature = node => {
    try {
      return JSON.stringify([
        node.content || '',
        node.attachments || null,
        node.visionFiles || null
      ]);
    } catch (_) {
      return String(node.content || '');
    }
  };

  for (const parent of Object.values(tree)) {
    if (!parent || !Array.isArray(parent.children) || parent.children.length < 2) continue;
    const seen = new Map();
    for (const childId of [...parent.children]) {
      const child = tree[childId];
      if (!child || child.role !== 'user') continue;
      const key = signature(child);
      const existingId = seen.get(key);
      if (existingId == null) {
        seen.set(key, childId);
        continue;
      }

      // 当前正在显示重复节点时，以它为主节点，避免修复后意外切换用户看到的分支。
      const activeIds = new Set(conv.activePath || []);
      let keepId = existingId;
      let removeId = childId;
      if (activeIds.has(childId) && !activeIds.has(existingId)) {
        keepId = childId;
        removeId = existingId;
        seen.set(key, keepId);
      }
      const keep = tree[keepId];
      const duplicate = tree[removeId];
      if (!keep || !duplicate) continue;
      if (!Array.isArray(keep.children)) keep.children = [];
      for (const grandchildId of duplicate.children || []) {
        if (!keep.children.includes(grandchildId)) keep.children.push(grandchildId);
        if (tree[grandchildId]) tree[grandchildId].parentId = keepId;
      }
      parent.children = parent.children.filter(id => id !== removeId);
      if (!parent.children.includes(keepId)) parent.children.push(keepId);
      if (activeEndpoint === removeId) activeEndpoint = keepId;
      delete tree[removeId];
      changed = true;
    }
  }

  if (changed) {
    const endpoint = tree[activeEndpoint] ? activeEndpoint : 'root';
    conv.activePath = buildPathTo(tree, endpoint);
  }
  return changed;
}

// 旧版相同内容编辑产生分支后，用户可能在原工具链下发送“继续”，而真正被停止的
// 长回复留在兄弟分支中。该结构在界面上会表现为中间回复消失。只有同时满足
// “短继续指令 + 无后续回复 + 兄弟回复明确带停止标记”时才重接，避免改动正常分支。
function reattachContinuationAfterStoppedSibling(conv) {
  if (!conv || !conv.tree || !Array.isArray(conv.activePath)) return false;
  const tree = conv.tree;
  const path = conv.activePath;
  const isContinuation = node => node && node.role === 'user'
    && /^(?:请)?(?:继续|接着(?:说|写|完成)?|往下(?:说|写)?|continue|go on)[\s.!。！]*$/i.test(String(node.content || '').trim());
  let changed = false;

  for (let i = path.length - 1; i >= 1; i--) {
    const continuation = tree[path[i]];
    if (!isContinuation(continuation) || (continuation.children || []).length > 0) continue;

    // 找到该继续消息所属交换的最上层 user，以及当前路径从它进入的 assistant 分支。
    let questionIndex = -1;
    for (let j = i - 1; j >= 1; j--) {
      if (tree[path[j]] && tree[path[j]].role === 'user') { questionIndex = j; break; }
    }
    if (questionIndex < 0) continue;
    const question = tree[path[questionIndex]];
    const activeAssistantId = path[questionIndex + 1];
    const stoppedSiblingId = (question.children || []).find(id => {
      const node = tree[id];
      return id !== activeAssistantId
        && node && node.role === 'assistant'
        && (node.children || []).length === 0
        && /(?:⏹️|已停止生成|已手动停止)/.test(String(node.content || ''));
    });
    if (stoppedSiblingId == null) continue;

    const oldParent = tree[continuation.parentId];
    const stoppedSibling = tree[stoppedSiblingId];
    if (!oldParent || !stoppedSibling) continue;
    oldParent.children = (oldParent.children || []).filter(id => id !== continuation.id);
    question.children = (question.children || []).filter(id => id !== stoppedSiblingId);
    stoppedSibling.parentId = oldParent.id;
    if (!oldParent.children.includes(stoppedSiblingId)) oldParent.children.push(stoppedSiblingId);
    stoppedSibling.children = [continuation.id];
    continuation.parentId = stoppedSiblingId;
    conv.activePath = buildPathTo(tree, continuation.id);
    changed = true;
    break;
  }
  return changed;
}

// ── 核心：由 activePath 重建扁平 messages 视图 ──
function recomputeMessages(conv) {
  if (!conv || !conv.tree || !conv.activePath) return conv.messages || [];
  const nodes = conv.activePath
    .map(id => conv.tree[id])
    .filter(Boolean)
    .filter(n => n.role && n.role !== 'root');
  conv.messages = nodes;
  return conv.messages;
}

// ── 核心：取当前活跃路径的节点序列（含 root） ──
function activePathNodes(conv) {
  if (!isTreeConv(conv)) return [];
  return conv.activePath.map(id => conv.tree[id]).filter(Boolean);
}

// 取活跃路径上"非系统"的用户/助手消息（供标题生成等使用，兼容旧语义）
function activePathUserAssistantNodes(conv) {
  return activePathNodes(conv).filter(n => n.role === 'user' || n.role === 'assistant');
}

// ── 迁移：把旧线性 conv（含 _candidates）转换为树 ──
// 线性数组 → 一条直链树；_candidates → 同父节点下的兄弟分支。
function migrateConvToTree(conv) {
  if (!conv) return conv;
  if (isTreeConv(conv)) return conv; // 已迁移

  const tree = {};
  const rootId = 'root';
  tree[rootId] = { id: rootId, role: 'root', parentId: null, children: [] };

  let prevId = rootId;
  const oldMessages = Array.isArray(conv.messages) ? conv.messages : [];
  // 带候选的 user 之后，紧随的非 user 消息是候选链的重复，需跳过（对应渲染的 skipUntilUser）
  let skipUntilUser = false;

  for (let i = 0; i < oldMessages.length; i++) {
    const m = oldMessages[i];
    if (!m || typeof m !== 'object') continue;

    // 跳过逻辑：在候选 user 之后、遇到下一个 user 之前，跳过所有独立消息
    if (skipUntilUser && m.role !== 'user') continue;

    // 有候选的 user 消息：把每个候选的整条链作为兄弟分支展开
    if (m.role === 'user' && Array.isArray(m._candidates) && m._candidates.length > 0) {
      skipUntilUser = true;
      // 1) 先在 prevId 下创建该 user 消息节点本身
      const userNodeId = genId();
      tree[userNodeId] = {
        id: userNodeId, role: 'user',
        content: m.content, time: m.time,
        attachments: m.attachments, visionFiles: m.visionFiles,
        parentId: prevId, children: []
      };
      if (!tree[prevId].children.includes(userNodeId)) tree[prevId].children.push(userNodeId);

      // 2) 对每个候选创建一条分支链（候选是"这个 user 之后的整段消息"）
      //    _activeCandidate 指定的那个作为活跃路径。
      const activeIdx = Math.min(m._activeCandidate || 0, m._candidates.length - 1);
      for (let ci = 0; ci < m._candidates.length; ci++) {
        const cand = m._candidates[ci];
        const candChain = cand && cand.messages && cand.messages.length
          ? cand.messages
          : (cand && cand.content ? [cand] : []);
        let branchParentId = userNodeId;
        for (const cm of candChain) {
          if (!cm || typeof cm !== 'object') continue;
          const nodeId = genId();
          tree[nodeId] = {
            id: nodeId,
            role: cm.role || 'assistant',
            content: cm.content,
            time: cm.time,
            reasoning: cm.reasoning,
            keyName: cm.keyName,
            tool_calls: cm.tool_calls,
            _toolInfo: cm._toolInfo,
            _kimiSearch: cm._kimiSearch,
            _kimiSearchResult: cm._kimiSearchResult,
            parentId: branchParentId,
            children: []
          };
          if (!tree[branchParentId].children.includes(nodeId)) tree[branchParentId].children.push(nodeId);
          branchParentId = nodeId;
        }
        // 活跃候选的末尾节点 = 活跃路径的接续点
        if (ci === activeIdx) prevId = branchParentId;
      }
      continue;
    }

    // 普通消息：直接挂在 prevId 下（遇到 user 时结束跳过）
    if (m.role === 'user') skipUntilUser = false;
    const nodeId = genId();
    tree[nodeId] = {
      id: nodeId,
      role: m.role || 'assistant',
      content: m.content,
      time: m.time,
      reasoning: m.reasoning,
      keyName: m.keyName,
      attachments: m.attachments,
      visionFiles: m.visionFiles,
      tool_calls: m.tool_calls,
      _toolInfo: m._toolInfo,
      _kimiSearch: m._kimiSearch,
      _kimiSearchResult: m._kimiSearchResult,
      parentId: prevId,
      children: []
    };
    if (!tree[prevId].children.includes(nodeId)) tree[prevId].children.push(nodeId);
    prevId = nodeId;
  }

  // 清理旧候选字段
  delete conv._candidates;
  delete conv._activeCandidate;
  delete conv._adopted;

  conv.tree = tree;
  conv.activePath = buildPathTo(tree, prevId);
  recomputeMessages(conv);
  return conv;
}

// 由末节点回溯构建到根(root)的路径
function buildPathTo(tree, nodeId) {
  const path = [];
  let cur = nodeId;
  while (cur != null && tree[cur]) {
    path.unshift(cur);
    const p = tree[cur].parentId;
    if (p == null || p === cur) break;
    cur = p;
  }
  if (path.length === 0 || path[0] !== 'root') path.unshift('root');
  return path;
}

// ── 创建一棵新树（空对话） ──
function initTreeOnConv(conv) {
  const tree = {};
  const rootId = 'root';
  tree[rootId] = { id: rootId, role: 'root', parentId: null, children: [] };
  conv.tree = tree;
  conv.activePath = [rootId];
  conv.messages = [];
  return conv;
}

// 确保 conv 已是树（兼容：新对话 / 旧数据）
function ensureTree(conv) {
  if (!conv) return conv;
  if (!isTreeConv(conv)) {
    // 有消息 → 迁移；无消息 → 初始化为空树
    if (Array.isArray(conv.messages) && conv.messages.length > 0) {
      migrateConvToTree(conv);
    } else {
      initTreeOnConv(conv);
    }
  }
  // activePath 是唯一展示路径，messages 只是其缓存。旧同步数据可能让两者不一致，
  // 因而每次确保树结构时都重新计算缓存；同时修复旧版产生的相同 user 分支。
  mergeDuplicateUserBranches(conv);
  reattachContinuationAfterStoppedSibling(conv);
  recomputeMessages(conv);
  return conv;
}

// ── 核心写路径 1：在当前活跃路径末尾追加一条消息 ──
// msg 支持 role/content/time/attachments/visionFiles/reasoning/keyName
// 及工具链相关字段（tool_calls/_toolInfo/_kimiSearch...）。
function appendMessage(conv, msg) {
  ensureTree(conv);
  if (!conv.tree || !conv.activePath || conv.activePath.length === 0) return null;
  const parentId = conv.activePath[conv.activePath.length - 1];
  const nodeId = genId();
  const node = Object.assign({}, msg, {
    id: nodeId,
    parentId: parentId,
    children: []
  });
  // 移除不应存到节点上的顶层字段
  delete node._candidates;
  delete node._activeCandidate;
  delete node._adopted;
  conv.tree[nodeId] = node;
  if (!conv.tree[parentId].children.includes(nodeId)) conv.tree[parentId].children.push(nodeId);
  conv.activePath.push(nodeId);
  recomputeMessages(conv);
  return nodeId;
}

// ── 核心写路径 2：在任意节点下创建分支并切换过去 ──
// 用于"从这里分叉"与"换一条（重新生成）"。baseNodeId 为父节点。
function createBranch(conv, baseNodeId, msg) {
  ensureTree(conv);
  if (!conv.tree || !conv.tree[baseNodeId]) return null;
  const nodeId = genId();
  const node = Object.assign({}, msg, {
    id: nodeId,
    parentId: baseNodeId,
    children: []
  });
  delete node._candidates;
  delete node._activeCandidate;
  delete node._adopted;
  conv.tree[nodeId] = node;
  if (!conv.tree[baseNodeId].children.includes(nodeId)) conv.tree[baseNodeId].children.push(nodeId);
  // 切换到新分支
  conv.activePath = buildPathTo(conv.tree, nodeId);
  recomputeMessages(conv);
  return nodeId;
}

// ── 编辑消息：在原 user 节点的父节点下创建「编辑后的新 user 分支」并切换过去 ──
// 用于"编辑消息后发送"：编辑后的内容作为新的 user 节点与原 user 并列（兄弟分支），
// 后续 AI 回复会在其下生成，形成 👤 b' → 🤖 回复B' 的分支。
function createBranchFromEdit(conv, baseUserId, newContent, extraFields) {
  ensureTree(conv);
  const baseUser = conv.tree[baseUserId];
  if (!conv.tree || !baseUser || baseUser.role !== 'user') return null;
  const parentId = baseUser.parentId;
  if (!conv.tree[parentId]) return null;
  const nodeId = genId();
  const node = Object.assign({}, extraFields || {}, {
    id: nodeId,
    role: 'user',
    content: newContent,
    time: baseUser.time,
    parentId: parentId,
    children: []
  });
  // 复制原 user 的附件/视觉文件（编辑通常保留附件）
  if (baseUser.attachments !== undefined && node.attachments === undefined) node.attachments = baseUser.attachments;
  if (baseUser.visionFiles !== undefined && node.visionFiles === undefined) node.visionFiles = baseUser.visionFiles;
  delete node._candidates;
  delete node._activeCandidate;
  delete node._adopted;
  conv.tree[nodeId] = node;
  if (!conv.tree[parentId].children.includes(nodeId)) conv.tree[parentId].children.push(nodeId);
  // 切换到新分支
  conv.activePath = buildPathTo(conv.tree, nodeId);
  recomputeMessages(conv);
  return nodeId;
}

// ── 切换活跃分支到指定节点 ──
function switchBranch(conv, nodeId) {
  if (!isTreeConv(conv) || !conv.tree[nodeId]) return false;
  conv.activePath = buildPathTo(conv.tree, nodeId);
  recomputeMessages(conv);
  return true;
}

// ── 统计某节点下的兄弟分支数（含自己）──
function siblingBranchCount(conv, nodeId) {
  if (!isTreeConv(conv) || !conv.tree[nodeId]) return 1;
  const p = conv.tree[nodeId].parentId;
  if (p == null || !conv.tree[p]) return 1;
  return conv.tree[p].children.length;
}

// 取某节点的兄弟节点 id 列表（不含自己，用于分支切换导航）
function siblingNodeIds(conv, nodeId) {
  if (!isTreeConv(conv) || !conv.tree[nodeId]) return [];
  const p = conv.tree[nodeId].parentId;
  if (p == null || !conv.tree[p]) return [];
  return conv.tree[p].children.filter(id => id !== nodeId);
}

// ── 判断某 user 节点是否已分叉（有多个 assistant 候选）──
// 返回 { count, activeBranchStartId } 或 null
function branchInfoAt(conv, nodeId) {
  if (!isTreeConv(conv) || !conv.tree[nodeId]) return null;
  const node = conv.tree[nodeId];
  if (node.role !== 'user') return null;
  if (!node.children || node.children.length < 2) return null;
  // 活跃路径上当前接续的 child
  let activeChild = null;
  const pathSet = new Set(conv.activePath);
  for (const cid of node.children) {
    if (pathSet.has(cid)) { activeChild = cid; break; }
  }
  return { count: node.children.length, activeChild };
}

// ── 清空对话：重置为空树 ──
function resetConvTree(conv) {
  const tree = {};
  tree['root'] = { id: 'root', role: 'root', parentId: null, children: [] };
  conv.tree = tree;
  conv.activePath = ['root'];
  conv.messages = [];
  return conv;
}

// 当前活跃路径上，向上最近的一个 user 节点 id
function lastUserNodeIdInActivePath(conv) {
  if (!isTreeConv(conv)) return null;
  for (let i = conv.activePath.length - 1; i >= 0; i--) {
    const n = conv.tree[conv.activePath[i]];
    if (n && n.role === 'user') return n.id;
  }
  return null;
}

// ── 交换聚合（树导航展示用）──
// 把「一次 user 提问 + AI 回复链（含工具调用、多次 API 调用）」视为一个交换节点。
// 数据模型保持消息级节点不变；以下辅助函数供树导航浮窗折叠展示。

// 收集以某 user 节点为根的子树中所有嵌套 user 节点 id（前序，父交换优先）。
// 注意：遍历不包含根 userId 本身；遇到 user 时记下并继续下钻其 children（含嵌套交换）。
function collectNestedUserIds(conv, userId) {
  if (!isTreeConv(conv)) return [];
  const tree = conv.tree;
  const out = [];
  const stack = [...((tree[userId] && tree[userId].children) || [])];
  const seen = new Set();
  while (stack.length) {
    const cid = stack.pop();
    if (!tree[cid] || seen.has(cid)) continue;
    seen.add(cid);
    if (tree[cid].role === 'user') out.push(cid);
    for (let i = (tree[cid].children || []).length - 1; i >= 0; i--) stack.push(tree[cid].children[i]);
  }
  const depthOf = (id) => { let d = 0, cur = id; while (cur && tree[cur]) { if (tree[cur].role === 'root') break; d++; cur = tree[cur].parentId; } return d; };
  out.sort((a, b) => depthOf(a) - depthOf(b));
  return out;
}

// 保留活跃路径最近 maxLen 条消息，重建树（用于日报等长对话防膨胀）。
// 仅在活跃路径上不存在分叉（每个非 root 节点都是父节点唯一 child）时安全执行；
// 否则保持现状返回 false。
function trimConvMessages(conv, maxLen) {
  ensureTree(conv);
  if (!isTreeConv(conv)) return false;
  const nodes = conv.messages || [];
  if (nodes.length <= maxLen) return false;

  // 检查是否纯线性（无分支）
  for (const n of nodes) {
    const p = conv.tree[n.parentId];
    if (p && p.children && p.children.length > 1) return false; // 有分叉，不裁剪
  }

  const keep = nodes.slice(-maxLen).map(n => ({ role: n.role, content: n.content, time: n.time, reasoning: n.reasoning, keyName: n.keyName, attachments: n.attachments, visionFiles: n.visionFiles, tool_calls: n.tool_calls, _toolInfo: n._toolInfo, _malformedToolProtocol: n._malformedToolProtocol, _dsmlToolProtocol: n._dsmlToolProtocol, _toolRoundCleanText: n._toolRoundCleanText, _kimiSearch: n._kimiSearch, _kimiSearchResult: n._kimiSearchResult }));
  resetConvTree(conv);
  for (const k of keep) appendMessage(conv, k);
  return true;
}
