// IPC 契约类型 —— 与 docs/02-IPC协议.md 逐字段锁死（M-A2 实现版）。
// 任何字段变更必须先改 docs/02 并递增 protocol_version，再改本文件。

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- 错误码（docs/02 §4）
export type ErrorCode =
  | 'NO_ACCOUNT'
  | 'ACCOUNT_NOT_FOUND'
  | 'KEY_NOT_FOUND'
  | 'DB_DECRYPT_FAIL'
  | 'SOURCE_UNAVAILABLE'
  | 'EXPORTING_BUSY'
  | 'EXPORT_FAILED'
  | 'PATH_NOT_ALLOWED'
  | 'SIDECAR_TIMEOUT'
  | 'PROTOCOL_MISMATCH'
  | 'BAD_FRAME'
  | 'INTERNAL';

export interface ProtocolError {
  code: ErrorCode;
  message: string; // 可直接展示的中文（沿用 Tk 文案）
  detail?: string;
}

/** 侧边可注入的错误（MockIpc 测试用） */
export type ErrorInjection = Partial<
  Record<
    | 'loadData' | 'exportMessages' | 'scanAccounts' | 'appInfo' | 'resolveMedia' | 'doctor'
    | 'extractTracking',
    ErrorCode
  >
>;

// ---------------------------------------------------------------- 通道③ 数据形状（docs/02 §1.3）

export interface Media {
  kind: string;
  name: string;
  path: string;
  rel_path: string;
  size: number;
  decoded: boolean;
}

export interface Message {
  ts: number;
  day: string;
  time_text: string;
  chat: string;
  chat_id: string;
  sender: string;
  sender_id: string;
  is_mine: boolean;
  mtype: string;
  text: string;
  truncated: boolean;
  is_group: boolean;
  local_id: number;
  server_id: number;
  quote_sender: string;
  quote_text: string;
  quote_svrid: number;
  media: Media[];
  source: 'store' | 'export';
  day_page: string;
  chat_dir: string;
}

/** load_source result.chats —— guidata.chat_options 行 */
export interface Chat {
  chat: string;
  chat_id: string;
  is_group: boolean;
  count: number;
  last_ts: number;
}

export interface LoadStats {
  messages: number;
  chats: number;
  media: number;
  first_ts: number;
  last_ts: number;
}

export interface LoadResult {
  source: 'store' | 'export';
  chats: Chat[];
  messages: Message[];
  stats: LoadStats;
  /** export 来源且包内有导出报告/state 时给出：导出完成时间（信息卡用，docs/02 §1.3 2026-11-10） */
  exported_at?: string;
}

/** FilterSpec —— 与 Tk guidata.filter_messages 语义逐字段一致 */
export interface FilterSpec {
  query: string;
  chat_id: string;
  date_from: string; // YYYY-MM-DD；空=不限；颠倒自动交换
  date_to: string;
  type: string; // 消息类型码；空=全部
}

export type Scope =
  | { type: 'indexes'; indexes: number[] }
  | { type: 'filter'; filter: Partial<FilterSpec> };

export interface ExportResult {
  path: string;
  count: number;
  bytes: number;
  /** bundle 专属（docs/02 §1.2 2026-11-10 #14）：full | incremental；exporter 按有无 state 判定 */
  mode?: 'full' | 'incremental';
  /** 本次报告新增条数（mode=incremental 时前端出「新增 N 条」文案） */
  newMessages?: number;
}

/**
 * bundle `options`（docs/02 §1.2 2026-11-10 冻结，2026-11-11 实现）——
 * **整体可省 = 全量行为**；未知键/非预期类型由 sidecar 拒为 INTERNAL。
 * 字段名与协议逐字一致（snake_case，仅壳命令参数是 camelCase）。
 */
export interface BundleOptions {
  /** 会话子集（chat_id == chat.username，guidata._from_message:185）；缺省=全部 */
  chats?: string[];
  /** 时间范围 unix 秒闭区间，0=不限；start_ts>end_ts（均非 0）→ INTERNAL */
  start_ts?: number;
  end_ts?: number;
  /** 正文类型子集；缺省=五类，sidecar 归一恒含 "text" */
  include?: string[];
  /** 生成物开关；给了对象则逐键覆盖、缺键=true */
  artifacts?: {
    html?: boolean;
    csv?: boolean;
    media_index?: boolean;
    date_index?: boolean;
  };
  /** 增量导出（同目录同账号才生效，跳过无新消息会话） */
  incremental?: boolean;
}

