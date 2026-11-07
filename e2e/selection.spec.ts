// 微信式选区/多选手势验收（docs/04 A1 #12–#18/#21/#22）——必须真鼠标：
// jsdom 的 getBoundingClientRect 全 0、没有 caretRangeFromPoint，拖选只能在这里测。
// 数据注入：浏览器 dev 里 App 用 MockIpc（main.ts → createIpc），这里在页面内
// 动态 import 同一个模块实例并替换 loadData/openPath，得到确定性小数据 +
// 可断言「打开附件」的调用记录（不碰 src/ 下任何文件）。
import { expect, test, type Page } from '@playwright/test';
import type { Message } from '../src/ipc/types';

test.use({
  viewport: { width: 1400, height: 1000 },
  permissions: ['clipboard-read', 'clipboard-write'],
});

function msg(partial: Partial<Message> & { ts: number }): Message {
  return {
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '测试群甲',
    chat_id: '111@chatroom',
    sender: '张三',
    sender_id: 'wxid_a',
    is_mine: false,
    mtype: 'text',
    text: '',
    truncated: false,
    is_group: true,
    local_id: partial.ts,
    server_id: partial.ts,
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

const CHATS = [
  { chat: '测试群甲', chat_id: '111@chatroom', is_group: true, count: 7, last_ts: 7 },
];

/** 7 条小数据：前 5 条文本（含一条多行给 #21），后两条附件（一条可打开、一条缺失） */
const FIXTURE: Message[] = [
  msg({ ts: 1, text: '第一条消息内容甲乙丙丁戊己庚辛' }),
  msg({ ts: 2, text: '第二条消息内容一二三四五六七八' }),
  msg({ ts: 3, text: '第三条消息内容甲乙丙丁戊己', is_mine: true, sender: '我' }),
  msg({ ts: 4, text: '第四行第一段甲乙丙丁戊己庚辛\n第四行第二段甲乙丙丁戊己' }),
  msg({ ts: 5, text: '第五条消息内容一二三四五六七八', is_mine: true, sender: '我' }),
  msg({
    ts: 6,
    mtype: 'file',
    media: [
      { kind: 'file', name: '运单.xlsx', path: 'D:/mock/运单.xlsx', rel_path: '', size: 2048, decoded: false },
    ],
  }),
  msg({
    ts: 7,
    mtype: 'file',
    media: [
      { kind: 'file', name: '缺失.xlsx', path: '', rel_path: '', size: 0, decoded: false },
    ],
  }),
];

function longFixture(count = 600): Message[] {
  return Array.from({ length: count }, (_, i) =>
    msg({ ts: i + 1, text: `滚动消息 ${i}：今天${i % 2 ? '发' : '收'}货安排确认一下` }),
  );
}

/**
 * 替换 MockIpc.prototype.loadData/openPath。
 * 必须命中页面**已加载**的模块 URL（Vite dev 会带 ?t= 版本参数），
 * 否则 import 的是另一个模块实例，原型补丁不生效。
 */
async function installFixture(
  page: Page,
  messages: Message[] = FIXTURE,
  chats = CHATS,
): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }) => {
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
      const mod = await import(url);
      const proto = mod.MockIpc.prototype;
      proto.loadData = async () => ({
        source: 'store',
        chats,
        messages,
        stats: {
          messages: messages.length,
          chats: chats.length,
          media: messages.reduce((n: number, m: Message) => n + m.media.length, 0),
          first_ts: messages[0]?.ts ?? 0,
          last_ts: messages[messages.length - 1]?.ts ?? 0,
        },
      });
      proto.openPath = async (path: string) => {
        const w = window as unknown as { __opened?: string[] };
        w.__opened = [...(w.__opened ?? []), path];
        return { ok: true };
      };
    },
    { messages, chats },
  );
}

