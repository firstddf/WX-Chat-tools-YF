// M-A4 安装版冒烟（CDP 连 --remote-debugging-port=9223 的安装实例）：
//   1) sidecar 握手 ready（壳内 app_info，等价于「无降级横幅」）
//   2) 账号栏 4 账号（微信在跑）
//   3) 点加载 → 状态行「共 N 条消息 · 匹配 N 条」（Tk 口径，docs/05）
//   4) 页面无 console 错误
// 前置：安装版需带 CDP 端口启动。注意 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 对本壳
// **无效**（wry 0.57.1 webview2/mod.rs:341 无条件 set_additional_browser_arguments，
// WebView2 遇到 API 参数即忽略该环境变量，2026-11-07 三种注入方式 A/B 实测）；
// 要开 CDP 只能走 config：`pnpm tauri build -c <overlay.json>`（app.windows[0]
// .additionalBrowserArgs = wry 默认串 + --remote-debugging-port=9223）。
// 用法：node scripts/install-smoke.mjs [--port 9223] [--timeout 300000] [--accounts 4]
// --accounts：账号数断言（默认 4 = 源机口径；本机数据根账号数不同则传参，2026-11-10 #6）
// 注意：只断开、不 close（browser.close() 会连带杀掉真实壳的 WebView2）。
import { chromium } from '@playwright/test';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const port = Number(arg('--port', 9223));
const loadTimeout = Number(arg('--timeout', 300000));
const expectAccounts = Number(arg('--accounts', 4));

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const consoleErrors = [];

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.waitForSelector('[data-testid="btn_load"]', { state: 'visible', timeout: 60000 });

// 1) sidecar 握手状态（docs/02 §2 app_info.sidecar.state）
let info = null;
try {
  info = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_info'));
} catch (e) {
  step('app_info invoke 可用', false, String(e).slice(0, 120));
}
if (info) {
  const st = info.sidecar || {};
  step('sidecar 握手 ready（无降级横幅）', ['ready', 'restarted'].includes(st.state), JSON.stringify(st));
  step('协议版本一致', info.protocol_version === 1 && st.protocol_version === 1,
    `壳=${info.protocol_version} sidecar=${st.protocol_version}`);
}

// 2) 账号栏（<option> 在 select 内不可见，必须等 attached 而不是 visible）
await page.waitForSelector('[data-testid="cmb_account"] option', { state: 'attached', timeout: 30000 });
const opts = await page.$$eval('[data-testid="cmb_account"] option', (els) => els.map((e) => e.value));
step(`账号栏 ${expectAccounts} 账号`, opts.length === expectAccounts, opts.join(', '));
const accStatus = ((await page.textContent('[data-testid="account_status"]').catch(() => '')) || '').trim();
step(`账号栏状态文案（发现 ${expectAccounts} 个账号）`, new RegExp(`发现\\s*${expectAccounts}\\s*个账号`).test(accStatus), accStatus.slice(0, 80));

// 3) 加载 → 状态行
const t0 = Date.now();
await page.click('[data-testid="btn_load"]');
await page.waitForFunction(
  () => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''),
  null,
  { timeout: loadTimeout },
).catch(() => { /* 下面统一取状态行判定 */ });
const loadMs = Date.now() - t0;
const st = ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
step('加载出「共 N 条消息」', /共 \d+ 条消息/.test(st), `${st.slice(0, 120)} · ${(loadMs / 1000).toFixed(1)}s`);
step('状态行「匹配 N 条」（加载完成即 apply_filters）', /匹配 \d+ 条/.test(st), st.slice(0, 120));

await page.screenshot({ path: 'test-results/m-a4/app-installed-loaded.png' }).catch(() => {});

// 4) console 错误
step('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');

const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('# 失败：' + failed.map((f) => f.name).join('；'));
// 只断开、不 close
process.exit(failed.length ? 1 : 0);
