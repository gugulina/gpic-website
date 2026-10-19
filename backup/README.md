# GPIC 官网 · 备份说明

> 目的：在使用 Qoder 等外部工具改动项目（甚至改动 GitHub 仓库状态）之前，
> 留一份**不依赖 git、不依赖云端**的本地快照，随时能回退或整站迁移。

---

## 一、为什么是三层，而不是「复制一个文件夹」

这个项目有个容易踩的坑：**最值钱的数据都不在 git 里**。

`.gitignore` 主动排除了这些（都是对的，因为仓库是公开的）：

| 被排除的内容 | 为什么不能进公开仓库 | 体积 |
|---|---|---|
| `官网/server/data/`（SQLite 库） | 含主催口令哈希、会话 | 248 K |
| `官网/web/admin.html` | 后台入口页 | 65 K |
| `官网/web/assets/uploads/` | 用户上传图 | 444 K |
| `官网/.workbuddy/memory/` | 项目决策记录 | 3.4 M |
| `官网/data/.backup/` | content.json 历史快照 | 408 K |
| `工具/`、四份办法通知、组织架构图 | 社团内部业务资料 | — |

所以**只备份 git = 丢光内容数据**。三层各管一件事：

```
backup/
├─ gpic-20261019-0850/            ← ① 完整文件副本（可直接运行）
│   ├─ 官网/                       含数据库、后台页、上传图、项目记忆
│   ├─ 工具/                       社团业务表
│   └─ ...根目录其它文件
├─ db/
│   └─ gpic-20261019-0850.sqlite   ← ② 数据库一致性快照（VACUUM INTO）
├─ gpic-20261019-0850.bundle       ← ③ git 全历史（单文件，11 MB）
└─ README.md                       ← 本文件
```

- **① 副本**：直接 `node server/index.mjs` 就能跑，用来"复制迁移"。
  不含 `.git`，避免和主仓库的 git 状态打架。
- **② 数据库快照**：`VACUUM INTO` 产出的事务一致副本。
  **不要直接 cp `gpic.sqlite`** —— 库是 WAL 模式，未合并的写入在 `-wal` 里，直接拷会丢。
- **③ bundle**：`git bundle create --all`，包含全部分支与提交历史。
  等价于"把整个 GitHub 仓库装进一个文件"。

---

## 二、恢复：三种场景

### 场景 A —— 内容被改坏了，只想回滚内容（最常用）

只把数据库换回去即可，代码不动：

```bash
cd "C:/Users/泽宇/WorkBuddy/幻想乡电力投资集团"
# 先停服务（Ctrl+C，或杀掉 4321 端口进程）
cp "backup/db/gpic-20261019-0850.sqlite" "官网/server/data/gpic.sqlite"
rm -f "官网/server/data/gpic.sqlite-wal" "官网/server/data/gpic.sqlite-shm"
# 重新启动服务即可
```

### 场景 B —— 代码被改坏了，想回到某个提交

如果只是工作区被改乱，主仓库的 `.git` 还在：

```bash
cd "C:/Users/泽宇/WorkBuddy/幻想乡电力投资集团"
git status                  # 先看改了什么
git restore .               # 丢弃未提交的改动
# 如果连提交历史都被动了（比如被 force push 覆盖）：
git fetch "backup/gpic-20261019-0850.bundle" main:rescue
git checkout rescue
```

### 场景 C —— 换机器 / 整站迁移

```bash
# 1) 把 backup/gpic-20261019-0850/ 整个拷到新机器
# 2) 直接就能跑：
cd "gpic-20261019-0850/官网"
node server/index.mjs
#    浏览器开 http://127.0.0.1:4321/

# 3) 如果想在新机器继续开发（要 git 历史）：
git clone "备份路径/gpic-20261019-0850.bundle" my-site
cd my-site
git remote set-url origin https://github.com/gugulina/gpic-website.git
```

> 副本里的数据库已替换为干净快照，**不含 `-wal` / `-shm`**，跨机器不会出问题。

---

## 三、再做一次备份

双击项目根目录的 **`备份.bat`**。

它每次会生成一组新的 `gpic-时间戳`（副本 + 快照 + bundle），
旧备份**不会被删**——清理请手动做，建议保留最近 3～5 份。

---

## 四、几条硬提醒

1. **`backup/` 已在 `.gitignore` 里**，不会被提交，也不会被推上 GitHub。
   但它**在项目目录内**——如果以后要打包整个项目发给别人，记得先剔除。
2. **备份里有敏感数据**（账目表、仓储清单、口令哈希）。
   不要上传网盘共享链接、不要发群、不要进任何公开仓库。
3. **bundle 不包含未提交的工作区改动**，只包含已提交的历史。
   所以备份前最好先 `git commit`，否则改动只会存在于「① 副本」里。
4. 本目录的中文文件名、`.docx`、`.xlsx` 都是原样复制，未做任何转码。

---

## 五、`[3/3]` 报「✘ 失败：」且后面一片空白

这不是仓库坏了，是**根本找不到 `git` 命令**。

命令不存在时 `spawnSync('git')` 返回的是 `status = null`、`stderr = null`，
拼出来就是空白；同时末尾会看到 `完成。HEAD =` —— 后面也是空的。
两个空格一起出现，基本就是这个原因。

这台机器上的真实成因：没装 Git for Windows，只有 WorkBuddy 自带的
PortableGit，而它不在 PATH 里。

`gpic-backup.mjs` 现在会按三级顺序自己去找 git（PortableGit 目录 → 常见安装
位置 → PATH），不用你配环境变量。真找不到时它会明确打印「跳过：找不到 git.exe」，
此时 ① 副本和 ② 库快照照样可用，只缺 git 历史。

> 2026-10-19 的 `gpic-20261019-1029` 就是这样缺了 bundle；
> 同一天修复后的 `gpic-20261019-1035` 是完整的三件套。

---

## 六、两个容易忽略的细节

1. **同一分钟内双击两次**会撞名（时间戳只到分钟）。脚本会自动删掉同名的那份
   重新生成，不会报错——但也意味着第一份被覆盖，这是有意的。
2. **`HEAD = （读取失败）`**：bundle 一般没事，多半是 git 在跑的中途被占用，
   重跑一次即可。

---

_最近一次备份：2026-10-19 10:35（HEAD `65270db`，三件套齐全，11.1 MB bundle）_
_验证记录：bundle 已实测 clone 出完整仓库；副本已实测 `node server/index.mjs` 起服务；库快照 10 表逐行与源库一致；副本内三个 `.bat` 均为 CRLF（可直接双击）。_
