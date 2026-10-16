// ═══════════════════════════════════════════════════════════════════
//  db.mjs · 把 supabase-js 的查询链，重建在 node:sqlite 上
// ═══════════════════════════════════════════════════════════════════
//
//  为什么要有这个文件：
//    functions/handler.mjs 里 19 个 action 的业务逻辑，全是「Supabase 形状」的
//    —— from().select().eq().maybeSingle() / insert / upsert / update / delete。
//    这套形状本身跟 Supabase 没有强绑定，只要有人把它翻译成 SQL，handler 就能
//    原地跑在任意数据库上。
//
//    所以这里不重写业务，只做一层「方言适配」：handler 说什么，这里翻成 SQLite。
//    handler.mjs 一个字符都不改。
//
//  用法：
//    import { openDatabase } from "./db.mjs";
//    const { client, close } = openDatabase("server/data/gpic.sqlite");
//    await client.from("notices").select("id,title").order("date", { ascending: false });
//
//  已实现的链式方法（handler 用到的全集）：
//    from · select(cols[, {count, head}]) · insert · upsert · update · delete
//    eq · neq · order(col[, {ascending}]) · limit(n) · maybeSingle()
//    以及直接 await 一个还没终结的构造器（thenable）
//
//  返回值形状与 supabase-js 对齐：{ data, error, count }
//  出错时不抛异常，而是把错误塞进 error，让 handler 原有的
//  `if (error) return { error: "database_request_failed" }` 分支照常生效。
//
//  ⚠️ 只有 node:sqlite（Node 22+ 内置）一个依赖，不装任何 npm 包。
// ═══════════════════════════════════════════════════════════════════

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 表结构元信息 ────────────────────────────────────────────────────
// pk   : 冲突判定用的主键（upsert 的 ON CONFLICT 目标）
// json : 这些列出入库要过 JSON.stringify / JSON.parse
// bool : 这些列出入库要过 0/1 转换
const SCHEMA = {
  site_settings: { pk: "key", json: [], bool: [] },
  hero_content: { pk: "id", json: ["actions", "stats"], bool: [] },
  notices: { pk: "id", json: ["body"], bool: [] },
  brands: { pk: "id", json: [], bool: ["is_self"] },
  goods: { pk: "id", json: ["tags"], bool: ["is_free"] },
  events: { pk: "id", json: [], bool: [] },
  social_links: { pk: "id", json: [], bool: [] },
  about_content: { pk: "id", json: ["paragraphs", "identity_tags", "biz_tags"], bool: [] },
  users: { pk: "id", json: [], bool: [] },
  auth_sessions: { pk: "id", json: [], bool: [] },
};

// JSON 列在「值为空」时回落的默认值，一律空数组（这批列语义上都是列表）
const JSON_EMPTY = "[]";

// ── 安全护栏 ────────────────────────────────────────────────────────

// 标识符白名单：表名、列名、排序字段全部必须过这一关。
// 这些值都来自 handler 里的常量，但拼 SQL 前仍然校验一遍 —— 拼串就是拼串，
// 不留口子。
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function ident(name) {
  if (typeof name !== "string" || !IDENT_RE.test(name)) {
    throw new Error(`invalid identifier: ${String(name)}`);
  }
  return `"${name}"`;
}

function tableMeta(table) {
  const meta = SCHEMA[table];
  if (!meta) throw new Error(`unknown table: ${String(table)}`);
  return meta;
}

// ── 值编解码 ────────────────────────────────────────────────────────

