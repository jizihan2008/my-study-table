// 临时诊断：验证 renderNoteMindmap 的树形字符解析（与 ai-render.js 同逻辑）
// 判断代码块内容是否"看起来像"思维导图（与 ai-render.js 的 looksLikeMindmap 同逻辑）
function looksLikeMindmap(code) {
  const s = String(code || '');
  if (/[├└]/.test(s)) return true; // 树形字符格式
  const nonEmpty = s.split('\n').filter(l => l.trim());
  if (nonEmpty.length < 2) return false;
  // 排除 ASCII 树/图：存在以连接符（\ / |）开头的行（如 "/"、"/ \"、"|-- main.js"、"|\"）
  if (nonEmpty.some(l => /^[\\/|]/.test(l.trim()))) return false;
  const indents = nonEmpty.map(l => (l.match(/^(\t| {2,})/) ? l.match(/^(\t| {2,})/)[0].length : 0));
  if (new Set(indents).size < 2) return false; // 无嵌套层级
  if (/[{};]|=>|<\/|<!--|\$\{|\b(function|const|let|var|return|if|else|for|while|class|import|export)\b/.test(s)) return false;
  return true;
}

function renderNoteMindmap(code) {
  const lines = String(code || '').split('\n');
  const root = { name: '', children: [] };
  const isTreeChar = lines.some(l => /[├└]/.test(l));
  const stack = [{ node: root, depth: -1 }];
  const pushNode = (depth, name) => {
    const node = { name: name, children: [] };
    while (stack.length > 1 && depth <= stack[stack.length - 1].depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node: node, depth: depth });
  };
  let unit = 0;
  if (isTreeChar) {
    const uniqCols = [...new Set(lines.map(l => l.search(/[├└]/)).filter(i => i >= 0))].sort((a, b) => a - b);
    for (const c of uniqCols) { if (c > 0) { unit = c; break; } }
  }
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (isTreeChar) {
      const m = line.match(/^([│| ]*)([├└])─+[ \t]*(.*)$/);
      if (m) {
        const col = line.indexOf(m[2]);
        const depth = unit > 0 ? Math.round(col / unit) + 1 : 1;
        pushNode(depth, m[3].trim());
      } else {
        pushNode(0, line.trim());
      }
    } else {
      const indent = line.length - line.trimStart().length;
      pushNode(indent, line.trim());
    }
  }
  const out = [];
  const renderNode = (node, level) => {
    const children = (node.children && node.children.length)
      ? node.children.map(c => renderNode(c, level + 1)).join('')
      : '';
    return `<div class="bk-mm-node level-${Math.min(level, 4)}">${node.name}${children}</div>`;
  };
  return root.children.map(c => renderNode(c, 1)).join('');
}

const userExample = `0x22 深度优先搜索
├─ 概念体系
│  ├─ 状态空间 = 图（状态→节点，转移→边）
│  ├─ 搜索树 = 状态点 + 成功递归的边
│  ├─ DFS 三要素：遍历形式 / 状态记录检索 / 剪枝
│  └─ 三种基础枚举：指数型·排列型·组合型（子集和·全排列·N皇后）
├─ 例1 小猫爬山 AcWing165（装箱问题，N≤18）
│  ├─ 状态：dfs(now, cnt) + cab[]
│  ├─ 分支：cnt+1（放旧车 / 租新车）
│  ├─ 剪枝：cnt ≥ ans 回溯（最优性剪枝）
│  └─ 顺序优化：重量降序，大猫优先（fail-first）
├─ 例2 Sudoku AcWing166（9×9 约束满足）
│  ├─ 每状态只选 1 格分支（勿混淆层次与分支！）
│  ├─ MRV：候选最少格优先 → 分支因子最小化
│  └─ 位运算：行&列&宫 → lowbit 取候选，O(1) 填撤
└─ 方法论
   ├─ 效率 = 搜索树规模 × 单点开销
   ├─ fail-first：约束最强者优先
   └─ 数据范围定算法：N≤20 → 搜索/状压`;

const indentExample = `中心主题
  分支一
    子分支1
    子分支2
  分支二`;

// tree 命令风格（双横线 ├── / └──）——曾导致节点名残留 "─ " 前缀
const treeCmdExample = `根节点
├── 一级A
│   ├── 二级A1
│   └── 二级A2
└── 一级B`;

