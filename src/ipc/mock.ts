// MockIpc —— 普通浏览器 / Vitest 用的 Ipc 实现（docs/02 §6）。
// 合成数据 + 错误码注入 + 调用录制（断言导出参数等用）。
import { deriveChats, deriveStats } from '../logic/derive';
import { makeAccounts, makeMessages } from './fixtures';
import type {
  Account, AppInfo, AppSettings, ErrorInjection, ExportParams, ExportResult, Ipc, LoadParams,
  LoadResult, Media, Message, ProgressParams, ProtocolError, ResolveMediaResult,
  ScanAccountsResult, SidecarStatus,
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
    await delay(this.latencyMs);
    this.fail('appInfo');
    return {
      name: '微信聊天记录工具',
      version: '0.1.0',
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
    return { source, chats: deriveChats(messages), messages, stats: deriveStats(messages) };
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
    // bundle = 本地数据包（全量，docs/02 §1.2）：count 回全量、进度 phase 对齐 sidecar
    if (params.format === 'bundle') {
      this.emitProgress({
        phase: 'export_bundle', done: 100, total: 100, message: '导出数据包 100%',
      });
      return { path: params.out_path, count: messages.length, bytes: Math.max(messages.length, 1) * 180 };
    }
    const count = params.scope?.type === 'indexes'
      ? params.scope.indexes.length
      : messages.length; // mock 不真筛，返回全量长度即可（断言看 calls）
    this.emitProgress({ phase: 'export', done: count, total: count, message: `导出 ${count} 条` });
    return { path: params.out_path, count, bytes: Math.max(count, 1) * 180 };
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
