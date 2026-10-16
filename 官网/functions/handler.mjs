const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store" },
});

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noticeIdRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9]+$/;
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
    supabase.from("goods").select("id,badge,badge_style,name,description,image,image_alt,tags,alt_label,price,unit,is_free,free_label").order("display_order"),
    supabase.from("events").select("*").order("date_start", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("social_links").select("id,label,href,sub").order("display_order"),
    supabase.from("about_content").select("*").limit(1).maybeSingle(),
  ]);

  const settings = {};
  let shop = null;
  if (settingsR.data) {
    for (const r of settingsR.data) {
      // shop 单独取出来，别把一坨 JSON 字符串混进 site 里
      if (r.key === SHOP_KEY) { shop = parseShopValue(r.value); continue; }
      settings[r.key] = r.value;
    }
  }

  return {
    ok: true,
    site: settings,
    hero: heroR.data || null,
    notices: noticesR.data || [],
    brands: brandsR.data || [],
    goods: goodsR.data || [],
    event: eventsR.data || null,
    social: socialR.data || [],
    about: aboutR.data || null,
    shop,
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
  const { data, error } = await supabase.from("goods")
    .select("id,badge,badge_style,name,description,image,image_alt,tags,alt_label,price,unit,is_free,free_label")
    .order("display_order");
  if (error || !Array.isArray(data)) return { error: "database_request_failed" };
  return { ok: true, items: data };
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

// ─── 通贩商店（shop）────────────────────────────────────────────
// 刻意不建新表：Qoder Sites 的数据库只经过 /rest/v1（PostgREST）代理，平台侧
// 没有执行 DDL 的入口，新建表在线上根本跑不通。所以复用已有的 site_settings，
// 把整个 shop 对象（title/desc/links/note）存成一条 JSON，零迁移。
const SHOP_KEY = "shop";

function parseShopValue(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const v = JSON.parse(value);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function getShop({ supabase }) {
  const { data, error } = await supabase.from("site_settings")
    .select("value").eq("key", SHOP_KEY).maybeSingle();
  if (error) return { error: "database_request_failed" };
  return { ok: true, ...(parseShopValue(data && data.value) || {}) };
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
  const { id, badge, badge_style, name, description, image, image_alt, tags, alt_label, price, unit, is_free, free_label, display_order } = body;
  if (typeof name !== "string") return { error: "invalid_fields" };
  if (!Array.isArray(tags)) return { error: "invalid_jsonb" };
  const gid = id && uuidRe.test(id) ? id : crypto.randomUUID();
  const t = now();
  const { error } = await supabase.from("goods")
    .upsert({ id: gid, badge: badge || "", badge_style: badge_style || "green", name, description: description || "", image: image || "", image_alt: image_alt || "", tags, alt_label: alt_label || "", price: price || "", unit: unit || "", is_free: !!is_free, free_label: free_label || "", display_order: display_order || 0, updated_at: t });
  if (error) return { error: "database_request_failed" };
  return { ok: true, id: gid };
}

async function deleteGood({ supabase, id }) {
  if (!uuidRe.test(id)) return { error: "invalid_id" };
  const { error } = await supabase.from("goods").delete().eq("id", id);
  if (error) return { error: "database_request_failed" };
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
  const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
  const safeName = `${crypto.randomUUID()}.${ext}`;
  const path = `${IMAGE_BUCKET}/${safeName}`;
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    await storage.storage.upload(path, buf, { contentType: file.type });
    return { ok: true, path: `assets/uploads/${safeName}`, url: `/storage/v1/object/public/${path}` };
  } catch {
    return { error: "upload_failed" };
  }
}

async function listImages() {
  const storage = await getStorage();
  if (!storage || !storage.storage) return { error: "storage_unavailable" };
  try {
    const files = await storage.storage.list(IMAGE_BUCKET, { limit: 100, offset: 0 });
    const items = (Array.isArray(files) ? files : []).map(f => ({
      name: typeof f === "string" ? f : f.name,
      path: `assets/uploads/${typeof f === "string" ? f : f.name}`,
    }));
    return { ok: true, items };
  } catch {
    return { error: "list_failed" };
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
  events: getEvents,
  social: getSocial,
  about: getAbout,
  shop: getShop,
  list_images: listImages,
};

const postActions = {
  save_settings: saveSettings,
  save_hero: saveHero,
  save_notice: saveNotice,
  delete_notice: deleteNotice,
  save_brand: saveBrand,
  delete_brand: deleteBrand,
  save_good: saveGood,
  delete_good: deleteGood,
  save_event: saveEvent,
  save_social: saveSocial,
  save_about: saveAbout,
  save_shop: saveShop,
  upload_image: uploadImage,
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
  "save_brand", "delete_brand", "save_good", "delete_good",
  "save_event", "save_social", "save_about", "save_shop", "upload_image",
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
      if (action === "delete_notice" || action === "delete_brand" || action === "delete_good") {
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
