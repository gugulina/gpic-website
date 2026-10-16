# -*- coding: utf-8 -*-
"""
社团官网图片处理脚本（对应《社团官网规划文档》5.3 节）
--------------------------------------------------------
作用：把画师 / 美工交付的原始素材，压缩生成为网站可直接引用的资源。
原始素材只读取、不修改、不删除。

用法：
    python scripts/build-assets.py

输入（放在项目根目录的原始素材）：
    可用背景1.png            品牌横幅（含社团名与口号），2560×1494
    幻电投 简化logo.png      简化标志 + GPIC 标准字，1920×1080，透明底
    幻电投 立绘logo.png      立绘标识，4500×5398
    月都核工 logo.png        月宫核工业集团，1920×1080，透明底
    河童水电 logo.png        河童地热水电集团，1920×1080，透明底
    飞鸟集团 logo.png        飞鸟集团，2560×1600，透明底
    斯卡雷特 logo.png        斯卡雷特能源集团，1280×720，透明底（含上下两版，取上方）
    产品海报.jpg             周边商品价目海报，含全部商品图与售价

输出（assets/images/）：
    banner.webp / banner.jpg / banner-960.webp   品牌横幅（hero 首屏）
    share.jpg                                    分享卡片专用图（og:image，JPEG）
    logo-mascot.webp / .jpg                      立绘标识
    logo-simple.webp / .png                      简化标志 + GPIC 标准字（透明底）
    logo-mark.webp / .png                        仅标志（透明底）
    favicon.png / favicon.ico                    站点图标（自动裁切标志）
    brand-lunar.webp / .png                      月宫核工业集团
    brand-kappa.webp / .png                      河童地热水电集团
    brand-asuka.webp / .png                      飞鸟集团
    brand-scarlet.webp / .png                    斯卡雷特能源集团
    goods-poster.webp                            周边商品目录海报（整张）
    goods-*.webp                                 周边商品缩略图（从海报按区域裁切）

依赖：pillow     pip install pillow

★ 成员单位 logo 的用色约定（重要，改版式前务必先读）
    美工交付的 4 个成员单位 logo 都是「浅色标识 + 透明底」，是**为深色背景设计**的：
        · 月都核工   浅灰 #D5D5D5 标准字
        · 河童水电   纯白标准字 + 蓝色徽章
        · 飞鸟集团   纯白字标
        · 斯卡雷特   白标准字 + 深红徽章
    把它们放在白底或浅色底上时，右侧标准字会**完全看不见**（只剩左边的徽章）。
    因此 index.html 的品牌卡片统一使用深色底（--brand-deep），本社卡片例外
    （幻电投的标志是彩色深绿+红+橙，只在浅底上好看）。
    若以后拿到这批 logo 的浅底版，替换源文件后需要同步改 .brand-card 的样式。

    历史：早期只有月宫核工一个 logo 时，用过「反相派生」（brand-lunar-inv）来适配
    浅色卡片；该方案会破坏品牌色（蓝→黄、白→黑），拿到深色卡片方案后已废弃，
    相关文件不再生成。
"""

import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DST = os.path.join(ROOT, "assets", "images")

BANNER_SRC = "可用背景1.png"
MASCOT_SRC = "幻电投 立绘logo.png"
SIMPLE_SRC = "幻电投 简化logo.png"
POSTER_SRC = "产品海报.jpg"

# 成员单位 logo：(输出前缀, 源文件名, 裁切框)
# 裁切框用于源图内含多个版本的场合，坐标为原图像素 (x1, y1, x2, y2)；None = 整张。
BRAND_SOURCES = [
    ("brand-lunar",   "月都核工 logo.png", None),
    ("brand-kappa",   "河童水电 logo.png", None),
    ("brand-asuka",   "飞鸟集团 logo.png", None),
    ("brand-scarlet", "斯卡雷特 logo.png", (12, 74, 1214, 332)),   # 只取上方的主标志版
]

# 简化 logo 里「标志」与「GPIC 标准字」的分界高度（原图像素）。素材改版后需重新标定。
SIMPLE_MARK_BOTTOM = 778

# 输出上限（长边像素）。约 2~3 倍于实际显示尺寸，保证高分屏下清晰。
BRAND_MAX_W, BRAND_MAX_H = 720, 360
MARK_WIDTH = 480

# 分享卡片图（og:image）的宽度。
#
# ★ 为什么单出一张、且用 JPEG 而不是 WebP（改这块之前务必先读）
#   1. 这张图只被微信 / QQ / 微博的**抓取程序**取用，不参与首屏加载，
#      所以它的大小不影响访客体验，没必要为了省体积换成 WebP；
#      恰恰相反——微信 / QQ 的链接预览对 WebP 的支持**不稳定**，
#      换 WebP 有让预览图直接不显示的风险，而分享到微信正是本站的主场景。
#   2. **不做裁切**。横幅上压着社团名与口号，按 1200×630 硬裁会切掉上下文字；
#      等比缩到 1200 宽（约 1200×700）即可，主流平台都能正常取用。
SHARE_WIDTH = 1200

# 从产品海报裁切商品缩略图：(输出名, x1, y1, x2, y2)，坐标为原图百分比。
# 海报版面若改版，这里需要重新标定。
POSTER_CROPS = [
    ("goods-proof",    0.020, 0.126, 0.815, 0.252),
    ("goods-warning",  0.005, 0.283, 0.530, 0.410),
    ("goods-energy",   0.690, 0.272, 0.995, 0.430),
    ("goods-kosuzu",   0.020, 0.466, 0.430, 0.636),
    ("goods-keychain", 0.455, 0.503, 0.998, 0.634),
    ("goods-badge",    0.085, 0.682, 0.912, 0.812),
    ("goods-postcard", 0.160, 0.862, 0.780, 0.958),
]


