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
  Record<'loadData' | 'exportMessages' | 'scanAccounts' | 'appInfo' | 'resolveMedia', ErrorCode>
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
}

// ---------------------------------------------------------------- Ipc 接口（docs/02 §6）

export interface Ipc {
  appInfo(): Promise<AppInfo>;
  scanAccounts(): Promise<ScanAccountsResult>;
  loadData(params: LoadParams): Promise<LoadResult>;
  /** 图片按需解码（懒解码，docs/02 §2 `resolve_media`）：indexes = messages 的全量下标 */
  resolveMedia(indexes: number[]): Promise<ResolveMediaResult>;
  exportMessages(params: ExportParams): Promise<ExportResult>;
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