function countLevel(html, level) {
  return (html.match(new RegExp(`level-${level}`, 'g')) || []).length;
}

const h1 = renderNoteMindmap(userExample);
const h2 = renderNoteMindmap(indentExample);

console.log('--- 树形字符格式层级统计 ---');
console.log('level-1 数（根级节点）:', countLevel(h1, 1));   // 期望 1（0x22 DFS）
console.log('level-2 数（一级分支）:', countLevel(h1, 2));   // 期望 4（概念/例1/例2/方法论）
console.log('level-3 数（二级节点）:', countLevel(h1, 3));   // 期望 4+4+3+3=14
console.log('level-4 数:', countLevel(h1, 4));               // 期望 0（树形里最深 3 级）

console.log('--- 缩进格式层级统计 ---');
console.log('level-1 数（中心）:', countLevel(h2, 1));       // 期望 1
console.log('level-2 数（分支）:', countLevel(h2, 2));       // 期望 2
console.log('level-3 数（子分支）:', countLevel(h2, 3));     // 期望 2

// 校验内容正确性
if (!h1.includes('0x22 深度优先搜索')) { console.error('FAIL: 缺根节点'); process.exit(1); }
if (!h1.includes('概念体系')) { console.error('FAIL: 缺一级分支'); process.exit(1); }
if (!h1.includes('状态空间 = 图')) { console.error('FAIL: 缺二级内容'); process.exit(1); }
if (!h1.includes('数据范围定算法')) { console.error('FAIL: 方法论二级'); process.exit(1); }
if (countLevel(h1, 1) !== 1 || countLevel(h1, 2) !== 4 || countLevel(h1, 3) !== 14) {
  console.error('FAIL: 树形层级数不对'); process.exit(1);
}
if (countLevel(h2, 1) !== 1 || countLevel(h2, 2) !== 2 || countLevel(h2, 3) !== 2) {
  console.error('FAIL: 缩进层级数不对'); process.exit(1);
}

console.log('\n--- 双横线 tree 命令风格测试 ---');
const h3 = renderNoteMindmap(treeCmdExample);
// 校验节点名不带 "─ " 前缀
for (const name of ['根节点', '一级A', '一级B', '二级A1', '二级A2']) {
  if (!h3.includes(name)) { console.error('FAIL: 缺节点 ' + name); process.exit(1); }
}
if (/─[ ]*</.test(h3)) { console.error('FAIL: 节点名残留 ─ 前缀 → ' + h3); process.exit(1); }
if (countLevel(h3, 1) !== 1 || countLevel(h3, 2) !== 2 || countLevel(h3, 3) !== 2) {
  console.error('FAIL: 双横线层级数不对'); process.exit(1);
}
console.log('PASS: 双横线格式 1/2/2 层级正确，无 ─ 前缀残留');

console.log('\n--- 裸 ``` 自动识别测试 ---');
const bareIndent = `中心主题
  分支一
    子分支1
    子分支2
  分支二`;
const bareTreeChar = `0x22 DFS
├─ 概念
└─ 方法`;
const asciiTreeExample = `A(in=1)
  / \\
  B(in=2) C(in=6)
    / \\     \\
    D(3) E(4) F(7)
      /
      G(5)`;

const codeBlocks = [
  // 应识别为思维导图
  ['缩进树(裸```)', bareIndent, true],
  ['树形字符(裸```)', bareTreeChar, true],
  // 不应误判为思维导图
  ['JS代码', 'const a = 1;\nfunction f() {\n  return a;\n}', false],
  ['JSON数据', '{\n  "a": 1,\n  "b": [1, 2]\n}', false],
  ['单行文本', '只有一行', false],
  ['无缩进多行', '第一行\n第二行\n第三行', false],
  ['ASCII二叉树图', asciiTreeExample, false],
  ['ASCII目录树', 'src\n|-- main.js\n|-- utils\n    |-- helper.js', false],
];
let allOk = true;
for (const [name, code, expect] of codeBlocks) {
  const got = looksLikeMindmap(code);
  const ok = got === expect;
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + ' → ' + got + ' (期望 ' + expect + ')');
  if (!ok) allOk = false;
}
if (!allOk) { console.error('FAIL: 裸```识别不通过'); process.exit(1); }

console.log('\nALL_MINDMAP_DIAG_PASS');
