// ═══════════════════════════════════════════════════════════════════
//  functions/storage.mjs · 自持版对象存储（本地文件系统）
// ═══════════════════════════════════════════════════════════════════
//
//  背景：
//    handler.mjs 的 getStorage() 原本只认 "./_qoder/storage.mjs"，那是 Qoder
//    平台注入的托管存储。自持部署时那个文件不存在，上传/图片列表就整个失效。
//
//    现在 getStorage() 改成按候选列表探测，本文件是第二顺位：
//      1. ./_qoder/storage.mjs  ← 平台托管（部署到 Qoder 时优先，本文件不生效）
//      2. ./storage.mjs         ← 本文件，自持时生效
//    两条路都实现同一个接口，handler 不用知道自己跑在哪。
//
//  接口（照抄平台那套，所以 handler 里的调用原地可用）：
//    storage.upload(path, dataUint8Array, { contentType })  → Promise<object>
//    storage.list(bucket, { limit, offset })                → Promise<{name,size,updated_at}[]>
//
//  存储位置映射：
//    对象路径 images/<uuid>.webp  →  web/assets/uploads/<uuid>.webp
//    （handler 上传后返回给前端的 path 是 "assets/uploads/<uuid>.webp"，
//      正好是 web/ 下的相对路径，前端 <img src> 直接能用，所以落盘也必须在这）
//
//  ⚠️ 只有 node: 内置模块，零 npm 依赖。
// ═══════════════════════════════════════════════════════════════════

import { mkdir, writeFile, readdir, stat, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// functions/ 的上一级就是站点根，上传目录落在 web/ 里
const WEB_ROOT = join(__dirname, "..", "web");
const UPLOAD_DIR = join(WEB_ROOT, "assets", "uploads");
const PUBLIC_PREFIX = "assets/uploads";

// 单个对象名只允许这些字符，杜绝 ../ 之类的路径穿越
const OBJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function assertSafeName(name) {
  if (typeof name !== "string" || !OBJECT_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`invalid object name: ${String(name)}`);
  }
  return name;
}

// images/<uuid>.webp → <uuid>.webp（bucket 段丢掉，只取最后一段）
function objectNameFromPath(path) {
  const segments = String(path).split("/").filter(Boolean);
  if (segments.length === 0) throw new Error("empty object path");
  return assertSafeName(segments[segments.length - 1]);
}

async function ensureDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

export const storage = {
  /**
   * 上传一个对象。
   * @param {string} path       形如 "images/<name>"
   * @param {Uint8Array} data   字节内容
   * @param {{contentType?: string}} [options]
   */
  async upload(path, data, options = {}) {
    await ensureDir();
    const name = objectNameFromPath(path);
    const target = join(UPLOAD_DIR, name);

    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    await writeFile(target, bytes);

    return {
      path,
      name,
      size: bytes.byteLength,
      contentType: options.contentType || "application/octet-stream",
      publicUrl: `/${PUBLIC_PREFIX}/${name}`,
    };
  },

  /**
   * 列出某个 bucket 下的对象（按文件名排序，支持分页）。
   * @param {string} bucket
   * @param {{limit?: number, offset?: number}} [options]
   */
  async list(bucket, options = {}) {
    await ensureDir();
    const limit = Number.isFinite(options.limit) ? Number(options.limit) : 100;
    const offset = Number.isFinite(options.offset) ? Math.max(0, Number(options.offset)) : 0;

    const entries = await readdir(UPLOAD_DIR, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue; // 跳过 .gitkeep 之类
      if (!OBJECT_NAME_RE.test(entry.name)) continue;
      const info = await stat(join(UPLOAD_DIR, entry.name));
      files.push({
        name: entry.name,
        size: info.size,
        updated_at: info.mtime.toISOString(),
      });
    }

    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return files.slice(offset, offset + limit);
  },

  /** 删除一个对象（handler 目前没用到，留给后台清理用） */
  async remove(path) {
    const name = objectNameFromPath(path);
    await rm(join(UPLOAD_DIR, name), { force: true });
    return { path };
  },
};

// 便于测试与换目录时复用
export const paths = { WEB_ROOT, UPLOAD_DIR, PUBLIC_PREFIX };

export default storage;
