<script setup lang="ts">
// 聊天数据管理页（A2 #27/#28/#29/#30 的载体）：会话树 + 搜索 + 浏览视图（纯浏览，无勾选）。
// 本地数据（docs/06 Phase 1）：「打开本地数据」回读 + 「打开最近数据」记忆回读 + 自检。
// 导出（#14 面板 / #17 独立页签）已整体迁到 ExportPage.vue，本页不再承载导出动作。
import { computed, inject, ref } from 'vue';
import { pickDir } from '../ipc/dialog';
import type { DoctorResult, ProtocolError } from '../ipc/types';
import { createSelection, STORE_KEY } from '../state/store';
import { filterIndexed } from '../logic/filter';
import MessageList from './MessageList.vue';

const store = inject(STORE_KEY)!;
const { data } = store;
const emit = defineEmits<{ 'to-filter': [chatId: string] }>();

const search = ref('');
const selectedId = ref('');
const notice = ref('');
const doctor = ref<DoctorResult | null>(null); // 自检结果（面板）
const doctorError = ref(''); // 自检失败文案（失败不崩，A2 #30 口径）
const doctorRunning = ref(false);
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

/** 数据源信息卡（docs/06 Phase 2 #8）：来源/条数/导出时间/附件数（stats + exported_at 现成） */
const sourceCard = computed(() => {
  if (!data.loaded) return null;
  const rows: Array<{ testid: string; text: string }> = [
    { testid: 'card_source', text: sourceLabel.value || '来源：—' },
    { testid: 'card_count', text: `条数 ${data.stats?.messages ?? data.messages.length}` },
    { testid: 'card_media', text: `附件 ${data.stats?.media ?? 0}` },
  ];
  if (data.exportedAt) {
    rows.push({ testid: 'card_exported_at', text: `导出于 ${data.exportedAt}` });
  }
  return rows;
});

/** 最近本地数据目录（docs/07 #6）：一键回到上次的数据包 */
const lastDir = computed(() => data.settings.last_export_dir);

function asError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ProtocolError;
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

/** 打开本地数据：选目录 → load {kind:"export"}，复用全部浏览/筛选链路 */
async function openLocal(): Promise<void> {
  const dir = await pickDir(lastDir.value || undefined); // 定位到上次的目录（#6 记忆）
  if (!dir) return;
  notice.value = '';
  await store.load({ kind: 'export', out_dir: dir });
  // 成败由 store 写入的 data.error / summary / sourceLabel 展示（不另设错误条）
  // 记忆由 store.load 成功路径统一写（rememberExportDir，#6）
}

/** 一键回到上次的本地数据包（docs/07 #6）：不弹选择框，直接回读记忆目录 */
async function openRecent(): Promise<void> {
  const dir = lastDir.value;
  if (!dir) return;
  notice.value = '';
  await store.load({ kind: 'export', out_dir: dir });
}

/** 数据层自检（docs/02 §1.2 `doctor`，docs/07 #3）：账号/密钥/逐库解密/消息数 */
async function runDoctor(): Promise<void> {
  if (doctorRunning.value) return;
  doctorRunning.value = true;
  doctor.value = null;
  doctorError.value = '';
  try {
    doctor.value = await store.ipc.doctor();
  } catch (e) {
    doctorError.value = asError(e).message; // KEY_NOT_FOUND/NO_ACCOUNT 等：展示文案不崩
  } finally {
    doctorRunning.value = false;
  }
}

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

// App 经 ref 触发：状态行「打开本地数据」出口（docs/07 Phase 2 #7）
defineExpose({ openLocal });
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
        <span class="f-sep"></span>
        <button
          type="button"
          class="f-btn"
          data-testid="btn_open_local"
          @click="openLocal"
        >
          打开本地数据
        </button>
        <button
          type="button"
          class="f-btn"
          data-testid="btn_doctor"
          :disabled="doctorRunning"
          @click="runDoctor"
        >
          {{ doctorRunning ? '自检中…' : '自检' }}
        </button>
        <button
          v-if="lastDir"
          type="button"
          class="f-btn"
          data-testid="btn_open_recent"
          @click="openRecent"
        >
          打开最近数据
        </button>
        <span class="f-count" data-testid="lbl_source">{{ sourceLabel }}</span>
      </div>

      <div class="f-row" v-if="notice">
        <span class="f-count" data-testid="manage_notice">{{ notice }}</span>
      </div>
      <!-- 自检结果面板（docs/07 #3）：每库 ✅/❌ + 消息数；失败只显示文案不崩 -->
      <div class="f-row" v-if="doctorError || doctor" data-testid="doctor_panel">
        <span class="f-count" data-testid="doctor_error" v-if="doctorError">⚠ {{ doctorError }}</span>
        <template v-if="doctor">
          <span class="f-count" data-testid="doctor_summary">
            自检 v{{ doctor.version }} · 账号 {{ doctor.account.wxid }} ·
            密钥 {{ doctor.key_sources.hit }}/{{ doctor.key_sources.total }}
            <template v-if="doctor.key_sources.missing.length > 0">
              （缺：{{ doctor.key_sources.missing.join('、') }}）
            </template>
            · 消息 {{ doctor.messages ?? '—' }} 条
          </span>
          <span
            v-for="db in doctor.dbs"
            :key="db.name"
            class="f-count"
            data-testid="doctor_db"
          >
            {{ db.ok ? '✅' : '❌' }} {{ db.name }}
          </span>
        </template>
      </div>
    </div>

    <div class="f-count" data-testid="lbl_summary">{{ summary }}</div>

    <!-- 数据源信息卡（docs/06 Phase 2 #8）：来源/条数/附件/导出时间（export 来源才有导出时间） -->
    <div class="f-row source-card" v-if="sourceCard" data-testid="source_card">
      <span
        v-for="row in sourceCard"
        :key="row.testid"
        class="f-count"
        :data-testid="row.testid"
      >{{ row.text }}</span>
    </div>

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
