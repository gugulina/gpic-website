#!/usr/bin/env node
/**
 * sync-public.mjs —— 把后台改的内容一键送上公网
 *
 * 由 同步到公网.bat 调用。三步：
 *   [1/3] 导出：SQLite 库 → data/content.json
 *   [2/3] 打包：content.json → 静态快照 web-standalone/
 *   [3/3] 上线：git commit + git push → GitHub Pages 自动发布
 *
 * 位置：本脚本与 同步到公网.bat 都放在**仓库根**（.git / .github 那一层），
 *   因为第 3 步做的是仓库级操作，和站点源码不在同一语义层。
 *   站点目录固定为「官网/」，由 ROOT 拼出来，不依赖当前工作目录。
 *
 * 为什么第 3 步必不可少：
 *   后台的「保存」只写本机的 SQLite 库。公网读的是仓库里的
 *   data/content.json。前两步只把本地文件改新，不推上去，线上
 *   永远还是旧内容 —— 这就是「点了保存但公网没变」的全部原因。
 *
 * 为什么中文提示写在 Node 里、而不是写在 .bat 里：
 *   cmd 在 chcp 65001（UTF-8 代码页）下解析批处理时，多字节中文
 *   会让读缓冲按字节/字符混算，行首几个字符被吞掉，表现为
 *   「'上地址：' 不是内部或外部命令」。实测：中文 + chcp 65001 必错，
 *   纯 ASCII + chcp 65001 正常，因此 bat 保持纯 ASCII，中文全在
 *   本文件输出（Node 的 UTF-8 输出不受此影响）。
 *
 *   这也是本文件虽然从 官网/scripts/ 搬到了仓库根、而 .bat 里的
 *   调用路径写成 "%~dp0sync-public.mjs" 而不是 "%~dp0官网\\scripts\\..." 的原因：
 *   后者会在 bat 里留下「官网」两个字，前功尽弃。
 *
 * 用法：
 *   node sync-public.mjs
 *   node sync-public.mjs --dry-run    # 只做到第 2 步，不提交不推送
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url)); // 仓库根：.git / .github 所在层
const SITE = join(ROOT, "官网");                       // 站点目录
const DRY = process.argv.includes("--dry-run");

const SEP = "  " + "-".repeat(60);
const say = (s = "") => process.stdout.write(s + "\n");
const step = (s) => say("\n  " + s + "\n");

function die(title, lines = []) {
  say("");
  say(SEP);
  say("  [X] " + title);
  for (const l of lines) say("      " + l);
  say(SEP);
  say("");
  process.exit(1);
}

/** 跑子进程并继承输出，返回是否成功 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  return r.status === 0;
}

/** 静默跑，拿 stdout；失败返回 null */
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim();
}

// ── 找 git ──
// 这台机器没装 Git for Windows，只有 WorkBuddy 自带的 PortableGit，
// 而 PortableGit 不在系统 PATH 里。双击 bat 时 cmd 的 PATH 很短，
// 'git' 直接是「找不到命令」，spawnSync 返回 status=null，
// 表现出来却像是「这个目录不是 git 仓库」—— 2026-10-19 真踩过。
function findGit() {
  const home = process.env.USERPROFILE || "";

  // ① WorkBuddy 自带 PortableGit：版本号会变，扫目录而不是写死
  const pgRoot = join(home, ".workbuddy", "binaries", "PortableGit", "versions");
  if (existsSync(pgRoot)) {
    try {
      for (const v of readdirSync(pgRoot)) {
        const p = join(pgRoot, v, "cmd", "git.exe");
        if (existsSync(p)) return p;
      }
    } catch {
      /* 读不了就当没有 */
    }
  }

  // ② 常见的 Git for Windows 安装位置
  const fixed = [
    "C://Program Files//Git//cmd//git.exe",
    "C://Program Files (x86)//Git//cmd//git.exe",
    join(home, "AppData", "Local", "Programs", "Git", "cmd", "git.exe"),
  ];
  for (const p of fixed) if (existsSync(p)) return p;

  // ③ 最后才信 PATH
  const which = capture("where", ["git"]);
  if (which) {
    for (const line of which.split(/\r?\n/)) {
      const p = line.trim();
      if (p && existsSync(p)) return p;
    }
  }
  return null;
}

