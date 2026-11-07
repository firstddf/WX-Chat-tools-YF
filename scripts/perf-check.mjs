// 真实壳卡顿诊断：主线程长任务 / 事件循环延迟 / 滚动帧时间 / 筛选响应
// 用法：node _probe/perf-check.mjs [--port 9222]
import { chromium } from '@playwright/test';

const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 9222);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
console.log('# page', page.url());

// 页面内探针：事件循环延迟 + 长任务
await page.evaluate(() => {
  window.__lag = [];
  window.__longtasks = [];
  const t0 = performance.now();
  let last = t0;
  window.__lagTimer = setInterval(() => {
    const now = performance.now();
    window.__lag.push({ t: Math.round(now - t0), drift: Math.round(now - last - 50) });
    last = now;
  }, 50);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {
    window.__longtasksError = String(e);
  }
});

const tLoad = Date.now();
await page.click('[data-testid="btn_load"]');
await page.waitForFunction(
  () => {
    const el = document.querySelector('[data-testid="lbl_status"]');
    return el && /共 \d+ 条消息/.test(el.textContent || '');
  },
  null,
  { timeout: 180000 },
);
const loadMs = Date.now() - tLoad;
const status = await page.textContent('[data-testid="lbl_status"]');
const afterLoad = await page.evaluate(() => ({
  lag: window.__lag.filter((x) => x.drift > 200),
  longtasks: window.__longtasks.slice(),
  maxDrift: Math.max(0, ...window.__lag.map((x) => x.drift)),
}));
console.log(`# 加载 ${loadMs}ms · ${status.trim().split('·')[0].trim()}`);
console.log(`# 加载期事件循环最大延迟 ${afterLoad.maxDrift}ms · >200ms 卡顿 ${afterLoad.lag.length} 次 · 长任务 ${afterLoad.longtasks.length} 个 ${JSON.stringify(afterLoad.longtasks.slice(0, 6))}`);

// 滚动帧时间：连续 60 次 scrollTop 变化，记录 rAF 间隔
const scrollPerf = await page.evaluate(async () => {
  const el = document.querySelector('[data-testid="message_view"]');
  if (!el) return { error: 'no scroll container' };
  window.__lag.length = 0;
  window.__longtasks.length = 0;
  const frames = [];
  let prev = performance.now();
  const step = Math.max(1, Math.floor(el.scrollHeight / 240));
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) {
    el.scrollTop += step;
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    frames.push(Math.round(now - prev));
    prev = now;
  }
  const total = performance.now() - t0;
  return {
    totalMs: Math.round(total),
    frameAvg: Math.round(frames.reduce((a, b) => a + b, 0) / frames.length),
    frameMax: Math.max(...frames),
    over50: frames.filter((f) => f > 50).length,
    rows: document.querySelectorAll('[data-testid="msg_row"]').length,
    longtasks: window.__longtasks.length,
  };
});
console.log(`# 滚动 60 帧：总 ${scrollPerf.totalMs}ms · 平均帧 ${scrollPerf.frameAvg}ms · 最大 ${scrollPerf.frameMax}ms · >50ms 帧 ${scrollPerf.over50} · 窗口行 ${scrollPerf.rows} · 长任务 ${scrollPerf.longtasks}`);

// 筛选响应
const tFilter = Date.now();
await page.evaluate(() => {
  window.__lag.length = 0;
  window.__longtasks.length = 0;
});
await page.fill('[data-testid="entry_query"]', '的');
await page.press('[data-testid="entry_query"]', 'Enter');
await page.waitForFunction(() => /匹配 \d+ 条/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''), null, { timeout: 30000 });
const filterMs = Date.now() - tFilter;
const afterFilter = await page.evaluate(() => ({
  maxDrift: Math.max(0, ...window.__lag.map((x) => x.drift)),
  longtasks: window.__longtasks.slice(0, 6),
}));
console.log(`# 筛选响应 ${filterMs}ms · 最大延迟 ${afterFilter.maxDrift}ms · 长任务 ${JSON.stringify(afterFilter.longtasks)}`);

// 还原
await page.click('[data-testid="btn_reset"]');
await page.evaluate(() => clearInterval(window.__lagTimer));
await page.screenshot({ path: 'test-results/real-acceptance/perf-after-load.png' });
// 故意不 close：保活真实壳
process.exit(0);
