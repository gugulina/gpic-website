// ═══════════════════════════════════════════════════════════════════
//  server/e2e-test.mjs · 自持动态站端到端回归测试
// ═══════════════════════════════════════════════════════════════════
//
//  打真后端、真数据库、真文件系统。不 mock 任何东西 —— 目的就是证明
//  「handler.mjs + SQLite + 本地存储」这三件套拼起来之后确实能跑。
//
//  覆盖：
//    A. 12 个 GET action 及其返回结构
//    B. 参数非法 / 未知 action / 未登录 等错误分支的 HTTP 状态码
//    C. 登录 → 令牌 → 带令牌写 → 读回 → 登出 的完整会话链路
//    D. 19 个 action 全部至少调用一次
//    E. 图片上传落盘 + list_images + 静态访问
//    F. 静态站点 4 个页面 + 资源 + 404 兜底
//
//  用法（先起服务）：
//    node server/index.mjs --port 4399 --db server/data/test.sqlite
//    node server/e2e-test.mjs --base http://127.0.0.1:4399 --password test123456
//
//  ⚠️ 请对「刚 seed 过」的库运行。测试会改写内容表（hero/about/settings/shop/recruit/social），
//      A 段落里的行数断言依赖 content.json 的原始条目数；连跑两次会因为内容已被
//      上一次改写而失败。重跑前先 `node server/seed.mjs --reset`。
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith("--")) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const BASE = opt("base", process.env.GPIC_BASE || "http://127.0.0.1:4399");
const API = `${BASE}/functions/v1/app`;
const USERNAME = opt("username", "admin");
const PASSWORD = opt("password", process.env.GPIC_ADMIN_PASSWORD || "test123456");

// 内容类断言不写死数字：商品和公告会随运营增减，写死就会频繁假红
// （2026-10-19 新增透卡商品 + 参展记录公告，一次红掉三条）。
const SEED = JSON.parse(readFileSync(join(ROOT, "data", "content.json"), "utf8"));

// ── 测试框架（够用就行，不引依赖）────────────────────────────────
let passed = 0;
const failures = [];
let group = "";

function section(name) {
  group = name;
  console.log(`\n  ── ${name} ${"─".repeat(Math.max(0, 46 - name.length))}`);
}

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`    ✓ ${label}${detail ? `  ${detail}` : ""}`);
  } else {
    failures.push({ group, label, detail });
    console.log(`    ✗ ${label}${detail ? `  ${detail}` : ""}`);
  }
}

// ── HTTP 小工具 ────────────────────────────────────────────────────
let sessionId = null;
let loginCookie = null;

