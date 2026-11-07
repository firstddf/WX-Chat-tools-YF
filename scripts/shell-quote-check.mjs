// 真机验收：引用跳转 / 闪烁 / 回跳 / 拖动不误跳（A1 #19/#20）
// 前置：应用以 --remote-debugging-port=9222 启动、vite 5173 在跑、已加载真实数据。
// 用法：node scripts/shell-quote-check.mjs [--port 9222]
import { chromium } from '@playwright/test';

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9222);
const results = [];
const step = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
if (!(await page.isVisible('[data-testid="page_filter"]').catch(() => false))) {
  await page.click('[data-testid="tab_filter"]').catch(() => null);
}
await page.waitForSelector('[data-testid="message_view"]', { timeout: 60000 });
const status = async () => ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
const scrollTop = () => page.$eval('[data-testid="message_view"]', (el) => el.scrollTop);

if (!/共 \d+ 条消息/.test(await status())) {
  await page.click('[data-testid="btn_load"]');
  await page.waitForFunction(() => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''), null, { timeout: 300000 });
}

/** 在滚动容器「可视区内」找一个引用块（必要时小步滚动），返回新鲜坐标 */
async function findVisibleQuote() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const hit = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="message_view"]');
      const vr = view.getBoundingClientRect();
      const els = [...document.querySelectorAll('[data-testid="quote_block"]')];
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (r.height > 0 && cy > vr.top + 40 && cy < vr.bottom - 40 && cx > vr.left + 10 && cx < vr.right - 10) {
          const row = els[i].closest('[data-testid="msg_row"]');
          return { i, x: Math.round(cx), y: Math.round(cy), idx: row?.dataset.index, text: (els[i].textContent || '').trim().slice(0, 34) };
        }
      }
      return null;
    });
    if (hit) return hit;
    await page.evaluate(() => {
      const v = document.querySelector('[data-testid="message_view"]');
      v.scrollTop += 600;
      v.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await sleep(150);
  }
  return null;
}

const found = await findVisibleQuote();
step('真实数据里找到可视区内的引用块', found !== null, found ? `index=${found.idx} 「${found.text}」` : '未找到（当前账号数据可能无引用消息）');

if (found) {
  // 把该块移到容器中部，保证鼠标坐标可靠
  await page.evaluate((i) => {
    const el = document.querySelectorAll('[data-testid="quote_block"]')[i];
    if (el) el.scrollIntoView({ block: 'center' });
  }, found.i);
  await sleep(250);
  const pos = await page.evaluate((i) => {
    const el = document.querySelectorAll('[data-testid="quote_block"]')[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, found.i);

  const before = await scrollTop();
  await page.mouse.click(pos.x, pos.y);
  await sleep(300);
  const afterClick = await page.evaluate(() => ({
    scrollTop: document.querySelector('[data-testid="message_view"]')?.scrollTop,
    // 闪烁类挂在气泡上（.bubble.flash），行号要从其最近的 msg_row 取
    flash: (() => {
      const el = document.querySelector('.flash');
      if (!el) return null;
      const row = el.closest('[data-testid="msg_row"]');
      return row ? row.dataset.index : 'found';
    })(),
    ret: Boolean(document.querySelector('[data-testid="quote_return"]')),
    notice: document.querySelector('[data-testid="quote_notice"]')?.textContent?.trim() || null,
  }));
  step('单击引用块 → 跳转并闪烁', afterClick.flash !== null && afterClick.notice === null, afterClick.flash !== null ? `闪到 index=${afterClick.flash}` : `flash 未出现（notice=${afterClick.notice}）`);
  step('跳转滚动位置发生变化', afterClick.scrollTop !== before, `scrollTop ${Math.round(before)} → ${Math.round(afterClick.scrollTop)}`);
  await page.screenshot({ path: 'test-results/real-acceptance/shell-quote-jump.png' });
  await sleep(1500);
  step('约 1.4s 后闪烁消失', (await page.$('.flash')) === null, (await page.$('.flash')) === null ? '.flash 已摘除' : '仍在闪');
  step('跳转后出现「↩ 返回」', afterClick.ret, afterClick.ret ? 'quote_return 可见' : '未出现');

  // 回跳
  if (afterClick.ret) {
    await page.click('[data-testid="quote_return"]');
    await sleep(350);
    const back = await scrollTop();
    step('点「↩ 返回」回到跳转前位置', Math.abs(back - before) <= 2, `scrollTop ${Math.round(back)}（原 ${Math.round(before)}）`);
  }

  // 拖动引用文字不误跳（重新取坐标）
  const pos2 = await page.evaluate((i) => {
    const el = document.querySelectorAll('[data-testid="quote_block"]')[i];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) };
  }, found.i);
  if (pos2) {
    const before2 = await scrollTop();
    await page.mouse.move(pos2.x, pos2.y);
    await page.mouse.down();
    await page.mouse.move(pos2.x + 30, pos2.y + 2, { steps: 8 });
    await page.mouse.up();
    await sleep(400);
    const after2 = await page.evaluate(() => ({
      scrollTop: document.querySelector('[data-testid="message_view"]')?.scrollTop,
      sel: (window.getSelection() || '').toString().slice(0, 24),
      flash: Boolean(document.querySelector('.flash')),
    }));
    step('拖动选择引用文字 → 只选字、不跳转', Math.abs(after2.scrollTop - before2) <= 2 && after2.sel.length > 0 && !after2.flash, `选区「${after2.sel}」· scrollTop 未变`);
    await page.keyboard.press('Escape');
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('# 失败：' + failed.map((f) => f.name).join('；'));
process.exit(failed.length ? 1 : 0);
