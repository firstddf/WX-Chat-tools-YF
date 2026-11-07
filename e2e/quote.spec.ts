// 引用跳转 / 闪烁 / 回跳验收（docs/04 A1 #19/#20；docs/01 D5）——必须真鼠标 + 真 CSS 动画：
// jsdom 没有布局与动画，`.flash` 何时消失、拖动是否被认成单击只能在这里跑。
//   1) 单击引用块 → 目标消息进入可视区 + `.flash` 出现且 QUOTE_FLASH_MS 后消失（animationend 摘类）；
//   2) 在引用文字上拖动（>4px）→ 只选字，不跳转；
//   3) 跳转后「↩ 返回」→ 回到跳转前的滚动位置；Esc 同效；
//   4) 无 svrid 的导出来源按内容匹配（#20）；目标不存在 → 提示条、不闪烁。
// 数据注入方式同 e2e/selection.spec.ts：页面内改 MockIpc.prototype.loadData（不碰 src/）。
import { expect, test, type Page } from '@playwright/test';
import type { Message } from '../src/ipc/types';
import { QUOTE_FLASH_MS, QUOTE_RETURN_VISIBLE_MS } from '../src/logic/quote';

test.use({ viewport: { width: 1400, height: 1000 } });

const ADDR = '门店地址，黑龙江省齐齐哈尔市龙沙区龙沙小区9号楼1单元7门市西龄鸟';
const EXPRESS = '明天下午发顺丰，单号 JT0000000000000';

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

/** 41 条：长列表让「跳转 → 返回」有明显位移；末尾四条覆盖 svrid / 内容匹配 / 找不到三种引用 */
function buildFixture(): Message[] {
  const messages = Array.from({ length: 41 }, (_, i) =>
    msg({ ts: i + 1, local_id: i, text: `第 ${i} 条消息：今天的发货安排确认一下，收到请回复。` }),
  );
  messages[0] = msg({ ts: 1, local_id: 0, text: ADDR, server_id: 123456789 });
  // 找不到：引用的内容在列表里不存在（被筛选过滤/正文匹配不上 → 提示条）
  messages[36] = msg({
    ts: 37,
    local_id: 36,
    mtype: 'quote',
    text: '好的\n[引用 老王] 完全不存在的引用内容甲乙丙丁戊',
  });
  // #20 导出来源：没有 quote_svrid，只有拍平正文，按内容匹配
  messages[37] = msg({ ts: 38, local_id: 37, text: EXPRESS, server_id: 800 });
  messages[38] = msg({
    ts: 39,
    local_id: 38,
    mtype: 'quote',
    text: `好的\n[引用 王五] ${EXPRESS}`,
    source: 'export',
  });
  // #19 store 来源：quote_svrid 精确跳转
  messages[39] = msg({
    ts: 40,
    local_id: 39,
    mtype: 'quote',
    text: `收到，安排\n[引用 遇见] ${ADDR}`,
    quote_sender: '遇见',
    quote_text: ADDR,
    quote_svrid: 123456789,
  });
  return messages;
}

const FIXTURE = buildFixture();
const CHATS = [{ chat: '测试群甲', chat_id: '111@chatroom', is_group: true, count: FIXTURE.length, last_ts: 41 }];

/** 替换页面已加载模块实例的 MockIpc.prototype.loadData（Vite dev 的模块带 ?t= 参数，按资源 URL 找） */
async function installFixture(page: Page, messages: Message[]): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }) => {
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
      const mod = await import(url);
      mod.MockIpc.prototype.loadData = async () => ({
        source: 'store',
        chats,
        messages,
        stats: {
          messages: messages.length,
          chats: chats.length,
          media: 0,
          first_ts: messages[0]?.ts ?? 0,
          last_ts: messages[messages.length - 1]?.ts ?? 0,
        },
      });
    },
    { messages, chats: CHATS },
  );
}

function filterPage(page: Page) {
  return page.getByTestId('page_filter');
}

function vlist(page: Page) {
  return filterPage(page).getByTestId('message_view');
}

function rowByIndex(page: Page, index: number) {
  return filterPage(page).locator(`.msg-row[data-index="${index}"]`);
}

function quoteBlockByIndex(page: Page, index: number) {
  return rowByIndex(page, index).locator('[data-testid="quote_block"]');
}

async function scrollTop(page: Page): Promise<number> {
  return vlist(page).evaluate((el) => el.scrollTop);
}

