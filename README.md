# 微信聊天记录工具（wxchart-tauri）

> 本机微信聊天记录的**本地查看与导出**工具：加载你自己的微信数据库 → 按会话/时间/类型筛选 →
> 浏览气泡消息 → 导出 JSON / CSV / HTML 站点（含图片与附件）。
> **纯本地运行：无网络通信、不上传任何数据、微信数据库只读访问**
> ——唯一例外见下方「快递单号提取」页的**可选**联网审核（默认关闭）。
> 版本 **0.2.1** · 平台 Windows 10/11 x64 · 协议版本见 [docs/02](docs/02-IPC协议.md)。

## 功能

- **数据加载**：自动发现本机微信数据目录（也可手动设置），选择账号后在**账号栏一键「加载数据」**
  （任何页签可用，不必先跳「数据筛选」页）加载会话与消息；
  未登录微信 / 密钥不在内存时给出明确引导（KEY_NOT_FOUND / NO_ACCOUNT）。
- **会话浏览**：左侧会话列表（搜索、全选/清空/反选），右侧气泡消息视图——
  虚拟滚动（万级消息不卡）、日期分组、引用块单击跳转、图片缩略图懒解码。
- **交互**（对齐 Tk 版手感）：鼠标拖选复制、跨气泡多选、右键菜单、日期控件、Ctrl+A。
- **数据筛选页**：按时间范围与消息类型筛选，筛选结果驱动浏览与导出。
- **导出**：独立「导出」页签——选择会话/时间/内容类型，导出 JSON、CSV、HTML 站点
  （含 `media_index` / `date_index`、图片与附件副本），支持**增量数据包**（同目录二次导出只补新消息）。
- **本地数据包**：导出数据包后可**脱离微信回读**（换机器、退出微信后继续浏览与再导出）。
- **数据层自检（doctor）**：一键检查数据目录、账号、密钥、各数据库可读性与消息计数。
- **快递单号提取**：独立页签，把微信导出 CSV 里的快递单号提取到首列（多单号拆行、增量复用）。
  **默认纯本地**（宽筛 + 规则提取，界面明示准确率有限）；**可选**开启「联网 AI 审核」
  （默认关闭、显式开启、可随时不用）——开启时界面明示**将发送的行数与去向**
  （仅「行号+类型+内容」三字段、仅宽筛命中行）；
  **服务商可选**：DeepSeek / 小米 MiMo / MiniMax 预设，或自定义 base_url + 模型名；
  API Key 按服务商**分槽**用 Windows DPAPI 加密存本机（可随时「保存 / 清除」），
  不落明文、不入库。
  **本页是全程序唯一的可选联网功能**，其余功能一律不联网。
- **设置记忆**：最近账号、数据目录、最近导出目录自动记住。
- **关于 / 帮助**：账号栏内置「关于」（版本、协议版本、构建信息、**作者与仓库地址**、隐私与许可）与
  **离线帮助页**（快速上手、常见问题、导出说明）——应用内即可查，无需联网。

## 安装与首次运行

> **下载**：GitHub **Releases** 页面 → `v0.2.1` → `WX-Chat-tools-YF_0.2.1_x64-setup.exe`
> （本地构建产物同内容、文件名为中文 `微信聊天记录工具_0.2.1_x64-setup.exe`——GitHub 会剔除资产名里的非 ASCII 字符）。

1. 运行安装包（或静默安装：`WX-Chat-tools-YF_0.2.1_x64-setup.exe /S`）。
   NSIS **currentUser 模式**——装到当前用户目录，**不需要管理员权限**；
2. 启动后**先登录微信**（解密密钥存在于微信进程内存，本工具只读取、不修改）；
3. 首次运行会自动发现微信数据目录；找不到时可在设置里手动指定；
4. 选择账号 → 账号栏「加载数据」→ 在「数据筛选」页筛选、在「导出」页导出；
   具体用法见应用内**帮助**（账号栏「帮助」按钮）。

