<script setup lang="ts">
// 应用外壳：账号栏（两个标签页共用）+ 标签页（数据筛选 / 聊天数据管理）+ sidecar 状态横幅 + store 装配。
import { computed, provide, ref } from 'vue';
import { useIpc } from './ipc/context';
import { createStore, STORE_KEY } from './state/store';
import AccountBar from './components/AccountBar.vue';
import FilterPanel from './components/FilterPanel.vue';
import ChatList from './components/ChatList.vue';
import MessageList from './components/MessageList.vue';

const ipc = useIpc();
const store = createStore(ipc);
provide(STORE_KEY, store);
void store.init();

const tab = ref<'filter' | 'manage'>('filter');
const filterPanelRef = ref<InstanceType<typeof FilterPanel> | null>(null);

const banner = computed(() => {
  const state = store.data.sidecar.state;
  if (state === 'failed') return '数据层（sidecar）不可用：自动重启仍失败，请查看日志或重启应用。';
  if (state === 'mismatch') return '版本不匹配，重新安装（协议主版本不一致）。';
  return '';
});

function onToFilter(chatId: string): void {
  tab.value = 'filter';
  filterPanelRef.value?.focusChat(chatId);
}
</script>

<template>
  <div class="app">
    <!-- 账号栏：位置对齐 Tk 版顶部（在标签页之上，两个标签页都可见） -->
    <AccountBar />

    <div class="tabbar">
      <button
        type="button"
        :class="{ active: tab === 'filter' }"
        data-testid="tab_filter"
        @click="tab = 'filter'"
      >
        数据筛选
      </button>
      <button
        type="button"
        :class="{ active: tab === 'manage' }"
        data-testid="tab_manage"
        @click="tab = 'manage'"
      >
        聊天数据管理
      </button>
    </div>

    <div v-if="banner" class="banner" data-testid="sidecar_banner">{{ banner }}</div>

    <div v-show="tab === 'filter'" class="tabpage" data-testid="page_filter">
      <FilterPanel ref="filterPanelRef" />
      <MessageList
        :items="store.matched.value"
        :messages="store.data.messages"
        :group-by-chat="true"
        :selection="store.selection"
      />
    </div>

    <div v-show="tab === 'manage'" class="tabpage" data-testid="page_manage">
      <ChatList @to-filter="onToFilter" />
    </div>
  </div>
</template>
