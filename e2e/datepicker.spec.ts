// 日期控件 + 筛选集成真浏览器验收（docs/04 A3 #34/#35/#36/#41/#46）——
// tests/datepicker.spec.ts 已用 jsdom 覆盖组件契约；这里补真浏览器 e2e：
// 真实输入框事件、真实 blur、真实弹层点击，以及「日期字段 → store 筛选 → 状态行/消息列表」的集成链路。
// 数据注入方式同 e2e/selection.spec.ts：页面内替换已加载 mock.ts 模块实例的
// MockIpc.prototype.loadData（不碰 src/ 与已有 spec）。
import { expect, test, type Page } from '@playwright/test';
import type { Chat, Message } from '../src/ipc/types';

test.use({ viewport: { width: 1400, height: 1000 } });

// ---------------------------------------------------------------- 确定性 fixture

function isoDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function msg(partial: Partial<Message> & { ts: number }): Message {
  return {
    day: '2026-09-10',
    time_text: '09:00:00',
    chat: '日期测试群',
    chat_id: '11112222@chatroom',
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

interface Fixture {
  messages: Message[];
  chats: Chat[];
}

function fixtureOf(messages: Message[]): Fixture {
  const chats: Chat[] = [];
  for (const m of messages) {
    const hit = chats.find((c) => c.chat_id === m.chat_id);
    if (hit) {
      hit.count += 1;
      hit.last_ts = Math.max(hit.last_ts, m.ts);
    } else {
      chats.push({ chat: m.chat, chat_id: m.chat_id, is_group: m.is_group, count: 1, last_ts: m.ts });
    }
  }
  return { messages, chats };
}

/** 固定日期 fixture：每个日期若干条，覆盖 #34/#35/#41 的期望计数 */
function buildFixedFixture(): Message[] {
  const buckets: Array<[string, number]> = [
    ['2026-09-10', 1],
    ['2026-09-15', 2],
    ['2026-09-20', 2],
    ['2026-10-01', 2],
    ['2026-10-02', 2],
    ['2026-11-05', 2],
  ];
  const out: Message[] = [];
  let ts = 1;
  for (const [day, count] of buckets) {
    for (let i = 0; i < count; i++) {
      out.push(msg({ ts: ts++, day, text: `${day} 第 ${i + 1} 条消息` }));
    }
  }
  return out;
}

/** 相对今天的 fixture：给 #46「快捷按钮 ↔ 手填起止日期」一致性用 */
function buildRelativeFixture(): Message[] {
  const buckets: Array<[number, number]> = [[0, 2], [-3, 2], [-10, 1], [-20, 2], [-40, 1]];
  const out: Message[] = [];
  let ts = 1;
  for (const [offset, count] of buckets) {
    const day = isoDay(offset);
    for (let i = 0; i < count; i++) {
      out.push(msg({ ts: ts++, day, text: `相对 ${offset} 天 第 ${i + 1} 条` }));
    }
  }
  return out;
}

const FIXED_MESSAGES = buildFixedFixture();
const FIXED = fixtureOf(FIXED_MESSAGES);

// ---------------------------------------------------------------- MockIpc 注入

async function installFixture(page: Page, fixture: Fixture): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }: { messages: Message[]; chats: Chat[] }) => {
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
      const mod = await import(url);
      const stats = {
        messages: messages.length,
        chats: chats.length,
        media: 0,
        first_ts: messages[0]?.ts ?? 0,
        last_ts: messages[messages.length - 1]?.ts ?? 0,
      };
      mod.MockIpc.prototype.loadData = async () => ({ source: 'store', chats, messages, stats });
    },
    { messages: fixture.messages, chats: fixture.chats },
  );
}

function filterPage(page: Page) {
  return page.getByTestId('page_filter');
}

function status(page: Page) {
  return page.getByTestId('lbl_status');
}

function fromInput(page: Page) {
  return page.getByTestId('entry_from').locator('.dp-input');
}

function toInput(page: Page) {
  return page.getByTestId('entry_to').locator('.dp-input');
}

