// MockIpc —— 普通浏览器 / Vitest 用的 Ipc 实现（docs/02 §6）。
// 合成数据 + 错误码注入 + 调用录制（断言导出参数等用）。
import { deriveChats, deriveStats } from '../logic/derive';
import { makeAccounts, makeMessages } from './fixtures';
import type {
  Account, AppInfo, AppSettings, DoctorResult, ErrorInjection, ExportParams, ExportResult,
  ExtractTrackingParams, ExtractTrackingResult, Ipc, LoadParams, LoadResult, Media, Message,
  ProgressParams, ProtocolError, ResolveMediaResult, ScanAccountsResult, SidecarStatus,
} from './types';
import { PROTOCOL_VERSION } from './types';

/** Mock 设置持久层键（localStorage）——跨页面重载的记忆语义由它承载（docs/07 #4 e2e） */
export const MOCK_SETTINGS_KEY = 'wxchart.mock.settings';

const SETTINGS_DEFAULTS: AppSettings = { last_account: '', last_export_dir: '', data_root: '' };

/** `resolve_media` 注入钩子：测试/浏览器 dev 用它回「已解码」数据；缺省走默认实现 */
export type ResolveMediaHook = (
  indexes: number[],
) => ResolveMediaResult | Promise<ResolveMediaResult>;

export interface MockIpcOptions {
  /** loadData 返回的合成消息条数（默认 11796 = 真机量级） */
  messageCount?: number;
  /** scanAccounts 返回的账号列表（默认 fixtures.makeAccounts()；传 [] 模拟无账号） */
  accounts?: Account[];
  /** 按方法注入错误码 */
  errors?: ErrorInjection;
  /** 模拟延迟（ms），默认 0 */
  latencyMs?: number;
  /** resolve_media 结果注入（懒解码测试回 decoded 数据用；缺省=原样返回） */
  resolveMedia?: ResolveMediaHook;
}

/** docs/02 §4 的中文提示文案（错误注入时回给前端） */
const ERROR_MESSAGES: Record<string, string> = {
  NO_ACCOUNT: '没有发现微信账号目录（请先登录微信）',
  ACCOUNT_NOT_FOUND: '账号不存在，点扫描刷新',
  KEY_NOT_FOUND: '微信刚启动还没解锁，点开几个聊天后重试',
  DB_DECRYPT_FAIL: '数据库解密失败，请重试或自检',
  SOURCE_UNAVAILABLE: '既无扫描结果也无导出目录，请先扫描或指向输出目录',
  EXPORTING_BUSY: '正在加载或导出，请稍候',
  EXPORT_FAILED: '写文件失败，请检查路径与权限',
  PATH_NOT_ALLOWED: '路径不在允许范围',
  SIDECAR_TIMEOUT: '数据层响应超时，正在重启',
  PROTOCOL_MISMATCH: '版本不匹配，重新安装',
  BAD_FRAME: '协议帧解析失败（内部错误）',
  INTERNAL: '内部错误',
};

export function protocolError(code: string): ProtocolError {
  return { code: code as ProtocolError['code'], message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL };
}

