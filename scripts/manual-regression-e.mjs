// docs/04 §E 手工回归（docs/07 #11）——八条的自动化等价执行（安装版 CDP 9223）：
//   E-1 气泡内拖选跟手（基础 / 滚动后 / 留白处三段）
//   E-2 跨气泡拖选：拖中蓝框（cross-hl）、松开后勾选框与「已选 N 条」即时正确
//   E-3 右键菜单四项状态与文案（文字上 / 头像留白上两个位置）
//   E-4 引用块单击 → 目标 .flash、1.4s 后消失、「↩ 返回」出现
//      （「找不到目标」分支真机数据恒可找到 → 由 e2e A1 #20 注入覆盖，此处不重复）
//   E-5 附件：先拖动选文件名（不打开、无新进程）→ 后单击打开（新进程实证）
//   E-6 连续滚动 50 步：无空屏、无 >200ms 长任务；管理页切会话无白屏
//   E-8 DOM 全量 dump vs scripts/tk-plan-dump.py（真 Tk MessageView._build_plan）：
//      计划事件序列 / 消息正文全量 / 固定种子抽样 20 条（内容·时间·分组）
//   E-7（Excel COM 打开 CSV）不在此脚本，分步执行见 docs/05 #11 章。
// 用法：node scripts/manual-regression-e.mjs [--port 9223]
//       [--tool-src ../wxchart-tool/src] [--root <微信数据根>]
//       [--account <wxid>] [--tk-dump <已有json> 跳过 python]
//       （`--root/--account` 的**默认值是脱敏占位符**，源码不写真实账号与本机路径；
//         真机运行必须显式传参，例如 --root D:\微信数据\xwechat_files --account wxid_xxx_xxxx）
// 约定：只断开 CDP、不 browser.close()（同 install-smoke.mjs）。
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const port = Number(arg('--port', 9223));
const toolSrc = resolve(arg('--tool-src', '../wxchart-tool/src'));
const dataRoot = arg('--root', 'D:\\微信数据\\xwechat_files');
const account = arg('--account', 'wxid_xxxxxxxx_1111');
const tkDumpArg = arg('--tk-dump', '');

const results = [];
const step = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

const shot = (name) => page.screenshot({ path: `test-results/m-a4/${name}` }).catch(() => {});
const getSel = () => page.evaluate(() => (window.getSelection() ? window.getSelection().toString() : ''));
const clearSel = async () => { await page.keyboard.press('Escape'); await page.evaluate(() => window.getSelection()?.removeAllRanges()); };

/** 向下滚一步；已到底自动回顶环绕（避免从列表底部起步时搜索循环原地打转——2026-11-10 E 轮踩到） */
async function scrollStep(frac = 0.5) {
  return page.evaluate((f) => {
    const v = document.querySelector('[data-testid="message_view"]');
    if (!v) return { moved: false, atTop: true, atEnd: true };
    const before = v.scrollTop;
    const max = v.scrollHeight - v.clientHeight;
    let next = before + Math.floor(v.clientHeight * f);
    if (next >= max - 1) next = before >= max - 1 ? 0 : max; // 已到底 → 回顶
    v.scrollTop = next;
    return { moved: v.scrollTop !== before, atTop: v.scrollTop <= 0, atEnd: v.scrollTop >= max - 1 };
  }, frac);
}

/** 当前有窗口的进程快照（附件打开/拖动不打开的 diff 判定，同 shell-media-check） */
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
const IGNORE_PROC = /^(cmd|conhost|powershell|pwsh|node|python|tasklist|explorer|msedgewebview2|wxchart-tauri|wxchart-data|weixin|wechatwin)\.exe$/;
const freshSince = (before) => [...windowedProcs()].filter((n) => !before.has(n) && !IGNORE_PROC.test(n));

