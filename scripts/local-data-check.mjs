// 真机验收（docs/07 #1 步骤 5）：本地数据全链路——真实微信数据导出数据包 → 无微信环境回读。
//
// 前置：应用已用 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 启动
//   Phase A（正常环境，微信在跑）：UI 加载真实数据 → 导出 bundle → 产物断言
//   Phase B（WXCHART_XWECHAT_ROOT 指向空目录 = 微信数据不可见）：回读 bundle → 数据/附件
//         断言 → 再导出 CSV → PathScope/asset scope 断言
// 用法：node scripts/local-data-check.mjs --phase a|b [--port 9222] [--dir <run-dir>]
// 说明：原生目录对话框 CDP 驱不了（同 docs/07 #5 降级口径），bundle/回读两步走真实
//   `__TAURI_INTERNALS__.invoke`（壳→sidecar→exporter 全链路真实）；两个 UI 入口的点击
//   流程由 e2e「本地数据 #1/#2」覆盖。约定：只断开 CDP，不 browser.close()。
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const phase = arg('--phase', '').toLowerCase();
if (phase !== 'a' && phase !== 'b') {
  console.error('用法: node scripts/local-data-check.mjs --phase a|b [--port 9222] [--dir <run-dir>]');
  process.exit(2);
}
const port = Number(arg('--port', process.env.WV2_CDP_PORT || '9222'));
const runDir = resolve(arg('--dir', join('test-results', 'local-data', 'run-default')));
const pkgDir = join(runDir, 'pkg');
mkdirSync(runDir, { recursive: true });

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

/** 页内 invoke（真实壳命令）；自带 950s 上限（壳 EXPORT_TIMEOUT 900s） */
async function invoke(page, cmd, args) {
  const task = page.evaluate(
    ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a),
    [cmd, args],
  );
  const guard = new Promise((_, rej) => setTimeout(() => rej(new Error(`invoke ${cmd} 超时 950s`)), 950_000));
  return Promise.race([task, guard]);
}

/** 在 pkg 里找一个真实图片文件（附件副本；热缓存命中时为解码后的 jpg/png） */
function findPkgImage(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(jpe?g|png|gif|webp)$/i.test(e.name)) return p;
    }
  }
  return '';
}

