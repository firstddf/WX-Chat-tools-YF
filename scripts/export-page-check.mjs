// 真机验收（docs/07 #17）：导出独立页签 —— 三段布局 + 会话勾选 + 真实数据导出全链路。
//
// 前置：安装版已带 CDP 端口启动（`pnpm tauri build -c test-results/m-a4/tauri.cdp.json`
//   → `setup.exe /S` → 启动，端口 9223 监听），微信在跑（导出要密钥）。
// 检查项：
//   S1 前端加载 + sidecar 握手 ready
//   S2 页签顺序照 Tk（导出 → 数据筛选 → 聊天数据管理）+ 导出页三段布局可见
//   S3 set_settings 注入输出目录 → reload → 导出页输出目录预填（last_export_dir 记忆链路）
//   S4 筛选页加载真实数据（开附件解析）→ 共 N 条 / C 个会话
//   S5 回导出页：列表行数 == 会话数、默认全选、已选 C/C、勾选框 C 个
//   S6 勾选交互（真机点击）：点第 1 行 → 已选 C-1 → 再点 → C
//   S7 搜索过滤（用首行会话 ID）→ 只剩 1 行 → 清空恢复 C 行
//   S8 清空 → Ctrl+A = 全选会话（App 在导出页转发）
//   S9 ▶开始导出（真实 bundle → 新目录）→ export_notice 完成文案 + export_log 时间戳行 + 报告条数
//   S10 console 0 错 + 截图
// 约定：只断开 CDP，不 browser.close()。
// 用法：node scripts/export-page-check.mjs [--port 9223] [--dir <run-dir>]
import { chromium } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const port = Number(arg('--port', process.env.WV2_CDP_PORT || '9223'));
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const runDir = resolve(arg('--dir', join('test-results', 'export-page', `run-${stamp}`)));
mkdirSync(runDir, { recursive: true });
const pkgDir = join(runDir, 'pkg');

const results = [];
const consoleErrors = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 页内 invoke（真实壳命令） */
async function invoke(page, cmd, args) {
  return page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
}

function readJson(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
}

