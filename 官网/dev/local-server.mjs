// 本地预览服务器 - 提供静态文件 + 模拟 API
// 用法: ELECTRON_RUN_AS_NODE=1 "Qoder CN.exe" dev/local-server.mjs
import { readFileSync, existsSync } from 'fs';
import { createServer } from 'http';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const WEB = join(ROOT, 'web');
const PORT = parseInt(process.argv[2] || '4173');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// 从 content.json 加载数据作为模拟 API
const contentPath = join(ROOT, 'data', 'content.json');
let content;
try {
  content = JSON.parse(readFileSync(contentPath, 'utf-8'));
  console.log('[mock] 已加载 content.json 作为模拟数据');
} catch (e) {
  console.warn('[mock] 无法加载 content.json，API 将返回空数据');
  content = {};
}

function mockApi(action, url) {
  const params = new URL(url, 'http://localhost').searchParams;

  if (action === 'all') {
    return {
      ok: true,
      site: content.site || {},
      hero: content.hero || null,
      notices: (content.notices?.items || []).map(n => ({ id: n.id, date: n.date, type: n.type, style: n.style, summary: n.text || n.summary, title: n.title, cover: n.cover || '', cover_alt: n.cover_alt || '' })),
      brands: (content.brands?.items || []).map((b, i) => ({ id: 'brand-' + i, name: b.name, sub: b.sub, logo: b.logo, is_self: b.isSelf || false })),
      goods: (content.goods?.items || []).map((g, i) => ({ id: 'good-' + i, badge: g.badge, badge_style: g.badgeStyle, name: g.name, description: g.desc, image: g.image, image_alt: g.imageAlt, tags: g.tags, alt_label: g.alt, price: g.price, unit: g.unit, is_free: g.free || false, free_label: g.freeLabel || '' })),
      event: content.event ? { ...content.event, date_start: content.event.date, date_end: content.event.dateEnd, link_href: content.event.link, visual: content.event.visual, visual_alt: content.event.visualAlt } : null,
      social: (content.social || []).filter(s => s.href).map((s, i) => ({ id: 'social-' + i, label: s.label, href: s.href, sub: s.sub })),
      about: content.about ? { ...content.about, identity_title: content.about.identityTitle, identity_tags: content.about.identityTags, biz_title: content.about.bizTitle, biz_tags: content.about.bizTags, visual: content.about.visual, visual_alt: content.about.visualAlt } : null,
      shop: content.shop || null,
      recruit: content.recruit || null,
    };
  }

  if (action === 'notices') {
    // 带 body：notice.html 列表项会进 notices 缓存，详情复用缓存、不再单独请求
    return { ok: true, items: (content.notices?.items || []).map(n => ({ id: n.id, date: n.date, type: n.type, style: n.style, summary: n.text || n.summary, title: n.title, cover: n.cover || '', cover_alt: n.cover_alt || '', body: n.body || [] })) };
  }

  if (action === 'notice') {
    const id = params.get('id');
    const n = (content.notices?.items || []).find(x => x.id === id);
    if (!n) return { error: 'not_found' };
    return { ok: true, ...n, body: n.body || [] };
  }

  if (action === 'brands') {
    return { ok: true, items: (content.brands?.items || []).map((b, i) => ({ id: 'brand-' + i, name: b.name, sub: b.sub, logo: b.logo, is_self: b.isSelf || false })) };
  }

  if (action === 'goods') {
    return { ok: true, items: (content.goods?.items || []).map((g, i) => ({ id: 'good-' + i, badge: g.badge, badge_style: g.badgeStyle, name: g.name, description: g.desc, image: g.image, image_alt: g.imageAlt, tags: g.tags, alt_label: g.alt, price: g.price, unit: g.unit, is_free: g.free || false, free_label: g.freeLabel || '' })) };
  }

  if (action === 'shop') {
    return { ok: true, ...(content.shop || {}) };
  }

  // recruit 在 content.json 里本就是后端的 snake_case 形状
  if (action === 'recruit') {
    return { ok: true, recruit: content.recruit || null };
  }

  if (action === 'settings') {
    // 真后端把 site_settings 的键原样返回（snake_case），kebab/驼峰都不对，
    // 所以这里要转换 —— 否则 assets/site.js 在 mock 上会「改了没反应」。
    const st = {};
    for (const [k, v] of Object.entries(content.site || {})) {
      const key = k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
      st[key] = key === 'show_admin_entry' ? String(v) : v;
    }
    return { ok: true, ...st };
  }

  if (action === 'hero') {
    return { ok: true, ...(content.hero || {}) };
  }

  if (action === 'social') {
    return { ok: true, items: (content.social || []).filter(s => s.href).map((s, i) => ({ id: 'social-' + i, label: s.label, href: s.href, sub: s.sub })) };
  }

  if (action === 'about') {
    const a = content.about || {};
    return { ok: true, ...a, identity_title: a.identityTitle, identity_tags: a.identityTags, biz_title: a.bizTitle, biz_tags: a.bizTags, visual: a.visual, visual_alt: a.visualAlt };
  }

  if (action === 'events') {
    return { ok: true, items: content.event ? [{ ...content.event, date_start: content.event.date, date_end: content.event.dateEnd, link_href: content.event.link, visual: content.event.visual, visual_alt: content.event.visualAlt }] : [] };
  }

  if (action === 'list_images') {
    return { error: 'storage_unavailable' };
  }

  // POST actions (mock - just return ok)
  if (action.startsWith('save_') || action.startsWith('delete_') || action === 'upload_image') {
    return { ok: true };
  }

  return { error: 'unknown_action' };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API 路由
  if (url.pathname === '/functions/v1/app') {
    const action = url.searchParams.get('action');
    const result = mockApi(action, req.url);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
    return;
  }

  // 静态文件
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = join(WEB, filePath);

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404 - 页面未找到</h1>');
    return;
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const body = readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mime });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  本地预览已启动`);
  console.log(`  http://127.0.0.1:${PORT}/`);
  console.log(`  管理后台: http://127.0.0.1:${PORT}/admin.html`);
  console.log(`  (admin / gpic2026)\n`);
  console.log(`  [mock] API 使用 content.json 数据（只读）`);
  console.log(`  [mock] 写入操作返回 ok 但不持久化\n`);
});
