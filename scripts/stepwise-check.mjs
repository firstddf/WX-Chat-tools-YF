// 分步诊断（真实壳）：node scripts/stepwise-check.mjs bad|good|state
// bad  = 切到未登录账号并加载（预期 KEY_NOT_FOUND）
// good = 切到可用账号并加载（预期 共 N 条）
// state= 只读当前状态
import { chromium } from '@playwright/test';

const mode = process.argv[2] || 'state';
const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9222';
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
if (!(await page.isVisible('[data-testid="page_filter"]').catch(() => false))) {
  await page.click('[data-testid="tab_filter"]').catch(() => null);
}
await page.waitForSelector('[data-testid="btn_load"]', { state: 'visible', timeout: 60000 });
const status = async () => ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
const opts = await page.$$eval('[data-testid="cmb_account"] option', (els) => els.map((e) => e.value));

if (mode === 'bad') {
  const bad = opts.find((v) => /firstddf/.test(v)) || opts[opts.length - 1];
  await page.selectOption('[data-testid="cmb_account"]', bad);
  await page.click('[data-testid="btn_load"]');
  await page.waitForFunction(() => /⚠/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''), null, { timeout: 120000 });
  console.log('BAD ->', await status());
} else if (mode === 'good') {
  const good = opts.find((v) => !/firstddf/.test(v));
  await page.selectOption('[data-testid="cmb_account"]', good);
  await page.click('[data-testid="btn_load"]');
  const t0 = Date.now();
  await page.waitForFunction(() => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''), null, { timeout: 300000 }).catch(async () => {
    console.log('GOOD -> TIMEOUT; status=', await status());
    process.exit(2);
  });
  console.log(`GOOD -> ${await status()} (${Date.now() - t0}ms)`);
} else {
  console.log('STATE ->', JSON.stringify({ url: page.url(), status: await status(), opts }, null, 1));
}
process.exit(0);
