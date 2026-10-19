#!/usr/bin/env node
/**
 * version.mjs —— 站点版本号的唯一维护入口
 *
 * 为什么需要它：
 *   站点有两条发布通道（自持动态站 / GitHub Pages 静态快照），同一份内容在
 *   两处跑。没有版本号时，「线上到底是哪一版」只能靠翻 git log 猜。
 *   但版本号一旦散落在 HTML、后端、构建脚本、提交信息里各写一份，
 *   迟早会走散 —— 所以真源只留一个文件，其余全部由脚本读取或校验。
 *
 * 真源：
 *   官网/web/version.json
 *   放在 web/ 下有两个好处：动态站直接由静态服务暴露（GET /version.json），
 *   静态快照打包时原样复制一份，两边天然同源。
 *
 * 用法：
 *   node scripts/version.mjs                      # 看当前版本 + 一致性体检
 *   node scripts/version.mjs check                # 只体检；有问题退出码 1（可接 CI）
 *   node scripts/version.mjs bump patch|minor|major --name "一句话标题" [--notes "补充"]
 *   node scripts/version.mjs tag [--push]         # 给当前提交打 vX.Y.Z 并（可选）推送
 *
 * ⚠️ 不要手改 HTML 里的版本号，也不要手改 version.json 的 version 字段 ——
 *    走 bump，否则 CHANGELOG 与 tag 会脱节。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(__dirname, "..");        // 官网/
const REPO = resolve(SITE, "..");             // 仓库根：.git / .github 那一层
const VERSION_FILE = join(SITE, "web", "version.json");
const CHANGELOG_FILE = join(SITE, "CHANGELOG.md");
const PAGES = ["index.html", "goods.html", "notice.html", "recruitment.html"];
const ANCHOR = "<!-- NEW-VERSION -->";

/**
 * 找 git.exe —— 本机只有 WorkBuddy 自带的 PortableGit，不在系统 PATH 里。
 * spawnSync("git") 找不到命令时返回 status=null、stderr=null，报错信息会是空白，
 * 备份脚本就踩过这个坑（2026-10-19）。同款探测逻辑在 sync-public.mjs 与
 * backup/_tools/gpic-backup.mjs 里各有一份，改这里记得对一下那边的顺序。
 */
function findGit() {
  const home = process.env.USERPROFILE || "";
  const pgRoot = join(home, ".workbuddy", "binaries", "PortableGit", "versions");
  if (existsSync(pgRoot)) {
    try {
      for (const v of readdirSync(pgRoot)) {
        const p = join(pgRoot, v, "cmd", "git.exe");
        if (existsSync(p)) return p;
      }
    } catch { /* 目录读不了就继续往下找 */ }
  }
  for (const p of [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
    join(home, "AppData", "Local", "Programs", "Git", "cmd", "git.exe"),
  ]) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync("where", ["git"], { encoding: "utf8" });
  if (which.status === 0) {
    for (const line of String(which.stdout || "").split(/\r?\n/)) {
      const p = line.trim();
      if (p && existsSync(p)) return p;
    }
  }
  return null;
}

const GITBIN = findGit();

/** 统一的 git 调用：GITBIN 为 null 时返回失败，而不是拼出空错误串 */
function git(args, opts = {}) {
  if (!GITBIN) return { status: -1, stdout: "", stderr: "找不到 git.exe" };
  return spawnSync(GITBIN, args, { cwd: REPO, encoding: "utf8", ...opts });
}

const ok = (s) => console.log("  \u2713 " + s);
const bad = (s) => console.log("  \u2717 " + s);
const warn = (s) => console.log("  ! " + s);
const head = (s) => console.log("\n" + s);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function parseVer(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || "").trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

