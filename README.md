# wxchart-tauri · Phase 2A 立项（Tauri 原生版）

> 目标：把 wxchart-tool 的界面与运行时升级为**原生 exe（无 Python 运行时）**——
> Tauri 2（Rust 壳）+ WebView2 前端，数据层先以 sidecar 复用现有 Python 实现，
> 再按契约逐步迁移到 Rust，最终彻底去 Python。

## 与现有 Tk 版的关系

| | `wxchart-tool`（Tk 版） | `wxchart-tauri`（本项目，Phase 2A） |
|---|---|---|
| 状态 | **单独保留**，继续可用、继续修 bug | **M-A2/M-A3 已收口，M-A4 打包主体完成**（2026-11-07）：图片缩略图懒解码真机热冷双验；NSIS 安装包产出（14.72MiB）+ 本机安装冒烟 + 冻结包导出链路实测全过；测试 **268 项全绿**（契约 23 + Tk 91 + Vitest 122 + Playwright 32）。余干净虚机冒烟/UI 级导出真机/杀软白名单（见 [docs/05](docs/05-开发日志.md) 遗留） |
| 界面 | tkinter + Canvas 自绘 | HTML/CSS/JS（WebView2 合成器渲染） |
| 运行时 | 需要本机 Python | 单安装包，最终无 Python |
| 数据层 | `src/wxchart` 同一份实现 | **直接复用**（sidecar 调用），后迁 Rust |
| 关系 | 事实上的行为规格来源 | 按 `docs/04` 的 91 项验收清单对齐行为 |

两版**共享数据契约**（消息字段、JSON/CSV 导出格式、quote 结构），
`wxchart-tool` 的 `tests/` 是行为规格的可执行来源，迁移期间不删除、不挪动。

## 环境前提（本机 2026-11-06 盘点 · M-A1 已落实）

- ✅ Node.js + pnpm 已安装（`D:\nodejs\...`）
- ✅ **Rust 工具链已装**（M-A1）：rustup stable-x86_64-pc-windows-msvc，cargo/rustc 1.99.1。
  rustup 走 USTC 镜像（实测官方 CDN 仅 0.29 MB/s，镜像约 2 MB/s）：
  - `RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static`
  - `RUSTUP_UPDATE_ROOT=https://mirrors.ustc.edu.cn/rust-static/rustup`
- ✅ **C++ 工具链：复用本机已有 VS 2026 Build Tools**（M-A1 方案决策，不另装 2022：
  省 4–6 GB 下载/约 40 分钟）—— MSVC 14.50.35717（`cl.exe`/`link.exe`）+
  Windows SDK 10.0.26100.0，rustc/Tauri 经 vswhere 自动检测。换机器时装
  **VS Build Tools 2022 + C++ 工作负载**即可（MSVC 版本不敏感）
- ✅ WebView2 运行时：Win10/11 自带（安装器会检测，缺失时引导下载 Evergreen 引导器）
  - ⚠️ **本机开发注意（2026-11-07 结案）**：本工作区被 DSH 文件沙箱打了 Low 完整性标签，
    cargo 产出的 exe 继承 Low IL，WebView2 会拒绝初始化（`failed to create webview` /
    窗口挂起）。遇到就跑 `scripts\fix-dev-integrity.ps1`（把 `src-tauri\target` 树 IL 改回 Medium），
    原因与证据见 [docs/05](docs/05-开发日志.md)
- ✅ Python 3.10.11 + 依赖（pycryptodome/zstandard/Pillow）已就绪 —— sidecar 打包用
- ✅ **依赖源全走国内镜像**（M-A2，2026-11-06 实测：npm 官方 0.36 vs 镜像 4.15 MB/s；
  crates 0.04 vs rsproxy 0.15；Playwright 0.89 vs 1.9）：
  - npm → npmmirror（工程级 `.npmrc`，只影响本项目）
  - cargo → rsproxy（`src-tauri/.cargo/config.toml`，S5 脚手架时落盘）
  - Playwright 浏览器 → `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`

## 目录规划（代码动工后的计划结构）