async function loadFixture(page: Page, expectedCount = 7): Promise<void> {
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText(`共 ${expectedCount} 条消息`, {
    timeout: 15_000,
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installFixture(page);
  await loadFixture(page);
});

// ---------------------------------------------------------------- 通用定位/手势

function filterPage(page: Page) {
  return page.getByTestId('page_filter');
}

function vlist(page: Page) {
  return filterPage(page).getByTestId('message_view');
}

async function rowByText(page: Page, text: string) {
  const row = filterPage(page).locator('.msg-row').filter({ hasText: text }).first();
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();
  return row;
}

async function bubbleBox(page: Page, text: string) {
  const row = await rowByText(page, text);
  const bubble = row.locator('.bubble');
  const box = await bubble.boundingBox();
  if (!box) throw new Error(`找不到气泡：${text}`);
  return box;
}

async function rowText(page: Page, text: string): Promise<string> {
  const row = await rowByText(page, text);
  return (await row.locator('.text').textContent()) ?? '';
}

async function selectionText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** 气泡内整行拖选：从左侧内边距按下 → 拖到右侧内边距，预期选中整条正文 */
async function dragFullBubble(
  page: Page,
  text: string,
): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  const box = await bubbleBox(page, text);
  const from = { x: box.x + 3, y: box.y + box.height / 2 };
  const to = { x: box.x + box.width - 4, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  return { from, to };
}

async function checkboxCount(page: Page): Promise<number> {
  return filterPage(page).locator('[data-testid="checkbox"]').count();
}

/** 已勾选的全量下标（多选模式下从勾选框 ☑ 读；顺序按 DOM 即显示顺序） */
async function checkedIndexes(page: Page): Promise<number[]> {
  const rows = filterPage(page).locator('.msg-row[data-index]');
  const count = await rows.count();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const index = Number(await row.getAttribute('data-index'));
    const box = row.locator('[data-testid="checkbox"]');
    if ((await box.count()) > 0 && (await box.textContent())?.trim() === '☑') out.push(index);
  }
  return out.sort((a, b) => a - b);
}

async function menuStates(page: Page): Promise<string[]> {
  return page
    .getByTestId('ctx_menu')
    .locator('[data-testid="ctx_item"]')
    .evaluateAll((items) =>
      items.map((el) => (el.getAttribute('aria-disabled') === 'true' ? 'disabled' : 'normal')),
    );
}

async function menuLabels(page: Page): Promise<string[]> {
  return page
    .getByTestId('ctx_menu')
    .locator('[data-testid="ctx_item"]')
    .evaluateAll((items) => items.map((el) => (el.textContent ?? '').trim()));
}

async function clickMenu(page: Page, key: string): Promise<void> {
  await page.getByTestId('ctx_menu').locator(`[data-key="${key}"]`).click();
}

// ---------------------------------------------------------------- A1 #12 单气泡选字复制

test('A1 #12 单气泡拖选/复制/Ctrl+C/Esc/点空白清除/点勾选框不清选区', async ({ page }) => {
  const text0 = await rowText(page, '第一条消息内容');

  // 1) 拖选：window.getSelection() 与气泡正文逐字一致，松开保留
  const { from, to } = await dragFullBubble(page, '第一条消息内容');
  expect(to.x).toBeGreaterThan(from.x);
  expect(await selectionText(page)).toBe(text0);

  // 高亮贴行：选区矩形落在该气泡的上下边界内
  const box = await bubbleBox(page, '第一条消息内容');
  const rect = await page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  expect(rect).not.toBeNull();
  expect(rect!.top).toBeGreaterThanOrEqual(box.y - 2);
  expect(rect!.bottom).toBeLessThanOrEqual(box.y + box.height + 2);
  expect(rect!.left).toBeGreaterThanOrEqual(box.x - 2);
  expect(rect!.right).toBeLessThanOrEqual(box.x + box.width + 2);

  // 2) Ctrl+C：剪贴板与选中文字一致
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text0);

  // 3) Esc 清除
  await page.keyboard.press('Escape');
  expect(await selectionText(page)).toBe('');

  // 4) 再拖选后，点勾选框不清文字选区（先进入多选让勾选框出现）
  await page.getByTestId('btn_select_all').click();
  await expect(filterPage(page).locator('[data-testid="checkbox"]').first()).toBeVisible();
  await dragFullBubble(page, '第一条消息内容');
  expect(await selectionText(page)).toBe(text0);

  const secondRow = await rowByText(page, '第二条消息内容');
  await secondRow.locator('[data-testid="checkbox"]').click();
  expect(await selectionText(page)).toBe(text0);
  expect(await checkedIndexes(page)).not.toContain(1);

  // 5) 点列表空白清除
  const listBox = (await vlist(page).boundingBox())!;
  await page.mouse.click(listBox.x + 4, listBox.y + 4);
  expect(await selectionText(page)).toBe('');
});

// ---------------------------------------------------------------- A1 #13 单条内选字 vs 拖过气泡转多选

