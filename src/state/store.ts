// 状态层（S3）——组合式 store，不引入 Pinia（docs/01 §3）。
// 数据加载 / 内存筛选（D2）/ 选择状态（Tk MessageView 语义）/ 状态行。
import { computed, reactive, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { filterIndexed } from '../logic/filter';
import type { Indexed } from '../logic/plan';
import type {
  Account, AppInfo, AppSettings, Chat, ExportParams, ExportResult, FilterSpec, Ipc, LoadParams,
  LoadStats, LoadResult, Message, ProgressParams, ProtocolError, ResolveMediaResult,
  SidecarStatus,
} from '../ipc/types';
import { PROTOCOL_VERSION } from '../ipc/types';

// ---------------------------------------------------------------- 数据状态

export interface DataState {
  loaded: boolean;
  loading: boolean;
  source: 'store' | 'export' | '';
  messages: Message[];
  chats: Chat[];
  stats: LoadStats | null;
  progress: ProgressParams | null;
  error: ProtocolError | null;
  appInfo: AppInfo | null;
  sidecar: SidecarStatus;
  filterApplied: boolean;
  /** 账号下拉的选项来源（docs/02 §2 scan_accounts，对应 Tk self.accounts） */
  accounts: Account[];
  /** 已选账号 wxid；空串 = 未选（对应 Tk self.account） */
  account: string;
  /** 扫描是否已完成（区分「还没扫」与「扫了但没有账号」，避免启动瞬间误报无账号） */
  accountsScanned: boolean;
  /** 账号扫描失败的错误（与数据加载错误分开，账号栏单独展示） */
  accountsError: ProtocolError | null;
  /** 账号扫描中（刷新按钮禁用 + 账号栏状态文字） */
  scanning: boolean;
  /** 应用设置（docs/02 §2；init 时读取，换账号时持久化 last_account） */
  settings: AppSettings;
}

// ---------------------------------------------------------------- 选择（Tk MessageView 语义）

export interface SelectionApi {
  readonly selectable: boolean;
  readonly multi: Ref<boolean>;
  readonly selected: Set<number>; // 全量下标集合（= 导出 scope.indexes）
  count(): number;
  indices(): number[];
  isSel(index: number): boolean;
  toggle(index: number): void;
  setMulti(v: boolean): void;
  /** 全选（作用于给定全集=当前匹配项，含未渲染的）；自动进入多选 */
  selectAll(indexes: readonly number[]): void;
  selectNone(): void;
  invert(indexes: readonly number[]): void;
  /** 等价 Tk set_messages：清空选择 + 退多选；原本有选择时回调 0 */
  reset(): void;
  onSelectionChange(cb: (count: number) => void): () => void;
}

export function createSelection(selectable = true): SelectionApi {
  const multi = ref(false);
  const selected = reactive(new Set<number>());
  const listeners = new Set<(count: number) => void>();
  const notify = (): void => {
    for (const cb of listeners) cb(selected.size);
  };

  return {
    selectable,
    multi,
    selected,
    count: () => selected.size,
    indices: () => [...selected].sort((a, b) => a - b),
    isSel: (index: number) => selected.has(index),
    toggle(index: number): void {
      if (!selectable) return;
      if (selected.has(index)) selected.delete(index);
      else selected.add(index);
      notify();
    },
    setMulti(v: boolean): void {
      if (!selectable) return;
      multi.value = v;
    },
    selectAll(indexes: readonly number[]): void {
      if (!selectable) return;
      selected.clear();
      for (const i of indexes) selected.add(i);
      multi.value = true; // 先定状态再画框（Tk 同）
      notify();
    },
    selectNone(): void {
      if (!selectable) return;
      selected.clear();
      notify();
    },
    invert(indexes: readonly number[]): void {
      if (!selectable) return;
      const next = new Set(indexes);
      for (const i of selected) next.delete(i);
      selected.clear();
      for (const i of next) selected.add(i);
      multi.value = true;
      notify();
    },
    reset(): void {
      const had = selected.size > 0;
      selected.clear();
      multi.value = false;
      if (had) notify();
    },
    onSelectionChange(cb: (count: number) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// ---------------------------------------------------------------- store

export interface AppStore {
  readonly ipc: Ipc;
  readonly data: DataState;
  readonly filter: FilterSpec;
  readonly matched: ComputedRef<Indexed[]>;
  readonly selection: SelectionApi;
  readonly statusText: ComputedRef<string>;
  init(): Promise<void>;
  /** 扫描账号（Tk refresh_accounts）：成功后重建选项并默认选中第一个 */
  scanAccounts(): Promise<void>;
  /** 切换已选账号（Tk _on_account_change：换账号即作废旧数据） */
  setAccount(wxid: string): void;
  load(params: LoadParams): Promise<void>;
  exportMessages(params: ExportParams): Promise<ExportResult>;
  setFilter(patch: Partial<FilterSpec>): void;
  resetFilter(): void;
  /**
   * 图片按需解码（懒解码，docs/02 §1.2 `resolve_media`）：把消息全量下标排进解码队列。
   * 微任务合批（不留定时器）、单次 IPC ≤32 个下标、同下标 in-flight 去重、
   * 代际守卫（load()/discardLoaded() 时 generation+1，旧代响应丢弃）；
   * 任何错误静默吞掉（不写 data.error、不弹错误条）。
   */
  queueResolveMedia(index: number): void;
  /**
   * 该消息第 `mi` 个附件是否已判「解码失败」（响应里仍 `decoded=false` 的图片入集合），
   * key = `${chat_id}|${local_id}|${server_id}|${media序号}`（docs/02 §1.3 定位字段）。
   * MediaThumb 据此停止重试（无请求死循环）。兼容两种调用：
   * `isDecodeFailed(msg, mi)` 与 `isDecodeFailed(msg, index, mi)`（index 仅冗余定位，不进 key）。
   */
  isDecodeFailed(msg: Message, miOrIndex: number, mi?: number): boolean;
}

export const STORE_KEY: InjectionKey<AppStore> = Symbol('wxchart-store');

function toProtocolError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ProtocolError;
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

export function createStore(ipc: Ipc): AppStore {
  const data = reactive<DataState>({
    loaded: false,
    loading: false,
    source: '',
    messages: [],
    chats: [],
    stats: null,
    progress: null,
    error: null,
    appInfo: null,
    sidecar: { state: 'starting' },
    filterApplied: false,
    accounts: [],
    account: '',
    accountsScanned: false,
    accountsError: null,
    scanning: false,
    settings: { last_account: '', last_export_dir: '' },
  });

  const filter = reactive<FilterSpec>({
    query: '',
    chat_id: '',
    date_from: '',
    date_to: '',
    type: '',
  });

  const selection = createSelection(true);
  const matched = computed<Indexed[]>(() => filterIndexed(data.messages, filter));

  // ---------------------------------------------------------------- 懒解码队列（docs/02 §1.2 resolve_media）
  // sidecar 加载期只定位不解码（media[].decoded=false），缩略图滚到视口时按需解码。
  // - 微任务合批（queueMicrotask，零定时器——unmount.spec 断言 pending timer 归零）；
  // - 单次 IPC 最多 32 个下标，多余下标排队走下一批；
  // - 同下标 in-flight 去重（同消息多图共用一个下标天然合并）；
  // - 代际守卫：load() 开始与 discardLoaded() 时 generation+1，旧代响应直接丢弃，
  //   防止把旧数据 patch 到新消息上；
  // - 任何错误静默吞掉（EXPORTING_BUSY/超时等不写 data.error、不弹错误条）。
  const RESOLVE_BATCH_LIMIT = 32;
  let generation = 0;
  const resolvePending = new Set<number>(); // 排队等批的下标（Set 插入序 = 提交顺序）
  const resolveInFlight = new Set<number>(); // 已发出 IPC、等响应的下标（去重）
  const decodeFailed = new Set<string>(); // 解码失败 key：命中后不再排队（防请求死循环）
  let flushScheduled = false;

  function decodeKey(msg: Message, mi: number): string {
    return `${msg.chat_id}|${msg.local_id}|${msg.server_id}|${mi}`;
  }

  function isDecodeFailed(msg: Message, miOrIndex: number, mi?: number): boolean {
    return decodeFailed.has(decodeKey(msg, mi ?? miOrIndex));
  }

  function queueResolveMedia(index: number): void {
    if (resolveInFlight.has(index) || resolvePending.has(index)) return;
    const msg = data.messages[index];
    if (!msg) return;
    // 该消息里仍未解码的图片若全部已判失败 → 不再排队（MediaThumb 与这里双保险）
    const retryable = msg.media.some(
      (m, mi) => m.kind === 'image' && !m.decoded && !decodeFailed.has(decodeKey(msg, mi)),
    );
    if (!retryable) return;
    resolvePending.add(index);
    scheduleResolveFlush();
  }

  /** 微任务合批：同一 tick 内排队的下标并成一批（不挂任何定时器） */
  function scheduleResolveFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      void flushResolveBatch();
    });
  }

  async function flushResolveBatch(): Promise<void> {
    const batch: number[] = [];
    for (const index of resolvePending) {
      if (resolveInFlight.has(index)) continue;
      batch.push(index);
      if (batch.length >= RESOLVE_BATCH_LIMIT) break;
    }
    if (batch.length === 0) return;
    for (const index of batch) {
      resolvePending.delete(index);
      resolveInFlight.add(index);
    }
    const gen = generation;
    try {
      const res = await ipc.resolveMedia(batch);
      if (gen === generation) applyResolved(res); // 旧代响应：丢弃，不 patch
    } catch {
      /* 静默：懒解码失败只保留占位，不进 data.error */
    } finally {
      for (const index of batch) resolveInFlight.delete(index);
      if (resolvePending.size > 0) scheduleResolveFlush(); // 剩余下标走下一批
    }
  }

  function applyResolved(res: ResolveMediaResult): void {
    for (const item of res.items) {
      const msg = data.messages[item.index];
      if (!msg) continue;
      // 正常响应的 media 与消息附件同长；空数组视为「无解码结果」，不抹掉已有附件
      if (item.media.length > 0 || msg.media.length === 0) msg.media = item.media;
      for (let mi = 0; mi < msg.media.length; mi++) {
        const m = msg.media[mi]!;
        if (m.kind === 'image' && !m.decoded) decodeFailed.add(decodeKey(msg, mi));
      }
    }
  }

  // ---------------------------------------------------------------- 账号（Tk refresh_accounts）
  let scanTask: Promise<void> | null = null;

  /** 换账号即作废旧数据（Tk _on_account_change：清空会话列表 + invalidate_data_cache） */
  function discardLoaded(): void {
    generation += 1; // 在途的懒解码响应全部作废（不能 patch 到新数据上）
    data.loaded = false;
    data.source = '';
    data.messages = [];
    data.chats = [];
    data.stats = null;
    data.progress = null;
    selection.reset();
  }

  function applyAccount(wxid: string): void {
    const changed = wxid !== data.account;
    data.account = wxid;
    if (!changed) return;
    discardLoaded();
    if (data.error?.code === 'NO_ACCOUNT') data.error = null;
  }

  function scanAccounts(): Promise<void> {
    if (scanTask) return scanTask;
    data.scanning = true;
    data.accountsError = null;
    const task = (async (): Promise<void> => {
      try {
        const res = await ipc.scanAccounts();
        data.accounts = res.accounts;
        data.accountsScanned = true;
        // 记忆优先（docs/07 #4）：settings.last_account 还在选项里 → 选它；
        // 否则回退 Tk 口径 current(0) = 最近活跃（无账号则清空选择）
        const remembered = data.settings.last_account;
        const chosen =
          res.accounts.find((a) => a.wxid === remembered)?.wxid ?? res.accounts[0]?.wxid ?? '';
        applyAccount(chosen);
      } catch (e) {
        data.accounts = [];
        data.accountsScanned = true;
        applyAccount('');
        data.accountsError = toProtocolError(e); // 扫描失败：账号栏显示 message，不白屏
      }
    })();
    const tracked = task.finally(() => {
      data.scanning = false;
      scanTask = null;
    });
    scanTask = tracked;
    return tracked;
  }

  function setAccount(wxid: string): void {
    applyAccount(wxid);
    if (!wxid) return;
    // 持久化账号记忆（docs/07 #4）：best-effort，写失败静默、不打断交互
    void ipc
      .setSettings({ last_account: wxid })
      .then((s) => {
        data.settings = s;
      })
      .catch(() => {});
  }

  async function init(): Promise<void> {
    try {
      const info = await ipc.appInfo();
      data.appInfo = info;
      data.sidecar = info.sidecar;
      // 只有「握手已完成且版本不同」才算 mismatch；starting/无 protocol_version
      // 是启动竞态，不能误判（壳队友发现的前端启动竞态）
      const shellBad = info.protocol_version !== PROTOCOL_VERSION;
      const sidecarBad =
        info.sidecar.protocol_version !== undefined &&
        info.sidecar.protocol_version !== PROTOCOL_VERSION;
      if (shellBad || sidecarBad) {
        data.sidecar = { ...info.sidecar, state: 'mismatch' };
      }
    } catch (e) {
      data.error = toProtocolError(e);
    }
    ipc.onProgress((p: ProgressParams) => {
      data.progress = p;
    });
    ipc.onSidecarStatus((s: SidecarStatus) => {
      data.sidecar = s;
    });
    // 读应用设置（docs/07 #4）：best-effort——读失败不阻断启动，按无记忆走
    try {
      data.settings = await ipc.getSettings();
    } catch {
      data.settings = { last_account: '', last_export_dir: '' };
    }
    // 启动即扫描一次账号（与 Tk __init__ 末尾 refresh_accounts() 一致）
    await scanAccounts();
  }

  async function load(params: LoadParams): Promise<void> {
    generation += 1; // 新一轮加载开始：在途懒解码响应作废（旧代直接丢弃）
    if (params.kind === 'store') {
      // 未选账号时与 Tk scan_sessions 一致：不调用数据层，只在状态行提示。
      // 启动竞态：账号还没扫完就先等一下，不让用户刚打开就点到「请先选择账号」。
      if (scanTask) await scanTask;
      else if (!data.accountsScanned) await scanAccounts();
      if (!data.account) {
        data.error = { code: 'NO_ACCOUNT', message: '请先选择账号' };
        return;
      }
    }
    data.loading = true;
    data.error = null;
    data.progress = null;
    try {
      const req: LoadParams = params.kind === 'store' ? { ...params, account: data.account } : params;
      const res: LoadResult = await ipc.loadData(req);
      data.messages = res.messages;
      data.chats = res.chats;
      data.stats = res.stats;
      data.source = res.source;
      data.loaded = true;
      // 对齐 Tk FilterTab.load_data() 末尾的 apply_filters()：加载完成即显示「匹配 N 条」
      // （只在成功路径置位；错误路径不置位，见下方 catch）
      data.filterApplied = true;
      selection.reset(); // 等价 Tk set_messages：清空选择 + 退多选
    } catch (e) {
      data.error = toProtocolError(e);
    } finally {
      data.loading = false;
    }
  }

  async function exportMessages(params: ExportParams): Promise<ExportResult> {
    try {
      return await ipc.exportMessages(params);
    } catch (e) {
      throw toProtocolError(e);
    }
  }

  function setFilter(patch: Partial<FilterSpec>): void {
    Object.assign(filter, patch);
    data.filterApplied = true;
    selection.reset(); // 等价 Tk 重新 set_messages：换筛选即清选择
  }

  function resetFilter(): void {
    Object.assign(filter, { query: '', chat_id: '', date_from: '', date_to: '', type: '' });
    data.filterApplied = true;
    selection.reset();
  }

  const statusText = computed<string>(() => {
    if (!data.loaded) return '';
    const total = data.messages.length;
    const chats = new Set(data.messages.map((m) => m.chat_id || m.chat)).size;
    const days = new Set(data.messages.map((m) => m.day).filter(Boolean)).size;
    const parts = [`共 ${total} 条消息 · ${chats} 个会话 · ${days} 天`];
    if (data.filterApplied) {
      parts.push(`匹配 ${matched.value.length} 条 · 已选 ${selection.count()} 条`);
    }
    if (data.source) {
      parts.push(`来源：${data.source === 'store' ? '扫描' : '导出目录'}`);
    }
    return parts.join(' · ');
  });

  return {
    ipc, data, filter, matched, selection, statusText,
    init, scanAccounts, setAccount, load, exportMessages, setFilter, resetFilter,
    queueResolveMedia, isDecodeFailed,
  };
}
