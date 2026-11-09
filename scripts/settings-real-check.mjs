// 真机验收（docs/07 #4）：改账号 → 重启应用 → 记忆自动恢复（真实壳 + 真实 settings.json）。
// 前置：应用已用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动
//   （数据根按需带 WXCHART_XWECHAT_ROOT）。两段式（重启不可在脚本内完成）：
//   pick   —— 读当前选中 → 切到「另一个账号」→ 断言 status + settings.json 已写入
//             （把选中值写 run 目录 picked.json 供第二段用）
//   verify —— 断言下拉值 == picked.json（= 重启后记忆恢复）且 settings.json 一致
// 用法：node scripts/settings-real-check.mjs --phase pick|verify [--port 9222] [--dir <run-dir>]
// 约定：只断开 CDP，不 browser.close()（同 acceptance-real.mjs）。
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const phase = arg('--phase', '');
if (phase !== 'pick' && phase !== 'verify') {
  console.error('用法: node scripts/settings-real-check.mjs --phase pick|verify [--port 9222] [--dir <run-dir>]');
  process.exit(2);
}
const port = Number(arg('--port', '9222'));
const runDir = resolve(arg('--dir', join('test-results', 'local-data', 'run-20261109')));
mkdirSync(runDir, { recursive: true });
const pickedFile = join(runDir, 'settings-picked.json');
const settingsFile = join(process.env.APPDATA, 'com.wxchart.app', 'settings.json');

const results = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const ctx = browser.contexts()[0];
  const page =
    ctx.pages().find((p) => !/^devtools:/.test(p.url())) || (await ctx.waitForEvent('page', { timeout: 30000 }));
  await page.waitForSelector('[data-testid="cmb_account"]', { timeout: 60000 });
  const opts = await page.$$eval('[data-testid="cmb_account"] option', (els) =>
    els.map((e) => e.value).filter(Boolean));
  const status0 = ((await page.textContent('[data-testid="account_status"]')) || '').trim();
  step('账号下拉有真实账号', opts.length >= 1, `${opts.join(' / ')} · ${status0}`);

  if (phase === 'pick') {
    const current = await page.$eval('[data-testid="cmb_account"]', (el) => el.value);
    const other = opts.find((v) => v !== current);
    if (!other) throw new Error(`只有一个账号（${current}），无法演示切换`);
    await page.selectOption('[data-testid="cmb_account"]', other);
    await page.waitForFunction(
      (wxid) => {
        const el = document.querySelector('[data-testid="account_status"]');
        return el && (el.textContent || '').includes(`已选账号：${wxid}`);
      },
      other,
      { timeout: 15000 },
    );
    const status1 = ((await page.textContent('[data-testid="account_status"]')) || '').trim();
    step('手动切换账号生效', status1.includes(`已选账号：${other}`), status1);

    // settings.json 真实落盘（%APPDATA%\com.wxchart.app\settings.json）
    let saved = null;
    for (let i = 0; i < 10 && !saved; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (existsSync(settingsFile)) {
        try {
          saved = JSON.parse(readFileSync(settingsFile, 'utf-8'));
        } catch {
          /* 写入中，重试 */
        }
      }
    }
    step(
      'settings.json 已写入 last_account',
      saved && saved.last_account === other,
      `${settingsFile} → ${JSON.stringify(saved)}`,
    );
    writeFileSync(pickedFile, JSON.stringify({ picked: other, current }));
    console.log(`# picked=${other}（重启应用后跑 --phase verify）`);
  } else {
    const picked = JSON.parse(readFileSync(pickedFile, 'utf-8')).picked;
    // 重启后的应用：init 读设置 → 扫描 → 记忆优先
    await page.waitForFunction(
      (wxid) => {
        const el = document.querySelector('[data-testid="cmb_account"]');
        return el && el.value === wxid;
      },
      picked,
      { timeout: 30000 },
    ).catch(() => null);
    const value = await page.$eval('[data-testid="cmb_account"]', (el) => el.value);
    const status = ((await page.textContent('[data-testid="account_status"]')) || '').trim();
    step('重启后下拉自动恢复到切换的账号', value === picked, `value=${value} expect=${picked} · ${status}`);
    const onDisk = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    step('settings.json 持久值一致', onDisk.last_account === picked, JSON.stringify(onDisk));
  }
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  // 约定：connectOverCDP 的 close 会拆掉真实壳——只摘监听，进程退出即脱离
  for (const c of browser.contexts()) for (const p of c.pages()) p.removeAllListeners();
}

const fails = results.filter((r) => !r.ok).length;
console.log(`\n== settings-real-check ${phase}：${results.length - fails}/${results.length} PASS ==`);
process.exit(fails ? 1 : 0);
