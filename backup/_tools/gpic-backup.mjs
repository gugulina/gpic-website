/**
 * GPIC 官网 · 三层备份脚本
 *
 *   ① 完整文件副本  backup/gpic-<时间戳>/          可直接 node server/index.mjs 跑
 *   ② 库一致性快照  backup/db/gpic-<时间戳>.sqlite VACUUM INTO，WAL 写入全部合并
 *   ③ git 全历史    backup/gpic-<时间戳>.bundle    --all，可 clone 出完整仓库
 *
 * 为什么不能只备份 git：数据库 / 后台页 / 上传图 / 项目记忆 都在 .gitignore 里，
 * 不在版本库中。只用 git 备份 = 丢光内容数据。
 *
 * 用法：node backup/_tools/gpic-backup.mjs
 */
import {
  cpSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync,
} from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

// ── 定位项目根（本脚本在 backup/_tools/ 下）──────────────────────
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const BK = join(ROOT, 'backup');

// ── 定位 git 可执行文件 ─────────────────────────────────────────
// 这台机器没有装 Git for Windows，只有 WorkBuddy 自带的 PortableGit，
// 而且它不在 PATH 里。直接 spawnSync('git') 会 ENOENT：status=null、
// stderr=null，表现出来就是「✘ 失败：」后面一片空白（2026-10-19 踩过）。
// 逻辑与根目录 sync-public.mjs 的 findGit() 保持一致，改一处记得改两处。
const capture = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return r && !r.error && r.status === 0 ? String(r.stdout || '').trim() : '';
};

function findGit() {
  const home = process.env.USERPROFILE || '';

  // ① WorkBuddy 自带 PortableGit：版本号会变，扫目录而不是写死
  const pgRoot = join(home, '.workbuddy', 'binaries', 'PortableGit', 'versions');
  if (existsSync(pgRoot)) {
    try {
      for (const v of readdirSync(pgRoot)) {
        const p = join(pgRoot, v, 'cmd', 'git.exe');
        if (existsSync(p)) return p;
      }
    } catch {
      /* 读不了就当没有 */
    }
  }

  // ② 常见的 Git for Windows 安装位置
  const fixed = [
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    join(home, 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
  ];
  for (const p of fixed) if (existsSync(p)) return p;

  // ③ 最后才信 PATH
  for (const line of capture('where', ['git']).split(/\r?\n/)) {
    const p = line.trim();
    if (p && existsSync(p)) return p;
  }
  return null;
}

const GITBIN = findGit();

// ── 时间戳（本地时间）───────────────────────────────────────────
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const TS = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
         + `-${p2(d.getHours())}${p2(d.getMinutes())}`;

// ── 排除项 ──────────────────────────────────────────────────────
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp-e2e', 'backup', '.trash']);
const SKIP_FILES = new Set(['Thumbs.db', 'Desktop.ini', '.DS_Store']);

function filter(src) {
  const name = src.split(/[\\/]/).pop();
  if (SKIP_DIRS.has(name) && statSync(src).isDirectory()) return false;
  if (SKIP_FILES.has(name)) return false;
  // 排除 SQLite 的运行期附属文件（快照会单独做）
  if (/gpic\.sqlite-(wal|shm|journal)$/.test(name)) return false;
  return true;
}

const human = (n) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
};

const treeStat = (dir) => {
  let bytes = 0, files = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else { try { bytes += statSync(full).size; files++; } catch {} }
    }
  };
  walk(dir);
  return { bytes, files };
};

console.log('='.repeat(68));
console.log(`GPIC 官网备份   时间戳 ${TS}`);
console.log(`项目根  ${ROOT}`);
console.log('='.repeat(68));

mkdirSync(BK, { recursive: true });
const SNAP = join(BK, `gpic-${TS}`);

