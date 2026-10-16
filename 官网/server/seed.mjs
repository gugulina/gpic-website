// ═══════════════════════════════════════════════════════════════════
//  server/seed.mjs · 把 data/content.json 灌进自持真库 + 建主催账号
// ═══════════════════════════════════════════════════════════════════
//
//  这个脚本替掉两件事：
//    · dev/seed-database.mjs    —— 原来往 Qoder 线上 API 灌数据（依赖公网 + 额度）
//    · dev/create-organizer.mjs —— 原来硬编码 admin / 明文密码建号
//
//  区别：
//    1. 直接写本地 SQLite，不走 HTTP、不依赖任何线上服务
//    2. 账号密码从 --password / GPIC_ADMIN_PASSWORD 读；都没给就现场生成一个强口令
//       并打印出来（明文永不写进代码、永不进仓库）
//    3. 幂等：反复执行只会把内容刷新到 content.json 的当前状态，不会插重复行
//
//  用法：
//    node server/seed.mjs                          # 增量导入（推荐）
//    node server/seed.mjs --reset                  # 先清空内容表再导入（保留账号）
//    node server/seed.mjs --username admin --password '你的口令'
//    node server/seed.mjs --reset --reset-users     # 连账号一起重来
//
//  ⚠️ 只有 node: 内置模块，零 npm 依赖。
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const DB_FILE = opt("db", process.env.GPIC_DB || join(__dirname, "data", "gpic.sqlite"));
const CONTENT_FILE = opt("content", join(ROOT, "data", "content.json"));
const RESET = flag("reset");
const RESET_USERS = flag("reset-users") || flag("reset-all");
const USERNAME = opt("username", "admin");
const ROLE = opt("role", "organizer") === "admin" ? "admin" : "organizer";
const FORCE_PASSWORD = flag("force-password");

// ── 口令哈希（与 functions/handler.mjs 完全同一套，登录才能对得上）────
function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 生成一个好念的强口令（避开 0/O/1/l/I 这类易混字符）
function generatePassword(length = 16) {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join("");
}

// ── 工具 ────────────────────────────────────────────────────────────
const camelToSnake = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const nowIso = () => new Date().toISOString();
// 生成确定性 UUID（版本 4 / 变体 8 形状，能过 handler 里的 uuidRe 校验）。
// 用固定 id 而不是随机 id，是为了让反复 seed 走 upsert 而不插重复行。
const sentinel = (prefix, index) =>
  `${String(prefix).padEnd(8, "0").slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;

const log = [];
function step(name, detail = "") {
  log.push({ name, detail, ok: true });
  const tail = detail ? `  ${detail}` : "";
  console.log(`  ✓ ${name}${tail}`);
}

function fail(name, detail) {
  log.push({ name, detail, ok: false });
  console.log(`  ✗ ${name}  ${detail}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────

if (!existsSync(CONTENT_FILE)) {
  console.error(`\n  ✗ 找不到内容源文件：${CONTENT_FILE}\n`);
  process.exit(1);
}

const content = JSON.parse(readFileSync(CONTENT_FILE, "utf-8"));
console.log("");
console.log("  幻想乡电力投资集团 官网 · 数据导入");
console.log("  ─────────────────────────────────────────────");
console.log(`  数据源    ${CONTENT_FILE}`);
console.log(`  目标库    ${DB_FILE}`);
console.log(`  模式      ${RESET ? "清空内容表后导入" : "增量导入（upsert）"}${RESET_USERS ? " + 重置账号" : ""}`);
console.log("  ─────────────────────────────────────────────");

const { client, close } = openDatabase(DB_FILE);

// 单行表 + 列表表用固定 uuid，保证反复 seed 不会插重复
const HERO_ID = "00000000-0000-0000-0000-000000000001";
const ABOUT_ID = "00000000-0000-0000-0000-000000000001";
const EVENT_ID = sentinel("2000000", 1);

// ── 清空 ────────────────────────────────────────────────────────────
if (RESET) {
  const contentTables = ["site_settings", "hero_content", "notices", "brands", "goods", "events", "social_links", "about_content"];
  for (const table of contentTables) {
    // 全表删除：neq 一个不可能存在的哨兵值，语义上等价于 TRUNCATE
    await client.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
  }
  // site_settings 主键是 key 不是 id，单独再来一次
  await client.from("site_settings").delete().neq("key", "__never__");
  step("清空内容表", `${contentTables.length} 张`);
}