function readPageText(name) {
  const f = join(SITE, "web", name);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

// ── 体检 ────────────────────────────────────────────────────────────
function check() {
  const problems = [];
  const warnings = [];

  if (!existsSync(VERSION_FILE)) {
    bad("找不到真源文件：" + VERSION_FILE);
    return { problems: ["missing_version_file"], warnings };
  }

  let v;
  try {
    v = readJson(VERSION_FILE);
  } catch (e) {
    bad("version.json 不是合法 JSON：" + e.message);
    return { problems: ["bad_json"], warnings };
  }

  const sem = parseVer(v.version);
  if (!sem) problems.push("version 不是 X.Y.Z 格式：" + v.version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.released || ""))) problems.push("released 不是 YYYY-MM-DD：" + v.released);
  if (!v.name || !String(v.name).trim()) problems.push("name 为空");
  if (!Number.isInteger(v.contentVersion)) problems.push("contentVersion 不是整数：" + v.contentVersion);

  // 内容结构版本的真源是 data/content.json 的 version 字段。
  // 页面里的 MIN_VER 只是它的镜像（旧静态站那套 gate），现在 web/ 四页已经不带
  // MIN_VER 了，所以不能拿「有没找到 MIN_VER」当判据 —— 以 content.json 为准，
  // 页面里若还留着 MIN_VER，就顺带校验一遍，防止两边走散。
  const contentJson = join(SITE, "data", "content.json");
  if (existsSync(contentJson)) {
    try {
      const cj = JSON.parse(readFileSync(contentJson, "utf8"));
      if (cj.version !== v.contentVersion) {
        problems.push("data/content.json 的 version=" + cj.version +
          " 与 contentVersion=" + v.contentVersion + " 不一致");
      }
    } catch (e) {
      problems.push("data/content.json 解析失败：" + e.message);
    }
  } else {
    warnings.push("找不到 data/content.json，无法校验内容结构版本");
  }

  for (const p of PAGES) {
    const text = readPageText(p);
    if (text == null) { problems.push("缺页面：" + p); continue; }
    const m = /var\s+MIN_VER\s*=\s*(\d+)/.exec(text);
    if (m && Number(m[1]) !== v.contentVersion) {
      problems.push(p + " 的 MIN_VER=" + m[1] + " 与 contentVersion=" + v.contentVersion + " 不一致");
    }
    // 页脚版本占位：四个页面都要有，否则只有首页显示版本号
    if (!/data-site-version/.test(text)) problems.push(p + " 缺少 data-site-version 占位");
  }

  // CHANGELOG 必须有当前版本条目
  if (existsSync(CHANGELOG_FILE)) {
    const cl = readFileSync(CHANGELOG_FILE, "utf8");
    if (!cl.includes("## [" + v.version + "]")) problems.push("CHANGELOG 里没有 [" + v.version + "] 条目");
    if (!cl.includes(ANCHOR)) warnings.push("CHANGELOG 缺少 " + ANCHOR + " 锚点，bump 无法自动插入");
  } else {
    problems.push("缺 CHANGELOG.md");
  }

  // 消费点必须在位（漏一个就会出现「某处显示旧版本」）
  const siteJs = join(SITE, "web", "assets", "site.js");
  if (existsSync(siteJs)) {
    const js = readFileSync(siteJs, "utf8");
    if (!js.includes("data-site-version")) problems.push("web/assets/site.js 没有填充 data-site-version 的逻辑");
    if (!js.includes("version.json")) problems.push("web/assets/site.js 没有读取 version.json");
  } else {
    problems.push("缺 web/assets/site.js");
  }

  const serverEntry = join(SITE, "server", "index.mjs");
  if (existsSync(serverEntry)) {
    if (!readFileSync(serverEntry, "utf8").includes("X-GPIC-Version")) {
      problems.push("server/index.mjs 没有下发 X-GPIC-Version 响应头");
    }
  }

  const builder = join(SITE, "scripts", "build-standalone.py");
  if (existsSync(builder)) {
    const py = readFileSync(builder, "utf8");
    if (!py.includes('"version.json"')) problems.push("build-standalone.py 没有把 version.json 复制进产物");
  }

  // git tag（只提醒，不算错：本地尚未打 tag 时也要能体检）
  const tagName = "v" + v.version;
  const tags = git(["tag", "-l", tagName]);
  if (tags.status === 0 && !String(tags.stdout || "").trim()) {
    warnings.push("当前版本还没有 git tag（" + tagName + "），可在提交后跑：node scripts/version.mjs tag");
  }

  head("版本一致性体检");
  console.log("  真源：" + VERSION_FILE);
  console.log("  版本：v" + v.version + "  (" + v.released + " · " + v.name + ")");
  console.log("  内容结构版本：contentVersion " + v.contentVersion);
  console.log("  扫描页面：" + PAGES.join(" "));
  console.log("");

  if (problems.length === 0) ok("全部一致，没有发现漂移");
  else problems.forEach(bad);
  warnings.forEach(warn);

  console.log("");
  return { problems, warnings };
}

