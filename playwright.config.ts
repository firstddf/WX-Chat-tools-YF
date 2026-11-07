// Playwright 配置 —— 页面级布局验收（docs/04 A1 #4/#11，jsdom 测不了的 getBoundingClientRect）。
// 测试跑在浏览器 dev（MockIpc）上，不依赖 Tauri 壳（docs/02 §6）。
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // 隔离 Playwright 的产物目录：默认 outputDir 就是 ./test-results，每次启动会**整目录清空**，
  // 曾把真机验收截图（test-results/real-acceptance/）连带抹掉（2026-11-07 实测）。
  // e2e 产物落 test-results/e2e/，证据目录 real-acceptance/、m-a4/ 不再受波及。
  outputDir: 'test-results/e2e',
  timeout: 30_000,
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  webServer: {
    command: 'pnpm dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
