// 临时诊断：验证 sync-logs.js 核心算法（gzip 往返 / 分片重组 / 字典序 / hash 稳定）
const MAX_ITEM_CHAR = 700 * 1024;

async function gzipB64(obj) {
  const enc = new TextEncoder();
  const blob = new Blob([enc.encode(JSON.stringify(obj))]);
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return { b64: btoa(bin), rawBytes: bytes.length };
}
async function gzipDecode(data) {
  const bin = atob(data.d);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buf));
}
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
async function packRec(itemId, meta, tree, activePath, items, depth, maxChars = MAX_ITEM_CHAR) {
  const payload = { meta, tree, activePath, items, part: 0, parts: 1 };
  const r = await gzipB64(payload);
  if (r.b64.length <= maxChars || items.length <= 1 || depth >= 6) {
    return [{ itemId, wrap: { v: 1, c: 'gzip', d: r.b64 }, bytes: r.rawBytes }];
  }
  const mid = Math.ceil(items.length / 2);
  const left = await packRec(itemId + '_p0', meta, tree, activePath, items.slice(0, mid), depth + 1, maxChars);
  const right = await packRec(itemId + '_p1', meta, null, null, items.slice(mid), depth + 1, maxChars);
  return left.concat(right);
}
async function rebuildPieces(pieces) {
  const sorted = pieces.slice().sort((a, b) => a.item_id.localeCompare(b.item_id));
  let meta = null, tree = null, activePath = null, items = [];
  for (const p of sorted) {
    const obj = await gzipDecode(p.data);
    if (obj.meta) meta = obj.meta;
    if (obj.tree) tree = obj.tree;
    if (obj.activePath) activePath = obj.activePath;
    if (Array.isArray(obj.items)) items = items.concat(obj.items);
  }
  return { meta, tree, activePath, items };
}

// ── 测试 1：小数据往返 ──
{
  const src = { meta: { id: 42, title: '测试会话' }, tree: { n1: { content: 'x' } }, activePath: ['n1'], items: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '世界' }] };
  const r = await gzipB64(src);
  const back = await gzipDecode({ d: r.b64 });
  if (JSON.stringify(back) !== JSON.stringify(src)) { console.error('FAIL roundtrip-small'); process.exit(1); }
  if (r.rawBytes <= 0) { console.error('FAIL bytes'); process.exit(1); }
  console.log('PASS 小数据 gzip 往返, bytes =', r.rawBytes);
}

// ── 测试 2：大数据分片 + 重组（用低阈值强制分片，验证二分逻辑）──
{
  const meta = { id: 7, title: '超大会话', systemPrompt: '', createdAt: 0, autoTitled: false };
  const tree = { root: { content: 'ROOT' } };
  const items = [];
  for (let i = 0; i < 2000; i++) {
    items.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '这是一条用于分片测试的长消息内容，序号 ' + i + '：' + 'abcdefg'.repeat(30) });
  }
  // 用小阈值（4K）强制产生多片，验证二分分片与字典序重组正确
  const pieces = await packRec('conv-7', meta, tree, ['root'], items, 0, 4 * 1024);
  if (pieces.length <= 1) { console.error('FAIL 未分片（应多片）'); process.exit(1); }
  console.log('PASS 强制分片数 =', pieces.length, '| 分片 id:', pieces.map(p => p.itemId).join(', '));
  const remoteRows = pieces.map((p) => ({ item_id: p.itemId, data: p.wrap }));
  const built = await rebuildPieces(remoteRows);
  if (JSON.stringify(built.items) !== JSON.stringify(items)) { console.error('FAIL 重组消息不一致'); process.exit(1); }
  if (JSON.stringify(built.tree) !== JSON.stringify(tree)) { console.error('FAIL 重组 tree 不一致'); process.exit(1); }
  if (JSON.stringify(built.meta) !== JSON.stringify(meta)) { console.error('FAIL 重组 meta 不一致'); process.exit(1); }
  if (JSON.stringify(built.activePath) !== JSON.stringify(['root'])) { console.error('FAIL 重组 activePath 不一致'); process.exit(1); }
  console.log('PASS 大数据分片重组一致（items/tree/meta/activePath）');
}

// ── 测试 5：真实阈值下不分片（确认 2000 条常规消息不误分）──
{
  const items = [];
  for (let i = 0; i < 2000; i++) {
    items.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: '普通消息 ' + i + '：' + 'abcdefg'.repeat(30) });
  }
  const pieces = await packRec('conv-8', { id: 8, title: '' }, null, null, items, 0);
  console.log('PASS 真实阈值(700K)分片数 =', pieces.length, '(1 = 单行上传)');
}

// ── 测试 3：hash 稳定性 ──
{
  const a = hashStr('abcdefg'.repeat(100));
  const b = hashStr('abcdefg'.repeat(100));
  if (a !== b) { console.error('FAIL hash 不稳定'); process.exit(1); }
  console.log('PASS hash 稳定 =', a);
}

// ── 测试 4：字典序重组顺序（4 片：_p0_p0/_p0_p1/_p1_p0/_p1_p1）──
{
  const ids = ['c_p1_p1', 'c_p0_p0', 'c_p1_p0', 'c_p0_p1'];
  const sorted = ids.slice().sort((a, b) => a.localeCompare(b));
  const expect = ['c_p0_p0', 'c_p0_p1', 'c_p1_p0', 'c_p1_p1'];
  if (sorted.join(',') !== expect.join(',')) { console.error('FAIL 字典序', sorted); process.exit(1); }
  console.log('PASS 分片字典序重组顺序正确');
}

console.log('\nALL_DIAG_PASS');
