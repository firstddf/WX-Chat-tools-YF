# 02 · IPC 协议（前端 ↔ Tauri ↔ sidecar）

> `protocol_version: 1`（2026-11-06 冻结草案）。任何不兼容变更必须递增版本号并同步
> [01-总体架构](01-总体架构与路线.md)。本协议同时是 **M-A1 的契约冻结评审对象**。
>
> **2026-11-07 增补（v1 内兼容扩展，不递增版本）**：新增方法/命令 `resolve_media`
> （图片**懒解码**）；`load_source` 的 `options.resolve_media` 语义由「加载期全量解码」
> 改为「加载期**只定位**、显示/导出时**按需解码**」——大账号首解 4700+ 图 ≈6.9 分钟
> 顶穿 300s `LOAD_TIMEOUT`（见 docs/05），字段形状不变，仅 `media[].decoded/path`
> 在解码完成前为 `false/""`。
>
> **2026-11-09 增补（v1 内兼容扩展，不递增版本）**：`export` 新增 `format:"bundle"`
> （**本地数据包**，docs/06 Phase 1）——全量复用 Tk `exporter.export()` 产出
> HTML 站点 + 附件副本 + `.wxchart-state.json` + 导出报告，可被 `load_source kind=export`
> 回读；**不带 scope、`out_path` 为目录**；配套 `export_messages` 命令在 bundle 成功后
> 把数据包根注册进 PathScope **与 asset 协议 scope**（包内图片缩略图可显示）。

## 0. 三层通信总览

| 通道 | 载体 | 格式 | 用途 |
|---|---|---|---|
| ① 前端 → Tauri | `invoke(cmd, args)` | JSON（Tauri IPC 序列化） | 命令调用（Promise 返回） |
| ② Tauri → 前端 | `emit(event, payload)` | JSON | 进度、sidecar 状态 |
| ③ Tauri ↔ sidecar | stdin/stdout，**一行一个 JSON**（NDJSON，UTF-8） | 同下 envelope | 数据层全部能力 |

约定：
- JSON 字符串内的换行由 `json.dumps` 转义为 `\n`，因此**行分隔 framing 是安全的**；
- 所有字段名 `snake_case`；时间戳一律 unix 秒；正文不截断（截断只发生在导出层，见 §5）；
- 前端永远不接触原始数据库路径以外的系统路径；`open_path` 只允许导出目录/附件 scope。

## 1. 通道③：Tauri ↔ sidecar（NDJSON）

### 1.1 envelope

```jsonc
// 请求（壳 → sidecar）
{"id": 7, "method": "load_source", "params": {"kind": "store", "account": "wxid_xxx"}}
// 成功
{"id": 7, "result": {"source": "store", "chats": [], "messages": [], "stats": {}}}
// 失败
{"id": 7, "error": {"code": "KEY_NOT_FOUND", "message": "没找到密钥", "detail": "..."}}
// sidecar → 壳 通知（无 id；壳转发为通道②的事件）
{"method": "progress", "params": {"phase": "read_chats", "done": 3, "total": 126, "message": "读取会话 3/126"}}
```

- `id`：整数，请求-响应配对；通知不带 `id`。
- sidecar **只**在 stdin/stdout 上说话；stderr 仅供日志（壳收集进日志面板）。
- 空行忽略；无法解析的行 → 记日志并回 `{id:null, error:{code:"BAD_FRAME"}}`（若有 id 可推断）。

### 1.2 方法清单（sidecar 实现）