安装目录与运行期写入目录见下文「杀软白名单」一节。

## 开发环境前提（仅开发/跑测试需要）

- **Node.js 24+ + pnpm**（`.npmrc` 已配置 npmmirror 镜像）
- **Rust stable（MSVC）+ VS Build Tools（含 C++ 工作负载）**——Tauri 壳编译
- **Python 3.10** + `pip install -r ../wxchart-tool/requirements.txt pyinstaller`——sidecar 数据层与打包
- **WebView2 运行时**：Win10/11 自带
- Playwright 浏览器：`pnpm exec playwright install chromium`（镜像已配置）
- 沙箱/低完整性环境下 WebView2 起不来时先跑 `scripts/fix-dev-integrity.ps1`
  （详见 [docs/07 §0](docs/07-施工计划清单.md) 环境铁律）

```powershell
pnpm install                 # 前端依赖
pnpm dev                     # 前端开发（vite 5173）
pwsh scripts/build-sidecar.ps1   # 冻结 sidecar（打包前）
pnpm tauri build             # 正式安装包（交付口径，不带调试端口）
```

## 测试口径

一键门禁（打包前必跑，**全绿才打包**）：

```powershell
pwsh scripts/verify.ps1
```

**基线 323 项全绿** = sidecar 契约 **40** + Tk 行为规格 **91** + Vitest **144** + Playwright **48**
（含 typecheck 0 错；口径演进见 [CHANGELOG](CHANGELOG.md) 与 [docs/04](docs/04-测试迁移与验收清单.md)）。

- 契约与 Tk 基线：`sidecar/tests/test_contract.py` + `../wxchart-tool/tests/`（**只读行为规格来源**）；
- 前端单测：`pnpm test`（Vitest，`tests/`）；端到端：`pnpm test:e2e`（Playwright，`e2e/`，
  产物固定落 `test-results/e2e/`）；
- 真机脚本：`scripts/*-real-check.mjs` / `install-smoke.mjs` 等，需本机装微信并登录；
- 验收清单与逐条去向：[docs/04-测试迁移与验收清单.md](docs/04-测试迁移与验收清单.md)。

## 与 Tk 版（wxchart-tool）的关系

| | `wxchart-tool`（Tk 版） | 本项目（Tauri 原生版） |
|---|---|---|
| 界面 | tkinter + Canvas 自绘 | HTML/CSS/JS（WebView2） |
| 运行时 | 需要本机 Python | 单安装包（数据层为内置冻结 sidecar） |
| 数据层 | `src/wxchart` 同一份实现 | 直接复用（sidecar 调用），远期按 [docs/01](docs/01-总体架构与路线.md) 迁 Rust |
| 角色 | **行为规格来源**（91 项测试） | 本仓库 = 主产品 |

两版共享数据契约（消息字段、JSON/CSV 导出格式、quote 结构）。
**本仓库只含 Tauri 版**；Tk 版是独立的只读基线，不在本仓库内。

## 文档索引

- [CHANGELOG.md](CHANGELOG.md) — 版本变更与已知限制
- [docs/01-总体架构与路线.md](docs/01-总体架构与路线.md) — 架构总览、选型理由、决策、风险
- [docs/02-IPC协议.md](docs/02-IPC协议.md) — 命令/事件/错误码/版本的完整规格
- [docs/03-数据层sidecar方案.md](docs/03-数据层sidecar方案.md) — 进程模型、传输、打包、迁移
- [docs/04-测试迁移与验收清单.md](docs/04-测试迁移与验收清单.md) — 91 项测试逐条去向与验收标准
- [docs/05-开发日志.md](docs/05-开发日志.md) — 按里程碑的进度、决策与遗留
- [docs/06-本地数据方案.md](docs/06-本地数据方案.md) — 本地数据包：导出与回读方案
- [docs/07-施工计划清单.md](docs/07-施工计划清单.md) — Backlog：现状/实现路径/验收/预估

## 已知限制