async function load(page: Page, expected: string): Promise<void> {
  await page.getByTestId('btn_load').click();
  await expect(status(page)).toContainText(expected, { timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installFixture(page, FIXED);
  await load(page, `共 ${FIXED_MESSAGES.length} 条消息`);
});

// ---------------------------------------------------------------- A3 #34

test('A3 #34 输入起始日期按 Enter → 筛选触发（匹配数/列表同步变少）', async ({ page }) => {
  const from = fromInput(page);
  await from.fill('2026-10-01');
  await from.press('Enter');

  // 2026-10-01 起：10-01(2) + 10-02(2) + 11-05(2) = 6 条
  await expect(status(page)).toContainText('匹配 6 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(6);
  await expect(filterPage(page)).not.toContainText('2026-09-10 第 1 条消息');

  // 清空 + Enter → 筛选恢复全量
  await from.fill('');
  await from.press('Enter');
  await expect(status(page)).toContainText(`匹配 ${FIXED_MESSAGES.length} 条`);
});

// ---------------------------------------------------------------- A3 #35

test('A3 #35 失焦规整：2026/11/5 → 2026-11-05 且筛选生效', async ({ page }) => {
  const from = fromInput(page);
  await from.fill('2026/11/5');
  await expect(from).toHaveValue('2026/11/5'); // 回车/失焦前保留原始输入

  // Tab 触发真实 blur（Tk <FocusOut> → _normalize 的等价路径）
  await from.press('Tab');
  await expect(from).toHaveValue('2026-11-05');
  // 规整后的值已提交给 store：只剩 2026-11-05 的 2 条
  await expect(status(page)).toContainText('匹配 2 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(2);
});

// ---------------------------------------------------------------- A3 #36

test('A3 #36 点 📅 弹层出现且唯一（连点两次仍只有一个）', async ({ page }) => {
  const field = page.getByTestId('entry_from');
  const calendarBtn = field.locator('.dp-btn-calendar');
  await expect(calendarBtn).toContainText('📅');

  await calendarBtn.click();
  const popup = page.locator('.dp-popup');
  await expect(popup).toHaveCount(1);
  await expect(popup).toBeVisible();
  await expect(popup.locator('.dp-view-label')).toHaveText(/^\d{4}-\d{2}$/);

  // 连点 📅：旧弹层销毁重建，页面上始终只有 1 个（Tk field_single_popup 的 e2e 面）
  await calendarBtn.click();
  await expect(popup).toHaveCount(1);
  await expect(popup).toBeVisible();

  // 关闭后不再有弹层
  await popup.locator('.dp-foot-close').click();
  await expect(popup).toHaveCount(0);
});

// ---------------------------------------------------------------- A3 #41

test('A3 #41 月历选日 → 回填输入框 + 弹层关闭 + 筛选触发', async ({ page }) => {
  const from = fromInput(page);
  // 输入固定日期，让弹层初始年月确定（与运行当天无关）
  await from.fill('2026-09-10');
  await from.press('Enter');
  await page.getByTestId('entry_from').locator('.dp-btn-calendar').click();

  const popup = page.locator('.dp-popup');
  await expect(popup.locator('.dp-view-label')).toHaveText('2026-09');
  await popup.locator('.dp-day', { hasText: /^15$/ }).click();

  // 选日：弹层关闭 + 输入框回填 + on_pick 已提交（筛选生效）
  await expect(popup).toHaveCount(0);
  await expect(from).toHaveValue('2026-09-15');
  // 2026-09-15 起：09-15(2) + 09-20(2) + 10-01(2) + 10-02(2) + 11-05(2) = 10 条
  await expect(status(page)).toContainText('匹配 10 条');
  await expect(filterPage(page).locator('.msg-row')).toHaveCount(10);
});

// ---------------------------------------------------------------- A3 #46

test('A3 #46 起止日期 + 快捷按钮组合，筛选结果一致（Tk test_app_integration）', async ({ page }) => {
  const relative = buildRelativeFixture();
  await installFixture(page, fixtureOf(relative));
  await load(page, `共 ${relative.length} 条消息`);

  const from = fromInput(page);
  const to = toInput(page);
  const rowCount = () => filterPage(page).locator('.msg-row').count();

  // 快捷「近7天」：起止回填 today-6..today → 4 条（today 2 + today-3 2）
  await filterPage(page).locator('[data-quick="7"]').click();
  await expect(status(page)).toContainText('匹配 4 条');
  await expect(from).toHaveValue(isoDay(-6));
  await expect(to).toHaveValue(isoDay(0));
  const quick7Rows = await rowCount();
  expect(quick7Rows).toBe(4);

  // 手填同一区间 → 结果与快捷按钮一致（起止日期组合链路）
  await from.fill(isoDay(-6));
  await from.press('Enter');
  await to.fill(isoDay(0));
  await to.press('Enter');
  await expect(status(page)).toContainText('匹配 4 条');
  expect(await rowCount()).toBe(quick7Rows);

  // 快捷「近30天」：today-29..today → 7 条（day 0/3/10/20 的 2+2+1+2）
  await page.getByTestId('btn_reset').click();
  await filterPage(page).locator('[data-quick="30"]').click();
  await expect(status(page)).toContainText('匹配 7 条');
  await expect(from).toHaveValue(isoDay(-29));
  await expect(to).toHaveValue(isoDay(0));
  const quick30Rows = await rowCount();
  expect(quick30Rows).toBe(7);

  await from.fill(isoDay(-29));
  await from.press('Enter');
  await to.fill(isoDay(0));
  await to.press('Enter');
  await expect(status(page)).toContainText('匹配 7 条');
  expect(await rowCount()).toBe(quick30Rows);

  // 快捷「全部」：清空起止日期 → 全量（日期字段与筛选结果同步复位）
  await filterPage(page).locator('[data-quick="all"]').click();
  await expect(from).toHaveValue('');
  await expect(to).toHaveValue('');
  await expect(status(page)).toContainText(`匹配 ${relative.length} 条`);
});