| method | params | result | 说明 / 复用的 Tk 实现 |
|---|---|---|---|
| `ping` | `{}` | `{protocol_version:1, app_version:"0.1.0-dev", python:"3.10.11"}` | 健康检查，启动即调；`app_version` = 数据层 `wxchart.__version__`，`python` = `platform.python_version()` 完整版本号 |
| `scan_accounts` | `{}` | `{accounts:[{wxid, nickname, active, root}]}` | `config.discover_accounts`；`active` 为 unix 秒，`nickname` M-A1 暂回显 wxid（M-A4 doctor 接 contact 显示名） |
| `load_source` | `{kind:"store", account, options?:{resolve_media?:bool}}` 或 `{kind:"export", out_dir}` | `{source, chats, messages, stats}`（形状见 §1.3） | `guidata.load_from_store` / `load_from_export_dir`；`resolve_media=true` 时挂 MediaResolver：**文件/视频/语音照常解析，图片只定位不解码**（`media[].decoded=false`、`path=""`，name 为 `.dat` 文件名或 `md5.dat`；缓存已有解码产物的直接回填 `decoded=true`）——懒解码，解码由 `resolve_media` 方法按需完成（2026-11-07：加载期全量解码大账号 4700+ 图 ≈6.9min 顶穿 300s 超时） |
| `resolve_media` | `{indexes:[int,…]}`（`load_source` 结果 `messages` 的下标，与 sidecar 内存 `self._items` 同序） | `{items:[{index, media:[Media,…]}]}` | **按需解码图片（懒解码）**：对每条下标对应的 `raw` 消息重跑 `MediaResolver.resolve`，`media` 形状同 §1.3；与 `load_source`/`export` 共用互斥锁（冲突 `EXPORTING_BUSY`）；未加载 → `SOURCE_UNAVAILABLE`；已加载但本次未挂 resolver（`resolve_media=false` 或 export 来源）→ **原样返回**（前端据此停止重试）；下标非法/越界 → `INTERNAL` |
| `export` | `{format:"json"\|"csv", scope, out_path}` 或 `{format:"bundle", out_path}`（bundle 见下） | `{path, count, bytes}` | json/csv：`guidata.to_records/write_json/write_csv`，**作用于已加载的内存数据**（D3），未先 `load_source` → `SOURCE_UNAVAILABLE`；bundle：**本地数据包**（见下），同一互斥锁与未加载口径 |
| `doctor` | `{}` | `{version, account?, key_sources, dbs:[{name, ok}], messages?}` | `cli doctor`（M-A4） |
| `stop` | `{}` | `{ok:true}` | 优雅退出（随后 EOF） |

> **M-A1 实现子集**：`ping / scan_accounts / load_source / export / stop`（`doctor` 留 M-A4）。
> 未知 `method` → `INTERNAL`（message「未知方法: xxx」）；`kind`/`format`/`scope.type`
> 等参数取值非法 → `INTERNAL`（message 指明字段）。

`scope`（导出范围，二选一）：

```jsonc
{"type":"indexes", "indexes":[0,5,9]}              // 多选：前端选中项的下标
{"type":"filter",  "filter": {...FilterSpec}}       // 导出全部匹配
```

`format:"bundle"`（**本地数据包**，2026-11-09 增补；Phase 1 全量，选择性数据包留 docs/06 Phase 3）：

```jsonc
{"format":"bundle", "out_path":"D:\\本地数据\\wxid_xxx"}   // 目录；不带 scope（scope 传 null → INTERNAL）
```

- 产出 = `exporter.export()` 原样（HTML 站点 + 附件副本 + `.wxchart-state.json` +
  `导出报告.json`，三方格式一致）→ `load_source {kind:"export", out_dir}` 可回读；
- **仅扫描（store）来源可打包**：sidecar 持有账号/KeySet/会话清单，打包时重开解密库
  （缓存命中不解密）并挂**真实** MediaResolver（同 Tk `start_export`，附件照常解码复制）；
  导出目录来源回读后再打包 → `INTERNAL`；未加载 → `SOURCE_UNAVAILABLE`；
- 附件缺失/复制失败只记入 `导出报告.json`（`media-missing`/`media-copy-failed`），不中断导出；
- result `{path, count, bytes}`：path=数据包根目录、count=`导出报告.messages`、
  bytes=目录总字节数（遍历求和）；期间 progress `phase:"export_bundle"`
  （exporter 的 pct 0–100 → `done/total`，message 原样）。

### 1.3 共享数据形状

**FilterSpec**（与 Tk `guidata.filter_messages` 语义逐字段一致，guidata 23 项测试即其契约）：

```jsonc
{"query": "报价 张三",          // 空格分词 AND；匹配 正文/发送人/群名/群号/附件名
 "chat_id": "48025936916",     // 群号/会话ID，子串匹配；空=全部
 "date_from": "2026-11-01", "date_to": "2026-11-04",  // 含端点；空=不限；颠倒自动交换
 "type": "quote"}              // 消息类型码；空=全部
```

**load_source 的 result**（M-A1 定形）：

```jsonc
{"source": "export",           // "store" | "export"，回显来源
 "chats": [                    // guidata.chat_options：会话去重、按名称排序
   {"chat":"武汉云仓 荆 发货售后", "chat_id":"48025936916@chatroom",
    "is_group":true, "count":132, "last_ts":1793676480}],
 "messages": [ /* Message 全量，按 (ts, local_id) 正序 */ ],
 "stats": {"messages":11796, "chats":42, "media":130,
           "first_ts":1793000000, "last_ts":1793676480}}
```

**Message**（应用内全量记录，比导出 JSON 多服务端定位字段）：