/**
 * `resolve_media` 的 result（docs/02 §1.2 / §2，2026-11-07 懒解码增补）：
 * 按 `load_source` 结果 `messages` 的下标回传该条消息解码后的 `media`
 * （形状同 §1.3）。未挂 resolver 时 sidecar **原样返回**（`decoded` 仍为 false），
 * 前端据此把图片记入「解码失败」并停止重试。
 */
export interface ResolveMediaResult {
  items: Array<{ index: number; media: Media[] }>;
}

/** `doctor` 自检结果（docs/02 §1.2 2026-11-09 #3 冻结形状） */
export interface DoctorResult {
  /** 数据层版本（wxchart.__version__） */
  version: string;
  account: { wxid: string; root: string };
  /** 密钥概览（不含任何密钥值，docs/03 §5）；missing 截前 8 条 */
  key_sources: { mode: string; pid: number; hit: number; total: number; missing: string[] };
  /** 逐库解密结果；部分失败不报错，ok=false 由面板逐条呈现 */
  dbs: Array<{ name: string; ok: boolean }>;
  /** 消息总数；库不可读时省略（前端显示 —） */
  messages?: number;
}

// ------------------------------------------- extract_tracking（docs/02 §1.2 #19）

/** 联网 AI 服务商（2026-11-13 BUG2 多选）：预设三家 + 自定义（base_url/model 自填） */
export type TrackingProvider = 'deepseek' | 'mimo' | 'minimax' | 'custom';

/** `extract_tracking` 参数（通道③ snake_case；invoke 层转 camelCase，docs/02 §2） */
export interface ExtractTrackingParams {
  /** `key` = 只管理本机已存 Key（保存/清除/查询），不读文件不调 API（2026-11-13 增补） */
  mode: 'preflight' | 'run' | 'key';
  /** mode=key 可省；其余必给 */
  in_path?: string;
  /** 旧成品 CSV（首列=快递单号）→ 增量复用；缺省不复用 */
  old_path?: string;
  /** run 必填（绝对路径）；preflight 可省 */
  out_path?: string;
  /** 联网 AI 审核：**默认 false=纯本地**（docs/07 #19 拍板①） */
  network?: boolean;
  /** network=true 时提供；DPAPI 加密存本机，不回传不入库（拍板③）；缺省 mimo（旧口径） */
  provider?: TrackingProvider;
  /** provider=custom 且 network=true 时必给；预设商忽略此参数 */
  base_url?: string;
  /** provider=custom 且 network=true 时必给；预设商忽略此参数 */
  model?: string;
  /** mode=key：true=清除该服务商已存 Key；false/缺省=保存（带 api_key）或查询 */
  clear_key?: boolean;
  /** network=true 时提供；DPAPI 加密存本机，不回传不入库（拍板③） */
  api_key?: string;
  /** 抽样回检（仅 network=true 有意义） */
  audit?: boolean;
  resume?: boolean;
  force?: boolean;
}

/** preflight result（docs/02 §1.2 #19）：只读计数，不调 API 不写产物 */
export interface TrackingPreflight {
  mode: 'preflight';
  rows: number;
  /** 宽筛命中行数（= 联网时发送行数上限） */
  candidates: number;
  reuse_rows: number;
  /** 联网时预估批次数（本地=0） */
  batches: number;
  /** 实际将发送行数（含回检抽样；network=false 时=0）——UI 明示用 */
  send_rows: number;
  /** 本机是否已存**当前服务商**的 API Key（mode=key 查询/保存后同样回此字段） */
  key_stored: boolean;
}

/** run result（docs/02 §1.2 #19） */
export interface TrackingRunResult {
  mode: 'run';
  path: string;
  rows: number;
  out_rows: number;
  with_numbers: number;
  numbers: number;
  reused_rows: number;
  sent_rows: number;
  tokens: number;
  elapsed: number;
  network: boolean;
}

