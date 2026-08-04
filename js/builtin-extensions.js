// ═══════════════════════════════════════════════════════════
//  内置扩展（自带插件）
//  快捷访问 / 音乐播放器 / 学习统计 三个官方功能以「内置插件」
//  形式由扩展系统管理，可随时启用 / 禁用 / 移除（恢复出厂）。
//  核心渲染函数仍由核心 JS 提供（renderLinks / renderMusic /
//  renderStats），扩展负责导航项与页面的注册与生命周期。
//  启用状态存 localStorage（study_ext_builtin_<id>）。
// ═══════════════════════════════════════════════════════════

window.BUILTIN_EXTENSIONS = [
  // ── 快捷访问 ──
  {
    id: 'builtin-links',
    meta: {
      id: 'builtin-links',
      name: '快捷访问',
      version: '1.0.0',
      type: 'plugin',
      description: '内置插件：收藏网页链接与应用，按分类管理快捷入口。',
      author: 'My Study Table',
      builtin: true
    },
    main: `
extAPI.registerNavItem({ id: 'links', icon: 'layout-grid', label: '快捷访问' });
extAPI.registerSection({
  id: 'links',
  html: [
    '<div class="card">',
    '  <div class="section-header">',
    '    <span class="section-title">快捷访问</span>',
    '    <button class="btn-toggle-input" id="btnLinkToggle" onclick="toggleLinkInput()">',
    '      <i data-lucide="plus" class="lucide-icon" style="width:16px;height:16px;"></i>新增',
    '    </button>',
    '  </div>',
    '  <div class="input-panel" id="linkInputPanel">',
    '    <div class="link-inputs">',
    '      <div class="input-row">',
    '        <input type="text" id="linkNameInput" placeholder="名称..." onkeydown="if(event.key===String.fromCharCode(13))document.getElementById(\\\'linkUrlInput\\\').focus()">',
    '      </div>',
    '      <div class="input-row">',
    '        <select id="linkTypeSelect" onchange="onLinkTypeChange()" style="width:120px;flex-shrink:0;">',
    '          <option value="link">🌐 网页链接</option>',
    '          <option value="app">📱 应用</option>',
    '        </select>',
    '        <input type="text" id="linkUrlInput" placeholder="网址 (URL) 或应用链接..." onkeydown="if(event.key===String.fromCharCode(13))document.getElementById(\\\'linkCatInput\\\').focus()">',
    '      </div>',
    '      <div class="input-row">',
    '        <input type="text" id="linkCatInput" placeholder="分类名称（如：学习 / 工具 / 娱乐）" list="catSuggestions" style="flex:1;">',
    '        <datalist id="catSuggestions"></datalist>',
    '        <button class="btn-add" onclick="addLink()">',
    '          <i data-lucide="plus" class="lucide-icon" style="width:16px;height:16px;"></i>添加',
    '        </button>',
    '      </div>',
    '    </div>',
    '  </div>',
    '  <div class="card-scroll">',
    '    <div class="links-panels" id="linksPanels"></div>',
    '    <div class="empty-state" id="linkEmpty">',
    '      <i data-lucide="link-2" class="lucide-icon" style="width:64px;height:64px;margin-bottom:12px;opacity:0.4;color:var(--text-secondary);display:block;margin-left:auto;margin-right:auto;"></i>',
    '      <p>暂无快捷入口，点击「新增」收藏吧 <i data-lucide="link" class="lucide-icon" style="width:14px;height:14px;vertical-align:middle;"></i></p>',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\\n'),
  render: function () { if (typeof renderLinks === 'function') renderLinks(); }
});
`
  },

  // ── 音乐播放器 ──
  {
    id: 'builtin-music',
    meta: {
      id: 'builtin-music',
      name: '音乐播放器',
      version: '1.0.0',
      type: 'plugin',
      description: '内置插件：本地音乐播放、播放列表与全局悬浮球控制。',
      author: 'My Study Table',
      builtin: true
    },
    main: `
extAPI.registerNavItem({ id: 'music', icon: 'music', label: '音乐' });
extAPI.registerSection({
  id: 'music',
  html: [
    '<div class="card">',
    '  <div class="section-header">',
    '    <span class="section-title"><i data-lucide="music" class="lucide-icon" style="width:16px;height:16px;vertical-align:middle;"></i> 音乐播放器</span>',
    '  </div>',
    '  <div class="card-scroll" id="musicContainer"></div>',
    '</div>'
  ].join('\\n'),
  render: function () { if (typeof renderMusic === 'function') renderMusic(); }
});
`
  },

  // ── 学习统计 ──
  {
    id: 'builtin-stats',
    meta: {
      id: 'builtin-stats',
      name: '学习统计',
      version: '1.0.0',
      type: 'plugin',
      description: '内置插件：最近 N 天学习数据概览（待办 / 计时 / 习惯 / AI 分析）。',
      author: 'My Study Table',
      builtin: true
    },
    main: `
extAPI.registerNavItem({ id: 'stats', icon: 'bar-chart-3', label: '统计' });
extAPI.registerSection({
  id: 'stats',
  html: '<div id="statsRoot"></div>',
  render: function () { if (typeof renderStats === 'function') renderStats(); }
});
`
  }
];