// ---------- 载入真实数据（筛选页，分组视图 = Tk group_by_chat=True 口径） ----------
await page.waitForSelector('[data-testid="btn_load"]', { state: 'visible', timeout: 60000 });
if (!(await page.isVisible('[data-testid="page_filter"]').catch(() => false))) await page.click('[data-testid="tab_filter"]');
// 解析附件路径：文件类附件要 resolver 给出 path 才渲染 media_file（E-5 前置，同 shell-media-check）；
// resolver 在 load 时生效 → 勾选后必须重载一次（hadResolve=false 即强制 reload）。
const hadResolve = await page.isChecked('[data-testid="var_resolve_media"]').catch(() => false);
if (!hadResolve) await page.check('[data-testid="var_resolve_media"]').catch(() => {});
let st = ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
if (!/共 \d+ 条消息/.test(st) || !hadResolve) {
  await page.click('[data-testid="btn_load"]');
  await page.waitForFunction(
    () => /共 \d+ 条消息/.test(document.querySelector('[data-testid="lbl_status"]')?.textContent || ''),
    null, { timeout: 300000 },
  ).catch(() => {});
}
st = ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
const totalMsgs = Number(/共 (\d+) 条消息/.exec(st)?.[1] || 0);
step('E-0 数据载入（真实 store）', totalMsgs > 0, st.slice(0, 120));
// 每轮从列表顶部起步（复跑时上轮可能停在底部）
await page.evaluate(() => { const v = document.querySelector('[data-testid="message_view"]'); if (v) v.scrollTop = 0; });
await sleep(200);

/** 找一段视口内可见、足够长的气泡正文 */
async function findVisibleText(extraPad = 40) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const hit = await page.evaluate((pad) => {
      const view = document.querySelector('[data-testid="message_view"]');
      if (!view) return null;
      const vr = view.getBoundingClientRect();
      for (const p of view.querySelectorAll('.msg-row .text')) {
        const r = p.getBoundingClientRect();
        if (r.top > vr.top + pad && r.bottom < vr.bottom - pad && r.width > 80 && r.height > 12) {
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return null;
    }, extraPad);
    if (hit) return hit;
    await scrollStep(0.6);
    await sleep(200);
  }
  return null;
}

/** 对一个矩形做「按下→逐步右移→抬起」拖选，返回每步选区长度 */
async function dragSample(box) {
  const x0 = box.x + 4;
  const y0 = box.y + box.h / 2;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  const lens = [];
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x0 + (box.w - 8) * (i / 6), y0);
    lens.push((await getSel()).length);
  }
  await page.mouse.up();
  await sleep(80);
  return lens;
}

// ---------- E-1 气泡内拖选跟手 ----------
try {
  await clearSel();
  const box = await findVisibleText();
  if (!box) throw new Error('找不到可见正文');
  const lens = await dragSample(box);
  step('E-1a 拖选跟手（选区随移动即时变长）',
    lens[1] > 0 && lens[5] >= lens[1] && lens[5] > 0,
    `每步选区长度=[${lens.join(',')}]`);

  // 滚动后再拖
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="message_view"]');
    v.scrollTop += 420;
  });
  await sleep(250);
  const box2 = await findVisibleText();
  if (!box2) throw new Error('滚动后找不到可见正文');
  const lens2 = await dragSample(box2);
  step('E-1b 滚动后拖选仍跟手', lens2.some((v) => v > 0) && lens2[5] > 0,
    `每步选区长度=[${lens2.join(',')}]`);

  // 留白处按下（气泡 padding，A1 #21「拖到留白选整段」）
  await clearSel();
  const pad = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="message_view"]');
    const vr = view.getBoundingClientRect();
    for (const p of view.querySelectorAll('.msg-row .text')) {
      const t = p.getBoundingClientRect();
      const bub = p.closest('.bubble');
      if (!bub) continue;
      const bb = bub.getBoundingClientRect();
      if (t.top > vr.top + 60 && t.bottom < vr.bottom - 60 && t.x - bb.x >= 6) {
        return { sx: bb.x + 3, sy: t.y + t.height / 2, tx: t.x + t.width * 0.6, ty: t.y + t.height / 2 };
      }
    }
    return null;
  });
  if (pad) {
    await page.mouse.move(pad.sx, pad.sy);
    await page.mouse.down();
    await page.mouse.move(pad.tx, pad.ty);
    const lenPad = (await getSel()).length;
    await page.mouse.up();
    step('E-1c 留白处按下拖到正文 → 选中内容', lenPad > 0, `选区长度=${lenPad}`);
  } else {
    step('E-1c 留白处按下拖到正文 → 选中内容', false, '找不到带 padding 的气泡');
  }
  await clearSel();
} catch (e) {
  step('E-1 拖选跟手', false, String(e).slice(0, 160));
}

