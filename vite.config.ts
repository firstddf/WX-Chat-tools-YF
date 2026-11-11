/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { execSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

/** 构建期注入「关于」弹窗的构建时间与 git 提交号（无 git 环境回退 unknown；docs/07 #18） */
function buildInfo(): string {
  const builtAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    /* 非 git 环境（导出的源码包）→ unknown，不阻塞构建 */
  }
  return JSON.stringify({ builtAt, commit });
}

// Vite + Vitest 一体配置（docs/02 §6：测试跑在 MockIpc 上，普通浏览器即可测）
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
  define: { __BUILD_INFO__: buildInfo() },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.spec.ts'],
    testTimeout: 15000,
  },
});
