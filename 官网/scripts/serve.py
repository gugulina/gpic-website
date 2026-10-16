#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
幻想乡电力投资集团 · 官网「本地预览 + 发布」服务器

用法：
    python scripts/serve.py             启动并自动打开管理后台
    python scripts/serve.py --no-open   只启动，不自动开浏览器

它做五件事：
    1. GET  /             提供静态文件（站点首页 + 管理后台）
    2. POST /api/save     接收后台点「发布」提交的数据，覆盖 data/content.json（自动备份旧版）
    3. POST /api/upload   接收后台上传的图片，自动转 WebP + 限宽后写入 assets/images/
    4. GET  /api/backups  列出 data/.backup/ 里的历史版本
    5. POST /api/rollback 把某个历史版本写回 data/content.json（回滚前会先备份当前版本）

另外两个辅助接口：
    GET /api/ping         在线探测，并带上磁盘上 content.json 的版本与内容指纹
    GET /api/assets       列出 assets/images/ 的真实文件（后台素材库用）

关于「发布的乐观锁」：
    /api/save 会检查请求头 X-Content-Base（后台记下的「这份草稿基于哪个版本」）。
    与磁盘当前指纹不一致 → 409 拒绝，避免浏览器里的旧草稿把后来的改动整片盖掉。
    响应体带 stale=true 与 disk 信息。确实要用草稿覆盖时，加 ?force=1。

