const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOCAL_MD_DIR = path.join(ROOT, 'new_ai_blog');
const FALLBACK_MD_DIR = 'D:/blog/最新博客归档目录/new_ai_blog';
const MD_DIR = process.env.MD_DIR || (fs.existsSync(LOCAL_MD_DIR) ? LOCAL_MD_DIR : FALLBACK_MD_DIR);
const TEMPLATE = path.join(ROOT, 'blog-prototype-ios.html');
const OUT_DIR = path.join(ROOT, 'dist');

const COLORS = {
  '设计': '#007aff',
  '前端': '#5ac8fa',
  '随笔': '#8e8e93',
  '效率': '#ff9500',
  '工具': '#1d9e75',
  '阅读': '#af52de'
};

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function parseMarkdown(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const meta = {};
  match[1].split(/\r?\n/).forEach(function(line) {
    const index = line.indexOf(':');
    if (index < 0) return;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  });

  if (!meta.title || !meta.date || !meta.category) return null;

  const body = match[2].trim();
  const minutes = Math.max(1, Math.round(body.replace(/\s/g, '').length / 300));
  const parts = meta.date.split('-');

  return {
    title: meta.title,
    date: meta.date,
    year: parts[0],
    month: parts[1],
    day: parts[2],
    shortDate: parts[1] + '.' + parts[2],
    monthLabel: parts[0] + ' 年 ' + parts[1] + ' 月',
    category: meta.category,
    summary: meta.summary || '',
    tags: (meta.tags || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean),
    embed: meta.embed || '',
    minutes: minutes,
    body: body
  };
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

  const posts = files.map(function(name) {
    return parseMarkdown(path.join(MD_DIR, name));
  }).filter(Boolean).sort(function(a, b) {
    return b.date.localeCompare(a.date);
  });

  const groups = [];
  posts.forEach(function(post) {
    let group = groups.filter(function(g) { return g.label === post.monthLabel; })[0];
    if (!group) {
      group = { label: post.monthLabel, posts: [] };
      groups.push(group);
    }
    group.posts.push(post);
  });

  let embedCount = 0;
  const groupsHtml = groups.map(function(group) {
    const rows = group.posts.map(function(post) {
      let extra = '';
      if (post.embed) {
        embedCount += 1;
        const panelId = 'embedPanel' + embedCount;
        const src = /^https?:\/\//.test(post.embed) ? post.embed : encodeURI(post.embed);
        extra =
          '\n        <div class="embed-strip" data-embed="' + panelId + '">嵌入 HTML 内容预览 · 点击展开</div>' +
          '\n        <figure class="embed-panel" id="' + panelId + '" hidden>' +
          '<iframe title="' + escapeHtml(post.title) + ' 嵌入内容" src="' + escapeHtml(src) +
          '" sandbox="allow-scripts" loading="lazy"></iframe></figure>';
      }
      const color = COLORS[post.category] || '#8e8e93';
      return '      <div class="entry" data-category="' + escapeHtml(post.category) + '">' +
        '\n        <div class="row"><span class="dot" style="background:' + color + '"></span>' +
        '<span class="title">' + escapeHtml(post.title) + '</span>' +
        '<span class="meta">' + escapeHtml(post.shortDate) + ' · ' + post.minutes + ' 分钟</span></div>' +
        extra +
        '\n      </div>';
    }).join('\n');

    return '  <section class="group">' +
      '\n    <h2 class="month">' + escapeHtml(group.label) + '</h2>' +
      '\n    <div class="list">' +
      '\n' + rows +
      '\n    </div>' +
      '\n  </section>';
  }).join('\n\n');

  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const startTag = '<main class="pad">';
  const start = template.indexOf(startTag);
  const contentStart = template.indexOf('>', start) + 1;
  const end = template.indexOf('</main>', contentStart);
  if (start < 0 || end < 0) throw new Error('模板中找不到 <main class="pad"> 区块');

  const mainHtml = '\n' + groupsHtml +
    '\n\n  <div class="empty" id="empty" hidden>没有匹配的文章。</div>\n';
  const output = template.slice(0, contentStart) + mainHtml + template.slice(end);
  const finalOutput = output.replace(
    /(<span class="count" id="count">)[^<]*(<\/span>)/,
    '$1' + posts.length + ' 篇$2'
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), finalOutput, 'utf8');

  const index = posts.map(function(post) {
    return {
      title: post.title,
      date: post.date,
      category: post.category,
      summary: post.summary,
      tags: post.tags,
      readingMinutes: post.minutes,
      embed: post.embed || null,
      body: post.body.replace(/[#*`>\[\]]/g, '').trim().slice(0, 2000)
    };
  });
  fs.writeFileSync(path.join(OUT_DIR, 'search-index.json'), JSON.stringify(index, null, 2), 'utf8');

  const embedSrc = path.join(MD_DIR, 'embed');
  if (fs.existsSync(embedSrc)) copyDir(embedSrc, path.join(OUT_DIR, 'embed'));

  console.log('生成完成: ' + posts.length + ' 篇文章, ' + groups.length + ' 个分组, ' + embedCount + ' 个嵌入块');
  console.log('输出: ' + path.join(OUT_DIR, 'index.html'));
  console.log('索引: ' + path.join(OUT_DIR, 'search-index.json'));
}

build();