// ── 找 Python 3：优先 WorkBuddy 自带的，跳过 Microsoft Store 的占位存根 ──
function findPython() {
  const managed = join(
    process.env.USERPROFILE || "",
    ".workbuddy", "binaries", "python", "versions", "3.13.12", "python.exe",
  );
  if (existsSync(managed)) return managed;

  const which = capture("where", ["python"]);
  if (which) {
    for (const line of which.split(/\r?\n/)) {
      const p = line.trim();
      if (p && !/WindowsApps/i.test(p) && existsSync(p)) return p;
    }
  }
  for (const c of ["py", "python3"]) {
    if (capture("where", [c])) return c;
  }
  return null;
}

// ════════════════════════════════════════════════════════════
say("");
say(SEP);
say("  幻电投官网 · 内容同步到公网");
say(SEP);

// ── 前置检查 ──
// 脚本靠自身位置推仓库根，所以先确认「同层找得到 官网/」。
// 少了这一步的话，脚本被拷到别处时会误报「找不到数据库」，很难查。
if (!existsSync(join(SITE, "web")) || !existsSync(join(SITE, "server"))) {
  die("脚本位置不对：它必须和「官网」文件夹放在同一层。", [
    "脚本当前所在目录：" + ROOT,
    "同层应当能找到「官网」文件夹，里面有 web/ 与 server/。",
    "把 同步到公网.bat 和 sync-public.mjs 一起放回仓库根目录即可。",
  ]);
}

const DB = join(SITE, "server", "data", "gpic.sqlite");
if (!existsSync(DB)) {
  die("找不到数据库 server/data/gpic.sqlite", [
    "先双击「启动自持站.bat」跑一次，它会在首次启动时建库。",
  ]);
}
if (!existsSync(join(SITE, "data", "content.json"))) {
  die("找不到骨架文件 data/content.json", ["这个文件应该在仓库里，检查是不是被删了。"]);
}

// ── [1/3] 导出 ──
step("[1/3] 导出数据库内容 → data/content.json");
if (!run(process.execPath, [join(SITE, "server", "export.mjs")])) {
  die("导出失败，后面两步没有执行，本地文件未被改动。");
}

// ── [2/3] 重建静态快照 ──
step("[2/3] 重建静态快照 → web-standalone/");
const PY = findPython();
if (!PY) {
  die("找不到 Python 3。", [
    "重建静态快照需要它（scripts/build-standalone.py）。",
    "装一个 Python 3 后重新双击本脚本即可。",
  ]);
}
if (!run(PY, [join(SITE, "scripts", "build-standalone.py")])) {
  die("静态快照重建失败。", [
    "常见原因：web/ 里引用了不存在的图片，构建会报「断链」并中止。",
    "导出已完成（data/content.json 已更新），但还没有推送。",
  ]);
}

if (DRY) {
  say("");
  say(SEP);
  say("  --dry-run：本地文件已更新，未提交、未推送。");
  say(SEP);
  say("");
  process.exit(0);
}

// ── [3/3] 提交并推送 ──
step("[3/3] 提交并推送到 GitHub");

const GITBIN = findGit();
if (!GITBIN) {
  die("找不到 git 命令。", [
    "第 3 步要用 git 提交并推送，但当前环境里找不到 git.exe。",
    "",
    "这台机器没有安装 Git for Windows；WorkBuddy 自带的 PortableGit 也没找到。",
    "装一个 Git 之后重新双击本脚本即可（自带的 PortableGit 会被自动识别）。",
  ]);
}

if (!capture(GITBIN, ["rev-parse", "--git-dir"], { cwd: ROOT })) {
  die("这个目录不是 git 仓库，无法推送。", [
    "请在完整的项目文件夹里运行本脚本",
    "（即包含 .git、官网/、.github/ 的那一层）。",
  ]);
}

const GIT = { cwd: ROOT };
const PATHS = ["官网/data/content.json", "官网/web", "官网/web-standalone"];