安全说明：只监听 127.0.0.1（本机回环），不对外网开放，也不会被局域网访问到。
"""

import datetime
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

# Pillow 用来把上传的图片转成 WebP —— 站点约定首屏 ≤500KB，原图直灌会直接破功。
# 没装也不影响其它功能：上传会退化成「原样保存」并在响应里说明。
try:
    from PIL import Image
    HAVE_PIL = True
except Exception:  # noqa: BLE001
    Image = None
    HAVE_PIL = False

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
IMAGES = ROOT / "assets" / "images"
BACKUP = DATA / ".backup"
HOST = "127.0.0.1"
PORT = 8788

ALLOWED_EXT = ("webp", "png", "jpg", "jpeg", "gif", "svg", "avif",
               "bmp", "tif", "tiff")   # 后三个只在上传时接受，会被转成 WebP

# 上传转码参数（与 scripts/build-assets.py 的口径保持一致）
UPLOAD_MAX_W = 1600        # 超过这个宽度就等比缩下来；站点最宽的图是 1920 的横幅
UPLOAD_QUALITY = 88        # WebP 质量。横幅用 88，周边缩略图用 88，这里统一取 88
TRANSCODE_EXT = ("png", "jpg", "jpeg", "bmp", "tif", "tiff")  # 这些格式一律转成 WebP
PASSTHROUGH_EXT = ("svg", "gif", "avif")                      # 矢量 / 动图 / 特殊格式原样保存
BACKUP_NAME_RE = re.compile(r"^content-\d{8}-\d{6}(-\d{3})?\.json$")

# 只接受来自本机页面的请求。
# 只监听回环地址挡得住外网，但挡不住 DNS rebinding —— 浏览器里任何一个网页
# 理论上都能 POST 到 127.0.0.1。校验 Host / Origin 是成本最低的有效防线。
ALLOWED_HOSTS = {"127.0.0.1:%d" % PORT, "localhost:%d" % PORT}
ALLOWED_ORIGINS = {"http://127.0.0.1:%d" % PORT, "http://localhost:%d" % PORT}

BACKUP_KEEP = 30  # 备份目录最多保留的份数


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        path = urlparse(self.path).path.lower()
        if path.endswith((".html", ".htm", ".json", ".js", ".css")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def guess_type(self, path):
        p = str(path).lower()
        if p.endswith(".webp"):
            return "image/webp"
        if p.endswith(".avif"):
            return "image/avif"
        return super().guess_type(path)

    def send_error(self, code, message=None, explain=None):
        """404 时改送根目录的 404.html，让本地预览与线上表现一致。
        线上静态托管本来就是这么干的；不这么做的话，本地测试 404 页面
        只能在文件名上手动访问 /404.html，永远测不到"地址打错"这条真实路径。
        出错就退回标准行为，不会把服务器搞挂。"""
        if code == 404:
            page = ROOT / "404.html"
            if page.is_file():
                try:
                    body = page.read_bytes()
                except OSError:
                    body = None
                if body is not None:
                    self.send_response(404)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(body)
                    return
        super().send_error(code, message, explain)

    def json_out(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---------- 同源校验（挡 DNS rebinding） ----------
    def same_origin(self):
        """Host 必须是本机地址；带了 Origin 的话也必须是本机来源。"""
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in ALLOWED_HOSTS:
            return False
        origin = (self.headers.get("Origin") or "").strip().lower()
        if origin and origin not in ALLOWED_ORIGINS:
            return False
        return True

    def deny_cross_site(self):
        """校验不通过就拒绝，返回 True 表示已经响应过、调用方应直接返回。"""
        if self.same_origin():
            return False
        self.log_message("拒绝跨站请求 Host=%s Origin=%s",
                         self.headers.get("Host"), self.headers.get("Origin"))
        self.json_out({
            "ok": False,
            "error": "拒绝跨站请求：Host 或 Origin 不是本机地址。"
                     "请通过 http://127.0.0.1:%d/ 打开站点与后台再操作。" % PORT,
        }, 403)
        return True

    # ---------- GET ----------
    def do_GET(self):
        if self.deny_cross_site():
            return
        parsed = urlparse(self.path)
        if parsed.path == "/api/ping":
            info = current_content_info()
            return self.json_out({
                "ok": True,
                "root": str(ROOT),
                "port": PORT,
                "time": int(time.time()),
                # 告诉后台「上传会不会自动压图」，后台据此决定还要不要提醒你手动压
                "pillow": HAVE_PIL,
                "maxWidth": UPLOAD_MAX_W,
                "backups": len(self.backup_files()),
                # 磁盘上 content.json 的现状（含指纹）：后台拿它判断
                # 「我这份草稿所基于的版本，是否已经被别的改动取代」
                "content": info,
            })
        if parsed.path == "/api/backups":
            return self.list_backups()
        if parsed.path == "/api/assets":
            files = []
            if IMAGES.is_dir():
                for f in sorted(IMAGES.iterdir()):
                    if f.is_file() and f.suffix.lower().lstrip(".") in ALLOWED_EXT:
                        st = f.stat()
                        files.append({
                            "path": "assets/images/" + f.name,
                            "name": f.name,
                            "size": st.st_size,
                            "mtime": int(st.st_mtime),
                        })
            return self.json_out({"ok": True, "files": files})
        if parsed.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()

    # ---------- POST ----------
    def do_POST(self):
        if self.deny_cross_site():
            return
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""

        if parsed.path == "/api/save":
            return self.save_content(raw, query)
        if parsed.path == "/api/upload":
            return self.upload_image(raw, query)
        if parsed.path == "/api/rollback":
            return self.rollback(query)
        return self.json_out({"ok": False, "error": "未知接口：" + parsed.path}, 404)

    def save_content(self, raw, query):
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            return self.json_out({"ok": False, "error": "JSON 解析失败：%s" % exc}, 400)

        # 结构闸门：内容不完整一律拒绝，避免把站点覆盖成一个空壳
        if not isinstance(data, dict):
            return self.json_out({"ok": False, "error": "内容必须是 JSON 对象，已拒绝写入。"}, 400)
        if not isinstance(data.get("site"), dict):
            return self.json_out({"ok": False, "error": "缺少 site 段，内容结构不完整，已拒绝写入。"}, 400)
        if not isinstance(data.get("version"), int):
            return self.json_out({"ok": False, "error": "缺少 version 字段或类型不对，已拒绝写入。"}, 400)

        DATA.mkdir(parents=True, exist_ok=True)
        target = DATA / "content.json"

        # 陈旧闸门：拒绝「基于旧版本改的草稿」覆盖磁盘上较新的内容。
        # 典型事故是浏览器里留着一份旧草稿，一按发布就把后来写进文件的改动
        # （比如新接的素材、别处改的文案）整片盖掉，而且全程没有任何提示。
        # 结构版本号 MIN_VER 只挡得住「结构变了」，挡不住「只改了值」的覆盖。
        force = str((query.get("force") or ["0"])[0]).lower() in ("1", "true", "yes")
        if not force:
            info = current_content_info()
            if info["exists"]:
                base = (self.headers.get("X-Content-Base") or "").strip()
                stale_reason = None
                if base:
                    # 乐观锁：后台带来的基线指纹对不上当前磁盘版本 → 中间被改过
                    if base != info["fingerprint"]:
                        stale_reason = "提交的草稿基于 %s，而磁盘上现在已是 %s。" % (
                            base, info["fingerprint"])
                else:
                    # 没带基线（旧版前端或第三方调用）：退回按 updatedAt 判断
                    disk_ts = iso_to_epoch(info["updatedAt"])
                    post_ts = iso_to_epoch(data.get("updatedAt"))
                    if disk_ts is not None and post_ts is not None and post_ts < disk_ts:
                        stale_reason = "提交内容的 updatedAt 是 %s，磁盘上是 %s。" % (
                            data.get("updatedAt"), info["updatedAt"])
                if stale_reason:
                    return self.json_out({
                        "ok": False,
                        "stale": True,
                        "error": ("磁盘上的 data/content.json 已经比这份草稿新，已拒绝写入，"
                                  "以免覆盖掉后来的改动。请先「载入服务器版本」；"
                                  "确实要用草稿覆盖，请加 ?force=1。"),
                        "reason": stale_reason,
                        "base": base or None,
                        "disk": info,
                    }, 409)

        # 先把上一版挪进备份目录，再写新文件（避免写坏导致内容全丢）
        archived = archive_current()

        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        target.write_text(text, encoding="utf-8")
        prune_backups()
        return self.json_out({
            "archived": archived,
            "ok": True,
            "path": "data/content.json",
            "bytes": len(text.encode("utf-8")),
            "at": int(time.time()),
            # 回给后台：这是刚写进去的版本的指纹，后台把它记成新的基线
            "fingerprint": content_fingerprint(data),
        })

    def upload_image(self, raw, query):
        name = os.path.basename(unquote((query.get("name") or [""])[0]))
        if not name or "." not in name:
            return self.json_out({"ok": False, "error": "文件名不合法"}, 400)
        ext = name.rsplit(".", 1)[-1].lower()
        if ext not in ALLOWED_EXT:
            return self.json_out({"ok": False, "error": "不支持的图片格式：." + ext}, 400)
        if not raw:
            return self.json_out({"ok": False, "error": "文件内容为空"}, 400)

        IMAGES.mkdir(parents=True, exist_ok=True)

        info = {"converted": False, "pillow": HAVE_PIL, "maxWidth": UPLOAD_MAX_W}
        out_name = name
        payload = raw

        if ext in TRANSCODE_EXT:
            if not HAVE_PIL:
                info["note"] = "服务端未安装 Pillow，已按原格式原样保存（未压缩、未限宽）。"
            else:
                try:
                    out_name, payload, meta = transcode_webp(raw, name)
                except Exception as exc:  # noqa: BLE001
                    return self.json_out({
                        "ok": False,
                        "error": "图片解码失败（可能不是有效的图片文件，或文件已损坏）：%s" % exc,
                    }, 400)
                # WebP 对照片几乎稳赢，但对扁平色块图（logo、纯色底图）偶尔会更大。
                # 项目里最硬的约束是「首屏 ≤500KB」，所以谁小用谁 ——
                # 除非原图被限宽过，那时候宽度优先，必须用缩小的 WebP。
                if (not meta["resized"] and ext not in ("bmp", "tif", "tiff")
                        and len(payload) >= len(raw)):
                    info.update(meta)
                    info["converted"] = False
                    info["note"] = ("转成 WebP 后反而更大（%.0f KB → %.0f KB），已按原格式保存。"
                                    % (len(raw) / 1024.0, len(payload) / 1024.0))
                    out_name, payload = name, raw
                else:
                    info.update(meta)
                    info["converted"] = True
        elif ext in PASSTHROUGH_EXT:
            info["note"] = "矢量 / 动图 / 特殊格式不做转码，已按原格式保存。"

        # 同名文件若内容完全一致，直接复用，避免反复上传堆出一堆副本
        existing = IMAGES / out_name
        reused = False
        try:
            if existing.is_file() and existing.read_bytes() == payload:
                reused = True
            else:
                existing = None
        except OSError:
            existing = None

        if not reused:
            out_name = unique_name(IMAGES, out_name)
            target = IMAGES / out_name
            try:
                target.write_bytes(payload)
            except OSError as exc:
                return self.json_out({"ok": False, "error": "写入失败：%s" % exc}, 500)
        else:
            out_name = existing.name

        st = (IMAGES / out_name).stat()
        return self.json_out({
            "ok": True,
            "path": "assets/images/" + out_name,
            "name": out_name,
            "bytes": st.st_size,
            "originalBytes": len(raw),
            "reused": reused,
            "at": int(time.time()),
            **info
        })

    # ---------- 历史版本 ----------
    def backup_files(self):
        """data/.backup/ 里的备份，按时间从新到旧。"""
        if not BACKUP.is_dir():
            return []
        found = []
        for f in BACKUP.glob("content-*.json"):
            if f.is_file():
                try:
                    found.append((f.stat().st_mtime, f))
                except OSError:
                    continue
        found.sort(key=lambda t: t[0], reverse=True)
        return [f for _, f in found]

    def list_backups(self):
        items = []
        for f in self.backup_files():
            try:
                st = f.stat()
            except OSError:
                continue
            item = {"name": f.name, "bytes": st.st_size, "mtime": int(st.st_mtime), "valid": False}
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(d, dict):
                    item["valid"] = isinstance(d.get("site"), dict)
                    item["version"] = d.get("version")
                    item["updatedAt"] = d.get("updatedAt")
                    item["siteName"] = (d.get("site") or {}).get("name") or ""
            except Exception:  # noqa: BLE001
                item["valid"] = False
            items.append(item)

        cur = DATA / "content.json"
        current = None
        if cur.is_file():
            st = cur.stat()
            current = {"bytes": st.st_size, "mtime": int(st.st_mtime)}
        return self.json_out({
            "ok": True,
            "keep": BACKUP_KEEP,
            "current": current,
            "files": items,
        })

    def rollback(self, query):
        name = os.path.basename(unquote((query.get("name") or [""])[0]))
        if not name or not BACKUP_NAME_RE.match(name):
            return self.json_out({"ok": False, "error": "备份文件名不合法"}, 400)
        src = BACKUP / name
        if not src.is_file():
            return self.json_out({
                "ok": False,
                "error": "找不到这个备份：%s（列表可能已过期，刷新一下再试）" % name,
            }, 404)
        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            return self.json_out({"ok": False, "error": "备份内容无法解析：%s" % exc}, 400)
        if not isinstance(data, dict) or not isinstance(data.get("site"), dict):
            return self.json_out({"ok": False, "error": "备份内容结构不完整，已拒绝回滚。"}, 400)

        # 回滚前先把「当前版本」也存一份 —— 这样回滚本身也能再撤销
        archived = archive_current()
        DATA.mkdir(parents=True, exist_ok=True)
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        (DATA / "content.json").write_text(text, encoding="utf-8")
        prune_backups()
        self.log_message("回滚到 %s（回滚前的版本已存为 %s）", name, archived)
        return self.json_out({
            "ok": True,
            "restored": name,
            "archived": archived,
            "bytes": len(text.encode("utf-8")),
            "at": int(time.time()),
            "content": data,
        })


def iso_to_epoch(value):
    """把 content.json 里的 updatedAt（ISO 8601，形如 2026-09-18T04:48:30.000Z）
    转成可比较的秒数；认不出来就返回 None（此时不做陈旧判断，宁可放过不可误拦）。"""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        dt = datetime.datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt.timestamp()


def read_current_content():
    """读磁盘上的 data/content.json；读不到或不是对象就返回 None。"""
    target = DATA / "content.json"
    if not target.is_file():
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def content_fingerprint(data):
    """内容指纹 —— 只取决于字段值，与 JSON 的书写格式无关。

    用来做一次乐观锁：后台发布时带上「我这份草稿是基于哪个版本改的」，
    服务端拿它和磁盘上的当前版本比对，对不上就拒绝写入。
    这一层挡的是「草稿比磁盘旧」的静默覆盖 —— 只比 updatedAt 挡不住，
    因为用户一编辑草稿，草稿的时间戳就变新了。
    """
    if not isinstance(data, dict):
        return None
    blob = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def current_content_info():
    data = read_current_content()
    if data is None:
        return {"exists": False, "fingerprint": None, "updatedAt": None,
                "version": None, "bytes": 0}
    target = DATA / "content.json"
    return {
        "exists": True,
        "fingerprint": content_fingerprint(data),
        "updatedAt": data.get("updatedAt"),
        "version": data.get("version"),
        "bytes": target.stat().st_size,
    }


def stamp():
    """备份文件名用的时间戳。带毫秒，避免同一秒内连续发布把前一次备份顶掉。"""
    return time.strftime("%Y%m%d-%H%M%S") + "-%03d" % int((time.time() % 1) * 1000)


def archive_current():
    """把当前 data/content.json 挪进备份目录，返回备份文件名（没有文件则返回 None）。"""
    target = DATA / "content.json"
    if not target.is_file():
        return None
    try:
        BACKUP.mkdir(parents=True, exist_ok=True)
        name = "content-%s.json" % stamp()
        target.replace(BACKUP / name)
        return name
    except OSError:
        return None


def transcode_webp(raw, name):
    """把上传的图片转成 WebP 并限宽。返回 (新文件名, 字节, 说明信息)。"""
    im = Image.open(io.BytesIO(raw))
    im.load()
    src_w, src_h = im.size
    src_fmt = im.format or "?"
    has_alpha = (im.mode in ("RGBA", "LA")) or (im.mode == "P" and "transparency" in im.info)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if has_alpha else "RGB")

    out_w, out_h = src_w, src_h
    if src_w > UPLOAD_MAX_W:
        out_w = UPLOAD_MAX_W
        out_h = max(1, round(src_h * UPLOAD_MAX_W / src_w))
        im = im.resize((out_w, out_h), Image.LANCZOS)

    buf = io.BytesIO()
    im.save(buf, format="WEBP", quality=UPLOAD_QUALITY, method=6)
    data = buf.getvalue()

    return name.rsplit(".", 1)[0] + ".webp", data, {
        "format": src_fmt,
        "width": out_w,
        "height": out_h,
        "srcWidth": src_w,
        "srcHeight": src_h,
        "resized": out_w != src_w,
        "alpha": has_alpha,
    }


def unique_name(folder, name):
    """目录里已有同名文件时，依次尝试 xxx-2.webp / xxx-3.webp……"""
    if not (folder / name).exists():
        return name
    stem, _, ext = name.rpartition(".")
    for i in range(2, 200):
        cand = "%s-%d.%s" % (stem, i, ext)
        if not (folder / cand).exists():
            return cand
    return "%s-%d.%s" % (stem, int(time.time()), ext)


def prune_backups():
    """备份目录只保留最近 BACKUP_KEEP 份，避免长期使用后无限增长。"""
    try:
        olds = sorted(BACKUP.glob("content-*.json"))
    except OSError:
        return
    for f in olds[:-BACKUP_KEEP]:
        try:
            f.unlink()
        except OSError:
            pass


def main():
    os.chdir(str(ROOT))
    url = "http://%s:%d/admin.html" % (HOST, PORT)
    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        print("无法监听 %s:%d —— %s" % (HOST, PORT, exc))
        print("可能已有一个预览服务器在运行，关掉它再试。")
        return 1

    print("=" * 58)
    print(" 幻想乡电力投资集团 · 官网本地服务器已启动")
    print(" 站点首页：http://%s:%d/" % (HOST, PORT))
    print(" 管理后台：%s" % url)
    print(" 数据目录：%s" % DATA)
    print(" 按 Ctrl+C 停止")
    print("=" * 58)

    if "--no-open" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
