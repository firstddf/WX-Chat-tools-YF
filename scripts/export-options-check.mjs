// 真机验收（docs/07 #14 步骤 4）：导出设置页 —— 选择性 + 增量数据包全链路。
//
// 前置：安装版已带 CDP 端口启动（`pnpm tauri build -c test-results/m-a4/tauri.cdp.json`
//   → `setup.exe /S` → 启动，端口 9223 监听），微信在跑（导出要密钥）。
// 检查项（严格按 docs/07 #14 步骤 4）：
//   S1 加载真实数据（开附件解析）
//   S2 首跑全量 bundle（无 options）→ mode=full + 报告 mode + result camelCase（newMessages）
//   S3 同目录二跑增量（options.incremental）→ mode=incremental、新增条数、**目录字节不暴涨**
//       （附件 blake2b 复用不重复复制）+ 跳过无新消息会话
//   S4 会话子集包（options.chats）/ S5 时间子集包（start_ts/end_ts）/ S6 类型子集包（include）
//   S7 三个子集包 `load_data kind=export` 回读断言（会话唯一 / 时间闭区间 / 无媒体类型）
//   S8 console 0 错 + 截图
// 降级口径（同 docs/07 #1 / #5）：原生目录对话框 CDP 驱不了 → 导出/回读两步走真实
//   `__TAURI_INTERNALS__.invoke`（壳→sidecar→exporter 全链路真实）；面板点击流程由
//   e2e「导出设置 #14」两条覆盖。
// 用法：node scripts/export-options-check.mjs [--port 9223] [--dir <run-dir>]
// 约定：只断开 CDP，不 browser.close()。
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
const runDir = resolve(arg('--dir', join('test-results', 'export-options', `run-${stamp}`)));
mkdirSync(runDir, { recursive: true });

const results = [];
const consoleErrors = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** YYYY-MM-DD → unix 秒（同 Tk gui._parse_date / ChatList.dayToTs：起 00:00:00、止 23:59:59） */
function dayTs(day, end) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (end) dt.setDate(dt.getDate() + 1);
  return Math.floor(dt.getTime() / 1000) - (end ? 1 : 0);
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

function readJson(p) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
}

