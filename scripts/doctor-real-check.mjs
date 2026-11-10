// 真机验收（docs/07 #3 尾巴）：管理页「自检」按钮 → doctor 结果面板（真实壳 + 真实微信库）。
// 前置：应用已用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动
//   （settings.data_root=D:\微信数据\xwechat_files 已在位 → 壳注入 doctor root）；
//   empty 段另需带 WXCHART_XWECHAT_ROOT=<空目录> 启动（env 发现顺序最高，#13 口径）。
// 三段式（切换 env/微信状态须重启应用，不可在脚本内完成）：
//   on    —— 微信在：点自检 → 面板摘要（密钥 hit/total + 消息 N 条）+ 逐库 ✅（20 库）
//   off   —— 微信不在（账号目录在、进程没起）：点自检 → KEY_NOT_FOUND 中文文案、不白屏
//   empty —— 无账号（env 空根）：点自检 → doctor_error 显 NO_ACCOUNT 中文文案、不白屏
// 用法：node scripts/doctor-real-check.mjs --phase on|off|empty [--port 9222] [--shots <dir>]
// 约定：只断开 CDP，不 browser.close()（同 acceptance-real.mjs）。
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const phase = arg('--phase', '');
if (!['on', 'off', 'empty'].includes(phase)) {
  console.error('用法: node scripts/doctor-real-check.mjs --phase on|off|empty [--port 9222]');
  process.exit(2);
}
const port = Number(arg('--port', '9222'));
const shotDir = resolve(arg('--shots', join('test-results', 'real-acceptance', 'doctor-20261110')));
mkdirSync(shotDir, { recursive: true });

const results = [];
const consoleErrors = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const ctx = browser.contexts()[0];
  const page =
    ctx.pages().find((p) => !/^devtools:/.test(p.url())) || (await ctx.waitForEvent('page', { timeout: 30000 }));
  await page.waitForLoadState('domcontentloaded');
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.waitForSelector('[data-testid="cmb_account"]', { timeout: 60000 });
  await page.click('[data-testid="tab_manage"]');
  await page.waitForSelector('[data-testid="page_manage"]', { timeout: 15000 });
  const manage = page.locator('[data-testid="page_manage"]');
  await manage.locator('[data-testid="btn_doctor"]').waitFor({ state: 'visible', timeout: 15000 });

  if (phase === 'on') {
    const t0 = Date.now();
    await manage.locator('[data-testid="btn_doctor"]').click();
    // 自检要走完 解密/读库（30s 壳超时上限）→ 面板出现即完成
    await manage.locator('[data-testid="doctor_panel"]').waitFor({ state: 'visible', timeout: 45000 });
    const ms = Date.now() - t0;
    const summary = ((await manage.locator('[data-testid="doctor_summary"]').textContent().catch(() => '')) || '').trim();
    const dbs = await manage.locator('[data-testid="doctor_db"]').allTextContents();
    const err = ((await manage.locator('[data-testid="doctor_error"]').textContent().catch(() => '')) || '').trim();

    step('自检完成出面板（无 error 行）', err === '' && summary !== '', `${ms}ms · ${summary}`);
    step('摘要含密钥命中 hit/total', /密钥 \d+\/\d+/.test(summary), summary);
    step('摘要含消息总数', /消息 \d+ 条/.test(summary), summary);
    step('逐库呈现（真实 20 库）', dbs.length >= 10, `${dbs.length} 库`);
    const bad = dbs.filter((d) => d.includes('❌'));
    step('全部库 ✅（微信在、缓存热）', dbs.length > 0 && bad.length === 0,
      bad.length ? `失败: ${bad.join(' | ')}` : `${dbs.length} 库全 ✅`);
    step('按钮恢复可点（非自检中）',
      !((await manage.locator('[data-testid="btn_doctor"]').textContent()) || '').includes('自检中'));
    await page.screenshot({ path: join(shotDir, `${phase}-panel.png`), fullPage: true });
    step('console 0 错', consoleErrors.length === 0, `${consoleErrors.length} 条: ${consoleErrors.slice(0, 3).join(' / ')}`);
  } else if (phase === 'off') {
    // 微信不在：账号目录在（root 注入扫得到），但进程没起 → extract_keys 抛
    // KEY_NOT_FOUND → 面板显 Tk 文案、不白屏（A2 #30 口径的真机版）
    const t0 = Date.now();
    await manage.locator('[data-testid="btn_doctor"]').click();
    await manage.locator('[data-testid="doctor_error"]').waitFor({ state: 'visible', timeout: 45000 });
    const ms = Date.now() - t0;
    const err = ((await manage.locator('[data-testid="doctor_error"]').textContent()) || '').trim();
    const summary = await manage.locator('[data-testid="doctor_summary"]').count();

    step('自检返回 KEY_NOT_FOUND 中文文案',
      err.includes('Weixin.exe 未运行') && err.includes('请先登录微信'), `${ms}ms · ${err}`);
    step('不呈现摘要（失败即停，不半截面板）', summary === 0);
    step('应用不白屏（管理页仍在）', await manage.isVisible());
    step('按钮恢复可点（非自检中）',
      !((await manage.locator('[data-testid="btn_doctor"]').textContent()) || '').includes('自检中'));
    await page.screenshot({ path: join(shotDir, `${phase}-panel.png`), fullPage: true });
    step('console 0 错', consoleErrors.length === 0, `${consoleErrors.length} 条: ${consoleErrors.slice(0, 3).join(' / ')}`);
  } else {
    // 空根（env 最高优先 → 扫不到账号）：doctor 回 NO_ACCOUNT 文案，不白屏
    const t0 = Date.now();
    await manage.locator('[data-testid="btn_doctor"]').click();
    await manage.locator('[data-testid="doctor_error"]').waitFor({ state: 'visible', timeout: 45000 });
    const ms = Date.now() - t0;
    const err = ((await manage.locator('[data-testid="doctor_error"]').textContent()) || '').trim();
    const summary = await manage.locator('[data-testid="doctor_summary"]').count();

    step('自检返回错误行（NO_ACCOUNT 文案）',
      err.includes('没有发现微信账号目录'), `${ms}ms · ${err}`);
    step('不呈现摘要（失败即停，不半截面板）', summary === 0);
    step('应用不白屏（管理页仍在）', await manage.isVisible());
    await page.screenshot({ path: join(shotDir, `${phase}-panel.png`), fullPage: true });
    step('console 0 错', consoleErrors.length === 0, `${consoleErrors.length} 条: ${consoleErrors.slice(0, 3).join(' / ')}`);
  }
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  for (const c of browser.contexts()) for (const p of c.pages()) p.removeAllListeners();
}

const fails = results.filter((r) => !r.ok).length;
console.log(`\n== doctor-real-check ${phase}：${results.length - fails}/${results.length} PASS ==`);
process.exit(fails ? 1 : 0);
