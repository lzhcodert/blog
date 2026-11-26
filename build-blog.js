const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOCAL_MD_DIR = path.join(ROOT, 'new_ai_blog');
const FALLBACK_MD_DIR = 'D:/blog/最新博客归档目录/new_ai_blog';
const MD_DIR = process.env.MD_DIR || (fs.existsSync(LOCAL_MD_DIR) ? LOCAL_MD_DIR : FALLBACK_MD_DIR);
const TEMPLATE = path.join(ROOT, 'tree-blog-homepage.html');
const OUT_DIR = path.join(ROOT, 'dist');
const POST_DIR = path.join(OUT_DIR, 'posts');

// 分类不写死：保留「技术」作为基础分类，其余从文章的 category 动态生成
const BASE_CAT = { id: 'tech', n: '技术', color: '#1d9e75' };
const CAT_PALETTE = ['#007aff', '#ff9500', '#af52de', '#5ac8fa', '#ff2d55', '#5856d6', '#ff3b30'];
let CATS = [Object.assign({}, BASE_CAT)];
let COLORS = { '技术': BASE_CAT.color };

function catHash(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) >>> 0;
  return h;
}

// 每次构建时按当前文章重建分类表：技术常驻，其余分类有文章才出现
function buildCats(posts) {
  const names = [];
  posts.forEach(function(p) {
    if (p.category && names.indexOf(p.category) < 0) names.push(p.category);
  });
  names.sort();
  const dynamicNames = names.filter(function(name) { return name !== BASE_CAT.n; });
  CATS = [Object.assign({}, BASE_CAT)];
  COLORS = { '技术': BASE_CAT.color };
  // 按排序顺序依次取色，避免哈希取模导致不同分类撞色
  dynamicNames.forEach(function(name, index) {
    const h = catHash(name);
    const color = CAT_PALETTE[index % CAT_PALETTE.length];
    CATS.push({ id: 'c' + h.toString(36), n: name, color: color });
    COLORS[name] = color;
  });
}

