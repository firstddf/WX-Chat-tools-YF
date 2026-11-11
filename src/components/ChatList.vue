<script setup lang="ts">
// 聊天数据管理页（A2 #27/#28/#29/#30 的载体）：会话树 + 搜索 + 浏览视图（纯浏览，无勾选）。
// 本地数据（docs/06 Phase 1）：「导出本地数据包」bundle 全量导出 + 「打开本地数据」回读。
// 导出设置面板（docs/07 #14，2026-11-11）：会话多选 / 时间范围 / 内容类型 / 生成物 /
// 增量 —— 逐项对齐 Tk 导出页截图，参数走 docs/02 §1.2 bundle `options`（拍板①=内嵌本页）。
import { computed, inject, ref, watch } from 'vue';
import { pickDir } from '../ipc/dialog';
import type { BundleOptions, DoctorResult, ExportParams, ProtocolError } from '../ipc/types';
import { createSelection, STORE_KEY } from '../state/store';
import { filterIndexed } from '../logic/filter';
import DatePicker from './DatePicker.vue';
import MessageList from './MessageList.vue';

const store = inject(STORE_KEY)!;
const { data } = store;
const emit = defineEmits<{ 'to-filter': [chatId: string] }>();

const search = ref('');
const selectedId = ref('');
const notice = ref('');
const exporting = ref(false); // bundle 导出中（按钮禁用 + 进度行）
const bundlePath = ref(''); // 最近一次数据包根目录（「打开导出目录」用）
const doctor = ref<DoctorResult | null>(null); // 自检结果（面板）
const doctorError = ref(''); // 自检失败文案（失败不崩，A2 #30 口径）
const doctorRunning = ref(false);
const browseSelection = createSelection(false); // 纯浏览：选择 API 恒为空（A1 #6）

// ---------------------------------------------------------------- 导出设置面板（#14）

/** 导出内容类型（text 恒勾且禁用——同 Tk：文字必导，docs/06 字段映射） */
const EXP_TYPE_KEYS = ['image', 'file', 'video', 'voice'] as const;
const EXP_TYPE_LABELS: Record<string, string> = {
  image: '图片', file: '文件', video: '视频', voice: '语音',
};
/** 四类生成物（默认全勾 = exporter 默认 True） */
const EXP_ARTIFACT_KEYS = ['html', 'csv', 'media_index', 'date_index'] as const;
const EXP_ARTIFACT_LABELS: Record<string, string> = {
  html: 'HTML', csv: 'csv', media_index: '按类型索引', date_index: '按日期索引',
};
/** 快捷时间范围（与筛选页 QUICK 同一组，写面板自己的起止日期） */
const EXP_QUICK: Array<{ id: string; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: '7', label: '近7天' },
  { id: '30', label: '近30天' },
  { id: 'month', label: '本月' },
];

// 默认展开（2026-11-11 用户反馈：对齐 Tk 导出页常驻卡片，不用先点「导出设置」）
const settingsOpen = ref(true); // 面板展开（拍板①：管理页内嵌，不新开页签）
const expChats = ref<string[]>([]); // 勾选的会话（chat_id == chat.username）
const expFrom = ref('');
const expTo = ref('');
const expTypes = ref<Record<string, boolean>>({
  image: true, file: true, video: true, voice: true,
});
const expArtifacts = ref<Record<string, boolean>>({
  html: true, csv: true, media_index: true, date_index: true,
});
const expIncremental = ref(true); // 默认勾（同 Tk var_incremental(True)）
const expDir = ref(''); // 输出目录（浏览选择；预填最近目录 #6）

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

/** bundle 导出中的进度行（复用 data://progress，docs/07 P0 步骤 4） */
const exportProgress = computed(() =>
  exporting.value && data.progress ? `导出中… ${data.progress.message}` : '',
);

function asError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ProtocolError;
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

