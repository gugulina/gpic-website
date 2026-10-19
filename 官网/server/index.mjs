// ═══════════════════════════════════════════════════════════════════
//  server/index.mjs · 自持动态站入口（Node 原生 http，零依赖）
// ═══════════════════════════════════════════════════════════════════
//
//  这个文件负责把「一个静态目录 + 一个 handler」缝成一个能跑的动态站：
//
//    GET  /                       → web/index.html（以及其余静态资源）
//    GET  /assets/images/x.webp   → 站点图片（含后台上传的）
//    *    /functions/v1/app       → functions/handler.mjs 的 19 个 action
//
//  它替掉的，正好是 Qoder 平台注入的那两层：
//    · functions/index.ts      —— Deno.serve(...) 平台入口
//    · functions/adapter.mjs   —— 平台租户校验 + /rest/v1 代理
//  这两层做的事（起服务、把 supabase 客户端递进去）这里用 30 行 Node 原生代码
//  就完成了，而且没有 x-instance-id 租户头、没有环境变量依赖。
//
//  ⚠️ 只有 node: 内置模块，零 npm 依赖。
// ═══════════════════════════════════════════════════════════════════

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, stat, mkdir } from "node:fs/promises";
import { join, extname, dirname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { openDatabase } from "./db.mjs";
import { handleRequest } from "../functions/handler.mjs";
import { paths as storagePaths } from "../functions/storage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_ROOT = join(ROOT, "web");
const API_PATH = "/functions/v1/app";

// ── 命令行参数 ──────────────────────────────────────────────────────
function argValue(flag, fallback) {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(flag);
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  return fallback;
}

const PORT = Number(argValue("--port", process.env.GPIC_PORT || 4321));
const HOST = argValue("--host", process.env.GPIC_HOST || "127.0.0.1");
const DB_FILE = argValue("--db", process.env.GPIC_DB || join(__dirname, "data", "gpic.sqlite"));

// ── 站点版本 ────────────────────────────────────────────────────────
// 真源只有一份：web/version.json（它本身也作为 /version.json 对外可读）。
// 这里读它只为两件事：给每个响应盖一个 X-GPIC-Version 头（curl -I 就能
// 看出线上跑的是哪版），以及启动时在控制台报一句。
// 读不到不算致命：版本号只是排障线索，不该拦住站点启动。
const VERSION_FILE = join(WEB_ROOT, "version.json");
let SITE_VERSION = null;
try {
  SITE_VERSION = JSON.parse(readFileSync(VERSION_FILE, "utf8"));
} catch {
  SITE_VERSION = null;
}
const VERSION_TAG = SITE_VERSION ? "v" + SITE_VERSION.version : "";

// ── MIME ────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
};

