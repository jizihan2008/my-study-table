// ═══════════════════════════════════════════════════════════════════
// 统一 Markdown 渲染器：CommonMark/GFM、KaTeX、脚注、任务列表、代码高亮与安全消毒
// 依赖（均在 index.html 中本地加载）：markdown-it、markdown-it-footnote、KaTeX、
// DOMPurify、Highlight.js。浏览器环境暴露 window.StudyMarkdown。
// ═══════════════════════════════════════════════════════════════════
(function (root, factory) {
  const api = factory(root || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.StudyMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
  const SAFE_IMAGE_PROTOCOLS = new Set(['https:']);
  const BARE_LATEX_RE = /\\(?:sin|cos|tan|log|ln|exp|lim|sup|inf|min|max|frac|sqrt|theta|Theta|Delta|alpha|beta|gamma|delta|lambda|pi|to|cdot|infty|partial|bar|hat|vec|dot|ddot|tilde|overline|underbrace|mathbb)(?![A-Za-z])(?:\[[^\]\n]*\])?(?:\{[^{}\n]*\}){0,2}(?:[_^](?:\{[^{}\n]*\}|[A-Za-z0-9]))?/g;
  let singleton = null;

  function normalizeLatex(formula) {
    return String(formula || '').replace(/\\\\(?=[A-Za-z])/g, '\\');
  }

  function isSafeUrl(value, kind) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (kind !== 'image' && raw.startsWith('#')) return /^#[A-Za-z0-9_\-:.\u00A0-\uFFFF]+$/.test(raw);
    try {
      const parsed = new URL(raw);
      return (kind === 'image' ? SAFE_IMAGE_PROTOCOLS : SAFE_LINK_PROTOCOLS).has(parsed.protocol.toLowerCase());
    } catch (_) {
      return false;
    }
  }

  function slugifyHeading(value) {
    const slug = String(value || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[\s]+/g, '-')
      .replace(/[^\p{Letter}\p{Number}\-_:.\u4e00-\u9fff]/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return slug || 'section';
  }

  function findClosingDelimiter(src, delimiter, from) {
    let pos = from;
    while (pos < src.length) {
      const found = src.indexOf(delimiter, pos);
      if (found < 0) return -1;
      let slashCount = 0;
      for (let i = found - 1; i >= 0 && src[i] === '\\'; i--) slashCount++;
      if (slashCount % 2 === 0) return found;
      pos = found + delimiter.length;
    }
    return -1;
  }

  function installMath(md, katex) {
    function renderFormula(content, displayMode) {
      if (!katex || typeof katex.renderToString !== 'function') {
        return md.utils.escapeHtml((displayMode ? '$$' : '$') + content + (displayMode ? '$$' : '$'));
      }
      try {
        return katex.renderToString(normalizeLatex(content), {
          displayMode,
          throwOnError: false,
          trust: false,
          strict: 'warn',
          output: 'htmlAndMathml'
        });
      } catch (_) {
        return md.utils.escapeHtml(content);
      }
    }

    md.renderer.rules.math_inline = (tokens, idx) => renderFormula(tokens[idx].content, false);
    md.renderer.rules.math_display = (tokens, idx) => {
      const tag = tokens[idx].block ? 'div' : 'span';
      return '<' + tag + ' class="markdown-math-display">' + renderFormula(tokens[idx].content, true) + '</' + tag + '>' + (tokens[idx].block ? '\n' : '');
    };

    md.inline.ruler.before('escape', 'math_inline', function (state, silent) {
      const start = state.pos;
      const src = state.src;
      let open = '';
      let close = '';
      let display = false;

      if (src.startsWith('\\(', start)) { open = '\\('; close = '\\)'; }
      else if (src.startsWith('\\[', start)) { open = '\\['; close = '\\]'; display = true; }
      else if (src.startsWith('$$', start)) { open = '$$'; close = '$$'; display = true; }
      else if (src[start] === '$') {
        if (/\s/.test(src[start + 1] || '')) return false;
        open = '$'; close = '$';
      } else return false;

      const end = findClosingDelimiter(src, close, start + open.length);
      if (end < 0 || end === start + open.length) return false;
      if (open === '$' && /\s/.test(src[end - 1] || '')) return false;
      if (silent) return false;

      const token = state.push(display ? 'math_display' : 'math_inline', 'math', 0);
      token.content = src.slice(start + open.length, end).trim();
      state.pos = end + close.length;
      return true;
    });

    md.block.ruler.before('fence', 'math_block', function (state, startLine, endLine, silent) {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const max = state.eMarks[startLine];
      const first = state.src.slice(start, max);
      const marker = first.startsWith('$$') ? '$$' : (first.startsWith('\\[') ? '\\[' : '');
      if (!marker) return false;
      const close = marker === '$$' ? '$$' : '\\]';
      let content = first.slice(marker.length);
      let closePos = findClosingDelimiter(content, close, 0);
      let nextLine = startLine + 1;

      while (closePos < 0 && nextLine < endLine) {
        const line = state.src.slice(state.bMarks[nextLine], state.eMarks[nextLine]);
        content += (content ? '\n' : '') + line;
        closePos = findClosingDelimiter(content, close, 0);
        nextLine++;
      }
      if (closePos < 0) return false;
      if (content.slice(closePos + close.length).trim()) return false;
      if (silent) return true;

      const token = state.push('math_display', 'math', 0);
      token.block = true;
      token.map = [startLine, nextLine];
      token.content = content.slice(0, closePos).trim();
      state.line = nextLine;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    // 兼容旧笔记中没有定界符的常见 LaTeX 命令；只处理 Markdown 已解析出的纯文本 token，
    // 因而不会修改行内代码、围栏代码、链接目标等内容。
    md.core.ruler.after('inline', 'bare_latex', function (state) {
      for (const blockToken of state.tokens) {
        if (blockToken.type !== 'inline' || !Array.isArray(blockToken.children)) continue;
        const nextChildren = [];
        for (const child of blockToken.children) {
          if (child.type !== 'text' || !child.content.includes('\\')) {
            nextChildren.push(child);
            continue;
          }
          let last = 0;
          BARE_LATEX_RE.lastIndex = 0;
          let match;
          while ((match = BARE_LATEX_RE.exec(child.content))) {
            if (match.index > last) {
              const text = new state.Token('text', '', 0);
              text.content = child.content.slice(last, match.index);
              nextChildren.push(text);
            }
            const math = new state.Token('math_inline', 'math', 0);
            math.content = match[0];
            nextChildren.push(math);
            last = match.index + match[0].length;
          }
          if (last === 0) nextChildren.push(child);
          else if (last < child.content.length) {
            const text = new state.Token('text', '', 0);
            text.content = child.content.slice(last);
            nextChildren.push(text);
          }
        }
        blockToken.children = nextChildren;
      }
    });
  }

  function installTaskLists(md) {
    md.core.ruler.after('inline', 'task_lists', function (state) {
      for (let i = 2; i < state.tokens.length; i++) {
        const token = state.tokens[i];
        if (token.type !== 'inline' || state.tokens[i - 1].type !== 'paragraph_open' || state.tokens[i - 2].type !== 'list_item_open') continue;
        const first = token.children && token.children[0];
        if (!first || first.type !== 'text') continue;
        const match = /^\[([ xX])\]\s+/.exec(first.content);
        if (!match) continue;

        first.content = first.content.slice(match[0].length);
        const checkbox = new state.Token('html_inline', '', 0);
        checkbox.content = '<input class="markdown-task-checkbox" type="checkbox" disabled' + (match[1].toLowerCase() === 'x' ? ' checked' : '') + ' aria-label="任务状态"> ';
        token.children.unshift(checkbox);
        if (!String(state.tokens[i - 2].attrGet('class') || '').split(/\s+/).includes('markdown-task-item')) {
          state.tokens[i - 2].attrJoin('class', 'markdown-task-item');
        }
        let nestedListDepth = 0;
        for (let j = i - 3; j >= 0; j--) {
          if (state.tokens[j].type === 'bullet_list_close') {
            nestedListDepth++;
            continue;
          }
          if (state.tokens[j].type === 'bullet_list_open') {
            if (nestedListDepth > 0) {
              nestedListDepth--;
              continue;
            }
            if (!String(state.tokens[j].attrGet('class') || '').split(/\s+/).includes('markdown-task-list')) {
              state.tokens[j].attrJoin('class', 'markdown-task-list');
            }
            break;
          }
        }
      }
    });
  }

  function installCollapsibleBlocks(md) {
    const openPattern = /^ {0,3}:::fold(?:[ \t]+(.*?))?[ \t]*$/;
    const closePattern = /^ {0,3}:::[ \t]*$/;

    md.block.ruler.before('fence', 'collapsible_block', function (state, startLine, endLine, silent) {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const firstLine = state.src.slice(start, state.eMarks[startLine]);
      const match = openPattern.exec(firstLine);
      if (!match) return false;

      let nextLine = startLine + 1;
      for (; nextLine < endLine; nextLine++) {
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const line = state.src.slice(lineStart, state.eMarks[nextLine]);
        if (closePattern.test(line)) break;
      }
      if (nextLine >= endLine) return false;
      if (silent) return true;

      const token = state.push('collapsible_block', 'details', 0);
      token.block = true;
      token.map = [startLine, nextLine + 1];
      token.meta = {
        title: String(match[1] || '').trim() || '折叠内容',
        body: nextLine > startLine + 1
          ? state.src.slice(state.bMarks[startLine + 1], state.bMarks[nextLine]).replace(/\n$/, '')
          : ''
      };
      state.line = nextLine + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

    md.renderer.rules.collapsible_block = function (tokens, idx, options, env) {
      const meta = tokens[idx].meta || {};
      const title = md.renderInline(meta.title || '折叠内容', env).trim();
      const body = md.render(meta.body || '', env);
      return '<details class="note-fold"><summary>' + title + '</summary>' +
        '<div class="note-fold-body">' + body + '</div></details>\n';
    };
  }

  function createRenderer(deps) {
    const markdownit = deps && deps.markdownit;
    if (typeof markdownit !== 'function') return null;
    const footnote = deps.footnote;
    const hljs = deps.hljs;
    const katex = deps.katex;
    const purify = deps.DOMPurify;
    let renderSequence = 0;

    const md = markdownit({
      html: false,
      linkify: true,
      typographer: false,
      breaks: true,
      langPrefix: 'language-',
      highlight: function (code, language) {
        const lang = String(language || '').trim().toLowerCase();
        if (hljs && lang && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang)) {
          try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch (_) { /* fall through */ }
        }
        return md.utils.escapeHtml(code);
      }
    });

    md.validateLink = value => isSafeUrl(value, 'link') || isSafeUrl(value, 'image');
    if (typeof footnote === 'function') md.use(footnote);
    installMath(md, katex);
    installTaskLists(md);
    installCollapsibleBlocks(md);

    const defaultFence = md.renderer.rules.fence.bind(md.renderer.rules);
    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
      const token = tokens[idx];
      const language = String(token.info || '').trim().split(/\s+/)[0].toLowerCase();
      // 思维导图必须由作者显式声明为 ```mindmap；无语言代码块一律按普通代码渲染，
      // 避免把缩进文本、目录树或 AI 输出的示例代码误判成导图。
      if (language === 'mindmap' && typeof root.renderNoteMindmap === 'function') {
        return root.renderNoteMindmap(md.utils.escapeHtml(token.content));
      }
      const html = defaultFence(tokens, idx, options, env, self);
      if (hljs && language && typeof hljs.getLanguage === 'function' && hljs.getLanguage(language)) {
        return html.replace(/<code class="([^"]*)">/, '<code class="$1 hljs">');
      }
      return html;
    };

    md.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
      const inline = tokens[idx + 1];
      const title = inline && Array.isArray(inline.children)
        ? inline.children.map(child => child.content || '').join('')
        : '';
      const base = slugifyHeading(title);
      const counts = env.__headingSlugCounts || (env.__headingSlugCounts = Object.create(null));
      const count = counts[base] || 0;
      counts[base] = count + 1;
      tokens[idx].attrSet('id', count ? base + '-' + count : base);
      return self.renderToken(tokens, idx, options);
    };

    const defaultLinkOpen = md.renderer.rules.link_open || function (tokens, idx, options, env, self) { return self.renderToken(tokens, idx, options); };
    md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
      const hrefIndex = tokens[idx].attrIndex('href');
      const href = hrefIndex >= 0 ? tokens[idx].attrs[hrefIndex][1] : '';
      if (!isSafeUrl(href, 'link')) {
        if (hrefIndex >= 0) tokens[idx].attrs.splice(hrefIndex, 1);
        return defaultLinkOpen(tokens, idx, options, env, self);
      }
      if (!href.startsWith('#')) {
        tokens[idx].attrSet('target', '_blank');
        tokens[idx].attrSet('rel', 'noopener noreferrer');
        tokens[idx].attrSet('data-markdown-external', 'true');
      }
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    md.renderer.rules.image = function (tokens, idx) {
      const token = tokens[idx];
      const src = token.attrGet('src') || '';
      if (!isSafeUrl(src, 'image')) return md.utils.escapeHtml(token.content || token.attrGet('alt') || '');
      const alt = token.content || token.attrGet('alt') || '';
      const title = token.attrGet('title');
      return '<img src="' + md.utils.escapeHtml(src) + '" alt="' + md.utils.escapeHtml(alt) + '"' +
        (title ? ' title="' + md.utils.escapeHtml(title) + '"' : '') +
        ' loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    };

    function sanitize(html) {
      if (!purify || typeof purify.sanitize !== 'function') return html;
      return purify.sanitize(html, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'referrerpolicy', 'disabled', 'checked', 'aria-label', 'data-markdown-external'],
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
        ALLOW_UNKNOWN_PROTOCOLS: false
      });
    }

    return {
      render: function (source, options) {
        const env = { docId: 'md' + (++renderSequence) };
        let html = md.render(String(source || ''), env);
        if (options && typeof options.transformHtml === 'function') html = options.transformHtml(html);
        return sanitize(html);
      },
      renderInline: function (source) {
        return sanitize(md.renderInline(String(source || ''), { docId: 'md' + (++renderSequence) }));
      },
      raw: md
    };
  }

  function getRenderer() {
    if (!singleton) {
      // 浏览器端缺少消毒器时安全降级为纯文本；不能在无最终消毒层时渲染扩展 HTML。
      if (root.document && (!root.DOMPurify || typeof root.DOMPurify.sanitize !== 'function')) return null;
      singleton = createRenderer({
        markdownit: root.markdownit,
        footnote: root.markdownitFootnote,
        hljs: root.hljs,
        katex: root.katex,
        DOMPurify: root.DOMPurify
      });
    }
    return singleton;
  }

  function render(source, options) {
    const renderer = getRenderer();
    if (renderer) return renderer.render(source, options);
    const text = String(source || '');
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  function renderInline(source) {
    const renderer = getRenderer();
    return renderer ? renderer.renderInline(source) : render(source);
  }

  function installExternalLinkHandler() {
    if (!root.document || root.__studyMarkdownLinkHandlerInstalled) return;
    root.__studyMarkdownLinkHandlerInstalled = true;
    root.document.addEventListener('click', function (event) {
      const anchor = event.target && event.target.closest ? event.target.closest('a[data-markdown-external="true"]') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (!isSafeUrl(href, 'link')) {
        event.preventDefault();
        return;
      }
      if (root.electronAPI && typeof root.electronAPI.openExternal === 'function') {
        event.preventDefault();
        root.electronAPI.openExternal(href).catch(function () {});
      }
    });
  }

  installExternalLinkHandler();

  return {
    render,
    renderInline,
    createRenderer,
    isSafeUrl,
    slugifyHeading,
    installExternalLinkHandler
  };
});
