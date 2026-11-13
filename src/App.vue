<script setup lang="ts">
// 应用外壳：账号栏（各标签页共用）+ 标签页（导出 / 数据筛选 / 聊天数据管理 / 快递单号提取，
// 前三个顺序照 Tk gui.py:103/158/160，#19 新页追加末尾）+ sidecar 状态横幅 + store 装配。
import { computed, onMounted, onUnmounted, provide, ref } from 'vue';
import { useIpc } from './ipc/context';
import { createStore, STORE_KEY } from './state/store';
import AccountBar from './components/AccountBar.vue';
import FilterPanel from './components/FilterPanel.vue';
import ChatList from './components/ChatList.vue';
import ExportPage from './components/ExportPage.vue';
import MessageList from './components/MessageList.vue';
import TrackingPage from './components/TrackingPage.vue';

const ipc = useIpc();
const store = createStore(ipc);
provide(STORE_KEY, store);
void store.init();

// 默认激活页仍为「数据筛选」（docs/07 #17 拍板 A5）：43 条 e2e 与真机脚本的隐式默认页口径
const tab = ref<'export' | 'filter' | 'manage' | 'tracking'>('filter');
const filterPanelRef = ref<InstanceType<typeof FilterPanel> | null>(null);
const chatListRef = ref<InstanceType<typeof ChatList> | null>(null);
const exportPageRef = ref<InstanceType<typeof ExportPage> | null>(null);

const banner = computed(() => {
  const state = store.data.sidecar.state;
  if (state === 'failed') return '数据层（sidecar）不可用：自动重启仍失败，请查看日志或重启应用。';
  if (state === 'mismatch') return '版本不匹配，重新安装（协议主版本不一致）。';
  return '';
});

/** 启动骨架屏（R3 对策补完，docs/07 #8）：sidecar 还在 starting 且无数据/无错误时占位，
 *  ready（或失败/出错）后切换为真实内容。 */
const booting = computed(
  () =>
    store.data.sidecar.state === 'starting' &&
    !store.data.loaded &&
    !store.data.error,
);

function onToFilter(chatId: string): void {
  tab.value = 'filter';
  filterPanelRef.value?.focusChat(chatId);
}

/** 状态行「打开本地数据」出口（docs/07 Phase 2 #7）：跳管理页并触发选目录 */
function onOpenLocal(): void {
  tab.value = 'manage';
  void chatListRef.value?.openLocal();
}

/**
 * 导出页 Ctrl/Cmd+A = 全选导出会话（docs/07 #14 追加 → #17 随面板迁到导出页）：
 * 吞掉浏览器「整页全选」默认行为（网页版会把工具栏/面板整片框蓝，Tk 是 Canvas 无此现象）。
 * 输入框内不劫持（照常全选框内文字）；其余页签不消费 → 默认行为
 * （配合骨架 user-select:none，只会选中消息正文，不再满屏蓝）。
 */
function onKeydown(e: KeyboardEvent): void {
  if (tab.value !== 'export') return;
  if (e.key.toLowerCase() !== 'a' || !(e.ctrlKey || e.metaKey)) return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (exportPageRef.value?.handleCtrlA()) e.preventDefault();
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="app">
    <!-- 账号栏：位置对齐 Tk 版顶部（在标签页之上，两个标签页都可见）；starting 期灰化 -->
    <AccountBar :class="{ 'boot-dim': booting }" />

    <div class="tabbar">
      <button
        type="button"
        :class="{ active: tab === 'export' }"
        data-testid="tab_export"
        @click="tab = 'export'"
      >
        导出
      </button>
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
      <button
        type="button"
        :class="{ active: tab === 'tracking' }"
        data-testid="tab_tracking"
        @click="tab = 'tracking'"
      >
        快递单号提取
      </button>
    </div>

    <div v-if="banner" class="banner" data-testid="sidecar_banner">{{ banner }}</div>

    <!-- 启动骨架屏（docs/07 #8）：starting 期内容区占位，ready 后切换为标签页内容 -->
    <div v-if="booting" class="boot-skeleton" data-testid="boot_skeleton">
      <div class="skel-block skel-toolbar"></div>
      <div v-for="i in 6" :key="i" class="skel-block skel-row" :style="{ width: `${94 - i * 6}%` }"></div>
    </div>

    <template v-else>
      <div v-show="tab === 'export'" class="tabpage" data-testid="page_export">
        <ExportPage ref="exportPageRef" />
      </div>

      <div v-show="tab === 'filter'" class="tabpage" data-testid="page_filter">
        <FilterPanel ref="filterPanelRef" @open-local="onOpenLocal" />
        <MessageList
          :items="store.matched.value"
          :messages="store.data.messages"
          :group-by-chat="true"
          :selection="store.selection"
        />
      </div>

      <div v-show="tab === 'manage'" class="tabpage" data-testid="page_manage">
        <ChatList ref="chatListRef" @to-filter="onToFilter" />
      </div>

      <div v-show="tab === 'tracking'" class="tabpage" data-testid="page_tracking">
        <TrackingPage />
      </div>
    </template>
  </div>
</template>
