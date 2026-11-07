// M-A4 探针：直接 invoke open_path，验证 release 下 register_media_from* 的 PathScope
// （它与 app.security.assetProtocol.scope 是两套独立机制，docs/03 §4/§5——本探针确认
// 懒解码新解码出的 path 已被注册、且 scope 外路径仍被拒）。
// 前置：安装版已带 CDP 端口启动且已加载过数据（DOM 里有缩略图）。
// 用法：node scripts/open-path-probe.mjs [--port 9223]
// 作用：会真实打开一次默认图片查看器（负例不会打开）；只断开、不 close。
import { chromium } from '@playwright/test';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const port = Number(arg('--port', 9223));

const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = b.contexts()[0];
const page = ctx.pages().find((p) => !/^devtools:/.test(p.url())) || ctx.pages()[0];

const r = await page.evaluate(async () => {
  const img = document.querySelector('[data-testid="media_thumb_img"]');
  if (!img) return { error: 'no thumb img in DOM（先加载数据并滚到带图消息）' };
  const u = new URL(img.src);
  const path = decodeURIComponent(u.pathname).replace(/^\//, '');
  let ok;
  try {
    ok = await window.__TAURI_INTERNALS__.invoke('open_path', { path });
  } catch (e) {
    ok = 'ERROR ' + JSON.stringify(e);
  }
  // 负例：scope 外路径必须被拒（PATH_NOT_ALLOWED）
  let neg;
  try {
    neg = await window.__TAURI_INTERNALS__.invoke('open_path', { path: 'C:\\Windows\\notepad.exe' });
  } catch (e) {
    neg = 'REJECTED ' + JSON.stringify(e);
  }
  return { path, openPathResult: ok, negative: neg };
});
console.log(JSON.stringify(r, null, 2));

const failed = [];
if (r.error) failed.push(r.error);
if (!(r.openPathResult && r.openPathResult.ok === true)) failed.push('open_path(解码图片) 未返回 {ok:true}: ' + JSON.stringify(r.openPathResult));
if (typeof r.negative !== 'string' || !r.negative.startsWith('REJECTED') || !/PATH_NOT_ALLOWED/.test(r.negative)) {
  failed.push('负例未按预期被 PATH_NOT_ALLOWED 拒绝: ' + JSON.stringify(r.negative));
}
console.log(failed.length ? 'PROBE FAIL:\n  ' + failed.join('\n  ') : 'PROBE PASS（scope 内放行 + scope 外拒绝）');
// 只断开、不 close（browser.close() 会连带杀掉真实壳的 WebView2）
process.exit(failed.length ? 1 : 0);