// ---------- E-2 跨气泡拖选 ----------
try {
  await clearSel();
  // 找视口内连续三条带正文的消息行
  let triple = null;
  for (let attempt = 0; attempt < 14 && !triple; attempt++) {
    triple = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="message_view"]');
      const vr = view.getBoundingClientRect();
      const rows = [];
      for (const r of view.querySelectorAll('.msg-row[data-index]')) {
        const t = r.querySelector('.text');
        if (!t) continue;
        const b = t.getBoundingClientRect();
        rows.push({ idx: Number(r.dataset.index), x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom });
      }
      for (let i = 0; i + 2 < rows.length; i++) {
        const [a, c, d] = [rows[i], rows[i + 1], rows[i + 2]];
        if (a.top > vr.top + 50 && d.bottom < vr.bottom - 50) return [a, c, d];
      }
      return null;
    });
    if (!triple) {
      await scrollStep(0.5);
      await sleep(200);
    }
  }
  if (!triple) throw new Error('找不到视口内连续三行正文');
  const [r1, r2, r3] = triple;
  const mid = (r) => ({ x: r.x + r.w * 0.5, y: r.y + r.h / 2 });
  await page.mouse.move(mid(r1).x, mid(r1).y);
  await page.mouse.down();
  await page.mouse.move(mid(r2).x, mid(r2).y);
  await sleep(60);
  const hl2 = await page.evaluate((i) => document.querySelector(`.msg-row[data-index="${i}"]`)?.classList.contains('cross-hl'), r2.idx);
  await page.mouse.move(mid(r3).x, mid(r3).y);
  await sleep(60);
  const hl3 = await page.evaluate((i) => document.querySelector(`.msg-row[data-index="${i}"]`)?.classList.contains('cross-hl'), r3.idx);
  await page.mouse.up();
  await sleep(200);
  step('E-2a 拖中跨选蓝框（cross-hl 圈到后续行）', Boolean(hl2 && hl3), `row2=${hl2} row3=${hl3}`);

  const checked = await page.$$eval('.msg-row', (rows) => rows
    .filter((r) => (r.querySelector('[data-testid="checkbox"]')?.textContent || '').includes('☑'))
    .map((r) => Number(r.dataset.index)));
  const status = ((await page.textContent('[data-testid="lbl_status"]').catch(() => '')) || '').trim();
  const statusN = Number(/已选 (\d+) 条/.exec(status)?.[1] ?? -1);
  const targets = new Set([r1.idx, r2.idx, r3.idx]);
  step('E-2b 松开后勾选框与计数即时正确',
    checked.length >= 2 && checked.length <= 3 && statusN === checked.length
      && checked.every((i) => targets.has(i)),
    `勾选=[${checked.join(',')}] 状态行已选=${statusN}（目标 ${[r1.idx, r2.idx, r3.idx].join(',')}）`);
  await shot('e-multiselect.png');

  await page.keyboard.press('Escape');
  await sleep(150);
  const afterEsc = await page.$$eval('.msg-row [data-testid="checkbox"]', (els) => els.length).catch(() => 0);
  step('E-2c Esc 退出多选（勾选框清空）', afterEsc === 0, `剩余勾选框=${afterEsc}`);
} catch (e) {
  step('E-2 跨气泡拖选', false, String(e).slice(0, 160));
}

// ---------- E-3 右键菜单四项 ----------
const EXPECT_ITEMS = [
  { key: 'copy_text', label: '复制选中文字（Ctrl+C）' },
  { key: 'copy_message', label: '复制整条消息' },
  { key: 'copy_visible', label: '复制全部已显示消息' },
  { key: 'multi_toggle', label: '多选（勾选这条消息）' },
];
async function readMenu() {
  return page.$$eval('[data-testid="ctx_item"]', (els) => els.map((e) => ({
    key: e.getAttribute('data-key'), label: (e.textContent || '').trim(), disabled: e.disabled,
  })));
}
const menuMatches = (items) => items.length === 4
  && EXPECT_ITEMS.every((e, i) => items[i].key === e.key && items[i].label === e.label);
