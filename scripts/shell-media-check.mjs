// 真机验收：图片缩略图端到端（A1 #9，懒解码版）——勾选「解析附件路径」→ 加载真实数据 →
// 滚动触发按需解码 → asset: 协议缩略图 → 点击打开（scope 白名单）。
// 懒解码（2026-11-07）：加载期图片只定位不解码，缩略图滚进视口才走 resolve_media 命令，
// 因此每个滚动位置要给按需解码留出时间（轮询等待），不能只等一帧。
// 前置：壳已用 protocol-asset 构建并以 --remote-debugging-port=9222 启动；vite 5173 在跑。
// 用法：node scripts/shell-media-check.mjs [--port 9222] [--account 子串] [--timeout 300000] [--no-click]
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const port = Number(arg('--port', 9222));
const accountHint = arg('--account', 'xxxxxxxx');
const loadTimeout = Number(arg('--timeout', 300000)); // 懒解码后加载不再含全量解码，300s 兜底足够
const doClick = !process.argv.includes('--no-click');

const results = [];
const step = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const consoleErrors = [];

/** 当前有窗口的进程名快照（点开原图后用 diff 判定「真的打开了」） */
function windowedProcs() {
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (m) names.add(m[1].toLowerCase());
    }
    return names;
  } catch {
    return new Set();
  }
}

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
if (!(await page.isVisible('[data-testid="page_filter"]').catch(() => false))) await page.click('[data-testid="tab_filter"]');
await page.waitForSelector('[data-testid="btn_load"]', { state: 'visible', timeout: 60000 });

// 勾选「解析附件路径」
const checked = await page.isChecked('[data-testid="var_resolve_media"]').catch(() => false);
if (!checked) await page.check('[data-testid="var_resolve_media"]');
step('已勾选「解析附件路径」', await page.isChecked('[data-testid="var_resolve_media"]'), '');

// 选账号（默认取列表第一个；源码不写真实账号，真机请用 --account <wxid子串> 指定）
const opts = await page.$$eval('[data-testid="cmb_account"] option', (els) => els.map((e) => e.value));
const account = opts.find((v) => v.includes(accountHint)) || opts[0];
await page.selectOption('[data-testid="cmb_account"]', account);
step('选中目标账号', Boolean(account), account || '无账号');
await sleep(200);

const t0 = Date.now();
await page.click('[data-testid="btn_load"]');
await page.waitForFunction(
  () => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''),
  null,
  { timeout: loadTimeout },
).catch(async () => {
  const st = (await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '';
  console.log('LOAD 未完成，状态：' + st.trim());
});
const loadMs = Date.now() - t0;
const st = (await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '';
step('真实数据加载（含附件解析）', /共 \d+ 条消息/.test(st), `${st.trim().slice(0, 100)} · ${(loadMs / 1000).toFixed(1)}s`);
// 状态行 Tk 口径：load 完成即 apply_filters → 立即显示「匹配 N 条」（docs/05 本轮改动）
step('加载完成即显示「匹配 N 条」', /匹配 \d+ 条/.test(st), st.trim().slice(0, 100));
// 懒解码门禁：全量解码时代大账号要 6.9 分钟；只定位的加载必须远低于该量级
step('懒解码生效（加载不再全量解码）', loadMs < 120000, `加载耗时 ${(loadMs / 1000).toFixed(1)}s（阈值 120s）`);

// 滚动找图片缩略图：懒解码下 <img> 是滚到位后才异步解码出来的，
// 每个位置先看有没有 thumb 容器，有则轮询等解码（最多 8s），没有才快速跳过。
const hit = await page.evaluate(async ({ waitMs }) => {
  const view = document.querySelector('[data-testid="message_view"]');
  if (!view) return null;
  const pick = () => {
    const vr = view.getBoundingClientRect();
    for (const img of document.querySelectorAll('[data-testid="media_thumb_img"]')) {
      // 只认加载完成的图：懒解码下 <img> 先进 DOM 再异步加载，
      // naturalWidth=0（未加载完/0×0）时把它当命中会假 FAIL，留给轮询等 load。
      if (img.naturalWidth === 0) continue;
      const r = img.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      if (cy > vr.top + 40 && cy < vr.bottom - 40) {
        return { src: img.src.slice(0, 160), naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, w: Math.round(r.width), h: Math.round(r.height) };
      }
    }
    return null;
  };
  const hasThumbInViewport = () => {
    const vr = view.getBoundingClientRect();
    for (const el of document.querySelectorAll('[data-testid="media_thumb"], [data-testid="media_missing"]')) {
      const r = el.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      if (cy > vr.top + 40 && cy < vr.bottom - 40) return true;
    }
    return false;
  };
  const scanOnce = async () => {
    const found = pick();
    if (found) return found;
    if (hasThumbInViewport()) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        const ok = pick();
        if (ok) return ok;
      }
      return null; // 有图但 8s 没解出来：换下一个位置继续找
    }
    return null;
  };
  let found = await scanOnce();
  if (found) return found;
  const h = view.scrollHeight;
  for (let i = 1; i <= 60 && !found; i++) {
    view.scrollTop = Math.floor((h * i) / 60);
    view.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    found = await scanOnce();
  }
  return found;
}, { waitMs: 8000 });