// ══ ① 完整文件副本 ═════════════════════════════════════════════
// 注意：不能直接 cpSync(ROOT, SNAP) —— Node 会先做路径检查，判定
// 「目标是自己的子目录」直接抛 ERR_FS_CP_EINVAL，filter 拦不住。
// 所以改为逐项复制 ROOT 下的顶层条目，把 backup/.git/node_modules 跳过。
console.log('\n[1/3] 复制工作区文件 …');
const t0 = Date.now();
// 时间戳只精确到分钟，同一分钟内双击两次会撞名。name 已存在时不能直接往上
// cpSync：Windows 下覆盖已存在文件会失败（shim 层 unlink 报 errno 0，
// 「The operation completed successfully」这种鬼话）。所以先删干净再重建。
if (existsSync(SNAP)) {
  console.log(`  · 同名备份已存在（同一分钟内重跑），清理后重建`);
  try {
    rmSync(SNAP, { recursive: true, force: true });
  } catch (e) {
    console.log(`  ✘ 删不掉旧目录：${e.message}`);
    console.log('    可能有文件正被打开（编辑器/资源管理器预览），关掉后重试。');
    process.exit(1);
  }
}
mkdirSync(SNAP, { recursive: true });
for (const e of readdirSync(ROOT, { withFileTypes: true })) {
  if (SKIP_DIRS.has(e.name) || SKIP_FILES.has(e.name)) continue;
  const src = join(ROOT, e.name);
  const dst = join(SNAP, e.name);
  if (e.isDirectory()) cpSync(src, dst, { recursive: true, filter });
  else cpSync(src, dst);
}
const st = treeStat(SNAP);
console.log(`  ✔ ${relative(ROOT, SNAP)}`);
console.log(`    ${st.files} 个文件 / ${human(st.bytes)} / 用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

// ══ ② 数据库一致性快照 ═════════════════════════════════════════
console.log('\n[2/3] 数据库一致性快照 …');
const dbSrc = join(ROOT, '官网', 'server', 'data', 'gpic.sqlite');
const dbDir = join(BK, 'db');
mkdirSync(dbDir, { recursive: true });
const dbDst = join(dbDir, `gpic-${TS}.sqlite`);

if (!existsSync(dbSrc)) {
  console.log('  ! 源库不存在，跳过');
} else {
  if (existsSync(dbDst)) rmSync(dbDst, { force: true });

  const con = new DatabaseSync(dbSrc, { readOnly: true });
  // VACUUM INTO 输出事务一致的干净副本；WAL 里未合并的写入会被全部包含
  con.exec(`VACUUM INTO '${dbDst.replace(/\\/g, '/').replace(/'/g, "''")}'`);
  con.close();

  // 校验快照
  const v = new DatabaseSync(dbDst, { readOnly: true });
  const cnt = (t) => v.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c;
  const goods = cnt('goods');
  const notices = cnt('notices');
  const users = v.prepare('SELECT username FROM users').all().map((r) => r.username);
  const tables = v.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  v.close();

  console.log(`  ✔ ${relative(ROOT, dbDst)}  (${human(statSync(dbDst).size)})`);
  console.log(`    表 ${tables.length} 个 | goods ${goods} | notices ${notices} | users [${users.join(', ')}]`);

  // 用干净快照替换副本里的库，并清掉 WAL 附属文件（跨机器更安全）
  // 注意：Windows 下 cpSync 覆盖已存在文件会失败（shim 层 unlink 报 errno 0），
  // 所以先删再拷。
  const snapDb = join(SNAP, '官网', 'server', 'data', 'gpic.sqlite');
  if (existsSync(snapDb)) {
    for (const ext of ['', '-wal', '-shm', '-journal']) {
      const p = snapDb + ext;
      if (existsSync(p)) rmSync(p, { force: true });
    }
    copyFileSync(dbDst, snapDb);
    console.log('    已用快照替换副本内的库（并移除 -wal / -shm）');
  }
}

// ══ ③ git 全历史 bundle ════════════════════════════════════════
console.log('\n[3/3] git 历史打包 …');
const bundle = join(BK, `gpic-${TS}.bundle`);

if (!GITBIN) {
  console.log('  ⚠ 跳过：找不到 git.exe');
  console.log('    这台机器没装 Git for Windows，WorkBuddy 自带的 PortableGit 也没找到。');
  console.log('    ① 文件副本和 ② 库快照已经备好了，只有 git 历史这次没打包。');
  console.log('    装一个 Git（或在 .workbuddy\\binaries\\PortableGit 里放一份）后重跑即可。');
} else if (!existsSync(join(ROOT, '.git'))) {
  console.log('  ⚠ 跳过：项目根没有 .git 目录');
  console.log(`    请从完整项目文件夹运行本脚本（当前 ${ROOT}）。`);
} else {
  if (existsSync(bundle)) rmSync(bundle, { force: true });

  const r = spawnSync(GITBIN, ['bundle', 'create', bundle, '--all'],
    { cwd: ROOT, encoding: 'utf8' });

  // 三种失败要分开说：命令都起不来 / 起来了但报错 / 正常结束
  if (r.error) {
    console.log(`  ✘ 失败：${r.error.message}`);
    console.log(`    git 路径：${GITBIN}`);
  } else if (r.status !== 0) {
    const msg = ((r.stderr || '') + (r.stdout || '')).trim();
    console.log(`  ✘ 失败：${msg || `git 退出码 ${r.status}`}`);
  } else {
    console.log(`  ✔ ${relative(ROOT, bundle)}  (${human(statSync(bundle).size)})`);
    const v = spawnSync(GITBIN, ['bundle', 'verify', bundle], { cwd: ROOT, encoding: 'utf8' });
    for (const line of String(v.stdout || '').split('\n').filter((l) => l.trim()).slice(0, 5)) {
      console.log('    ' + line.trim());
    }
  }
}

// ══ 小结 ═══════════════════════════════════════════════════════
const headTxt = GITBIN
  ? (capture(GITBIN, ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }) || '（读取失败）')
  : '（git 不可用）';
const dirtyLines = GITBIN
  ? capture(GITBIN, ['status', '--porcelain'], { cwd: ROOT })
  : '';

console.log('\n' + '='.repeat(68));
console.log(`完成。HEAD = ${headTxt}`);
if (dirtyLines) {
  console.log('⚠️  工作区有未提交的改动 —— bundle 只含已提交历史，');
  console.log('    这些改动只存在于「① 副本」里。建议先 git commit 再备份。');
}
console.log(`备份根目录：${BK}`);
console.log('='.repeat(68));