```jsonc
{"ts":1793676480, "day":"2026-11-05", "time_text":"10:48:00",
 "chat":"武汉云仓 荆 发货售后", "chat_id":"48025936916@chatroom",
 "sender":"王五", "sender_id":"wxid_xxx", "is_mine":false,
 "mtype":"text", "text":"...", "truncated":false,
 "is_group":true, "local_id":123, "server_id":987654321,
 "quote_sender":"遇见", "quote_text":"被引用内容", "quote_svrid":111222333,
 "media":[{"kind":"file","name":"运单.xlsx","path":"D:\\...\\运单.xlsx",
           "rel_path":"会话/2026-11/运单.xlsx","size":24962,"decoded":true}],
 "source":"store",             // "store" | "export"
 "day_page":"2026-11-05.html", // export 来源：当天页面相对路径（store 来源为空串）
 "chat_dir":"武汉云仓_48025936916"} // export 来源：会话目录相对路径（store 来源为空串）
```

> `server_id/quote_*` 是**引用跳转**的定位依据：单击引用块先按 `quote_svrid` 精确匹配
> （同会话优先、取引用之前的最近一条），为 0（导出来源）时按 `quote_text` 内容匹配，
> 规则与 Tk 版 `_find_quoted` 完全一致。

**ExportRecord**（导出 JSON 的一行——**冻结格式**，与 Tk 版、`数据筛选.html` 三方一致，
字段表见 `wxchart-tool/docs/08`；不因 2A 增删字段）：
`time, day, ts, chat, chat_id, sender, sender_id, mine, type, type_label, text, truncated,
media[{kind,name,path}], day_page`。

## 2. 通道①：前端 → Tauri（invoke 命令）

> **invoke 参数键 = camelCase**（2026-11-09 真机实测修正）：Tauri v2 把 Rust 命令的
> snake_case 形参映射为 camelCase 键（`out_path`→**`outPath`**、`out_dir`→**`outDir`**），
> 单词参数同形（`kind`/`scope`/`path`/`indexes` 不变）。此前多 word 参数从未在真壳
> 跑过（e2e 走 MockIpc 不校验线格式），`local-data-check.mjs` 首跑即撞出
> `missing required key outPath`——`tauri.ts` 已按此修正；Rust 形参与下表语义不变。

| cmd | args | resolves | 说明 |
|---|---|---|---|
| `app_info` | `{}` | `{name, version, protocol_version, sidecar:{state, protocol_version?}}` | 启动握手；壳校验 sidecar 协议主版本一致，不一致置 `state:"mismatch"` |
| `scan_accounts` | `{}` | `{accounts:[...]}` | 转发通道③ |
| `load_data` | `{kind, account?, outDir?, options?}`（键 camelCase，见上注） | `{source, chats, messages, stats}` | **全量**返回（≈11k 条 / 数 MB）；期间 emit `data://progress`；`kind=export` 成功后 `out_dir` 注册进 PathScope **与 asset 协议 scope**（数据包内图片可显示） |
| `resolve_media` | `{indexes:number[]}` | `{items:[{index, media:[Media,…]}]}` | 转发通道③ `resolve_media`（图片懒解码，超时 60s）；**新解码出的 `path` 同步加入 `open_path` 路径 scope 白名单**（否则点击打开报 `PATH_NOT_ALLOWED`） |
| `export_messages` | `{format, scope?, outPath}`（键 camelCase，见上注） | `{path, count, bytes}` | `outPath` 由前端先经 `plugin:dialog\|save` 取得；`format:"bundle"` 时 scope 省略（传 null）、`outPath` 为**目录**（`plugin:dialog\|open` directory 模式）；bundle 成功后该目录注册进 PathScope **与 asset 协议 scope** |
| `open_path` | `{path}` | `{ok}` | opener 插件；路径必须在导出目录/附件 scope 内，否则 `PATH_NOT_ALLOWED` |
| `reveal_path` | `{path}` | `{ok}` | 在资源管理器中定位 |
| `doctor` | `{}` | 见 §1.2 | M-A4 |
| `get_settings` | `{}` | `{last_account, last_export_dir}`（均为 string，缺省 `""`） | 读应用设置；文件不存在/损坏 → 默认值（**损坏容忍**，2026-11-09 #4 冻结） |
| `set_settings` | `{patch:{last_account?, last_export_dir?}}` | 合并后的全量设置（同上形状） | **白名单字段**合并写入 `%APPDATA%\com.wxchart.app\settings.json`（原子 tmp+rename）；**未知字段/非字符串值 → `INTERNAL`**（message 指明字段——防 `lastAccount` 这类拼写静默丢失）；单窗口，跨窗口同步见 §3 `settings://changed` 裁剪注 |

