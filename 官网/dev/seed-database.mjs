// 将 content.json 导入到已部署的数据库
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const API = 'https://gpic-site-v5i875hpip7.qoder.zone/functions/v1/app';

const content = JSON.parse(readFileSync(join(ROOT, 'data', 'content.json'), 'utf-8'));
const results = [];

async function post(action, body) {
  const r = await fetch(`${API}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://gpic-site-v5i875hpip7.qoder.zone' },
    body: JSON.stringify(body),
  });
  return r.json();
}

// 1. 站点设置
console.log('导入站点设置…');
const siteData = {};
for (const [k, v] of Object.entries(content.site)) {
  if (typeof v === 'string') {
    // camelCase → snake_case
    const snake = k.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
    siteData[snake] = v;
  }
}
let r = await post('save_settings', siteData);
results.push(['站点设置', r.ok ? 'ok' : JSON.stringify(r)]);

// 1b. 通贩商店 —— 存在 site_settings 的 shop 键里，一条 JSON（不建新表）
console.log('导入通贩商店…');
const shopSrc = content.shop || {};
r = await post('save_shop', {
  title: shopSrc.title || '',
  desc: shopSrc.desc || '',
  links: (shopSrc.links || []).map(l => ({ label: l.label, href: l.href || '', sub: l.sub || '' })),
  note: shopSrc.note || '',
});
results.push(['通贩商店', r.ok ? 'ok' : JSON.stringify(r)]);

// 1c. 人员招募 —— 同样存在 site_settings 的 recruit 键里
console.log('导入人员招募…');
const recSrc = content.recruit || {};
r = await post('save_recruit', {
  badge: recSrc.badge || '',
  title: recSrc.title || '',
  intro: recSrc.intro || '',
  deadline: recSrc.deadline || '',
  contact_qq: recSrc.contact_qq || recSrc.contactQq || '',
  contact_url: recSrc.contact_url || recSrc.contactUrl || '',
  jobs: (recSrc.jobs || []).map(j => ({
    title: j.title || '',
    rows: (j.rows || []).map(x => ({ label: x.label || '', value: x.value || '' })),
  })),
  how_items: recSrc.how_items || recSrc.howItems || [],
  notes: recSrc.notes || [],
  cta_slogan: recSrc.cta_slogan || recSrc.ctaSlogan || '',
  cta_text: recSrc.cta_text || recSrc.ctaText || '',
  cta_button: recSrc.cta_button || recSrc.ctaButton || '',
});
results.push(['人员招募', r.ok ? 'ok' : JSON.stringify(r)]);

// 2. 首页横幅
console.log('导入首页横幅…');
r = await post('save_hero', {
  banner: content.hero.banner || '',
  banner_fallback: content.hero.bannerFallback || '',
  banner_alt: content.hero.bannerAlt || '',
  badge: content.hero.badge || '',
  title: content.hero.title || '',
  body: content.hero.body || '',
  sub: content.hero.sub || '',
  actions: (content.hero.actions || []).map(a => ({ label: a.label, href: a.href, style: a.style })),
  stats: (content.hero.stats || []).map(s => ({ num: s.num, label: s.label })),
});
results.push(['首页横幅', r.ok ? 'ok' : JSON.stringify(r)]);

// 3. 公告
console.log('导入公告…');
for (const n of content.notices.items) {
  r = await post('save_notice', {
    id: n.id,
    date: n.date,
    type: n.type,
    style: n.style,
    summary: n.text || '',
    title: n.title,
    cover: n.cover || '',
    cover_alt: n.coverAlt || '',
    body: n.body || [],
  });
  if (!r.ok) { results.push(['公告 ' + n.id, r.error]); break; }
}
results.push(['公告 (' + content.notices.items.length + ')', 'done']);

// 4. 品牌 - 先清理旧数据
console.log('清理旧品牌数据…');
const existingBrands = await (await fetch(`${API}?action=brands`, { headers: { 'Origin': 'https://gpic-site-v5i875hpip7.qoder.zone' } })).json();
if (existingBrands.ok && existingBrands.items) {
  for (const b of existingBrands.items) {
    await fetch(`${API}?action=delete_brand&id=${b.id}`, { method: 'POST', headers: { 'Origin': 'https://gpic-site-v5i875hpip7.qoder.zone' } });
  }
}
console.log('导入品牌…');
for (let i = 0; i < content.brands.items.length; i++) {
  const b = content.brands.items[i];
  const id = `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;
  r = await post('save_brand', {
    id,
    name: b.name,
    sub: b.sub,
    logo: b.logo,
    is_self: b.isSelf || false,
    display_order: i,
  });
  if (!r.ok) { results.push(['品牌', r.error]); break; }
}
results.push(['品牌 (' + content.brands.items.length + ')', 'done']);

// 5. 商品 - 先清理旧数据
console.log('清理旧商品数据…');
const existingGoods = await (await fetch(`${API}?action=goods`, { headers: { 'Origin': 'https://gpic-site-v5i875hpip7.qoder.zone' } })).json();
if (existingGoods.ok && existingGoods.items) {
  for (const g of existingGoods.items) {
    await fetch(`${API}?action=delete_good&id=${g.id}`, { method: 'POST', headers: { 'Origin': 'https://gpic-site-v5i875hpip7.qoder.zone' } });
  }
}
console.log('导入商品…');
for (let i = 0; i < content.goods.items.length; i++) {
  const g = content.goods.items[i];
  const id = `10000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`;
  r = await post('save_good', {
    id,
    badge: g.badge,
    badge_style: g.badgeStyle,
    name: g.name,
    description: g.desc,
    image: g.image,
    image_alt: g.imageAlt || '',
    tags: g.tags || [],
    alt_label: g.alt || '',
    price: g.price || '',
    unit: g.unit || '',
    is_free: g.free || false,
    free_label: g.freeLabel || '',
    display_order: i,
  });
  if (!r.ok) { results.push(['商品', r.error]); break; }
}
results.push(['商品 (' + content.goods.items.length + ')', 'done']);

// 6. 活动
console.log('导入参展活动…');
r = await post('save_event', {
  badge: content.event.badge || '',
  title: content.event.title || '',
  subtitle: content.event.subtitle || '',
  booth: content.event.booth || '',
  debut: content.event.debut || '',
  date_start: content.event.date || '',
  date_end: content.event.dateEnd || '',
  link_label: content.event.linkLabel || '',
  link_href: content.event.link || '',
  visual: content.event.visual || '',
  visual_alt: content.event.visualAlt || '',
});
results.push(['参展活动', r.ok ? 'ok' : JSON.stringify(r)]);

// 7. 社交链接
console.log('导入社交链接…');
r = await post('save_social', {
  items: content.social.filter(s => s.label).map(s => ({ label: s.label, href: s.href || '', sub: s.sub || '' })),
});
results.push(['社交链接', r.ok ? 'ok' : JSON.stringify(r)]);

// 8. 关于我们
console.log('导入关于我们…');
r = await post('save_about', {
  badge: content.about.badge || '',
  title: content.about.title || '',
  subtitle: content.about.subtitle || '',
  paragraphs: content.about.paragraphs || [],
  identity_title: content.about.identityTitle || '',
  identity_tags: content.about.identityTags || [],
  biz_title: content.about.bizTitle || '',
  biz_tags: content.about.bizTags || [],
  visual: content.about.visual || '',
  visual_alt: content.about.visualAlt || '',
});
results.push(['关于我们', r.ok ? 'ok' : JSON.stringify(r)]);

// 汇总
console.log('\n═══ 导入结果 ═══');
for (const [name, status] of results) {
  const mark = status === 'done' || status === true ? '✓' : '✗';
  console.log(`  ${mark} ${name}: ${status}`);
}
console.log('');