/** 目标行「在位」：整行落在消息列表可视区内（虚拟列表滚动到位，而不是仅仅存在于 DOM） */
async function expectRowInView(page: Page, index: number): Promise<void> {
  const listBox = (await vlist(page).boundingBox())!;
  const row = rowByIndex(page, index);
  await expect(row).toHaveCount(1);
  const box = (await row.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(listBox.y - 1);
  expect(box.y + box.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1);
}

/** 单击引用块正中（真实鼠标事件序列：mousedown → mouseup → click） */
async function clickQuote(page: Page, index: number): Promise<void> {
  const block = quoteBlockByIndex(page, index);
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();
  const box = (await block.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await installFixture(page, FIXTURE);
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText(`共 ${FIXTURE.length} 条消息`, {
    timeout: 15_000,
  });
});

// ---------------------------------------------------------------- A1 #19 渲染 + 跳转 + 闪烁

test('A1 #19 引用块单行省略/正文剥离；单击 → 目标在位 + .flash 1.4s 后消失', async ({ page }) => {
  // 1) 渲染：类名 + 文案 + 单行省略的计算样式；气泡正文剥掉 [引用 行
  const block = quoteBlockByIndex(page, 39);
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();
  await expect(block).toContainText(`遇见: ${ADDR}`);
  const style = await block.evaluate((el) => {
    const s = getComputedStyle(el);
    return { overflow: s.overflow, textOverflow: s.textOverflow, whiteSpace: s.whiteSpace };
  });
  expect(style.overflow).toBe('hidden');
  expect(style.textOverflow).toBe('ellipsis');
  expect(style.whiteSpace).toBe('nowrap');
  await expect(rowByIndex(page, 39).locator('.text')).toHaveText('收到，安排');
  await expect(rowByIndex(page, 39)).not.toContainText('[引用');

  const before = await scrollTop(page);
  expect(before).toBeGreaterThan(0); // 引用在列表末尾，跳转会明显上移

  // 2) 单击：目标（第 0 条原消息）滚进可视区
  await clickQuote(page, 39);
  await expectRowInView(page, 0);
  expect(await scrollTop(page)).toBeLessThan(before);

  // 3) 目标气泡出现 .flash，并在动画结束后自动消失（animationend 摘类，无残留定时器）
  const flash = rowByIndex(page, 0).locator('.bubble.flash');
  await expect(flash).toHaveCount(1);
  await expect(flash).toBeVisible();
  await expect(rowByIndex(page, 0).locator('.bubble.flash')).toHaveCount(0, {
    timeout: QUOTE_FLASH_MS + 2000,
  });
});

// ---------------------------------------------------------------- A1 #19 拖动不跳

test('A1 #19 在引用文字上拖动（>4px）→ 只选字，不跳转、不滚动、无提示条', async ({ page }) => {
  const block = quoteBlockByIndex(page, 39);
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();
  const before = await scrollTop(page);

  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  // 拖动确实选中了引用文字（是选字手势，不是单击）
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.length).toBeGreaterThan(0);

  await page.waitForTimeout(150); // 给可能的误跳转留出时间
  await expect(page.locator('.bubble.flash')).toHaveCount(0);
  expect(Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2);
  await expect(page.getByTestId('quote_notice')).toHaveCount(0);
});

// ---------------------------------------------------------------- A1 #19 回跳

test('A1 #19 跳转后「↩ 返回」回到原位置；Esc 同效', async ({ page }) => {
  // 先把引用块滚进可视区（引用在列表末尾），再记录「跳转前位置」
  const block = quoteBlockByIndex(page, 39);
  await block.scrollIntoViewIfNeeded();
  await expect(block).toBeVisible();
  const before = await scrollTop(page);
  expect(before).toBeGreaterThan(0); // 确认记录的是非零位置，回跳才有意义

  const box = (await block.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expectRowInView(page, 0);

  // 返回入口在跳转后出现（3s 内可见），点击回到跳转前的 scrollTop
  const back = page.getByTestId('quote_return');
  await expect(back).toBeVisible({ timeout: QUOTE_RETURN_VISIBLE_MS });
  await expect(back).toContainText('返回');
  await back.click();
  await expect.poll(async () => Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2);
  await expect(back).toHaveCount(0); // 用过即清（连同回跳记录）

  // Esc 也能回跳：再跳一次，按 Esc 回到原位置
  await clickQuote(page, 39);
  await expectRowInView(page, 0);
  await page.keyboard.press('Escape');
  await expect.poll(async () => Math.abs((await scrollTop(page)) - before)).toBeLessThanOrEqual(2);
});

// ---------------------------------------------------------------- A1 #20 内容匹配 + 找不到提示

test('A1 #20 无 svrid 按内容匹配跳转；目标不存在 → 提示条且不闪烁', async ({ page }) => {
  // 导出风格引用（只有拍平正文）：单击 → 内容匹配到第 37 条「明天下午发顺丰…」
  await clickQuote(page, 38);
  await expectRowInView(page, 37);
  await expect(rowByIndex(page, 37).locator('.bubble.flash')).toHaveCount(1);
  await expect(page.locator('.bubble.flash')).toHaveCount(0, { timeout: QUOTE_FLASH_MS + 2000 });

  // 找不到原消息：出提示条（文案同 Tk _warn），不闪烁、不记录回跳
  await clickQuote(page, 36);
  const notice = page.getByTestId('quote_notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('没有找到被引用的原消息');
  await expect(page.locator('.bubble.flash')).toHaveCount(0);
  await expect(page.getByTestId('quote_return')).toHaveCount(0);
});