function finish() {
  const fails = results.filter((r) => !r.ok).length;
  console.log(
    `\n== export-page-check：${results.length - fails}/${results.length} PASS，console 错误 ${consoleErrors.length} 条 ==`,
  );
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join('\n'));
  console.log(`产物目录：${runDir}`);
  process.exit(fails ? 1 : 0);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('CDP 已连接但没有任何 browser context');
  const page =
    ctx.pages().find((p) => !/^devtools:/.test(p.url())) ||
    (await ctx.waitForEvent('page', { timeout: 30000 }));
  await page.waitForLoadState('domcontentloaded');
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ---- S1 前端加载 + sidecar ready ----
  await page.waitForSelector('[data-testid="tab_filter"]', { timeout: 60000 });
  await page.click('[data-testid="tab_filter"]').catch(() => {});
  await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
  step('S1 壳内前端已加载（安装版 CDP 9223）', true, page.url());
  const info = await invoke(page, 'app_info').catch((e) => ({ err: String(e) }));
  step(
    'S1b sidecar 握手 ready',
    info?.sidecar?.state === 'ready',
    JSON.stringify(info?.sidecar ?? info?.err),
  );

  // ---- S2 页签顺序（照 Tk gui.py:103/158/160）+ 三段布局 ----
  const tabTexts = await page.$$eval('.tabbar button', (els) => els.map((e) => e.textContent?.trim()));
  step(
    'S2a 页签顺序 = 导出 / 数据筛选 / 聊天数据管理',
    tabTexts.join('|') === '导出|数据筛选|聊天数据管理',
    tabTexts.join(' | '),
  );
  await page.click('[data-testid="tab_export"]');
  await page.waitForSelector('[data-testid="page_export"]', { state: 'visible', timeout: 15000 });
  const seg = await page.evaluate(() => ({
    tree: !!document.querySelector('[data-testid="exp_chat_tree"]'),
    settings: !!document.querySelector('[data-testid="export_settings"]'),
    log: !!document.querySelector('[data-testid="export_log"]'),
    start: !!document.querySelector('[data-testid="btn_export_start"]'),
    stop: !!document.querySelector('[data-testid="btn_export_stop"]'), // A3：不放「■停止」
    noPanel: !document.querySelector('[data-testid="page_manage"] [data-testid="export_settings"]'),
  }));
  step(
    'S2b 导出页三段布局（左列表/右设置卡/底动作条+日志）+ 管理页无内嵌面板',
    seg.tree && seg.settings && seg.log && seg.start && seg.noPanel && !seg.stop,
    JSON.stringify(seg),
  );
  await page.screenshot({ path: join(runDir, '01-export-page.png') });

  // ---- S3 set_settings 注入输出目录 → reload → 预填（#14 同款：直 invoke 绕过 store 需 reload）----
  await invoke(page, 'set_settings', { patch: { last_export_dir: pkgDir } });
  await page.reload().catch(() => {});
  await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
  await page.click('[data-testid="tab_export"]');
  const dirVal = await page.inputValue('[data-testid="entry_exp_dir"]').catch(() => '');
  step('S3 输出目录预填 last_export_dir（记忆链路）', dirVal === pkgDir, dirVal);

  // ---- S4 筛选页加载真实数据（开附件解析，bundle 要附件完整）----
  await page.click('[data-testid="tab_filter"]');
  await page.click('[data-testid="var_resolve_media"]');
  const t0 = Date.now();
  await page.click('[data-testid="btn_load"]');
  await page.waitForFunction(
    () => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''),
    null,
    { timeout: 300_000 },
  );
  const loadMs = Date.now() - t0;
  const status = (await page.textContent('[data-testid="lbl_status"]')) || '';
  const m = status.match(/共 (\d+) 条消息 · (\d+) 个会话/);
  const total = m ? Number(m[1]) : 0;
  const chats = m ? Number(m[2]) : 0;
  step('S4 真实数据加载', total > 0 && chats > 0, `${status.trim().slice(0, 140)} · ${(loadMs / 1000).toFixed(1)}s`);

  // ---- S5 导出页列表：行数 == 会话数、默认全选、勾选框齐 ----
  await page.click('[data-testid="tab_export"]');
  await page.waitForSelector('[data-testid="exp_chat_row"]', { timeout: 30000 });
  const rowCount = await page.locator('[data-testid="exp_chat_row"]').count();
  const checkCount = await page.locator('[data-testid="exp_chat_check"]').count();
  const countText = ((await page.textContent('[data-testid="exp_chat_count"]')) || '').replace(/\s+/g, '');
  step(
    'S5 列表行数 == 会话数、默认全选、勾选框齐',
    rowCount === chats && checkCount === chats && countText.includes(`已选${chats}/${chats}`),
    `行=${rowCount} 勾选框=${checkCount} 计数行=${countText}`,
  );

  // ---- S6 勾选交互（真机点击）：第 1 行 → C-1 → 再点 → C ----
  const first = page.locator('[data-testid="exp_chat_check"]').first();
  await first.click();
  const afterOff = ((await page.textContent('[data-testid="exp_chat_count"]')) || '').replace(/\s+/g, '');
  await first.click();
  const afterOn = ((await page.textContent('[data-testid="exp_chat_count"]')) || '').replace(/\s+/g, '');
  step(
    'S6 勾选框点击往返（C → C-1 → C）',
    afterOff.includes(`已选${chats - 1}/${chats}`) && afterOn.includes(`已选${chats}/${chats}`),
    `${afterOff} → ${afterOn}`,
  );

  // ---- S7 搜索过滤（用首行会话 ID，唯一命中）→ 1 行 → 清空恢复 ----
  const firstMeta = ((await page.textContent('[data-testid="exp_chat_row"]')) || '').trim();
  const idMatch = firstMeta.match(/(?:群号|会话ID)\s+(\S+)/);
  const keyword = idMatch ? idMatch[1] : '';
  await page.fill('[data-testid="exp_entry_search"]', keyword);
  const filtered = await page.locator('[data-testid="exp_chat_row"]').count();
  await page.fill('[data-testid="exp_entry_search"]', '');
  const restored = await page.locator('[data-testid="exp_chat_row"]').count();
  step(
    'S7 搜索过滤（会话 ID 唯一命中 1 行）+ 清空恢复',
    keyword !== '' && filtered === 1 && restored === chats,
    `关键词=${keyword} 过滤后=${filtered} 恢复=${restored}`,
  );

  // ---- S8 清空 → Ctrl+A = 全选（App 在导出页转发）----
  await page.click('[data-testid="btn_exp_none"]');
  await page.click('[data-testid="exp_chat_count"]'); // 焦点落到非输入元素
  await page.keyboard.press('Control+A');
  const afterCtrlA = ((await page.textContent('[data-testid="exp_chat_count"]')) || '').replace(/\s+/g, '');
  step(
    'S8 Ctrl+A = 全选会话（吞掉整页全选）',
    afterCtrlA.includes(`已选${chats}/${chats}`),
    afterCtrlA,
  );

  // ---- S9 ▶开始导出（真实 bundle → 新目录）----
  const te = Date.now();
  await page.click('[data-testid="btn_export_start"]');
  const noticeOk = await page
    .waitForFunction(
      () => /已导出数据包|增量导出完成/.test(document.querySelector('[data-testid="export_notice"]')?.textContent || ''),
      null,
      { timeout: 300_000 },
    )
    .then(() => true)
    .catch(() => false);
  const ms = Date.now() - te;
  const notice = ((await page.textContent('[data-testid="export_notice"]').catch(() => '')) || '').trim();
  const report = readJson(join(pkgDir, '导出报告.json'));
  const logText = ((await page.textContent('[data-testid="export_log"]').catch(() => '')) || '').trim();
  step(
    'S9 开始导出 → 完成文案 + 报告 messages == 加载条数',
    noticeOk && report?.messages === total,
    `${notice} · report.messages=${report?.messages} 期望=${total} mode=${report?.mode} · ${(ms / 1000).toFixed(1)}s`,
  );
  step(
    'S9b 日志框有时间戳行 + 进度/动作条在位',
    /\[\d{2}:\d{2}:\d{2}\]/.test(logText) && logText.includes('开始导出'),
    logText.split('\n').slice(-2).join(' / ').slice(0, 200),
  );
  await page.screenshot({ path: join(runDir, '02-export-done.png') });

  // ---- S10 收尾 ----
  step('S10 console 0 错', consoleErrors.length === 0, `${consoleErrors.length} 条`);
  writeFileSync(
    join(runDir, 'meta.json'),
    JSON.stringify(
      {
        tabs: tabTexts,
        total,
        chats,
        layout: seg,
        export: { messages: report?.messages, mode: report?.mode, duration_sec: report?.duration_sec, ms, notice },
      },
      null,
      2,
    ),
  );
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  // 约定：只摘监听，node 进程退出即脱离 CDP，不 browser.close()
  for (const c of browser.contexts()) {
    for (const p of c.pages()) p.removeAllListeners();
  }
}
finish();