/** 数据包导出执行体：完成提示按 result.mode 分文案（docs/02 §1.2 #14：
 *  full →「已导出数据包 N 条」（现行）、incremental →「增量导出完成：新增 N 条」（同 Tk gui.py:305）） */
async function runBundle(dir: string, options?: BundleOptions): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  notice.value = '';
  try {
    const params: ExportParams = { format: 'bundle', out_path: dir };
    if (options) params.options = options;
    const r = await store.exportMessages(params);
    bundlePath.value = r.path;
    notice.value =
      r.mode === 'incremental'
        ? `增量导出完成：新增 ${r.newMessages ?? 0} 条 → ${r.path}`
        : `已导出数据包 ${r.count} 条 → ${r.path}`;
    void store.rememberExportDir(r.path); // 数据包根 → 最近目录（#6）
  } catch (e) {
    notice.value = `⚠ ${asError(e).message}`;
  } finally {
    exporting.value = false;
  }
}

/** 导出本地数据包（format=bundle，全量快捷入口；docs/02 §1.2 / docs/06 Phase 1） */
async function exportBundle(): Promise<void> {
  if (exporting.value) return;
  const dir = await pickDir(lastDir.value || undefined); // 定位到上次的目录（#6 记忆）
  if (!dir) return;
  await runBundle(dir);
}

// ---------------------------------------------------------------- 导出设置面板（#14）

function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
  if (settingsOpen.value) {
    expChats.value = data.chats.map((c) => c.chat_id); // 开面板 = 全选（缺省语义）
    if (!expDir.value) expDir.value = lastDir.value; // 输出目录预填最近目录（#6）
  }
}

// 数据重载后会话清单变化 → 面板开着就回到「全选」缺省（不残留已消失的会话 id）
watch(
  () => data.chats,
  () => {
    if (settingsOpen.value) expChats.value = data.chats.map((c) => c.chat_id);
    if (!expDir.value) expDir.value = lastDir.value; // 输出目录预填最近目录（#6；不覆盖用户已选）
  },
);

/** Ctrl+A（App 在管理页转发）：面板展开时 = 全选会话。返回是否消费该键——
 *  收起时返回 false，让浏览器默认只在消息正文里选字（骨架已 user-select:none）。 */
function handleCtrlA(): boolean {
  if (!settingsOpen.value) return false;
  expSelectAll();
  return true;
}

function toggleChat(id: string): void {
  expChats.value = expChats.value.includes(id)
    ? expChats.value.filter((x) => x !== id)
    : [...expChats.value, id];
}

/** 三按钮作用于**当前搜索可见**的会话（同 Tk visible_chats 口径） */
function expSelectAll(): void {
  expChats.value = visibleChats.value.map((c) => c.chat_id);
}

function expSelectNone(): void {
  expChats.value = [];
}

function expInvert(): void {
  const picked = new Set(expChats.value);
  for (const c of visibleChats.value) {
    if (picked.has(c.chat_id)) picked.delete(c.chat_id);
    else picked.add(c.chat_id);
  }
  expChats.value = data.chats.map((c) => c.chat_id).filter((id) => picked.has(id)); // 保持树顺序
}

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 快捷时间范围（同筛选页 quick 语义，写面板自己的起止） */
function expQuick(id: string): void {
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
  expFrom.value = from;
  expTo.value = to;
}

/** YYYY-MM-DD → unix 秒（同 Tk gui._parse_date：起=当天 00:00:00、止=当天 23:59:59；
 *  空串由调用方按「不限」处理，非法/日期不存在 → null 供调用方报日期错误） */
function dayToTs(day: string, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  if (end) dt.setDate(dt.getDate() + 1); // +1 天 −1 秒 = 23:59:59（同 Tk timedelta）
  return Math.floor(dt.getTime() / 1000) - (end ? 1 : 0);
}

/** 组装 bundle options（docs/02 §1.2 白名单键；缺省语义：全选/不限/全类型/全生成物 = 省键）。
 *  校验不过写 notice 并回 null（不发请求）。 */
