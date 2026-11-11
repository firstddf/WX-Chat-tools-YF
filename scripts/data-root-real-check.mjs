// 真机验收（docs/07 #13）：数据目录「自动发现失败可操作引导」与「手动设置后扫到账号并加载」。
// 前置：应用以 CDP 9222 启动，且**不带** WXCHART_XWECHAT_ROOT env——本机数据在自定义位置
//   D:\微信数据\xwechat_files（常见位置全不命中，正好验证两条路径）：
//   auto   —— settings 无 data_root：自动发现全 miss → 状态行含「已尝试：…」列表
//   manual —— settings.data_root=D:\微信数据\xwechat_files（外部写入后重启应用）：
//             扫到 2 账号 + 状态回显数据目录 + UI 点加载成功（load_source root 注入口径）
// 用法：node scripts/data-root-real-check.mjs --phase auto|manual [--port 9222] [--shots <dir>]
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
if (phase !== 'auto' && phase !== 'manual') {
  console.error('用法: node scripts/data-root-real-check.mjs --phase auto|manual [--port 9222]');
  process.exit(2);
}
const port = Number(arg('--port', '9222'));
const shotDir = resolve(arg('--shots', join('test-results', 'local-data', 'run-20261109')));
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
  const status = async () => ((await page.textContent('[data-testid="account_status"]')) || '').trim();

  if (phase === 'auto') {
    // 自动发现：本机常见位置全不命中 → 空结果 + 已尝试列表（可操作引导）
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="account_status"]');
        return el && /没有发现微信账号目录/.test(el.textContent || '');
      },
      { timeout: 30000 },
    );
    const s = await status();
    step('自动发现空结果引导文案', s.includes('没有发现微信账号目录'), s);
    step(
      '状态行附「已尝试」位置列表（≥2 个候选）',
      s.includes('已尝试：') && (s.match(/[A-Za-z]:\\/g) || []).length >= 2,
      s,
    );
    step('未误报数据目录（无 data_root 回显）', !s.includes('数据目录：'), s);
    await page.screenshot({ path: join(shotDir, 'D1-auto-notfound.png') });
  } else {
    // 手动设置：settings.data_root 已写入并重启 → 显式 root 扫到账号 + 回显
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="cmb_account"]');
        return el && el.options.length >= 2;
      },
      { timeout: 30000 },
    ).catch(() => null);
    const s0 = await status();
    const opts = await page.$$eval('[data-testid="cmb_account"] option', (els) =>
      els.map((e) => e.value).filter(Boolean));
    step('手动设置后扫到真实账号', opts.length >= 2, `${opts.join(' / ')} · ${s0}`);
    // 期望值取自 get_settings（源码不写死本机路径——脱敏整改 2026-11-11）
    const settings = await page
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('get_settings'))
      .catch(() => null);
    const expectRoot = settings?.data_root || '';
    step(
      '状态行回显数据目录（== settings.data_root）',
      Boolean(expectRoot) && s0.includes(`数据目录：${expectRoot}`),
      `${s0} · data_root=${expectRoot}`,
    );

    // UI 加载（load_source root 注入口径——扫到还要能加载）。
    // 选中账号若非当前登录 → KEY_NOT_FOUND（键在微信进程内存里，docs/02 §4 既定路径，
    // 与数据目录无关）→ 自动切另一账号重试。
    const loadOnce = async () => {
      const t0 = Date.now();
      await page.click('[data-testid="btn_load"]');
      await page
        .waitForFunction(
          () => {
            const el = document.querySelector('[data-testid="lbl_status"]');
            if (!el) return false;
            const text = el.textContent || '';
            return /共 \d+ 条消息/.test(text) || (/密钥/.test(text) && el.classList.contains('warn'));
          },
          { timeout: 300000 },
        )
        .catch(() => null);
      const text = ((await page.textContent('[data-testid="lbl_status"]')) || '').trim();
      return { text, ms: Date.now() - t0 };
    };
    let loaded = await loadOnce();
    let note = '';
    if (!/共 \d+ 条消息/.test(loaded.text) && opts.length > 1) {
      const cur = await page.$eval('[data-testid="cmb_account"]', (el) => el.value);
      const other = opts.find((v) => v !== cur);
      if (other) {
        note = `（${cur} 非当前登录 → 切 ${other} 重试）`;
        await page.selectOption('[data-testid="cmb_account"]', other);
        loaded = await loadOnce();
      }
    }
    step(
      'UI 加载真实数据（root 注入 load_source）',
      /共 \d+ 条消息/.test(loaded.text),
      `${loaded.text} · ${loaded.ms}ms${note}`,
    );
    await page.screenshot({ path: join(shotDir, 'D2-manual-loaded.png') });
    step('console 0 错（Phase manual）', consoleErrors.length === 0, `${consoleErrors.length} 条`);
  }
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  for (const c of browser.contexts()) for (const p of c.pages()) p.removeAllListeners();
}

const fails = results.filter((r) => !r.ok).length;
console.log(`\n== data-root-real-check ${phase}：${results.length - fails}/${results.length} PASS ==`);
process.exit(fails ? 1 : 0);
