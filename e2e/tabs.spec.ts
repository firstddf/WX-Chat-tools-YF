// 标签页流程真浏览器验收（docs/04 A2 #24–#30；对应 Tk tests/test_gui_smoke.py 7 项）——
// Vitest tests/app.spec.ts 只证明组件状态机，这里补的是「真浏览器里点出来的流程」：
// 真实 DOM 事件、真实下拉/输入框、真实剪贴板、真实保存路径回执。
//
// 数据注入沿用 e2e/selection.spec.ts 的做法（不碰 src/）：
// 页面内动态 import Vite 已加载的 mock.ts 模块实例，替换 MockIpc.prototype 的
// loadData / exportMessages，用确定性小数据驱动界面，并把导出参数录到 window.__exports。
import { expect, test, type Page } from '@playwright/test';
import type { Chat, Message } from '../src/ipc/types';

test.use({
  viewport: { width: 1400, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],
});

// ---------------------------------------------------------------- 确定性 fixture

/** 本地时区今天（YYYY-MM-DD；快捷日期「今天」用它算） */
function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const TODAY = isoDay(0);

function msg(partial: Partial<Message> & { ts: number }): Message {
  return {
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '测试群一',
    chat_id: '12345678@chatroom',
    sender: '李四',
    sender_id: 'wxid_li',
    is_mine: false,
    mtype: 'text',
    text: '',
    truncated: false,
    is_group: true,
    local_id: partial.local_id ?? partial.ts,
    server_id: partial.server_id ?? partial.ts * 7 + 1,
    quote_sender: '',
    quote_text: '',
    quote_svrid: 0,
    media: [],
    source: 'store',
    day_page: '',
    chat_dir: '',
    ...partial,
  };
}

/** 与 Tk test_gui_smoke.build_samples 同构：2 群 + 1 单聊，含本人/系统/图片/关键词 XYZ */
const FIXTURE_MESSAGES: Message[] = [
  msg({ ts: 1, day: '2026-10-01', chat: '测试群一', chat_id: '12345678@chatroom', text: '群一早上好' }),
  msg({ ts: 2, day: '2026-10-01', chat: '测试群一', chat_id: '12345678@chatroom', text: '我是自己', is_mine: true, sender: '我' }),
  msg({ ts: 3, day: '2026-10-01', chat: '测试群一', chat_id: '12345678@chatroom', mtype: 'system', text: '你已加入群聊', sender: '系统' }),
  msg({
    ts: 4,
    day: '2026-10-02',
    chat: '测试群一',
    chat_id: '12345678@chatroom',
    mtype: 'image',
    sender: '王五',
    media: [{ kind: 'image', name: '测试图片.png', path: '', rel_path: '', size: 0, decoded: false }],
  }),
  msg({ ts: 5, day: '2026-10-02', chat: '测试群二', chat_id: '87654321@chatroom', text: '群二消息 特殊关键词XYZ', sender: '赵六' }),
  msg({ ts: 6, day: '2026-10-03', chat: '张三', chat_id: 'wxid_alice', is_group: false, text: '单聊内容', sender: '张三' }),
  msg({ ts: 7, day: TODAY, chat: '测试群二', chat_id: '87654321@chatroom', text: '今天的群二消息', sender: '赵六' }),
  msg({ ts: 8, day: TODAY, chat: '张三', chat_id: 'wxid_alice', is_group: false, text: '今天的单聊内容', sender: '张三' }),
];

/** 按消息重建 chats（= sidecar load_source 的 chats 行；保证 count/last_ts 与数据一致） */
function chatsOf(messages: readonly Message[]): Chat[] {
  const out: Chat[] = [];
  for (const m of messages) {
    const hit = out.find((c) => c.chat_id === m.chat_id);
    if (hit) {
      hit.count += 1;
      hit.last_ts = Math.max(hit.last_ts, m.ts);
    } else {
      out.push({ chat: m.chat, chat_id: m.chat_id, is_group: m.is_group, count: 1, last_ts: m.ts });
    }
  }
  return out;
}

const FIXTURE_CHATS = chatsOf(FIXTURE_MESSAGES);
const FIXTURE_DAYS = new Set(FIXTURE_MESSAGES.map((m) => m.day)).size;

// ---------------------------------------------------------------- MockIpc 注入

interface WindowWithHooks extends Window {
  __exports?: unknown[];
  __loads?: unknown[];
  __reveals?: string[];
  __opened?: string[];
}

