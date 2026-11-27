const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

// slug 固定为「日期-标题哈希」：只由 date 和 title 决定，与文件遍历顺序、文章总数无关，
// 新增或删除文章都不会让历史链接失效。同一天同一标题视为同一篇（会走下面的撞号兜底）。
function slugFor(meta) {
  const datePart = String(meta.date || '').replace(/[^0-9-]/g, '') || 'undated';
  const h = crypto.createHash('sha1').update(String(meta.title || '').trim(), 'utf8').digest('hex').slice(0, 6);
  return datePart + '-' + h;
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
  const time = /^\d{2}:\d{2}$/.test(meta.time || '') ? meta.time : '00:00';

  return {
    slug: slugFor(meta),
    title: meta.title,
    date: meta.date,
    stamp: meta.date + 'T' + time,
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
    /^!\[/.test(t) || /^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t) || /^>\s?/.test(t) ||
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
      const lang = t.replace(/^```/, '').trim();
      i++;
      const buf = [];
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      // 长代码默认折叠，短代码只保留复制入口
      const collapsible = buf.length > 14;
      out.push(
        '<div class="code-block' + (collapsible ? ' is-collapsed' : '') + '"' +
        (collapsible ? ' data-expand-label="展开全部 · ' + buf.length + ' 行"' : '') + '>' +
        '<div class="code-bar"><span class="code-lang">' + escapeHtml(lang) + '</span>' +
        '<span class="code-btns">' +
        (collapsible ? '<button type="button" class="code-toggle" aria-expanded="false">展开全部 · ' + buf.length + ' 行</button>' : '') +
        '<button type="button" class="code-copy">复制</button>' +
        '</span></div>' +
        '<div class="code-body"><pre><code>' + escapeHtml(buf.join('\n')) + '</code></pre></div>' +
        '</div>'
      );
      continue;
    }

    // 块级图片：![说明](embed/xxx.png)，相对路径统一改写为详情页可用的 ../ 前缀
    const img = t.match(/^!\[(.*?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/);
    if (img) {
      let src = img[2];
      if (!/^(https?:)?\/\//.test(src) && src.charAt(0) !== '/' && src.indexOf('../') !== 0) {
        src = '../' + src;
      }
      out.push('<figure class="md-figure"><img src="' + escapeHtml(src) + '" alt="' +
        escapeHtml(img[1]) + '" loading="lazy"><figcaption>' + inlineMd(img[1]) + '</figcaption></figure>');
      i++;
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
/* 详情页用到的语义色此前未定义（首页模板只提供 --fg/--border/--accent 一套），
   这里补一层别名，避免目录、表格、弹层等元素出现透明背景或丢边框。 */
:root{
  --surface:#ffffff; --surface-3:#f2f2f7; --line:#e5e5ea;
  --text:#1c1c1e; --muted:#6e6e73; --faint:#a1a1a6;
  --blue:#007aff; --blue-soft:#eaf3ff;
}
@media (prefers-color-scheme: dark){
  :root{
    --surface:#1d1d20; --surface-3:#262629; --line:#333337;
    --text:#f2f2f7; --muted:#a1a1a6; --faint:#6e6e73;
    --blue:#0a84ff; --blue-soft:#1c2b40;
  }
}
/* 返回列表：桌面端放在目录标题右侧，移动端改为底部悬浮按钮 */
.back{font-size:12px;color:var(--blue);text-decoration:none;white-space:nowrap;padding:2px 4px;border-radius:6px}
.back:hover{background:var(--blue-soft)}
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
/* 代码块：超过 14 行默认折叠，所有代码块都能一键复制 */
.code-block{margin:0 0 18px;border:.5px solid var(--line);border-radius:11px;background:var(--surface-3);overflow:hidden}
.code-bar{display:flex;align-items:center;gap:10px;padding:4px 8px 4px 12px;border-bottom:.5px solid var(--line)}
.code-lang{font-size:11px;letter-spacing:.4px;color:var(--faint);text-transform:lowercase}
.code-btns{margin-left:auto;display:flex;gap:2px}
.code-btns button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;line-height:1;padding:6px 9px;border-radius:6px;cursor:pointer;transition:background .15s,color .15s}
.code-btns button:hover{background:var(--line);color:var(--text)}
.code-btns button.done{color:#34c759}
.code-block pre{margin:0;padding:12px 14px;border-radius:0;background:transparent}
.code-body{position:relative}
.code-block.is-collapsed .code-body{max-height:320px;overflow:hidden}
.code-block.is-collapsed .code-body::after{content:"";position:absolute;left:0;right:0;bottom:0;height:72px;background:linear-gradient(to bottom,transparent,var(--surface-3));pointer-events:none}
@media(max-width:760px){.code-block pre{padding:11px 12px}.code-btns button{font-size:11.5px;padding:5px 8px}}
.article-body table{border-collapse:collapse;width:100%;margin:0 0 20px;font-size:14px}
.article-body th,.article-body td{border:.5px solid var(--line);padding:9px 11px;text-align:left}
.article-body th{background:var(--surface-3);font-weight:600}
.article-body blockquote{margin:0 0 18px;padding:10px 14px;border-left:3px solid var(--blue);background:var(--blue-soft);border-radius:0 8px 8px 0}
.md-figure{margin:22px 0;border:.5px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}
.md-figure img{display:block;width:100%;height:auto;background:#fff}
.md-figure figcaption{padding:9px 12px;background:var(--surface-3);font-size:12px;line-height:1.6;color:var(--muted)}
.article-embeds{margin-top:38px;padding-top:24px;border-top:.5px solid var(--line)}
.article-embeds h2{font-size:20px;line-height:1.4;letter-spacing:-.3px;margin:0 0 14px;color:var(--text);scroll-margin-top:72px}
.embed-figure{margin:0 0 20px;border:.5px solid var(--line);border-radius:12px;overflow:hidden;background:var(--surface)}
.embed-figure figcaption{padding:10px 13px;background:var(--surface-3);font-size:12px;color:var(--muted)}
.embed-figure iframe{display:block;width:100%;border:0;background:#fff}
/* 右侧子标题导航：按二级标题分组，三级标题缩进并从属于最近的二级标题 */
.toc{position:sticky;top:78px;width:190px;flex:0 0 190px;max-height:calc(100vh - 110px);overflow:auto;padding:6px 4px 6px 16px;border-left:.5px solid var(--line)}
.toc-title{font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--faint);margin:0 0 10px;padding-left:10px}
.toc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px}
.toc-head .toc-title{margin:0}
.toc a{display:block;font-size:12.5px;line-height:1.45;color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:7px;border-left:2px solid transparent;transition:background .15s,color .15s}
.toc a:hover{color:var(--blue);background:var(--surface-3)}
.toc-group{margin:0 0 4px}
.toc-group > a{color:var(--text);font-weight:600}
.toc a.lv3{position:relative;padding-left:26px;font-size:12px;color:var(--faint);font-weight:400}
.toc a.lv3::before{content:"";position:absolute;left:15px;top:0;bottom:0;width:1px;background:var(--line)}
.toc a.lv3::after{content:"";position:absolute;left:15px;top:50%;width:6px;border-top:1px solid var(--line)}
.toc a.active{color:var(--blue);background:var(--blue-soft);border-left-color:var(--blue);font-weight:600}
.toc a.lv3.active{border-left-color:transparent}
/* 移动端目录：右下角「返回列表 + 目录」悬浮操作 + 底部弹层，桌面端完全隐藏 */
.detail-actions{display:none}
.toc-sheet{display:none}
@media(max-width:980px){
  .detail-wrap{display:block;padding:20px 0 64px}
  .article{max-width:820px;margin:0 auto}
  .toc{display:none}
  .detail-actions{display:flex;position:fixed;right:calc(16px + env(safe-area-inset-right,0px));bottom:calc(18px + env(safe-area-inset-bottom));z-index:60;align-items:center;gap:8px}
  .toc-fab,.back-fab{display:inline-flex;align-items:center;gap:6px;height:38px;padding:0 13px;border:.5px solid var(--line);border-radius:999px;background:var(--surface);color:var(--text);font:inherit;font-size:13px;text-decoration:none;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,.14);cursor:pointer}
  .toc-fab:active,.back-fab:active{transform:scale(.97)}
  .back-fab{color:var(--blue)}
  .toc-sheet{display:none;position:fixed;inset:0;z-index:80}
  .toc-sheet.on{display:block}
  .toc-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.3)}
  .toc-panel{position:absolute;left:0;right:0;bottom:0;max-height:72vh;overflow:auto;background:var(--surface);border-radius:16px 16px 0 0;padding:6px 10px calc(16px + env(safe-area-inset-bottom));box-shadow:0 -10px 34px rgba(0,0,0,.16);animation:tocUp .2s ease}
  .toc-panel-head{display:flex;align-items:center;gap:10px;padding:8px 6px 2px}
  .toc-panel-head span{font-size:11px;font-weight:600;letter-spacing:.4px;color:var(--faint);margin-right:auto}
  .toc-close{width:28px;height:28px;border:0;border-radius:50%;background:var(--surface-3);color:var(--muted);font-size:15px;line-height:1;cursor:pointer}
  .toc-sheet .toc{display:block;position:static;width:auto;max-height:none;overflow:visible;padding:0;border-left:0}
}
@keyframes tocUp{from{transform:translateY(14px);opacity:.5}to{transform:none;opacity:1}}
@media(max-width:700px){
  .article-title{font-size:23px}
  .article-body{font-size:14.5px}
  .detail-actions{right:calc(12px + env(safe-area-inset-right,0px));bottom:calc(12px + env(safe-area-inset-bottom));gap:6px}
  .toc-fab,.back-fab{height:36px;padding:0 11px;font-size:12px}
}`;

const TOC_JS = `
<script>
(function(){
  var fab = document.getElementById('toc-fab');
  var sheet = document.getElementById('toc-sheet');

  function openSheet(){
    if (!sheet) return;
    sheet.classList.add('on');
    fab.setAttribute('aria-expanded','true');
    document.body.style.overflow = 'hidden';
  }
  function closeSheet(){
    if (!sheet || !sheet.classList.contains('on')) return;
    sheet.classList.remove('on');
    fab.setAttribute('aria-expanded','false');
    document.body.style.overflow = '';
  }

  if (fab && sheet) {
    fab.addEventListener('click', openSheet);
    sheet.addEventListener('click', function(e){
      if (e.target.closest('[data-toc-close]') || e.target.closest('a')) closeSheet();
    });
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape') closeSheet();
    });
  }

  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a'));
  if (!links.length) return;
  var targets = links.map(function(a){ return document.getElementById(a.getAttribute('href').slice(1)); });
  links.forEach(function(a){
    a.addEventListener('click', function(e){
      var el = document.getElementById(a.getAttribute('href').slice(1));
      if (!el) return;
      e.preventDefault();
      closeSheet();
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
/* 横屏查看：全屏/旋转引导（仅手机端显示入口） */
.modal-landscape{display:none}
.land-tools{display:none;position:absolute;top:calc(8px + env(safe-area-inset-top));right:8px;z-index:4;gap:8px}
.land-tools button{border:0;border-radius:8px;padding:7px 11px;font-size:12px;background:rgba(255,255,255,.9);color:#007aff;box-shadow:0 2px 10px rgba(0,0,0,.12);cursor:pointer;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.rotate-hint{display:none;position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:5;width:min(280px,80vw);padding:20px;border-radius:16px;background:rgba(28,28,30,.92);color:#fff;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.rotate-hint.show{display:block}
.rotate-hint .rh-icon{font-size:34px;line-height:1;margin-bottom:10px}
.rotate-hint .rh-title{font-size:14px;font-weight:600;margin-bottom:6px}
.rotate-hint .rh-sub{font-size:12px;color:rgba(255,255,255,.72);line-height:1.5}
.modal-overlay.landscape-mode{padding:0;background:#fff}
.modal-overlay.landscape-mode .modal{width:100vw;height:100vh;height:100dvh;border-radius:0}
.modal-overlay.landscape-mode .modal-head{display:none}
.modal-overlay.landscape-mode .land-tools{display:flex}
.modal-overlay:fullscreen{background:#fff}
.modal-overlay:fullscreen .modal{width:100vw;height:100vh}
@media(max-width:700px){
  .modal-overlay{padding:0}
  .modal{width:100%;height:100%;border-radius:0}
  .modal-head{padding:9px 11px}
  .modal-landscape{display:inline-flex}
}`;

const MODAL_HTML = `
<div class="modal-overlay" id="imgModal" role="dialog" aria-modal="true" aria-label="嵌入内容预览">
  <div class="modal">
    <div class="modal-head">
      <span class="modal-title">嵌入内容</span>
      <button type="button" class="modal-btn modal-landscape" data-modal-landscape>横屏查看</button>
      <button type="button" class="modal-btn" data-modal-newtab>新标签页打开</button>
      <button type="button" class="modal-close" data-modal-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body"><iframe title="嵌入内容预览" sandbox="allow-scripts" loading="lazy"></iframe></div>
  </div>
  <div class="land-tools">
    <button type="button" data-modal-landscape>退出横屏</button>
    <button type="button" data-modal-close aria-label="关闭">×</button>
  </div>
  <div class="rotate-hint" data-rotate-hint aria-hidden="true">
    <div class="rh-icon">▭↻</div>
    <div class="rh-title">请旋转手机至横屏</div>
    <div class="rh-sub">图会自动铺满屏幕，看得更清楚</div>
  </div>
</div>`;

const MODAL_JS = `
(function(){
  var overlay = document.getElementById('imgModal');
  if (!overlay) return;
  var frame = overlay.querySelector('iframe');
  var titleEl = overlay.querySelector('.modal-title');
  var landBtn = overlay.querySelector('.modal-head [data-modal-landscape]');
  var hint = overlay.querySelector('[data-rotate-hint]');
  var currentUrl = '';
  var hintTimer = null;

  function showHint(){
    if (!hint) return;
    hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 4000);
  }
  function hideHint(){
    if (hint) hint.classList.remove('show');
  }
  function isFullscreen(){
    return document.fullscreenElement === overlay || document.webkitFullscreenElement === overlay;
  }
  function orient(){
    return window.screen && (window.screen.orientation || window.screen.mozOrientation);
  }
  function enterLandscape(){
    overlay.classList.add('landscape-mode');
    if (landBtn) landBtn.textContent = '退出横屏';
    /* 真全屏：Android Chrome / Edge 支持，iPhone Safari 会静默失败 */
    var req = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
    if (req) {
      try { Promise.resolve(req.call(overlay)).catch(function(){}); } catch(e){}
    }
    /* 旋转锁定：需要全屏 + 浏览器支持，失败则提示用户自己转 */
    var o = orient(), locked = false;
    if (o && o.lock) {
      try {
        var p = o.lock('landscape');
        if (p && typeof p.then === 'function') {
          p.then(function(){ locked = true; hideHint(); }).catch(function(){ showHint(); });
        } else { locked = true; }
      } catch(e){}
    }
    if (!locked) setTimeout(function(){
      if (overlay.classList.contains('landscape-mode') && window.innerWidth < window.innerHeight) showHint();
    }, 350);
  }
  function exitLandscape(){
    if (!overlay.classList.contains('landscape-mode')) return;
    overlay.classList.remove('landscape-mode');
    hideHint();
    if (landBtn) landBtn.textContent = '横屏查看';
    var o = orient();
    if (o && o.unlock) { try { o.unlock(); } catch(e){} }
    if (isFullscreen()) {
      var ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) { try { Promise.resolve(ex.call(document)).catch(function(){}); } catch(e){} }
    }
  }
  window.addEventListener('resize', function(){
    if (overlay.classList.contains('landscape-mode') && window.innerWidth > window.innerHeight) hideHint();
  });

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
    exitLandscape();
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
    if (e.target.closest('[data-modal-landscape]')){
      e.preventDefault();
      if (overlay.classList.contains('landscape-mode')) exitLandscape(); else enterLandscape();
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
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') { if (overlay.classList.contains('landscape-mode')) exitLandscape(); else close(); }
  });
})();`;

/* ==================== 显示模式：默认 / 护眼 / 羊皮纸 / 深色（首页 + 详情页共用） ==================== */
/* 启动脚本放在 head：正文渲染前恢复状态，避免刷新闪烁；兼容旧版 blog-eye-care */
const THEME_BOOT_JS = `
<script>
(function(){
  try{
    var m=localStorage.getItem('blog-theme-mode');
    if(!m && localStorage.getItem('blog-eye-care')==='on') m='eye';
    if(m==='eye'||m==='parchment'||m==='dark') document.documentElement.setAttribute('data-mode',m);
  }catch(e){}
})();
</script>`;

const THEME_CSS = `
/* ---------- 显示模式：覆盖首页与详情页两套变量 ---------- */
/* 护眼：暖色纸张 */
html[data-mode="eye"]{
  --bg:#f5efdf; --fg:#43392c; --fg2:#6f6250; --fg3:#9c8d76;
  --border:#ddd0b6; --card:#fbf6e9; --hover:#efe4cd;
  --accent:#8a6a3b; --accent-soft:#ecdfc2;
  --surface:#fbf6e9; --surface-3:#efe4cd; --line:#ddd0b6;
  --text:#43392c; --muted:#6f6250; --faint:#9c8d76;
  --blue:#8a6a3b; --blue-soft:#ecdfc2;
  color-scheme:light;
}
html[data-mode="eye"] body{background:var(--bg);color:var(--fg)}
html[data-mode="eye"] .article-body{color:var(--text)}
html[data-mode="eye"] .stage-scroll{background:radial-gradient(ellipse at 50% 118%,rgba(138,106,59,.08),transparent 68%)}
html[data-mode="eye"] .search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(138,106,59,.14)}
html[data-mode="eye"] .embed-figure iframe,html[data-mode="eye"] .modal-body iframe{filter:sepia(.12) saturate(.94)}
html[data-mode="eye"] .modal-body,html[data-mode="eye"] .modal-overlay.landscape-mode,html[data-mode="eye"] .modal-overlay:fullscreen{background:#f5efdf}
/* 羊皮纸：更深的旧纸底色 + 细纹，正文改用衬线体，像翻一本旧书 */
html[data-mode="parchment"]{
  --bg:#eee0c0; --fg:#3b2f20; --fg2:#6b5740; --fg3:#9a8462;
  --border:#cdb894; --card:#f7ecd2; --hover:#e7d7b2;
  --accent:#8a5a2b; --accent-soft:#ead4aa;
  --surface:#f7ecd2; --surface-3:#e7d7b2; --line:#cdb894;
  --text:#3b2f20; --muted:#6b5740; --faint:#9a8462;
  --blue:#8a5a2b; --blue-soft:#ead4aa;
  color-scheme:light;
}
html[data-mode="parchment"] body{
  color:var(--fg);
  background-color:var(--bg);
  background-image:
    radial-gradient(circle at 12% 18%,rgba(122,84,42,.10) 0 1px,transparent 1.5px),
    radial-gradient(circle at 78% 62%,rgba(122,84,42,.08) 0 1px,transparent 1.5px),
    repeating-linear-gradient(0deg,rgba(122,84,42,.035) 0 1px,transparent 1px 6px);
  background-size:38px 38px,52px 52px,100% 6px;
}
html[data-mode="parchment"] .article-title,
html[data-mode="parchment"] .article-body{font-family:"Songti SC","STSong","Noto Serif SC",Georgia,serif}
html[data-mode="parchment"] .article-body{color:var(--text)}
html[data-mode="parchment"] .stage-scroll{background:radial-gradient(ellipse at 50% 118%,rgba(138,90,43,.12),transparent 68%)}
html[data-mode="parchment"] .search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(138,90,43,.16)}
html[data-mode="parchment"] .embed-figure iframe,html[data-mode="parchment"] .modal-body iframe{filter:sepia(.28) saturate(.86) contrast(.97)}
html[data-mode="parchment"] .modal-body,html[data-mode="parchment"] .modal-overlay.landscape-mode,html[data-mode="parchment"] .modal-overlay:fullscreen{background:#f7ecd2}
/* 深色 */
html[data-mode="dark"]{
  --bg:#141416; --fg:#f2f2f7; --fg2:#a1a1a6; --fg3:#6e6e73;
  --border:#333337; --card:#1d1d20; --hover:#262629;
  --accent:#0a84ff; --accent-soft:#1c2b40;
  --surface:#1d1d20; --surface-3:#262629; --line:#333337;
  --text:#f2f2f7; --muted:#a1a1a6; --faint:#6e6e73;
  --blue:#0a84ff; --blue-soft:#1c2b40;
  color-scheme:dark;
}
html[data-mode="dark"] body{background:var(--bg);color:var(--fg)}
html[data-mode="dark"] .article-body{color:var(--text)}
html[data-mode="dark"] .stage-scroll{background:radial-gradient(ellipse at 50% 118%,rgba(10,132,255,.09),transparent 68%)}
html[data-mode="dark"] .search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(10,132,255,.18)}
/* 嵌入图本身是白底 SVG，深色下反相+转相，尽量保持原彩色相位 */
html[data-mode="dark"] .embed-figure iframe,html[data-mode="dark"] .modal-body iframe{filter:invert(.9) hue-rotate(180deg)}
html[data-mode="dark"] .modal-body,html[data-mode="dark"] .modal-overlay.landscape-mode,html[data-mode="dark"] .modal-overlay:fullscreen{background:#1d1d20}
html[data-mode="dark"] .vein{stroke:#8e8e93!important}
/* 右上角模式开关与菜单：桌面与手机同位置，不与详情页右下角目录按钮冲突 */
.theme-toggle{position:fixed;top:calc(14px + env(safe-area-inset-top,0px));right:16px;z-index:150;width:38px;height:38px;border:1px solid var(--border);border-radius:50%;background:var(--card);color:var(--muted);display:grid;place-items:center;cursor:pointer;box-shadow:0 3px 14px rgba(0,0,0,.1);transition:background .18s,color .18s,border-color .18s}
.theme-toggle:hover{border-color:var(--accent);color:var(--accent)}
.theme-toggle svg{width:19px;height:19px;display:block}
.theme-menu{position:fixed;top:calc(58px + env(safe-area-inset-top,0px));right:16px;z-index:149;min-width:132px;padding:5px;border:1px solid var(--border);border-radius:12px;background:var(--card);box-shadow:0 8px 28px rgba(0,0,0,.16);display:none}
.theme-menu.on{display:block}
.theme-menu button{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--fg2);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.theme-menu button:hover{background:var(--hover);color:var(--fg)}
.theme-menu button.on{color:var(--accent);font-weight:600}
.theme-menu button svg{width:16px;height:16px;flex:0 0 16px}
.theme-menu button .tick{margin-left:auto;font-size:12px;opacity:0}
.theme-menu button.on .tick{opacity:1}
@media(max-width:760px){.theme-toggle{width:36px;height:36px;top:calc(12px + env(safe-area-inset-top,0px));right:12px}.theme-menu{top:calc(54px + env(safe-area-inset-top,0px));right:12px}}`;

const THEME_HTML = `
<button type="button" class="theme-toggle" id="themeToggle" aria-label="切换显示模式" aria-haspopup="true" aria-expanded="false" title="显示模式"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none"/></svg></button>
<div class="theme-menu" id="themeMenu" role="menu" aria-label="显示模式">
  <button type="button" data-mode="normal" role="menuitemradio" aria-checked="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg><span>默认</span><i class="tick">✓</i></button>
  <button type="button" data-mode="eye" role="menuitemradio" aria-checked="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg><span>护眼</span><i class="tick">✓</i></button>
  <button type="button" data-mode="parchment" role="menuitemradio" aria-checked="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 0-2 2v10"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><span>羊皮纸</span><i class="tick">✓</i></button>
  <button type="button" data-mode="dark" role="menuitemradio" aria-checked="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg><span>深色</span><i class="tick">✓</i></button>
</div>`;

const THEME_JS = `
<script>
(function(){
  var btn=document.getElementById('themeToggle'), menu=document.getElementById('themeMenu');
  if(!btn||!menu) return;
  var root=document.documentElement;
  function current(){ return root.getAttribute('data-mode')||'normal'; }
  function sync(){
    var m=current();
    [].forEach.call(menu.querySelectorAll('button[data-mode]'), function(b){
      var on=b.getAttribute('data-mode')===m;
      b.classList.toggle('on',on);
      b.setAttribute('aria-checked',on?'true':'false');
    });
    var names={normal:'默认',eye:'护眼',parchment:'羊皮纸',dark:'深色'};
    btn.setAttribute('title','显示模式：'+(names[m]||'默认'));
  }
  function setMode(m){
    if(m==='normal') root.removeAttribute('data-mode'); else root.setAttribute('data-mode',m);
    try{ localStorage.setItem('blog-theme-mode',m); localStorage.removeItem('blog-eye-care'); }catch(e){}
    sync();
  }
  function close(){ menu.classList.remove('on'); btn.setAttribute('aria-expanded','false'); }
  btn.addEventListener('click',function(e){
    e.stopPropagation();
    var open=!menu.classList.contains('on');
    menu.classList.toggle('on',open);
    btn.setAttribute('aria-expanded',open?'true':'false');
  });
  menu.addEventListener('click',function(e){
    var b=e.target.closest('button[data-mode]'); if(!b) return;
    setMode(b.getAttribute('data-mode')); close();
  });
  document.addEventListener('click',function(e){ if(!menu.contains(e.target)&&e.target!==btn) close(); });
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
  sync();
})();
</script>`;

const CODE_JS = `
<script>
(function(){
  function fallbackCopy(text, done){
    var ta=document.createElement('textarea');
    ta.value=text; ta.setAttribute('readonly','');
    ta.style.position='fixed'; ta.style.top='-2000px'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); }catch(e){}
    document.body.removeChild(ta); done();
  }
  function copyText(text, done){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done, function(){ fallbackCopy(text, done); });
    }else{ fallbackCopy(text, done); }
  }
  [].forEach.call(document.querySelectorAll('.code-block'), function(block){
    var pre=block.querySelector('pre');
    var toggle=block.querySelector('.code-toggle');
    var copy=block.querySelector('.code-copy');
    var label=block.getAttribute('data-expand-label')||'展开全部';
    // 行数够长但实际没超高，就不必折叠，免得短代码也顶着「展开」
    if(block.classList.contains('is-collapsed') && pre && pre.scrollHeight<=340){
      block.classList.remove('is-collapsed');
      if(toggle){ toggle.parentNode.removeChild(toggle); toggle=null; }
    }
    if(toggle){
      toggle.addEventListener('click', function(){
        var collapsed=block.classList.toggle('is-collapsed');
        toggle.textContent = collapsed ? label : '收起';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      });
    }
    if(copy){
      copy.addEventListener('click', function(){
        var code=block.querySelector('code');
        copyText(code ? code.textContent : '', function(){
          copy.textContent='已复制';
          copy.classList.add('done');
          setTimeout(function(){ copy.textContent='复制'; copy.classList.remove('done'); }, 1600);
        });
      });
    }
  });
})();
</script>`;

function injectTheme(html) {
  return html
    .replace('</head>', THEME_BOOT_JS + '\n</head>')
    .replace('</style>', THEME_CSS + '\n</style>')
    .replace('</body>', THEME_HTML + '\n' + THEME_JS + '\n</body>');
}

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
      "    t:" + JSON.stringify(p.title) + ", date:'" + p.date + "', stamp:'" + p.stamp + "', m:" + p.minutes +
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
        ' data-modal-src="' + escapeHtml(src) + '"' +
        ' data-modal-title="' + escapeHtml(post.title + ' · ' + label) + '">⤢ 弹窗查看</button></figcaption>' +
        '<iframe title="' + escapeHtml(label) + '"' + frameAttrs +
        ' sandbox="allow-scripts" loading="lazy" style="height:' + h + 'px"></iframe>' +
        '</figure>';
    }).join('\n');
    const sectionTitle = post.embedTitle || '相关图表';
    embedsHtml = '\n  <div class="article-embeds">\n    <h2 id="sec-embeds">' + escapeHtml(sectionTitle) + '</h2>\n' + blocks + '\n  </div>';
    headings.push({ id: 'sec-embeds', text: sectionTitle, level: 2 });
  }

  // 三级标题归入最近的二级标题，目录里直观体现从属关系
  const tocInner = headings.length
    ? (function() {
        const groups = [];
        let current = null;
        headings.forEach(function(x) {
          if (x.level === 2 || !current) {
            current = [];
            groups.push(current);
          }
          current.push(x);
        });
        return groups.map(function(group) {
          return '<div class="toc-group">' + group.map(function(x) {
            return '<a href="#' + x.id + '" class="' + (x.level === 3 ? 'lv3' : '') + '">' + escapeHtml(x.text) + '</a>';
          }).join('') + '</div>';
        }).join('');
      })()
    : '';

  // 返回列表：桌面端放在目录标题右侧；无目录时仍保留在侧栏
  const backLink = '<a class="back" href="../index.html" aria-label="返回文章列表">← 返回列表</a>';
  const tocHtml = tocInner
    ? '<nav class="toc" aria-label="文章目录"><div class="toc-head"><span class="toc-title">本页目录</span>' + backLink + '</div>' + tocInner + '</nav>'
    : '<nav class="toc" aria-label="页面导航">' + backLink + '</nav>';

  // 移动端：返回列表 + 目录并排悬浮，底部弹层复用同一份目录结构
  const backFab = '<a class="back-fab" href="../index.html" aria-label="返回文章列表">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M15 18l-6-6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '返回列表</a>';
  const tocFab = tocInner
    ? '<button class="toc-fab" id="toc-fab" type="button" aria-expanded="false" aria-controls="toc-sheet">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<path d="M4 6h10M4 12h10M4 18h10" stroke-linecap="round"/><path d="M18 6h2M18 12h2M18 18h2" stroke-linecap="round"/></svg>' +
      '目录</button>'
    : '';
  const tocSheetHtml = tocInner
    ? '<div class="toc-sheet" id="toc-sheet" role="dialog" aria-modal="true" aria-label="本页目录">\n' +
      '  <div class="toc-backdrop" data-toc-close></div>\n' +
      '  <div class="toc-panel">\n' +
      '    <div class="toc-panel-head"><span>本页目录 · ' + headings.length + ' 节</span>' + backLink +
      '<button class="toc-close" type="button" data-toc-close aria-label="关闭目录">×</button></div>\n' +
      '    <nav class="toc" aria-label="文章目录">' + tocInner + '</nav>\n' +
      '  </div>\n' +
      '</div>'
    : '';
  const mobileActions = '<div class="detail-actions">' + backFab + tocFab + '</div>' + tocSheetHtml;

  var html = '<!doctype html>\n<html lang="zh-CN">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<title>' + escapeHtml(post.title) + ' · 札记</title>\n' +
    '<style>\n' + baseCss + '\n' + DETAIL_CSS + '\n</style>\n' +
    '</head>\n<body>\n' +
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
    mobileActions + '\n' +
    TOC_JS +
    CODE_JS +
    '</body>\n</html>\n';
  return injectTheme(injectModal(html));
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
    return b.stamp.localeCompare(a.stamp);
  });

  // 极端情况：同一天、同一标题会被算出同一个 slug，这里加序号兜底，避免静默覆盖文件
  const slugSeen = {};
  posts.forEach(function(p) {
    if (!slugSeen[p.slug]) { slugSeen[p.slug] = 1; return; }
    slugSeen[p.slug] += 1;
    p.slug = p.slug + '-' + slugSeen[p.slug];
  });

  // 先根据当前文章重建分类，后续首页/详情页都使用动态分类表
  buildCats(posts);

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const styleMatch = template.match(/<style>([\s\S]*?)<\/style>/);
  const baseCss = styleMatch ? styleMatch[1] : '';

  if (template.indexOf('/* __DATA_START__ */') < 0 || template.indexOf('/* __DATA_END__ */') < 0) {
    throw new Error('模板中找不到 /* __DATA_START__ */ ... /* __DATA_END__ */ 数据注入标记');
  }
  const finalOutput = injectTheme(renderIndex(posts, template));
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