function catId(name) {
  const byName = CATS.filter(function(c) { return c.n === name; })[0];
  return byName ? byName.id : BASE_CAT.id;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function splitList(value) {
  return String(value || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function slugify(name, index) {
  const ascii = String(name).toLowerCase().replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (ascii || 'post') + '-' + index;
}

function parseMarkdown(file, index) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const meta = {};
  match[1].split(/\r?\n/).forEach(function(line) {
    const i = line.indexOf(':');
    if (i < 0) return;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  });

  if (!meta.title || !meta.date || !meta.category) return null;

  let body = match[2].trim();
  const firstLine = body.split(/\r?\n/)[0].trim();
  if (firstLine === meta.title) {
    const nl = body.indexOf('\n');
    body = (nl < 0 ? '' : body.slice(nl + 1)).trim();
  }

  const minutes = Math.max(1, Math.round(body.replace(/\s/g, '').length / 300));
  const parts = meta.date.split('-');

  return {
    slug: slugify(path.basename(file), index),
    title: meta.title,
    date: meta.date,
    monthLabel: parts[0] + ' 年 ' + parts[1] + ' 月',
    shortDate: parts[1] + '.' + parts[2],
    category: meta.category,
    summary: meta.summary || '',
    tags: splitList(meta.tags),
    embeds: splitList(meta.embed),
    embedLabels: splitList(meta['embed-label']),
    embedTitle: meta['embed-title'] || '相关图表',
    embedHeight: parseInt(meta['embed-height'], 10) || 0,
    minutes: minutes,
    body: body
  };
}

/* ---------- 极简 Markdown 渲染（无第三方依赖） ---------- */
function inlineMd(text) {
  let s = escapeHtml(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, function(_, c) {
    codes.push(c);
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, t, u) {
    return '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>';
  });
  s = s.replace(/\u0000C(\d+)\u0000/g, function(_, i) {
    return '<code>' + codes[Number(i)] + '</code>';
  });
  return s;
}

function splitTableRow(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function(s) { return s.trim(); });
}

function isBlockStart(t) {
  return /^```/.test(t) || /^#{1,6}\s/.test(t) || /^\|/.test(t) ||
    /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t) || /^>\s?/.test(t) ||
    /^(---|\*\*\*|___)$/.test(t);
}

function renderMarkdown(md, headings) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }

    if (/^```/.test(t)) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }

    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = h[1].length;
      const raw = h[2];
      const inner = inlineMd(raw);
      if ((n === 2 || n === 3) && headings) {
        const id = 'sec-' + (headings.length + 1);
        const plain = raw.replace(/[*_`~]/g, '').trim();
        headings.push({ id: id, text: plain, level: n });
        out.push('<h' + n + ' id="' + id + '">' + inner + '</h' + n + '>');
      } else {
        out.push('<h' + n + '>' + inner + '</h' + n + '>');
      }
      i++;
      continue;
    }

    if (/^\|/.test(t) && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const header = splitTableRow(t);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        rows.push(splitTableRow(lines[i].trim()));
        i++;
      }
      let html = '<table><thead><tr>' + header.map(function(c) {
        return '<th>' + inlineMd(c) + '</th>';
      }).join('') + '</tr></thead><tbody>';
      rows.forEach(function(r) {
        html += '<tr>' + r.map(function(c) { return '<td>' + inlineMd(c) + '</td>'; }).join('') + '</tr>';
      });
      out.push(html + '</tbody></table>');
      continue;
    }

    if (/^[-*]\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(inlineMd(lines[i].trim().replace(/^[-*]\s+/, '')));
        i++;
      }
      out.push('<ul>' + items.map(function(x) { return '<li>' + x + '</li>'; }).join('') + '</ul>');
      continue;
    }

    if (/^\d+\.\s+/.test(t)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(inlineMd(lines[i].trim().replace(/^\d+\.\s+/, '')));
        i++;
      }
      out.push('<ol>' + items.map(function(x) { return '<li>' + x + '</li>'; }).join('') + '</ol>');
      continue;
    }

    if (/^>\s?/.test(t)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + inlineMd(buf.join(' ')) + '</blockquote>');
      continue;
    }

    if (/^(---|\*\*\*|___)$/.test(t)) { out.push('<hr>'); i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i].trim())) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push('<p>' + inlineMd(para.join(' ')) + '</p>');
    else i++;
  }
  return out.join('\n');
}

const DETAIL_CSS = `
.back{font-size:13px;color:var(--blue);text-decoration:none}
.detail-wrap{display:flex;gap:40px;align-items:flex-start;max-width:1240px;margin:0 auto;padding:28px 0 64px}
.article{flex:1;min-width:0;max-width:820px;margin:0;padding:0}
.article-meta-top{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.article-title{font-size:29px;line-height:1.3;letter-spacing:-.6px;margin:12px 0 10px}
.article-meta{font-size:12px;color:var(--faint);margin-bottom:26px;padding-bottom:20px;border-bottom:.5px solid var(--line)}
.article-body{font-size:15px;line-height:1.85;color:#2b2b2e}
.article-body h2{font-size:20px;line-height:1.4;letter-spacing:-.3px;margin:34px 0 12px;color:var(--text);scroll-margin-top:72px}
.article-body h3{font-size:17px;margin:26px 0 10px;color:var(--text);scroll-margin-top:72px}
.article-body p{margin:0 0 16px}
.article-body ul,.article-body ol{margin:0 0 18px;padding-left:22px}
.article-body li{margin:6px 0}
.article-body a{color:var(--blue)}
.article-body strong{font-weight:600;color:var(--text)}
.article-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--surface-3);padding:2px 5px;border-radius:5px;font-size:13px}
.article-body pre{background:var(--surface-3);padding:14px;border-radius:10px;overflow:auto;margin:0 0 18px}
.article-body pre code{background:transparent;padding:0}
.article-body table{border-collapse:collapse;width:100%;margin:0 0 20px;font-size:14px}
.article-body th,.article-body td{border:.5px solid var(--line);padding:9px 11px;text-align:left}
.article-body th{background:var(--surface-3);font-weight:600}
.article-body blockquote{margin:0 0 18px;padding:10px 14px;border-left:3px solid var(--blue);background:var(--blue-soft);border-radius:0 8px 8px 0}
.article-embeds{margin-top:38px;padding-top:24px;border-top:.5px solid var(--line)}
.article-embeds h2{font-size:20px;line-height:1.4;letter-spacing:-.3px;margin:0 0 14px;color:var(--text);scroll-margin-top:72px}
.embed-figure{margin:0 0 20px;border:.5px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}
.embed-figure figcaption{padding:10px 13px;background:var(--surface-3);font-size:12px;color:var(--muted)}
.embed-figure iframe{display:block;width:100%;border:0;background:#fff}
/* 右侧子标题导航：按二级标题分组，三级标题缩进并从属于最近的二级标题 */
.toc{position:sticky;top:78px;width:190px;flex:0 0 190px;max-height:calc(100vh - 110px);overflow:auto;padding:6px 4px 6px 16px;border-left:.5px solid var(--line)}
.toc-title{font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--faint);margin:0 0 10px;padding-left:10px}
.toc a{display:block;font-size:12.5px;line-height:1.45;color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:7px;border-left:2px solid transparent;transition:background .15s,color .15s}
.toc a:hover{color:var(--blue);background:var(--surface-3)}
.toc-group{margin:0 0 4px}
.toc-group > a{color:var(--text);font-weight:600}
.toc a.lv3{position:relative;padding-left:26px;font-size:12px;color:var(--faint);font-weight:400}
.toc a.lv3::before{content:"";position:absolute;left:15px;top:0;bottom:0;width:1px;background:var(--line)}
.toc a.lv3::after{content:"";position:absolute;left:15px;top:50%;width:6px;border-top:1px solid var(--line)}
.toc a.active{color:var(--blue);background:var(--blue-soft);border-left-color:var(--blue);font-weight:600}
.toc a.lv3.active{border-left-color:transparent}
@media(max-width:980px){
  .detail-wrap{display:block;padding:20px 0 64px}
  .article{max-width:820px;margin:0 auto}
  .toc{display:none}
}
@media(max-width:700px){
  .article-title{font-size:23px}
  .article-body{font-size:14.5px}
}`;

const TOC_JS = `
<script>
(function(){
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length) return;
  var targets = links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); });
  links.forEach(function(a){
    a.addEventListener('click', function(e){
      var el = document.getElementById(a.getAttribute('href').slice(1));
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({behavior:'smooth', block:'start'});
      if (history.replaceState) history.replaceState(null, '', a.getAttribute('href'));
    });
  });
  function update(){
    var y = window.scrollY + 90, idx = 0;
    for (var i=0;i<targets.length;i++){ if (targets[i] && targets[i].getBoundingClientRect().top + window.scrollY <= y) idx = i; }
    links.forEach(function(a,i){ a.classList.toggle('active', i===idx); });
  }
  window.addEventListener('scroll', update, {passive:true});
  window.addEventListener('resize', update);
  update();
})();
</script>
`;

const MODAL_CSS = `
/* 嵌入图弹窗查看器 */
.embed-strip{display:flex;align-items:center;gap:8px}
.strip-label{flex:1;min-width:0}
.embed-open{display:inline-flex;align-items:center;gap:4px;flex:none;border:0;background:var(--blue-soft,#e5f1ff);color:var(--blue,#007aff);font-size:11px;line-height:1;padding:6px 9px;border-radius:7px;cursor:pointer;white-space:nowrap}
.embed-open:hover{background:#d5e8ff}
.embed-figure figcaption{display:flex;align-items:center;justify-content:space-between;gap:10px}
.modal-overlay{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.modal-overlay.open{display:flex}
.modal{width:min(1400px,100%);height:min(94vh,1100px);display:flex;flex-direction:column;background:var(--surface,#fff);border-radius:16px;overflow:hidden;box-shadow:0 20px 70px rgba(0,0,0,.35)}
.modal-head{flex:none;display:flex;align-items:center;gap:8px;padding:11px 13px;border-bottom:.5px solid var(--line,#e5e5ea);background:var(--surface,#fff)}
.modal-title{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--text,#1d1d1f);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modal-btn{border:0;background:var(--surface-3,#f2f2f7);color:var(--blue,#007aff);font-size:12px;padding:7px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.modal-btn:hover{background:var(--blue-soft,#e5f1ff)}
.modal-close{width:30px;height:30px;flex:none;border:0;border-radius:50%;background:var(--surface-3,#f2f2f7);color:var(--muted,#6e6e73);font-size:19px;line-height:1;cursor:pointer;display:grid;place-items:center}
.modal-close:hover{background:#e5e5ea;color:var(--text,#1d1d1f)}
.modal-body{flex:1;min-height:0;background:#fff}
.modal-body iframe{display:block;width:100%;height:100%;border:0;background:#fff}
@media(max-width:700px){
  .modal-overlay{padding:0}
  .modal{width:100%;height:100%;border-radius:0}
  .modal-head{padding:9px 11px}
}`;

const MODAL_HTML = `
<div class="modal-overlay" id="imgModal" role="dialog" aria-modal="true" aria-label="嵌入内容预览">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title">嵌入内容</span>
      <button type="button" class="modal-btn" data-modal-newtab>新标签页打开</button>
      <button type="button" class="modal-close" data-modal-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body"><iframe title="嵌入内容预览" sandbox="allow-scripts" loading="lazy"></iframe></div>
  </div>
</div>`;

const MODAL_JS = `
(function(){
  var overlay = document.getElementById('imgModal');
  if (!overlay) return;
  var frame = overlay.querySelector('iframe');
  var titleEl = overlay.querySelector('.modal-title');
  var currentUrl = '';
  function open(src, doc, title){
    titleEl.textContent = title || '嵌入内容';
    currentUrl = src || '';
    frame.removeAttribute('srcdoc');
    if (doc !== null && doc !== undefined && doc !== '') frame.srcdoc = doc;
    else frame.src = src || 'about:blank';
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function close(){
    overlay.classList.remove('open');
    frame.removeAttribute('srcdoc');
    frame.src = 'about:blank';
    currentUrl = '';
    document.body.style.overflow = '';
  }
  document.addEventListener('click', function(e){
    var btn = e.target.closest('.embed-open');
    if (btn){
      e.preventDefault();
      var fig = btn.closest('.embed-figure');
      var srcFrame = fig ? fig.querySelector('iframe') : null;
      if (btn.hasAttribute('data-modal-idx') && srcFrame && srcFrame.hasAttribute('srcdoc')){
        open('', srcFrame.getAttribute('srcdoc'), btn.getAttribute('data-modal-title'));
      } else {
        open(btn.getAttribute('data-modal-src'), null, btn.getAttribute('data-modal-title'));
      }
      return;
    }
    if (e.target.closest('[data-modal-newtab]')){
      if (frame.hasAttribute('srcdoc')){
        var blob = new Blob([frame.getAttribute('srcdoc')], {type:'text/html'});
        window.open(URL.createObjectURL(blob), '_blank');
      } else if (currentUrl){ window.open(currentUrl, '_blank'); }
      return;
    }
    if (e.target.closest('[data-modal-close]') || e.target === overlay) close();
  });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
})();`;

function injectModal(html) {
  return html
    .replace('</style>', MODAL_CSS + '\n</style>')
    .replace('</body>', MODAL_HTML + '\n<script>\n' + MODAL_JS + '\n</script>\n</body>');
}

function renderIndex(posts, template) {
  // 分类由 buildCats() 从文章动态生成：技术常驻，其余按文章出现情况自动增删
  const usedCats = CATS.slice();
  const catJson = usedCats.map(function(c) {
    return "  { id:'" + c.id + "', n:'" + c.n + "', color:'" + c.color + "' }";
  }).join(',\n');

  const postJson = posts.map(function(p) {
    return "  { url:'posts/" + encodeURI(p.slug) + ".html', c:'" + catId(p.category) + "',\n" +
      "    t:" + JSON.stringify(p.title) + ", date:'" + p.date + "', m:" + p.minutes +
      ", em:" + p.embeds.length + ",\n" +
      "    ex:" + JSON.stringify(p.summary) + " }";
  }).join(',\n');

  const dataBlock =
    '/* __DATA_START__ */\n' +
    "var POST_BASE = '';\n" +
    'window.__CATS__ = [\n' + catJson + '\n];\n' +
    'window.__POSTS__ = [\n' + postJson + '\n];\n' +
    '/* __DATA_END__ */';

  let html = template.replace(
    /\/\* __DATA_START__ \*\/[\s\S]*?\/\* __DATA_END__ \*\//,
    function() { return dataBlock; }
  );

  // 无脚本回退列表也改成指向详情页
  const noscriptItems = posts.map(function(p) {
    var c = usedCats.filter(function(x) { return x.id === catId(p.category); })[0] || usedCats[0] || { color: '#8e8e93', n: '' };
    return '<li class="post-item"><span class="pl-dot" style="background:' + c.color + '"></span>' +
      '<span class="pl-date">' + p.shortDate + '</span>' +
      '<a class="pl-title" href="posts/' + encodeURI(p.slug) + '.html">' + escapeHtml(p.title) + '</a>' +
      (p.embeds.length ? '<span class="pl-em">' + p.embeds.length + ' 图</span>' : '') +
      '<span class="pl-cat">' + escapeHtml(c.n) + '</span></li>';
  }).join('\n    ');
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/, '<noscript>\n  <ul class="post-list">\n    ' + noscriptItems + '\n  </ul>\n</noscript>');

  return html;
}

function readEmbedDoc(embed) {
  if (/^https?:\/\//.test(embed)) return null;
  const p = path.join(MD_DIR, embed);
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
  catch (e) { return null; }
}

function renderDetail(post, baseCss) {
  const color = COLORS[post.category] || '#8e8e93';
  const headings = [];
  const bodyHtml = renderMarkdown(post.body, headings);
  let embedsHtml = '';
  if (post.embeds.length) {
    const blocks = post.embeds.map(function(embed, i) {
      const src = /^https?:\/\//.test(embed) ? embed : '../' + encodeURI(embed);
      const doc = readEmbedDoc(embed);
      const label = post.embedLabels[i] || ('嵌入内容 ' + (i + 1));
      const h = post.embedHeight || 520;
      // 内联原始 HTML（srcdoc）：详情页自包含，预览面板/本地/线上都能显示，不依赖相对路径
      const frameAttrs = doc !== null
        ? ' srcdoc="' + escapeHtml(doc) + '"'
        : ' src="' + escapeHtml(src) + '"';
      return '<figure class="embed-figure">' +
        '<figcaption><span>' + escapeHtml(label) + '</span>' +
        '<button type="button" class="embed-open" data-modal-idx="' + i + '"' +
        ' data-modal-title="' + escapeHtml(post.title + ' · ' + label) + '">⤢ 弹窗查看</button></figcaption>' +
        '<iframe title="' + escapeHtml(label) + '"' + frameAttrs +
        ' sandbox="allow-scripts" loading="lazy" style="height:' + h + 'px"></iframe>' +
        '</figure>';
    }).join('\n');
    const sectionTitle = post.embedTitle || '相关图表';
    embedsHtml = '\n  <div class="article-embeds">\n    <h2 id="sec-embeds">' + escapeHtml(sectionTitle) + '</h2>\n' + blocks + '\n  </div>';
    headings.push({ id: 'sec-embeds', text: sectionTitle, level: 2 });
  }

  const tocHtml = headings.length
    ? (function() {
        // 三级标题归入最近的二级标题，目录里直观体现从属关系
        const groups = [];
        let current = null;
        headings.forEach(function(x) {
          if (x.level === 2 || !current) {
            current = [];
            groups.push(current);
          }
          current.push(x);
        });
        return '<nav class="toc" aria-label="文章目录"><div class="toc-title">本页目录</div>' +
          groups.map(function(group) {
            return '<div class="toc-group">' + group.map(function(x) {
              return '<a href="#' + x.id + '" class="' + (x.level === 3 ? 'lv3' : '') + '">' + escapeHtml(x.text) + '</a>';
            }).join('') + '</div>';
          }).join('') + '</nav>';
      })()
    : '';

  var html = '<!doctype html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<title>' + escapeHtml(post.title) + ' · 札记</title>\n' +
    '<style>\n' + baseCss + '\n' + DETAIL_CSS + '\n</style>\n' +
    '</head>\n<body>\n' +
    '<header class="topbar"><div class="top-inner pad">' +
    '<a class="back" href="../index.html">← 返回列表</a>' +
    '</div></header>\n' +
    '<main class="pad">\n' +
    '<div class="detail-wrap">\n' +
    '<article class="article">\n' +
    '  <div class="article-meta-top"><span class="dot" style="background:' + color + '"></span>' + escapeHtml(post.category) + '</div>\n' +
    '  <h1 class="article-title">' + escapeHtml(post.title) + '</h1>\n' +
    '  <div class="article-meta">' + escapeHtml(post.date) + ' · ' + post.minutes + ' 分钟阅读</div>\n' +
    '  <div class="article-body">\n' + bodyHtml + '\n  </div>' + embedsHtml + '\n' +
    '</article>\n' +
    tocHtml + '\n' +
    '</div>\n' +
    '</main>\n' +
    TOC_JS +
    '</body>\n</html>\n';
  return injectModal(html);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach(function(name) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  });
}

function build() {
  if (!fs.existsSync(MD_DIR)) {
    throw new Error('MD 目录不存在: ' + MD_DIR + '（可用 MD_DIR 环境变量覆盖）');
  }

  const files = fs.readdirSync(MD_DIR).filter(function(name) {
    return name.toLowerCase().endsWith('.md');
  });

  const posts = files.map(function(name, i) {
    return parseMarkdown(path.join(MD_DIR, name), i + 1);
  }).filter(Boolean).sort(function(a, b) {
    return b.date.localeCompare(a.date);
  });

  // 先根据当前文章重建分类，后续首页/详情页都使用动态分类表
  buildCats(posts);

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const styleMatch = template.match(/<style>([\s\S]*?)<\/style>/);
  const baseCss = styleMatch ? styleMatch[1] : '';

  if (template.indexOf('/* __DATA_START__ */') < 0 || template.indexOf('/* __DATA_END__ */') < 0) {
    throw new Error('模板中找不到 /* __DATA_START__ */ ... /* __DATA_END__ */ 数据注入标记');
  }
  const finalOutput = renderIndex(posts, template);
  const embedCount = posts.reduce(function(n, p) { return n + p.embeds.length; }, 0);
  const usedCatCount = CATS.filter(function(c) {
    return posts.some(function(p) { return catId(p.category) === c.id; });
  }).length;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(POST_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), finalOutput, 'utf8');

  posts.forEach(function(post) {
    fs.writeFileSync(path.join(POST_DIR, post.slug + '.html'), renderDetail(post, baseCss), 'utf8');
  });

  const index = posts.map(function(post) {
    return {
      title: post.title,
      date: post.date,
      category: post.category,
      summary: post.summary,
      tags: post.tags,
      readingMinutes: post.minutes,
      url: 'posts/' + post.slug + '.html',
      embeds: post.embeds,
      body: post.body.replace(/[#*`>\[\]]/g, '').trim().slice(0, 2000)
    };
  });
  fs.writeFileSync(path.join(OUT_DIR, 'search-index.json'), JSON.stringify(index, null, 2), 'utf8');

  const embedSrc = path.join(MD_DIR, 'embed');
  if (fs.existsSync(embedSrc)) copyDir(embedSrc, path.join(OUT_DIR, 'embed'));

  console.log('生成完成: ' + posts.length + ' 篇文章, ' + usedCatCount + ' 个分类, ' + embedCount + ' 个嵌入块');
  console.log('输出: ' + path.join(OUT_DIR, 'index.html'));
  console.log('详情: ' + path.join(POST_DIR) + ' (' + posts.length + ' 个页面)');
  console.log('索引: ' + path.join(OUT_DIR, 'search-index.json'));
}

build();
