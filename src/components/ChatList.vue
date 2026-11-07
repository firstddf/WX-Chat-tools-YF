<script setup lang="ts">
// 聊天数据管理页（A2 #27/#28/#29/#30 的载体）：会话树 + 搜索 + 浏览视图（纯浏览，无勾选）。
import { computed, inject, ref } from 'vue';
import { createSelection, STORE_KEY } from '../state/store';
import { filterIndexed } from '../logic/filter';
import MessageList from './MessageList.vue';

const store = inject(STORE_KEY)!;
const { data } = store;
const emit = defineEmits<{ 'to-filter': [chatId: string] }>();

const search = ref('');
const selectedId = ref('');
const notice = ref('');
const browseSelection = createSelection(false); // 纯浏览：选择 API 恒为空（A1 #6）

const visibleChats = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return data.chats;
  return data.chats.filter(
    (c) => c.chat.toLowerCase().includes(q) || c.chat_id.toLowerCase().includes(q),
  );
});

const browseItems = computed(() =>
  selectedId.value ? filterIndexed(data.messages, { chat_id: selectedId.value }) : [],
);

const summary = computed(() => {
  if (data.error) return `⚠ ${data.error.message}`;
  if (!data.loaded) return '';
  if (data.chats.length === 0) {
    return '没有可用的聊天数据：请先在「导出」页扫描会话，或导出一次';
  }
  return `${data.chats.length} 个会话 · ${data.messages.length} 条消息`;
});

const sourceLabel = computed(() =>
  data.source ? `来源：${data.source === 'store' ? '扫描' : '导出目录'}` : '',
);

function refresh(): void {
  notice.value = '';
  void store.load({ kind: 'store' });
}

function browse(): void {
  if (!selectedId.value && visibleChats.value.length > 0) {
    selectedId.value = visibleChats.value[0]!.chat_id;
  }
  if (selectedId.value) notice.value = '';
}

function openPage(): void {
  notice.value = '打开页面：导出目录页面将在 M-A4 打包后接通';
}

async function copyId(): Promise<void> {
  const id = selectedId.value;
  if (!id) {
    notice.value = '请先选择会话';
    return;
  }
  try {
    await navigator.clipboard?.writeText(id);
    notice.value = `已复制群号 ${id}`;
  } catch {
    notice.value = `群号：${id}（复制不可用）`;
  }
}

function toFilter(): void {
  if (selectedId.value) emit('to-filter', selectedId.value);
}
</script>

<template>
  <div class="manage">
    <div class="f-panel">
      <div class="f-row">
        <input
          v-model="search"
          class="f-input f-grow"
          data-testid="entry_search"
          placeholder="搜索会话（名称/群号）"
        />
        <button type="button" class="f-btn" data-testid="btn_refresh" @click="refresh">
          刷新数据
        </button>
        <button type="button" class="f-btn" data-testid="btn_browse" @click="browse">
          浏览消息
        </button>
        <button type="button" class="f-btn" data-testid="btn_open_page" @click="openPage">
          打开导出页面
        </button>
        <button type="button" class="f-btn" data-testid="btn_copy_id" @click="copyId">
          复制群号
        </button>
        <button type="button" class="f-btn" data-testid="btn_to_filter" @click="toFilter">
          在筛选中查找
        </button>
        <span class="f-count" data-testid="lbl_source">{{ sourceLabel }}</span>
      </div>
      <div class="f-row" v-if="notice">
        <span class="f-count" data-testid="manage_notice">{{ notice }}</span>
      </div>
    </div>

    <div class="f-count" data-testid="lbl_summary">{{ summary }}</div>

    <div class="manage-body">
      <div class="chat-tree" data-testid="chat_tree">
        <div
          v-for="c in visibleChats"
          :key="c.chat_id"
          class="chat-row"
          :class="{ active: c.chat_id === selectedId }"
          data-testid="chat_row"
          @click="selectedId = c.chat_id"
          @dblclick="browse"
        >
          <span class="chat-name">{{ c.chat }}</span>
          <span class="chat-meta"
            >{{ c.is_group ? '群号' : '会话ID' }} {{ c.chat_id }} · {{ c.count }} 条</span
          >
        </div>
      </div>
      <div class="browse-pane">
        <MessageList
          :items="browseItems"
          :messages="data.messages"
          :group-by-chat="false"
          :selection="browseSelection"
        />
      </div>
    </div>
  </div>
</template>