// ── 请求体读取 ──────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      // 硬上限 12MB：比 handler 自己的 5MB 图片限制宽松，超了直接掐断连接
      if (size > 12 * 1024 * 1024) {
        rejectBody(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

// ── API 分支 ────────────────────────────────────────────────────────
function toWebRequest(req, url, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else headers.set(key, value);
  }
  const method = req.method || "GET";
  const init = { method, headers };
  if (body && body.length > 0 && method !== "GET" && method !== "HEAD") init.body = body;
  return new Request(url, init);
}

async function sendWebResponse(res, response) {
  const headers = {};
  for (const [key, value] of response.headers) {
    const k = key.toLowerCase();
    if (k === "content-length" || k === "set-cookie") continue;
    headers[k] = value;
  }
  // 会话 cookie 可能有多条，必须用数组透传，否则被合并成一条失效
  const setCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;

  const buffer = Buffer.from(await response.arrayBuffer());
  headers["content-length"] = buffer.byteLength;

  res.writeHead(response.status, headers);
  res.end(buffer);
}

// ── 静态分支 ────────────────────────────────────────────────────────
function safeJoin(rootDir, urlPath) {
  // 先解码，再 normalize，最后确认没跑出根目录
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const full = resolve(rootDir, relative);
  if (full !== rootDir && !full.startsWith(rootDir + sep)) return null;
  return full;
}

async function isFile(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

async function serveStatic(res, pathname, { headOnly = false } = {}) {
  let target = pathname === "/" ? "/index.html" : pathname;
  let full = safeJoin(WEB_ROOT, target);

  if (full && !(await isFile(full))) {
    // 干净 URL 兜底：/notice → /notice.html
    if (!extname(full)) {
      const withHtml = `${full}.html`;
      if (await isFile(withHtml)) {
        full = withHtml;
        target = `${target}.html`;
      } else {
        full = null;
      }
    } else {
      full = null;
    }
  }

  if (!full) {
    // 站点自带 404.html，拿它当错误页
    const notFound = join(WEB_ROOT, "404.html");
    if (await isFile(notFound)) {
      const body = await readFile(notFound);
      res.writeHead(404, {
        "content-type": MIME[".html"],
        "content-length": body.byteLength,
        "cache-control": "no-store",
      });
      res.end(headOnly ? undefined : body);
      return;
    }
    res.writeHead(404, { "content-type": MIME[".txt"] });
    res.end("404 Not Found");
    return;
  }

  const ext = extname(full).toLowerCase();
  const body = await readFile(full);
  const headers = {
    "content-type": MIME[ext] || "application/octet-stream",
    "content-length": body.byteLength,
  };
  // HTML 不缓存（后台改完即时可见），其余资源短缓存
  headers["cache-control"] = ext === ".html" ? "no-store" : "public, max-age=300";
  res.writeHead(200, headers);
  res.end(headOnly ? undefined : body);
}

// ── 启动 ────────────────────────────────────────────────────────────

const { client, close } = openDatabase(DB_FILE);

// 图库目录先建出来，免得首张图上传前 list_images 报错
await mkdir(storagePaths.IMAGE_DIR, { recursive: true });

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const { pathname } = url;
  const headOnly = req.method === "HEAD";

  // 每个响应都盖版本号：线上排障时 curl -I 一眼看出跑的是哪一版，
  // 不用登机器翻文件。writeHead 只合并同名键，这条不会被覆盖掉。
  if (VERSION_TAG) res.setHeader("X-GPIC-Version", VERSION_TAG);

  try {
    // ── 后端 API ──
    if (pathname === API_PATH) {
      const body = req.method === "GET" || headOnly ? null : await readBody(req);
      const request = toWebRequest(req, url.toString(), body);
      const response = await handleRequest({ request, supabase: client });
      await sendWebResponse(res, response);
      return;
    }

    // ── 上传对象的公共访问路径（handler 返回的 url 字段指到这里）──
    const objectMatch = pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (objectMatch) {
      await serveStatic(res, `/assets/images/${objectMatch[2]}`, { headOnly });
      return;
    }

    // ── 静态站点 ──
    if (req.method === "GET" || headOnly) {
      await serveStatic(res, pathname, { headOnly });
      return;
    }

    res.writeHead(405, { "content-type": MIME[".txt"], "cache-control": "no-store" });
    res.end("405 Method Not Allowed");
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": MIME[".json"], "cache-control": "no-store" });
    }
    res.end(JSON.stringify({ error: "internal_error", message: String((err && err.message) || err) }));
  }
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  console.log("");
  console.log("  幻想乡电力投资集团 官网 · 自持动态站已启动");
  if (SITE_VERSION) {
    console.log("  版本 " + VERSION_TAG + "  (" + SITE_VERSION.released + " · " + SITE_VERSION.name + ")");
  } else {
    console.log("  版本  未读到 web/version.json");
  }
  console.log("  ─────────────────────────────────────────────");
  console.log(`  站点首页    ${base}/`);
  console.log(`  公告        ${base}/notice.html`);
  console.log(`  制品        ${base}/goods.html`);
  console.log(`  管理后台    ${base}/admin.html`);
  console.log(`  后端接口    ${base}${API_PATH}?action=all`);
  console.log("  ─────────────────────────────────────────────");
  console.log(`  数据库      ${DB_FILE}`);
  console.log(`  图库目录    ${storagePaths.IMAGE_DIR}`);
  console.log("");
  console.log("  首次使用请先跑：node server/seed.mjs");
  console.log("  停止服务：Ctrl+C");
  console.log("");
});

function shutdown() {
  console.log("\n  正在关闭…");
  server.close(() => {
    try { close(); } catch { /* 已关就忽略 */ }
    process.exit(0);
  });
  // 兜底：3 秒还没退就强退
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
