// 临时诊断：读 Vue 组件内部状态（需要 dev 构建，el.__vueParentComponent 可用）
import { chromium } from '@playwright/test';

const port = process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : '9222';
const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];
await page.waitForTimeout(300);
const state = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="lbl_status"]');
  const text = el ? el.textContent : null;
  let inst = el && el.__vueParentComponent;
  // 向上找到带 setupState.data 的实例
  const dump = {};
  let hops = 0;
  while (inst && hops < 6) {
    const s = inst.setupState || {};
    if (s.data) {
      const d = s.data;
      dump.error = d.error ? JSON.parse(JSON.stringify(d.error)) : null;
      dump.loaded = d.loaded;
      dump.loading = d.loading;
      dump.source = d.source;
      dump.messages = Array.isArray(d.messages) ? d.messages.length : typeof d.messages;
      dump.progress = d.progress ? JSON.parse(JSON.stringify(d.progress)) : null;
      dump.account = d.account;
      dump.sidecar = d.sidecar ? JSON.parse(JSON.stringify(d.sidecar)) : null;
      dump.accountsError = d.accountsError || null;
      dump.accounts = Array.isArray(d.accounts) ? d.accounts.map((a) => a.wxid) : typeof d.accounts;
      break;
    }
    inst = inst.parent;
    hops++;
  }
  return { text, hasInstance: hops < 6 && Object.keys(dump).length > 0, dump };
});
console.log(JSON.stringify(state, null, 1));
process.exit(0);