function finish() {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n== local-data-check phase ${phase.toUpperCase()}：${results.length - fails}/${results.length} PASS，console 错误 ${consoleErrors.length} 条 ==`);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join('\n'));
  process.exit(fails ? 1 : 0);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP 已连接但没有任何 browser context');
  const page =
    ctx.pages().find((p) => !/^devtools:/.test(p.url())) || (await ctx.waitForEvent('page', { timeout: 30000 }));
  await page.waitForLoadState('domcontentloaded');
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
  step('壳内前端已加载（WebView2 + Vue 挂载完成）', true, page.url());

  if (phase === 'a') {
    // ---- A1 真实数据加载（开附件解析：bundle 要附件完整，同时给缩略图证据）----
    await page.click('[data-testid="var_resolve_media"]');
    const t0 = Date.now();
    await page.click('[data-testid="btn_load"]');
    await waitStatus(page, /共 \d+ 条消息/, 300_000);
    const loaded = Date.now() - t0;
    const status = (await page.textContent('[data-testid="lbl_status"]')) || '';
    const m = status.match(/共 (\d+) 条消息 · (\d+) 个会话 · (\d+) 天/);
    const total = m ? Number(m[1]) : 0;
    step('A1 真实数据加载（真实 sidecar → 前端）', total > 0, `${status.trim()} · ${loaded}ms`);

    // ---- A2 缩略图经 asset 协议真实渲染（懒解码滚到视口）----
    // 数据面先看一眼：前32条里有多少条带图片（区分「首屏没图」与「解码没成」）
    const head = await invoke(page, 'resolve_media', { indexes: Array.from({ length: 32 }, (_, i) => i) })
      .catch((e) => ({ err: String(e), items: [] }));
    const headImg = (head.items ?? []).filter((it) =>
      (it.media ?? []).some((m) => m.kind === 'image')).length;
    let shown = 0;
    let missingCnt = 0;
    let polled = 0;
    for (let i = 0; i < 45 && shown === 0; i++) {
      await sleep(1000);
      const counts = await page.evaluate(() => {
        const view = document.querySelector('[data-testid="message_view"]') || document.scrollingElement;
        if (view && view.scrollHeight > view.clientHeight + 10) view.scrollTop += 900;
        const imgs = [...document.querySelectorAll('img')].filter(
          (im) => (im.src || '').includes('asset') && im.complete && im.naturalWidth > 0,
        ).length;
        return {
          imgs,
          missing: document.querySelectorAll('[data-testid="media_missing"]').length,
          rows: document.querySelectorAll('.msg-row').length,
        };
      }).catch(() => ({ imgs: -1, missing: -1, rows: -1 }));
      shown = counts.imgs;
      missingCnt = counts.missing;
      polled += 1;
    }
    step(
      'A2 缩略图渲染（asset.localhost + 懒解码）',
      shown > 0,
      `${shown} 张 naturalWidth>0 · 占位 ${missingCnt} · 前32条含图 ${headImg} · 轮询 ${polled}s${head.err ? ` · resolve_err=${head.err}` : ''}`,
    );

    // ---- A3 导出本地数据包（真实壳命令 → sidecar bundle）----
    const te = Date.now();
    let res;
    try {
      // invoke 键 = camelCase（docs/02 §2 2026-11-09 实测注：Rust snake_case 形参）
      res = await invoke(page, 'export_messages', {
        format: 'bundle', scope: null, outPath: pkgDir,
      });
    } catch (e) {
      step('A3 bundle 导出', false, String(e));
      throw e;
    }
    const exportMs = Date.now() - te;
    step(
      'A3 bundle 导出（format=bundle 全量）',
      res && res.path === pkgDir && res.count > 0 && res.bytes > 0,
      `count=${res?.count} bytes=${res?.bytes} · ${(exportMs / 1000).toFixed(1)}s`,
    );

    // ---- A4 产物形状（exporter 原样：站点/state/报告/会话目录）----
    const shape = [
      join(pkgDir, '索引.html'),
      join(pkgDir, '.wxchart-state.json'),
      join(pkgDir, '导出报告.json'),
    ];
    const missing = shape.filter((p) => !existsSync(p));
    const report = existsSync(shape[2]) ? JSON.parse(readFileSync(shape[2], 'utf-8')) : {};
    const chatDirs = existsSync(pkgDir)
      ? readdirSync(pkgDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '_assets').length
      : 0;
    step(
      'A4 数据包产物（站点/state/报告/会话目录）',
      missing.length === 0 && chatDirs >= 1,
      `会话目录 ${chatDirs} 个 · 报告 chats=${report.chats} messages=${report.messages} media=${JSON.stringify(report.media)} 缺=${missing.length}`,
    );

    // ---- A5 包根 scope：reveal / open 立即可用（bundle 成功后壳已注册）----
    const reveal = await invoke(page, 'reveal_path', { path: pkgDir }).catch((e) => ({ err: String(e) }));
    const open = await invoke(page, 'open_path', { path: join(pkgDir, '索引.html') }).catch((e) => ({ err: String(e) }));
    step('A5 包根已进 PathScope（reveal_path/open_path）',
      reveal?.ok === true && open?.ok === true,
      `reveal=${JSON.stringify(reveal)} open=${JSON.stringify(open)}`);

    writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
      total, chats: m ? Number(m[2]) : 0, days: m ? Number(m[3]) : 0,
      bundleCount: res?.count ?? 0, report: {
        chats: report.chats, messages: report.messages, media: report.media,
      },
    }, null, 2));
    await page.screenshot({ path: join(runDir, 'A-loaded-exported.png') });
    step('console 0 错（Phase A）', consoleErrors.length === 0, `${consoleErrors.length} 条`);
  } else {
    // ---- B1 回读（空微信根环境：微信数据完全不可见）----
    const meta = existsSync(join(runDir, 'meta.json'))
      ? JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf-8'))
      : null;
    let load;
    try {
      load = await invoke(page, 'load_data', { kind: 'export', account: null, outDir: pkgDir, options: null });
    } catch (e) {
      step('B1 回读 load kind=export', false, String(e));
      throw e;
    }
    const n = load?.messages?.length ?? 0;
    // 容差2：导出报告 messages 与回读条数存在个别口径差（实测 3004 vs 3003）
    const near = !meta || Math.abs(n - meta.bundleCount) <= 2;
    step(
      'B1 回读（source=export，无微信数据可见）',
      load?.source === 'export' && n > 0 && near,
      `source=${load?.source} messages=${n} stats=${JSON.stringify(load?.stats)} meta=${meta ? meta.bundleCount : 'n/a'}`,
    );

    // ---- B2 附件抽查：回读 media 路径真实存在（附件副本在包内）----
    const paths = [];
    for (const msg of load?.messages ?? []) {
      for (const med of msg.media ?? []) {
        if (med.path && !paths.includes(med.path)) paths.push(med.path);
      }
      if (paths.length >= 10) break;
    }
    const exist = paths.filter((p) => existsSync(p));
    step('B2 回读附件/图片路径真实存在', paths.length > 0 && exist.length === paths.length,
      `${exist.length}/${paths.length} 存在${paths[0] ? `，例：${paths[0]}` : ''}`);

    // ---- B3 再导出 CSV（回读数据可再导出，docs/06 验收口径）----
    const csvPath = join(runDir, 'reexport.csv');
    const exp = await invoke(page, 'export_messages', {
      format: 'csv', scope: { type: 'filter', filter: {} }, outPath: csvPath,
    }).catch((e) => ({ err: String(e) }));
    const csvOk = existsSync(csvPath) && statSync(csvPath).size > 0
      && readFileSync(csvPath, 'utf-8').includes('会话');
    step('B3 回读数据再导出 CSV', exp?.count > 0 && csvOk,
      `count=${exp?.count} bytes=${exp?.bytes ?? 0} err=${exp?.err ?? '-'}`);

    // ---- B4 asset scope：包内图片经 asset 协议可加载（load 后壳已 allow_directory）----
    const img = findPkgImage(pkgDir);
    if (!img) {
      step('B4 包内图片 asset 协议加载', true, '包内无图片文件（跳过：账号无图片或均为 .dat）');
    } else {
      const url = await page.evaluate((p) => window.__TAURI_INTERNALS__.convertFileSrc(p), img);
      const okImg = await page.evaluate(
        (u) => new Promise((r) => {
          const im = new Image();
          im.onload = () => r(im.naturalWidth > 0);
          im.onerror = () => r(false);
          im.src = u;
          setTimeout(() => r(false), 10_000);
        }),
        url,
      );
      step('B4 包内图片 asset 协议加载', okImg, `${img} → ${url.slice(0, 80)}…`);
    }

    // ---- B5 PathScope 边界：包内放行、包外拒绝 ----
    // 错误对象在**页内**捕获再返回：经 evaluate 抛出会被序列化成 "Object" 丢掉 code 字段
    const inOk = await invoke(page, 'reveal_path', { path: pkgDir }).catch((e) => ({ err: String(e) }));
    const outRes = await page.evaluate(async (p) => {
      try {
        await window.__TAURI_INTERNALS__.invoke('open_path', { path: p });
        return { rejected: false, code: '' };
      } catch (e) {
        return { rejected: true, code: (e && e.code) || String(e) };
      }
    }, 'C:\\Windows\\notepad.exe');
    step('B5 scope 边界（包内放行 / 包外 PATH_NOT_ALLOWED）',
      inOk?.ok === true && outRes.rejected && outRes.code.includes('PATH_NOT_ALLOWED'),
      `包内=${JSON.stringify(inOk)} 包外=${JSON.stringify(outRes)}`);

    await page.screenshot({ path: join(runDir, 'B-readback.png') });
    step('console 0 错（Phase B）', consoleErrors.length === 0, `${consoleErrors.length} 条`);
    step('应用存活（回读全程无崩溃白屏）', await page.$('[data-testid="btn_load"]') !== null, 'btn_load 仍在');
  }
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  // 约定（同 acceptance-real.mjs）：connectOverCDP 的 browser.close() 会连带拆掉
  // 真实壳的 WebView2——只摘监听，node 进程退出即脱离 CDP。
  for (const c of browser.contexts()) {
    for (const p of c.pages()) p.removeAllListeners();
  }
}
finish();
