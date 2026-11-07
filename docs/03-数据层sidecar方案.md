# 03 · 数据层 sidecar 方案（Phase 2A）

> 原则：**一份数据代码，两个宿主**。sidecar 是对 `wxchart-tool/src/wxchart` 的薄封装
> （不复制、不改写 Tk 仓库——它单独保留），把已验证的数据层包成 [02-IPC协议](02-IPC协议.md)
> 的通道③。M-A5 换 Rust 实现时，只换宿主、不换契约。

## 1. 组成与代码关系

```
wxchart-tauri/
└── sidecar/
    ├── launcher.py          ← 入口：stdin/stdout NDJSON 循环 + 方法分发（薄）
    ├── mapping.py           ← 异常→错误码、对象→协议 JSON（含 Message/ExportRecord 组装）
    ├── wxchart_data.spec    ← PyInstaller 打包描述（hiddenimports 指向 Tk 仓库源码）
    ├── .cache/              ← store 解密缓存（默认；可用 WXCHART_SIDECAR_WORK_DIR 覆盖，
    │                          不写 Tk 仓库——保持只读引用）
    └── tests/
        └── test_contract.py ← 通道③契约测试（直跑：python sidecar/tests/test_contract.py）

依赖方向：launcher.py  ──import──►  ../wxchart-tool/src/wxchart/   （只读引用）
```

- **单一事实源**：数据层的 bug 修复只发生在 `wxchart-tool`，sidecar 自动受益；
  Tk 仓库的 91 项测试同时守护 sidecar 底层（`docs/04` B 类 31 项直接是契约测试）。
- `wxchart-tool` **不因 2A 改动一行**；若将来 Tk 仓库归档，把 `src/wxchart` 平移到
  共享位置即可（一次性路径调整，不属于本阶段）。

## 2. 传输选型

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **stdin/stdout NDJSON**（选定） | 零端口、零防火墙/杀软噪音、天然私有（只有父进程能读写）、易转发日志 | 调试要经壳转发（见 `--http`） | ✅ 主通道 |
| HTTP `127.0.0.1:<随机口>+token` | curl 直接调、生态工具多 | 端口占用/冲突、本机防火墙弹窗、token 泄漏面、AV 对监听端口敏感 | 作为**调试备选**：`launcher.py --http 0` 打印随机口，仅开发期用 |
| Windows named pipe | 私有、支持重叠 IO | 实现与调试都比 stdio 麻烦 | ❌ 无收益 |
| 复用 Tk 的直接 import（同进程） | 无 IPC | 把 Python 拉进壳进程 = 没去 Python | ❌ 违背目标 |

NDJSON framing 的安全性：JSON 字符串内的换行一律转义为 `\n`，行分隔不会截断数据；
单帧上限 64MB（防御性），超限回 `BAD_FRAME`。

## 3. 进程生命周期

```
壳启动 ─► spawn sidecar（pipes, 不开新控制台窗口）
      ─► 5s 内 ping → 协议主版本校验 → status:ready（event sidecar://status）
         （2026-11-06 实测 Python 冷启 2.0–2.3s，2s 会踩线，故握手窗口定为 5s）
运行中 ─► 请求串行处理（单线程循环；progress 通知可穿插在响应之间）
      ─► 崩溃：自动重启 1 次（退避 500ms）；再失败 → status:failed，前端降级横幅
      ─► 调用超时（load 300s / export 900s / resolve_media 60s / 其它 10s）→ SIDECAR_TIMEOUT
         ⚠️ 2026-11-07 实测：大账号 400+ 会话 / 3 万+ 条，60s 不够（会在读完会话后
         被判超时）→ load 由 60s 放宽到 300s；前端已有 `data://progress` 进度可看，
         超时只作为兜底，不用于限制正常大账号加载
      ⚠️ 2026-11-07 二轮：图片改**懒解码**（加载期只定位不解码）→ 新增通道③/①
         `resolve_media` 按需解码可见缩略图（60s/批，前端每批 ≤32 条，进同一把互斥锁）；
         `export` 写出前为导出子集补齐未解码图片（冷缓存全量 ≈6.9min）→ export 300s→900s，
         期间发 progress 通知