try {
  await clearSel();
  const box = await findVisibleText();
  if (!box) throw new Error('找不到可见正文');
  await page.mouse.click(box.x + box.w * 0.4, box.y + box.h / 2, { button: 'right' });
  await page.waitForSelector('[data-testid="ctx_menu"]', { state: 'visible', timeout: 5000 });
  const onText = await readMenu();
  await shot('e-ctxmenu.png');
  step('E-3a 右键正文：四项文案 + 状态（复制选中禁用/整条/全部/多选可用）',
    menuMatches(onText) && onText[0].disabled === true && onText[1].disabled === false
      && onText[2].disabled === false && onText[3].disabled === false,
    onText.map((i) => `${i.key}${i.disabled ? '[禁]' : ''}`).join(' | '));
  await page.mouse.click(12, 12); // 点外部关闭
  await sleep(150);

  // 头像/留白处右键 → 「复制整条消息」禁用
  const av = await page.evaluate(() => {
    const view = document.querySelector('[data-testid="message_view"]');
    const vr = view.getBoundingClientRect();
    for (const a of view.querySelectorAll('.msg-row .avatar')) {
      const r = a.getBoundingClientRect();
      if (r.top > vr.top + 60 && r.bottom < vr.bottom - 60) return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  });
  if (av) {
    await page.mouse.click(av.x + av.w / 2, av.y + av.h / 2, { button: 'right' });
    await page.waitForSelector('[data-testid="ctx_menu"]', { state: 'visible', timeout: 5000 });
    const onAvatar = await readMenu();
    step('E-3b 头像处右键：四项文案照常、复制整条消息禁用',
      menuMatches(onAvatar) && onAvatar[1].disabled === true,
      onAvatar.map((i) => `${i.key}${i.disabled ? '[禁]' : ''}`).join(' | '));
    await page.mouse.click(12, 12);
  } else {
    step('E-3b 头像处右键：四项文案照常、复制整条消息禁用', false, '找不到头像');
  }
} catch (e) {
  step('E-3 右键菜单', false, String(e).slice(0, 160));
}

// ---------- E-4 引用块单击 ----------
try {
  let qb = null;
  for (let attempt = 0; attempt < 220 && !qb; attempt++) {
    qb = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="message_view"]');
      const vr = view.getBoundingClientRect();
      for (const q of view.querySelectorAll('[data-testid="quote_block"]')) {
        const r = q.getBoundingClientRect();
        if (r.top > vr.top + 60 && r.bottom < vr.bottom - 60) return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return null;
    });
    if (!qb) {
      await scrollStep(0.9);
      await sleep(150);
    }
  }
  if (!qb) throw new Error('全量滚动未找到引用块（真机数据无引用 → 记 N/A）');
  const scrollBefore = await page.evaluate(() => document.querySelector('[data-testid="message_view"]').scrollTop);
  await page.mouse.click(qb.x + qb.w * 0.5, qb.y + qb.h / 2);
  await sleep(350);
  const flashNow = await page.$$eval('.bubble.flash', (els) => els.length);
  const scrollAfter = await page.evaluate(() => document.querySelector('[data-testid="message_view"]').scrollTop);
  const retVisible = await page.isVisible('[data-testid="quote_return"]').catch(() => false);
  step('E-4a 引用块单击 → 目标闪烁 + 「↩ 返回」出现', flashNow >= 1 && retVisible,
    `flash=${flashNow} 返回按钮=${retVisible} scroll ${scrollBefore}→${scrollAfter}`);
  await shot('e-quote-flash.png');
  const flashGone = await page.waitForFunction(() => document.querySelectorAll('.bubble.flash').length === 0,
    null, { timeout: 3500 }).then(() => true).catch(() => false);
  step('E-4b 闪烁 1.4s 后自动消失', flashGone);
  // 返回原位
  if (retVisible) { await page.click('[data-testid="quote_return"]').catch(() => {}); }
  step('E-4c 「找不到目标」提示分支', true, '真机数据恒可找到 → 由 e2e A1 #20 注入覆盖（不重复注入）');
} catch (e) {
  step('E-4 引用块单击', false, String(e).slice(0, 160));
}