function encodeValue(meta, column, value) {
  if (meta.json.includes(column)) {
    if (value === undefined || value === null) return JSON_EMPTY;
    if (typeof value === "string") {
      // 已经是 JSON 串（例如 site_settings 里的 shop）就原样存，别二次编码
      return value;
    }
    return JSON.stringify(value);
  }
  if (meta.bool.includes(column)) return value ? 1 : 0;
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function decodeRow(meta, row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const raw = row[key];
    if (meta.json.includes(key)) {
      if (typeof raw !== "string") {
        out[key] = raw === null || raw === undefined ? [] : raw;
        continue;
      }
      try {
        out[key] = JSON.parse(raw);
      } catch {
        out[key] = [];
      }
      continue;
    }
    if (meta.bool.includes(key)) {
      out[key] = !!raw;
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// select 的列清单：支持 "*" 和 "a,b,c"
function parseColumns(spec, table) {
  if (!spec || spec === "*") return null; // null 表示取全列
  const cols = String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (cols.length === 0) return null;
  for (const c of cols) {
    if (!IDENT_RE.test(c)) throw new Error(`invalid column: ${c}`);
  }
  return cols;
}

// ── 查询构造器 ──────────────────────────────────────────────────────

class QueryBuilder {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.meta = tableMeta(table);
    this.operation = null; // select | insert | upsert | update | delete
    this.columns = null; // select 列清单，null = 全列
    this.countMode = null; // "exact" | null
    this.headOnly = false;
    this.payload = null; // insert / upsert / update 的数据
    this.filters = []; // [{ column, op: "=" | "<>", value }]
    this.orders = []; // [{ column, ascending }]
    this.limitCount = null;
    this.promise = null; // 缓存，保证 thenable 只执行一次
  }

  // ── 动作 ──

  select(spec = "*", options = {}) {
    this.operation = "select";
    this.columns = parseColumns(spec, this.table);
    if (options && options.count === "exact") this.countMode = "exact";
    if (options && options.head === true) this.headOnly = true;
    return this;
  }

  insert(payload) {
    this.operation = "insert";
    this.payload = payload;
    return this;
  }

  upsert(payload) {
    this.operation = "upsert";
    this.payload = payload;
    return this;
  }

  update(patch) {
    this.operation = "update";
    this.payload = patch;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  // ── 修饰 ──

  eq(column, value) {
    this.filters.push({ column, op: "=", value });
    return this;
  }

  neq(column, value) {
    this.filters.push({ column, op: "<>", value });
    return this;
  }

  order(column, options = {}) {
    const ascending = !(options && options.ascending === false);
    this.orders.push({ column, ascending });
    return this;
  }

  limit(n) {
    this.limitCount = n;
    return this;
  }

  // ── 终结符 ──

  // supabase 语义：0 行 → data null；多行 → 报错（这里取首行，宽容处理）
  maybeSingle() {
    return this._run("single");
  }

  // 让 `await builder` 直接可用（handler 里大量这么写）
  then(onFulfilled, onRejected) {
    return this._run("many").then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this._run("many").catch(onRejected);
  }

  finally(onFinally) {
    return this._run("many").finally(onFinally);
  }

  // ── 执行 ──

  _run(mode) {
    if (this.promise) return this.promise;
    this.promise = (async () => {
      try {
        return await this._execute(mode);
      } catch (err) {
        return { data: null, error: { message: String((err && err.message) || err) }, count: null };
      }
    })();
    return this.promise;
  }

  async _execute(mode) {
    switch (this.operation) {
      case "select":
        return this._executeSelect(mode);
      case "insert":
        return this._executeInsert();
      case "upsert":
        return this._executeUpsert();
      case "update":
        return this._executeUpdate();
      case "delete":
        return this._executeDelete();
      default:
        throw new Error(`no operation set for table ${this.table}`);
    }
  }

  // 生成 WHERE 子句 + 绑定参数
  _where() {
    if (this.filters.length === 0) return { sql: "", params: [] };
    const parts = [];
    const params = [];
    for (const f of this.filters) {
      parts.push(`${ident(f.column)} ${f.op} ?`);
      params.push(this._bind(f.column, f.value));
    }
    return { sql: ` WHERE ${parts.join(" AND ")}`, params };
  }

  // 过滤条件里的值也要按列类型编码（json/bool 列理论上用不到，但保持一致）
  _bind(column, value) {
    if (this.meta.bool.includes(column)) return value ? 1 : 0;
    if (this.meta.json.includes(column)) {
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    return value;
  }

  _executeSelect(mode) {
    const where = this._where();

    // count + head：只要总数，不要行
    if (this.countMode === "exact" && this.headOnly) {
      const sql = `SELECT COUNT(*) AS __count FROM ${ident(this.table)}${where.sql}`;
      const row = this.db.prepare(sql).get(...where.params);
      return { data: null, error: null, count: Number(row && row.__count) || 0 };
    }

    let sql = `SELECT ${this.columns ? this.columns.map(ident).join(", ") : "*"} FROM ${ident(this.table)}${where.sql}`;

    if (this.orders.length > 0) {
      sql += ` ORDER BY ${this.orders
        .map((o) => `${ident(o.column)} ${o.ascending ? "ASC" : "DESC"}`)
        .join(", ")}`;
    }
    if (this.limitCount !== null && this.limitCount !== undefined) {
      sql += ` LIMIT ${Number(this.limitCount) | 0}`;
    }

    const rows = this.db.prepare(sql).all(...where.params).map((r) => decodeRow(this.meta, r));

    if (mode === "single") {
      return { data: rows.length > 0 ? rows[0] : null, error: null, count: null };
    }
    return { data: rows, error: null, count: null };
  }

  _executeInsert() {
    const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
    if (rows.length === 0) return { data: [], error: null, count: null };

    const insertOne = (row) => {
      if (!row || typeof row !== "object") throw new Error("insert payload must be an object");
      const cols = Object.keys(row);
      if (cols.length === 0) throw new Error("insert payload is empty");
      const sql = `INSERT INTO ${ident(this.table)} (${cols.map(ident).join(", ")}) VALUES (${cols
        .map(() => "?")
        .join(", ")})`;
      const params = cols.map((c) => encodeValue(this.meta, c, row[c]));
      this.db.prepare(sql).run(...params);
    };

    if (rows.length === 1) {
      insertOne(rows[0]);
    } else {
      // 多行插入包成事务，避免插一半失败留下半截数据
      this.db.exec("BEGIN");
      try {
        for (const row of rows) insertOne(row);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
    return { data: null, error: null, count: null };
  }

  _executeUpsert() {
    const row = this.payload;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("upsert payload must be a single object");
    }
    const cols = Object.keys(row);
    if (cols.length === 0) throw new Error("upsert payload is empty");

    const pk = this.meta.pk;
    if (!cols.includes(pk)) throw new Error(`upsert payload must include primary key "${pk}"`);

    const updatable = cols.filter((c) => c !== pk);
    const conflict =
      updatable.length > 0
        ? ` DO UPDATE SET ${updatable.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(", ")}`
        : " DO NOTHING";

    const sql =
      `INSERT INTO ${ident(this.table)} (${cols.map(ident).join(", ")}) ` +
      `VALUES (${cols.map(() => "?").join(", ")}) ` +
      `ON CONFLICT(${ident(pk)})${conflict}`;

    const params = cols.map((c) => encodeValue(this.meta, c, row[c]));
    this.db.prepare(sql).run(...params);
    return { data: null, error: null, count: null };
  }

  _executeUpdate() {
    const patch = this.payload;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("update payload must be a single object");
    }
    const cols = Object.keys(patch);
    if (cols.length === 0) throw new Error("update payload is empty");
    if (this.filters.length === 0) throw new Error("update without filter is refused");

    const where = this._where();
    const sql = `UPDATE ${ident(this.table)} SET ${cols.map((c) => `${ident(c)} = ?`).join(", ")}${where.sql}`;
    const params = [...cols.map((c) => encodeValue(this.meta, c, patch[c])), ...where.params];
    this.db.prepare(sql).run(...params);
    return { data: null, error: null, count: null };
  }

  _executeDelete() {
    if (this.filters.length === 0) throw new Error("delete without filter is refused");
    const where = this._where();
    const sql = `DELETE FROM ${ident(this.table)}${where.sql}`;
    this.db.prepare(sql).run(...where.params);
    return { data: null, error: null, count: null };
  }
}

// ── 对外入口 ────────────────────────────────────────────────────────

/**
 * 打开（或就地创建）一个 SQLite 库，返回 supabase 形状的 client。
 *
 * @param {string} file  库文件路径；传 ":memory:" 可开内存库（测试用）
 * @param {{schemaPath?: string, verbose?: boolean}} [options]
 * @returns {{ client: {from: (t: string) => QueryBuilder}, db: DatabaseSync, close: () => void, file: string }}
 */
export function openDatabase(file, options = {}) {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  // 建表：schema.sql 全 IF NOT EXISTS，重复执行安全
  const schemaPath = options.schemaPath || join(__dirname, "schema.sql");
  db.exec(readFileSync(schemaPath, "utf-8"));

  const client = {
    from(table) {
      tableMeta(table); // 提前炸，避免拼出无意义的 SQL
      return new QueryBuilder(db, table);
    },
  };

  return { client, db, file, close: () => db.close() };
}

export { SCHEMA };
export default openDatabase;