退出   ─► invoke stop → 等 stdin EOF/2s → 仍活着则 kill（防僵尸）
```

- **互斥**：`load_source` 与 `export` 不并发（Python 侧加锁，`resolve_media` 用同一把锁；冲突回 `EXPORTING_BUSY`），
  与 Tk 版"正在导出不能加载"的语义一致。
- **日志**：sidecar stderr = 结构化前缀行（`[level] message`），壳收集进日志面板并落
  `sidecar.log`（滚动 5MB×3；**dev 落 `src-tauri/logs/`、release 落 `$APPLOG`**
  = `%LOCALAPPDATA%\com.wxchart.app\logs\`——编译期源码路径在干净机器上不存在，
  见 §4.3）；stdout 只允许协议帧。
- **开发模式**：`WXCHART_SIDECAR_CMD` 环境变量可覆盖启动命令为
  `python sidecar/launcher.py`（免每次 PyInstaller 重打）；`pnpm tauri dev` 默认走它。
- **环境变量钩子**（M-A1 新增，均可选）：
  - `WXCHART_XWECHAT_ROOT`：覆盖账号发现根目录（默认 `config.DEFAULT_XWECHAT_ROOT`；
    测试指向空目录即稳定复现 `NO_ACCOUNT`）；
  - `WXCHART_SIDECAR_WORK_DIR`：store 解密缓存目录（默认 `sidecar/.cache`，不写 Tk 仓库；
    **release 下壳会自动注入每用户目录** `%LOCALAPPDATA%\com.wxchart.app\media`，
    用户显式设置时以用户值为准——见 §4.3）；
  - `WXCHART_SIDECAR_MAX_FRAME`：单帧字节上限（默认 64MB，测试可调小验证 `BAD_FRAME`）。
- **手工调试**：`python sidecar/launcher.py` 后逐行输入 JSON（一行一个请求）即可对话；
  响应在 stdout、日志在 stderr。

## 4. 打包（PyInstaller → Tauri externalBin）

> **打包时点（验收节奏约定，2026-11-06）**：先完成各项功能检测，最后统一打包一次
> 验证——不做「打包一次测一次」的增量循环。打包验证集中在 M-A4 收尾一次性完成，
> 打包前必须 `scripts/verify.ps1` 全绿（契约测试 + Tk 全量 91 项）。
> **M-A4 实测（2026-11-07）**：打包前 verify 全绿 268 项；收尾再跑一次同样全绿。

### 4.1 一键打包（全部已落地，可重复执行）

```text
# 1) sidecar（wxchart-tauri 下执行；幂等，约 35s）
Set-ExecutionPolicy -Scope Process Bypass -Force
& scripts/build-sidecar.ps1
#   = python -m PyInstaller --noconfirm sidecar/wxchart_data.spec
#     → sidecar/dist/wxchart-data/{wxchart-data.exe, _internal/}
#     → exe 重命名为 wxchart-data-x86_64-pc-windows-msvc.exe（externalBin 平台后缀）
#     → 落 src-tauri/binaries/{wxchart-data-x86_64-pc-windows-msvc.exe, _internal/}
#     → icacls 把该树设为 Medium IL（见 4.5 坑 3）
# 实测产物：exe 4.3MB + _internal 28.3MB ≈ 32.6MB（原预估 25–35MB 内）

# 2) 产物独立冒烟（不经壳；cwd 故意选在 exe 外 = 证无源码树/工作目录依赖）
python scripts/sidecar-product-smoke.py src-tauri/binaries/wxchart-data-x86_64-pc-windows-msvc.exe --load

# 3) Tauri 打包（tauri.conf.json 已含 bundle.active=true / targets ["nsis"] /
#    externalBin / resources；首次构建会从 GitHub 下载 NSIS 工具到
#    %LOCALAPPDATA%\tauri\NSIS，仅首次需要联网）
pnpm tauri build
#   → src-tauri/target/release/bundle/nsis/微信聊天记录工具_0.1.0_x64-setup.exe（14.72 MiB）