test('A1 #13 选区不跨气泡；拖过其它气泡转多选（清文字选区、勾 2 条、Esc 清空）', async ({ page }) => {
  expect(await checkboxCount(page)).toBe(0); // 勾选框默认隐藏
  const text0 = await rowText(page, '第一条消息内容');
  const text1 = await rowText(page, '第二条消息内容');

  // 1) 只在第 0 条气泡内拖动：选中本条文字，不进入多选
  await dragFullBubble(page, '第一条消息内容');
  expect(await selectionText(page)).toBe(text0);
  expect(await checkboxCount(page)).toBe(0);

  // 2) 同一次按住：从第 0 条拖到行间隙（仍钳在本条末尾，不跨条）→ 再拖进第 1 条
  const b0 = await bubbleBox(page, '第一条消息内容');
  const b1 = await bubbleBox(page, '第二条消息内容');
  await page.mouse.move(b0.x + 3, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width - 4, b0.y + b0.height / 2, { steps: 6 });
  expect(await selectionText(page)).toBe(text0);

  // 气泡下方行间隙：选区应停在第 0 条边缘，不能把第 1 条带进来
  const gapY = b0.y + b0.height + 4;
  await page.mouse.move(b0.x + 10, gapY, { steps: 4 });
  expect(await selectionText(page)).toBe(text0);

  // 拖进第 1 条气泡：文字选区作废，转跨选
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 8 });
  expect(await selectionText(page)).toBe('');
  await page.mouse.up();

  // 松开才进入多选：勾选框出现，「勾中经过的条」
  await expect(filterPage(page).locator('[data-testid="checkbox"]').first()).toBeVisible();
  expect(await checkedIndexes(page)).toEqual([0, 1]);

  // 3) 多选模式下单个气泡内拖动仍可选该条文字，且不影响已勾选
  await dragFullBubble(page, '第二条消息内容');
  expect(await selectionText(page)).toBe(text1);
  expect(await checkedIndexes(page)).toEqual([0, 1]);

  // 4) Esc 退出多选并清空
  await page.keyboard.press('Escape');
  await expect(filterPage(page).locator('[data-testid="checkbox"]')).toHaveCount(0);
  expect(await selectionText(page)).toBe('');
});

// ---------------------------------------------------------------- A1 #14 跨选保留已勾、间隙不误触、松框、Esc

test('A1 #14 跨选保留已勾、拖过行间隙不误触、松开清外框、Esc 退出', async ({ page }) => {
  // 先手动勾第 0 条（右键菜单「多选」= Tk menu.invoke 等价路径）
  const b0 = await bubbleBox(page, '第一条消息内容');
  await page.mouse.click(b0.x + b0.width / 2, b0.y + b0.height / 2, { button: 'right' });
  await clickMenu(page, 'multi_toggle');
  await expect(filterPage(page).locator('[data-testid="checkbox"]').first()).toBeVisible();
  expect(await checkedIndexes(page)).toEqual([0]);

  const b1 = await bubbleBox(page, '第二条消息内容');
  const b2 = await bubbleBox(page, '第三条消息内容');
  const b3 = await bubbleBox(page, '第四行第一段甲乙丙丁');

  // 从第 1 条按住拖到第 3 条；途中经过行间隙不应改变勾选
  await page.mouse.move(b1.x + 3, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width - 4, b1.y + b1.height / 2, { steps: 5 });

  const gapY = b1.y + b1.height + 4; // 第 1 条气泡与第 2 条气泡之间的行间隙
  await page.mouse.move(b1.x + 10, gapY, { steps: 4 });
  expect(await checkedIndexes(page)).toEqual([0]); // 空隙不误触
  expect(await filterPage(page).locator('.msg-row.cross-hl').count()).toBe(0);

  // 进入第 2 条：开始框选（保留已勾的第 0 条）
  await page.mouse.move(b2.x + 3, b2.y + b2.height / 2, { steps: 6 });
  expect(await checkedIndexes(page)).toEqual([0, 1, 2]);
  expect(await filterPage(page).locator('.msg-row.cross-hl').count()).toBeGreaterThan(0);

  // 拖到第 3 条：范围扩到 0..3
  await page.mouse.move(b3.x + 3, b3.y + b3.height / 2, { steps: 6 });
  expect(await checkedIndexes(page)).toEqual([0, 1, 2, 3]);
  await page.mouse.up();

  // 松开：外框清掉，多选保持
  expect(await filterPage(page).locator('.msg-row.cross-hl').count()).toBe(0);
  expect(await checkedIndexes(page)).toEqual([0, 1, 2, 3]);

  // Esc 退出：勾选框消失、勾选清空
  await page.keyboard.press('Escape');
  await expect(filterPage(page).locator('[data-testid="checkbox"]')).toHaveCount(0);
  expect(await selectionText(page)).toBe('');
});