function finish() {
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\n== export-options-check：${results.length - fails}/${results.length} PASS，console 错误 ${consoleErrors.length} 条 ==`);
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 10).join('\n'));
  console.log(`产物目录：${runDir}`);
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

  // 页签用 v-show：上一轮若停在管理页，筛选页按钮是 hidden → 先切回筛选页
  await page.waitForSelector('[data-testid="tab_filter"]', { timeout: 60000 });
  await page.click('[data-testid="tab_filter"]').catch(() => {});
  await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
  step('壳内前端已加载（安装版 CDP 9223）', true, page.url());

  const info = await invoke(page, 'app_info').catch((e) => ({ err: String(e) }));
  step('sidecar 握手 ready', info?.sidecar?.state === 'ready', JSON.stringify(info?.sidecar ?? info?.err));

  // ---- S1 加载真实数据（开附件解析：bundle 要附件完整，同 local-data-check Phase A）----
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
  const m = status.match(/共 (\d+) 条消息 · (\d+) 个会话 · (\d+) 天/);
  const total = m ? Number(m[1]) : 0;
  step('S1 真实数据加载', total > 0, `${status.trim().slice(0, 120)} · ${(loadMs / 1000).toFixed(1)}s`);
  await page.screenshot({ path: join(runDir, '01-loaded.png') });

  const pkgFull = join(runDir, 'pkg-full');
  const reportPath = join(pkgFull, '导出报告.json');
  const statePath = join(pkgFull, '.wxchart-state.json');

  // ---- S2 首跑全量（无 options = Phase 1 全量行为，向后兼容）----
  const te1 = Date.now();
  const full = await invoke(page, 'export_messages', { format: 'bundle', scope: null, outPath: pkgFull });
  const ms1 = Date.now() - te1;
  const report1 = readJson(reportPath);
  step(
    'S2 首跑全量：result mode=full + 报告 mode=full + count/bytes>0',
    full?.mode === 'full' && report1?.mode === 'full' && full.count > 0 && full.bytes > 0,
    `count=${full?.count} bytes=${full?.bytes} report.mode=${report1?.mode} · ${(ms1 / 1000).toFixed(1)}s`,
  );
  step(
    'S2b result camelCase：newMessages 在、new_messages 不在（壳改键，docs/02 §2）',
    typeof full?.newMessages === 'number' && full?.new_messages === undefined,
    `newMessages=${full?.newMessages} new_messages=${JSON.stringify(full?.new_messages)}`,
  );

  const state = readJson(statePath);
  const chatIds = Object.keys(state?.chats ?? {});
  step('S2c state 就绪（会话清单 + 按日期清单）', chatIds.length > 0 && (state?.day_entries?.length ?? 0) > 0,
    `chats=${chatIds.length} day_entries=${state?.day_entries?.length ?? 0}`);

  // ---- S3 同目录二跑增量 ----
  const te2 = Date.now();
  const inc = await invoke(page, 'export_messages', {
    format: 'bundle', scope: null, outPath: pkgFull, options: { incremental: true },
  });
  const ms2 = Date.now() - te2;
  const report2 = readJson(reportPath);
  const growth = (inc?.bytes ?? 0) - (full?.bytes ?? 0);
  const limit = Math.round(full.bytes * 0.05) + 1024 * 1024; // 5% + 1MB 容差
  step(
    'S3 二跑增量：mode=incremental + 跳过无新消息会话',
    inc?.mode === 'incremental' && report2?.mode === 'incremental' && (report2?.skipped_chats ?? 0) >= 1,
    `newMessages=${inc?.newMessages} skipped=${report2?.skipped_chats} · ${(ms2 / 1000).toFixed(1)}s（首跑 ${(ms1 / 1000).toFixed(1)}s）`,
  );
  step(
    'S3b 目录字节不暴涨（附件 blake2b 复用不重复复制）',
    growth <= limit,
    `bytes ${full.bytes} → ${inc.bytes}（增长 ${growth}，上限 ${limit}）`,
  );
  step(
    'S3c 新增条数与报告一致（new_messages 线格式）',
    typeof inc?.newMessages === 'number' && inc.newMessages === (report2?.new_messages ?? -1),
    `result=${inc?.newMessages} report=${report2?.new_messages}`,
  );

  // ---- S4 会话子集包：挑条数最少的会话（导出快、断言稳）----
  const pickChat = chatIds
    .map((id) => ({ id, count: Number(state.chats[id]?.count ?? 0) }))
    .filter((c) => c.count > 0)
    .sort((a, b) => a.count - b.count)[0];
  const pkgChat = join(runDir, 'pkg-chat');
  const chatRes = await invoke(page, 'export_messages', {
    format: 'bundle', scope: null, outPath: pkgChat, options: { chats: [pickChat.id] },
  });
  step(
    'S4 会话子集包（options.chats）',
    chatRes?.mode === 'full' && chatRes.count > 0 && chatRes.count <= pickChat.count,
    `chats=[${pickChat.id}] count=${chatRes?.count}（该会话 ${pickChat.count} 条）`,
  );

  // ---- S5 时间子集包：挑消息最少的一天 ----
  const perDay = new Map();
  for (const e of state.day_entries) perDay.set(e.d, (perDay.get(e.d) ?? 0) + 1);
  const pickDay = [...perDay.entries()].sort((a, b) => a[1] - b[1])[0];
  const startTs = dayTs(pickDay[0], false);
  const endTs = dayTs(pickDay[0], true);
  const pkgTime = join(runDir, 'pkg-time');
  const timeRes = await invoke(page, 'export_messages', {
    format: 'bundle', scope: null, outPath: pkgTime,
    options: { start_ts: startTs, end_ts: endTs },
  });
  step(
    'S5 时间子集包（start_ts/end_ts 闭区间）',
    timeRes?.count > 0 && timeRes.count < full.count && timeRes.count <= pickDay[1],
    `${pickDay[0]}（${pickDay[1]} 条）→ count=${timeRes?.count} < 全量 ${full.count}`,
  );

  // ---- S6 类型子集包：只导文字 ----
  const pkgType = join(runDir, 'pkg-type');
  const typeRes = await invoke(page, 'export_messages', {
    format: 'bundle', scope: null, outPath: pkgType, options: { include: ['text'] },
  });
  step(
    'S6 类型子集包（include=["text"]，text 恒含）',
    typeRes?.count > 0 && typeRes.count <= full.count,
    `count=${typeRes?.count} ≤ 全量 ${full.count}`,
  );

  // ---- S7 三个子集包回读（load_source kind=export；此后不再导出）----
  const back1 = await invoke(page, 'load_data', { kind: 'export', account: null, outDir: pkgChat, options: null });
  const ids1 = new Set((back1?.chats ?? []).map((c) => c.chat_id));
  const onlyOne = ids1.size === 1 && ids1.has(pickChat.id);
  const msgsAllOne = (back1?.messages ?? []).every((mm) => mm.chat_id === pickChat.id);
  step(
    'S7a 会话子集回读：只有该会话',
    back1?.source === 'export' && (back1?.messages?.length ?? 0) > 0 && onlyOne && msgsAllOne,
    `chats=${(back1?.chats ?? []).map((c) => c.chat_id).join(',')} messages=${back1?.messages?.length ?? 0}`,
  );

  const back2 = await invoke(page, 'load_data', { kind: 'export', account: null, outDir: pkgTime, options: null });
  const outOfRange = (back2?.messages ?? []).filter((mm) => mm.ts < startTs || mm.ts > endTs);
  step(
    'S7b 时间子集回读：全部落在闭区间内',
    back2?.source === 'export' && (back2?.messages?.length ?? 0) > 0 && outOfRange.length === 0,
    `messages=${back2?.messages?.length ?? 0} 越界=${outOfRange.length} 区间=[${startTs},${endTs}]`,
  );

  const back3 = await invoke(page, 'load_data', { kind: 'export', account: null, outDir: pkgType, options: null });
  const mediaTypes = ['image', 'file', 'video', 'voice'];
  const withMedia = (back3?.messages ?? []).filter((mm) => mediaTypes.includes(mm.mtype));
  step(
    'S7c 类型子集回读：无图片/文件/视频/语音正文',
    back3?.source === 'export' && (back3?.messages?.length ?? 0) > 0 && withMedia.length === 0,
    `messages=${back3?.messages?.length ?? 0} 媒体类型=${withMedia.length}`,
  );

  // ---- S8 收尾：**UI 链路**回读 + console + 截图 ----
  // S7 的三次回读是直 invoke（绕过 store——#6 坑：store 状态不刷新，信息卡仍是「扫描」），
  // 这里补一条真实按钮链路：set_settings 注入最近目录 → reload →「打开最近数据」→ 信息卡。
  await invoke(page, 'set_settings', { patch: { last_export_dir: pkgType } });
  await page.reload().catch(() => {});
  await page.waitForSelector('[data-testid="btn_load"]', { timeout: 60000 });
  await page.click('[data-testid="tab_manage"]');
  const recent = await page
    .waitForSelector('[data-testid="btn_open_recent"]', { state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  step('S8a「打开最近数据」按钮出现（last_export_dir 记忆 + reload 重读）', recent);
  if (recent) await page.click('[data-testid="btn_open_recent"]');
  const cardOk = await page
    .waitForFunction(
      (cnt) => {
        const src = document.querySelector('[data-testid="card_source"]')?.textContent || '';
        const card = document.querySelector('[data-testid="card_count"]')?.textContent || '';
        return /来源：导出目录/.test(src) && card.includes(String(cnt));
      },
      typeRes.count,
      { timeout: 60_000 },
    )
    .then(() => true)
    .catch(() => false);
  const card =
    ((await page.textContent('[data-testid="card_source"]').catch(() => '')) || '').trim() +
    ' | ' +
    ((await page.textContent('[data-testid="card_count"]').catch(() => '')) || '').trim();
  step(
    'S8b UI 链路回读：信息卡「来源：导出目录 · 条数 = 类型子集条数」',
    cardOk,
    `${card.slice(0, 160)}（期望条数 ${typeRes.count}）`,
  );
  await page.screenshot({ path: join(runDir, '08-subset-readback.png') });
  step('console 0 错', consoleErrors.length === 0, `${consoleErrors.length} 条`);

  writeFileSync(
    join(runDir, 'meta.json'),
    JSON.stringify(
      {
        total,
        chats: m ? Number(m[2]) : 0,
        days: m ? Number(m[3]) : 0,
        full: { count: full.count, bytes: full.bytes, ms: ms1 },
        incremental: { count: inc.count, bytes: inc.bytes, ms: ms2, newMessages: inc.newMessages, skipped: report2?.skipped_chats },
        subsets: {
          chat: { id: pickChat.id, count: chatRes.count },
          time: { day: pickDay[0], start_ts: startTs, end_ts: endTs, count: timeRes.count },
          type: { include: ['text'], count: typeRes.count },
        },
      },
      null,
      2,
    ),
  );
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  // 约定（同 local-data-check.mjs）：只摘监听，node 进程退出即脱离 CDP，不 browser.close()
  for (const c of browser.contexts()) {
    for (const p of c.pages()) p.removeAllListeners();
  }
}
finish();
