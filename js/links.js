// ═══════════ Links: Category ═══════════
function getAllCategories() {
  const cats = new Set(links.map(l => l.category || '默认分类'));
  return Array.from(cats).sort();
}

function updateCatSuggestions() {
  const datalist = document.getElementById('catSuggestions');
  datalist.innerHTML = getAllCategories().map(c => `<option value="${escapeAttr(c)}">`).join('');
}

function groupLinksByCategory() {
  const groups = {};
  links.forEach(l => {
    const cat = l.category || '默认分类';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(l);
  });
  return groups;
}

function addLink() {
  const type = document.getElementById('linkTypeSelect').value;
  const name = document.getElementById('linkNameInput').value.trim();
  let url = document.getElementById('linkUrlInput').value.trim();
  const category = document.getElementById('linkCatInput').value.trim() || '默认分类';
  if (!name) return;
  if (type === 'link' && !url) return;
  // 网页链接自动补充 https://，应用链接保持原样
  if (type === 'link' && url && !/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  links.unshift({ id: genId(), name, url, category, type });
  saveData('study_links_v3', links);
  document.getElementById('linkNameInput').value = '';
  document.getElementById('linkUrlInput').value = '';
  document.getElementById('linkCatInput').value = '';
  document.getElementById('linkTypeSelect').value = 'link';
  onLinkTypeChange();
  document.getElementById('linkNameInput').focus();
  renderLinks();
}

function deleteLink(id, e) {
  e.stopPropagation();
  if (typeof moveToTrash === 'function') {
    const l = links.find(l => l.id === id);
    if (l) moveToTrash('links', l);
  } else {
    links = links.filter(l => l.id !== id);
    saveData('study_links_v3', links);
    renderLinks();
  }
}

function archiveLink(id) {
  if (typeof moveToArchive === 'function') {
    const l = links.find(l => l.id === id);
    if (l) moveToArchive('links', l);
  }
}

function openLink(url, type) {
  if (!url) return;
  // 在 Electron 中使用系统默认浏览器（Edge）打开
  if (isElectronEnv) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function renderLinkCards(linkList) {
  return linkList.map(l => {
    let letter = l.name.charAt(0).toUpperCase();
    if (l.type === 'link' && l.url) {
      try { letter = new URL(l.url).hostname.replace('www.', '').charAt(0).toUpperCase(); } catch {}
    }
    const isApp = l.type === 'app';
    return `
      <div class="link-card" onclick="openLink('${escapeAttr(l.url || '')}', '${l.type}')">
        <div class="link-card-icon${isApp ? ' app-icon' : ''}">${letter}</div>
        <div class="link-card-name">${escapeHtml(l.name)}</div>
        ${l.url ? `<div class="link-card-url">${escapeHtml(l.url)}</div>` : ''}
        <span class="link-card-type-badge ${isApp ? 'app' : 'link'}">${isApp ? '应用' : '链接'}</span>
      </div>
    `;
  }).join('');
}

function renderLinks() {
  const pc = document.getElementById('linksPanels');
  const empty = document.getElementById('linkEmpty');
  updateCatSuggestions();
  if (links.length === 0) { pc.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  const groups = groupLinksByCategory();
  // Use saved category order, or default to sorted
  const savedOrder = loadCategoryOrder();
  const cats = savedOrder.length > 0
    ? savedOrder.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !savedOrder.includes(c)))
    : Object.keys(groups).sort();
  const colors = ['#4f6ef7','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#f97316'];
  pc.innerHTML = cats.map((cat, idx) => `
    <div class="cat-section">
      <div class="cat-section-header">
        <div class="cat-section-icon" style="background:${colors[idx%8]}15; color:${colors[idx%8]};">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>
        </div>
        <span class="cat-section-name">${escapeHtml(cat)}</span>
        <span class="cat-section-count">${groups[cat].length} 个</span>
        <div class="cat-section-right">
          <div class="cat-section-actions">
            ${idx > 0 ? `<button class="cat-move-btn" onclick="event.stopPropagation();moveCategoryToTop('${escapeAttr(cat)}')" title="移到首位"><i data-lucide="chevrons-up" class="lucide-icon" style="width:12px;height:12px;"></i></button>` : ''}
            ${idx > 0 ? `<button class="cat-move-btn" onclick="event.stopPropagation();moveCategory('${escapeAttr(cat)}', -1)" title="上移"><i data-lucide="chevron-up" class="lucide-icon" style="width:12px;height:12px;"></i></button>` : ''}
            ${idx < cats.length - 1 ? `<button class="cat-move-btn" onclick="event.stopPropagation();moveCategory('${escapeAttr(cat)}', 1)" title="下移"><i data-lucide="chevron-down" class="lucide-icon" style="width:12px;height:12px;"></i></button>` : ''}
            ${idx < cats.length - 1 ? `<button class="cat-move-btn" onclick="event.stopPropagation();moveCategoryToBottom('${escapeAttr(cat)}')" title="移到末位"><i data-lucide="chevrons-down" class="lucide-icon" style="width:12px;height:12px;"></i></button>` : ''}
          </div>
          <i data-lucide="chevron-down" class="lucide-icon cat-toggle" style="width:16px;height:16px;color:var(--text-secondary);flex-shrink:0;"></i>
        </div>
      </div>
      <div class="cat-section-body"><div class="link-grid">${renderLinkCards(groups[cat])}</div></div>
    </div>
  `).join('');
  // Re-apply collapsed state after DOM rebuild
  setTimeout(function() { applyCollapsedState(); if (typeof lucide !== 'undefined') lucide.createIcons(); }, 0);
}

// ═══════════ Category Order Management ═══════════
const CAT_ORDER_KEY = 'study_link_category_order';

function loadCategoryOrder() {
  try { return JSON.parse(localStorage.getItem(CAT_ORDER_KEY) || '[]'); }
  catch { return []; }
}

function saveCategoryOrder(order) {
  localStorage.setItem(CAT_ORDER_KEY, JSON.stringify(order));
}

function moveCategory(cat, direction) {
  const groups = groupLinksByCategory();
  const savedOrder = loadCategoryOrder();
  let cats = savedOrder.length > 0
    ? savedOrder.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !savedOrder.includes(c)))
    : Object.keys(groups).sort();
  const idx = cats.indexOf(cat);
  if (idx === -1) return;
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= cats.length) return;
  // Swap
  [cats[idx], cats[newIdx]] = [cats[newIdx], cats[idx]];
  saveCategoryOrder(cats);
  renderLinks();
}

