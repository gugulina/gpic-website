/**
 * migrate-users-perms.mjs —— 给 users 表补 perms 列（2026-10-19 权限改造）
 *
 * 背景：
 *   schema.sql 里建表语句是 CREATE TABLE IF NOT EXISTS，对**已经存在**的库
 *   不会追加新列。老库升级必须先跑本脚本，否则 handler 一查 perms 就报错。
 *
 * 做什么：
 *   1. 列不存在 → ALTER TABLE users ADD COLUMN perms TEXT
 *   2. 把所有 perms 为空的账号回填成「全部内容域可写」
 *      —— 改造前所有管理员本来就能改全部页面，回填是为了升级前后行为不变。
 *      想收权，升级完去后台「账户管理」里一个个改。
 *
 * 幂等：反复执行安全，第 2 步只碰 perms 为空的行。
 *
 * 用法：
 *   node server/migrate-users-perms.mjs                     # 默认正式库
 *   node server/migrate-users-perms.mjs --db 某库.sqlite
 *   node server/migrate-users-perms.mjs --dry-run           # 只看要改什么
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DB_PATH = resolve(argOf("--db", join(__dirname, "data", "gpic.sqlite")));
const DRY = process.argv.includes("--dry-run");

const ALL_PERMS = {
  settings: "write", hero: "write", notices: "write", brands: "write", goods: "write",
  shop: "write", event: "write", recruit: "write", social: "write", about: "write",
  images: "write",
};

if (!existsSync(DB_PATH)) {
  console.error("✗ 找不到数据库：" + DB_PATH);
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000");

console.log("库：" + DB_PATH);

const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
const hasPerms = cols.includes("perms");

if (!hasPerms) {
  if (DRY) {
    console.log("  [dry-run] 需要执行：ALTER TABLE users ADD COLUMN perms TEXT");
  } else {
    db.exec("ALTER TABLE users ADD COLUMN perms TEXT");
    console.log("  ✓ 已加列 perms");
  }
} else {
  console.log("  · perms 列已存在，跳过加列");
}

const before = hasPerms
  ? db.prepare("SELECT id, username, role FROM users WHERE perms IS NULL OR perms = ''").all()
  : db.prepare("SELECT id, username, role FROM users").all();

if (before.length === 0) {
  console.log("  · 没有需要回填的账号");
} else {
  console.log("  待回填 " + before.length + " 个账号：");
  for (const u of before) console.log("      " + u.username + "  (" + u.role + ")");
  if (DRY) {
    console.log("  [dry-run] 未写入。去掉 --dry-run 即执行回填");
  } else {
    // 只在这次加列之前就已经存在的账号：全部给满，保证升级前后能改的页面一样多
    const stmt = db.prepare(
      "UPDATE users SET perms = ? WHERE perms IS NULL OR perms = ''"
    );
    stmt.run(JSON.stringify(ALL_PERMS));
    console.log("  ✓ 已回填为「全部内容域可写」");
  }
}

// 收尾自检：列在、能读出来。（dry-run 且还没加列时跳过，否则 SELECT perms 会报错）
if (!hasPerms && DRY) {
  console.log("");
  console.log("  [dry-run] 正式执行后会自动打印账号清单");
  db.close();
  process.exit(0);
}

const after = db.prepare("SELECT username, role, perms FROM users ORDER BY created_at").all();
console.log("");
console.log("  当前账号：");
for (const u of after) {
  const label = u.role === "organizer"
    ? "主催（全权，忽略 perms）"
    : u.perms ? Object.keys(JSON.parse(u.perms)).length + " 个页面" : "无权限";
  console.log("    " + u.username.padEnd(16) + u.role.padEnd(11) + label);
}

db.close();