```
wxchart-tauri/
├── README.md                  ← 本文件
├── docs/
│   ├── 01-总体架构与路线.md
│   ├── 02-IPC协议.md          ← 前端 ↔ Tauri ↔ sidecar 三层协议
│   ├── 03-数据层sidecar方案.md
│   └── 04-测试迁移与验收清单.md ← 91 项测试的逐条去向
├── src/                       ← Vue 3 + TS + Vite 前端
│   ├── ipc/                   ← IPC 适配层（tauri 实现 / 浏览器 mock 双轨，测试用）
│   ├── components/            ← 气泡列表、虚拟滚动、引用块、多选、筛选面板
│   └── styles/                ← 由 exporter.py 的气泡 CSS 移植
├── src-tauri/                 ← Rust 壳（窗口、命令路由、sidecar 生命周期）
├── sidecar/                   ← Python 数据层启动器（复用 ../wxchart-tool/src/wxchart）
│   └── tests/test_contract.py ← 通道③契约测试（M-A1，直跑风格：python 即可）
├── scripts/
│   ├── verify.ps1             ← 验收脚本：契约 14 + Tk 全量 91 + typecheck + Vitest + Playwright（打包前必跑）
│   ├── acceptance-real.mjs    ← 真机验收：CDP 驱动真实壳（账号/加载/筛选/虚拟滚动/管理页）
│   ├── shell-interaction-check.mjs ← 真机交互：真鼠标拖选/复制/右键菜单/多选
│   └── fix-dev-integrity.ps1  ← 开发期修复：target 树完整性级别改回 Medium（WebView2 起不来时）
└── tests/                     ← 前端测试（Vitest + Playwright），对照 docs/04
```

> 代码目录为计划结构；M-A1 已落地 `sidecar/` 与 `scripts/`，前端 `src/` 与
> `src-tauri/` 仍待 M-A2 动工（动工顺序见路线图 M-A1）。

## 路线图（详见 docs/01）

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M-A1 契约冻结** | 评审并冻结 `docs/02/03` 协议；装 Rust 工具链；sidecar 骨架（stdio NDJSON + `ping/scan_accounts/load_source/export/stop`；**无 `query` 方法**——筛选在前端，见 docs/01 D2） | 契约测试 `sidecar/tests/test_contract.py` 跑通 `ping/load_source/export` + 错误码映射；协议文档标注 version=1 |
| **M-A2 可看**（✅ 2026-11-07 收口） | 前端壳：窗口、会话列表、**虚拟滚动消息列表**、筛选面板、气泡样式（移植 exporter CSS）、账号选择 | ✅ 真机验收：真实 WebView2 + 真实微信库（1 万+ / 3 万+ 条两个账号样本），虚拟滚动/筛选/全选/管理页 + 真鼠标拖选/复制/右键菜单全过；`verify.ps1` 191 项全绿 |
| **M-A3 可用（对齐微信）**（✅ 已收口 2026-11-07） | 文字拖选复制、引用块跳转、多选（跨气泡拖选/右键/勾选框）、右键菜单、日期控件、图片缩略图 | 拖选/多选/右键菜单/日期控件/引用跳转+回跳/图片缩略图全部过（A1 #9 懒解码真机热冷双验 10/10）；目标 `docs/04` ≥90% |
| **M-A4 可交付**（🚧 主体完成 2026-11-07） | 导出 JSON/CSV 打通、保存对话框、Tauri 打包（bundle 内含 sidecar） | ✅ NSIS 安装包产出（14.72MiB）+ 本机静默安装冒烟（握手/账号/加载/图片 scope/优雅退出）+ 冻结包导出链路实测（CSV 含解码路径）全过；**余**：干净虚机全链路、UI 级导出真机、杀软白名单 |
| **M-A5 去 Python（可选）** | 热路径 Rust 化（解密/解析/筛选），sidecar 退场 | 同一契约测试对 Rust 实现全绿；包体内无 Python |

## 文档索引

- [docs/01-总体架构与路线.md](docs/01-总体架构与路线.md) — 架构总览、选型理由、决策、风险
- [docs/02-IPC协议.md](docs/02-IPC协议.md) — 命令/事件/错误码/版本的完整规格
- [docs/03-数据层sidecar方案.md](docs/03-数据层sidecar方案.md) — 进程模型、传输、打包、迁移
- [docs/04-测试迁移与验收清单.md](docs/04-测试迁移与验收清单.md) — 91 项测试逐条去向与验收标准
- [docs/05-开发日志.md](docs/05-开发日志.md) — Phase 2A 按里程碑的进度、决策与遗留（M-A2 起）
- [docs/06-本地数据方案.md](docs/06-本地数据方案.md) — 本地数据（脱离微信可用）清单方案：数据包导出 + 导出目录回读
- [docs/07-施工计划清单.md](docs/07-施工计划清单.md) — **待实现功能 Backlog**：现状/实现路径/验收/预估，下次开工按此施工
