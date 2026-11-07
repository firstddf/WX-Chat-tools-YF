<script setup lang="ts">
// 账号栏（Tk gui.py _build_ui 顶部「账号: 下拉 + 刷新账号」）——
// 两个标签页都可见；启动扫描与选账号都在 store（store.init → scanAccounts），
// 这里只负责展示交互，不直接碰 IPC。
import { computed, inject } from 'vue';
import { STORE_KEY } from '../state/store';
import type { Account } from '../ipc/types';

const store = inject(STORE_KEY)!;
const { data } = store;

/** Tk 下拉显示 wxid；昵称非空且不同于 wxid 时显示「昵称 (wxid)」 */
function labelOf(a: Account): string {
  return a.nickname && a.nickname !== a.wxid ? `${a.nickname} (${a.wxid})` : a.wxid;
}

const statusText = computed(() => {
  if (data.scanning) return '正在扫描账号…';
  if (data.accountsError) return `⚠ ${data.accountsError.message}`;
  if (data.accountsScanned && data.accounts.length === 0) {
    // Tk gui.py refresh_accounts 无账号时的引导文案
    return '没有发现微信账号目录，请确认微信已安装并登录';
  }
  if (!data.accountsScanned) return '';
  if (data.account) {
    return `发现 ${data.accounts.length} 个账号 · 已选账号：${data.account}`;
  }
  return `发现 ${data.accounts.length} 个账号`;
});

const statusWarn = computed(
  () => Boolean(data.accountsError) || (data.accountsScanned && data.accounts.length === 0),
);

function onSelect(e: Event): void {
  store.setAccount((e.target as HTMLSelectElement).value);
}
</script>

<template>
  <div class="accountbar" data-testid="account_bar">
    <label class="f-label" for="cmb_account">账号:</label>
    <select
      id="cmb_account"
      class="f-input account-select"
      data-testid="cmb_account"
      :value="data.account"
      :disabled="data.scanning"
      @change="onSelect"
    >
      <option v-if="data.accounts.length === 0" value="">（未发现账号）</option>
      <option v-for="a in data.accounts" :key="a.wxid" :value="a.wxid">{{ labelOf(a) }}</option>
    </select>
    <button
      type="button"
      class="f-btn"
      data-testid="btn_refresh_accounts"
      :disabled="data.scanning"
      @click="store.scanAccounts()"
    >
      刷新账号
    </button>
    <span class="account-status" :class="{ warn: statusWarn }" data-testid="account_status">
      {{ statusText }}
    </span>
  </div>
</template>