if (RESET_USERS) {
  await client.from("auth_sessions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await client.from("users").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  step("清空账号与会话");
}

// ── 1. 站点设置 ─────────────────────────────────────────────────────
{
  const t = nowIso();
  let count = 0;
  for (const [key, value] of Object.entries(content.site || {})) {
    const snake = camelToSnake(key);
    // handler 的 save_settings 契约要求 value 恒为字符串，所以布尔也转成 "true"/"false"
    const stored = typeof value === "string" ? value : String(value);
    const { error } = await client.from("site_settings").upsert({ key: snake, value: stored, updated_at: t });
    if (error) {
      fail("站点设置", `${snake}: ${error.message}`);
      break;
    }
    count++;
  }
  step("站点设置", `${count} 项`);
}

// ── 2. 通贩商店（存成 site_settings 的一条 shop JSON）──────────────
{
  const shop = content.shop || {};
  const payload = JSON.stringify({
    title: shop.title || "",
    desc: shop.desc || "",
    links: (shop.links || []).map((l) => ({
      label: l.label || "",
      href: l.href || "",
      sub: l.sub || "",
    })),
    note: shop.note || "",
  });
  const { error } = await client.from("site_settings").upsert({ key: "shop", value: payload, updated_at: nowIso() });
  if (error) fail("通贩商店", error.message);
  else step("通贩商店", `${(shop.links || []).length} 个渠道`);
}

// ── 2b. 人员招募（同样存成 site_settings 的一条 recruit JSON）────────
{
  const r = content.recruit || {};
  const howItems = r.how_items || r.howItems || [];
  const payload = JSON.stringify({
    badge: r.badge || "",
    title: r.title || "",
    intro: r.intro || "",
    deadline: r.deadline || "",
    contact_qq: r.contact_qq || r.contactQq || "",
    contact_url: r.contact_url || r.contactUrl || "",
    jobs: (r.jobs || []).map((j) => ({
      title: j.title || "",
      rows: (j.rows || []).map((x) => ({ label: x.label || "", value: x.value || "" })),
    })),
    how_items: howItems.filter((x) => typeof x === "string"),
    notes: (r.notes || []).filter((x) => typeof x === "string"),
    cta_slogan: r.cta_slogan || r.ctaSlogan || "",
    cta_text: r.cta_text || r.ctaText || "",
    cta_button: r.cta_button || r.ctaButton || "",
  });
  const { error } = await client.from("site_settings").upsert({ key: "recruit", value: payload, updated_at: nowIso() });
  if (error) fail("人员招募", error.message);
  else step("人员招募", `${(r.jobs || []).length} 个岗位 / ${howItems.length} 条报名说明`);
}

// ── 3. 首页横幅 ─────────────────────────────────────────────────────
{
  const hero = content.hero || {};
  const { error } = await client.from("hero_content").upsert({
    id: HERO_ID,
    banner: hero.banner || "",
    banner_fallback: hero.bannerFallback || "",
    banner_alt: hero.bannerAlt || "",
    badge: hero.badge || "",
    title: hero.title || "",
    body: hero.body || "",
    sub: hero.sub || "",
    actions: (hero.actions || []).map((a) => ({ label: a.label, href: a.href, style: a.style })),
    stats: (hero.stats || []).map((s) => ({ num: s.num, label: s.label })),
    updated_at: nowIso(),
  });
  if (error) fail("首页横幅", error.message);
  else step("首页横幅", `${(hero.stats || []).length} 项数据`);
}

// ── 4. 公告 ─────────────────────────────────────────────────────────
{
  const items = (content.notices && content.notices.items) || [];
  const t = nowIso();
  let count = 0;
  for (const n of items) {
    const { error } = await client.from("notices").upsert({
      id: n.id,
      date: n.date || "",
      type: n.type || "",
      style: n.style || "green",
      summary: n.text || n.summary || "",
      title: n.title || "",
      cover: n.cover || "",
      cover_alt: n.coverAlt || "",
      body: n.body || [],
      created_at: n.createdAt || t,
      updated_at: t,
    });
    if (error) {
      fail("公告", `${n.id}: ${error.message}`);
      break;
    }
    count++;
  }
  const blocks = items.reduce((sum, n) => sum + (Array.isArray(n.body) ? n.body.length : 0), 0);
  step("公告", `${count} 篇 / ${blocks} 个区块`);
}

// ── 5. 品牌 ─────────────────────────────────────────────────────────
{
  const items = (content.brands && content.brands.items) || [];
  const t = nowIso();
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const b = items[i];
    const { error } = await client.from("brands").upsert({
      id: sentinel("0000000", i + 1),
      name: b.name || "",
      sub: b.sub || "",
      logo: b.logo || "",
      is_self: !!b.isSelf,
      display_order: i,
      updated_at: t,
    });
    if (error) {
      fail("品牌", `${b.name}: ${error.message}`);
      break;
    }
    count++;
  }
  step("品牌", `${count} 个`);
}

// ── 6. 制品 ─────────────────────────────────────────────────────────
{
  const items = (content.goods && content.goods.items) || [];
  const t = nowIso();
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const g = items[i];
    const { error } = await client.from("goods").upsert({
      id: sentinel("1000000", i + 1),
      badge: g.badge || "",
      badge_style: g.badgeStyle || "green",
      name: g.name || "",
      description: g.desc || "",
      image: g.image || "",
      image_alt: g.imageAlt || "",
      tags: g.tags || [],
      alt_label: g.alt || "",
      price: g.price || "",
      unit: g.unit || "",
      is_free: !!g.free,
      free_label: g.freeLabel || "",
      display_order: i,
      updated_at: t,
    });
    if (error) {
      fail("制品", `${g.name}: ${error.message}`);
      break;
    }
    count++;
  }
  step("制品", `${count} 款`);
}

