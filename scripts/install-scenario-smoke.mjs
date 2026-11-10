// M-A4 #6 安装版场景冒烟（CDP 连 --remote-debugging-port=9223 的安装实例）：
//   recent    本地数据包回读：set_settings 注入 last_export_dir → 点「打开最近数据」
//             → 断言状态行「共 N 条消息 · … 来源：导出目录」（按钮链路，docs/05 #6 §3.3）
//   noaccount 无微信场景：安装版带 WXCHART_XWECHAT_ROOT=<空目录> 启动
//             → 断言账号栏「没有发现微信账号目录…（已尝试：…）」引导
//             → 点加载 → NO_ACCOUNT 出口（btn_open_local_error「打开本地数据」）不白屏
// 用法：node scripts/install-scenario-smoke.mjs --mode recent --pkg <数据包目录>
//       node scripts/install-scenario-smoke.mjs --mode noaccount
// 前置：安装版需带 CDP 端口启动（见 install-smoke.mjs 头注：只能走 config overlay）。
// 注意：只断开、不 close（browser.close() 会连带杀掉真实壳的 WebView2）。
import { chromium } from '@playwright/test';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const mode = arg('--mode', '');
const port = Number(arg('--port', 9223));
const pkg = arg('--pkg', '');

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

if (mode === 'recent') {
  if (!pkg) { console.error('--pkg 必填'); process.exit(2); }
  // 1) 注入最近目录（协议 set_settings 白名单字段，docs/02 §2）
  const s = await page.evaluate(
    (p) => window.__TAURI_INTERNALS__.invoke('set_settings', { patch: { last_export_dir: p } }),
    pkg,
  );
  step('set_settings 注入 last_export_dir', s?.last_export_dir === pkg, String(s?.last_export_dir));
  // 直接 invoke 不经 store（data.settings 只在 boot/记忆动作刷新）→ reload 让 boot 重读
  await page.reload().catch(() => {});
  await page.waitForSelector('[data-testid="btn_load"]', { state: 'visible', timeout: 60000 });
  // 「打开最近数据」在聊天数据管理页签（ChatList，v-if="lastDir"）→ 先切页签
  await page.click('[data-testid="tab_manage"]');
  const appeared = await page.waitForSelector('[data-testid="btn_open_recent"]', { state: 'visible', timeout: 10000 })
    .then(() => true).catch(() => false);
  step('btn_open_recent 出现（lastDir 记忆）', appeared);
  if (appeared) await page.click('[data-testid="btn_open_recent"]');
  // 3) 信息卡断言（管理页无 lbl_status；来源/条数卡片 docs/06 Phase 2 #8）
  const ok = await page.waitForFunction(
    () => {
      const src = document.querySelector('[data-testid="card_source"]')?.textContent || '';
      const cnt = document.querySelector('[data-testid="card_count"]')?.textContent || '';
      return /来源：导出目录/.test(src) && /条数\s*[1-9]\d*/.test(cnt);
    },
    null,
    { timeout: 60000 },
  ).then(() => true).catch(() => false);
  const card = ((await page.textContent('[data-testid="card_source"]').catch(() => '')) || '').trim()
    + ' | ' + ((await page.textContent('[data-testid="card_count"]').catch(() => '')) || '').trim();
  step('回读信息卡「来源：导出目录 · 条数 N>0」', ok, card.slice(0, 160));
  await page.screenshot({ path: 'test-results/m-a4/pkg-readback.png' }).catch(() => {});
} else if (mode === 'noaccount') {
  // 1) 账号栏引导文案（AccountBar：没有发现微信账号目录 + #13 已尝试位置）
  const acc = ((await page.textContent('[data-testid="account_status"]').catch(() => '')) || '').trim();
  step('账号栏无账号引导（含已尝试位置）',
    /没有发现微信账号目录/.test(acc) && /已尝试/.test(acc), acc.slice(0, 200));
  // 2) 点加载 → NO_ACCOUNT 错误出口（btn_open_local_error），不白屏
  await page.click('[data-testid="btn_load"]');
  const exitOk = await page.waitForSelector('[data-testid="btn_open_local_error"]', { state: 'visible', timeout: 30000 })
    .then(() => true).catch(() => false);
  step('加载 NO_ACCOUNT → 「打开本地数据」出口可见（不白屏）', exitOk);
  const st = ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
  step('状态行错误文案清晰', /微信|账号|登录/.test(st), st.slice(0, 160));
  await page.screenshot({ path: 'test-results/m-a4/no-account.png' }).catch(() => {});
} else {
  console.error('--mode recent|noaccount 必填');
  process.exit(2);
}

step('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');

const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过（mode=${mode}）`);
if (failed.length) console.log('# 失败：' + failed.map((f) => f.name).join('；'));
// 只断开、不 close
process.exit(failed.length ? 1 : 0);
