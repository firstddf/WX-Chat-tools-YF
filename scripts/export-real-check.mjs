// 真机验收（docs/07 #5）：UI 级导出全链路——点「导出选中 JSON/CSV」→ 原生保存对话框
// （CDP 操作不了原生窗口 → 调 scripts/save-dialog.ps1 注入路径并点保存）→ 断言落盘文件。
// 前置：应用以 CDP 9222 启动、vite 5173 在跑、微信在线（能扫到账号并加载）。
// 断言：JSON = 可解析 + 记录数 == 选中数 + 无 BOM；CSV = UTF-8 BOM + 表头 + 记录数 ==
// 选中数（CSV 解析器计数，正文内 \n 被引号包裹不误计）+ 公式列 ' 前缀抽查（数据含公式样本时）。
// 用法：node scripts/export-real-check.mjs [--port 9222] [--dir <run-dir>]
// 约定：只断开 CDP，不 browser.close()（同 acceptance-real.mjs）。
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const port = Number(arg('--port', '9222'));
const runDir = resolve(arg('--dir', join('test-results', 'real-acceptance', 'export-real')));
mkdirSync(runDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = join(runDir, `export-${stamp}.json`);
const csvPath = join(runDir, `export-${stamp}.csv`);
const saveDialogPs1 = resolve('scripts', 'save-dialog.ps1');

const results = [];
const consoleErrors = [];
function step(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** CSV 记录数（状态机解析：引号字段内的 \r\n 不算行界） */
function csvRecordCount(text) {
  let rows = 0;
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawContent = true;
    } else if (c === '\n') {
      if (sawContent) rows++;
      sawContent = false;
    } else if (c !== '\r') {
      sawContent = true;
    }
  }
  if (sawContent) rows++;
  return rows; // 含表头
}

/** 调 save-dialog.ps1：等原生对话框 → 注入路径 → 点保存 → 等关闭。
 *  失败时强清所有残留对话框（防串台：残留 #32770 会吞掉下一阶段的注入）。 */
function automateSave(target) {
  try {
    return execFileSync('pwsh', ['-NoProfile', '-File', saveDialogPs1, '-Path', target], {
      encoding: 'utf8',
      timeout: 90_000,
    }).trim();
  } catch (e) {
    killStrayDialog();
    throw e;
  }
}