async function api(action, { method = "GET", body, headers = {}, query = "", auth = false, session, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  // session 显式覆盖，用来模拟「另一个账号」的身份
  const sid = session === undefined ? sessionId : session;
  if (auth && sid) h["x-session-id"] = sid;
  const res = await fetch(`${API}?action=${action}${query}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return raw ? { status: res.status, data, res } : { ...(data || {}), __status: res.status };
}

// ═══════════════════════════════════════════════════════════════════

console.log("");
console.log("  自持动态站 · 端到端测试");
console.log("  ═══════════════════════════════════════════════════════");
console.log(`  目标  ${BASE}`);
console.log(`  账号  ${USERNAME}`);

// ── A. GET actions ─────────────────────────────────────────────────
section("A. GET actions（12 个）");

const all = await api("all");
check("all 返回 ok", all.ok === true);
check("all.site 有 16 项", Object.keys(all.site || {}).length === 16, `实际 ${Object.keys(all.site || {}).length}`);
check("all.hero 单行对象", !!all.hero && all.hero.title?.length > 0);
check("all.hero.actions 是数组", Array.isArray(all.hero?.actions) && all.hero.actions.length > 0);
check("all.notices 是数组且不含 body", Array.isArray(all.notices) && !("body" in (all.notices[0] || {})));
check("all.brands 有序", Array.isArray(all.brands) && all.brands.length === 5);
check("all.goods 有序", Array.isArray(all.goods) && all.goods.length === SEED.goods.items.length, `${all.goods?.length} vs 内容文件 ${SEED.goods.items.length}`);
check("all.event 单行对象", !!all.event && all.event.booth?.length > 0);
check("all.social 是数组", Array.isArray(all.social) && all.social.length === 6);
check("all.about 单行对象", !!all.about && all.about.title?.length > 0);
check("all.shop 已从 site 里摘出", !!all.shop && !("shop" in all.site), `shop.title=${all.shop?.title}`);
check("all.recruit 已从 site 里摘出", !!all.recruit && !("recruit" in all.site), `recruit.title=${all.recruit?.title}`);
check("all.recruit 结构与 seed 一致", all.recruit?.jobs?.length === 4 &&
  all.recruit.jobs.reduce((n, j) => n + j.rows.length, 0) === 11 &&
  all.recruit.how_items?.length === 4 && all.recruit.notes?.length === 4,
  `岗位=${all.recruit?.jobs?.length} 说明=${all.recruit?.how_items?.length}`);

const notices = await api("notices");
check("notices 带 body", notices.ok === true && Array.isArray(notices.items) && "body" in notices.items[0]);
check("notices 篇数与内容文件一致", notices.items.length === SEED.notices.items.length, `${notices.items.length} vs ${SEED.notices.items.length}`);
check("notices 按日期倒序", notices.items[0].date >= notices.items[notices.items.length - 1].date, `${notices.items[0].date} → ${notices.items[notices.items.length - 1].date}`);
const blockTotal = notices.items.reduce((s, n) => s + (Array.isArray(n.body) ? n.body.length : 0), 0);
const seedBlocks = SEED.notices.items.reduce((s, n) => s + (Array.isArray(n.body) ? n.body.length : 0), 0);
check("notices 的 blocks 已还原为数组", blockTotal === seedBlocks, `共 ${blockTotal} 个区块，内容文件 ${seedBlocks}`);

const one = await api("notice", { query: "&id=2026-09-20-a" });
check("notice 单篇详情", one.ok === true && one.id === "2026-09-20-a");
check("notice.body 是 20 个区块", Array.isArray(one.body) && one.body.length === 20);

for (const [action, expectKey] of [["settings", "name"], ["hero", "title"], ["brands", "items"], ["goods", "items"], ["events", "items"], ["social", "items"], ["about", "title"], ["shop", "title"], ["recruit", "recruit"]]) {
  const r = await api(action);
  check(`${action} 可用`, r.ok === true && expectKey in r, `HTTP ${r.__status}`);
}

const images = await api("list_images");
check("list_images 走本地存储不报 storage_unavailable", images.ok === true, `items=${(images.items || []).length}`);

// ── B. 错误分支 ────────────────────────────────────────────────────
section("B. 错误分支与状态码");

const noAction = await fetch(API);
check("缺 action → 400", noAction.status === 400, `HTTP ${noAction.status}`);

const unknown = await api("no_such_action");
check("未知 action → 404", unknown.__status === 404, `HTTP ${unknown.__status}`);

const badId = await api("notice", { query: "&id=NOT-A-VALID-ID" });
check("非法公告 id → 400", badId.__status === 400 && badId.error === "invalid_id", `HTTP ${badId.__status}`);

const missing = await api("notice", { query: "&id=2099-12-31-zz" });
check("不存在的公告 → 404", missing.__status === 404 && missing.error === "not_found", `HTTP ${missing.__status}`);

const unauth = await api("save_settings", { method: "POST", body: { name: "x" } });
check("未登录写操作 → 401", unauth.__status === 401 && unauth.error === "login_required", `HTTP ${unauth.__status}`);

const badLogin = await api("login", { method: "POST", body: { username: USERNAME, password: "definitely-wrong" } });
check("错误口令 → 401", badLogin.__status === 401 && badLogin.error === "invalid_credentials", `HTTP ${badLogin.__status}`);

const shortPwd = await api("create_user", { method: "POST", body: {} });
check("未登录 create_user → 401", shortPwd.__status === 401, `HTTP ${shortPwd.__status}`);

// ── C. 登录 ────────────────────────────────────────────────────────
section("C. 登录与会话");

const login = await api("login", { method: "POST", body: { username: USERNAME, password: PASSWORD }, raw: true });
check("登录成功 → 200", login.status === 200, `HTTP ${login.status}`);
check("返回 session_id", typeof login.data?.session_id === "string" && login.data.session_id.length >= 32);
check("返回 user 且角色为 organizer", login.data?.user?.role === "organizer", `role=${login.data?.user?.role}`);
const setCookie = login.res.headers.getSetCookie();
check("下发会话 Cookie", Array.isArray(setCookie) && setCookie.some((c) => c.startsWith("gpic_session=")), setCookie?.[0]?.split(";")[0]);
sessionId = login.data?.session_id;
loginCookie = setCookie?.find((c) => c.startsWith("gpic_session="))?.split(";")[0];

const me = await api("list_users", { method: "POST", auth: true, body: {} });
check("带 x-session-id 可通过鉴权", me.ok === true, `items=${me.items?.length}`);
check("list_users 返回 items 数组", Array.isArray(me.items) && me.items.length >= 1, `${JSON.stringify(me.items?.[0])}`);

const viaCookie = await fetch(`${API}?action=list_users`, {
  method: "POST",
  headers: { cookie: loginCookie, "content-type": "application/json" },
  body: "{}",
});
const viaCookieData = await viaCookie.json();
check("带 Cookie 也可通过鉴权", viaCookieData.ok === true, `HTTP ${viaCookie.status}`);

// ── D. 写操作（覆盖剩余全部 action）────────────────────────────────
section("D. 写操作（19 个 action 全覆盖）");

const rSettings = await api("save_settings", { method: "POST", auth: true, body: { footer_note: "端到端测试写入" } });
check("save_settings", rSettings.ok === true, JSON.stringify(rSettings));
const settingsBack = await api("settings");
check("save_settings 读回一致", settingsBack.footer_note === "端到端测试写入", `footer_note=${settingsBack.footer_note}`);

const rShop = await api("save_shop", { method: "POST", auth: true, body: { title: "通贩商店（测试）", desc: "e2e", links: [{ label: "淘宝", href: "https://example.com", sub: "主店" }], note: "e2e note" } });
check("save_shop", rShop.ok === true, JSON.stringify(rShop));
const shopBack = await api("shop");
check("save_shop 读回一致", shopBack.title === "通贩商店（测试）" && shopBack.links?.length === 1, `links=${shopBack.links?.length}`);
const shopBad = await api("save_shop", { method: "POST", auth: true, body: { title: 123, links: [] } });
check("save_shop 非法 title → 400", shopBad.__status === 400, `HTTP ${shopBad.__status}`);

const rRecruit = await api("save_recruit", { method: "POST", auth: true, body: {
  badge: "测试字号", title: "人员招募（测试）", intro: "i", deadline: "2099 年 1 月 1 日",
  contact_qq: "123456", contact_url: "https://example.com/q",
  jobs: [{ title: "测试岗位", rows: [{ label: "岗位职责", value: "做**测试**" }] }],
  how_items: ["**报名时间**：现在"], notes: ["备注一"],
  cta_slogan: "s", cta_text: "t", cta_button: "b",
} });
check("save_recruit", rRecruit.ok === true, JSON.stringify(rRecruit));
const recBack = await api("recruit");
check("save_recruit 读回一致", recBack.recruit?.title === "人员招募（测试）" &&
  recBack.recruit.jobs?.length === 1 && recBack.recruit.jobs[0].rows[0].value === "做**测试**" &&
  recBack.recruit.how_items?.length === 1 && recBack.recruit.notes?.length === 1,
  `job=${recBack.recruit?.jobs?.[0]?.title} how=${recBack.recruit?.how_items?.length}`);
const recBadTitle = await api("save_recruit", { method: "POST", auth: true, body: { title: 1, jobs: [], how_items: [], notes: [] } });
check("save_recruit 非法 title → 400", recBadTitle.__status === 400, `HTTP ${recBadTitle.__status}`);
const recBadJobs = await api("save_recruit", { method: "POST", auth: true, body: { title: "x", jobs: "not-array", how_items: [], notes: [] } });
check("save_recruit jobs 非数组 → 400", recBadJobs.__status === 400, `HTTP ${recBadJobs.__status}`);
const recBadRow = await api("save_recruit", { method: "POST", auth: true, body: { title: "x", jobs: [{ title: "j", rows: [{ label: "l" }] }], how_items: [], notes: [] } });
check("save_recruit 行缺 value → 400", recBadRow.__status === 400, `HTTP ${recBadRow.__status}`);
const recUnauth = await api("save_recruit", { method: "POST", body: { title: "x", jobs: [], how_items: [], notes: [] } });
check("save_recruit 未登录 → 401", recUnauth.__status === 401, `HTTP ${recUnauth.__status}`);

const rHero = await api("save_hero", { method: "POST", auth: true, body: { banner: "/assets/images/hero.webp", badge: "测试", title: "横幅标题（测试）", body: "b", sub: "s", actions: [{ label: "L", href: "#a", style: "primary" }], stats: [{ num: "1", label: "x" }] } });
check("save_hero", rHero.ok === true, JSON.stringify(rHero));
const heroBack = await api("hero");
check("save_hero 读回一致", heroBack.title === "横幅标题（测试）" && heroBack.actions?.length === 1, `actions=${heroBack.actions?.length}`);

const rNotice = await api("save_notice", { method: "POST", auth: true, body: { id: "2099-01-01-z", date: "2099-01-01", type: "测试", style: "green", summary: "s", title: "端到端测试公告", cover: "", cover_alt: "", body: [{ kind: "p", text: "第一段" }, { kind: "h", text: "小标题" }] } });
check("save_notice 新建", rNotice.ok === true, JSON.stringify(rNotice));
const noticeBack = await api("notice", { query: "&id=2099-01-01-z" });
check("save_notice 读回 body", noticeBack.title === "端到端测试公告" && noticeBack.body?.length === 2, `blocks=${noticeBack.body?.length}`);

const rNotice2 = await api("save_notice", { method: "POST", auth: true, body: { id: "2099-01-01-z", date: "2099-01-01", type: "测试", style: "gold", summary: "s2", title: "端到端测试公告（改）", body: [{ kind: "p", text: "改过了" }] } });
check("save_notice 走 update 分支", rNotice2.ok === true);
const noticeBack2 = await api("notice", { query: "&id=2099-01-01-z" });
check("update 生效且未插重复", noticeBack2.title === "端到端测试公告（改）" && noticeBack2.body?.length === 1, `blocks=${noticeBack2.body?.length}`);

const rBadNotice = await api("save_notice", { method: "POST", auth: true, body: { id: "bad id!", date: "2099-01-01", title: "x", body: [] } });
check("save_notice 非法 id → 400", rBadNotice.__status === 400, `HTTP ${rBadNotice.__status}`);

const rBrand = await api("save_brand", { method: "POST", auth: true, body: { name: "测试品牌", sub: "sub", logo: "/assets/images/x.webp", is_self: true, display_order: 99 } });
check("save_brand 新建（自动生成 uuid）", rBrand.ok === true && /^[0-9a-f-]{36}$/.test(rBrand.id || ""), `id=${rBrand.id}`);
const brandBack = await api("brands");
const createdBrand = brandBack.items.find((b) => b.id === rBrand.id);
check("save_brand 读回 is_self 为布尔 true", createdBrand?.is_self === true, `is_self=${createdBrand?.is_self} (${typeof createdBrand?.is_self})`);

const rBrandUp = await api("save_brand", { method: "POST", auth: true, body: { id: rBrand.id, name: "测试品牌（改）", sub: "s", logo: "", is_self: false, display_order: 99 } });
check("save_brand 走 upsert 更新", rBrandUp.ok === true && rBrandUp.id === rBrand.id);

const rGood = await api("save_good", { method: "POST", auth: true, body: { name: "测试制品", badge: "新", badge_style: "gold", description: "d", image: "/assets/images/goods-badge.webp", image_alt: "alt", tags: [{ text: "标签", key: true }], alt_label: "a", price: "12", unit: "元", is_free: false, free_label: "", display_order: 99 } });
check("save_good 新建", rGood.ok === true && /^[0-9a-f-]{36}$/.test(rGood.id || ""), `id=${rGood.id}`);
const goodBack = await api("goods");
const createdGood = goodBack.items.find((g) => g.id === rGood.id);
check("save_good 读回 tags 为数组", Array.isArray(createdGood?.tags) && createdGood.tags.length === 1, `tags=${JSON.stringify(createdGood?.tags)}`);
check("save_good 读回 is_free 为布尔", createdGood?.is_free === false, `is_free=${createdGood?.is_free} (${typeof createdGood?.is_free})`);

// 商品页工具区（海报 / 通贩 两张卡的文案与按钮）—— 2026-10-19 新增
const blockSave = await api("save_goods_block", { method: "POST", auth: true, body: {
  posterTitle: "海报卡", posterDesc: "d1", poster: "assets/images/goods-poster.webp", posterLabel: "看海报",
  buyTitle: "通贩卡", buyDesc: "d2", buyHref: "https://example.com/buy", buyLabel: "去买", note: "第一行\n第二行",
} });
check("save_goods_block", blockSave.ok === true, JSON.stringify(blockSave));
const goodsWithBlock = await api("goods");
check("goods 接口带回 block", goodsWithBlock.block?.buyLabel === "去买" && goodsWithBlock.block?.note.includes("\n"), JSON.stringify(goodsWithBlock.block));
const allWithBlock = await api("all");
check("all 接口带回 goodsBlock", allWithBlock.goodsBlock?.posterLabel === "看海报", JSON.stringify(allWithBlock.goodsBlock));
const badHref = await api("save_goods_block", { method: "POST", auth: true, body: { buyHref: "javascript:alert(1)" } });
check("save_goods_block 挡住 javascript: 链接", badHref.error === "invalid_href", JSON.stringify(badHref));

// ── 商品状态：售罄 / 下架 / 首页精选 ──────────────────────────────
// 三态的可见性差异是这组断言的重点：
//   售罄 → 公开接口仍返回、但排在在售之后
//   下架 → 公开接口完全不返回，后台仍能看到
const offId = rGood.id;                       // 刚新建的「测试制品」当成下架样本
const soldOutId = SEED.goods.items[0].id;     // 拿一件真实商品当售罄样本

const rOff = await api("set_good_status", { method: "POST", auth: true, body: { id: offId, status: "off_shelf" } });
check("set_good_status 标记下架", rOff.ok === true && rOff.status === "off_shelf", JSON.stringify(rOff));

const rSold = await api("set_good_status", { method: "POST", auth: true, body: { id: soldOutId, status: "sold_out" } });
check("set_good_status 标记售罄", rSold.ok === true && rSold.status === "sold_out", JSON.stringify(rSold));

const badStatus = await api("set_good_status", { method: "POST", auth: true, body: { id: soldOutId, status: "不存在的状态" } });
check("set_good_status 拒绝非法状态", badStatus.error === "invalid_status", JSON.stringify(badStatus));

const pubAfter = await api("goods");
check("下架商品不出现在公开 goods 接口", !pubAfter.items.some((g) => g.id === offId),
  `共 ${pubAfter.items.length} 条`);
check("售罄商品仍出现在公开 goods 接口", pubAfter.items.some((g) => g.id === soldOutId));
check("售罄商品排在所有在售商品之后",
  pubAfter.items.findIndex((g) => g.id === soldOutId) === pubAfter.items.length - 1,
  `位置 ${pubAfter.items.findIndex((g) => g.id === soldOutId)} / ${pubAfter.items.length - 1}`);
check("公开接口不下发 off_shelf 状态", !pubAfter.items.some((g) => g.status === "off_shelf"));

const allAfterStatus = await api("all");
check("all 接口同样过滤下架商品", !allAfterStatus.goods.some((g) => g.id === offId));

const adminList = await api("admin_goods", { auth: true });
const anonAdmin = await api("admin_goods");
check("admin_goods 匿名访问被拒", ["login_required", "session_expired"].includes(anonAdmin.error), `HTTP ${anonAdmin.__status}`);
check("admin_goods 含下架商品", Array.isArray(adminList.items) && adminList.items.some((g) => g.id === offId),
  `共 ${adminList.items?.length} 条`);

// 首页精选：只认列表里有的，顺序即数组顺序
const homeIds = [SEED.goods.items[2].id, SEED.goods.items[1].id];
const rHome = await api("save_home_goods", { method: "POST", auth: true, body: { ids: homeIds } });
check("save_home_goods 保存顺序", rHome.ok === true && JSON.stringify(rHome.homeGoods) === JSON.stringify(homeIds), JSON.stringify(rHome));
const allHome = await api("all");
check("all 接口回传 homeGoods 且保持顺序", JSON.stringify(allHome.homeGoods) === JSON.stringify(homeIds), JSON.stringify(allHome.homeGoods));

// 重复 id 要去重，但不能打乱首次出现的顺序
const rDup = await api("save_home_goods", { method: "POST", auth: true, body: { ids: [homeIds[0], homeIds[1], homeIds[0]] } });
check("save_home_goods 去重且顺序稳定", JSON.stringify(rDup.homeGoods) === JSON.stringify(homeIds), JSON.stringify(rDup.homeGoods));

const badHome = await api("save_home_goods", { method: "POST", auth: true, body: { ids: ["not-a-uuid"] } });
check("save_home_goods 拒绝非法 id", badHome.error === "invalid_id", JSON.stringify(badHome));

// 删商品时必须顺手把它从首页精选里摘掉，否则后台会留一条指向不存在商品的空条目
await api("save_home_goods", { method: "POST", auth: true, body: { ids: [offId, homeIds[0]] } });
const hb = await api("home_goods");
check("home_goods 读回刚写入的列表", hb.homeGoods && hb.homeGoods[0] === offId, JSON.stringify(hb.homeGoods));

const rDel = await api("delete_good", { method: "POST", auth: true, query: `&id=${offId}` });
check("delete_good 删除下架商品", rDel.ok === true, JSON.stringify(rDel));
const homeAfterDel = await api("home_goods");
check("删除商品后自动从首页精选摘除", !homeAfterDel.homeGoods.includes(offId), JSON.stringify(homeAfterDel.homeGoods));

// 复原售罄样本，避免影响后面的「首屏/静态断言」；首页精选也复位成「只有第一件」
await api("set_good_status", { method: "POST", auth: true, body: { id: soldOutId, status: "on_sale" } });
await api("save_home_goods", { method: "POST", auth: true, body: { ids: [SEED.goods.items[0].id] } });


const rEvent = await api("save_event", { method: "POST", auth: true, body: { badge: "测试展", title: "测试展会", subtitle: "sub", booth: "A01", debut: "首发", date_start: "2099-05-01", date_end: "2099-05-02", link_label: "详情", link_href: "https://example.com", visual: "", visual_alt: "" } });
check("save_event", rEvent.ok === true, `id=${rEvent.id}`);
const eventsBack = await api("events");
check("save_event 读回且倒序", eventsBack.items?.[0]?.title === "测试展会", `首条 ${eventsBack.items?.[0]?.title}`);

const rSocial = await api("save_social", { method: "POST", auth: true, body: { items: [{ label: "QQ 群", href: "https://example.com", sub: "8xxxx" }, { label: "B站", href: "https://example.com", sub: "官号" }] } });
check("save_social（整表重建）", rSocial.ok === true);
const socialBack = await api("social");
check("save_social 读回 2 条且顺序正确", socialBack.items?.length === 2 && socialBack.items[0].label === "QQ 群", `首条 ${socialBack.items?.[0]?.label}`);

const rAbout = await api("save_about", { method: "POST", auth: true, body: { badge: "测试", title: "关于（测试）", subtitle: "sub", paragraphs: ["一段", "二段"], identity_title: "身份", identity_tags: ["标签1", "标签2"], biz_title: "业务", biz_tags: ["业务1"], visual: "", visual_alt: "" } });
check("save_about", rAbout.ok === true, JSON.stringify(rAbout));
const aboutBack = await api("about");
check("save_about 读回数组字段", Array.isArray(aboutBack.paragraphs) && aboutBack.paragraphs.length === 2 && aboutBack.identity_tags?.length === 2, `paragraphs=${aboutBack.paragraphs?.length}`);

// ── E. 上传 ────────────────────────────────────────────────────────
section("E. 图片上传与本地存储");

const srcImage = join(ROOT, "web", "assets", "images", "goods-badge.webp");
check("测试源图存在", existsSync(srcImage), srcImage);

let uploadedPath = null;
if (existsSync(srcImage)) {
  const buf = readFileSync(srcImage);
  const fd = new FormData();
  fd.append("file", new File([buf], "e2e-upload.webp", { type: "image/webp" }));
  const upRes = await fetch(`${API}?action=upload_image`, { method: "POST", headers: sessionId ? { "x-session-id": sessionId } : {}, body: fd });
  const up = await upRes.json();
  check("upload_image → ok", up.ok === true, JSON.stringify(up));
  uploadedPath = up.path;
  check("返回 path 形如 assets/images/up-*.webp", /^assets\/images\/up-[\d-]+-[0-9a-f]{4}\.webp$/.test(up.path || ""), `path=${up.path}`);
  check("返回 url 是可访问的静态地址", typeof up.url === "string" && up.url === "/" + up.path, `url=${up.url}`);

  const onDisk = join(ROOT, "web", up.path || "___none___");
  check("文件确实落到 web/assets/images/", existsSync(onDisk), onDisk);

  const imgList = await api("list_images");
  check("list_images 能列出新文件", (imgList.items || []).some((i) => i.path === up.path), `共 ${(imgList.items || []).length} 个`);

  const staticFetch = await fetch(`${BASE}/${up.path}`);
  check("上传后的图片可被静态访问", staticFetch.status === 200 && staticFetch.headers.get("content-type") === "image/webp", `HTTP ${staticFetch.status} ${staticFetch.headers.get("content-type")}`);
  const urlFetch = await fetch(`${BASE}${up.url}`);
  check("handler 给的 url 也能访问", urlFetch.status === 200, `HTTP ${urlFetch.status}`);

  // 删除（图片管理里的删除按钮）：删完静态访问应 404，list_images 不再列出
  if (up.ok && up.path) {
    const delRes = await api("delete_image", { method: "POST", auth: true, query: `&id=${encodeURIComponent(up.path.split("/").pop())}` });
    check("delete_image", delRes.ok === true, JSON.stringify(delRes));
    const afterDel = await fetch(`${BASE}/${up.path}`);
    check("删除后静态访问 404", afterDel.status === 404, `HTTP ${afterDel.status}`);
    const listAfterDel = await api("list_images");
    check("删除后 list_images 不再列出", !(listAfterDel.items || []).some((i) => i.path === up.path));
    const traversal = await api("delete_image", { method: "POST", auth: true, query: "&id=..%2F..%2Fserver%2Fdata%2Fgpic.sqlite" });
    check("delete_image 拒绝路径穿越", traversal.error === "invalid_id", JSON.stringify(traversal));
  }


  const badType = new FormData();
  badType.append("file", new File([Buffer.from("not an image")], "evil.txt", { type: "text/plain" }));
  const badRes = await fetch(`${API}?action=upload_image`, { method: "POST", headers: { "x-session-id": sessionId }, body: badType });
  const badData = await badRes.json();
  check("上传非图片类型被拒 → 400", badRes.status === 400 && badData.error === "unsupported_type", `HTTP ${badRes.status} ${badData.error}`);
}

// ── F. 用户管理 ────────────────────────────────────────────────────
section("F. 用户管理（organizer 专属）");

const usersBefore = await api("list_users", { method: "POST", auth: true, body: {} });
check("list_users", usersBefore.ok === true, `${usersBefore.items?.length} 个用户`);

const rCreate = await api("create_user", { method: "POST", auth: true, body: { username: "e2e_admin", password: "e2e_pwd_123", role: "admin" } });
check("create_user", rCreate.ok === true && /^[0-9a-f-]{36}$/.test(rCreate.id || ""), JSON.stringify(rCreate));

const dup = await api("create_user", { method: "POST", auth: true, body: { username: "e2e_admin", password: "e2e_pwd_123", role: "admin" } });
check("重名用户被拒 → 400", dup.__status === 400 && dup.error === "username_exists", `HTTP ${dup.__status}`);

const weak = await api("create_user", { method: "POST", auth: true, body: { username: "ok_name", password: "123" } });
check("口令过短被拒 → 400", weak.__status === 400 && weak.error === "password_too_short", `HTTP ${weak.__status}`);

const newLogin = await api("login", { method: "POST", body: { username: "e2e_admin", password: "e2e_pwd_123" } });
check("新建账号可以登录", newLogin.ok === true && newLogin.user?.role === "admin");
const newSession = newLogin.session_id;

// 用新建的 admin 身份访问 organizer 专属接口
const asAdmin = await fetch(`${API}?action=list_users`, { method: "POST", headers: { "x-session-id": newSession } });
const asAdminData = await asAdmin.json();
check("admin 角色访问 list_users → 403", asAdmin.status === 403 && asAdminData.error === "forbidden", `HTTP ${asAdmin.status} ${asAdminData.error}`);

// ⚠️ 改密必须用 e2e_admin 自己的会话，否则会改掉主催的口令
const pwdChange = await api("change_password", { method: "POST", auth: true, session: newSession, body: { old_password: "e2e_pwd_123", new_password: "e2e_pwd_456" } });
check("change_password", pwdChange.ok === true, JSON.stringify(pwdChange));
const wrongOld = await api("change_password", { method: "POST", auth: true, session: newSession, body: { old_password: "totally-wrong", new_password: "e2e_pwd_789" } });
check("旧口令错误 → 400", wrongOld.__status === 400 && wrongOld.error === "invalid_old_password", `HTTP ${wrongOld.__status}`);
const reLogin = await api("login", { method: "POST", body: { username: "e2e_admin", password: "e2e_pwd_456" } });
check("改密后新口令可登录", reLogin.ok === true);
const oldLogin = await api("login", { method: "POST", body: { username: "e2e_admin", password: "e2e_pwd_123" } });
check("改密后旧口令失效", oldLogin.__status === 401, `HTTP ${oldLogin.__status}`);
const organizerStillOk = await api("login", { method: "POST", body: { username: USERNAME, password: PASSWORD } });
check("主催口令未被误改", organizerStillOk.ok === true, `HTTP ${organizerStillOk.__status}`);

const delSelf = await api("delete_user", { method: "POST", auth: true, query: `&id=${login.data.user.id}` });
check("不能删自己 → 400", delSelf.__status === 400 && delSelf.error === "cannot_delete_self", `HTTP ${delSelf.__status}`);

const delUser = await api("delete_user", { method: "POST", auth: true, query: `&id=${rCreate.id}` });
check("delete_user", delUser.ok === true, JSON.stringify(delUser));
const gone = await api("login", { method: "POST", body: { username: "e2e_admin", password: "e2e_pwd_456" } });
check("被删账号无法登录", gone.__status === 401);

// ── G. 清理写操作 ──────────────────────────────────────────────────
section("G. 删除操作");

const delNotice = await api("delete_notice", { method: "POST", auth: true, query: "&id=2099-01-01-z" });
check("delete_notice", delNotice.ok === true, JSON.stringify(delNotice));
const noticeGone = await api("notice", { query: "&id=2099-01-01-z" });
check("删除后查不到 → 404", noticeGone.__status === 404);

const delBrand = await api("delete_brand", { method: "POST", auth: true, query: `&id=${rBrand.id}` });
check("delete_brand", delBrand.ok === true, JSON.stringify(delBrand));

const delGood = await api("delete_good", { method: "POST", auth: true, query: `&id=${rGood.id}` });
check("delete_good", delGood.ok === true, JSON.stringify(delGood));

const delBad = await api("delete_good", { method: "POST", auth: true, query: "&id=not-a-uuid" });
check("删除非法 uuid → 400", delBad.__status === 400, `HTTP ${delBad.__status}`);

// ── H. 登出 ────────────────────────────────────────────────────────
section("H. 登出");

const logout = await api("logout", { method: "POST", auth: true, raw: true });
check("logout → 200", logout.status === 200, `HTTP ${logout.status}`);
check("logout 清 Cookie", logout.res.headers.getSetCookie().some((c) => c.startsWith("gpic_session=;")), logout.res.headers.getSetCookie()?.[0]);
const afterLogout = await api("save_settings", { method: "POST", auth: true, body: { name: "x" } });
check("登出后旧令牌失效 → 401", afterLogout.__status === 401, `HTTP ${afterLogout.__status}`);

// ── I. 静态站点 ────────────────────────────────────────────────────
section("I. 静态站点与 404");

for (const [path, expectType, mustContain] of [
  ["/", "text/html", "幻想乡"],
  ["/index.html", "text/html", null],
  ["/notice.html", "text/html", "新闻公告"],
  ["/goods.html", "text/html", null],
  ["/admin.html", "text/html", "登录"],
  ["/recruitment.html", "text/html", null],
  ["/style.css", "text/css", null],
  ["/assets/images/goods-badge.webp", "image/webp", null],
]) {
  const res = await fetch(`${BASE}${path}`);
  const ctype = res.headers.get("content-type") || "";
  const body = res.status === 200 ? await res.text().catch(() => "") : "";
  const typeOk = ctype.startsWith(expectType);
  const contentOk = mustContain ? body.includes(mustContain) : true;
  check(`GET ${path}`, res.status === 200 && typeOk && contentOk, `HTTP ${res.status} ${ctype.split(";")[0]}${mustContain && !contentOk ? " 内容不匹配" : ""}`);
}

const notFound = await fetch(`${BASE}/this-page-does-not-exist.html`);
check("不存在的路径 → 404（走站点 404.html）", notFound.status === 404, `HTTP ${notFound.status}`);

// 用编码过的穿越路径，绕开 fetch 自身的 URL 归一化
const traversal = await fetch(`${BASE}/%2e%2e%2f%2e%2e%2ffunctions%2fhandler.mjs`);
const traversalBody = await traversal.text().catch(() => "");
check("路径穿越 /../ 被挡住", traversal.status === 404 && !traversalBody.includes("handleRequest"), `HTTP ${traversal.status}`);

const traversalWin = await fetch(`${BASE}/%2e%2e%5c%2e%2e%5cfunctions%5chandler.mjs`);
const traversalWinBody = await traversalWin.text().catch(() => "");
check("路径穿越 ..\\ 被挡住", traversalWin.status === 404 && !traversalWinBody.includes("handleRequest"), `HTTP ${traversalWin.status}`);

// handler.mjs / adapter.mjs 属于服务端代码，不该出现在 web/ 静态目录里
const leak = await fetch(`${BASE}/../functions/handler.mjs`.replace("/../", "/%2e%2e/"));
const leakBody = await leak.text().catch(() => "");
check("服务端源码不可通过静态路径读取", !leakBody.includes("handleRequest"), `HTTP ${leak.status}`);

// ─────────────────────────────────────────────────────────────────
section("J. 版本号");

// 真源只有 web/version.json 一份，这几条就是在证明「一处改、处处一致」没有漏。
// 漏掉任何一处，线上就会出现「页脚是 v1.1.0、响应头还是 v1.0.0」这种鬼故事。
const verRes = await fetch(`${BASE}/version.json`);
const verJson = verRes.status === 200 ? await verRes.json().catch(() => null) : null;
const semverOk = !!verJson && /^\d+\.\d+\.\d+$/.test(String(verJson.version));
check("GET /version.json", verRes.status === 200 && semverOk,
  `HTTP ${verRes.status} version=${verJson && verJson.version}`);

const expectedTag = verJson ? "v" + verJson.version : "(无)";
for (const path of ["/", "/goods.html", "/notice.html", "/recruitment.html"]) {
  const r = await fetch(`${BASE}${path}`);
  const tag = r.headers.get("x-gpic-version");
  check(`X-GPIC-Version ${path}`, !!verJson && tag === expectedTag, `头=${tag || "(缺)"} 期望=${expectedTag}`);
}

const allForVer = await (await fetch(`${BASE}/functions/v1/app?action=all`)).json();
const allVer = allForVer && allForVer.version;
check("all 里的 version 与真源一致",
  !!verJson && !!allVer && allVer.version === verJson.version,
  `接口=${allVer && allVer.version}`);

// 页脚那颗版本胶囊是 JS 填的，HTML 里只该有空占位。
// 一旦有人在 HTML 里写死 vX.Y.Z，就等于出现了第二份真源 —— 这里直接拦下。
for (const p of ["index", "goods", "notice", "recruitment"]) {
  const html = await (await fetch(`${BASE}/${p}.html`)).text();
  const hasSlot = /data-site-version/.test(html);
  const hardcoded = /data-site-version[^>]*>\s*v\d+\.\d+\.\d+/.test(html);
  check(`${p}.html 版本占位`, hasSlot && !hardcoded,
    !hasSlot ? "缺 data-site-version" : hardcoded ? "版本号被写死在 HTML 里" : "空占位");
}

// ── 汇总 ───────────────────────────────────────────────────────────
console.log("");
console.log("  ═══════════════════════════════════════════════════════");
console.log(`  通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log("");
  console.log("  失败明细：");
  for (const f of failures) console.log(`    ✗ [${f.group}] ${f.label}  ${f.detail}`);
}
console.log("");

process.exit(failures.length === 0 ? 0 : 1);
