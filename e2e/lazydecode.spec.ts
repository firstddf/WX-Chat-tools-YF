// 图片懒解码真浏览器验收（docs/02 §1.2/§2 `resolve_media`；docs/05 §8.1 P0）——
// 加载期图片只定位不解码（media[].decoded=false、path=""）→ 渲染「[图片] 名」占位；
// 缩略图挂载即把消息全量下标排进 store 的解码队列，按需解码：
//   1) 注入钩子回 decoded 数据 → 占位换成 <img>（src 可加载、naturalWidth>0）；
//   2) 默认实现（原样返回 = 解不出）→ 占位保持，且只发一次 resolve_media（无重试死循环）。
// 数据注入沿用 e2e/selection.spec.ts：页面内 import 已加载的 mock.ts 实例换 loadData，
// 再包一层 resolveMedia 做调用录制 + 门闩（控制解码完成时机；不碰 src/ 下任何文件）。
import { expect, test, type Page } from '@playwright/test';
import type { Chat, Message } from '../src/ipc/types';

test.use({ viewport: { width: 1400, height: 1000 } });

/** 1×1 透明 GIF dataURL：fileSrc 在非 Tauri 环境原样返回，浏览器里可直接加载 */
const THUMB_DATA_URL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function msg(partial: Partial<Message> & { ts: number }): Message {
  return {
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '懒解码测试群',
    chat_id: '55556666@chatroom',
    sender: '张三',
    sender_id: 'wxid_zhang',
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

/** 3 条：图片消息在全量下标 1（懒解码入参断言用） */
const MESSAGES: Message[] = [
  msg({ ts: 1, text: '第一条消息内容' }),
  msg({
    ts: 2,
    mtype: 'image',
    text: '',
    media: [
      {
        kind: 'image',
        name: '懒解码.png',
        path: '',
        rel_path: '会话/2026-10/懒解码.png',
        size: 1024,
        decoded: false,
      },
    ],
  }),
  msg({ ts: 3, text: '第三条消息内容' }),
];

const CHATS: Chat[] = [
  { chat: '懒解码测试群', chat_id: '55556666@chatroom', is_group: true, count: 3, last_ts: 3 },
];

interface WindowWithResolve extends Window {
  __resolveCalls?: number[][];
  __releaseResolve?: () => void;
}

/**
 * 注入 fixture + 包一层 `MockIpc.prototype.resolveMedia`：
 * - `decode:true` → 门闩挂起，测试先断言占位，再放行回「已解码」数据；
 * - `decode:false` → 转调默认实现（原样返回，模拟解不出）。
 */
async function install(page: Page, decode: boolean): Promise<void> {
  await page.evaluate(
    async ({ messages, chats, decode, thumb }: { messages: Message[]; chats: Chat[]; decode: boolean; thumb: string }) => {
      const entries = performance.getEntriesByType('resource').map((e) => e.name);
      const url = entries.find((n) => /\/src\/ipc\/mock\.ts/.test(n)) ?? '/src/ipc/mock.ts';
      const mod = await import(url);
      const w = window as WindowWithResolve;
      w.__resolveCalls = [];
      const stats = {
        messages: messages.length,
        chats: chats.length,
        media: messages.reduce((n, m) => n + m.media.length, 0),
        first_ts: messages[0]?.ts ?? 0,
        last_ts: messages[messages.length - 1]?.ts ?? 0,
      };
      mod.MockIpc.prototype.loadData = async () => ({ source: 'store', chats, messages, stats });
      const orig = mod.MockIpc.prototype.resolveMedia;
      mod.MockIpc.prototype.resolveMedia = async function (indexes: number[]) {
        w.__resolveCalls!.push([...indexes]);
        if (decode) {
          await new Promise<void>((resolve) => {
            w.__releaseResolve = resolve; // 门闩：测试显式放行解码完成
          });
          return {
            items: indexes.map((index) => ({
              index,
              media: (messages[index]?.media ?? []).map((m) => ({ ...m, decoded: true, path: thumb })),
            })),
          };
        }
        return orig.call(this, indexes); // 默认实现：原样返回（解不出 → 占位不破）
      };
    },
    { messages: MESSAGES, chats: CHATS, decode, thumb: THUMB_DATA_URL },
  );
}

async function load(page: Page): Promise<void> {
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText(`共 ${MESSAGES.length} 条消息`, {
    timeout: 15_000,
  });
}

function filterPage(page: Page) {
  return page.getByTestId('page_filter');
}

function resolveCalls(page: Page): Promise<number[][]> {
  return page.evaluate(() => (window as WindowWithResolve).__resolveCalls ?? []);
}

// ---------------------------------------------------------------- 懒解码：解得出

test('懒解码：加载期占位 → 解码响应回来后缩略图 <img> 出现且可加载', async ({ page }) => {
  await page.goto('/');
  await install(page, true);
  await load(page);

  // 加载期只定位不解码：占位先在（解码请求被门闩挂起，绝不会先出图）
  await expect(filterPage(page).getByTestId('media_missing')).toHaveText('[图片] 懒解码.png');
  await expect(filterPage(page).getByTestId('media_thumb_img')).toHaveCount(0);

  // 懒解码请求已发出，入参是消息全量下标（图片消息在第 1 条）
  await expect.poll(() => resolveCalls(page)).toEqual([[1]]);

  // 放行解码 → 占位换成 <img>（src 可加载：naturalWidth>0 = 真解码出的图）
  await page.evaluate(() => (window as WindowWithResolve).__releaseResolve?.());
  const img = filterPage(page).getByTestId('media_thumb_img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', THUMB_DATA_URL);
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(filterPage(page).getByTestId('media_missing')).toHaveCount(0);

  // 去重/不重试：解码成功后不再发第二次 resolve_media
  await page.waitForTimeout(400);
  expect(await resolveCalls(page)).toEqual([[1]]);
});

// ---------------------------------------------------------------- 懒解码：解不出

test('懒解码解不出（默认 mock 原样返回）→ 占位保持且只发一次 resolve_media（无重试死循环）', async ({ page }) => {
  await page.goto('/');
  await install(page, false);
  await load(page);

  const missing = filterPage(page).getByTestId('media_missing');
  await expect(missing).toHaveText('[图片] 懒解码.png');
  await expect(filterPage(page).getByTestId('media_thumb_img')).toHaveCount(0);

  // 请求发过一次（响应里仍 decoded=false → 记入解码失败 key）
  await expect.poll(() => resolveCalls(page)).toEqual([[1]]);

  // 观察窗口内不再重试：既不发第二次请求，也不闪 <img>
  await page.waitForTimeout(600);
  expect(await resolveCalls(page)).toEqual([[1]]);
  await expect(filterPage(page).getByTestId('media_thumb_img')).toHaveCount(0);
  await expect(missing).toHaveText('[图片] 懒解码.png');
});
