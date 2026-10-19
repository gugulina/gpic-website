const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store" },
});

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noticeIdRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+$/;

// ─── 商品状态 ───────────────────────────────────────────────────────
// 三态是「展示口径」而不是「库存数字」：管理员手动切换，不需要盘点。
//   on_sale   公开可见、顺序靠前、可导流购买
//   sold_out  公开可见、排在在售之后、标注售罄并隐藏购买入口
//   off_shelf 公开接口完全不返回（后台仍可见，数据保留）
const GOOD_STATUSES = new Set(["on_sale", "sold_out", "off_shelf"]);
// 三态在列表里的排序权重：在售 0 → 售罄 1 → 下架 2（下架本来就不出库，留 2 只是兜底）
const GOOD_STATUS_RANK = { on_sale: 0, sold_out: 1, off_shelf: 2 };
// 公开接口统一用这份列清单，避免三处 select 写歪
const GOOD_COLS = "id,badge,badge_style,name,description,image,image_alt,tags,alt_label,price,unit,is_free,free_label,display_order,status";
// 首页精选只存「商品 id 的有序数组」，数组下标即展示顺序
const HOME_GOODS_KEY = "home_goods";
const HOME_GOODS_MAX = 12;
const MAX_BODY = 512 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const IMAGE_BUCKET = "images";
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const SESSION_EXPIRY_HOURS = 24;

// 存储模块探测顺序：
//   1. ./_qoder/storage.mjs —— 部署到 Qoder 时由平台注入的托管存储，优先命中
//   2. ./storage.mjs        —— 自持部署时用的本地文件系统实现
// 两者接口一致（storage.upload / storage.list），handler 不需要知道自己跑在哪。
const STORAGE_CANDIDATES = ["./_qoder/storage.mjs", "./storage.mjs"];

let storageModule = null;
let storageProbed = false;
async function getStorage() {
  if (storageProbed) return storageModule;
  storageProbed = true;
  for (const candidate of STORAGE_CANDIDATES) {
    try {
      const mod = await import(candidate);
      if (mod && mod.storage) { storageModule = mod; return storageModule; }
    } catch { /* 换下一个候选 */ }
  }
  storageModule = null;
  return storageModule;
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function now() { return new Date().toISOString(); }

// ─── Password hashing (PBKDF2-SHA256) ──

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function verifyPassword(password, salt, hash) {
  const computed = await hashPassword(password, salt);
  return computed === hash;
}

// ─── Session management ───

function getSessionId(request) {
  const hdr = request.headers.get("x-session-id");
  if (hdr) return hdr;
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/gpic_session=([a-f0-9-]+)/);
  return match ? match[1] : null;
}