# 4) 静默安装 + 安装版冒烟（记录见 4.4）
& "<上一步的 setup.exe>" /S          # NSIS 静默安装
#   安装目录：%LOCALAPPDATA%\微信聊天记录工具（NSIS currentUser 模式默认，无管理员）
```

### 4.2 externalBin 落盘布局（查证结论，2026-11-07：源码 + 装机实证双确认）

| 阶段 | 位置 | 文件名 | 依据（本地源码逐行核对） |
|---|---|---|---|
| 源文件（构建输入） | `src-tauri/binaries/` | `wxchart-data-x86_64-pc-windows-msvc.exe`（**带**三元组 + .exe） | tauri-utils `resources.rs::external_binaries()`：`{path}-{target}{.exe}` |
| 构建期拷贝 | `src-tauri/target/<profile>/` | `wxchart-data.exe`（**剥掉**三元组）+ 同期 `_internal/` | tauri-build `copy_binaries()`：`file_name().replace("-{target_triple}","")`；resources 同步拷到同目录 |
| NSIS 安装后 | `$INSTDIR\`（主 exe 同目录） | `wxchart-data.exe`（剥三元组）+ `_internal\` | tauri-bundler `nsis/mod.rs::generate_binaries_data` + `installer.nsi`（`SetOutPath $INSTDIR` 后 `File /oname=`） |
| 运行时定位 | `current_exe().parent()` | 同上 | tauri-utils `platform.rs::resource_dir`：**Windows 下 = exe 所在目录**（`$RESOURCE` 同此） |

**装机实证**：`%LOCALAPPDATA%\微信聊天记录工具\` = {`wxchart-tauri.exe` 9.74MB（主 exe 名取
cargo **package 名**，非中文 productName）、`wxchart-data.exe` 4.27MB、`_internal\` 457 文件、
`uninstall.exe`} —— 与上表逐项一致。

**关键点：`_internal` 必须另走 `bundle.resources`**——externalBin 只拷单文件，而
PyInstaller 6 onedir 的 exe 依赖同级 `_internal/`（bootloader 按 exe 自身目录找）。
用 map 形式 `"resources": {"binaries/_internal": "_internal"}`：map 的目录 Walk 目标
**保留目录结构**（array 形式会按 `resource_relpath` 落到 `binaries/_internal/` 下，位置不对）。
同一份 resources 构建期也拷进 `target/<profile>/`，所以直接跑 target 下的 release exe 同样成立。
⚠️ tauri-build 构建期会校验 externalBin 源文件与 resources 目录**存在**——所以
`cargo check`/`tauri build` 必须在 `build-sidecar.ps1` 跑过之后（顺序即 4.1）。

### 4.3 release 启动分支与缓存目录/scope（sidecar.rs）

`resolve_start_cmd()` 优先级：
1. `WXCHART_SIDECAR_CMD`（环境变量覆盖，保留）；
2. **release**（`!cfg!(debug_assertions)`）：`find_bundled_sidecar()` = `current_exe()` 同目录的
   `wxchart-data.exe`，**且要求同级 `_internal/` 存在**（候选另含三元组原名与 `binaries/`
   子目录两种手工布局）；
3. dev 默认：`python <CARGO_MANIFEST_DIR>/../sidecar/launcher.py`（编译期路径，仅开发机有效）。
   dev 构建里 `target/debug/` 也拷了随包 exe，但第 3 步优先——改 sidecar 不用重打 PyInstaller
   （§3 约定不变）。

解码缓存（work_dir）与 asset scope：

- **dev**：不变，launcher 默认 `sidecar/.cache`；scope 用机器绝对路径条目（换机器需同步——
  **两条 scope 条目并存**）。
- **release**：spawn 时注入 `WXCHART_SIDECAR_WORK_DIR=%LOCALAPPDATA%\com.wxchart.app\media`
  （= `$APPLOCALDATA/media`，用 `app.path().app_local_data_dir()` 计算；用户已显式设置该
  变量时不覆盖）。避免 launcher 的 `_HERE/.cache` 落进安装目录（只读/会被清）。启动日志带
  `work_dir=...`。
- **asset scope 新增 `$APPLOCALDATA/media/**`**：Tauri v2 对 scope 逐条走 `path().parse()`
  （tauri `src/path/mod.rs`），支持 `$LOCALDATA/$APPDATA/$APPLOCALDATA/$APPLOG/...` 变量，
  **变量必须是路径首段**（如 `$APPLOCALDATA/media/**`）。装机实证：缩略图
  `http://asset.localhost/...com.wxchart.app%5Cmedia%5Cdecoded%5C...` 正常解码显示。
- `open_path` 的 PathScope **不受此影响**（两套独立机制）：它走运行期维护的
  「附件精确路径 + 导出目录前缀」白名单（`register_media_from*`）。探针实证：
  scope 内解码图片 `invoke('open_path')` → `{ok:true}`，scope 外
  `C:\Windows\notepad.exe` → `PATH_NOT_ALLOWED`（`scripts/open-path-probe.mjs`）。
- release 日志同样离开编译期路径：`SidecarLog` dev 落 `src-tauri/logs/`，**release 落
  `$APPLOG`**（Windows = `%LOCALAPPDATA%\com.wxchart.app\logs\sidecar.log`）。

### 4.4 M-A4 打包验证记录（2026-11-07）

- 构建：`pnpm tauri build` → `微信聊天记录工具_0.1.0_x64-setup.exe` **14.72 MiB**；
  静默安装 `/S` → `%LOCALAPPDATA%\微信聊天记录工具`（exit 0）。
- 产物独立冒烟（`scripts/sidecar-product-smoke.py --load`）：ping `protocol_version=1`、
  scan_accounts **4 真账号**、`load_source` 真解密 **1 万+ 条 / 50+ 会话**、stop 干净退出 0。
- 安装版冒烟（CDP 9223，`scripts/install-smoke.mjs`）**7/7**：`app_info.sidecar.state=ready`
  （= 无降级横幅）、协议 1=1、账号栏 4 账号（「发现 4 个账号 · 已选账号：wxid_xxxxxxxx_3333」）、
  点加载 **「共 3 万+ 条消息 · 200+ 个会话 · 约 3 个月 · 匹配 3 万+ 条」29.6s**、console 0 错。
- 图片/asset scope（`scripts/shell-media-check.mjs --port 9223`）**9/10**：加载 3 万+ 条
  **45.8s**（<120s 懒解码阈值）、缩略图真实解码（naturalWidth>0、src 指向
  `$APPLOCALDATA/media/decoded/...`）、CSS 102x220、console 0 错。唯一 FAIL 是「点击打开」
  的**新进程 diff 检测**（0 个新进程）——`open_path` 探针已证 scope 放行 `{ok:true}`、负例
  拒绝；lead 修正探测时序（点击前清场 + 10s 轮询）后复跑 **10/10**，点击打开原图新进程实证 ✓
  → 确认是检测方法局限，非 scope 缺陷。
- **干净重建（正式交付包，不带 CDP overlay）**：`pnpm tauri build` 2m55s → 同路径
  `微信聊天记录工具_0.1.0_x64-setup.exe` **14.72 MiB**；`/S` 重装 exit 0 → 最小验证全过：
  `sidecar.log` `握手成功: state=ready protocol_version=1`、`work_dir=...\com.wxchart.app\media`
  注入正确、`$INSTDIR\.cache` 不存在、关闭时 `收到 stop → sidecar 已退出 exit code: 0`。
  （交付包 = 此次重建产物；CDP 冒烟用的是同源码仅多一个 browser 参数的 `-c` 临时包。）
- **CDP 环境变量对照实验（定性 docs/05「dev 9222 之谜」，2026-11-07 下午）**：

  | 场景 | 进程 IL | env 注入方式 | 结果 |
  |---|---|---|---|
  | dev exe `target/debug`（fix-dev-integrity 打过 Medium 标签） | Medium | shell `$env:` | ✅ **9222 监听**，浏览器命令行含 `--remote-debugging-port=9222` |
  | release `target/release` ×2 | Medium | shell `$env:` | ✅ 9224 / 9228 监听 |
  | 安装版 exe（NSIS 装出的文件**无标签**→ 从提权 shell 启动 = High）×3 | High | PSI / shell / cmd 三种注入 | ❌ 端口不监听、浏览器主进程命令行无该参数 |
  | 同一份安装版文件复制到 `<测试目录>`、`E:\<测试目录>2` | High | shell `$env:` | ❌ ×2（排除路径/盘符因素） |
  | **同一安装版 exe `icacls` 打 Medium 标签后重启（因果实验）** | Medium | shell `$env:` | ✅ **9232 监听** |

  PEB 读取实证：High 失败样本的进程环境里**确实存在**
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9226`（变量在场，只是未被采用）。
  → **结论：env 路线的可用性取决于进程完整性级别——Medium 生效（5/5）、High 被忽略（5/5），
  且有 1 例标签翻转的因果验证**；docs/05「dev 9222 曾生效」与此完全自洽（dev exe 是 Medium
  标签）。机理（WebView2 Core 对提权进程忽略 env 附加参数，疑为本地提权面防护）未见源码级确认。
  → M-A4 冒烟的 CDP 走 **config `additionalBrowserArgs`**（`-c` overlay，任意 IL 生效），
  交付包不带端口。
- verify：打包前、收尾各一次 **ALL GREEN 268 项**（契约 23 + Tk 91 + typecheck +
  Vitest 122 + Playwright 32）。

### 4.5 已知坑（本轮实测，按发生顺序）

1. **`--collect-all pycryptodome` 是空操作**：pycryptodome 的可导入包名是 `Crypto`
   （实测 0 项 + 3 条 not-a-package 警告）→ spec 里 `collect_all("Crypto", ...)`，
   并滤掉 `Crypto.SelfTest` 测试向量（数百文件）。
2. **原命令 `--paths ../wxchart-tool/src` 少一层**：`sidecar/` 在 `wxchart-tauri/` 下，
   数据层是 `../../wxchart-tool/src`（与 launcher.py 的 `parent.parent` 同口径）；
   spec 用 `SPECPATH` 推导，任意 cwd 可重复执行。
3. **Low IL（工作区标签）**：DSH 沙箱给工作区打 Low Mandatory Level → 打包 exe 继承
   Low IL → `find_pids(Weixin.exe)` 返回空 → `KEY_NOT_FOUND「Weixin.exe 未运行」`
   （微信其实在跑 15 进程）。A/B：同 exe 放 `%TEMP%` 立即正常、原地失败。
   `build-sidecar.ps1` 已固化 `icacls /setintegritylevel (OI)(CI)Medium`
   （fix-dev-integrity 同款）；**安装版不受影响**（安装目录 Medium）。
4. **`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 只在 Medium IL 进程下生效**：wry 0.57.1
   `webview2/mod.rs:308/341` **无条件**设 API `AdditionalBrowserArguments`（没配就是默认串
   `--disable-features=... --autoplay-policy=...`），WebView2 会把 env 变量**追加**在 API 参数
   之后（dev 实测两者同框）——但**提权（High IL）进程下该 env 变量被忽略**：5/5 失败（PEB 实证
   变量确在进程环境里，浏览器命令行就是没有），给 exe 打 Medium 标签后同一安装版立即生效
   （1/1 因果翻转，完整矩阵见 4.4）。NSIS 装出的 exe **默认无标签** → 从提权 shell 启动即
   High；用户从 Explorer（Medium）启动则 Medium。**开 CDP 的稳妥路**：config
   `additionalBrowserArgs`（`pnpm tauri build -c <overlay>`），任意 IL 生效——M-A4 冒烟即此。
5. **HEVC 原图还原依赖本机 ffmpeg**（`media.py` `shutil.which("ffmpeg")` 或
   `D:\ffmpeg`/`C:\ffmpeg`）：缺失自动回退 `_t` 缩略图（不阻断），干净机不保证原图清晰度。
6. **`test-results/` 会被 verify 的 Playwright 清空**：playwright.config 未设 `outputDir`
   → 默认 `./test-results`，每次 `pnpm test:e2e` 整目录清（实测：verify 期间写入
   `test-results/m-a4/` 的文件 5–6 秒即被删，verify 结束后存活；前几轮真机截图
   `test-results/real-acceptance/` 大概率同因丢失）。已修：`outputDir: 'test-results/e2e'`。
   记录/截图落 `test-results/` 时避开 verify 并发窗口。
7. **`.ps1` 必须 ASCII-only**：PS5.1 按 ANSI 读无 BOM 文件，中文注释会把脚本读挂
   （verify.ps1 同款约定；build-sidecar.ps1 首版踩过）。

### 4.6 打包要点（沿用原决策）

- **`--onedir` 不用 onefile**：onefile 每次启动解压到临时目录（慢 1–3s、易触发 AV 误报）；
  onedir 整目录随 Tauri 安装包分发，壳用绝对路径 spawn（`find_bundled_sidecar()`）。
- **剔除 tkinter**：数据层不用 GUI，剔掉可省 ~15MB（`wxchart.gui_chatview` 的 PIL.ImageTk
  不可达，spec 一并 exclude）——这是 sidecar 与 Tk 版打包的差异点。
- 体积实测：Python 运行时 + pycryptodome + zstandard + Pillow ≈ **32.6MB**（onedir）；
  安装包 **14.72 MiB**（LZMA 压缩后，低于原预估 40–55MB）。
- 启动预估：Python 冷启动 2.0–2.3s（2026-11-06 实测）→ 启动遮蔽策略不变：用"先出窗口 +
  ready 后切换"遮蔽（R3 对策）。
- 杀软误报对策：优先代码签名（可选）、安装说明附白名单、避免 onefile、固定构建哈希。

## 5. 安全

1. sidecar **不监听任何网络端口**（主通道 stdio；`--http` 仅开发期显式开启）；
2. 所有路径参数经壳侧 scope 校验：只允许 **输出目录内**与**已解析附件**路径
   （`PATH_NOT_ALLOWED`），防前端被注入后读任意文件；
3. `export` 的 `out_path` 必须是前端经 Tauri 保存对话框取得的用户显式选择；
4. sidecar 不回传原始数据库内容以外的系统信息；`doctor` 输出不含密钥值。

## 6. 与 91 项测试的关系

- **B 类 31 项（guidata 23 + exporter 8）原封不动**作为 sidecar 底层契约：
  `load_from_store/export_dir`、FilterSpec 筛选、JSON/CSV 写出（防公式注入、BOM、截断）。
- 通道③ 新增**薄封装自身的测试**（launcher 分发、错误码映射、NDJSON framing、
  进度通知透传）——M-A1 交付物之一，目标：mock 数据上 `ping/load/export` 全绿；
  载体 `sidecar/tests/test_contract.py`（与 Tk 仓同款直跑风格、零新增依赖、兼容
  pytest；mock = 自造 `.wxchart-state.json` 导出夹具，不接触真实聊天数据）。
- 契约同源：`FilterSpec`、`Message`、`ExportRecord`、错误码在
  [02-IPC协议](02-IPC协议.md) 定义一次，Python 断言与 TS 类型（`src/ipc/types.ts`）双向核对
  （M-A1 用类型生成或人工对照表锁死）。

## 7. M-A5 迁移计划（预留，不排期）

1. **契约双跑**：为 Rust 实现写同一套契约测试（对 mock fixtures 断言），与 Python 版并行绿；
2. **替换顺序**（风险从低到高）：`write_json/write_csv` → `filter/messages` →
   `model 解析（appmsg/quote/zstd）` → `sqlcipher 逐页解密` → `keys 密钥提取`（依赖真机，最后）；
3. 每替换一个模块，壳内开关切换宿主（`WXCHART_DATA_BACKEND=python|rust`），灰度验证；
4. 全模块 Rust 化 + 真机回归后，PyInstaller 与 `wxchart-data` 退场 → **无 Python 的最终形态**。
