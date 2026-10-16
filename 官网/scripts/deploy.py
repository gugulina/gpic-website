#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
幻想乡电力投资集团 · 官网「打包成可上传目录」脚本
====================================================

作用：把站点整理成一个**只含站点本身**的目录，整包丢给托管平台就行，
      不需要自己判断"哪几个文件要传、哪几个不能传"。

用法：
    python scripts/deploy.py
    python scripts/deploy.py --out 发布包
    python scripts/deploy.py --site-url https://gpic.example.com
    python scripts/deploy.py --site-url gpic.example.com --zip
    python scripts/deploy.py --keep-admin          # 一般不这么用

它会做六件事：
    1. 复制 index.html、notice.html、404.html、robots.txt、sitemap.xml、
       assets/、data/content.json（其余一律不带）
    2. 把**部署副本**的 site.showAdminEntry 置为 false ——
       线上没有 admin.html，导航和页脚的后台入口留着会让访客点出 404
    3. 按 content.json 的真实内容**重新生成 sitemap.xml**（含每条公告的详情页），
       并把 robots.txt 里的 __SITE_URL__ 换成正式域名 ——
       **没给 --site-url 时会把 sitemap.xml 整个删掉**，因为站点地图必须写
       绝对地址，留一份填着占位域名的上去还不如不给
    4. 体检：内容里引用的图片是否都存在、有没有超过首屏预算的大图
    5. 体检：robots.txt / sitemap.xml / 404.html 是否齐备
    6. 生成「发布报告.txt」放在项目根目录，写明这次打了什么、要传什么

注意：
    · 原始素材（根目录的 png / jpg / 规划文档 / 启动 bat）不会被复制
    · admin.html 与 scripts/ 默认剔除（默认密码在里面，绝不能上线）
    · notice.html 是公告页，首页每条公告与导航「新闻公告」都指向它；
      漏传这一个文件，首页的公告链接会全部 404
    · 404.html 是整站**唯一**使用「站点根绝对路径」的页面（以 / 开头），
      因为它可能在任意目录深度下被触发，相对路径指不回站点根。
      放在子目录里托管时需要相应调整，详见该文件头部注释
    · 只改部署副本，不动 data/content.json 本身