const add = spawnSync(GITBIN, ["add", "--", ...PATHS], { ...GIT, encoding: "utf8" });
if (add.status !== 0) {
  die("git add 失败。", [
    "检查是否有别的程序锁住了文件，或磁盘权限异常。",
    String(add.stderr || "").trim(),
  ]);
}

// 有没有东西待提交？git diff --cached --quiet 无差异时返回 0
const hasStaged = spawnSync(GITBIN, ["diff", "--cached", "--quiet"], GIT).status !== 0;

if (!hasStaged) {
  // 内容没变，但上一次可能「提交成功、推送失败」—— 把欠的提交补推上去
  const aheadRaw = capture(GITBIN, ["rev-list", "--count", "origin/main..HEAD"], GIT);
  const ahead = Number(aheadRaw);
  if (ahead > 0) {
    say("");
    say("  发现 " + ahead + " 条已提交但还没推送的记录，补推一次…");
    say("");
    if (!run(GITBIN, ["push", "origin", "main"], GIT)) {
      die("补推失败。", [
        "本地提交是安全的，没有丢；只是还没上网。",
        "检查网络 / 代理 / GitHub 凭据后再跑一次。",
      ]);
    }
    say("");
    say(SEP);
    say("  补推完成，线上会在 1 ~ 3 分钟内更新。");
    say("  线上地址： https://gugulina.github.io/gpic-website/");
    say(SEP);
    say("");
    process.exit(0);
  }

  say("");
  say(SEP);
  say("  库里内容与已在公网上的版本一致，没有需要推送的改动。");
  say("  线上本来就是最新的，不用重复推送。");
  say(SEP);
  say("");
  process.exit(0);
}

// 统计这次动了几个文件，写进 commit message
// core.quotepath=false：否则中文路径会被转义成 \345\256\230\347\275\221/...
// 这种八进制串，打印出来完全看不懂
const changedFiles = (capture(GITBIN, ["-c", "core.quotepath=false", "diff", "--cached", "--name-only"], GIT) || "")
  .split(/\r?\n/).filter(Boolean);

// 版本号写进提交信息：翻 git log 时一眼看出这条是哪个版本发的。
// 真源是 官网/web/version.json，读不到就不带，不让版本号拦住同步。
const SITE_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(SITE, "web", "version.json"), "utf8")).version || "");
  } catch {
    return "";
  }
})();

const msg = "内容同步" + (SITE_VERSION ? " v" + SITE_VERSION : "") +
  "：后台改动上线（" + changedFiles.length + " 个文件）";

const commit = spawnSync(GITBIN, ["commit", "-m", msg], { ...GIT, encoding: "utf8" });
if (commit.status !== 0) {
  const err = String(commit.stderr || "").trim();
  die("git commit 失败。", [
    /user\.(name|email)/i.test(err)
      ? "git 还没配身份。在命令行跑一次："
      : "错误详情：",
    /user\.(name|email)/i.test(err)
      ? 'git config --global user.email "你的邮箱"'
      : err,
  ]);
}

say("");
say("  本次提交涉及 " + changedFiles.length + " 个文件：");
for (const f of changedFiles.slice(0, 12)) say("      " + f);
if (changedFiles.length > 12) say("      … 另有 " + (changedFiles.length - 12) + " 个");
say("");

if (!run(GITBIN, ["push", "origin", "main"], GIT)) {
  die("本地提交成功，但推送到 GitHub 失败。", [
    "本地改动已经安全提交，不会丢；只是还没上网。",
    "检查网络 / 代理 / GitHub 凭据后，重新双击本脚本即可重试",
    "（内容没变时它会自动把欠的提交补推上去）。",
    "",
    "也可以在项目根目录手动执行：  git push origin main",
  ]);
}

say("");
say(SEP);
say("  已推送完成。");
say("");
say("  GitHub Actions 会自动重建并发布，通常 1 ~ 3 分钟。");
say("  线上地址： https://gugulina.github.io/gpic-website/");
say("  进度查看： https://github.com/gugulina/gpic-website/actions");
say("");
say("  如果打开还是旧内容，先按 Ctrl + F5 强制刷新 ——");
say("  GitHub Pages 的 CDN 缓存偶尔会多留几分钟。");
say(SEP);
say("");