/**
 * 替换页面**已加载**模块实例的 MockIpc.prototype.loadData / exportMessages。
 * Vite dev 的模块 URL 带 ?t= 版本参数，必须按 performance 资源表找同一个实例，
 * 否则 import 到的是另一个模块副本，原型补丁不生效（同 e2e/selection.spec.ts）。
 */
async function installFixture(page: Page, messages: Message[], chats: Chat[]): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }: { messages: Message[]; chats: Chat[] }) => {
      const w = window as WindowWithHooks;
      w.__exports = [];
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
      const mod = await import(url);
      const stats = {
        messages: messages.length,
        chats: chats.length,
        media: messages.reduce((n, m) => n + m.media.length, 0),
        first_ts: messages[0]?.ts ?? 0,
        last_ts: messages[messages.length - 1]?.ts ?? 0,
      };
      mod.MockIpc.prototype.loadData = async () => ({ source: 'store', chats, messages, stats });
      mod.MockIpc.prototype.exportMessages = async (params: {
        format: string;
        scope: { type: string; indexes?: number[] };
        out_path: string;
      }) => {
        w.__exports!.push(params);
        const count =
          params.scope.type === 'indexes' ? (params.scope.indexes ?? []).length : messages.length;
        return { path: params.out_path, count, bytes: Math.max(count, 1) * 180 };
      };
    },
    { messages, chats },
  );
}

/** 注入加载错误码（走 mock.ts 的 protocolError，文案与真实 IPC 同一张映射表） */
async function installLoadError(page: Page, code: string): Promise<void> {
  await page.evaluate(async (errorCode: string) => {
    const entries = performance.getEntriesByType('resource').map((e) => e.name);
    const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
    const mod = await import(url);
    mod.MockIpc.prototype.loadData = async () => {
      throw mod.protocolError(errorCode);
    };
  }, code);
}

async function exportCalls(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as WindowWithHooks).__exports ?? []);
}

function filterPage(page: Page) {
  return page.getByTestId('page_filter');
}

function status(page: Page) {
  return page.getByTestId('lbl_status');
}

async function gotoAndInstall(page: Page): Promise<void> {
  await page.goto('/');
  await installFixture(page, FIXTURE_MESSAGES, FIXTURE_CHATS);
}

async function load(page: Page, expected = `共 ${FIXTURE_MESSAGES.length} 条消息`): Promise<void> {
  await page.getByTestId('btn_load').click();
  await expect(status(page)).toContainText(expected, { timeout: 15_000 });
}