function moveCategoryToTop(cat) {
  const groups = groupLinksByCategory();
  const savedOrder = loadCategoryOrder();
  let cats = savedOrder.length > 0
    ? savedOrder.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !savedOrder.includes(c)))
    : Object.keys(groups).sort();
  const idx = cats.indexOf(cat);
  if (idx <= 0) return;
  cats.splice(idx, 1);
  cats.unshift(cat);
  saveCategoryOrder(cats);
  renderLinks();
}

function moveCategoryToBottom(cat) {
  const groups = groupLinksByCategory();
  const savedOrder = loadCategoryOrder();
  let cats = savedOrder.length > 0
    ? savedOrder.filter(c => groups[c]).concat(Object.keys(groups).filter(c => !savedOrder.includes(c)))
    : Object.keys(groups).sort();
  const idx = cats.indexOf(cat);
  if (idx === -1 || idx >= cats.length - 1) return;
  cats.splice(idx, 1);
  cats.push(cat);
  saveCategoryOrder(cats);
  renderLinks();
}

// ═══════════ Category Click: Collapse / Expand ═══════════
var collapsedCats = (function() {
  try { return new Set(JSON.parse(localStorage.getItem('study_links_collapsed_cats') || '[]')); }
  catch { return new Set(); }
})();
function saveCollapsedCats() {
  localStorage.setItem('study_links_collapsed_cats', JSON.stringify(Array.from(collapsedCats)));
}

function applyCollapsedState() {
  document.querySelectorAll('.cat-section').forEach(function(el) {
    var name = el.querySelector('.cat-section-name');
    if (name && collapsedCats.has(name.textContent)) {
      el.classList.add('collapsed');
    } else {
      el.classList.remove('collapsed');
    }
  });
}

// Delegate click on category headers
var linksPanelsEl = document.getElementById('linksPanels');
if (linksPanelsEl) {
  linksPanelsEl.addEventListener('click', function(e) {
    var header = e.target.closest('.cat-section-header');
    if (!header) return;
    if (e.target.closest('.cat-move-btn')) return;
    var section = header.closest('.cat-section');
    if (!section) return;
    var nameEl = section.querySelector('.cat-section-name');
    if (!nameEl) return;
    var name = nameEl.textContent;
    if (collapsedCats.has(name)) {
      collapsedCats.delete(name);
      section.classList.remove('collapsed');
    } else {
      collapsedCats.add(name);
      section.classList.add('collapsed');
    }
    saveCollapsedCats();
  });
}