// ── 升版本 ──────────────────────────────────────────────────────────
function bump(kind, opts) {
  if (!["patch", "minor", "major"].includes(kind)) {
    console.error("✗ 只能升 patch / minor / major");
    process.exit(1);
  }
  const v = readJson(VERSION_FILE);
  const cur = parseVer(v.version);
  if (!cur) {
    console.error("✗ 当前 version 不是 X.Y.Z：" + v.version);
    process.exit(1);
  }

  let next;
  if (kind === "major") next = (cur.major + 1) + ".0.0";
  else if (kind === "minor") next = cur.major + "." + (cur.minor + 1) + ".0";
  else next = cur.major + "." + cur.minor + "." + (cur.patch + 1);

  const name = opts.name || "未命名更新";
  const released = today();
  const from = v.version;   // 先留原值：下面一改，打印「X → Y」就会变成「Y → Y」

  // version.json：只动 version / released / name，summary 由人工补
  v.version = next;
  v.released = released;
  v.name = name;
  if (opts.summary) v.summary = opts.summary;
  writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + "\n", "utf8");

  // CHANGELOG：在锚点下方插入，最新版本永远在最上面
  if (existsSync(CHANGELOG_FILE)) {
    let cl = readFileSync(CHANGELOG_FILE, "utf8");
    const entry = [
      "## [" + next + "] · " + released + " · " + name,
      "",
      "- " + (opts.summary || "（待补：这一版改了什么、为什么发）"),
      "",
    ].join("\n");
    if (cl.includes(ANCHOR)) {
      cl = cl.replace(ANCHOR, ANCHOR + "\n\n" + entry);
    } else {
      cl = cl + "\n" + entry;
    }
    writeFileSync(CHANGELOG_FILE, cl, "utf8");
  }

  console.log("");
  console.log("  \u2713 版本已升：" + from + " → " + next + "  (" + released + " · " + name + ")");
  console.log("    改的是：" + VERSION_FILE);
  console.log("    已往 CHANGELOG 插入占位条目，记得补正文。");
  console.log("");
  console.log("  接下来：");
  console.log("    1) 补 CHANGELOG 正文与 version.json 的 summary");
  console.log("    2) node scripts/version.mjs check");
  console.log("    3) git commit -am \"发布 v" + next + "：" + name + "\"");
  console.log("    4) node scripts/version.mjs tag --push");
  console.log("");
}

// ── 打 tag ──────────────────────────────────────────────────────────
function tag(push) {
  const v = readJson(VERSION_FILE);
  const name = "v" + v.version;
  const exists = git(["tag", "-l", name]);
  if (String(exists.stdout || "").trim()) {
    console.log("  ! " + name + " 已存在，不重复打。要重打先删：git tag -d " + name);
    return;
  }
  const msg = name + " · " + v.name + "（内容结构 v" + v.contentVersion + "）";
  const r = git(["tag", "-a", name, "-m", msg]);
  if (r.status !== 0) {
    console.error("✗ 打 tag 失败：" + String(r.stderr || "").trim());
    process.exit(1);
  }
  console.log("  \u2713 已打 tag " + name);

  if (push) {
    const p = git(["push", "origin", name], { stdio: "inherit" });
    if (p.status !== 0) {
      console.error("✗ 推送 tag 失败，本地 tag 还在，稍后重试：git push origin " + name);
      process.exit(1);
    }
    console.log("  \u2713 已推送 tag");
  } else {
    console.log("    推送：git push origin " + name);
  }
}

// ── 入口 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0] || "show";

function argOf(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : "";
}

if (cmd === "check") {
  const { problems } = check();
  process.exit(problems.length ? 1 : 0);
} else if (cmd === "bump") {
  bump(argv[1], { name: argOf("--name"), summary: argOf("--summary") });
} else if (cmd === "tag") {
  tag(argv.includes("--push"));
} else if (cmd === "show" || cmd === "--help" || cmd === "-h") {
  check();
  console.log("  用法：");
  console.log("    node scripts/version.mjs check");
  console.log("    node scripts/version.mjs bump patch|minor|major --name \"标题\"");
  console.log("    node scripts/version.mjs tag [--push]");
  console.log("");
} else {
  console.error("✗ 不认识的子命令：" + cmd);
  process.exit(1);
}