/** 已勾选的全量下标（按 data-index 读勾选框 ☑，顺序升序） */
async function checkedIndexes(page: Page): Promise<number[]> {
  const rows = filterPage(page).locator('.msg-row[data-index]');
  const count = await rows.count();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const index = Number(await row.getAttribute('data-index'));
    const box = row.locator('[data-testid="checkbox"]');
    if ((await box.count()) > 0 && ((await box.textContent()) ?? '').trim() === '☑') out.push(index);
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- A2 #24

test('A2 #24 加载 + 四条件筛选 + 状态行（共 N 条消息 · 匹配 M 条，格式同 Tk）', async ({ page }) => {
  await gotoAndInstall(page);
  await load(page);

  // 状态行与 Tk _refresh_status 同格式：共 N 条消息 · C 个会话 · D 天 [· 匹配 M 条 · 已选 K 条] · 来源
  await expect(status(page)).toContainText(
    `共 ${FIXTURE_MESSAGES.length} 条消息 · ${FIXTURE_CHATS.length} 个会话 · ${FIXTURE_DAYS} 天`,
  );
  await expect(status(page)).toContainText('来源：扫描');
  // Tk FilterTab.load_data() 末尾会 apply_filters()：加载完成即显示「匹配 N 条 · 已选 0 条」
  //（2026-11-07 对齐：filterApplied 在 load 成功路径就置位，不再等首次筛选）
  await expect(status(page)).toContainText(`匹配 ${FIXTURE_MESSAGES.length} 条 · 已选 0 条`);

  // 下拉按数据重建：全部会话/全部类型在首位
  const chatOptions = page.getByTestId('cmb_chat').locator('option');
  await expect(chatOptions).toHaveCount(FIXTURE_CHATS.length + 1);
  await expect(chatOptions.first()).toHaveText('全部会话');
  const typeOptions = page.getByTestId('cmb_type').locator('option');
  expect(await typeOptions.count()).toBeGreaterThan(1);
  await expect(typeOptions.first()).toHaveText('全部类型');

  // 条件 1/4：关键词（空格分词 AND）
  const query = page.getByTestId('entry_query');
  await query.fill('XYZ');
  await query.press('Enter');
  await expect(status(page)).toContainText('匹配 1 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(1);
  await expect(filterPage(page)).toContainText('群二消息 特殊关键词XYZ');
  await query.fill('');
  await query.press('Enter');
  await expect(status(page)).toContainText('匹配 8 条');

  // 条件 2/4：群号/会话ID
  const chatInput = page.getByTestId('entry_chat');
  await chatInput.fill('87654321@chatroom');
  await chatInput.press('Enter');
  await expect(status(page)).toContainText('匹配 2 条');
  await expect(page.getByTestId('cmb_chat')).toHaveValue('87654321@chatroom');
  await page.getByTestId('btn_reset').click();
  await expect(status(page)).toContainText('匹配 8 条');
  await expect(query).toHaveValue('');
  await expect(chatInput).toHaveValue('');

  // 条件 3/4：类型（i=3 是 image）
  await page.getByTestId('cmb_type').selectOption('image');
  await expect(status(page)).toContainText('匹配 1 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(1);
  await page.getByTestId('cmb_type').selectOption('');
  await expect(status(page)).toContainText('匹配 8 条');

  // 条件 4/4：快捷日期「今天」→ 起止日期回填 + 只匹配今天的 2 条
  await filterPage(page).locator('[data-quick="today"]').click();
  await expect(status(page)).toContainText('匹配 2 条');
  await expect(page.getByTestId('entry_from').locator('.dp-input')).toHaveValue(TODAY);
  await expect(page.getByTestId('entry_to').locator('.dp-input')).toHaveValue(TODAY);
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(2);

  // 重置恢复全量
  await page.getByTestId('btn_reset').click();
  await expect(status(page)).toContainText('匹配 8 条');
});

// ---------------------------------------------------------------- A2 #25

test('A2 #25 勾选 + 导出：保存路径 + exportMessages 参数 scope.indexes 与选中一致', async ({ page }) => {
  await gotoAndInstall(page);
  await load(page);

  // 加载完成状态行就带「匹配/已选」段（Tk load_data → apply_filters），这里先复核一次再进导出流程
  await expect(status(page)).toContainText('匹配 8 条 · 已选 0 条');

  // 未勾选 → 警告且不产生导出调用（Tk showwarning 分支）
  await page.getByTestId('btn_json').click();
  await expect(status(page)).toContainText('请先勾选要导出的消息');
  expect(await exportCalls(page)).toEqual([]);

  // 全选 → 8 个勾选框全部 ☑
  await page.getByTestId('btn_select_all').click();
  await expect(status(page)).toContainText('已选 8 条');
  expect(await checkedIndexes(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

  // 手动取消全量下标 2 → 选中 7 条（勾选状态与显示顺序无关）
  await filterPage(page).locator('.msg-row[data-index="2"] [data-testid="checkbox"]').click();
  await expect(status(page)).toContainText('已选 7 条');
  expect(await checkedIndexes(page)).toEqual([0, 1, 3, 4, 5, 6, 7]);

  // 导出选中 JSON：浏览器 dev 的「保存对话框」返回建议文件名 选中.json（ipc/dialog.ts）
  await page.getByTestId('btn_json').click();
  await expect(status(page)).toContainText('已导出 7 条 → 选中.json');
  const calls = (await exportCalls(page)) as Array<{
    format: string;
    scope: { type: string; indexes?: number[] };
    out_path: string;
  }>;
  expect(calls).toHaveLength(1);
  expect(calls[0]!.format).toBe('json');
  expect(calls[0]!.scope.type).toBe('indexes');
  // scope.indexes 与勾选完全一致（含未渲染进窗口的也不丢，这里小数据全渲染）
  expect(calls[0]!.scope.indexes).toEqual([0, 1, 3, 4, 5, 6, 7]);
  expect(calls[0]!.out_path).toBe('选中.json');

  // 全部匹配 CSV：scope.type=filter、out_path=全部匹配.csv（Tk 同文件名）
  await page.getByTestId('btn_all_csv').click();
  await expect(status(page)).toContainText('已导出 8 条 → 全部匹配.csv');
  const all = (await exportCalls(page)) as Array<{
    format: string;
    scope: { type: string; filter?: Record<string, string> };
    out_path: string;
  }>;
  expect(all).toHaveLength(2);
  expect(all[1]!.format).toBe('csv');
  expect(all[1]!.scope.type).toBe('filter');
  expect(all[1]!.scope.filter?.query).toBe('');
  expect(all[1]!.out_path).toBe('全部匹配.csv');
});

// ---------------------------------------------------------------- 本地数据（docs/06 Phase 1，e2e +3）

/**
 * 本地数据测试夹具：loadData 记参数并回 source=export（回读场景）、
 * exportMessages 记参数（bundle 不带 scope）、revealPath 记路径。
 */
async function installLocalData(page: Page, messages: Message[], chats: Chat[]): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }: { messages: Message[]; chats: Chat[] }) => {
      const w = window as WindowWithHooks;
      w.__exports = [];
      w.__loads = [];
      w.__reveals = [];
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
      const mod = await import(url);
      const stats = {
        messages: messages.length,
        chats: chats.length,
        media: messages.reduce((n, m) => n + m.media.length, 0),
        first_ts: messages[0]?.ts ?? 0,
        last_ts: messages[messages.length - 1]?.ts ?? 0,
      };
      mod.MockIpc.prototype.loadData = async (params: unknown) => {
        w.__loads!.push(params);
        const kind = (params as { kind?: string }).kind;
        return {
          source: kind === 'export' ? 'export' : 'store',
          chats,
          messages,
          stats,
        };
      };
      mod.MockIpc.prototype.exportMessages = async (params: {
        format: string;
        scope?: { type: string };
        out_path: string;
      }) => {
        w.__exports!.push(params);
        return { path: params.out_path, count: messages.length, bytes: messages.length * 180 };
      };
      mod.MockIpc.prototype.revealPath = async (path: string) => {
        w.__reveals!.push(path);
        return { ok: true };
      };
    },
    { messages, chats },
  );
}

async function localCalls(page: Page): Promise<{
  exports: unknown[];
  loads: unknown[];
  reveals: string[];
}> {
  return page.evaluate(() => {
    const w = window as WindowWithHooks;
    return { exports: w.__exports ?? [], loads: w.__loads ?? [], reveals: w.__reveals ?? [] };
  });
}

async function gotoLocal(page: Page): Promise<void> {
  await page.goto('/');
  await installLocalData(page, FIXTURE_MESSAGES, FIXTURE_CHATS);
}

test('本地数据 #1 导出本地数据包：bundle 参数（无 scope、目录 out_path）+ 完成提示 + 打开导出目录', async ({
  page,
}) => {
  await gotoLocal(page);
  await load(page);
  await page.getByTestId('tab_manage').click();
  const manage = page.getByTestId('page_manage');

  // 浏览器 dev 的目录选择回固定路径（ipc/dialog.ts pickDir）
  await manage.getByTestId('btn_export_bundle').click();
  await expect(manage.getByTestId('manage_notice')).toContainText('已导出数据包 8 条 → C:/mock/local-data');

  const { exports } = await localCalls(page);
  const calls = exports as Array<{ format: string; scope?: unknown; out_path: string }>;
  expect(calls).toHaveLength(1);
  expect(calls[0]!.format).toBe('bundle');
  expect(calls[0]!.out_path).toBe('C:/mock/local-data');
  expect(calls[0]!.scope, 'bundle 不带 scope（docs/02 §1.2）').toBeUndefined();

  // 完成后出现「打开导出目录」→ revealPath 收到数据包根
  //（注意：localCalls 是 evaluate 的结构化快照，必须点击**后**再取）
  await expect(manage.getByTestId('btn_reveal_bundle')).toBeVisible();
  await manage.getByTestId('btn_reveal_bundle').click();
  const after = await localCalls(page);
  expect(after.reveals).toEqual(['C:/mock/local-data']);
});

test('本地数据 #2 打开本地数据：load kind=export 参数 + 来源：导出目录（两页都显示）', async ({
  page,
}) => {
  await gotoLocal(page);
  await load(page);
  await page.getByTestId('tab_manage').click();
  const manage = page.getByTestId('page_manage');

  await manage.getByTestId('btn_open_local').click();
  await expect(manage.getByTestId('lbl_source')).toHaveText('来源：导出目录');
  await expect(manage.getByTestId('lbl_summary')).toContainText(
    `${FIXTURE_CHATS.length} 个会话 · ${FIXTURE_MESSAGES.length} 条消息`,
  );

  const { loads } = await localCalls(page);
  const localLoads = loads as Array<{ kind: string; out_dir?: string }>;
  const local = localLoads.find((l) => l.kind === 'export');
  expect(local, '应发起 load {kind:"export"}').toBeTruthy();
  expect(local!.out_dir).toBe('C:/mock/local-data');

  // 筛选页状态行同源展示（docs/02 §2 load_data kind=export → statusText 来源段）
  await page.getByTestId('tab_filter').click();
  await expect(status(page)).toContainText('来源：导出目录');
  await expect(status(page)).toContainText(`共 ${FIXTURE_MESSAGES.length} 条消息`);
});

test('本地数据 #3 回读数据驱动全链路：筛选在 export 来源下照常（匹配 N 条）', async ({ page }) => {
  await gotoLocal(page);
  await load(page);
  await page.getByTestId('tab_manage').click();
  await page.getByTestId('page_manage').getByTestId('btn_open_local').click();
  await expect(page.getByTestId('page_manage').getByTestId('lbl_source')).toHaveText(
    '来源：导出目录',
  );

  // 回读复用全部前端链路（docs/06 Phase 1 行 3）：切筛选页做关键词筛选
  await page.getByTestId('tab_filter').click();
  const query = page.getByTestId('entry_query');
  await query.fill('XYZ');
  await query.press('Enter');
  await expect(status(page)).toContainText('匹配 1 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(1);
  await expect(filterPage(page)).toContainText('群二消息 特殊关键词XYZ');
  await expect(status(page)).toContainText('来源：导出目录');
});

// ---------------------------------------------------------------- 设置记忆（docs/07 #4）

test('设置记忆 #4 换账号 → 重开页面自动恢复（mock 持久层 localStorage）', async ({ page }) => {
  await page.goto('/');
  // 初始无记忆 → Tk 口径选列表第一个（最近活跃）
  await expect(page.getByTestId('cmb_account')).toHaveValue('wxid_mock_alpha');
  await expect(page.getByTestId('account_status')).toContainText('已选账号：wxid_mock_alpha');

  // 用户手动换账号 → setAccount 持久化 last_account
  await page.getByTestId('cmb_account').selectOption('wxid_mock_beta');
  await expect(page.getByTestId('account_status')).toContainText('已选账号：wxid_mock_beta');

  // 重开页面（模拟重启应用）→ init 读设置 → 扫描后记忆优先
  await page.reload();
  await expect(page.getByTestId('cmb_account')).toHaveValue('wxid_mock_beta');
  await expect(page.getByTestId('account_status')).toContainText('已选账号：wxid_mock_beta');
});

// ---------------------------------------------------------------- A2 #26

test('A2 #26 管理页「在筛选中查找」→ 切页 + entry_chat 预填 + 结果只剩该会话', async ({ page }) => {
  await gotoAndInstall(page);
  await load(page);

  await page.getByTestId('tab_manage').click();
  const manage = page.getByTestId('page_manage');
  await expect(page.getByTestId('page_filter')).toBeHidden();
  const row = manage.getByTestId('chat_row').filter({ hasText: '测试群二' });
  await expect(row).toHaveCount(1);
  await row.click();
  await manage.getByTestId('btn_to_filter').click();

  // 切回筛选页、群号预填、筛选条件真正生效（Tk focus_chat）
  await expect(page.getByTestId('page_filter')).toBeVisible();
  await expect(page.getByTestId('entry_chat')).toHaveValue('87654321@chatroom');
  await expect(status(page)).toContainText('匹配 2 条');
  await expect(page.getByTestId('cmb_chat')).toHaveValue('87654321@chatroom');

  // 结果只剩该会话：一个群标题 + 该会话的 2 条
  await expect(filterPage(page).getByTestId('group_header')).toHaveCount(1);
  await expect(filterPage(page).getByTestId('group_header')).toContainText('测试群二');
  await expect(filterPage(page).getByTestId('group_header')).toContainText('群号 87654321@chatroom · 2 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(2);

  // 清空预填群号 → 恢复全部（Tk 同：清空后 apply_filters 恢复）
  await page.getByTestId('entry_chat').fill('');
  await page.getByTestId('entry_chat').press('Enter');
  await expect(status(page)).toContainText('匹配 8 条');
});

// ---------------------------------------------------------------- A2 #27 / #28

test('A2 #27/#28 会话树浏览（选行/双击刷新右侧）+ 搜索过滤 + 复制群号=剪贴板', async ({ page }) => {
  await gotoAndInstall(page);
  await load(page);

  await page.getByTestId('tab_manage').click();
  const manage = page.getByTestId('page_manage');
  const rows = manage.getByTestId('chat_row');
  await expect(rows).toHaveCount(FIXTURE_CHATS.length);
  await expect(manage.getByTestId('lbl_summary')).toContainText(
    `${FIXTURE_CHATS.length} 个会话 · ${FIXTURE_MESSAGES.length} 条消息`,
  );

  // 搜索过滤会话树（名称/群号）
  const search = manage.getByTestId('entry_search');
  await search.fill('群二');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('测试群二');
  await search.fill('');
  await expect(rows).toHaveCount(FIXTURE_CHATS.length);

  // 选行 + 复制群号 → 系统剪贴板 = 群号（Tk copy_chat_id）
  await rows.filter({ hasText: '测试群二' }).click();
  await manage.getByTestId('btn_copy_id').click();
  await expect(manage.getByTestId('manage_notice')).toContainText('已复制群号 87654321@chatroom');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('87654321@chatroom');

  // 选行 + 「浏览消息」→ 右侧只显示该会话（纯浏览无勾选）
  await manage.getByTestId('btn_browse').click();
  const browse = manage.getByTestId('message_view');
  await expect(browse.locator('.msg-row')).toHaveCount(2);
  await expect(browse).toContainText('群二消息 特殊关键词XYZ');
  await expect(browse).toContainText('今天的群二消息');
  await expect(browse).not.toContainText('群一早上好'); // 浏览视图只含该会话
  await expect(browse.locator('[data-testid="checkbox"]')).toHaveCount(0);

  // #28 双击另一会话行 → 右侧浏览视图刷新成该会话
  await rows.filter({ hasText: '张三' }).dblclick();
  await expect(browse.locator('.msg-row')).toHaveCount(2);
  await expect(browse).toContainText('单聊内容');
  await expect(browse).not.toContainText('群二消息');
});

// ---------------------------------------------------------------- A2 #29

test('A2 #29 无数据引导文案（三处，与 Tk 一致）', async ({ page }) => {
  await page.goto('/');
  await installFixture(page, [], []);
  await load(page, '没有可用的聊天数据');

  const EMPTY_GUIDANCE = '没有可用的聊天数据：请先在「导出」页扫描会话，或导出一次';

  // 1) 筛选页状态行（Tk FilterTab.on_done 空数据分支）
  await expect(status(page)).toContainText(EMPTY_GUIDANCE);
  await expect(status(page)).toContainText('导出');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(0);

  // 2) 消息视图空状态（Tk gui_chatview 同文案）
  const empty = filterPage(page).getByTestId('empty_state');
  await expect(empty).toContainText('没有匹配的消息');
  await expect(empty).toContainText('换个关键词，或放宽群号 / 日期 / 类型筛选条件。');

  // 3) 管理页汇总（Tk ManageTab 空数据分支）+ 会话树 0 行
  await page.getByTestId('tab_manage').click();
  await expect(page.getByTestId('lbl_summary')).toContainText(EMPTY_GUIDANCE);
  await expect(page.getByTestId('page_manage').getByTestId('chat_row')).toHaveCount(0);
});

// ---------------------------------------------------------------- A2 #30

test('A2 #30 注入 KEY_NOT_FOUND → 中文文案、应用不白屏', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');
  await installLoadError(page, 'KEY_NOT_FOUND');
  await load(page, '微信刚启动还没解锁');

  // 中文文案来自 docs/02 §4 错误码映射（MockIpc.protocolError 同一张表）
  await expect(status(page)).toContainText('微信刚启动还没解锁，点开几个聊天后重试');

  // 不白屏：账号栏 + 两个标签页 + 筛选页控件仍在，且可以正常切页
  await expect(page.getByTestId('account_bar')).toBeVisible();
  await expect(page.getByTestId('tab_filter')).toBeVisible();
  await expect(page.getByTestId('page_filter')).toBeVisible();
  await expect(page.getByTestId('btn_load')).toBeVisible();
  await page.getByTestId('tab_manage').click();
  await expect(page.getByTestId('page_manage')).toBeVisible();
  await expect(page.getByTestId('lbl_summary')).toContainText('微信刚启动还没解锁');
  await expect(page.getByTestId('page_manage').getByTestId('chat_row')).toHaveCount(0);

  // 已加载数据为空 + 错误只走文案，不抛运行时异常
  expect(pageErrors).toEqual([]);
});