// ── 7. 参展活动 ─────────────────────────────────────────────────────
{
  const e = content.event;
  if (!e) {
    step("参展活动", "content.json 无 event，跳过");
  } else {
    const { error } = await client.from("events").upsert({
      id: EVENT_ID,
      badge: e.badge || "",
      title: e.title || "",
      subtitle: e.subtitle || "",
      booth: e.booth || "",
      debut: e.debut || "",
      date_start: e.date || "",
      date_end: e.dateEnd || "",
      link_label: e.linkLabel || "",
      link_href: e.link || "",
      visual: e.visual || "",
      visual_alt: e.visualAlt || "",
      updated_at: nowIso(),
    });
    if (error) fail("参展活动", error.message);
    else step("参展活动", `${e.title || "（无标题）"} · ${e.booth || "无摊位号"}`);
  }
}

// ── 8. 社交链接（整表重建，顺序即 display_order）────────────────────
{
  const items = (content.social || []).filter((s) => s && s.label);
  await client.from("social_links").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  const t = nowIso();
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const { error } = await client.from("social_links").insert({
      id: sentinel("3000000", i + 1),
      label: s.label,
      href: s.href || "",
      sub: s.sub || "",
      display_order: i,
      updated_at: t,
    });
    if (error) {
      fail("社交链接", `${s.label}: ${error.message}`);
      break;
    }
    count++;
  }
  step("社交链接", `${count} 条`);
}

// ── 9. 关于我们 ─────────────────────────────────────────────────────
{
  const a = content.about || {};
  const { error } = await client.from("about_content").upsert({
    id: ABOUT_ID,
    badge: a.badge || "",
    title: a.title || "",
    subtitle: a.subtitle || "",
    paragraphs: a.paragraphs || [],
    identity_title: a.identityTitle || "",
    identity_tags: a.identityTags || [],
    biz_title: a.bizTitle || "",
    biz_tags: a.bizTags || [],
    visual: a.visual || "",
    visual_alt: a.visualAlt || "",
    updated_at: nowIso(),
  });
  if (error) fail("关于我们", error.message);
  else step("关于我们", `${(a.paragraphs || []).length} 段`);
}

// ── 10. 主催账号 ────────────────────────────────────────────────────
let issuedPassword = null;
{
  const existing = await client.from("users").select("id,username,role").eq("username", USERNAME).maybeSingle();
  if (existing.error) {
    fail("主催账号", existing.error.message);
  } else if (existing.data && !FORCE_PASSWORD) {
    step("主催账号", `${USERNAME} 已存在（未改动口令，要改加 --force-password）`);
  } else {
    const supplied = opt("password", process.env.GPIC_ADMIN_PASSWORD || null);
    const password = supplied || generatePassword(16);
    if (!supplied) issuedPassword = password;

    const salt = randomSalt();
    const hash = await hashPassword(password, salt);
    const t = nowIso();

    if (existing.data) {
      const { error } = await client.from("users")
        .update({ password_hash: hash, password_salt: salt, role: ROLE, updated_at: t })
        .eq("id", existing.data.id);
      if (error) fail("主催账号", error.message);
      else step("主催账号", `${USERNAME} 口令已重置`);
    } else {
      const { error } = await client.from("users").insert({
        id: crypto.randomUUID(),
        username: USERNAME,
        password_hash: hash,
        password_salt: salt,
        role: ROLE,
        created_at: t,
        updated_at: t,
      });
      if (error) fail("主催账号", error.message);
      else step("主催账号", `${USERNAME} 已创建（角色 ${ROLE}）`);
    }
  }
}

// ── 结果自检 ────────────────────────────────────────────────────────
console.log("  ─────────────────────────────────────────────");
const checks = [];
for (const table of ["site_settings", "hero_content", "notices", "brands", "goods", "events", "social_links", "about_content", "users"]) {
  const { count } = await client.from(table).select("*", { count: "exact", head: true });
  checks.push([table, count]);
}
console.log("  入库自检");
for (const [table, count] of checks) {
  console.log(`    ${table.padEnd(16)} ${String(count).padStart(4)} 行`);
}

if (issuedPassword) {
  console.log("  ─────────────────────────────────────────────");
  console.log("  ⚠️  已生成随机主催口令（只显示这一次，请立刻抄走）");
  console.log("");
  console.log(`      用户名  ${USERNAME}`);
  console.log(`      口令    ${issuedPassword}`);
  console.log("");
  console.log("      想换成自己定的口令，重跑：");
  console.log(`        node server/seed.mjs --username ${USERNAME} --password '你的口令' --force-password`);
} else {
  console.log("  ─────────────────────────────────────────────");
  console.log(`  登录账号  ${USERNAME}（口令为你指定的那个）`);
}

const failed = log.filter((entry) => !entry.ok);
console.log("");
console.log(failed.length === 0 ? "  ✓ 导入完成，无失败项" : `  ✗ 有 ${failed.length} 项失败，见上方日志`);
console.log("");

close();
process.exit(failed.length === 0 ? 0 : 1);
