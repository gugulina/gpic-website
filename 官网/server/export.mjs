/**
 * export.mjs —— 把 SQLite 库里的内容导出回 data/content.json
 *
 * 为什么需要它：
 *   后台（admin.html）写的是 SQLite 库；而 GitHub Pages 静态版读的是
 *   data/content.json（build-standalone.py 打成快照，再由 static-api.js 适配）。
 *   两边是**不同的数据源**。在后台改完内容后跑一次本脚本，静态版才会同步。
 *
 * 策略：以现有 content.json 为骨架，只用库里的数据覆盖「可编辑的 9 个区块」。
 *   库里没有的字段 —— works 区块、各列表的标题/副标题等区块文案、
 *   notice.layout、event.countdown、about.bulletin —— 一律原样保留。
 *   version 的语义是「内容结构版本」，导出只搬内容，不动它，仅刷新 updatedAt。
 *
 * 用法：
 *   node server/export.mjs                      # 导出到 data/content.json
 *   node server/export.mjs --check              # 只报告差异，不写文件
 *   node server/export.mjs --db x.sqlite --out y.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { openDatabase } from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DB_PATH = argOf("--db", join(ROOT, "server", "data", "gpic.sqlite"));
const OUT_PATH = argOf("--out", join(ROOT, "data", "content.json"));
const CHECK_ONLY = process.argv.includes("--check");

const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const clone = (v) => JSON.parse(JSON.stringify(v));

/** 递归列出两个值之间的差异路径，用于 --check 时定位问题 */
function diffPaths(a, b, path = "", acc = []) {
  if (a === b) return acc;
  const ta = Object.prototype.toString.call(a);
  const tb = Object.prototype.toString.call(b);
  if (ta !== tb) {
    acc.push(path + " : " + ta + " → " + tb);
    return acc;
  }
  if (ta === "[object Array]") {
    if (a.length !== b.length) acc.push(path + ".length : " + a.length + " → " + b.length);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diffPaths(a[i], b[i], path + "[" + i + "]", acc);
    }
    return acc;
  }
  if (ta === "[object Object]") {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) diffPaths(a?.[k], b?.[k], path + "." + k, acc);
    return acc;
  }
  acc.push(path + " : " + JSON.stringify(a) + " → " + JSON.stringify(b));
  return acc;
}

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error("✗ 找不到数据库：" + DB_PATH);
    console.error("  先跑一次 seed：node server/seed.mjs");
    process.exit(1);
  }
  if (!existsSync(OUT_PATH)) {
    console.error("✗ 找不到骨架文件：" + OUT_PATH);
    process.exit(1);
  }

  const base = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  const { client, close } = openDatabase(DB_PATH);
  const stats = [];

  try {
    const out = clone(base);

    // ── 站点设置（shop / recruit 以 JSON 存在同一个表里，拆出来单独放）──
    const settingRows = (await client.from("site_settings").select("key,value")).data || [];
    const site = {};
    const blobs = { shop: base.shop || null, recruit: base.recruit || null };
    for (const row of settingRows) {
      if (row.key === "shop" || row.key === "recruit") {
        try {
          blobs[row.key] = JSON.parse(row.value);
        } catch {
          /* 解析不了就保留原有的值 */
        }
        continue;
      }
      site[camel(row.key)] = row.key === "show_admin_entry"
        ? String(row.value).toLowerCase() === "true"
        : row.value;
    }
    if (Object.keys(site).length) {
      out.site = Object.assign({}, base.site, site);
      stats.push(["站点设置", Object.keys(site).length]);
    }

    // ── 首页横幅 ──
    const heroRow = (await client.from("hero_content").select("*").limit(1).maybeSingle()).data;
    if (heroRow) {
      out.hero = Object.assign({}, base.hero, {
        banner: heroRow.banner,
        bannerFallback: heroRow.banner_fallback,
        bannerAlt: heroRow.banner_alt,
        badge: heroRow.badge,
        title: heroRow.title,
        body: heroRow.body,
        sub: heroRow.sub,
        actions: heroRow.actions || [],
        stats: heroRow.stats || [],
      });
      stats.push(["首页横幅", 1]);
    }

    // ── 公告 ──
    // 顺序以 content.json 的人工编排为准（那就是首页的显示顺序），不按 date 重排；
    // 库里新增的公告按 date 升序 unshift，最终最新的排在最前。
    // layout 是库外字段，按 id 从骨架里继承。
    const noticeRows = (await client.from("notices").select("*")).data || [];
    if (noticeRows.length) {
      const byId = new Map(noticeRows.map((r) => [r.id, r]));
      const toItem = (r, prev) => Object.assign({}, prev || {}, {
        id: r.id,
        date: r.date,
        type: r.type,
        style: r.style,
        text: r.summary || "",
        title: r.title || "",
        cover: r.cover || "",
        coverAlt: r.cover_alt || "",
        body: r.body || [],
      });
      const items = [];
      const seen = new Set();
      for (const prev of (base.notices && base.notices.items) || []) {
        const row = byId.get(prev.id);
        if (!row) continue;                 // 库里已删除的，导出时也去掉
        items.push(toItem(row, prev));
        seen.add(row.id);
      }
      const added = noticeRows
        .filter((r) => !seen.has(r.id))
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      for (const row of added) items.unshift(toItem(row, null));
      out.notices = Object.assign({}, base.notices, { items });
      stats.push(["公告", items.length]);
    }

    // ── 品牌集群 ──
    const brandRows = (await client.from("brands").select("*").order("display_order")).data || [];
    if (brandRows.length) {
      out.brands = Object.assign({}, base.brands, {
        items: brandRows.map((b) => ({
          name: b.name,
          sub: b.sub,
          logo: b.logo,
          isSelf: !!b.is_self,
        })),
      });
      stats.push(["品牌", brandRows.length]);
    }

    // ── 周边商品 ──
    const goodRows = (await client.from("goods").select("*").order("display_order")).data || [];
    if (goodRows.length) {
      out.goods = Object.assign({}, base.goods, {
        items: goodRows.map((g) => {
          const item = {
            badge: g.badge,
            badgeStyle: g.badge_style,
            name: g.name,
            desc: g.description,
            image: g.image,
            imageAlt: g.image_alt,
            tags: g.tags || [],
            alt: g.alt_label,
            price: g.price,
            unit: g.unit,
            free: !!g.is_free,
          };
          // freeLabel 只在非空时出现，跟原 content.json 的写法保持一致
          if (g.free_label) item.freeLabel = g.free_label;
          return item;
        }),
      });
      stats.push(["商品", goodRows.length]);
    }

    // ── 参展活动（countdown 是库外字段）──
    const eventRow = (await client.from("events").select("*").order("updated_at", { ascending: false }).limit(1).maybeSingle()).data;
    if (eventRow) {
      out.event = Object.assign({}, base.event, {
        badge: eventRow.badge,
        title: eventRow.title,
        subtitle: eventRow.subtitle,
        booth: eventRow.booth,
        debut: eventRow.debut,
        date: eventRow.date_start,
        dateEnd: eventRow.date_end,
        linkLabel: eventRow.link_label,
        link: eventRow.link_href,
        visual: eventRow.visual,
        visualAlt: eventRow.visual_alt,
      });
      stats.push(["参展活动", 1]);
    }

    // ── 社交链接 ──
    const socialRows = (await client.from("social_links").select("*").order("display_order")).data || [];
    if (socialRows.length) {
      out.social = socialRows.map((s) => ({ label: s.label, href: s.href, sub: s.sub }));
      stats.push(["社交链接", socialRows.length]);
    }

    // ── 关于我们（bulletin 是库外字段）──
    const aboutRow = (await client.from("about_content").select("*").limit(1).maybeSingle()).data;
    if (aboutRow) {
      out.about = Object.assign({}, base.about, {
        badge: aboutRow.badge,
        title: aboutRow.title,
        subtitle: aboutRow.subtitle,
        paragraphs: aboutRow.paragraphs || [],
        identityTitle: aboutRow.identity_title,
        identityTags: aboutRow.identity_tags || [],
        bizTitle: aboutRow.biz_title,
        bizTags: aboutRow.biz_tags || [],
        visual: aboutRow.visual,
        visualAlt: aboutRow.visual_alt,
      });
      stats.push(["关于我们", 1]);
    }

    // ── 通贩商店 ──
    if (blobs.shop) {
      out.shop = blobs.shop;
      stats.push(["通贩商店", (blobs.shop.links || []).length]);
    }

    // ── 人员招募 ──
    if (blobs.recruit) {
      out.recruit = blobs.recruit;
      stats.push(["人员招募", (blobs.recruit.jobs || []).length]);
    }

    // ── 差异判定：version / updatedAt 不参与比较 ──
    const strip = (o) => {
      const c = clone(o);
      delete c.version;
      delete c.updatedAt;
      return JSON.stringify(c);
    };
    const changed = strip(out) !== strip(base);

    console.log("库：" + DB_PATH);
    console.log("骨架：" + OUT_PATH);
    console.log("");

    if (!changed) {
      console.log("✓ 库与 content.json 内容一致，无需更新");
      stats.forEach(([name, n]) => console.log("    " + name.padEnd(8) + n));
      return;
    }

    if (CHECK_ONLY) {
      const diffs = diffPaths(base, out);
      console.log("⚠ 检测到差异（--check 模式，未写文件）");
      console.log("");
      console.log("差异明细（" + diffs.length + " 处）：");
      diffs.slice(0, 40).forEach((d) => console.log("    " + d));
      if (diffs.length > 40) console.log("    … 另有 " + (diffs.length - 40) + " 处");
      console.log("");
      console.log("去掉 --check 即可写回 " + OUT_PATH);
      process.exitCode = 2;
      return;
    }

    out.updatedAt = new Date().toISOString();

    // content.json 一贯是 CRLF + 2 空格缩进，跟随原格式以免 diff 全是行尾噪音
    const text = JSON.stringify(out, null, 2).replace(/\n/g, "\r\n") + "\r\n";
    writeFileSync(OUT_PATH, text, "utf8");

    console.log("✓ 已导出");
    for (const [name, n] of stats) console.log("    " + name.padEnd(8) + n);
    console.log("");
    console.log("接着跑：python scripts/build-standalone.py   # 刷新静态快照");
  } finally {
    close();
  }
}

main().catch((e) => {
  console.error("✗ 导出失败：" + (e && e.message ? e.message : e));
  process.exit(1);
});
