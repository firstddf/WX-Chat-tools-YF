<script setup lang="ts">
// 数据筛选页控制面板（A2 #24/#25/#26/#29/#30 的载体）——
// 控件集与 Tk FilterTab 对齐（FILTER_ATTRS：query/chat/双日期/会话与类型下拉/
// 快捷日期/附件解析/加载/全选清空反选/导出选中与全部 JSON+CSV）。
import { computed, inject, ref } from 'vue';
import { deriveTypes } from '../logic/typelabels';
import { pickSavePath } from '../ipc/dialog';
import { STORE_KEY } from '../state/store';
import type { ProtocolError } from '../ipc/types';
import DatePicker from './DatePicker.vue';

const store = inject(STORE_KEY)!;
const { data, filter, matched, selection } = store;
const emit = defineEmits<{ 'open-local': [] }>();

const queryDraft = ref('');
const chatDraft = ref('');
const resolveMedia = ref(false); // 附件解析默认关闭（A2 #24 var_resolve_media）
const notice = ref<{ warn: boolean; text: string } | null>(null);

const typeOptions = computed(() => deriveTypes(data.messages));
const chatOptions = computed(() => data.chats);
const matchedIndexes = computed(() => matched.value.map((p) => p.index));
const statusText = computed(() => store.statusText.value);

const QUICK: Array<{ id: string; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: '7', label: '近7天' },
  { id: '30', label: '近30天' },
  { id: 'month', label: '本月' },
];

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function quick(id: string): void {
  const today = new Date();
  let from = '';
  let to = '';
  if (id === 'today') {
    from = to = dayStr(today);
  } else if (id === '7' || id === '30') {
    const span = id === '7' ? 6 : 29;
    const start = new Date(today);
    start.setDate(start.getDate() - span);
    from = dayStr(start);
    to = dayStr(today);
  } else if (id === 'month') {
    from = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    to = dayStr(today);
  }
  notice.value = null;
  store.setFilter({ date_from: from, date_to: to });
}

function applyQuery(): void {
  notice.value = null;
  store.setFilter({ query: queryDraft.value });
}

function applyChat(): void {
  notice.value = null;
  store.setFilter({ chat_id: chatDraft.value });
}

function onChatSelect(e: Event): void {
  chatDraft.value = (e.target as HTMLSelectElement).value;
  applyChat();
}

function onTypeSelect(e: Event): void {
  notice.value = null;
  store.setFilter({ type: (e.target as HTMLSelectElement).value });
}

function resetAll(): void {
  queryDraft.value = '';
  chatDraft.value = '';
  notice.value = null;
  store.resetFilter();
}

function load(): void {
  notice.value = null;
  void store.load({ kind: 'store', options: { resolve_media: resolveMedia.value } });
}

/** 管理页「在筛选中查找」（A2 #26） */
function focusChat(chatId: string): void {
  chatDraft.value = chatId;
  store.setFilter({ chat_id: chatId });
}

function asError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ProtocolError;
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

async function exportSel(fmt: 'json' | 'csv'): Promise<void> {
  if (selection.count() === 0) {
    notice.value = { warn: true, text: '请先勾选要导出的消息' };
    return;
  }
  const path = await pickSavePath(`选中.${fmt}`);
  if (!path) return;
  try {
    const r = await store.exportMessages({
      format: fmt,
      scope: { type: 'indexes', indexes: selection.indices() },
      out_path: path,
    });
    notice.value = { warn: false, text: `已导出 ${r.count} 条 → ${r.path}` };
  } catch (e) {
    notice.value = { warn: true, text: asError(e).message };
  }
}

async function exportAll(fmt: 'json' | 'csv'): Promise<void> {
  const path = await pickSavePath(`全部匹配.${fmt}`);
  if (!path) return;
  try {
    const r = await store.exportMessages({
      format: fmt,
      scope: { type: 'filter', filter: { ...filter } },
      out_path: path,
    });
    notice.value = { warn: false, text: `已导出 ${r.count} 条 → ${r.path}` };
  } catch (e) {
    notice.value = { warn: true, text: asError(e).message };
  }
}

const statusLine = computed(() => {
  // 注意：statusText 是 ComputedRef，JS 模板字符串里必须取 .value，
  // 否则错误/提示分支会渲染成 "[object Object]"（模板插值才会自动解包 ref）。
  const st = statusText.value;
  if (data.loading) {
    return `加载中…${data.progress ? ` · ${data.progress.message}` : ''}`;
  }
  if (data.error) {
    return `⚠ ${data.error.message}${st ? ` · ${st}` : ''}`;
  }
  if (data.loaded && data.messages.length === 0) {
    return '没有可用的聊天数据：请先在「导出」页扫描会话，或导出一次';
  }
  if (notice.value) {
    return `${notice.value.warn ? '⚠ ' : ''}${notice.value.text}${st ? ` · ${st}` : ''}`;
  }
  return st;
});