// ---------------------------------------------------------------- A1 #15 右键进/出多选

test('A1 #15 右键菜单进多选（勾中点着的条）/退出清空；点外部关闭', async ({ page }) => {
  const b1 = await bubbleBox(page, '第二条消息内容');
  const center = { x: b1.x + b1.width / 2, y: b1.y + b1.height / 2 };

  // 右键 → 菜单（尚未进入多选，第四项是「多选（勾选这条消息）」）
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(page.getByTestId('ctx_menu')).toBeVisible();
  expect((await menuLabels(page))[3]).toBe('多选（勾选这条消息）');
  expect(await menuStates(page)).toEqual(['disabled', 'normal', 'normal', 'normal']);

  // 点菜单项 → 进入多选并勾中点着的条
  await clickMenu(page, 'multi_toggle');
  await expect(page.getByTestId('ctx_menu')).toHaveCount(0);
  await expect(filterPage(page).locator('[data-testid="checkbox"]').first()).toBeVisible();
  expect(await checkedIndexes(page)).toEqual([1]);

  // 再次右键 → 「退出多选（清空选择）」
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(page.getByTestId('ctx_menu')).toBeVisible();
  expect((await menuLabels(page))[3]).toBe('退出多选（清空选择）');
  await clickMenu(page, 'multi_toggle');
  await expect(filterPage(page).locator('[data-testid="checkbox"]')).toHaveCount(0);
  expect(await checkedIndexes(page)).toEqual([]);

  // 点外部关闭菜单
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(page.getByTestId('ctx_menu')).toBeVisible();
  const listBox = (await vlist(page).boundingBox())!;
  await page.mouse.click(listBox.x + 4, listBox.y + 4);
  await expect(page.getByTestId('ctx_menu')).toHaveCount(0);
});

// ---------------------------------------------------------------- A1 #15/#17 菜单项执行

test('A1 #15 菜单项执行：复制选中文字 / 复制整条消息 / 复制全部已显示消息', async ({ page }) => {
  const text1 = await rowText(page, '第二条消息内容');
  const b1 = await bubbleBox(page, '第二条消息内容');
  const center = { x: b1.x + b1.width / 2, y: b1.y + b1.height / 2 };
  // Windows 剪贴板会把 \n 规整成 \r\n，断言前统一回 \n
  const clipboard = () =>
    page.evaluate(() => navigator.clipboard.readText()).then((t) => t.replace(/\r\n/g, '\n'));

  // 复制整条消息
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await clickMenu(page, 'copy_message');
  await expect.poll(clipboard).toBe(text1);

  // 复制选中文字（先拖出一段原生选区，再右键调菜单）
  await dragFullBubble(page, '第二条消息内容');
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await clickMenu(page, 'copy_text');
  await expect.poll(clipboard).toBe(text1);

  // 复制全部已显示消息（小数据全渲染 = 7 条，按显示顺序拼接）
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await clickMenu(page, 'copy_visible');
  const expectedAll = [
    '第一条消息内容甲乙丙丁戊己庚辛',
    '第二条消息内容一二三四五六七八',
    '第三条消息内容甲乙丙丁戊己',
    '第四行第一段甲乙丙丁戊己庚辛\n第四行第二段甲乙丙丁戊己',
    '第五条消息内容一二三四五六七八',
    '运单.xlsx',
    '缺失.xlsx',
  ].join('\n');
  await expect.poll(clipboard).toBe(expectedAll);
});

// ---------------------------------------------------------------- A1 #18 菜单四项状态矩阵

