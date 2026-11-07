// 临时诊断：读取真实壳里前端的当前状态（只读，不改动应用）
import { chromium } from '@playwright/test';

const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9222';
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.waitForTimeout(800);
const read = async (sel) => (await page.textContent(sel).catch(() => null));
console.log(JSON.stringify({
  url: page.url(),
  title: await page.title(),
  status: await read('[data-testid="lbl_status"]'),
  account: await read('[data-testid="account_status"]'),
  banner: await read('[data-testid="sidecar_banner"]'),
  accountOptions: await page.$$eval('[data-testid="cmb_account"] option', (els) => els.map((e) => e.textContent.trim())).catch(() => []),
  selectedAccount: await page.$eval('[data-testid="cmb_account"]', (el) => el.value).catch(() => null),
  rows: await page.$$eval('[data-testid="msg_row"]', (els) => els.length).catch(() => -1),
  loadingText: await read('[data-testid="lbl_status"]'),
  consoleErrors: errs,
}, null, 1));
process.exit(0);