const statusWarn = computed(
  () => Boolean(data.error) || Boolean(notice.value?.warn),
);

/** 微信数据不可用（KEY_NOT_FOUND/NO_ACCOUNT）→ 状态行给「打开本地数据」出口
 *  （docs/07 Phase 2 #7：跳管理页触发选目录） */
const showOpenLocal = computed(
  () => data.error !== null && (data.error.code === 'KEY_NOT_FOUND' || data.error.code === 'NO_ACCOUNT'),
);

defineExpose({ focusChat });
</script>

<template>
  <div class="filter-panel">
    <div class="f-panel">
      <div class="f-row">
        <label class="f-label" for="fq">关键词</label>
        <input
          id="fq"
          v-model="queryDraft"
          class="f-input f-grow"
          data-testid="entry_query"
          placeholder="空格分词 AND：正文/发送人/群名/群号/附件名"
          @keydown.enter="applyQuery"
        />
        <label class="f-label" for="fc">群号/会话ID</label>
        <input
          id="fc"
          v-model="chatDraft"
          class="f-input"
          data-testid="entry_chat"
          @keydown.enter="applyChat"
        />
        <span class="f-reset">
          <button type="button" class="f-btn" data-testid="btn_reset" @click="resetAll">
            重置
          </button>
        </span>
      </div>

      <div class="f-row">
        <select
          class="f-input"
          data-testid="cmb_chat"
          :value="filter.chat_id"
          @change="onChatSelect"
        >
          <option value="">全部会话</option>
          <option v-for="c in chatOptions" :key="c.chat_id" :value="c.chat_id">{{ c.chat }}</option>
        </select>
        <select class="f-input" data-testid="cmb_type" :value="filter.type" @change="onTypeSelect">
          <option value="">全部类型</option>
          <option v-for="t in typeOptions" :key="t.code" :value="t.code">
            {{ t.label }}（{{ t.count }}）
          </option>
        </select>
        <DatePicker
          data-testid="entry_from"
          :model-value="filter.date_from"
          placeholder="起始日期"
          @update:model-value="(v: string) => store.setFilter({ date_from: v })"
        />
        <span class="f-tilde">至</span>
        <DatePicker
          data-testid="entry_to"
          :model-value="filter.date_to"
          placeholder="结束日期"
          @update:model-value="(v: string) => store.setFilter({ date_to: v })"
        />
        <div class="f-chips" data-testid="quick_buttons">
          <button
            v-for="q in QUICK"
            :key="q.id"
            type="button"
            class="f-chip"
            :data-quick="q.id"
            @click="quick(q.id)"
          >
            {{ q.label }}
          </button>
        </div>
        <label class="f-label">
          <input v-model="resolveMedia" type="checkbox" data-testid="var_resolve_media" />
          解析附件路径
        </label>
      </div>

      <div class="f-toolbar">
        <button type="button" class="f-btn primary" data-testid="btn_load" @click="load">
          加载/刷新数据
        </button>
        <span class="f-sep"></span>
        <button
          type="button"
          class="f-btn"
          data-testid="btn_select_all"
          @click="selection.selectAll(matchedIndexes)"
        >
          全选
        </button>
        <button
          type="button"
          class="f-btn"
          data-testid="btn_select_none"
          @click="selection.selectNone()"
        >
          清空
        </button>
        <button
          type="button"
          class="f-btn"
          data-testid="btn_invert"
          @click="selection.invert(matchedIndexes)"
        >
          反选
        </button>
        <span class="f-sep"></span>
        <button type="button" class="f-btn" data-testid="btn_json" @click="exportSel('json')">
          导出选中 JSON
        </button>
        <button type="button" class="f-btn" data-testid="btn_csv" @click="exportSel('csv')">
          导出选中 CSV
        </button>
        <span class="f-sep"></span>
        <button type="button" class="f-btn" data-testid="btn_all_json" @click="exportAll('json')">
          全部匹配 JSON
        </button>
        <button type="button" class="f-btn" data-testid="btn_all_csv" @click="exportAll('csv')">
          全部匹配 CSV
        </button>
      </div>
    </div>

    <div class="statusbar" :class="{ warn: statusWarn }" data-testid="lbl_status">
      {{ statusLine }}
      <button
        v-if="showOpenLocal"
        type="button"
        class="f-btn"
        data-testid="btn_open_local_error"
        @click="emit('open-local')"
      >
        打开本地数据
      </button>
    </div>
  </div>
</template>