/** mode=key result（2026-11-13 BUG2）：只回本机该服务商 Key 是否已存（不回明文） */
export interface TrackingKeyResult {
  mode: 'key';
  key_stored: boolean;
}

export type ExtractTrackingResult = TrackingPreflight | TrackingRunResult | TrackingKeyResult;

export interface PingResult {
  protocol_version: number;
  app_version: string;
  python: string;
}

export interface Account {
  wxid: string;
  nickname: string;
  active: number;
  root: string;
}

export interface ProgressParams {
  phase: string;
  done: number;
  total: number;
  message: string;
}

// ---------------------------------------------------------------- 通道①/②（docs/02 §2/§3）

export type SidecarState = 'starting' | 'ready' | 'restarted' | 'failed' | 'mismatch';

export interface SidecarStatus {
  state: SidecarState;
  detail?: string;
  protocol_version?: number;
}

export interface AppInfo {
  name: string;
  version: string;
  protocol_version: number;
  sidecar: SidecarStatus;
}

/** 应用设置（docs/02 §2 冻结：白名单字段，缺省空串；`data_root` 为 #13 增补） */
export interface AppSettings {
  last_account: string;
  last_export_dir: string;
  /** 微信数据目录：空串 = 自动发现（发现顺序见 docs/02 §1.2 scan_accounts） */
  data_root: string;
}

/** scan_accounts 结果（docs/02 §1.2 #13）：root=命中目录（空=未命中），tried=已尝试位置 */
export interface ScanAccountsResult {
  accounts: Account[];
  root?: string;
  tried?: string[];
}

export type LoadParams =
  | { kind: 'store'; account?: string; options?: { resolve_media?: boolean } }
  | { kind: 'export'; out_dir: string };

export interface ExportParams {
  /** bundle = 本地数据包（docs/02 §1.2 2026-11-09：全量、不带 scope、out_path 为目录） */
  format: 'json' | 'csv' | 'bundle';
  /** json/csv 必填；bundle 不带（传 undefined → 壳转 null，sidecar 拒绝非 null） */
  scope?: Scope;
  out_path: string;
  /** 仅 bundle 有意义（#14 选择性/增量）；缺省 = Phase 1 全量行为 */
  options?: BundleOptions;
}

// ---------------------------------------------------------------- Ipc 接口（docs/02 §6）

export interface Ipc {
  appInfo(): Promise<AppInfo>;
  scanAccounts(): Promise<ScanAccountsResult>;
  loadData(params: LoadParams): Promise<LoadResult>;
  /** 图片按需解码（懒解码，docs/02 §2 `resolve_media`）：indexes = messages 的全量下标 */
  resolveMedia(indexes: number[]): Promise<ResolveMediaResult>;
  exportMessages(params: ExportParams): Promise<ExportResult>;
  /** 数据层自检（docs/02 §1.2 `doctor`）：账号/密钥/逐库解密/消息数 */
  doctor(): Promise<DoctorResult>;
  /** 快递单号提取（docs/02 §1.2 `extract_tracking` #19）：preflight 计数 / run 执行 */
  extractTracking(params: ExtractTrackingParams): Promise<ExtractTrackingResult>;
  openPath(path: string): Promise<{ ok: boolean }>;
  revealPath(path: string): Promise<{ ok: boolean }>;
  /** 读应用设置（docs/02 §2；文件缺失/损坏 → 默认空串） */
  getSettings(): Promise<AppSettings>;
  /** 白名单合并写设置；未知字段/非字符串 → INTERNAL（docs/02 §2） */
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** 订阅进度通知；返回退订函数 */
  onProgress(cb: (p: ProgressParams) => void): () => void;
  /** 订阅 sidecar 状态事件；返回退订函数 */
  onSidecarStatus(cb: (s: SidecarStatus) => void): () => void;
}

// ---------------------------------------------------------------- 事件名（docs/02 §3）

export const EVENT_PROGRESS = 'data://progress';
export const EVENT_SIDECAR_STATUS = 'sidecar://status';
