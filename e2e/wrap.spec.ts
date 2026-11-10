// C 类换行向量回归（docs/07 #9 / docs/04 C 清单）——
// Tk `test_chatview.py::test_split_lines_wrapping` 的输入向量移植：
// TS 侧无对应换行函数（换行由 CSS `white-space: pre-wrap` + `word-break` 承载，
// 浏览器排版天然正确）→ 按 docs/07 #9 fallback 口径：向量固化为 e2e 视觉回归——
//   1) 中文逐字断行  2) 空格断行  3) \n 显式换行  4) 单字超宽不死循环/不溢出
//   5) 空文本不渲染正文（不炸）；统一断言「不丢字（textContent 往返）+ 不溢出 + 行盒数」。
import { expect, test, type Page } from '@playwright/test';
import type { Chat, Message } from '../src/ipc/types';

test.use({ viewport: { width: 1400, height: 1000 } });

// ---------------------------------------------------------------- 确定性 fixture

const CHAT_ID = '990001@chatroom';

function msg(partial: Partial<Message> & { ts: number; text: string }): Message {
  return {
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '换行向量群',
    chat_id: CHAT_ID,
    sender: '李四',
    sender_id: 'wxid_li',
    is_mine: false,
    mtype: 'text',
    truncated: false,
    is_group: true,
    local_id: partial.ts,
    server_id: partial.ts * 7 + 1,
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

// 向量输入（= Tk _split_lines 的入参；出参由浏览器排版承载）
const V = {
  // Tk: _split_lines("一二三四五六七八九十", ...) → 逐字断行（中文无空格）
  chinese: '换行向量甲' + '一二三四五六七八九十'.repeat(6), // 60 中文字 → 必然多行
  // Tk: _split_lines("aaa bbb ccc ddd eee", ...) → 空格处断行
  spaces: '换行向量乙 ' + 'word '.repeat(30),
  // Tk: _split_lines("a\nbb", ...) → 显式换行符必须保留（pre-wrap）
  newline: '换行向量丙\n第二行内容',
  // Tk: _split_lines("超宽字", 小行宽, ...) → 单字逐个成行（不能死循环/丢字）
  // 60 字 × 14px = 840px > 气泡 max-width 680px → 必然逐字断行
  wide: '换行向量丁' + '超'.repeat(60),
  // Tk: _split_lines("", ...) → 空串不炸
  empty: '',
};

const FIXTURE_MESSAGES: Message[] = [
  msg({ ts: 1, text: V.chinese }),
  msg({ ts: 2, text: V.spaces }),
  msg({ ts: 3, text: V.newline }),
  msg({ ts: 4, text: V.wide }),
  msg({ ts: 5, text: V.empty }),
];

const FIXTURE_CHATS: Chat[] = [
  { chat: '换行向量群', chat_id: CHAT_ID, is_group: true, count: FIXTURE_MESSAGES.length, last_ts: 5 },
];

/** 替换页面已加载的 MockIpc.prototype.loadData（同 e2e/tabs.spec 的做法） */
async function installFixture(page: Page): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }: { messages: Message[]; chats: Chat[] }) => {
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
    { messages: FIXTURE_MESSAGES, chats: FIXTURE_CHATS },
  );
}

/** 行盒统计：Range.getClientRects 每行一个盒（块级 getClientRects 只回 1 个，必须用 Range）。
 *  行数按矩形 y 去重——Chromium 会对 `\n` 字符本身多回一个零宽碎片（实测 3 盒/2 行）。 */
async function lineStats(page: Page): Promise<
  Array<{ text: string; lines: number; overflow: boolean }>
> {
  return page.evaluate(() => {
    const out: Array<{ text: string; lines: number; overflow: boolean }> = [];
    for (const el of document.querySelectorAll('.bubble .text')) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set(
        [...range.getClientRects()]
          .filter((r) => r.width > 0 || r.height > 0)
          .map((r) => Math.round(r.top)),
      );
      out.push({
        text: el.textContent ?? '',
        lines: tops.size,
        overflow: el.scrollWidth > el.clientWidth + 1,
      });
    }
    return out;
  });
}

// ---------------------------------------------------------------- 向量回归

test('C 换行向量：中文逐字/空格/\\n/超宽单字/空串 —— 不丢字、不溢出、行盒正确', async ({ page }) => {
  await page.goto('/');
  await installFixture(page);
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText('共 5 条消息');

  // 按群号筛出 5 条向量（空文本消息不含关键词，故按 chat 过滤）
  await page.getByTestId('entry_chat').fill(CHAT_ID);
  await page.getByTestId('entry_chat').press('Enter');
  await expect(page.getByTestId('lbl_status')).toContainText('匹配 5 条');

  const stats = await lineStats(page);
  const byPrefix = (p: string) => {
    const hit = stats.find((s) => s.text.startsWith(p));
    expect(hit, `应渲染含「${p}」的正文`).toBeTruthy();
    return hit!;
  };

  // 1) 中文逐字断行：多行 + 不丢字（textContent 往返 = 输入）
  const cn = byPrefix('换行向量甲');
  expect(cn.text).toBe(V.chinese);
  expect(cn.lines).toBeGreaterThan(1);
  expect(cn.overflow).toBe(false);

  // 2) 空格断行：多行 + 不丢字（含尾随空格，pre-wrap 保留）
  const sp = byPrefix('换行向量乙');
  expect(sp.text).toBe(V.spaces);
  expect(sp.lines).toBeGreaterThan(1);
  expect(sp.overflow).toBe(false);

  // 3) 显式换行：恰好 2 个行盒（\n 保留为真实换行，pre-wrap）
  const nl = byPrefix('换行向量丙');
  expect(nl.text).toBe(V.newline);
  expect(nl.lines).toBe(2);
  expect(nl.overflow).toBe(false);

  // 4) 超宽单字：逐字断行（多行）+ 不丢字 + 不溢出（= Tk「不死循环」的浏览器等价）
  const wd = byPrefix('换行向量丁');
  expect(wd.text).toBe(V.wide);
  expect(wd.lines).toBeGreaterThan(1);
  expect(wd.overflow).toBe(false);

  // 5) 空串：行渲染（行在），但不渲染正文 <p class="text">（v-if，不炸）
  const rows = page.locator('.msg-row');
  await expect(rows).toHaveCount(5);
  const emptyRow = rows.last();
  await expect(emptyRow.locator('.bubble')).toHaveCount(1);
  await expect(emptyRow.locator('.text')).toHaveCount(0);

  // 统一：气泡不横向溢出列表（A1 #11 同口径；message_view 筛选页/管理页各一个，取筛选页）
  const listBox = (await page.getByTestId('page_filter').getByTestId('message_view').boundingBox())!;
  for (const b of await page.locator('.bubble').all()) {
    const box = (await b.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(listBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
  }
});
