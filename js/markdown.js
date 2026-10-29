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

  const LATEX_ROW_ENV_RE = /\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix|smallmatrix|array|aligned|alignedat|gathered|cases|split)\}([\s\S]*?)\\end\{\1\}/g;
  const LATEX_ROW_COMMANDS = 'alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|frac|dfrac|tfrac|sqrt|text|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|mathfrak|boldsymbol|vec|bar|hat|dot|ddot|tilde|overline|underline|sum|prod|int|lim|vdots|cdots|ddots|dots';
  const LATEX_ROW_COMMAND_RE = new RegExp('(^|[^\\\\])\\\\\\\\(?=(?:' + LATEX_ROW_COMMANDS + ')\\b)', 'g');

  function repairLatexRows(body) {
    return String(body || '')
      // Common copy/typing mistake: a_{11}\a_{21} (one slash missing).
      .replace(/(^|[^\\])\\(?=[A-Za-z]\s*[_^])/g, (_, prefix) => prefix + '\\'.repeat(2))
      .replace(/(^|[^\\])\\(?=\s*[0-9])/g, (_, prefix) => prefix + '\\'.repeat(2))
      // Recover row breaks before commands that lost one slash in older builds,
      // e.g. "\\vdots" should be "\\\\vdots" inside a matrix.
      .replace(LATEX_ROW_COMMAND_RE, (_, prefix) => prefix + '\\'.repeat(3));
  }

  function normalizeLatex(formula) {
    // Never collapse every "\\command" globally: in arrays and matrices the
    // first two slashes are a real row break. Only repair high-confidence row
    // mistakes inside environments where \\ has structural meaning.
    return String(formula || '').replace(LATEX_ROW_ENV_RE, (_, env, body) =>
      '\\begin{' + env + '}' + repairLatexRows(body) + '\\end{' + env + '}'
    );
  }

  function isSafeUrl(value, kind) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    if (kind !== 'image' && /^#note=[A-Za-z0-9_%+.*-]+(?:(?:&heading=[A-Za-z0-9_%+.*-]+)|(?:&offset=\d+(?:&endOffset=\d+)?(?:&revision=[A-Za-z0-9_%+.*-]+)?))?$/.test(raw)) return true;
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
      let depth = 1;
      let fence = null;
      for (; nextLine < endLine; nextLine++) {
        if (state.sCount[nextLine] - state.blkIndent >= 4) continue;
        const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
        const line = state.src.slice(lineStart, state.eMarks[nextLine]);
        const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
          if (fenceMatch && fenceMatch[1][0] === fence.char && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = null;
          continue;
        }
        if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
          fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
          continue;
        }
        if (openPattern.test(line) || /^ {0,3}:::important(?:\s|$)/.test(line)) depth++;
        else if (closePattern.test(line) && --depth === 0) break;
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

    // Parse folds within the document's core pass so references and footnotes
    // are resolved once, including those in titles and nested fold bodies.
    md.core.ruler.before('inline', 'collapsible_inline', state => {
      if (state.inlineMode) return;
      const expand = (items, offset = 0) => {
        const result = [];
        items.forEach(token => {
          if (token.map && offset) token.map = token.map.map(line => line + offset);
          result.push(token);
          if (token.type !== 'collapsible_block') return;
          const title = new state.Token('inline', '', 0);
          title.content = token.meta.title;
          title.children = [];
          result.push(title);
          const body = [];
          md.block.parse(token.meta.body, md, state.env, body);
          for (const child of expand(body, token.map[0] + 1)) result.push(child);
          result.push(new state.Token('collapsible_end', '', 0));
        });
        return result;
      };
      state.tokens = expand(state.tokens);
    });
    md.core.ruler.push('collapsible_collect', state => {
      if (state.inlineMode) return;
      const stack = [], result = [];
      let target = result;
      state.tokens.forEach((token, index) => {
        if (token.type === 'collapsible_end') {
          target = stack.pop();
        } else if (token.type === 'collapsible_block') {
          target.push(token);
          token.meta.titleToken = state.tokens[index + 1];
          token.meta.bodyTokens = [];
          stack.push(target);
          target = token.meta.bodyTokens;
        } else if (index === 0 || state.tokens[index - 1].type !== 'collapsible_block') {
          target.push(token);
        }
      });
      state.tokens = result;
    });

    md.renderer.rules.collapsible_block = function (tokens, idx, options, env) {
      const meta = tokens[idx].meta || {};
      const title = md.renderer.renderInline(meta.titleToken?.children || [], options, env).trim();
      if (env.__readingPlan && meta.readingFoldId != null) {
        return '<details class="note-fold" data-fold-index="' + meta.readingFoldId + '" data-lazy-fold="' + meta.readingFoldId + '"' +
          (env.__readingPlan.foldStates[meta.readingFoldId] ? ' open' : '') + '><summary id="' + md.utils.escapeHtml(meta.readingTitleId) + '">' + title + '</summary>' +
          '<div class="note-fold-body">' + md.utils.escapeHtml(meta.body || '') + '</div></details>\n';
      }
      const body = md.renderer.render(meta.bodyTokens || [], options, env);
      return '<details class="note-fold"><summary>' + title + '</summary>' +
        '<div class="note-fold-body">' + body + '</div></details>\n';
    };
  }

  function installImportant(md) {
    // Inline syntax: =={label}content==. Escaped delimiters remain literal.
    md.inline.ruler.before('emphasis', 'note_important_inline', (state, silent) => {
      const match = /^==\{((?:\\.|[^}\\\n])*)\}((?:\\.|[^\\\n])*?)==/.exec(state.src.slice(state.pos));
      if (!match) return false;
      if (!silent) {
        const token = state.push('note_important_inline', 'span', 0);
        token.meta = { title: match[1].replace(/\\(.)/g, '$1'), body: match[2] };
      }
      state.pos += match[0].length;
      return true;
    });
    md.renderer.rules.note_important_inline = (tokens, index, options, env) => {
      const meta = tokens[index].meta;
      return '<span class="note-important note-important-inline"><span class="note-important-title">'
        + md.utils.escapeHtml(meta.title) + '</span><span class="note-important-body">'
        + md.renderInline(meta.body, env) + '</span></span>';
    };
    md.block.ruler.before('fence', 'note_important', (state, startLine, endLine, silent) => {
      const lineAt = line => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      const match = /^:::important(?:[ \t]+(.*))?$/.exec(lineAt(startLine));
      if (!match || state.sCount[startLine] - state.blkIndent >= 4) return false;
      let end = startLine + 1, depth = 1, fence = null;
      for (; end < endLine; end++) {
        const line = lineAt(end);
        if (state.sCount[end] - state.blkIndent >= 4) continue;
        const marker = /^(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
          if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
          continue;
        }
        if (marker) { fence = marker[1]; continue; }
        if (/^:::(?:important|fold)(?:\s|$)/.test(line)) depth++;
        else if (/^:::\s*$/.test(line) && --depth === 0) break;
      }
      if (end >= endLine) return false;
      if (silent) return true;
      const open = state.push('note_important_open', 'div', 1);
      open.block = true; open.map = [startLine, end + 1];
      open.attrSet('class', 'note-important note-important-block');
      const title = state.push('note_important_title', 'div', 0);
      title.content = (match[1] || '').replace(/\\(.)/g, '$1');
      const body = state.push('note_important_body_open', 'div', 1);
      body.attrSet('class', 'note-important-body'); body.block = true;
      const oldMax = state.lineMax, oldParent = state.parentType;
      state.lineMax = end; state.parentType = 'note_important';
      state.md.block.tokenize(state, startLine + 1, end);
      state.lineMax = oldMax; state.parentType = oldParent;
      state.push('note_important_body_close', 'div', -1).block = true;
      state.push('note_important_close', 'div', -1).block = true;
      state.line = end + 1;
      return true;
    }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
    md.renderer.rules.note_important_title = (tokens, index) => '<div class="note-important-title">'
      + md.utils.escapeHtml(tokens[index].content) + '</div>';
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

    // Rich editing needs a lossless fallback when CommonMark delimiters cannot
    // represent punctuation next to words. Accept only attribute-free format
    // tags and line breaks used by multiline table cells; arbitrary HTML
    // remains disabled and output is still sanitized.
    md.inline.ruler.before('html_inline', 'rich_format_tag', (state, silent) => {
      const match = state.src.slice(state.pos).match(/^(?:<\/?(?:strong|em|del)>|<br\s*\/?>)/i);
      if (!match) return false;
      if (!silent) state.push('html_inline', '', 0).content = match[0];
      state.pos += match[0].length;
      return true;
    });

    md.validateLink = value => isSafeUrl(value, 'link') || isSafeUrl(value, 'image');
    if (typeof footnote === 'function') md.use(footnote);
    installMath(md, katex);
    installTaskLists(md);
    installCollapsibleBlocks(md);
    installImportant(md);

    function mapSourceLines(tokens, offset = 0) {
      tokens.forEach(token => {
        if (token.meta?.bodyTokens) mapSourceLines(token.meta.bodyTokens, offset);
        if (!token.block || !token.map || !token.tag) return;
        token.attrSet('data-source-line', token.map[0] + offset);
        token.attrSet('data-source-end', token.map[1] + offset);
      });
    }
    md.core.ruler.push('source_lines', state => {
      if (state.env.__sourceMap) mapSourceLines(state.tokens, state.env.__sourceLineOffset || 0);
    });

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
      if (env.__readingPlan && tokens[idx].attrGet('id')) return self.renderToken(tokens, idx, options);
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
      if (href.startsWith('#note=')) tokens[idx].attrSet('class', 'note-jump-block');
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

    ['fence', 'code_block', 'collapsible_block', 'math_display'].forEach(name => {
      const render = md.renderer.rules[name];
      md.renderer.rules[name] = function(tokens, index, ...args) {
        let html = render.call(this, tokens, index, ...args);
        const start = tokens[index].attrGet('data-source-line');
        const end = tokens[index].attrGet('data-source-end');
        if (start != null) {
          html = html.replace(/^<(\w+)/, '<$1 data-source-line="' + start + '" data-source-end="' + end + '"');
          if (name === 'collapsible_block') html = html.replace(/<summary(?=[ >])/, '<summary data-source-line="' + start + '" data-source-end="' + (Number(start) + 1) + '"');
        }
        return html;
      };
    });

    function sanitize(html) {
      if (!purify || typeof purify.sanitize !== 'function') return html;
      return purify.sanitize(html, {
        USE_PROFILES: { html: true, svg: true, mathMl: true },
        ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'referrerpolicy', 'disabled', 'checked', 'aria-label', 'data-markdown-external'],
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
        ALLOW_UNKNOWN_PROTOCOLS: false
      });
    }

    function createReadingPlan(source, options = {}) {
      const env = { docId: 'md' + (++renderSequence), __sourceMap: true };
      const tokens = md.parse(String(source || ''), env);
      const blocks = [];
      let group = [], depth = 0;
      tokens.forEach(token => {
        group.push(token);
        depth += token.nesting;
        if (depth === 0) { blocks.push({ tokens: group }); group = []; }
      });
      if (group.length) blocks.push({ tokens: group });
      const headings = [], tocEntries = [], folds = new Map(), counts = Object.create(null);
      let foldIndex = 0;
      const visit = (items, blockIndex, ancestors = [], offset = 0) => {
        mapSourceLines(items, offset);
        items.forEach((token, index) => {
          if (token.type === 'heading_open') {
            const title = (items[index + 1]?.children || []).map(child => child.content || '').join('');
            const base = slugifyHeading(title), count = counts[base] || 0;
            counts[base] = count + 1;
            const id = count ? base + '-' + count : base;
            token.attrSet('id', id);
            const heading = { id, tagName: token.tag.toUpperCase(), textContent: title, blockIndex, ancestors };
            headings.push(heading);
            tocEntries.push(heading);
          }
          if (token.type === 'collapsible_block') {
            const id = foldIndex++;
            token.meta.readingFoldId = id;
            const base = 'note-fold-title-' + id, count = counts[base] || 0;
            counts[base] = count + 1;
            token.meta.readingTitleId = count ? base + '-' + count : base;
            const title = token.meta.titleToken;
            tocEntries.push({ id: token.meta.readingTitleId, tagName: 'SUMMARY',
              textContent: (title?.children || []).map(child => child.content || '').join(''),
              blockIndex, ancestors: [...ancestors, id] });
            const bodyTokens = token.meta.bodyTokens || [];
            folds.set(id, bodyTokens);
            visit(bodyTokens, blockIndex, [...ancestors, id]);
          }
        });
      };
      blocks.forEach((block, index) => {
        visit(block.tokens, index);
        block.text = block.tokens.map(token => token.type === 'inline' || token.type === 'fence' || token.type === 'code_block'
          ? token.content : token.type === 'collapsible_block' ? token.meta.title + '\n' + token.meta.body : '').filter(Boolean).join('\n');
      });
      const plan = { blocks, headings, tocEntries, foldStates: options.foldStates || {} };
      env.__readingPlan = plan;
      plan.renderBlock = index => sanitize(md.renderer.render(blocks[index].tokens, md.options, env));
      plan.renderFold = id => sanitize(md.renderer.render(folds.get(Number(id)) || [], md.options, env));
      return plan;
    }

    return {
      createReadingPlan,
      render: function (source, options) {
        const env = { docId: 'md' + (++renderSequence), __sourceMap: !!options?.sourceMap };
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

  function createReadingPlan(source, options) {
    return getRenderer()?.createReadingPlan(source, options) || null;
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
    createReadingPlan,
    normalizeLatex,
    isSafeUrl,
    slugifyHeading,
    installExternalLinkHandler
  };
});