// ═══════════ Links: Context Menu ═══════════
var linkCtxTargetId = null;

function showLinkContextMenu(x, y, id) {
  var menu = document.getElementById('linkContextMenu');
  if (!menu) return;
  linkCtxTargetId = id;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('visible');
  var rect = menu.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function closeLinkContextMenu() {
  var menu = document.getElementById('linkContextMenu');
  if (menu) menu.classList.remove('visible');
  linkCtxTargetId = null;
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#linkContextMenu')) closeLinkContextMenu();
});

if (linksPanelsEl) {
  linksPanelsEl.addEventListener('contextmenu', function(e) {
    var card = e.target.closest('.link-card');
    if (!card) return;
    var m = card.getAttribute('onclick');
    if (!m) return;
    var urlMatch = m.match(/openLink\('([^']*)'/);
    if (!urlMatch) return;
    var url = urlMatch[1];
    var l = links.find(function(li) { return li.url === url || (!li.url && url === ''); });
    if (!l) return;
    e.preventDefault();
    showLinkContextMenu(e.clientX, e.clientY, l.id);
  });
}

function linkCtxOpen() {
  var id = linkCtxTargetId;
  closeLinkContextMenu();
  if (id == null) return;
  var l = links.find(function(li) { return li.id === id; });
  if (l) openLink(l.url, l.type);
}
function linkCtxEdit() { var id = linkCtxTargetId; closeLinkContextMenu(); if (id != null) openEditLinkModal(id); }
function linkCtxArchive() { var id = linkCtxTargetId; closeLinkContextMenu(); if (id != null) archiveLink(id); }
function linkCtxDelete() {
  var id = linkCtxTargetId;
  closeLinkContextMenu();
  if (id != null) { deleteLink(id, { stopPropagation: function(){} }); }
}

// ═══════════ Category: Context Menu ═══════════
var catCtxTargetName = null;

function showCatContextMenu(x, y, catName) {
  var menu = document.getElementById('catContextMenu');
  if (!menu) return;
  catCtxTargetName = catName;
  // Toggle collapse item label
  var toggleItem = document.getElementById('catCtxToggleCollapse');
  if (toggleItem) {
    toggleItem.textContent = collapsedCats.has(catName) ? '展开' : '折叠';
  }
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.classList.add('visible');
  var rect = menu.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  if (rect.right > vw) menu.style.left = Math.max(0, vw - rect.width - 6) + 'px';
  if (rect.bottom > vh) menu.style.top = Math.max(0, vh - rect.height - 6) + 'px';
  if (typeof lucide !== 'undefined') setTimeout(function() { lucide.createIcons(); }, 0);
}

function closeCatContextMenu() {
  var menu = document.getElementById('catContextMenu');
  if (menu) menu.classList.remove('visible');
  catCtxTargetName = null;
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('#catContextMenu')) closeCatContextMenu();
});

if (linksPanelsEl) {
  linksPanelsEl.addEventListener('contextmenu', function(e) {
    // Check if this is on a category header (not on a link card)
    var header = e.target.closest('.cat-section-header');
    if (!header) return;
    e.preventDefault();
    var nameEl = header.querySelector('.cat-section-name');
    if (!nameEl) return;
    showCatContextMenu(e.clientX, e.clientY, nameEl.textContent);
  });
}

function catCtxToggleCollapse() {
  var name = catCtxTargetName;
  closeCatContextMenu();
  if (!name) return;
  if (collapsedCats.has(name)) {
    collapsedCats.delete(name);
  } else {
    collapsedCats.add(name);
  }
  saveCollapsedCats();
  applyCollapsedState();
}

function catCtxMoveTop() {
  var name = catCtxTargetName;
  closeCatContextMenu();
  if (name) moveCategoryToTop(name);
}
function catCtxMoveUp() {
  var name = catCtxTargetName;
  closeCatContextMenu();
  if (name) moveCategory(name, -1);
}
function catCtxMoveDown() {
  var name = catCtxTargetName;
  closeCatContextMenu();
  if (name) moveCategory(name, 1);
}
function catCtxMoveBottom() {
  var name = catCtxTargetName;
  closeCatContextMenu();
  if (name) moveCategoryToBottom(name);
}

// Apply collapsed state after initial render
setTimeout(function() { applyCollapsedState(); }, 100);
