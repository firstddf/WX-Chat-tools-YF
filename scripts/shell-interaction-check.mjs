// 真机交互验收（M-A3，A1 #12/#13/#15/#17）+ 错误分支文案（[object Object] 回归）
// 前置：应用以 --remote-debugging-port=9222 启动（vite 5173 在跑）。
// 用法：node scripts/shell-interaction-check.mjs [--port 9222]
// 只读式操作：用真实鼠标事件驱动真实 WebView2，不注入测试钩子（数据为真实库数据）。
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
// 上一次验收可能停在「聊天数据管理」标签页：先切回「数据筛选」（v-show 隐藏时按钮不可见）
if (!(await page.isVisible('[data-testid="page_filter"]'))) {
  await page.click('[data-testid="tab_filter"]');
  await sleep(300);
}
await page.waitForSelector('[data-testid="btn_load"]', { state: 'visible', timeout: 60000 });

const statusText = async () => (await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '';

// ---- 1) 错误分支：切到未登录账号（KEY_NOT_FOUND）→ 文案不得出现 [object Object] ----
const opts = await page.$$eval('[data-testid="cmb_account"] option', (els) => els.map((e) => ({ v: e.value, t: e.textContent.trim() })));
step('账号下拉有真实选项', opts.length > 0, opts.map((o) => o.t).join(' / '));
const bad = opts.find((o) => /firstddf/.test(o.v)) || opts[opts.length - 1];
await page.selectOption('[data-testid="cmb_account"]', bad.v);
await sleep(300);
await page.click('[data-testid="btn_load"]');
await page.waitForFunction(
  () => /⚠/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''),
  null,
  { timeout: 120000 },
).catch(() => null);
const errText = await statusText();
step(
  '未登录账号 → 中文错误文案且无 [object Object]',
  errText.includes('⚠') && !errText.includes('[object Object]'),
  errText.trim().slice(0, 160),
);

// ---- 2) 切回可用账号并加载（真机数据） ----
const good = opts.find((o) => !/firstddf/.test(o.v));
await page.selectOption('[data-testid="cmb_account"]', good.v);
await sleep(300);
const t0 = Date.now();
await page.click('[data-testid="btn_load"]');
await page.waitForFunction(
  () => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''),
  null,
  { timeout: 300000 },
);
const loadedText = await statusText();
step('切换账号后重新加载成功', /共 \d+ 条消息/.test(loadedText), `${loadedText.trim().slice(0, 90)} · ${Date.now() - t0}ms`);
await page.screenshot({ path: 'test-results/real-acceptance/shell-loaded.png' });

// 找一个多行文本气泡作为拖选目标
const target = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="msg_row"]')];
  for (const row of rows) {
    const p = row.querySelector('.bubble p.text');
    if (!p) continue;
    const r = p.getBoundingClientRect();
    if (r.width > 120 && r.height > 0) {
      const range = document.createRange();
      range.selectNodeContents(p);
      const rects = [...range.getClientRects()];
      if (rects.length === 0) continue;
      const first = rects[0];
      const last = rects[rects.length - 1];
      return {
        text: (p.textContent || '').slice(0, 40),
        x1: Math.round(first.left + 8),
        y1: Math.round(first.top + first.height / 2),
        x2: Math.round(Math.min(last.right - 2, last.left + 60)),
        y2: Math.round(last.top + last.height / 2),
        rowIndex: row.dataset.index,
      };
    }
  }
  return null;
});
step('可拖选的气泡存在', target !== null, target ? `index=${target.rowIndex} text=${target.text}` : '未找到');

// ---- 3) A1 #12 单气泡拖选 + 复制 ----
if (target) {
  await page.mouse.move(target.x1, target.y1);
  await page.mouse.down();
  await page.mouse.move(target.x2, target.y2, { steps: 12 });
  await page.mouse.up();
  await sleep(200);
  const sel = await page.evaluate(() => (window.getSelection() || '').toString());
  step('单气泡拖选产生选区（真实鼠标）', sel.length > 0, `选区「${sel.slice(0, 30)}」`);
  await page.screenshot({ path: 'test-results/real-acceptance/shell-dragselect.png' });
  // Ctrl+C 后读剪贴板（真实壳的剪贴板权限）
  await page.keyboard.press('Control+C');
  await sleep(400);
  const clip = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      return 'ERR:' + e.message;
    }
  });
  step('Ctrl+C 写入剪贴板（真实 WebView2）', typeof clip === 'string' && clip.length > 0 && !clip.startsWith('ERR'), String(clip).slice(0, 30));
  // Esc 清除
  await page.keyboard.press('Escape');
  await sleep(200);
  const selAfterEsc = await page.evaluate(() => (window.getSelection() || '').toString());
  step('Esc 清除文字选区', selAfterEsc.length === 0, `「${selAfterEsc}」`);
}

// ---- 4) A1 #15 右键菜单（在气泡内右键，Tk 语义：勾中点着的条） ----
const rowForMenu = await page.evaluate(() => {
  const bubble = document.querySelector('[data-testid="msg_row"] .bubble');
  if (!bubble) return null;
  const r = bubble.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
});
if (rowForMenu) {
  await page.mouse.click(rowForMenu.x, rowForMenu.y, { button: 'right' });
  await sleep(400);
  const menu = await page.$$eval('.ctx-menu .ctx-item', (els) => els.map((e) => ({ text: e.textContent.trim(), disabled: e.getAttribute('aria-disabled') === 'true' || e.hasAttribute('disabled') }))).catch(() => []);
  step('右键弹出菜单（真实鼠标右键）', menu.length >= 3, menu.map((m) => m.text + (m.disabled ? '(禁用)' : '')).join(' | '));
  await page.screenshot({ path: 'test-results/real-acceptance/shell-contextmenu.png' });
  // 点「多选」项 → 进入多选并勾选
  const multiItem = await page.$$eval('.ctx-menu .ctx-item', (els) => els.findIndex((e) => /多选/.test(e.textContent || '')));
  if (multiItem >= 0) {
    await page.$$eval('.ctx-menu .ctx-item', (els, i) => els[i].click(), multiItem);
    await sleep(500);
    const checks = await page.$$eval('[data-testid="checkbox"]', (els) => els.length);
    const checked = await page.$$eval('[data-testid="checkbox"]', (els) => els.filter((e) => e.textContent.trim() === '☑').length);
    step('点菜单「多选」→ 进入多选并勾中该条', checks > 0 && checked > 0, `勾选框 ${checks} · 已勾 ${checked}`);
    await page.screenshot({ path: 'test-results/real-acceptance/shell-multi.png' });
    await page.keyboard.press('Escape');
    await sleep(400);
    const checksAfter = await page.$$eval('[data-testid="checkbox"]', (els) => els.length).catch(() => -1);
    step('Esc 退出多选并清空选择', checksAfter === 0, `勾选框 ${checksAfter}`);
  } else {
    step('点菜单「多选」→ 进入多选并勾中该条', false, '菜单中未找到多选项');
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('# 失败：' + failed.map((f) => f.name).join('；'));
// 保活真实壳：不调用 browser.close()，直接退出进程
process.exit(failed.length ? 1 : 0);