test('A1 #18 右键菜单四项状态矩阵（三组位置）', async ({ page }) => {
  const b1 = await bubbleBox(page, '第二条消息内容');
  const center = { x: b1.x + b1.width / 2, y: b1.y + b1.height / 2 };
  const listBox = (await vlist(page).boundingBox())!;

  // 组 1：无选区、点在消息上
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(page.getByTestId('ctx_menu')).toBeVisible();
  expect(await menuLabels(page)).toEqual([
    '复制选中文字（Ctrl+C）',
    '复制整条消息',
    '复制全部已显示消息',
    '多选（勾选这条消息）',
  ]);
  expect(await menuStates(page)).toEqual(['disabled', 'normal', 'normal', 'normal']);

  // 组 2：有选区、点在消息上 → 四项全可用
  await page.mouse.click(listBox.x + 4, listBox.y + 4); // 关掉菜单
  await dragFullBubble(page, '第二条消息内容');
  expect(await selectionText(page)).not.toBe('');
  await page.mouse.click(center.x, center.y, { button: 'right' });
  await expect(page.getByTestId('ctx_menu')).toBeVisible();
  expect(await menuStates(page)).toEqual(['normal', 'normal', 'normal', 'normal']);

  // 组 3：选区还在、点在空白处 → 「复制整条消息」禁用
  await page.mouse.click(listBox.x + 4, listBox.y + 4, { button: 'right' });
  await expect(page.getByTestId('ctx_menu')).toBeVisible();
  expect(await menuStates(page)).toEqual(['normal', 'disabled', 'normal', 'normal']);
  // 空白右键不应清掉已有文字选区
  expect(await selectionText(page)).not.toBe('');
});

// ---------------------------------------------------------------- A1 #16 浏览模式选字

test('A1 #16 管理页浏览视图（selectable=false）仍可拖选复制，拖过气泡不转多选', async ({ page }) => {
  await page.getByTestId('tab_manage').click();
  const manage = page.getByTestId('page_manage');
  await manage.getByTestId('chat_row').first().click();
  const browseList = manage.getByTestId('message_view');
  await expect(browseList.locator('.msg-row').first()).toBeVisible();
  expect(await browseList.locator('[data-testid="checkbox"]').count()).toBe(0);

  const row0 = browseList.locator('.msg-row').filter({ hasText: '第一条消息内容' }).first();
  const row1 = browseList.locator('.msg-row').filter({ hasText: '第二条消息内容' }).first();
  const text0 = (await row0.locator('.text').textContent()) ?? '';
  const b0 = (await row0.locator('.bubble').boundingBox())!;
  const b1 = (await row1.locator('.bubble').boundingBox())!;

  // 从第 0 条拖进第 1 条：浏览模式不转多选，选区钳在第 0 条内
  await page.mouse.move(b0.x + 3, b0.y + b0.height / 2);
  await page.mouse.down();
  await page.mouse.move(b0.x + b0.width - 4, b0.y + b0.height / 2, { steps: 6 });
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 8 });
  expect(await selectionText(page)).toBe(text0);
  await page.mouse.up();
  expect(await selectionText(page)).toBe(text0);
  expect(await browseList.locator('.msg-row.cross-hl').count()).toBe(0);
  expect(await browseList.locator('[data-testid="checkbox"]').count()).toBe(0);

  // Ctrl+C 在浏览模式同样可用
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text0);

  await page.keyboard.press('Escape');
  expect(await selectionText(page)).toBe('');
});

// ---------------------------------------------------------------- A1 #17 附件单击打开 / 拖动选文件名

test('A1 #17 附件单击 → openPath 被调；拖动 → 只选文件名不打开；缺失文件仅占位', async ({ page }) => {
  const link = filterPage(page).locator('[data-testid="media_file"]').first();
  await link.scrollIntoViewIfNeeded();
  await expect(link).toContainText('运单.xlsx');
  const box = (await link.boundingBox())!;

  const opened = () =>
    page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? []);
  expect(await opened()).toEqual([]);

  // 单击 → 打开
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(opened).toEqual(['D:/mock/运单.xlsx']);

  // 拖动附件文字 → 只选文件名，不触发打开
  await page.evaluate(() => {
    (window as unknown as { __opened?: string[] }).__opened = [];
  });
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  const selected = await selectionText(page);
  expect(selected).toContain('运单.xlsx');
  await page.waitForTimeout(150);
  expect(await opened()).toEqual([]);

  // 缺失文件只有占位文本，点它不会打开
  const missing = filterPage(page).locator('[data-testid="media_missing"]').first();
  await missing.scrollIntoViewIfNeeded();
  expect(await missing.textContent()).toBe('[文件] 缺失.xlsx');
  await missing.click();
  await page.waitForTimeout(100);
  expect(await opened()).toEqual([]);
});

