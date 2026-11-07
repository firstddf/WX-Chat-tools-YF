// 真机验收（S6c）：通过 CDP 驱动「真实 Tauri 壳 + WebView2 + 真实 sidecar」里的前端。
// 前置：应用已用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动。
// 用法：node scripts/acceptance-real.mjs [--port 9222] [--shots <dir>]
// 只操作真实 UI（data-testid），不注入任何测试钩子；先加载真实数据，再验筛选/虚拟滚动/选区。
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const port = Number(arg('--port', process.env.WV2_CDP_PORT || '9222'));
const shotDir = resolve(arg('--shots', join('test-results', 'real-acceptance', stamp())));
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
mkdirSync(shotDir, { recursive: true });

const results = [];
const consoleErrors = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitStatus(page, re, timeout) {
  await page.waitForFunction(
    (src) => {
      const el = document.querySelector('[data-testid="lbl_status"]');
      return el && new RegExp(src).test(el.textContent || '');
    },
    re.source,
    { timeout },
  );
  return (await page.textContent('[data-testid="lbl_status"]')) || '';
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP 已连接但没有任何 browser context');
  // 应用页面 = 非 devtools 的那一页
  const page =
    ctx.pages().find((p) => !/^devtools:/.test(p.url())) || (await ctx.waitForEvent('page', { timeout: 30000 }));
  await page.waitForLoadState('domcontentloaded');
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  console.log(`# 目标页 ${page.url()}`);
  await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
  const banner = await page.$('[data-testid="sidecar_banner"]');
  step('壳内前端已加载（WebView2 + Vue 挂载完成）', true, page.url());
  step('sidecar 无降级横幅', banner === null, banner ? await banner.textContent() : '无横幅');

  // ---- 0) 账号选择（真实 scan_accounts → 下拉） ----
  await page.waitForSelector('[data-testid="cmb_account"]', { timeout: 30000 }).catch(() => null);
  const acctStatus = (await page.textContent('[data-testid="account_status"]').catch(() => '')) || '';
  const acctOpts = await page.$$eval('[data-testid="cmb_account"] option', (els) => els.map((e) => e.textContent.trim())).catch(() => []);
  const acctSel = await page.$eval('[data-testid="cmb_account"]', (el) => el.value).catch(() => '');
  step('账号栏渲染 + 真实账号扫描有结果', acctOpts.length >= 1 && Boolean(acctSel), `${acctOpts.join(' / ')} · 已选 ${acctSel} · ${acctStatus.trim()}`);
  await page.screenshot({ path: join(shotDir, '00-account-shell.png') });

  // ---- 1) 真实数据加载 ----
  const t0 = Date.now();
  await page.click('[data-testid="btn_load"]');
  await waitStatus(page, /共 \d+ 条消息/, 300000);
  const loaded = Date.now() - t0;
  const statusLoaded = (await page.textContent('[data-testid="lbl_status"]')) || '';
  const m = statusLoaded.match(/共 (\d+) 条消息 · (\d+) 个会话 · (\d+) 天/);
  const total = m ? Number(m[1]) : 0;
  step('真实数据加载完成（真实 sidecar → 前端）', total > 0, `${statusLoaded.trim()} · ${loaded}ms`);
  await page.screenshot({ path: join(shotDir, '01-loaded.png') });

  // ---- 2) 虚拟滚动：只渲染可视窗口 ----
  const SEL_VIEW = '[data-testid="message_view"]';
  const countRows = () => page.$$eval('[data-testid="msg_row"]', (els) => els.length).catch(() => -1);
  const renderedRows = await countRows();
  step(
    '虚拟滚动生效：渲染行数远小于总数',
    renderedRows > 0 && renderedRows < Math.max(200, total * 0.2),
    `渲染 ${renderedRows} 行 / 共 ${total} 条`,
  );
  const before = await page.$eval(SEL_VIEW, (el) => el.scrollTop).catch(() => -1);
  if (before >= 0) {
    const tScroll = Date.now();
    await page.$eval(SEL_VIEW, (el) => {
      el.scrollTop = Math.floor(el.scrollHeight * 0.5);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await sleep(400);
    const after = await page.$eval(SEL_VIEW, (el) => el.scrollTop);
    const rows2 = await countRows();
    step(
      '滚动到中段后重新窗口化渲染',
      after > 0 && rows2 > 0 && rows2 < Math.max(200, total * 0.2),
      `scrollTop ${Math.round(after)} · 渲染 ${rows2} 行 · 耗时 ${Date.now() - tScroll}ms`,
    );
    await page.screenshot({ path: join(shotDir, '02-scrolled-mid.png') });
    await page.$eval(SEL_VIEW, (el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await sleep(200);
  } else {
    step('虚拟滚动生效：只渲染可视窗口', false, '未找到滚动容器 data-testid=message_view');
  }

  // ---- 3) 关键词筛选（真实本地过滤，零 IPC） ----
  await page.fill('[data-testid="entry_query"]', '');
  const kw = '的';
  await page.fill('[data-testid="entry_query"]', kw);
  await page.press('[data-testid="entry_query"]', 'Enter');
  await sleep(400);
  const statusFiltered = (await page.textContent('[data-testid="lbl_status"]')) || '';
  const mf = statusFiltered.match(/匹配 (\d+) 条/);
  step('关键词筛选实时生效', mf !== null, statusFiltered.trim());
  await page.screenshot({ path: join(shotDir, '03-filtered.png') });

  // ---- 4) 重置 → 全选/计数（选区状态机跑在真实数据上） ----
  await page.click('[data-testid="btn_reset"]');
  await sleep(400);
  const resetText = (await page.textContent('[data-testid="lbl_status"]')) || '';
  const mr = resetText.match(/匹配 (\d+) 条/);
  step('重置筛选恢复全量', mr !== null && Number(mr[1]) === total, resetText.trim());
  await page.click('[data-testid="btn_select_all"]');
  await sleep(400);
  const selText = (await page.textContent('[data-testid="lbl_status"]')) || '';
  const ms = selText.match(/已选 (\d+) 条/);
  step(
    '全选作用于全量匹配项（状态层，非仅可视窗口）',
    ms !== null && mr !== null && Number(ms[1]) === Number(mr[1]),
    selText.trim(),
  );
  const checked = await page.$$eval('[data-testid="checkbox"]', (els) => els.filter((e) => e.textContent.trim() === '☑').length).catch(() => -1);
  step('多选勾选框随状态出现', checked > 0, `可视窗口内已勾 ${checked} 个`);
  await page.click('[data-testid="btn_select_none"]');
  await sleep(200);

  // ---- 5) 管理页数据 ----
  await page.click('[data-testid="tab_manage"]');
  await sleep(500);
  const manageText = (await page.textContent('[data-testid="page_manage"]')) || '';
  step('管理页渲染会话列表', manageText.length > 20, `${manageText.replace(/\s+/g, ' ').slice(0, 80)}…`);
  await page.screenshot({ path: join(shotDir, '04-manage.png') });

  step('无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');
} catch (e) {
  step('验收脚本异常', false, e && e.message ? e.message : String(e));
} finally {
  // 注意：connectOverCDP 的 browser.close() 会连带关掉被连接的浏览器进程，
  // 也就是会把真实壳的 WebView2 拆掉（外壳随之退出）。验收后要保留应用窗口，
  // 所以这里只断开、不 close：让 node 进程自然退出，websocket 断开即脱离。
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) p.removeAllListeners();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过 · 截图 ${shotDir}`);
if (failed.length) {
  console.log('# 失败项：' + failed.map((f) => f.name).join('；'));
  process.exit(1);
}
// 保活真实壳：不调用 browser.close()（会拆掉 WebView2），显式退出本进程
process.exit(0);