def save(im, name, **kw):
    path = os.path.join(DST, name)
    im.save(path, **kw)
    print("  %-24s %sx%s  %6.0f KB" % (name, im.width, im.height, os.path.getsize(path) / 1024))


def load(name):
    path = os.path.join(ROOT, name)
    if not os.path.exists(path):
        print("!! 找不到素材：%s" % path)
        return None
    im = Image.open(path)
    print("  源 %-22s %s %s  %.2f MB" % (name, im.size, im.mode, os.path.getsize(path) / 1024 / 1024))
    return im


def trim_alpha(im, thresh=8):
    """按不透明像素裁掉四周空白"""
    bb = im.convert("RGBA").split()[-1].point(lambda v: 255 if v > thresh else 0).getbbox()
    return im.crop(bb) if bb else im


def fit(im, max_w, max_h=None):
    """等比缩放到不超过给定上限（只缩不放）"""
    if max_h is None:
        max_h = max_w
    scale = min(1.0, max_w / im.width, max_h / im.height)
    if scale >= 1.0:
        return im
    return im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                     Image.LANCZOS)


def main():
    os.makedirs(DST, exist_ok=True)
    print("== 素材来源 ==")
    banner_src = load(BANNER_SRC)
    mascot_src = load(MASCOT_SRC)
    simple_src = load(SIMPLE_SRC)

    print("\n== 横幅 / 立绘 ==")
    if banner_src:
        banner = banner_src.convert("RGB")
        b = banner.resize((1920, round(banner.height * 1920 / banner.width)), Image.LANCZOS)
        save(b, "banner.webp", format="WEBP", quality=88, method=6)
        save(b, "banner.jpg", format="JPEG", quality=88, optimize=True, progressive=True)
        save(b.resize((960, round(b.height * 960 / b.width)), Image.LANCZOS),
             "banner-960.webp", format="WEBP", quality=86, method=6)

        # 分享卡片图：等比缩到 SHARE_WIDTH 宽，保持原始宽高比（理由见文件头 SHARE_WIDTH 注释）
        share = b.resize((SHARE_WIDTH, round(b.height * SHARE_WIDTH / b.width)), Image.LANCZOS)
        save(share, "share.jpg", format="JPEG", quality=86, optimize=True, progressive=True)

    if mascot_src:
        m0 = mascot_src.convert("RGB")
        m = m0.resize((900, round(m0.height * 900 / m0.width)), Image.LANCZOS)
        save(m, "logo-mascot.webp", format="WEBP", quality=90, method=6)
        save(m, "logo-mascot.jpg", format="JPEG", quality=90, optimize=True, progressive=True)

    print("\n== 本社简化标志（透明底） ==")
    if simple_src:
        s0 = simple_src.convert("RGBA")

        # 整张：标志 + GPIC 标准字
        full = fit(trim_alpha(s0), 720)
        save(full, "logo-simple.webp", format="WEBP", quality=92, method=6)
        save(full, "logo-simple.png", format="PNG", optimize=True)

        # 仅标志：导航栏与品牌卡片用（去掉下方 GPIC 标准字）
        mark = trim_alpha(s0.crop((0, 0, s0.width, SIMPLE_MARK_BOTTOM)))
        print("  标志裁切后 %sx%s" % mark.size)
        mark = fit(mark, MARK_WIDTH)
        save(mark, "logo-mark.webp", format="WEBP", quality=92, method=6)
        save(mark, "logo-mark.png", format="PNG", optimize=True)

        print("\n== 站点图标 ==")
        side = max(mark.size) + 48
        canvas = Image.new("RGB", (side, side), (255, 255, 255))
        canvas.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2), mark.split()[-1])
        canvas = canvas.resize((256, 256), Image.LANCZOS)
        save(canvas, "favicon.png", format="PNG", optimize=True)
        ico = os.path.join(DST, "favicon.ico")
        canvas.save(ico, sizes=[(16, 16), (32, 32), (48, 48)])
        print("  %-24s 256x256  %6.0f KB" % ("favicon.ico", os.path.getsize(ico) / 1024))

    print("\n== 成员单位 logo（深色卡片用，保留透明底） ==")
    for prefix, src_name, crop_box in BRAND_SOURCES:
        src = load(src_name)
        if not src:
            continue
        im = src.convert("RGBA")
        if crop_box:
            im = im.crop(crop_box)
        im = fit(trim_alpha(im), BRAND_MAX_W, BRAND_MAX_H)
        save(im, prefix + ".webp", format="WEBP", quality=92, method=6)
        save(im, prefix + ".png", format="PNG", optimize=True)

    print("\n== 周边商品图（从产品海报裁切） ==")
    poster_img = load(POSTER_SRC)
    if poster_img:
        p = poster_img.convert("RGB")
        pw, ph = p.size
        save(p.resize((640, round(ph * 640 / pw)), Image.LANCZOS),
             "goods-poster.webp", format="WEBP", quality=86, method=6)
        for name, x1, y1, x2, y2 in POSTER_CROPS:
            c = p.crop((int(x1 * pw), int(y1 * ph), int(x2 * pw), int(y2 * ph)))
            cw = min(640, c.width)
            c = c.resize((cw, round(c.height * cw / c.width)), Image.LANCZOS)
            save(c, name + ".webp", format="WEBP", quality=88, method=6)

    print("\n完成。输出目录：%s" % DST)


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        sys.exit("缺少依赖，请先执行：pip install pillow")