function buildOptions(): BundleOptions | null {
  const all = data.chats.map((c) => c.chat_id);
  const checked = all.filter((id) => expChats.value.includes(id));
  if (checked.length === 0) {
    notice.value = '⚠ 请至少选择一个会话（勾选左侧会话或点「全选」）';
    return null;
  }
  let start = 0;
  let end = 0;
  const rawFrom = expFrom.value.trim();
  const rawTo = expTo.value.trim();
  if (rawFrom) {
    const v = dayToTs(rawFrom, false);
    if (v === null) {
      notice.value = '⚠ 日期格式应为 YYYY-MM-DD';
      return null;
    }
    start = v;
  }
  if (rawTo) {
    const v = dayToTs(rawTo, true);
    if (v === null) {
      notice.value = '⚠ 日期格式应为 YYYY-MM-DD';
      return null;
    }
    end = v;
  }
  const options: BundleOptions = {};
  if (checked.length !== all.length) options.chats = checked; // 全选 = 缺省语义（省键）
  if (start) options.start_ts = start;
  if (end) options.end_ts = end;
  const types = EXP_TYPE_KEYS.filter((k) => expTypes.value[k]);
  if (types.length !== EXP_TYPE_KEYS.length) options.include = ['text', ...types]; // 恒含 text
  const arts = EXP_ARTIFACT_KEYS.filter((k) => expArtifacts.value[k]);
  if (arts.length !== EXP_ARTIFACT_KEYS.length) {
    // 给了对象则逐键覆盖（缺键=true）→ 显式回传四键，避免上一次的值残留
    options.artifacts = {
      html: expArtifacts.value.html,
      csv: expArtifacts.value.csv,
      media_index: expArtifacts.value.media_index,
      date_index: expArtifacts.value.date_index,
    };
  }
  options.incremental = expIncremental.value;
  return options;
}

async function browseExpDir(): Promise<void> {
  const dir = await pickDir(expDir.value || lastDir.value || undefined);
  if (dir) expDir.value = dir;
}