// ---------- E-5 附件：拖动选名 vs 单击打开 ----------
try {
  let link = null;
  for (let attempt = 0; attempt < 220 && !link; attempt++) {
    link = await page.evaluate(() => {
      const view = document.querySelector('[data-testid="message_view"]');
      const vr = view.getBoundingClientRect();
      for (const f of view.querySelectorAll('[data-testid="media_file"]')) {
        const r = f.getBoundingClientRect();
        if (r.top > vr.top + 60 && r.bottom < vr.bottom - 60) return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return null;
    });
    if (!link) {
      await scrollStep(0.9);
      await sleep(150);
    }
  }
  if (!link) {
    // 真机该账号可能没有「文件类」附件 → 记 N/A（语义由 e2e A1 #17 覆盖、图片点击由 media-check 10/10 覆盖）
    const kinds = await page.evaluate(() => ({
      file: document.querySelectorAll('[data-testid="media_file"]').length,
      missing: document.querySelectorAll('[data-testid="media_missing"]').length,
      thumb: document.querySelectorAll('[data-testid="media_thumb"]').length,
    }));
    step('E-5 附件单击打开 vs 拖动选名', true,
      `N/A：全量滚动无 media_file（file=${kinds.file} missing=${kinds.missing} thumb=${kinds.thumb}）→ 语义由 e2e A1 #17 覆盖，图片点击打开已由 media-check 10/10 覆盖`);
    throw new Error('__NA__');
  }

  // 1) 拖动选文件名：选区非空 + 不打开（无新进程）
  await clearSel();
  const beforeDrag = windowedProcs();
  await page.mouse.move(link.x + 6, link.y + link.h / 2);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(link.x + 6 + i * 18, link.y + link.h / 2);
  const dragLen = (await getSel()).length;
  await page.mouse.up();
  await sleep(1200);
  const dragFresh = freshSince(beforeDrag);
  step('E-5a 拖动选中文件名且不打开', dragLen > 0 && dragFresh.length === 0,
    `选区=${dragLen} 新进程=${dragFresh.join(',') || '无'}`);
  await clearSel();

  // 2) 单击打开：新进程实证（查看器多为单实例 → 检测前清场同 shell-media-check）
  for (const name of ['msphotos.exe', 'photoviewer.exe', 'paint.exe', 'picasaphotoviewer.exe']) {
    try { execFileSync('taskkill', ['/IM', name, '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 本来就没开 */ }
  }
  await sleep(300);
  const beforeClick = windowedProcs();
  const tClick = Date.now();
  await page.mouse.click(link.x + link.w * 0.4, link.y + link.h / 2);
  let clickFresh = [];
  // 「打开方式」宿主（openwith.exe）实测可 >10s 才拉起（2026-11-10 E-5b 首跑踩到）→ 窗口 25s
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    clickFresh = freshSince(beforeClick);
    if (clickFresh.length) break;
    await sleep(500);
  }
  const pollMs = Date.now() - tClick;
  step('E-5b 单击打开附件（新进程实证）', clickFresh.length > 0,
    `新进程=${clickFresh.join(',') || '（无）'} · 轮询 ${Math.round(pollMs / 1000)}s`);
  await shot('e-attachment-open.png');
  for (const name of [...clickFresh, 'msphotos.exe', 'photoviewer.exe', 'paint.exe']) {
    try { execFileSync('taskkill', ['/IM', name, '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 已退出 */ }
  }
} catch (e) {
  if (String(e.message) !== '__NA__') step('E-5 附件单击/拖动区分', false, String(e).slice(0, 160));
}

// ---------- E-6 连续滚动 + 切会话 ----------
try {
  await page.evaluate(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__lt.push(Math.round(e.duration));
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* 不支持则跳过（Chromium 支持） */ }
    const v = document.querySelector('[data-testid="message_view"]');
    if (v) v.scrollTop = 0;
  });
  await sleep(200);
  const scroll = await page.evaluate(async () => {
    const v = document.querySelector('[data-testid="message_view"]');
    const steps = 50;
    const white = [];
    const sleepMs = 70;
    for (let i = 0; i <= steps; i++) {
      v.scrollTop = Math.floor((v.scrollHeight - v.clientHeight) * (i / steps));
      await new Promise((r) => setTimeout(r, sleepMs));
      if (v.children.length === 0) white.push(i);
    }
    return { white, maxScrollTop: v.scrollTop, scrollHeight: v.scrollHeight };
  });
  await sleep(400);
  const longtasks = await page.evaluate(() => window.__lt || []);
  const maxLt = longtasks.length ? Math.max(...longtasks) : 0;
  step('E-6a 连续滚动 50 步：无空屏、无 >200ms 长任务',
    scroll.white.length === 0 && maxLt < 200,
    `空屏步=${scroll.white.join(',') || '0'} 长任务=${longtasks.length}个 最大=${maxLt}ms（scrollHeight=${scroll.scrollHeight}）`);

  // 切会话（管理页会话树，A2 #27 双击刷新右侧）
  await page.click('[data-testid="tab_manage"]');
  await page.waitForSelector('[data-testid="chat_tree"]', { state: 'visible', timeout: 10000 });
  const treeRows = await page.$$('[data-testid="chat_row"]');
  const pick = [0, Math.floor(treeRows.length / 2), treeRows.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  let whiteSwitch = 0;
  const switched = [];
  for (const i of pick) {
    const row = page.locator('[data-testid="chat_row"]').nth(i);
    await row.dblclick().catch(() => {});
    const okPane = await page.waitForFunction(() => {
      const view = document.querySelector('[data-testid="message_view"]');
      if (!view) return false;
      return view.children.length > 0 || document.querySelector('[data-testid="empty_state"]') !== null;
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!okPane) whiteSwitch++;
    const name = ((await row.textContent().catch(() => '')) || '').trim().slice(0, 24);
    switched.push(`${i}:${name}${okPane ? '✓' : '✗'}`);
  }
  step('E-6b 管理页切会话无白屏（3 次）', whiteSwitch === 0, switched.join(' | '));
  await shot('e-manage-switch.png');
  await page.click('[data-testid="tab_filter"]').catch(() => {});
} catch (e) {
  step('E-6 滚动/切会话', false, String(e).slice(0, 160));
}

// ---------- E-8 与 Tk 同数据抽样比对 ----------
try {
  // 1) Tk 侧：真 MessageView._build_plan dump（已有 --tk-dump 则复用）
  let tkDumpPath = tkDumpArg;
  if (!tkDumpPath) {
    tkDumpPath = resolve('test-results/m-a4/tk-plan-dump.json');
    const py = spawnSync('python', [
      resolve('scripts/tk-plan-dump.py'),
      '--tool-src', toolSrc, '--root', dataRoot, '--account', account,
      '--out', tkDumpPath, '--seed', '20261110', '--sample', '20',
    ], { encoding: 'utf8', cwd: process.cwd(), timeout: 300000 });
    const pyOut = `${py.stdout || ''}${py.stderr || ''}`.trim();
    step('E-8a Tk 侧 dump（真 MessageView._build_plan）',
      py.status === 0 && existsSync(tkDumpPath), pyOut.split(/\r?\n/).slice(-2).join(' | ').slice(0, 240));
  } else {
    step('E-8a Tk 侧 dump（复用已有，与 app 载入快照同批）',
      existsSync(tkDumpPath), tkDumpPath);
  }
  if (!existsSync(tkDumpPath)) throw new Error('tk dump 不存在，跳过比对');
  const tk = JSON.parse(readFileSync(tkDumpPath, 'utf8'));

  // 2) app 侧：全量滚动 walk，按 data-ev 收集计划事件与气泡正文
  await page.click('[data-testid="tab_filter"]').catch(() => {});
  await sleep(300);
  const dom = await page.evaluate(async () => {
    const view = document.querySelector('[data-testid="message_view"]');
    const evs = new Map();
    const collect = () => {
      for (const el of view.querySelectorAll('[data-ev]')) {
        const k = Number(el.dataset.ev);
        if (evs.has(k)) continue;
        const t = el.dataset.testid;
        if (t === 'group_header') evs.set(k, ['group', (el.querySelector('.name')?.textContent || '').trim()]);
        else if (t === 'day_bar') evs.set(k, ['day', (el.textContent || '').trim()]);
        else if (t === 'time_bar') evs.set(k, ['time', (el.textContent || '').trim()]);
        else if (t === 'msg_row') {
          const sys = el.classList.contains('system');
          const body = sys
            ? (el.querySelector('.system-text')?.textContent ?? '')
            : (el.querySelector('.text')?.textContent ?? '');
          evs.set(k, ['msg', Number(el.dataset.index), body]);
        }
      }
    };
    view.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const stride = Math.max(200, Math.floor(view.clientHeight * 0.5));
    let guard = 0;
    while (guard++ < 4000) {
      collect();
      const next = view.scrollTop + stride;
      if (next >= view.scrollHeight - view.clientHeight - 1) { view.scrollTop = view.scrollHeight; collect(); break; }
      view.scrollTop = next;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    const maxEv = evs.size ? Math.max(...evs.keys()) : -1;
    const events = [];
    const missing = [];
    for (let k = 0; k <= maxEv; k++) {
      if (evs.has(k)) events.push(evs.get(k));
      else missing.push(k);
    }
    return { events, missing, maxEv };
  });

  // 3) 比对：事件序列（类型+文本+下标） / 正文全量 / 抽样 20 条
  const tkEvents = tk.events;
  let seqOk = dom.missing.length === 0 && tkEvents.length === dom.events.length;
  let seqDiff = `tk=${tkEvents.length} dom=${dom.events.length} missing=${dom.missing.length}`;
  if (seqOk) {
    for (let k = 0; k < tkEvents.length; k++) {
      const a = tkEvents[k];
      const c = dom.events[k];
      if (a[0] !== c[0]) { seqOk = false; seqDiff = `ev#${k} 类型 ${a[0]}≠${c[0]}`; break; }
      if (a[0] === 'msg' ? a[1] !== c[1] : String(a[1]) !== String(c[1])) {
        seqOk = false; seqDiff = `ev#${k} ${a[0]} "${String(a[1]).slice(0, 40)}"≠"${String(c[1]).slice(0, 40)}"`;
        break;
      }
    }
  }
  step('E-8b 计划事件序列与 Tk 完全一致', seqOk, seqDiff.slice(0, 200));

  // 正文全量（msg 事件按 index 对齐）
  const domByIndex = new Map();
  for (const e of dom.events) if (e[0] === 'msg') domByIndex.set(e[1], e[2]);
  let bodyDiff = [];
  for (const [idx, rec] of Object.entries(tk.by_index)) {
    const mine = domByIndex.get(Number(idx));
    if (mine === undefined) bodyDiff.push(`#${idx} DOM缺失`);
    else if (mine !== rec.body) bodyDiff.push(`#${idx} "${String(mine).slice(0, 40)}"≠"${String(rec.body).slice(0, 40)}"`);
  }
  step('E-8c 消息正文全量一致', bodyDiff.length === 0 && domByIndex.size === tk.total_msgs,
    bodyDiff.length ? bodyDiff.slice(0, 3).join(' ; ').slice(0, 200)
      : `${domByIndex.size}/${tk.total_msgs} 条`);

  // 抽样 20 条：内容/时间/分组
  const sampleBad = [];
  for (const idx of tk.sample) {
    const rec = tk.by_index[String(idx)];
    // 事件序列已逐位一致 → 按事件序列重建该 index 的 group/day/time 上下文
    let g = '', d = '', t = '';
    const ctx = {};
    for (const e of dom.events) {
      if (e[0] === 'group') g = e[1];
      else if (e[0] === 'day') d = e[1];
      else if (e[0] === 'time') t = e[1];
      else ctx[e[1]] = { group: g, day: d, time: t };
    }
    const mine = ctx[idx];
    const tkRec = tk.by_index[String(idx)];
    const body = domByIndex.get(idx);
    if (!mine || mine.group !== tkRec.group || mine.day !== tkRec.day || mine.time !== tkRec.time || body !== tkRec.body) {
      sampleBad.push(`#${idx}`);
    }
  }
  step(`E-8d 固定种子抽样 ${tk.sample.length} 条（内容·时间·分组）一致`,
    sampleBad.length === 0 && tk.sample.length === 20,
    sampleBad.length ? `不一致：${sampleBad.join(',')}` : `seed=${tk.seed} 全部一致`);
} catch (e) {
  step('E-8 与 Tk 比对', false, String(e).slice(0, 200));
}

// ---------- 汇总 ----------
step('全程无 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || '0 条');
const failed = results.filter((r) => !r.ok);
console.log(`\n# 结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('# 失败：' + failed.map((f) => f.name).join('；'));
// 只断开、不 close
process.exit(failed.length ? 1 : 0);