// ---------------------------------------------------------------- A1 #21 气泡留白开选/钳边

test('A1 #21 气泡内边距按下可开选；拖到留白选整段；拖出气泡停在本条边缘', async ({ page }) => {
  const text3 = await rowText(page, '第四行第一段');
  const b3 = await bubbleBox(page, '第四行第一段');
  const lineHeight = 22.4; // 正文 14px × 1.6

  // 1) 左侧留白按下（x 在 12px 内边距内）→ 仍产生选区；拖到右侧留白最后一行 → 整段
  const firstLineY = b3.y + 8 + lineHeight / 2;
  const lastLineY = b3.y + b3.height - 8 - lineHeight / 2;
  await page.mouse.move(b3.x + 3, firstLineY);
  await page.mouse.down();
  await page.mouse.move(b3.x + b3.width - 3, lastLineY, { steps: 10 });
  await page.mouse.up();
  expect(await selectionText(page)).toBe(text3);

  // 2) 在文字上按下、往下拖出气泡（下方行间隙）→ 停在本条末尾，不跨到第 4 条
  await page.mouse.move(b3.x + 12, b3.y + 8 + lineHeight / 2);
  await page.mouse.down();
  await page.mouse.move(b3.x + 20, b3.y + b3.height + 8, { steps: 8 });
  await page.mouse.up();
  expect(await selectionText(page)).toBe(text3);
});

// ---------------------------------------------------------------- A1 #22 滚动后拖选落点正确

test('A1 #22 虚拟列表滚动后拖选落点仍正确', async ({ page }) => {
  await installFixture(page, longFixture(600), [
    { chat: '测试群甲', chat_id: '111@chatroom', is_group: true, count: 600, last_ts: 600 },
  ]);
  await loadFixture(page, 600);

  const list = vlist(page);
  const listBox = (await list.boundingBox())!;

  // 先明显滚动一段（虚拟列表只渲染可视窗口±overscan）
  await list.evaluate((el) => {
    el.scrollTop = 12_000;
  });
  await expect
    .poll(async () => list.locator('.msg-row[data-index]').count(), { timeout: 5_000 })
    .toBeGreaterThan(0);
  await page.waitForTimeout(150);

  // 取一个完整落在可视区内的行（避开 overscan 的半截行）
  const rows = list.locator('.msg-row[data-index]');
  const total = await rows.count();
  let target: { row: ReturnType<typeof rows.nth>; index: number } | null = null;
  for (let i = 0; i < total; i++) {
    const row = rows.nth(i);
    const bb = await row.boundingBox();
    if (!bb) continue;
    if (bb.y > listBox.y + 30 && bb.y + bb.height < listBox.y + listBox.height - 30) {
      target = { row, index: Number(await row.getAttribute('data-index')) };
      break;
    }
  }
  expect(target).not.toBeNull();
  expect(target!.index).toBeGreaterThan(50); // 确认确实滚动到了很后面

  const bubble = target!.row.locator('.bubble');
  const box = (await bubble.boundingBox())!;
  const expected = (await target!.row.locator('.text').textContent()) ?? '';

  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await selectionText(page)).toBe(expected);

  // Esc 清除，保证不残留
  await page.keyboard.press('Escape');
  expect(await selectionText(page)).toBe('');
});

// ---------------------------------------------------------------- A1 #23 替代：无 >100ms 长任务

test('A1 #23 替代验收：进出多选与跨选拖动无 >100ms 长任务', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration > 100) w.__longTasks.push(entry.duration);
      }
    }).observe({ entryTypes: ['longtask'] });
  });

  // 全选/清空（进入/退出多选）与跨选拖动
  await page.getByTestId('btn_select_all').click();
  await expect(filterPage(page).locator('[data-testid="checkbox"]').first()).toBeVisible();
  await page.getByTestId('btn_select_none').click();
  await page.keyboard.press('Escape');

  const b1 = await bubbleBox(page, '第二条消息内容');
  const b3 = await bubbleBox(page, '第四行第一段甲乙丙丁');
  await page.mouse.move(b1.x + 3, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b3.x + 3, b3.y + b3.height / 2, { steps: 20 });
  await page.mouse.up();

  const longTasks = await page.evaluate(
    () => (window as unknown as { __longTasks: number[] }).__longTasks,
  );
  expect(longTasks).toEqual([]);
});
