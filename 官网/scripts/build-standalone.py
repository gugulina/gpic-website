#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build-standalone.py —— 从 web/ 派生一份「零后端」的静态站点到 web-standalone/

背景：
    web/ 版页面把数据源写死成 '/functions/v1/app'（Qoder Sites 的 Supabase 后端），
    额度用尽后整站 429。本脚本把 public 页面复制一份，注入 static-api.js 适配层，
    让数据改由同目录的 data/content.json 提供 —— 不碰 web/，不需要后端。

用法：
    python scripts/build-standalone.py

产物：
    web-standalone/
        index.html goods.html notice.html recruitment.html 404.html style.css
        robots.txt .nojekyll
        static-api.js            ← 手写维护，本脚本不覆盖
        data/content.json
        assets/images/*

为什么 404 页要单独处理：
    根目录/web 下的 404.html 用的是站根绝对路径（/assets/…、/index.html）。
    自持站把 web/ 挂在站点根，所以绝对路径没事；但 GitHub Pages 之类的
    项目页挂在 /<repo>/ 子路径下，绝对路径会指到域名根 -> 全断。
    这里统一改写成相对路径，两种部署方式都能用。
"""
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC_WEB = ROOT / "web"
OUT = ROOT / "web-standalone"

PAGES = ["index.html", "goods.html", "notice.html", "recruitment.html"]
EXTRA = ["style.css"]
# 404 页：需要把绝对路径相对化，单独走 copy_404()
PAGES_RELATIVE = ["404.html"]
SHIM_TAG = '<script src="static-api.js"></script>'
INJECT_ANCHOR = "</head>"

# GitHub Pages 项目页部署在 /<repo>/ 子路径下。robots.txt 里写 /admin.html
# 这种站根绝对路径会指到域名根，是错的；这里只留路径无关的规则。
ROBOTS_STANDALONE = """\
# 幻想乡电力投资集团官网（静态快照版）
#
# 这份是「零后端」静态快照，只读，不含后台与接口。
# 后台入口 admin.html 与 functions/ 都没随本版发布，因此无需 Disallow。
#
# 域名定下来、正式站上线后，需要：
#   1) 在正式站的 robots.txt 里补 Disallow: /admin.html、Disallow: /functions/
#   2) 在本文件补一行 Sitemap: https://你的域名/sitemap.xml

User-agent: *
Allow: /
"""


def copy_page(name: str) -> str:
    src = SRC_WEB / name
    dst = OUT / name
    if not src.exists():
        return "缺失源文件：%s" % src

    text = src.read_text(encoding="utf-8")

    # 幂等：已经注入过就不再插
    if SHIM_TAG in text:
        status = "已注入(跳过)"
    elif INJECT_ANCHOR in text:
        text = text.replace(INJECT_ANCHOR, "  " + SHIM_TAG + "\n" + INJECT_ANCHOR, 1)
        status = "已注入"
    else:
        status = "!! 找不到 </head>，未注入"

    dst.write_text(text, encoding="utf-8")
    return "%s  (%.1f KB)" % (status, dst.stat().st_size / 1024)


def copy_file(rel: str, src_root: Path | None = None) -> str:
    src = (src_root or SRC_WEB) / rel
    dst = OUT / rel
    if not src.exists():
        return "缺失源文件：%s" % src
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return "已复制  (%.1f KB)" % (dst.stat().st_size / 1024)


def hide_admin_entry(name: str) -> str:
    """纯静态版不带后台（部署约定本来就不传 admin.html），把入口藏掉免得点出 404"""
    f = OUT / name
    text = f.read_text(encoding="utf-8")
    if 'class="admin-entry"' not in text:
        return "无后台入口"
    if 'class="admin-entry" style="display:none"' in text:
        return "入口已隐藏(跳过)"
    text = text.replace('class="admin-entry"',
                        'class="admin-entry" style="display:none"', 1)
    f.write_text(text, encoding="utf-8")
    return "入口已隐藏"


def copy_images() -> str:
    src = ROOT / "assets" / "images"
    dst = OUT / "assets" / "images"
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for f in src.iterdir():
        if f.is_file():
            shutil.copy2(f, dst / f.name)
            n += 1
    return "已复制 %d 个文件" % n


def copy_404() -> str:
    """404 页：把站根绝对路径改写成相对路径，好兼容子路径部署。

    只砍「单个前导斜杠」，"//host" 这类协议相对 URL 与 https:// 都不动。
    """
    src = SRC_WEB / PAGES_RELATIVE[0]
    dst = OUT / PAGES_RELATIVE[0]
    if not src.exists():
        return "缺失源文件：%s" % src
    text = src.read_text(encoding="utf-8")
    text, n = re.subn(r'((?:src|href)\s*=\s*["\'])/(?!/)', r"\1", text)
    dst.write_text(text, encoding="utf-8")
    return "已复制，相对化 %d 处绝对路径  (%.1f KB)" % (n, dst.stat().st_size / 1024)


def write_robots() -> str:
    f = OUT / "robots.txt"
    f.write_text(ROBOTS_STANDALONE, encoding="utf-8")
    return "已生成（路径无关版，%.0f B）" % f.stat().st_size


def write_nojekyll() -> str:
    """GitHub Pages 见到 .nojekyll 就不再走 Jekyll 处理，产物原样发布。"""
    f = OUT / ".nojekyll"
    f.write_text("", encoding="utf-8")
    return "已生成（跳过 Jekyll 处理）"


def check_refs() -> list:
    """扫描产物 HTML 里的本地引用，确认文件真的存在（不存在的列出来）"""
    missing = []
    pat = re.compile(r'(?:src|href)\s*=\s*["\']([^"\'#?]+)["\']', re.I)
    for name in PAGES + PAGES_RELATIVE:
        f = OUT / name
        if not f.exists():
            continue
        for ref in pat.findall(f.read_text(encoding="utf-8")):
            if ref.startswith(("http://", "https://", "data:", "//", "mailto:", "javascript:")):
                continue
            if ref == "admin.html":
                continue  # 后台入口已在上面隐藏，纯静态版不带 admin.html
            if not (OUT / ref).exists():
                missing.append("%s -> %s" % (name, ref))
    return missing


def main() -> int:
    if not SRC_WEB.is_dir():
        print("找不到 web/ 目录：%s" % SRC_WEB)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    print("输出目录：%s" % OUT)
    print("=" * 78)

    print("[页面]")
    for p in PAGES:
        print("  %-18s %s" % (p, copy_page(p)))
    print("  %-18s %s" % ("[后台入口]", hide_admin_entry("index.html")))
    print("[错误页]")
    print("  %-18s %s" % (PAGES_RELATIVE[0], copy_404()))
    print("[其余静态文件]")
    for e in EXTRA:
        print("  %-18s %s" % (e, copy_file(e)))
    print("  %-18s %s" % ("robots.txt", write_robots()))
    print("  %-18s %s" % (".nojekyll", write_nojekyll()))
    print("[数据]")
    print("  %-18s %s" % ("data/content.json",
                          copy_file("data/content.json", src_root=ROOT)))
    print("[图片]")
    print("  %-18s %s" % ("assets/images/", copy_images()))

    shim = OUT / "static-api.js"
    print("[适配层]")
    if shim.exists():
        print("  %-18s 存在 (%.1f KB) —— 本脚本不覆盖，手写维护" % ("static-api.js", shim.stat().st_size / 1024))
    else:
        print("  %-18s !! 缺失！页面将无法取到数据" % "static-api.js")

    print("=" * 78)
    missing = check_refs()
    if missing:
        print("引用检查：发现 %d 个断链" % len(missing))
        for m in missing:
            print("  !! " + m)
    else:
        print("引用检查：全部本地引用均可解析 ✓")

    print("\n本地预览：python -m http.server 8099 --directory \"%s\"" % OUT)
    print("上线：推仓库后由 .github/workflows/pages.yml 发布到 GitHub Pages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