async function exportFromPanel(): Promise<void> {
  if (exporting.value) return;
  const options = buildOptions(); // 校验不过 → notice 提示、不发请求
  if (!options) return;
  if (!expDir.value) {
    notice.value = '⚠ 请先选择输出目录';
    return;
  }
  await runBundle(expDir.value, options);
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

/** 数据包导出完成后的「打开导出目录」（复用 reveal_path，scope 已由壳放行） */
function revealBundle(): void {
  if (!bundlePath.value) return;
  void store.ipc.revealPath(bundlePath.value).catch(() => {
    notice.value = '⚠ 打开导出目录失败';
  });
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

// App 经 ref 触发：状态行「打开本地数据」出口（docs/07 Phase 2 #7）+ 管理页 Ctrl+A（#14）
defineExpose({ openLocal, handleCtrlA });
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
          data-testid="btn_export_bundle"
          :disabled="exporting"
          @click="exportBundle"
        >
          导出本地数据包
        </button>
        <button
          type="button"
          class="f-btn"
          data-testid="btn_export_settings"
          :aria-expanded="settingsOpen"
          @click="toggleSettings"
        >
          {{ settingsOpen ? '收起导出设置' : '导出设置' }}
        </button>
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
        <button
          v-if="bundlePath"
          type="button"
          class="f-btn"
          data-testid="btn_reveal_bundle"
          @click="revealBundle"
        >
          打开导出目录
        </button>
        <span class="f-count" data-testid="lbl_source">{{ sourceLabel }}</span>
      </div>
      <!-- 导出设置面板（docs/07 #14：选择性 + 增量数据包；拍板①=管理页内嵌，不新开页签） -->
      <div v-if="settingsOpen" class="settings-stack" data-testid="export_settings">
        <!-- 会话多选：勾选在左侧会话树（面板展开才显示），三按钮作用于搜索可见的会话（同 Tk） -->
        <div class="f-row">
          <span class="f-label">导出会话</span>
          <button type="button" class="f-btn" data-testid="btn_exp_all" @click="expSelectAll">
            全选
          </button>
          <button type="button" class="f-btn" data-testid="btn_exp_none" @click="expSelectNone">
            清空
          </button>
          <button type="button" class="f-btn" data-testid="btn_exp_invert" @click="expInvert">
            反选
          </button>
          <span class="f-count" data-testid="exp_chat_count">
            已选 {{ expChats.length }}/{{ data.chats.length }} 个会话
          </span>
        </div>

        <!-- 时间范围：DatePicker（A3 复用）+ 快捷按钮（与筛选页同组语义） -->
        <div class="f-row">
          <span class="f-label">时间范围</span>
          <DatePicker
            data-testid="entry_exp_from"
            :model-value="expFrom"
            placeholder="起始日期"
            @update:model-value="(v: string) => (expFrom = v)"
          />
          <span class="f-tilde">至</span>
          <DatePicker
            data-testid="entry_exp_to"
            :model-value="expTo"
            placeholder="结束日期"
            @update:model-value="(v: string) => (expTo = v)"
          />
          <div class="f-chips" data-testid="exp_quick_buttons">
            <button
              v-for="q in EXP_QUICK"
              :key="q.id"
              type="button"
              class="f-chip"
              :data-testid="`exp_quick_${q.id}`"
              @click="expQuick(q.id)"
            >
              {{ q.label }}
            </button>
          </div>
        </div>

        <!-- 导出内容（text 恒勾禁用）+ 四类生成物 + 增量 -->
        <div class="f-row">
          <span class="f-label">导出内容</span>
          <label class="f-label">
            <input type="checkbox" checked disabled data-testid="var_include_text" />
            文字（必选）
          </label>
          <label v-for="t in EXP_TYPE_KEYS" :key="t" class="f-label">
            <input v-model="expTypes[t]" type="checkbox" :data-testid="`var_include_${t}`" />
            {{ EXP_TYPE_LABELS[t] }}
          </label>
          <span class="f-sep"></span>
          <span class="f-label">生成物</span>
          <label v-for="a in EXP_ARTIFACT_KEYS" :key="a" class="f-label">
            <input v-model="expArtifacts[a]" type="checkbox" :data-testid="`var_artifact_${a}`" />
            {{ EXP_ARTIFACT_LABELS[a] }}
          </label>
          <span class="f-sep"></span>
          <label class="f-label">
            <input v-model="expIncremental" type="checkbox" data-testid="var_incremental" />
            增量导出（跳过没有新消息的会话）
          </label>
        </div>

        <!-- 输出目录（pickDir + 最近目录预填）+ 开始导出（进度走 data://progress） -->
        <div class="f-row">
          <span class="f-label">输出目录</span>
          <input
            class="f-input f-grow"
            data-testid="entry_exp_dir"
            :value="expDir"
            readonly
            placeholder="未选择目录"
          />
          <button type="button" class="f-btn" data-testid="btn_exp_browse" @click="browseExpDir">
            浏览…
          </button>
          <span class="f-sep"></span>
          <button
            type="button"
            class="f-btn primary"
            data-testid="btn_export_start"
            :disabled="exporting"
            @click="exportFromPanel"
          >
            开始导出
          </button>
        </div>
      </div>

      <div class="f-row" v-if="notice || exportProgress">
        <span class="f-count" data-testid="manage_notice">{{ exportProgress || notice }}</span>
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
          <div class="chat-head">
            <!-- 导出设置面板展开时才给勾选（拍板①：会话多选复用本树，docs/07 #14） -->
            <input
              v-if="settingsOpen"
              type="checkbox"
              class="chat-check"
              data-testid="chat_check"
              :checked="expChats.includes(c.chat_id)"
              @click.stop
              @change="toggleChat(c.chat_id)"
            />
            <span class="chat-name">{{ c.chat }}</span>
          </div>
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