/** 跑前清场：关掉残留的 #32770（上轮失败可能留下）；无残留 3s 内 NO DIALOG 退出 */
function killStrayDialog() {
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-File', saveDialogPs1, '-Kill'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
    console.log(`清场: ${out}`);
  } catch (e) {
    console.log(`清场失败（忽略）: ${String(e.stdout || e.message).slice(0, 80)}`);
  }
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

  // 干净起点：重载 → 扫到账号 → 加载真实数据
  await page.reload();
  await page.waitForSelector('[data-testid="cmb_account"]', { timeout: 60000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="cmb_account"]');
      return el && el.options.length >= 1 && el.options[0].value;
    },
    null,
    { timeout: 30000 },
  );
  await page.click('[data-testid="btn_load"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="lbl_status"]');
      return el && /共 \d+ 条消息/.test(el.textContent || '');
    },
    null,
    { timeout: 300000 },
  );
  const loaded = ((await page.textContent('[data-testid="lbl_status"]')) || '').trim();
  step('加载真实数据', /共 \d+ 条消息/.test(loaded), loaded.slice(0, 90));

  // 全选（多选态）→ 记下选中数
  await page.click('[data-testid="btn_select_all"]');
  const selText = ((await page.textContent('[data-testid="lbl_status"]')) || '').trim();
  const selected = Number((selText.match(/已选 (\d+) 条/) || [])[1] || 0);
  step('全选进入多选', selected > 0, `已选 ${selected} · ${selText.slice(0, 60)}`);

  // 等导出完成提示：**等 notice 出现目标文件名**（通用「已导出 N 条」会匹配旧提示，
  // 上轮实测误判——2026-11-10 坑）
  const waitNotice = (name) =>
    page.waitForFunction(
      (n) => {
        const el = document.querySelector('[data-testid="lbl_status"]');
        return el && (el.textContent || '').includes(n);
      },
      name,
      { timeout: 120_000 },
    );

  // ---- JSON：点导出 → 原生对话框注入路径 → 断言落盘 ----
  killStrayDialog(); // 清上轮残留（若有）
  await page.click('[data-testid="btn_json"]');
  let saveOut = '';
  try {
    saveOut = automateSave(jsonPath);
    step('原生保存对话框自动保存（JSON）', saveOut.includes('DIALOG CLOSED'), saveOut.slice(0, 60));
  } catch (e) {
    step('原生保存对话框自动保存（JSON）', false,
      String(e.stdout || e.message || e).slice(0, 160));
  }
  await waitNotice('export-' + stamp + '.json').catch(() => null);
  const jsonNotice = ((await page.textContent('[data-testid="lbl_status"]')) || '').trim();
  step('JSON 导出完成提示（含目标路径）',
    jsonNotice.includes('export-' + stamp + '.json'), jsonNotice.slice(0, 110));

  const jsonOk = existsSync(jsonPath);
  step('JSON 文件落盘', jsonOk, jsonOk ? `${statSync(jsonPath).size}B` : jsonPath);
  let records = [];
  if (jsonOk) {
    const raw = readFileSync(jsonPath);
    const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    step('JSON 无 BOM', !bom, bom ? '首字节 EF BB BF' : 'ok');
    try {
      records = JSON.parse(raw.toString('utf8'));
      step('JSON 可解析且记录数 == 选中数',
        Array.isArray(records) && records.length === selected,
        `${Array.isArray(records) ? records.length : typeof records}/${selected}`);
    } catch (e) {
      step('JSON 可解析且记录数 == 选中数', false, String(e).slice(0, 120));
    }
  }

  // ---- CSV：同选择集再导一次（先确保 JSON 对话框已关，防串台） ----
  killStrayDialog();
  await page.click('[data-testid="btn_csv"]');
  try {
    const out = automateSave(csvPath);
    step('原生保存对话框自动保存（CSV）', out.includes('DIALOG CLOSED'), out.slice(0, 60));
  } catch (e) {
    step('原生保存对话框自动保存（CSV）', false, String(e.stdout || e.message || e).slice(0, 160));
  }
  await waitNotice('export-' + stamp + '.csv').catch(() => null);
  const csvNotice = ((await page.textContent('[data-testid="lbl_status"]')) || '').trim();
  step('CSV 导出完成提示（含目标路径）',
    csvNotice.includes('export-' + stamp + '.csv'), csvNotice.slice(0, 110));

  const csvOk = existsSync(csvPath);
  step('CSV 文件落盘', csvOk, csvOk ? `${statSync(csvPath).size}B` : csvPath);
  if (csvOk) {
    const raw = readFileSync(csvPath);
    const body = raw.toString('utf8');
    step('CSV 带 UTF-8 BOM', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
      [...raw.slice(0, 3)].map((b) => b.toString(16)).join(' '));
    step('CSV 表头正确', body.replace(/^\ufeff/, '').startsWith('时间,日期,会话,群号,发送人,类型,内容,附件,附件路径'),
      body.replace(/^\ufeff/, '').split('\r\n')[0]);
    const rows = csvRecordCount(body);
    step('CSV 记录数（含表头）== 选中数 + 1', rows === selected + 1, `${rows}/${selected + 1}`);

    // 公式列 ' 前缀抽查：数据里有公式样本才断言（真实数据未必有）
    const formulaRec = records.find(
      (r) => typeof r.text === 'string' && /^[=+\-@\t\r]/.test(r.text),
    );
    if (formulaRec) {
      const needle = "'" + formulaRec.text.slice(0, 8);
      step('公式样本带 \' 前缀（防注入）', body.includes(needle), needle);
    } else {
      step('公式样本带 \' 前缀（防注入）', true, 'SKIP：本批数据无公式开头文本（契约测试已覆盖）');
    }
  }

  await page.screenshot({ path: join(runDir, 'export-after.png'), fullPage: true });
  step('console 0 错', consoleErrors.length === 0, `${consoleErrors.length} 条: ${consoleErrors.slice(0, 3).join(' / ')}`);
} catch (e) {
  step('脚本执行未抛异常', false, String(e));
} finally {
  for (const c of browser.contexts()) for (const p of c.pages()) p.removeAllListeners();
}

const fails = results.filter((r) => !r.ok).length;
console.log(`\n== export-real-check：${results.length - fails}/${results.length} PASS ==`);
console.log(`产物目录: ${runDir}`);
process.exit(fails ? 1 : 0);
