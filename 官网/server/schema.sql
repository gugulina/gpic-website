-- ═══════════════════════════════════════════════════════════════════
--  幻想乡电力投资集团 官网 · 自持数据库 schema
--  SQLite（node:sqlite / DatabaseSync），零 npm 依赖
-- ═══════════════════════════════════════════════════════════════════
--
--  这张 schema 是「照着 functions/handler.mjs 反推」出来的，不是另起炉灶：
--  handler 里出现的每一个表名 / 列名都在这里有对应列，所以 handler.mjs 能原样
--  跑在 SQLite 上，一行业务逻辑都不用改。
--
--  列类型约定（SQLite 无真类型，靠 db.mjs 编解码）：
--    · JSON 列  → 存 TEXT，写入时 JSON.stringify，读取时 JSON.parse
--    · 布尔列   → 存 INTEGER 0/1，读取时还原成 true/false
--    · 其余     → TEXT / INTEGER
--
--  主键：
--    · site_settings 用 key（它就是 KV 表）
--    · hero_content / about_content 是单行表，固定用哨兵 UUID
--      '00000000-0000-0000-0000-000000000001'（handler 里硬写的）
--    · 其余用 id
--
--  幂等：全部 IF NOT EXISTS，重复执行不会破坏已有数据。
-- ═══════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── 站点设置（KV）─────────────────────────────────────────────────
-- handler: getSettings / saveSettings / getShop / saveShop
-- 注意 key='shop' 那一行存的是一整坨 shop JSON（title/desc/links/note），
-- getAll 会把它单独挑出来，不混进 site 对象里。
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT
);

-- ── 首页横幅（单行）───────────────────────────────────────────────
-- handler: getHero / saveHero
-- actions = [{label,href,style}]
-- stats   = [{num,label}]
CREATE TABLE IF NOT EXISTS hero_content (
  id              TEXT PRIMARY KEY,
  banner          TEXT NOT NULL DEFAULT '',
  banner_fallback TEXT NOT NULL DEFAULT '',
  banner_alt      TEXT NOT NULL DEFAULT '',
  badge           TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL DEFAULT '',
  sub             TEXT NOT NULL DEFAULT '',
  actions         TEXT NOT NULL DEFAULT '[]',   -- JSON
  stats           TEXT NOT NULL DEFAULT '[]',   -- JSON
  updated_at      TEXT
);

-- ── 公告 ──────────────────────────────────────────────────────────
-- handler: getNotices / getNotice / saveNotice / deleteNotice
-- id 形如 2026-09-20-a（noticeIdRe 校验）
-- body = blocks 数组，kind ∈ p / h / ul / quote / sign / img / hr …
CREATE TABLE IF NOT EXISTS notices (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL DEFAULT '',
  type       TEXT NOT NULL DEFAULT '',
  style      TEXT NOT NULL DEFAULT 'green',
  summary    TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  cover      TEXT NOT NULL DEFAULT '',
  cover_alt  TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '[]',         -- JSON blocks
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_date ON notices(date DESC);

-- ── 集团成员品牌 ──────────────────────────────────────────────────
-- handler: getBrands / saveBrand / deleteBrand
CREATE TABLE IF NOT EXISTS brands (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sub           TEXT NOT NULL DEFAULT '',
  logo          TEXT NOT NULL DEFAULT '',
  is_self       INTEGER NOT NULL DEFAULT 0,      -- 布尔
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_brands_order ON brands(display_order);

-- ── 制品 / 通贩商品 ───────────────────────────────────────────────
-- handler: getGoods / getAdminGoods / saveGood / setGoodStatus / deleteGood
-- tags = string[]
-- status 三态（见 goods.html / index.html 的渲染分支）：
--   on_sale   在售 —— 正常展示，可导流到通贩平台
--   sold_out  售罄 —— 仍然展示（含图片与描述），但标注售罄、不提供购买入口
--   off_shelf 下架 —— 公开接口一律不返回，仅在后台可见，数据保留可随时重新上架
CREATE TABLE IF NOT EXISTS goods (
  id            TEXT PRIMARY KEY,
  badge         TEXT NOT NULL DEFAULT '',
  badge_style   TEXT NOT NULL DEFAULT 'green',
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  image         TEXT NOT NULL DEFAULT '',
  image_alt     TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '[]',      -- JSON
  alt_label     TEXT NOT NULL DEFAULT '',
  price         TEXT NOT NULL DEFAULT '',
  unit          TEXT NOT NULL DEFAULT '',
  is_free       INTEGER NOT NULL DEFAULT 0,      -- 布尔
  free_label    TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'on_sale', -- on_sale / sold_out / off_shelf
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_goods_order ON goods(display_order);

-- ── 参展活动 ──────────────────────────────────────────────────────
-- handler: getEvents / saveEvent
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  badge       TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  subtitle    TEXT NOT NULL DEFAULT '',
  booth       TEXT NOT NULL DEFAULT '',
  debut       TEXT NOT NULL DEFAULT '',
  date_start  TEXT NOT NULL DEFAULT '',
  date_end    TEXT NOT NULL DEFAULT '',
  link_label  TEXT NOT NULL DEFAULT '',
  link_href   TEXT NOT NULL DEFAULT '',
  visual      TEXT NOT NULL DEFAULT '',
  visual_alt  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(date_start DESC);

-- ── 社交链接 ──────────────────────────────────────────────────────
-- handler: getSocial / saveSocial（整表删干净再按数组顺序插回）
CREATE TABLE IF NOT EXISTS social_links (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  href          TEXT NOT NULL DEFAULT '',
  sub           TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_social_order ON social_links(display_order);

-- ── 关于我们（单行）───────────────────────────────────────────────
-- handler: getAbout / saveAbout
-- paragraphs / identity_tags / biz_tags 均为 JSON 数组
CREATE TABLE IF NOT EXISTS about_content (
  id             TEXT PRIMARY KEY,
  badge          TEXT NOT NULL DEFAULT '',
  title          TEXT NOT NULL DEFAULT '',
  subtitle       TEXT NOT NULL DEFAULT '',
  paragraphs     TEXT NOT NULL DEFAULT '[]',     -- JSON
  identity_title TEXT NOT NULL DEFAULT '',
  identity_tags  TEXT NOT NULL DEFAULT '[]',     -- JSON
  biz_title      TEXT NOT NULL DEFAULT '',
  biz_tags       TEXT NOT NULL DEFAULT '[]',     -- JSON
  visual         TEXT NOT NULL DEFAULT '',
  visual_alt     TEXT NOT NULL DEFAULT '',
  updated_at     TEXT
);

-- ── 后台账号 ──────────────────────────────────────────────────────
-- handler: doLogin / doCreateUser / doChangePassword / doListUsers
-- role ∈ organizer / admin（organizer 才能管用户）
-- 口令用 PBKDF2-SHA256，100000 轮；明文永不入库
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT,
  updated_at    TEXT
);

-- ── 会话 ──────────────────────────────────────────────────────────
-- handler: doLogin / doLogout / requireAuth
-- 有效期 24h，过期即由 requireAuth 顺手删掉
CREATE TABLE IF NOT EXISTS auth_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);