**筛选不在 IPC 层**：`load_data` 后所有筛选/分组/选区/引用跳转都在前端内存完成（D2 决策）。

## 3. 通道②：Tauri → 前端（事件）

| event | payload | 时机 |
|---|---|---|
| `data://progress` | `{phase, done, total, message}` | `load_data` / `export_messages` 期间（转发 sidecar `progress` 通知） |
| `sidecar://status` | `{state:"starting"\|"ready"\|"restarted"\|"failed"\|"mismatch", detail?}` | sidecar 生命周期变化；`failed` 时前端显示降级横幅；`mismatch`=协议主版本不一致（见 §2 `app_info`） |
| `settings://changed` | `{...}` | 设置被其它窗口修改（**预留不实现**：本项目单窗口，2026-11-09 #4 施工时裁剪——`get/set_settings` 已可用，跨窗口同步暂无消费方；若将来多窗口再启用） |

## 4. 错误码

| code | 来源 | 前端提示策略 |
|---|---|---|
| `NO_ACCOUNT` | 未发现微信账号目录 | 引导"先登录微信/点扫描会话" |
| `ACCOUNT_NOT_FOUND` | 指定 wxid 不存在 | 下拉刷新 |
| `KEY_NOT_FOUND` | `KeyExtractError`（微信未运行/刚启动） | "微信刚启动还没解锁，点开几个聊天后重试"（沿用 Tk 文案） |
| `DB_DECRYPT_FAIL` | 解密失败 | 带 detail 提示重试/自检 |
| `SOURCE_UNAVAILABLE` | 既无扫描结果也无导出目录 | 引导扫描或指向输出目录 |
| `EXPORTING_BUSY` | 与加载/导出互斥 | 等待或停止当前任务 |
| `EXPORT_FAILED` | 写文件失败 | 显示 detail（路径/权限） |
| `PATH_NOT_ALLOWED` | 路径不在 scope | 安全拒绝，不重试 |
| `SIDECAR_TIMEOUT` | ping/调用超时 | 重启一次 → 仍失败显示 `sidecar://status failed` 横幅 |
| `PROTOCOL_MISMATCH` | 协议主版本不一致 | 阻断并提示"版本不匹配，重新安装" |
| `BAD_FRAME` | NDJSON 解析失败 | 记日志（内部错误） |
| `INTERNAL` | 其它异常 | 通用错误框 + detail |

错误对象统一：`{code, message, detail?}` —— `message` 为可直接展示的中文（沿用 Tk 版文案）。

## 5. 典型会话（时序）

```text
前端                     壳(Tauri)                    sidecar(Python)
 │ invoke app_info ──────►│ 校验 protocol_version        │
 │◄── {sidecar:"starting"}│ spawn + ping ───────────────►│
 │                        │◄─ {protocol_version:1}      │
 │◄── event sidecar://status ready                       │
 │ invoke scan_accounts ─►│ ── scan_accounts ───────────►│ ──► accounts
 │ invoke load_data ─────►│ ── load_source ─────────────►│
 │◄─ event data://progress (读取会话 3/126…) ◄───────────│◄── progress 通知
 │◄── {chats, messages[11796], stats} ◄──────────────────│
 │ （本地：筛选/分组/气泡渲染/拖选/引用跳转/多选——零 IPC）
 │ invoke resolve_media ─►│ ── resolve_media {indexes} ─►│ 可见缩略图按需解码（懒解码）
  │◄── {items:[{index,media}]}（新 path 进 scope 白名单） ◄│
  │ invoke export_messages│ ── export {scope, out_path} ─►│ write_json/write_csv
 │◄── {path, count}       │◄─────────────────────────────│
 │ invoke open_path ─────►│ scope 校验 → opener 打开     │
```

## 6. 测试与 mock 约定

- 前端 `src/ipc/` 暴露唯一接口 `interface Ipc { appInfo(); loadData(...); exportMessages(...); ... }`：
  - `TauriIpc`：invoke/emit 实现（生产）；
  - `MockIpc`：返回合成数据（生成器 `src/ipc/fixtures.ts`，测试与浏览器 dev mock 共用；
    **不使用真实聊天记录**），可注入错误码。
- Vitest/Playwright 全部跑在 `MockIpc` 上 ⇒ **普通浏览器即可测**，不依赖壳；
- 契约测试（Python 侧）用同一份 FilterSpec/错误码断言 sidecar 实现 ⇒ 双端同源。