"""

import argparse
import json
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONTENT = DATA / "content.json"

DEFAULT_OUT = "dist"
REPORT_NAME = "发布报告.txt"

# 站点根目录下允许被复制进发布包的文件（有则复制，没有就跳过）
ROOT_WHITELIST = [
    "index.html",
    "notice.html",      # 公告页：首页每条公告都指向它，漏了会整片 404
    "robots.txt",
    "sitemap.xml",
    "404.html",
    "CNAME",
    ".nojekyll",
    "favicon.ico",
]

# 内容里出现的资源引用（用于体检）
ASSET_RE = re.compile(
    r"(?:assets/[\w\-./\u4e00-\u9fa5]+\.(?:webp|png|jpe?g|gif|svg|avif|ico))", re.I
)

FIRST_SCREEN_BUDGET_KB = 500      # 《社团官网规划文档》里的硬约束
BIG_IMAGE_KB = 300                # 单张图超过它就值得压一压

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass


def visible_notices(content):
    """对外可见的公告。与 index.html / notice.html 的列表口径保持一致：
    标题和摘要都是空的（多半是刚建好还没写）不列出来。"""
    raw = ((content.get("notices") or {}).get("items") or [])
    out = []
    for it in raw:
        if not isinstance(it, dict):
            continue
        if str(it.get("title") or "").strip() or str(it.get("text") or "").strip():
            out.append(it)
    return out


def build_sitemap(content, url):
    """按 content.json 的真实内容生成 sitemap —— 不照抄根目录那份模板，
    因为每条公告的详情页地址只有这里才知道。"""
    lastmod = str(content.get("updatedAt") or "")[:10]
    lastmod_line = ("    <lastmod>%s</lastmod>\n" % lastmod) if re.match(r"^\d{4}-\d{2}-\d{2}$", lastmod) else ""

    entries = [("", "1.0", "网站首页"), ("notice.html", "0.8", "新闻公告")]
    for it in visible_notices(content):
        nid = str(it.get("id") or "").strip()
        if not nid:
            continue
        title = str(it.get("title") or it.get("text") or "").strip()[:60]
        entries.append(("notice.html?id=" + quote(nid, safe=""), "0.6", title))

    body = []
    for path, prio, _label in entries:
        body.append(
            "  <url>\n"
            "    <loc>%s</loc>\n" % escape(url + "/" + path)
            + lastmod_line
            + "    <changefreq>weekly</changefreq>\n"
            "    <priority>%s</priority>\n"
            "  </url>\n" % prio
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!-- 由 scripts/deploy.py 自动生成，请勿手工编辑（改内容后重新打包即可）。 -->\n"
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(body)
        + "</urlset>\n"
    )


def human(kb):
    return ("%.0f KB" % kb) if kb < 1024 else ("%.2f MB" % (kb / 1024.0))


def size_kb(p):
    try:
        return p.stat().st_size / 1024.0
    except OSError:
        return 0.0


def normalize_url(raw):
    u = raw.strip().rstrip("/")
    if not u:
        return ""
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    return u


def collect_asset_refs(obj, found):
    """递归找出内容里所有 assets/... 形式的引用。"""
    if isinstance(obj, dict):
        for v in obj.values():
            collect_asset_refs(v, found)
    elif isinstance(obj, list):
        for v in obj:
            collect_asset_refs(v, found)
    elif isinstance(obj, str):
        for m in ASSET_RE.findall(obj):
            found.add(m)


def clear_output(out):
    """清空输出目录，返回没清掉的路径。

    刻意不用 shutil.rmtree：本机装了「删东西先进回收站」的安全策略，会把它
    整个接管过去，而回收站处理含中文的路径会失败并抛错。2026-09-18 实际踩到：
    目录内容其实已经删干净，只在最后删目录本身时报错 —— 整次打包却因此中断，
    看起来像「打包全废了」。改成逐个删（unlink / rmdir 不受该策略接管）。"""
    stuck = []
    if not out.exists():
        return stuck
    for p in sorted(out.rglob("*"), key=lambda x: len(x.parts), reverse=True):
        try:
            if p.is_dir():
                p.rmdir()
            else:
                p.unlink()
        except OSError as e:  # noqa: PERF203
            stuck.append((p, e))
    try:
        out.rmdir()
    except OSError as e:
        stuck.append((out, e))
    return stuck


def copytree_clean(src, dst):
    """复制目录，跳过 .DS_Store / Thumbs.db 这类系统垃圾。"""
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in sorted(src.rglob("*")):
        if p.is_dir():
            continue
        if p.name in (".DS_Store", "Thumbs.db", "desktop.ini"):
            continue
        rel = p.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser(
        description="把官网打包成一个可以直接上传的目录",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="输出目录（项目内），默认 %s" % DEFAULT_OUT)
    ap.add_argument("--site-url", default="",
                    help="正式域名，会写进部署副本的 site.siteUrl，例如 https://gpic.example.com")
    ap.add_argument("--keep-admin", action="store_true",
                    help="连 admin.html 一起打包（默认剔除，因为里面有默认密码）")
    ap.add_argument("--zip", action="store_true", help="额外打一个 zip 压缩包")
    args = ap.parse_args()

    out = (ROOT / args.out).resolve()
    if out == ROOT or ROOT not in out.parents:
        sys.exit("输出目录必须放在项目内部，收到：%s" % out)

    if not CONTENT.is_file():
        sys.exit("找不到 %s —— 先跑起后台并把内容发布一次。" % CONTENT)
    try:
        content = json.loads(CONTENT.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        sys.exit("data/content.json 无法解析：%s" % exc)
    if not isinstance(content.get("site"), dict):
        sys.exit("data/content.json 结构不完整（缺 site 段），先修好再打包。")

    lines = []
    say = lambda s="": (print(s), lines.append(s))  # noqa: E731

    say("=" * 60)
    say(" 幻电投企划 · 官网打包")
    say(" 时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    say("=" * 60)

    # ---------- 部署副本 ----------
    deployed = json.loads(json.dumps(content, ensure_ascii=False))
    site = deployed["site"]
    notes = []

    if site.get("showAdminEntry") is not False:
        site["showAdminEntry"] = False
        notes.append("部署副本的 site.showAdminEntry 已置为 false：线上没有 admin.html，"
                     "导航与页脚的后台入口留着会让访客点出 404。")

    if args.site_url:
        url = normalize_url(args.site_url)
        site["siteUrl"] = url
        notes.append("部署副本的 site.siteUrl = %s（分享卡片 og:image / og:url / canonical 会用它）。" % url)
    elif not site.get("siteUrl"):
        notes.append("site.siteUrl 还是空的：转发到微信 / QQ / 微博时抓不到预览图。"
                     "下次可以用 --site-url 你的域名 补上。")

    # ---------- 清空输出目录（带安全闸门） ----------
    if out.exists():
        looks_like_ours = (out / "index.html").is_file()
        has_stuff = any(out.iterdir())
        if has_stuff and not looks_like_ours:
            sys.exit("输出目录 %s 已存在，且不像是本脚本生成的，为安全起见没有动它。\n"
                     "换个 --out，或先手动处理它。" % out)
        stuck = clear_output(out)
        if stuck:
            say("  ! 有 %d 项旧内容没能清掉，可能会混进这次发布包：" % len(stuck))
            for p, err in stuck[:5]:
                say("      %s（%s）" % (p, err))
            say("      建议手动删掉 %s 后重新打包。" % out)
            sys.exit(1)

    # ---------- 复制 ----------
    copied = []
    for name in ROOT_WHITELIST:
        src = ROOT / name
        if src.is_file():
            out.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, out / name)
            copied.append(name)

    if args.keep_admin:
        shutil.copy2(ROOT / "admin.html", out / "admin.html")
        copied.append("admin.html")

    assets_src = ROOT / "assets"
    n_assets = copytree_clean(assets_src, out / "assets") if assets_src.is_dir() else 0

    (out / "data").mkdir(parents=True, exist_ok=True)
    (out / "data" / "content.json").write_text(
        json.dumps(deployed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ---------- sitemap.xml 与 robots.txt（依赖正式域名） ----------
    final_url = str(site.get("siteUrl") or "").rstrip("/")

    sm_out = out / "sitemap.xml"
    if final_url:
        sm_out.write_text(build_sitemap(deployed, final_url), encoding="utf-8")
        n_notice = len(visible_notices(deployed))
        notes.append("sitemap.xml 已按 %s 重新生成，含首页、公告列表与 %d 条公告详情页。" % (final_url, n_notice))
    elif sm_out.is_file():
        sm_out.unlink()
        if "sitemap.xml" in copied:
            copied.remove("sitemap.xml")
        notes.append("因为没给 --site-url，发布包里的 sitemap.xml 已删除 —— "
                     "站点地图必须写绝对地址，留一份填着占位域名的上去只会让搜索引擎反复抓失败。"
                     "域名定了之后加 --site-url 重新打包即可自动生成。")

    rb_out = out / "robots.txt"
    if rb_out.is_file():
        # 根目录那份是「带内部说明的模板」；上线用的这份把注释行去掉，只留规则本身。
        # Sitemap 那一行由这里按域名重新生成 —— 站点地图地址必须写绝对路径，
        # 而模板里写的是占位符，不能直接替换了事（注释里也会被误替换）。
        rb_lines = []
        for ln in rb_out.read_text(encoding="utf-8").splitlines():
            s = ln.strip()
            if not s or s.startswith("#"):
                continue
            if s.lower().startswith("sitemap:"):
                if not final_url:
                    continue
                rb_lines.append("Sitemap: %s/sitemap.xml" % final_url)
            else:
                rb_lines.append(ln.rstrip())
        rb_out.write_text("\n".join(rb_lines) + "\n", encoding="utf-8")
        if not final_url:
            notes.append("robots.txt 里的 Sitemap 行已去掉（没有正式域名，指不过去）。")

    say("\n【已复制】")
    for name in copied:
        say("  %-18s %8s" % (name, human(size_kb(out / name))))
    say("  %-18s %8d 个文件" % ("assets/", n_assets))
    say("  %-18s %8s" % ("data/content.json", human(size_kb(out / "data" / "content.json"))))
    if not args.keep_admin:
        say("  （admin.html 与 scripts/ 已按惯例剔除）")

    # ---------- 体检：资源引用 ----------
    refs = set()
    collect_asset_refs(deployed, refs)
    for name in [n for n in copied if n.endswith((".html", ".htm"))]:
        try:
            refs.update(ASSET_RE.findall((out / name).read_text(encoding="utf-8", errors="ignore")))
        except OSError:
            pass

    missing = sorted(r for r in refs if not (out / r).is_file())
    big = sorted(
        ((r, size_kb(out / r)) for r in refs if (out / r).is_file() and size_kb(out / r) > BIG_IMAGE_KB),
        key=lambda t: -t[1],
    )

    say("\n【体检】")
    say("  内容与页面里引用到的资源：%d 个" % len(refs))
    if missing:
        say("  ! 有 %d 个引用在发布包里找不到对应文件（页面上会显示裂图）：" % len(missing))
        for m in missing:
            say("      - %s" % m)
    else:
        say("  √ 引用的资源全都在，没有裂图风险")

    if big:
        say("  以下图片超过 %d KB，如果出现在首屏就要留意 500 KB 预算：" % BIG_IMAGE_KB)
        for r, kb in big:
            say("      - %-42s %s" % (r, human(kb)))
    else:
        say("  √ 没有超过 %d KB 的单张图片" % BIG_IMAGE_KB)

    # ---------- 体检：上线基建文件 ----------
    say("\n【上线基建】")
    for name in ("robots.txt", "sitemap.xml", "404.html"):
        if (out / name).is_file():
            say("  √ %-13s %s" % (name, human(size_kb(out / name))))
        elif name == "sitemap.xml" and not final_url:
            say("  – %-13s 本次未包含（域名定了之后加 --site-url 重新打包）" % name)
        else:
            say("  ! %-13s 缺失：项目根目录里找不到这个文件" % name)

    # ---------- 体检：首屏体积 ----------
    hero = deployed.get("hero") or {}
    first = ["index.html"]
    for key in ("banner", "bannerFallback"):
        v = hero.get(key)
        if isinstance(v, str) and v:
            first.append(v)
    first += ["assets/images/favicon.ico", "assets/images/favicon.png"]
    seen, total, rows = set(), 0.0, []
    for f in first:
        if f in seen:
            continue
        seen.add(f)
        p = out / f
        if p.is_file():
            kb = size_kb(p)
            total += kb
            rows.append((f, kb))
    say("\n【首屏体积】（首屏只算首页 + 横幅 + 图标；.webp 与 .jpg 兜底不会同时下载）")
    for f, kb in rows:
        say("  %-42s %s" % (f, human(kb)))
    biggest = max([kb for f, kb in rows if f.endswith((".webp", ".jpg", ".png"))] or [0])
    est = sum(kb for f, kb in rows if not f.endswith(".jpg"))
    say("  ————————————————————————————————————————")
    say("  首页首屏估算（webp 生效时）：%s / 预算 %d KB　%s"
        % (human(est), FIRST_SCREEN_BUDGET_KB,
           "√ 在预算内" if est <= FIRST_SCREEN_BUDGET_KB else "! 超了，压一压横幅"))
    say("  首屏这几张里最大的一张（含 jpg 兜底）：%s" % human(biggest))

    # ---------- 说明 ----------
    say("\n【说明】")
    if notes:
        for n in notes:
            say("  · %s" % n)
    else:
        say("  · 无需特别说明")

    say("\n【接下来】")
    say("  1. 把 %s/ 里的全部内容上传到你的静态托管（别只传一半）" % args.out)
    say("  2. 上传后打开首页确认；再往微信里发一次链接，看预览图是否正常")
    say("  3. 随手输一个不存在的地址（例如 /abc），确认出现本站自己的 404 页面；")
    say("     再访问 你的域名/robots.txt 与 /sitemap.xml，确认两个文件都能打开")
    say("  4. data/content.json 在线上是只读的 —— 以后改内容仍然在本机后台发布，")
    say("     然后重新跑一次本脚本、重传这一个文件即可")

    if args.zip:
        zpath = out.with_name(out.name + ".zip")
        if zpath.exists():
            zpath.unlink()
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(out.rglob("*")):
                if p.is_file():
                    z.write(p, (Path(args.out) / p.relative_to(out)).as_posix())
        say("\n  已额外打包：%s（%s）" % (zpath.name, human(size_kb(zpath))))

    total_all = sum(size_kb(p) for p in out.rglob("*") if p.is_file())
    say("\n发布包总计：%s，共 %d 个文件" % (human(total_all), sum(1 for p in out.rglob("*") if p.is_file())))

    report = ROOT / REPORT_NAME
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n报告已写入：%s" % report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