const delay = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export class MockIpc implements Ipc {
  /** 调用录制：断言 export_messages / resolve_media 参数等 */
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly errors: ErrorInjection;
  /**
   * resolve_media 结果注入（可写属性，风格同 `errors`）：
   * 不设时走默认实现——**原样返回**该下标消息的 media（`decoded` 仍为 false），
   * 模拟「解不出」，现有占位断言不破；测试可直接赋值回「已解码」数据。
   */
  resolveMediaHook: ResolveMediaHook | null;
  private readonly messageCount: number;
  private readonly accounts: Account[];
  private readonly latencyMs: number;
  private cache = new Map<string, Message[]>();
  private progressCbs = new Set<(p: ProgressParams) => void>();
  private statusCbs = new Set<(s: SidecarStatus) => void>();
  /** 已导出过的数据包目录（export_state 等价物：同目录二跑才可能 incremental） */
  private bundleDirs = new Set<string>();
  /** 是否已存 DPAPI Key（extractTracking 带 api_key 跑过后为 true；preflight 回显用） */
  trackingKeyStored = false;

  constructor(opts: MockIpcOptions = {}) {
    this.errors = { ...opts.errors };
    this.messageCount = opts.messageCount ?? 11796;
    this.accounts = opts.accounts ?? makeAccounts();
    this.latencyMs = opts.latencyMs ?? 0;
    this.resolveMediaHook = opts.resolveMedia ?? null;
  }

  private emitProgress(p: ProgressParams): void {
    for (const cb of this.progressCbs) cb(p);
  }

  private fail(method: keyof ErrorInjection): void {
    const code = this.errors[method];
    if (code) throw protocolError(code);
  }

  private messagesFor(source: 'store' | 'export'): Message[] {
    const key = `${source}:${this.messageCount}`;
    let msgs = this.cache.get(key);
    if (!msgs) {
      msgs = makeMessages(this.messageCount, source);
      this.cache.set(key, msgs);
    }
    return msgs;
  }

  async appInfo(): Promise<AppInfo> {
    // e2e 启动骨架屏（docs/07 #8）：addInitScript 在模块加载前写入
    // window.__MOCK_APPINFO_DELAY__（ms）→ 就绪前 sidecar 停留 starting、骨架屏可见；
    // 默认 0，不影响任何现有测试。
    const extra =
      typeof window !== 'undefined'
        ? Number((window as Window & { __MOCK_APPINFO_DELAY__?: number }).__MOCK_APPINFO_DELAY__ ?? 0)
        : 0;
    if (extra > 0) await new Promise((r) => setTimeout(r, extra));
    await delay(this.latencyMs);
    this.fail('appInfo');
    return {
      name: '微信聊天记录工具',
      version: '0.2.0',
      protocol_version: PROTOCOL_VERSION,
      sidecar: { state: 'ready', protocol_version: PROTOCOL_VERSION },
    };
  }

  async scanAccounts(): Promise<ScanAccountsResult> {
    // 与壳同口径（#13）：settings.data_root 显式注入 → root 回显、tried 记录
    //（壳读 settings 文件注入，mock 读自己的持久层——e2e 据 root 回显断言）
    const settings = await this.getSettings();
    this.calls.push({ method: 'scanAccounts', params: { root: settings.data_root || null } });
    await delay(this.latencyMs);
    this.fail('scanAccounts');
    return {
      accounts: this.accounts.map((a) => ({ ...a })),
      root: settings.data_root || '',
      tried: settings.data_root ? [settings.data_root] : [],
    };
  }

  async loadData(params: LoadParams): Promise<LoadResult> {
    this.calls.push({ method: 'loadData', params });
    await delay(this.latencyMs);
    this.fail('loadData');
    const source = params.kind === 'store' ? 'store' : 'export';
    const total = this.messageCount;
    this.emitProgress({ phase: 'read_chats', done: 0, total, message: `读取会话 0/${total}` });
    const messages = this.messagesFor(source);
    this.emitProgress({ phase: 'read_chats', done: total, total, message: `读取会话 ${total}/${total}` });
    return {
      source,
      chats: deriveChats(messages),
      messages,
      stats: deriveStats(messages),
      // export 来源给导出时间（信息卡断言用；store 来源省略键，与 sidecar 同口径）
      ...(source === 'export' ? { exported_at: '2026-11-09 21:30:00' } : {}),
    };
  }

  /**
   * 默认「解不出」路径：取该下标消息的 media **原样返回**（副本，字段不变）——
   * 图片仍 `decoded=false`，前端据此落「解码失败」、占位不破、不再重试。
   * 下标不在 mock 数据里（如页面内替换了 loadData 的 e2e）→ 返回 `[]`（无解码结果）。
   */
  private mediaAt(index: number): Media[] {
    for (const msgs of this.cache.values()) {
      const hit = msgs[index];
      if (hit) return hit.media.map((m) => ({ ...m }));
    }
    return [];
  }

  /** docs/02 §1.2/§2 `resolve_media`：按需解码（懒解码）；进 `calls` 供断言 */
  async resolveMedia(indexes: number[]): Promise<ResolveMediaResult> {
    this.calls.push({ method: 'resolveMedia', params: { indexes } });
    await delay(this.latencyMs);
    this.fail('resolveMedia');
    if (this.resolveMediaHook) return await this.resolveMediaHook(indexes);
    return { items: indexes.map((index) => ({ index, media: this.mediaAt(index) })) };
  }

  async exportMessages(params: ExportParams): Promise<ExportResult> {
    this.calls.push({ method: 'exportMessages', params });
    await delay(this.latencyMs);
    this.fail('exportMessages');
    const messages = this.cache.get(`store:${this.messageCount}`) ?? this.messagesFor('store');
    // bundle = 本地数据包（docs/02 §1.2）：count 回全量、进度 phase 对齐 sidecar；
    // mode/new_messages 同 exporter 语义——incremental 且该目录已有数据包才判 incremental
    if (params.format === 'bundle') {
      this.emitProgress({
        phase: 'export_bundle', done: 100, total: 100, message: '导出数据包 100%',
      });
      const incremental =
        Boolean(params.options?.incremental) && this.bundleDirs.has(params.out_path);
      this.bundleDirs.add(params.out_path);
      return {
        path: params.out_path,
        count: messages.length,
        bytes: Math.max(messages.length, 1) * 180,
        mode: incremental ? 'incremental' : 'full',
        // mock 不造新消息：增量回 0（完成文案「新增 0 条」）
        newMessages: incremental ? 0 : messages.length,
      };
    }
    const count = params.scope?.type === 'indexes'
      ? params.scope.indexes.length
      : messages.length; // mock 不真筛，返回全量长度即可（断言看 calls）
    this.emitProgress({ phase: 'export', done: count, total: count, message: `导出 ${count} 条` });
    return { path: params.out_path, count, bytes: Math.max(count, 1) * 180 };
  }

  /** docs/02 §1.2 `doctor`：合成自检结果；进 `calls` 供断言 */
  async doctor(): Promise<DoctorResult> {
    this.calls.push({ method: 'doctor', params: {} });
    await delay(this.latencyMs);
    this.fail('doctor');
    return {
      version: '0.1.0',
      account: { wxid: this.accounts[0]?.wxid ?? 'wxid_mock', root: 'C:/mock/xwechat_files' },
      key_sources: { mode: 'config-cipher', pid: 4242, hit: 14, total: 14, missing: [] },
      dbs: [
        { name: 'message/message.db', ok: true },
        { name: 'session/session.db', ok: true },
        { name: 'contact/contact.db', ok: true },
      ],
      messages: this.messageCount,
    };
  }

  /**
   * docs/02 §1.2 `extract_tracking`（#19）：合成计数/结果；进 `calls` 供断言。
   * preflight：rows=11796、候选 42、复用 7——network=false → send_rows=0；
   * network=true+audit → 候选 42 + 回检抽样 300 → 342（UI 披露行数断言用）。
   * run：回显合成统计并发一条 progress（phase=extract_tracking）。
   */
  async extractTracking(params: ExtractTrackingParams): Promise<ExtractTrackingResult> {
    this.calls.push({ method: 'extractTracking', params });
    await delay(this.latencyMs);
    this.fail('extractTracking');
    if (params.mode === 'preflight') {
      const network = params.network ?? false;
      const audit = params.audit ?? true;
      const candidates = 42;
      const sendRows = network ? candidates + (audit ? 300 : 0) : 0;
      return {
        mode: 'preflight',
        rows: 11796,
        candidates,
        reuse_rows: 7,
        batches: network ? 1 : 0,
        send_rows: sendRows,
        key_stored: this.trackingKeyStored,
      };
    }
    const network = params.network ?? false;
    if (params.api_key) this.trackingKeyStored = true; // 保存语义（sidecar DPAPI 落盘等价）
    this.emitProgress({
      phase: 'extract_tracking', done: 1, total: 1, message: '导出完成',
    });
    return {
      mode: 'run',
      path: params.out_path ?? 'C:/mock/输出_提取快递单号.csv',
      rows: 11796,
      out_rows: 11830,
      with_numbers: 640,
      numbers: 712,
      reused_rows: 7,
      sent_rows: network ? 342 : 0,
      tokens: network ? 521000 : 0,
      elapsed: 12.3,
      network,
    };
  }

  async openPath(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async revealPath(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  /** docs/02 §2 `get_settings`：localStorage 持久层；缺失/损坏 → 默认（镜像壳的损坏容忍） */
  async getSettings(): Promise<AppSettings> {
    await delay(this.latencyMs);
    try {
      const raw = localStorage.getItem(MOCK_SETTINGS_KEY);
      if (!raw) return { ...SETTINGS_DEFAULTS };
      const obj = JSON.parse(raw) as Record<string, unknown>;
      return {
        last_account: typeof obj.last_account === 'string' ? obj.last_account : '',
        last_export_dir: typeof obj.last_export_dir === 'string' ? obj.last_export_dir : '',
        data_root: typeof obj.data_root === 'string' ? obj.data_root : '',
      };
    } catch {
      return { ...SETTINGS_DEFAULTS };
    }
  }

  /** docs/02 §2 `set_settings`：白名单合并（与壳同口径：未知键/非字符串 → INTERNAL） */
  async setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.calls.push({ method: 'setSettings', params: { patch } }); // 断言用
    await delay(this.latencyMs);
    const next = await this.getSettings();
    for (const [key, val] of Object.entries(patch)) {
      if (key !== 'last_account' && key !== 'last_export_dir' && key !== 'data_root') {
        throw { code: 'INTERNAL', message: `set_settings 字段不在白名单: ${key}` } satisfies ProtocolError;
      }
      if (typeof val !== 'string') {
        throw { code: 'INTERNAL', message: `set_settings 字段必须是字符串: ${key}` } satisfies ProtocolError;
      }
      if (key === 'last_account') next.last_account = val;
      else if (key === 'last_export_dir') next.last_export_dir = val;
      else next.data_root = val;
    }
    localStorage.setItem(MOCK_SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  onProgress(cb: (p: ProgressParams) => void): () => void {
    this.progressCbs.add(cb);
    return () => this.progressCbs.delete(cb);
  }

  onSidecarStatus(cb: (s: SidecarStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  /** 测试辅助：触发一次 sidecar 状态事件 */
  emitSidecarStatus(s: SidecarStatus): void {
    for (const cb of this.statusCbs) cb(s);
  }
}
