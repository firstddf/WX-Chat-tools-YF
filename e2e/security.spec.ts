// C 类双轨前端移植（docs/04 §C）：`script_injection_escaped` → XSS 转义；
// `no_external_links` → 应用零外链。源断言来自 wxchart-tool/tests/test_filter_page.py，
// 在 web 端的等价验收是「不可信文本按纯文本插值渲染 + 渲染后 DOM 无任何外链资源」。
//
// 数据注入同 e2e/selection.spec.ts：页面内替换已加载 mock.ts 模块实例的
// MockIpc.prototype.loadData（不碰 src/）。
import { expect, test, type Page } from '@playwright/test';
import type { Chat, Message } from '../src/ipc/types';

test.use({ viewport: { width: 1400, height: 1000 } });

interface WindowHooks {
  __xssFired?: number;
}

// ---------------------------------------------------------------- fixture 工具

function msg(partial: Partial<Message> & { ts: number }): Message {
  return {
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '安全测试群',
    chat_id: '33334444@chatroom',
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

function fixtureOf(messages: Message[]): { messages: Message[]; chats: Chat[] } {
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

async function installFixture(
  page: Page,
  messages: Message[],
  chats: Chat[],
): Promise<void> {
  await page.evaluate(
    async ({ messages, chats }: { messages: Message[]; chats: Chat[] }) => {
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
    },
    { messages, chats },
  );
}

async function gotoAndLoad(page: Page, messages: Message[]): Promise<void> {
  const fixture = fixtureOf(messages);
  await page.goto('/');
  await installFixture(page, fixture.messages, fixture.chats);
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText(
    `共 ${messages.length} 条消息`,
    { timeout: 15_000 },
  );
}

// ---------------------------------------------------------------- C XSS 转义

// 源测试 XSS_TEXT 的等价向量：换行 + script 闭合 + 行内标签 + 引号 + &，外加真实链接文本。
const XSS_TEXT = [
  '第一行',
  '第二行 </script><script>window.__xssFired=1</script>',
  '<img src=x onerror="window.__xssFired=2">',
  '<b>加粗</b> & "双引号" \'单引号\'',
  '详情见 https://evil.example/x?y=1',
].join('\n');
const XSS_SENDER = '<img src=1 onerror="window.__xssFired=3">李四';
const XSS_MEDIA_NAME = '<img src=x onerror="window.__xssFired=4">图片.png';
const XSS_FILE_NAME = '<script>window.__xssFired=5</script>附件.txt';

const XSS_MESSAGES: Message[] = [
  msg({ ts: 1, day: '2026-10-01', text: XSS_TEXT, sender: '李四' }),
  msg({ ts: 2, day: '2026-10-01', text: '发送人名注入测试', sender: XSS_SENDER }),
  msg({
    ts: 3,
    day: '2026-10-01',
    mtype: 'image',
    sender: '王五',
    media: [{ kind: 'image', name: XSS_MEDIA_NAME, path: '', rel_path: '', size: 0, decoded: false }],
  }),
  msg({
    ts: 4,
    day: '2026-10-01',
    mtype: 'file',
    sender: '王五',
    media: [{ kind: 'file', name: XSS_FILE_NAME, path: 'D:/mock/附件.txt', rel_path: '', size: 1, decoded: false }],
  }),
  msg({ ts: 5, day: '2026-10-01', mtype: 'system', sender: '系统', text: '<script>window.__xssFired=6</script>系统消息' }),
];

test('C XSS：消息正文/发送人/附件名按纯文本渲染，脚本与 onerror 不执行', async ({ page }) => {
  const dialogs: string[] = [];
  const pageErrors: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/');
  // 注入执行哨兵：任何被注入的脚本/事件处理器执行都会把它改掉
  await page.evaluate(() => {
    (window as WindowHooks).__xssFired = 0;
  });

  const fixture = fixtureOf(XSS_MESSAGES);
  await installFixture(page, fixture.messages, fixture.chats);
  await page.getByTestId('btn_load').click();
  await expect(page.getByTestId('lbl_status')).toContainText(
    `共 ${XSS_MESSAGES.length} 条消息`,
    { timeout: 15_000 },
  );
  // 等可能的 onerror 异步回调跑完再断言
  await page.waitForTimeout(300);

  const filterPage = page.getByTestId('page_filter');

  // 1) 正文逐字按纯文本显示（textContent 含原始 <img>/<script> 字符串）
  const textRow = filterPage.locator('.msg-row[data-index="0"]');
  const renderedText = await textRow.locator('.text').evaluate((el) => el.textContent ?? '');
  expect(renderedText).toBe(XSS_TEXT);

  // 2) 发送人名同样按纯文本显示
  const senderRow = filterPage.locator('.msg-row[data-index="1"]');
  const renderedSender = await senderRow.locator('.msg-sender').evaluate((el) => el.textContent ?? '');
  expect(renderedSender).toBe(XSS_SENDER);

  // 3) 附件名按纯文本显示（缺失图片占位 / 可打开文件按钮文案）
  const missing = filterPage.getByTestId('media_missing').first();
  expect(await missing.evaluate((el) => el.textContent ?? '')).toBe(`[图片] ${XSS_MEDIA_NAME}`);
  const fileLink = filterPage.getByTestId('media_file').first();
  expect(await fileLink.evaluate((el) => el.textContent ?? '')).toContain(XSS_FILE_NAME);

  // 4) 注入的标签没有变成实际元素/属性：无 <script>、无 <img src=x>、无 onerror
  const dom = await page.evaluate(() => ({
    appScripts: document.querySelectorAll('#app script').length,
    onerrorAttrs: document.querySelectorAll('[onerror]').length,
    textImgs: document.querySelectorAll('.text img').length,
    textBold: document.querySelectorAll('.text b').length,
    injectedImg: document.querySelectorAll('.media img[src="x"]').length,
    xssFired: (window as WindowHooks).__xssFired,
  }));
  expect(dom.appScripts).toBe(0);
  expect(dom.onerrorAttrs).toBe(0);
  expect(dom.textImgs).toBe(0);
  expect(dom.textBold).toBe(0);
  expect(dom.injectedImg).toBe(0);
  // 5) 没有任何脚本执行 / 弹窗 / 未捕获异常
  expect(dom.xssFired).toBe(0);
  expect(dialogs).toEqual([]);
  expect(pageErrors).toEqual([]);
  await expect(filterPage.locator('.msg-row')).toHaveCount(XSS_MESSAGES.length);
});

// ---------------------------------------------------------------- C 零外链

const LINK_TEXT = '详情见 https://evil.example/a?b=1 或 http://evil.example/b（正文里的链接，不是外部资源）';

const LINK_MESSAGES: Message[] = [
  msg({ ts: 1, day: '2026-10-01', text: LINK_TEXT, sender: '李四' }),
  msg({
    ts: 2,
    day: '2026-10-01',
    mtype: 'image',
    sender: '王五',
    // 本地缩略图：http 检查要有真实的 img 才不是空断言
    media: [
      {
        kind: 'image',
        name: '本地图片.png',
        path: 'D:/mock/本地图片.png',
        rel_path: '安全测试群/2026-10/本地图片.png',
        size: 1024,
        decoded: true,
      },
    ],
  }),
];

test('C 零外链：渲染后 DOM 无 http(s) 资源 / 正文链接只是文本', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (!/^https?:\/\//.test(url)) return;
    const host = new URL(url).hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') externalRequests.push(url);
  });

  await gotoAndLoad(page, LINK_MESSAGES);

  // 1) 隐藏/可见页面 + 消息列表都渲染完成后，资源属性指向外链的数量必须为 0
  const external = await page.evaluate(() => {
    const count = (selector: string) => document.querySelectorAll(selector).length;
    return {
      anchors: count('a[href^="http"]'),
      images: count('img[src^="http"]'),
      links: count('link[href^="http"]'),
      scripts: count('script[src^="http"]'),
      srcset: count('[srcset*="http"]'),
      poster: count('[poster^="http"]'),
      inline: count('[style*="http"]'),
    };
  });
  expect(external).toEqual({
    anchors: 0,
    images: 0,
    links: 0,
    scripts: 0,
    srcset: 0,
    poster: 0,
    inline: 0,
  });

  // 2) 本地图片消息：无论渲染成 <img> 还是本地占位，都不得引入外链资源
  //    （浏览器 dev 里 D:/... 路径无法加载 → MediaThumb 降级为「[图片] 名」占位，属预期）
  const filterPage = page.getByTestId('page_filter');
  const media = filterPage.locator('.msg-row[data-index="1"] .media');
  await expect(media).toBeVisible();
  const imgSrcs = await page
    .locator('img')
    .evaluateAll((els) => els.map((el) => el.getAttribute('src') ?? ''));
  for (const src of imgSrcs) expect(src).not.toMatch(/^https?:/);
  const renderedMedia = await media.evaluate((el) => el.textContent ?? '');
  expect((await media.locator('img').count()) > 0 || renderedMedia.includes('本地图片.png')).toBe(
    true,
  );

  // 3) 正文里的 http 链接是内容不是资源：保持纯文本、不生成 <a>
  const linkRow = filterPage.locator('.msg-row[data-index="0"]');
  expect(await linkRow.locator('.text').evaluate((el) => el.textContent ?? '')).toBe(LINK_TEXT);
  await expect(linkRow.locator('a')).toHaveCount(0);

  // 4) 全程没有向外域发起 http(s) 请求（只允许 Vite dev server 自身的 http://localhost）
  expect(externalRequests).toEqual([]);
});