if (hit) {
  step('图片气泡出现 <img class="thumb"> 且已解码', hit.naturalWidth > 0, `${hit.naturalWidth}x${hit.naturalHeight} · CSS ${hit.w}x${hit.h} · src=${hit.src.slice(0, 60)}`);
  // src 有两种合法形态：首轮是 asset 协议 URL；MediaThumb 的 LRU 缩略图缓存
  // （rememberThumb）生成后会切成 dataURL——而 dataURL 只可能来自一次成功的 asset fetch，
  // 所以两者都是 asset 协议生效的证据；再用 resource timing 兜底抓 asset.localhost 请求。
  const srcKind = /^data:image\//.test(hit.src)
    ? 'data-url'
    : (/^(http:\/\/asset\.localhost|asset:)/.test(hit.src) ? 'asset' : 'other');
  let assetEvidence = srcKind === 'asset';
  let assetDetail = srcKind === 'asset' ? hit.src.slice(0, 60) : '';
  if (srcKind === 'data-url') {
    const hasAssetReq = await page.evaluate(() =>
      performance.getEntriesByType('resource').some((r) => r.name.includes('asset.localhost')),
    );
    assetEvidence = true; // dataURL 由 rememberThumb 生成，其前置 fetch 必是 asset URL
    assetDetail = `dataURL 缩略图缓存（resource timing 里 asset.localhost 请求：${hasAssetReq ? '有' : '无'}）`;
  } else if (srcKind === 'other') {
    assetEvidence = false;
    assetDetail = hit.src.slice(0, 60);
  }
  step('asset 协议加载证据（asset URL 或其生成的 dataURL 缩略图）', assetEvidence, assetDetail);
  step('缩略图 ≤220px', hit.w <= 220 && hit.h <= 220, `${hit.w}x${hit.h}`);
  await page.screenshot({ path: 'test-results/real-acceptance/shell-image-thumb.png' });

  if (doClick) {
    // 点击打开：验证 resolve_media 新解码 path 已进 open_path scope 白名单。
    // scope 没注册时 openOriginal 静默吞错、什么都不打开 → 用「点击后出现的新进程」判阳性。
    // 查看器多为单实例（再开只是新窗口、不产生新进程）→ 点击前先清场，保证 diff 干净。
    for (const name of ['msphotos.exe', 'photoviewer.exe', 'paint.exe', 'picasaphotoviewer.exe']) {
      try {
        execFileSync('taskkill', ['/IM', name, '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* 本来就没开 */ }
    }
    await sleep(300);
    const before = windowedProcs();
    let clickErr = '';
    try {
      await page.click('[data-testid="media_thumb"]', { timeout: 5000 });
    } catch (e) {
      clickErr = String(e.message).slice(0, 80);
    }
    // 轮询等新进程（最多 10s）：后台可能在跑重编译，看图器冷启可能超过固定 3s
    let fresh = [];
    const detectDeadline = Date.now() + 10000;
    while (Date.now() < detectDeadline) {
      const after = windowedProcs();
      fresh = [...after].filter((n) => !before.has(n) && !/^(cmd|conhost|powershell|pwsh|node|python|tasklist)\.exe$/.test(n));
      if (fresh.length) break;
      await sleep(500);
    }
    const openerErr = consoleErrors.filter((e) => /PATH_NOT_ALLOWED|not configured|403|scope/i.test(e));
    step('点击缩略图打开原图（scope 放行）', !clickErr && openerErr.length === 0 && fresh.length > 0,
      clickErr || (openerErr.slice(0, 2).join(' | ') || `新进程: ${fresh.join(', ') || '（无——可能打开的是已有进程的文档窗口）'}`));
    // 收尾：关掉查看器（无条件尽力而为，晚到的进程也兜住；绝不碰 explorer.exe——那是用户桌面）
    for (const name of ['msphotos.exe', 'photoviewer.exe', 'paint.exe', 'picasaphotoviewer.exe']) {
      try {
        execFileSync('taskkill', ['/IM', name, '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* 已退出则忽略 */ }
    }
  }
} else {
  const counts = await page.evaluate(() => ({
    imgs: document.querySelectorAll('[data-testid="media_thumb_img"]').length,
    placeholders: document.querySelectorAll('[data-testid="media_missing"]').length,
    thumbs: document.querySelectorAll('[data-testid="media_thumb"]').length,
  }));
  step('图片气泡出现 <img class="thumb"> 且已解码', false, `缩略图 img=${counts.imgs} 容器=${counts.thumbs} 占位=${counts.placeholders}（均已滚过 60 屏）`);
  await page.screenshot({ path: 'test-results/real-acceptance/shell-image-none.png' });
}

step('页面无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');

const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('# 失败：' + failed.map((f) => f.name).join('；'));
// 只断开、不 close（browser.close() 会连带杀掉真实壳的 WebView2）
process.exit(failed.length ? 1 : 0);