- **语音消息只能看到气泡与文件，不能播放、不能转文字**：微信语音原文为 SILK_V3 格式，
  WebView2 与本仓库均无解码器（Tk 版同样没有，属长期缺口，非本次回归）；转码/转写待排期。
- **框选起点必须在气泡上**：行内头像/头部/行间隙不作为拖选起点——与 Tk 版 `_bubble_msg_at`
  口径逐字一致（按设计，不是缺陷）。
- **无检查更新、无网络请求**：版本升级需手动下载安装包。
  （唯一例外：「快递单号提取」页的可选联网审核，默认关闭、显式开启。）
- 数据层当前为 **Python 冻结 sidecar**（PyInstaller onedir）；去 Python（M-A5）为可选远期项，未排期。
- 打开导出的 HTML 站点/图片/语音时使用系统默认程序；语音 `.silk` 文件无关联程序时无法播放。

## 许可与隐私

- **License：[LICENSE](LICENSE) — PolyForm Noncommercial License 1.0.0（非商用）**
  - `Required Notice: Copyright 2026 firstddf (https://github.com/firstddf/WX-Chat-tools-YF)`
  - 即：可以学习、研究、个人非商业使用；**商业使用需另行授权**。
- **隐私**：除「快递单号提取」页**可选的**联网 AI 审核（默认关闭、显式开启、可随时不用）外，
  程序**不联网**、不上传数据；微信数据库**只读**访问；
  所有个人数据（账号、消息、图片、导出包、`settings.json`）只落在你本机的用户目录，
  **不在本仓库内**；仓库内的测试夹具全部为占位符（`wxid_xxxxxxxx_1111` 等）。

## 安装与杀软白名单（docs/07 #7）

**安装目录**（NSIS currentUser 模式，无需管理员）：

```text
%LOCALAPPDATA%\微信聊天记录工具\
  ├─ wxchart-tauri.exe        主程序（窗口 + 命令路由 + sidecar 生命周期）
  ├─ wxchart-data.exe         数据层 sidecar（PyInstaller onedir，非单文件 exe）
  ├─ _internal\               sidecar 运行时（约 450 文件）
  └─ uninstall.exe            卸载
```

**运行期写入目录**（杀软白名单/排除项应覆盖的全部位置）：

```text
%LOCALAPPDATA%\com.wxchart.app\
  ├─ EBWebView\               WebView2 用户数据（浏览器内核 profile）
  ├─ media\                   图片解码缓存（sidecar work_dir，只增不删）
  └─ logs\                    运行日志（release 落 $APPLOG，安装目录不可写）
%APPDATA%\com.wxchart.app\settings.json   应用设置（最近账号/数据目录，单文件）
%APPDATA%\com.wxchart.app\tracking.key           快递单号提取的 API Key（DPAPI 加密，MiMo 槽）
%APPDATA%\com.wxchart.app\tracking_<服务商>.key   其余服务商槽（deepseek/minimax/custom，同加密）
```

- 程序目录**只读**（除卸载外不写入）；所有可写数据都在上面两个 `%LOCALAPPDATA%`/
  `%APPDATA%` 目录——**排除这两处即可消除全部写入告警**；
- 微信数据目录（如 `D:\微信数据\xwechat_files`，用户自定义）**只读访问**，程序从不写入。

**误报说明与提交指引**：

- 本程序默认**无网络通信**、无注入、无自启动（唯一例外：「快递单号提取」页可选联网审核，
  默认关闭）；sidecar 为 PyInstaller **onedir** 布局
  （非 onefile 单文件——R2 对策，已显著减小杀软启发式误报面）；
- 若仍被误报：向杀软厂商提交**误报申诉**，附安装目录与 `wxchart-data.exe` 路径
  （如 `%LOCALAPPDATA%\微信聊天记录工具\`），并说明其为本地数据解密组件、
  行为=读本机数据库文件解密到本机缓存目录；
- **代码签名**可根治 SmartScreen/杀软信誉问题，但需采购代码签名证书（单列决策，未纳入排期）。