function sessionCookie(sessionId) {
  const maxAge = SESSION_EXPIRY_HOURS * 3600;
  return `gpic_session=${sessionId}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

async function requireAuth({ supabase, request }) {
  const sessionId = getSessionId(request);
  if (!sessionId) return { error: "login_required" };
  const { data: session } = await supabase.from("auth_sessions")
    .select("user_id, expires_at").eq("id", sessionId).maybeSingle();
  if (!session) return { error: "login_required" };
  if (new Date(session.expires_at) < new Date()) {
    await supabase.from("auth_sessions").delete().eq("id", sessionId);
    return { error: "session_expired" };
  }
  const { data: user } = await supabase.from("users")
    .select("id, username, role").eq("id", session.user_id).maybeSingle();
  if (!user) return { error: "login_required" };
  return { ok: true, user };
}

function requireOrganizer(authResult) {
  if (authResult.error) return authResult;
  if (authResult.user.role !== "organizer") return { error: "forbidden" };
  return authResult;
}

// ─── GET handlers ───

async function getAll({ supabase }) {
  const [settingsR, heroR, noticesR, brandsR, goodsR, eventsR, socialR, aboutR] = await Promise.all([
    supabase.from("site_settings").select("key,value"),
    supabase.from("hero_content").select("*").limit(1).maybeSingle(),
    supabase.from("notices").select("id,date,type,style,summary,title,cover,cover_alt").order("date", { ascending: false }),
    supabase.from("brands").select("id,name,sub,logo,is_self").order("display_order"),
    supabase.from("goods").select(GOOD_COLS).order("display_order"),
    supabase.from("events").select("*").order("date_start", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("social_links").select("id,label,href,sub").order("display_order"),
    supabase.from("about_content").select("*").limit(1).maybeSingle(),
  ]);

  const settings = {};
  const blobs = {};
  let homeGoodsRaw = "";
  if (settingsR.data) {
    for (const r of settingsR.data) {
      // home_goods 是「首页精选的有序 id 数组」，不随 site 一起下发
      if (r.key === HOME_GOODS_KEY) { homeGoodsRaw = r.value; continue; }
      // shop / recruit 这类「整块 JSON」的设置单独取出来，
      // 别把一坨 JSON 字符串混进 site 里
      if (BLOB_KEYS.has(r.key)) { blobs[r.key] = parseJsonObject(r.value); continue; }
      settings[r.key] = r.value;
    }
  }

  // 公开接口：下架商品一律不出库。售罄保留（前端负责标注），
  // 并且排到在售商品后面，避免「首页第一眼看到买不到的东西」。
  const publicGoods = sortGoods((goodsR.data || []).filter((g) => g.status !== "off_shelf"));

  return {
    ok: true,
    site: settings,
    hero: heroR.data || null,
    notices: noticesR.data || [],
    brands: brandsR.data || [],
    goods: publicGoods,
    // 首页只渲染这里列出的商品，顺序即数组顺序；未列出的不上首页
    homeGoods: parseHomeIds(homeGoodsRaw),
    event: eventsR.data || null,
    social: socialR.data || [],
    about: aboutR.data || null,
    shop: blobs.shop || null,
    recruit: blobs.recruit || null,
    goodsBlock: blobs.goods_block || null,
  };
}

async function getNotices({ supabase }) {
  // 必须带上 body：notice.html 的列表加载会把列表项写进 notices 缓存，
  // 点进详情时 showNotice() 命中缓存就不再请求详情 —— 列表不给 body，正文就永远空白。
  const { data, error } = await supabase.from("notices")
    .select("id,date,type,style,summary,title,cover,cover_alt,body")
    .order("date", { ascending: false });
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  return { ok: true, items: data };
}

async function getNotice({ supabase, id }) {
  if (!noticeIdRe.test(id)) return { error: "invalid_id" };
  const { data, error } = await supabase.from("notices")
    .select("*").eq("id", id).maybeSingle();
  if (error) return { error: "database_request_failed" };
  if (!data) return { error: "not_found" };
  return { ok: true, ...data };
}

async function getBrands({ supabase }) {
  const { data, error } = await supabase.from("brands")
    .select("id,name,sub,logo,is_self").order("display_order");
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  return { ok: true, items: data };
}

async function getGoods({ supabase }) {
  // 商品页不只有卡片列表：底部「商品目录海报」「线上通贩」两张卡里的按钮
  // 也是内容（海报路径、购买链接）。这些都存在 site_settings 的 goods_block
  // 里，和 items 一起返回，前端一次请求就能把整页填满。
  const [listR, blockR] = await Promise.all([
    supabase.from("goods").select(GOOD_COLS).order("display_order"),
    supabase.from("site_settings").select("value").eq("key", GOODS_BLOCK_KEY).maybeSingle(),
  ]);
  if (listR.error || !Array.isArray(listR.data)) return { error: "database_request_failed" };
  return {
    ok: true,
    // 下架商品对公开页面不存在；售罄保留并排在在售之后
    items: sortGoods(listR.data.filter((g) => g.status !== "off_shelf")),
    block: parseJsonObject(blockR.data && blockR.data.value) || null,
  };
}

// 后台专用：包含下架商品。GET 请求默认不带鉴权，所以路由层对它单独要求 session。
async function getAdminGoods({ supabase }) {
  const [listR, homeIds] = await Promise.all([
    supabase.from("goods").select(GOOD_COLS).order("display_order"),
    readHomeIds(supabase),
  ]);
  if (listR.error || !Array.isArray(listR.data)) return { error: "database_request_failed" };
  return { ok: true, items: sortGoods(listR.data), homeGoods: homeIds };
}

async function getHomeGoods({ supabase }) {
  return { ok: true, homeGoods: await readHomeIds(supabase) };
}

async function saveHomeGoods({ supabase, body }) {
  if (!body || !Array.isArray(body.ids)) return { error: "invalid_body" };
  if (body.ids.length > HOME_GOODS_MAX) return { error: "too_many_items" };
  // 顺序就是展示顺序，所以只能做「去重」不能做「排序」：保留首次出现的下标
  const ids = [];
  for (const id of body.ids) {
    if (typeof id !== "string" || !uuidRe.test(id)) return { error: "invalid_id" };
    if (!ids.includes(id)) ids.push(id);
  }
  const { error } = await supabase.from("site_settings").upsert({
    key: HOME_GOODS_KEY,
    value: JSON.stringify({ ids }),
    updated_at: now(),
  });
  if (error) return { error: "database_request_failed" };
  return { ok: true, homeGoods: ids };
}

async function getEvents({ supabase }) {
  const { data, error } = await supabase.from("events")
    .select("*").order("date_start", { ascending: false });
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  return { ok: true, items: data };
}

async function getSocial({ supabase }) {
  const { data, error } = await supabase.from("social_links")
    .select("id,label,href,sub").order("display_order");
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  return { ok: true, items: data };
}

async function getAbout({ supabase }) {
  const { data, error } = await supabase.from("about_content")
    .select("*").limit(1).maybeSingle();
  if (error) return { error: "database_request_failed" };
  return { ok: true, ...(data || {}) };
}

async function getHero({ supabase }) {
  const { data, error } = await supabase.from("hero_content")
    .select("*").limit(1).maybeSingle();
  if (error) return { error: "database_request_failed" };
  return { ok: true, ...(data || {}) };
}

async function getSettings({ supabase }) {
  const { data, error } = await supabase.from("site_settings").select("key,value");
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  const settings = {};
  for (const r of data) settings[r.key] = r.value;
  return { ok: true, ...settings };
}

// ─── 整块 JSON 设置（shop / recruit）──────────────────────────────
// 刻意不建新表：Qoder Sites 的数据库只经过 /rest/v1（PostgREST）代理，平台侧
// 没有执行 DDL 的入口，新建表在线上根本跑不通。所以复用已有的 site_settings，
// 把一整个对象存成一条 JSON，零迁移。
const SHOP_KEY = "shop";
const RECRUIT_KEY = "recruit";
// 商品页「海报 / 通贩」两张卡的文案与按钮，整块 JSON 存在 site_settings 里
const GOODS_BLOCK_KEY = "goods_block";
const BLOB_KEYS = new Set([SHOP_KEY, RECRUIT_KEY, GOODS_BLOCK_KEY]);

function parseJsonObject(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ─── 商品排序与首页精选 ─────────────────────────────────────────────

// 在售在前、售罄在后；同状态内按 display_order，再按名称兜底（避免顺序抖动）。
// 排序放在 JS 里而不是 SQL 里，是因为 sqlite 适配层的 order() 只接列名，
// 写不了 CASE WHEN；商品量级只有几十条，内存排序没有代价。
function sortGoods(list) {
  return list.slice().sort((a, b) => {
    const ra = GOOD_STATUS_RANK[a.status] ?? 0;
    const rb = GOOD_STATUS_RANK[b.status] ?? 0;
    if (ra !== rb) return ra - rb;
    const da = Number(a.display_order) || 0;
    const db = Number(b.display_order) || 0;
    if (da !== db) return da - db;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

// home_goods 的值形如 {"ids":["uuid1","uuid2"]}。
// 只放行合法 UUID：历史上删掉的商品可能在数组里留悬空 id，
// 这里顺手过滤掉，前端就不用再兜一遍。
function parseHomeIds(value) {
  const obj = parseJsonObject(value);
  if (!obj || !Array.isArray(obj.ids)) return [];
  const out = [];
  for (const id of obj.ids) {
    if (typeof id === "string" && uuidRe.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

async function readHomeIds(supabase) {
  const { data } = await supabase.from("site_settings")
    .select("value").eq("key", HOME_GOODS_KEY).maybeSingle();
  return parseHomeIds(data && data.value);
}

async function getShop({ supabase }) {
  const { data, error } = await supabase.from("site_settings")
    .select("value").eq("key", SHOP_KEY).maybeSingle();
  if (error) return { error: "database_request_failed" };
  return { ok: true, ...(parseJsonObject(data && data.value) || {}) };
}

async function saveShop({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { title, desc, links, note } = body;
  if (typeof title !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(links)) return { error: "invalid_jsonb" };
  if (links.length > 20) return { error: "too_many_items" };
  for (const l of links) {
    if (!l || typeof l !== "object" || typeof l.label !== "string") return { error: "invalid_fields" };
  }
  const payload = JSON.stringify({
    title,
    desc: typeof desc === "string" ? desc : "",
    links: links.map((l) => ({
      label: l.label,
      href: typeof l.href === "string" ? l.href : "",
      sub: typeof l.sub === "string" ? l.sub : "",
    })),
    note: typeof note === "string" ? note : "",
  });
  const { error } = await supabase.from("site_settings")
    .upsert({ key: SHOP_KEY, value: payload, updated_at: now() });
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

// ─── 商品页工具区（goods_block）──────────────────────────────────
// 商品页底部那两张卡：「商品目录海报」和「线上通贩」。
// 它们的标题、说明、按钮文字、按钮链接、页脚备注原本全是写死在 goods.html 里的，
// 后台改不了 —— 用户 2026-10-19 反馈「两个按钮没有编辑权限」就是指这个。
// 现在整块做成 JSON 存 site_settings，导出时合进 content.json 的 goods 对象。

const GOODS_BLOCK_FIELDS = [
  // [字段名, 最大长度]
  ["posterTitle", 60],
  ["posterDesc", 300],
  ["poster", 300],          // 第一页
  ["posterLabel", 60],
  ["poster2", 300],         // 第二页（留空 = 前台不显示第二个按钮）
  ["posterLabel2", 60],
  ["buyTitle", 60],
  ["buyDesc", 300],
  ["buyHref", 500],
  ["buyLabel", 60],
  ["note", 600],
];

// 只放行 http(s) / 站内绝对路径 / 站内相对路径，挡掉 javascript: 之类的注入
function safeUrl(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (/^(assets|\.\.?)\//.test(v)) return v;
  return null; // 不合法
}

async function saveGoodsBlock({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const payload = {};
  for (const [key, max] of GOODS_BLOCK_FIELDS) {
    const raw = typeof body[key] === "string" ? body[key] : "";
    payload[key] = raw.slice(0, max);
  }
  const href = safeUrl(payload.buyHref);
  if (href === null) return { error: "invalid_href" };
  payload.buyHref = href;
  const poster = safeUrl(payload.poster);
  if (poster === null) return { error: "invalid_poster" };
  payload.poster = poster;
  const poster2 = safeUrl(payload.poster2);
  if (poster2 === null) return { error: "invalid_poster" };
  payload.poster2 = poster2;

  const { error } = await supabase.from("site_settings")
    .upsert({ key: GOODS_BLOCK_KEY, value: JSON.stringify(payload), updated_at: now() });
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

// ─── 人员招募（recruit）───────────────────────────────────────────
// 与 shop 同一套路：整块 JSON 存在 site_settings 里，不建新表。
// 正文里的 **…** 由前端转 <strong>（与 about.paragraphs 的约定一致）。
async function getRecruit({ supabase }) {
  const { data, error } = await supabase.from("site_settings")
    .select("value").eq("key", RECRUIT_KEY).maybeSingle();
  if (error) return { error: "database_request_failed" };
  return { ok: true, recruit: parseJsonObject(data && data.value) };
}

async function saveRecruit({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const s = (v) => (typeof v === "string" ? v : "");
  const { title, jobs, how_items, notes } = body;
  if (typeof title !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(jobs) || !Array.isArray(how_items) || !Array.isArray(notes)) {
    return { error: "invalid_jsonb" };
  }
  if (jobs.length > 30 || how_items.length > 50 || notes.length > 50) {
    return { error: "too_many_items" };
  }
  for (const j of jobs) {
    if (!j || typeof j !== "object" || typeof j.title !== "string" || !Array.isArray(j.rows)) {
      return { error: "invalid_fields" };
    }
    if (j.rows.length > 20) return { error: "too_many_items" };
    for (const r of j.rows) {
      if (!r || typeof r !== "object" || typeof r.label !== "string" || typeof r.value !== "string") {
        return { error: "invalid_fields" };
      }
    }
  }
  const strings = (a) => a.filter((x) => typeof x === "string");
  const payload = JSON.stringify({
    badge: s(body.badge),
    title,
    intro: s(body.intro),
    deadline: s(body.deadline),
    contact_qq: s(body.contact_qq),
    contact_url: s(body.contact_url),
    jobs: jobs.map((j) => ({
      title: j.title,
      rows: j.rows.map((r) => ({ label: r.label, value: r.value })),
    })),
    how_items: strings(how_items),
    notes: strings(notes),
    cta_slogan: s(body.cta_slogan),
    cta_text: s(body.cta_text),
    cta_button: s(body.cta_button),
  });
  const { error } = await supabase.from("site_settings")
    .upsert({ key: RECRUIT_KEY, value: payload, updated_at: now() });
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

// ─── POST handlers (write) ───

async function saveSettings({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const entries = Object.entries(body);
  if (entries.length === 0) return { ok: true };
  if (entries.length > 100) return { error: "too_many_settings" };
  const t = now();
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) return { error: "invalid_key" };
    if (typeof value !== "string") return { error: "invalid_value" };
    const { error } = await supabase.from("site_settings")
      .upsert({ key, value, updated_at: t });
    if (error) return { error: "database_request_failed" };
  }
  return { ok: true };
}

async function saveHero({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { banner, banner_fallback, banner_alt, badge, title, body: bodyText, sub, actions, stats } = body;
  if (typeof banner !== "string" || typeof title !== "string" || typeof badge !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(actions) || !Array.isArray(stats)) return { error: "invalid_jsonb" };
  const id = "00000000-0000-0000-0000-000000000001";
  const t = now();
  const { error } = await supabase.from("hero_content")
    .upsert({ id, banner: banner || "", banner_fallback: banner_fallback || "", banner_alt: banner_alt || "", badge, title, body: bodyText || "", sub: sub || "", actions, stats, updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

async function saveNotice({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { id, date, type, style, summary, title, cover, cover_alt, body: bodyBlocks } = body;
  if (!noticeIdRe.test(id)) return { error: "invalid_id" };
  if (typeof title !== "string" || typeof date !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(bodyBlocks)) return { error: "invalid_jsonb" };
  const t = now();
  const existing = await supabase.from("notices").select("id").eq("id", id).maybeSingle();
  const row = {
    id, date: date || "", type: type || "", style: style || "green",
    summary: summary || "", title, cover: cover || "", cover_alt: cover_alt || "",
    body: bodyBlocks, updated_at: t,
  };
  let result;
  if (existing.data) {
    result = await supabase.from("notices").update(row).eq("id", id);
  } else {
    result = await supabase.from("notices").insert({ ...row, created_at: t });
  }
  if (result.error) return { error: "database_request_failed" };
  return { ok: true };
}

async function deleteNotice({ supabase, id }) {
  if (!noticeIdRe.test(id)) return { error: "invalid_id" };
  const { error } = await supabase.from("notices").delete().eq("id", id);
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

async function saveBrand({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { id, name, sub, logo, is_self, display_order } = body;
  if (typeof name !== "string") return { error: "invalid_fields" };
  const bid = id && uuidRe.test(id) ? id : crypto.randomUUID();
  const t = now();
  const { error } = await supabase.from("brands")
    .upsert({ id: bid, name, sub: sub || "", logo: logo || "", is_self: !!is_self, display_order: display_order || 0, updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true, id: bid };
}

async function deleteBrand({ supabase, id }) {
  if (!uuidRe.test(id)) return { error: "invalid_id" };
  const { error } = await supabase.from("brands").delete().eq("id", id);
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

async function saveGood({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { id, badge, badge_style, name, description, image, image_alt, tags, alt_label, price, unit, is_free, free_label, display_order, status } = body;
  if (typeof name !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(tags)) return { error: "invalid_jsonb" };
  const gid = id && uuidRe.test(id) ? id : crypto.randomUUID();
  const t = now();

  // 状态缺省 = 在售（新建商品、以及老客户端不带这个字段时都走这里）；
  // 带了但不认识就报错，别静默回落成在售 —— 那样「标记下架」会变成
  // 「悄悄上架」，是最难查的一类事故。
  let goodStatus = "on_sale";
  if (status !== undefined && status !== null && status !== "") {
    if (!GOOD_STATUSES.has(status)) return { error: "invalid_status" };
    goodStatus = status;
  }

  const { error } = await supabase.from("goods")
    .upsert({ id: gid, badge: badge || "", badge_style: badge_style || "green", name, description: description || "", image: image || "", image_alt: image_alt || "", tags, alt_label: alt_label || "", price: price || "", unit: unit || "", is_free: !!is_free, free_label: free_label || "", display_order: display_order || 0, status: goodStatus, updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true, id: gid };
}

// 只改状态、不碰其他字段：后台列表上的「售罄 / 下架 / 上架」下拉走这条路，
// 避免整表单回写时把别人刚改的文案覆盖掉。
async function setGoodStatus({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  if (!uuidRe.test(body.id || "")) return { error: "invalid_id" };
  if (!GOOD_STATUSES.has(body.status)) return { error: "invalid_status" };
  const { error } = await supabase.from("goods")
    .update({ status: body.status, updated_at: now() }).eq("id", body.id);
  if (error) return { error: "database_request_failed" };
  return { ok: true, id: body.id, status: body.status };
}

async function deleteGood({ supabase, id }) {
  if (!uuidRe.test(id)) return { error: "invalid_id" };
  const { error } = await supabase.from("goods").delete().eq("id", id);
  if (error) return { error: "database_request_failed" };

  // 顺手把它从首页精选里摘掉，否则后台会留一条指向不存在商品的空条目。
  // 失败不影响删除本身，所以不把错误往上抛。
  try {
    const ids = await readHomeIds(supabase);
    if (ids.includes(id)) {
      const left = ids.filter((x) => x !== id);
      await supabase.from("site_settings").upsert({
        key: HOME_GOODS_KEY,
        value: JSON.stringify({ ids: left }),
        updated_at: now(),
      });
    }
  } catch { /* 清理失败就让前端跳过悬空 id */ }

  return { ok: true };
}

async function saveEvent({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { id, badge, title, subtitle, booth, debut, date_start, date_end, link_label, link_href, visual, visual_alt } = body;
  if (typeof title !== "string") return { error: "invalid_fields" };
  const eid = id && uuidRe.test(id) ? id : crypto.randomUUID();
  const t = now();
  const { error } = await supabase.from("events")
    .upsert({ id: eid, badge: badge || "", title, subtitle: subtitle || "", booth: booth || "", debut: debut || "", date_start: date_start || "", date_end: date_end || "", link_label: link_label || "", link_href: link_href || "", visual: visual || "", visual_alt: visual_alt || "", updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true, id: eid };
}

async function saveSocial({ supabase, body }) {
  if (!body || !Array.isArray(body.items)) return { error: "invalid_body" };
  const items = body.items;
  if (items.length > 50) return { error: "too_many_items" };
  const t = now();
  const { error: delErr } = await supabase.from("social_links").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  if (delErr) return { error: "database_request_failed" };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (typeof item.label !== "string") return { error: "invalid_fields" };
    const { error } = await supabase.from("social_links")
      .insert({ id: crypto.randomUUID(), label: item.label, href: item.href || "", sub: item.sub || "", display_order: i, updated_at: t });
    if (error) return { error: "database_request_failed" };
  }
  return { ok: true };
}

async function saveAbout({ supabase, body }) {
  if (!body || typeof body !== "object") return { error: "invalid_body" };
  const { badge, title, subtitle, paragraphs, identity_title, identity_tags, biz_title, biz_tags, visual, visual_alt } = body;
  if (typeof title !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(paragraphs) || !Array.isArray(identity_tags) || !Array.isArray(biz_tags)) return { error: "invalid_jsonb" };
  const aid = "00000000-0000-0000-0000-000000000001";
  const t = now();
  const { error } = await supabase.from("about_content")
    .upsert({ id: aid, badge: badge || "", title, subtitle: subtitle || "", paragraphs, identity_title: identity_title || "", identity_tags, biz_title: biz_title || "", biz_tags, visual: visual || "", visual_alt: visual_alt || "", updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

// ─── Image upload ───

// 文件名格式：up-20261019-105530-a3f1.webp
//   · up- 前缀把"后台上传的图"和站点原有的语义名（goods-*.webp、brand-*.webp）区分开
//   · 时间戳让文件管理器里按名排序 = 按上传时间排序
//   · 4 位随机后缀防同秒覆盖
//   · 全程 ASCII，避免中文文件名进 URL 时还得 encodeURIComponent
const EXT_BY_TYPE = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

function uploadName(contentType) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `up-${stamp}-${rand}.${EXT_BY_TYPE.get(contentType)}`;
}

async function uploadImage({ request }) {
  const storage = await getStorage();
  if (!storage || !storage.storage) return { error: "storage_unavailable" };
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) return { error: "invalid_content_type" };
  let formData;
  try { formData = await request.formData(); } catch { return { error: "invalid_body" }; }
  const file = formData.get("file");
  if (!file || typeof file.name !== "string") return { error: "missing_file" };
  if (file.size > MAX_IMAGE) return { error: "file_too_large" };
  if (!ALLOWED_TYPES.has(file.type)) return { error: "unsupported_type" };
  // 扩展名按 MIME 定，不信客户端文件名 —— 前端已把图转成 WebP 再传，
  // 所以正常路径下这里必然是 .webp。图片统一进 assets/images/。
  const safeName = uploadName(file.type);
  const path = `${IMAGE_BUCKET}/${safeName}`;
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    await storage.storage.upload(path, buf, { contentType: file.type });
    return {
      ok: true,
      path: `assets/images/${safeName}`,
      // 以前这里是 /storage/v1/object/public/images/xxx —— Supabase 的桶地址，
      // 换成本地存储后这个路径根本不存在（访问必 404）。现在给真正能用
      // 的静态地址，前端拿 path 拼相对路径、拿 url 直接 <img src>。
      url: `/assets/images/${safeName}`,
      size: buf.byteLength,
      type: file.type,
    };
  } catch {
    return { error: "upload_failed" };
  }
}

async function listImages() {
  const storage = await getStorage();
  if (!storage || !storage.storage) return { error: "storage_unavailable" };
  try {
    // 现在列的是整个 assets/images/ 图库（含站点原有的语义名图片），
    // 不再只是"上传过的那几张"，所以上限放宽到 500。
    const files = await storage.storage.list(IMAGE_BUCKET, { limit: 500, offset: 0 });
    const items = (Array.isArray(files) ? files : []).map(f => {
      const name = typeof f === "string" ? f : f.name;
      return {
        name,
        path: `assets/images/${name}`,
        size: typeof f === "string" ? 0 : (f.size || 0),
        updated_at: typeof f === "string" ? "" : (f.updated_at || ""),
      };
    });
    return { ok: true, items };
  } catch {
    return { error: "list_failed" };
  }
}

async function deleteImage({ id }) {
  const storage = await getStorage();
  if (!storage || !storage.storage) return { error: "storage_unavailable" };
  if (typeof storage.storage.remove !== "function") return { error: "delete_unsupported" };
  // 前端传的是 "assets/images/xxx.webp" 或裸文件名，两种都收；
  // 带 .. / 反斜杠的一律拒（storage 自己也会挡，这里先挡一道让报错更清楚）
  const rawInput = String(id || "");
  if (rawInput.includes("..") || rawInput.includes("\\")) return { error: "invalid_id" };
  const name = rawInput.split("/").pop() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) || name.includes("..")) {
    return { error: "invalid_id" };
  }
  try {
    await storage.storage.remove(`${IMAGE_BUCKET}/${name}`);
    return { ok: true, deleted: name };
  } catch {
    return { error: "delete_failed" };
  }
}

// ─── Auth endpoints ───

async function doLogin({ supabase, body }) {
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return { error: "invalid_body" };
  }
  const { data: user } = await supabase.from("users")
    .select("id, username, password_hash, password_salt, role")
    .eq("username", body.username).maybeSingle();
  if (!user) return { error: "invalid_credentials" };
  const ok = await verifyPassword(body.password, user.password_salt, user.password_hash);
  if (!ok) return { error: "invalid_credentials" };
  const sessionId = crypto.randomUUID();
  const t = now();
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 3600 * 1000).toISOString();
  const { error } = await supabase.from("auth_sessions")
    .insert({ id: sessionId, user_id: user.id, created_at: t, expires_at: expiresAt });
  if (error) return { error: "database_request_failed" };
  return { ok: true, session_id: sessionId, user: { id: user.id, username: user.username, role: user.role } };
}

async function doLogout({ supabase, sessionId }) {
  if (sessionId) {
    await supabase.from("auth_sessions").delete().eq("id", sessionId);
  }
  return { ok: true };
}

async function doChangePassword({ supabase, body, userId }) {
  if (!body || typeof body.old_password !== "string" || typeof body.new_password !== "string") {
    return { error: "invalid_body" };
  }
  if (body.new_password.length < 6) return { error: "password_too_short" };
  const { data: user } = await supabase.from("users")
    .select("password_hash, password_salt").eq("id", userId).maybeSingle();
  if (!user) return { error: "user_not_found" };
  const ok = await verifyPassword(body.old_password, user.password_salt, user.password_hash);
  if (!ok) return { error: "invalid_old_password" };
  const newSalt = randomSalt();
  const newHash = await hashPassword(body.new_password, newSalt);
  const t = now();
  const { error } = await supabase.from("users")
    .update({ password_hash: newHash, password_salt: newSalt, updated_at: t }).eq("id", userId);
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

async function doListUsers({ supabase }) {
  const { data, error } = await supabase.from("users")
    .select("id, username, role, created_at").order("created_at");
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  return { ok: true, items: data };
}

async function doCreateUser({ supabase, body }) {
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return { error: "invalid_body" };
  }
  if (body.username.length < 2 || body.username.length > 32) return { error: "invalid_username" };
  if (!/^[a-zA-Z0-9_]+$/.test(body.username)) return { error: "invalid_username" };
  if (body.password.length < 6) return { error: "password_too_short" };
  const role = body.role === "organizer" ? "organizer" : "admin";
  const salt = randomSalt();
  const hash = await hashPassword(body.password, salt);
  const t = now();
  const { data: existing } = await supabase.from("users")
    .select("id").eq("username", body.username).maybeSingle();
  if (existing) return { error: "username_exists" };
  const id = crypto.randomUUID();
  const { error } = await supabase.from("users")
    .insert({ id, username: body.username, password_hash: hash, password_salt: salt, role, created_at: t, updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true, id };
}

async function doDeleteUser({ supabase, id, currentUserId }) {
  if (!uuidRe.test(id)) return { error: "invalid_id" };
  if (id === currentUserId) return { error: "cannot_delete_self" };
  const { error } = await supabase.from("users").delete().eq("id", id);
  if (error) return { error: "database_request_failed" };
  await supabase.from("auth_sessions").delete().eq("user_id", id);
  return { ok: true };
}

async function bootstrapOrganizer({ supabase, body }) {
  if (!body || typeof body.username !== "string" || typeof body.password_hash !== "string" || typeof body.password_salt !== "string") {
    return { error: "invalid_body" };
  }
  const { count } = await supabase.from("users").select("*", { count: "exact", head: true });
  if (count > 0) return { error: "users_exist" };
  const role = body.role === "organizer" ? "organizer" : "admin";
  const { error } = await supabase.from("users").insert({
    id: body.id || crypto.randomUUID(),
    username: body.username,
    password_hash: body.password_hash,
    password_salt: body.password_salt,
    role,
    created_at: body.created_at || now(),
    updated_at: body.updated_at || now(),
  });
  if (error) return { error: "database_request_failed" };
  return { ok: true };
}

// ─── Router ───

const getActions = {
  all: getAll,
  settings: getSettings,
  hero: getHero,
  notices: getNotices,
  notice: getNotice,
  brands: getBrands,
  goods: getGoods,
  admin_goods: getAdminGoods,
  home_goods: getHomeGoods,
  events: getEvents,
  social: getSocial,
  about: getAbout,
  shop: getShop,
  recruit: getRecruit,
  list_images: listImages,
};

// 走 GET 但必须带有效 session 的 action（其余 GET 都是公开内容）
const getAuthRequired = new Set(["admin_goods"]);

const postActions = {
  save_settings: saveSettings,
  save_hero: saveHero,
  save_notice: saveNotice,
  delete_notice: deleteNotice,
  save_brand: saveBrand,
  delete_brand: deleteBrand,
  save_good: saveGood,
  set_good_status: setGoodStatus,
  save_home_goods: saveHomeGoods,
  delete_good: deleteGood,
  save_event: saveEvent,
  save_social: saveSocial,
  save_about: saveAbout,
  save_shop: saveShop,
  save_goods_block: saveGoodsBlock,
  save_recruit: saveRecruit,
  upload_image: uploadImage,
  delete_image: deleteImage,
  login: doLogin,
  logout: doLogout,
  change_password: doChangePassword,
  list_users: doListUsers,
  create_user: doCreateUser,
  delete_user: doDeleteUser,
  bootstrap_organizer: bootstrapOrganizer,
};

const authRequired = new Set([
  "save_settings", "save_hero", "save_notice", "delete_notice",
  "save_brand", "delete_brand", "save_good", "set_good_status", "save_home_goods", "delete_good",
  "save_event", "save_social", "save_about", "save_shop", "save_goods_block",
  "save_recruit", "upload_image", "delete_image",
  "logout", "change_password", "list_users", "create_user", "delete_user",
]);

const organizerRequired = new Set(["list_users", "create_user", "delete_user"]);

export async function handleRequest({ request, supabase }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  if (!action) return json({ error: "missing_action" }, 400);

  if (request.method === "GET") {
    const handler = getActions[action];
    if (!handler) return json({ error: "unknown_action" }, 404);
    // 极少数 GET 会带后台数据（例如含下架商品的 admin_goods），单独要求 session
    if (getAuthRequired.has(action)) {
      const auth = await requireAuth({ supabase, request });
      if (auth.error) return json({ error: auth.error }, 401);
    }
    try {
      const id = url.searchParams.get("id") || "";
      const result = await handler({ supabase, id });
      if (result.error) return json({ error: result.error }, result.error === "not_found" ? 404 : result.error === "invalid_id" ? 400 : 503);
      return json(result);
    } catch {
      return json({ error: "database_request_failed" }, 503);
    }
  }

  if (request.method === "POST") {
    const handler = postActions[action];
    if (!handler) return json({ error: "unknown_action" }, 404);

    if (authRequired.has(action)) {
      const auth = await requireAuth({ supabase, request });
      if (auth.error) {
        const status = auth.error === "session_expired" ? 401 : 401;
        return json({ error: auth.error }, status);
      }
      if (organizerRequired.has(action)) {
        const orgCheck = requireOrganizer(auth);
        if (orgCheck.error) return json({ error: orgCheck.error }, 403);
      }
    }

    try {
      let body, id;
      if (action === "upload_image") {
        const result = await handler({ request });
        if (result.error) return json({ error: result.error }, result.error === "file_too_large" ? 413 : result.error === "unsupported_type" ? 400 : 503);
        return json(result);
      }
      if (action === "delete_notice" || action === "delete_brand" || action === "delete_good" || action === "delete_image") {
        id = url.searchParams.get("id") || "";
        const result = await handler({ supabase, id });
        if (result.error) return json({ error: result.error }, result.error === "invalid_id" ? 400 : 503);
        return json(result);
      }
      if (action === "logout") {
        const sessionId = getSessionId(request);
        const result = await handler({ supabase, sessionId });
        const headers = { "cache-control": "no-store", "set-cookie": "gpic_session=; Path=/; Max-Age=0" };
        return new Response(JSON.stringify(result), { status: 200, headers });
      }
      if (action === "login") {
        body = await readJson(request);
        if (!body) return json({ error: "invalid_body" }, 400);
        const result = await handler({ supabase, body });
        if (result.error) return json({ error: result.error }, result.error === "invalid_credentials" ? 401 : 400);
        const headers = { "cache-control": "no-store", "set-cookie": sessionCookie(result.session_id) };
        return new Response(JSON.stringify(result), { status: 200, headers });
      }
      if (action === "bootstrap_organizer") {
        body = await readJson(request);
        if (!body) return json({ error: "invalid_body" }, 400);
        const result = await handler({ supabase, body });
        if (result.error) return json({ error: result.error }, result.error === "users_exist" ? 409 : 400);
        return json(result);
      }
      if (action === "change_password") {
        const auth = await requireAuth({ supabase, request });
        body = await readJson(request);
        if (!body) return json({ error: "invalid_body" }, 400);
        const result = await handler({ supabase, body, userId: auth.user.id });
        if (result.error) return json({ error: result.error }, result.error.startsWith("invalid") || result.error === "password_too_short" ? 400 : 503);
        return json(result);
      }
      if (action === "delete_user") {
        const auth = await requireAuth({ supabase, request });
        id = url.searchParams.get("id") || "";
        const result = await handler({ supabase, id, currentUserId: auth.user.id });
        if (result.error) return json({ error: result.error }, result.error === "invalid_id" ? 400 : result.error === "cannot_delete_self" ? 400 : 503);
        return json(result);
      }
      body = await readJson(request);
      if (!body) return json({ error: "invalid_body" }, 400);
      const result = await handler({ supabase, body });
      if (result.error) return json({ error: result.error }, result.error.startsWith("invalid") || result.error.startsWith("too_many") || result.error === "username_exists" || result.error === "password_too_short" ? 400 : 503);
      return json(result);
    } catch {
      return json({ error: "database_request_failed" }, 503);
    }
  }

  return json({ error: "method_not_allowed" }, 405);
}
