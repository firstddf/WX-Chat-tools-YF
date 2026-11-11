<script setup lang="ts">
// 导出页（docs/07 #17，2026-11-11）：本地导出独立成页，三段布局照 Tk「导出」页
// （wxchart-tool/gui.py:102-152）—— 左：搜索会话 + 全选/清空/反选 + 会话勾选列表；
// 右：「导出设置」卡（时间范围 / 导出内容 / 生成物 / 增量 / 输出目录）；
// 底：▶开始导出 + 打开导出目录 + 进度条 + 日志框。参数走 docs/02 §1.2 bundle `options`
// （承接原管理页内嵌面板的全部逻辑，#14 拍板①「内嵌」已被本项改需求撤销）。
import { computed, inject, ref, watch } from 'vue';
import { pickDir } from '../ipc/dialog';
import type { BundleOptions, ExportParams, ProtocolError } from '../ipc/types';
import { STORE_KEY } from '../state/store';
import DatePicker from './DatePicker.vue';

const store = inject(STORE_KEY)!;
const { data } = store;

// ---------------------------------------------------------------- 导出设置（原 #14 面板迁入）

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
/** 快捷时间范围（与筛选页 QUICK 同一组，写本页自己的起止日期） */
const EXP_QUICK: Array<{ id: string; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'today', label: '今天' },
  { id: '7', label: '近7天' },
  { id: '30', label: '近30天' },
  { id: 'month', label: '本月' },
];

const search = ref('');
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

const exporting = ref(false); // 导出中（按钮禁用 + 进度条）
const bundlePath = ref(''); // 最近一次数据包根目录（「打开导出目录」用）
const notice = ref(''); // 最新一条提示（export_notice）
const logLines = ref<string[]>([]); // 日志框（Tk 底部「日志」LabelFrame 的网页等价）

const visibleChats = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return data.chats;
  return data.chats.filter(
    (c) => c.chat.toLowerCase().includes(q) || c.chat_id.toLowerCase().includes(q),
  );
});

const lastDir = computed(() => data.settings.last_export_dir);

/** 进度条（A3：协议无 cancel/无进度百分比字段，用现成 data://progress 的 done/total） */
const progressPct = computed(() => {
  if (!exporting.value || !data.progress || !data.progress.total) return 0;
  return Math.round((data.progress.done / data.progress.total) * 100);
});
const progressText = computed(() =>
  exporting.value && data.progress ? `导出中… ${data.progress.message}` : '',
);

function asError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ProtocolError;
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

/** 日志框写一行（带时间戳，同 Tk gui.log；只留最近 200 行，防长跑撑爆 DOM） */
function log(msg: string): void {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const line = `[${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}] ${msg}`;
  logLines.value = [...logLines.value.slice(-199), line];
}

/** 数据包导出执行体：完成提示按 result.mode 分文案（docs/02 §1.2 #14：
 *  full →「已导出数据包 N 条」、incremental →「增量导出完成：新增 N 条」（同 Tk gui.py:305）） */
async function runBundle(dir: string, options?: BundleOptions): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  notice.value = '';
  log(options ? `开始导出（选择性）→ ${dir}` : `开始导出（全量数据包）→ ${dir}`);
  try {
    const params: ExportParams = { format: 'bundle', out_path: dir };
    if (options) params.options = options;
    const r = await store.exportMessages(params);
    bundlePath.value = r.path;
    notice.value =
      r.mode === 'incremental'
        ? `增量导出完成：新增 ${r.newMessages ?? 0} 条 → ${r.path}`
        : `已导出数据包 ${r.count} 条 → ${r.path}`;
    log(notice.value);
    void store.rememberExportDir(r.path); // 数据包根 → 最近目录（#6）
  } catch (e) {
    notice.value = `⚠ ${asError(e).message}`;
    log(notice.value);
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

// ---------------------------------------------------------------- 会话多选（Tk 左栏）

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

/** Ctrl+A（App 在导出页转发）= 全选会话（吞掉浏览器整页全选；Tk 导出页 Listbox 的
 *  Ctrl 多选网页等价）。导出页恒消费该键。 */
function handleCtrlA(): boolean {
  expSelectAll();
  return true;
}

// 数据重载后会话清单变化 → 回到「全选」缺省（不残留已消失的会话 id）
watch(
  () => data.chats,
  () => {
    expChats.value = data.chats.map((c) => c.chat_id);
  },
  { immediate: true },
);

// 最近目录记忆到位/变化 → 输出目录预填（#6；空才填，不覆盖用户已选）。
// 与上面的会话 watch 分开：settings 可能晚于挂载到达，合在一个 watch 里会漏预填。
watch(
  lastDir,
  (v) => {
    if (!expDir.value && v) expDir.value = v;
  },
  { immediate: true },
);

// ---------------------------------------------------------------- 时间范围 / 参数组装

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 快捷时间范围（同筛选页 quick 语义，写本页自己的起止） */
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
    log(notice.value);
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
      log(notice.value);
      return null;
    }
    start = v;
  }
  if (rawTo) {
    const v = dayToTs(rawTo, true);
    if (v === null) {
      notice.value = '⚠ 日期格式应为 YYYY-MM-DD';
      log(notice.value);
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
    log(notice.value);
    return;
  }
  await runBundle(expDir.value, options);
}

/** 数据包导出完成后的「打开导出目录」（复用 reveal_path，scope 已由壳放行） */
function revealBundle(): void {
  if (!bundlePath.value) return;
  void store.ipc.revealPath(bundlePath.value).catch(() => {
    notice.value = '⚠ 打开导出目录失败';
    log(notice.value);
  });
}

// App 经 ref 触发：导出页 Ctrl+A = 全选会话（docs/07 #17）
defineExpose({ handleCtrlA });
</script>

<template>
  <div class="export-page">
    <div class="export-top">
      <!-- 左：搜索会话 + 全选/清空/反选 + 会话勾选列表（Tk 左栏 gui.py:110-127） -->
      <div class="export-left">
        <div class="f-panel">
          <div class="f-row">
            <span class="f-label">搜索会话:</span>
            <input
              v-model="search"
              class="f-input f-grow"
              data-testid="exp_entry_search"
              placeholder="名称/群号"
            />
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
        </div>

        <div class="chat-tree" data-testid="exp_chat_tree">
          <div
            v-for="c in visibleChats"
            :key="c.chat_id"
            class="chat-row"
            data-testid="exp_chat_row"
            @click="toggleChat(c.chat_id)"
          >
            <div class="chat-head">
              <input
                type="checkbox"
                class="chat-check"
                data-testid="exp_chat_check"
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
          <div v-if="visibleChats.length === 0" class="f-count" data-testid="exp_empty">
            没有可用的聊天数据：请先加载数据，或打开本地数据
          </div>
        </div>
      </div>

      <!-- 右：「导出设置」卡（Tk 右栏 gui.py:163-208 _build_settings） -->
      <div class="f-panel export-right" data-testid="export_settings">
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

        <!-- 输出目录（pickDir + 最近目录预填） -->
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
        </div>
      </div>
    </div>

    <!-- 底：动作条 + 进度条 + 日志（Tk 底栏 gui.py:133-152；A3 不放「■停止」） -->
    <div class="export-bottom">
      <div class="f-row">
        <button
          type="button"
          class="f-btn primary"
          data-testid="btn_export_start"
          :disabled="exporting"
          @click="exportFromPanel"
        >
          ▶ 开始导出
        </button>
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
          v-if="bundlePath"
          type="button"
          class="f-btn"
          data-testid="btn_reveal_bundle"
          @click="revealBundle"
        >
          打开导出目录
        </button>
        <div class="export-progress" aria-hidden="true">
          <i :style="{ width: `${progressPct}%` }"></i>
        </div>
        <span class="f-count" data-testid="export_progress">{{ progressText }}</span>
      </div>

      <div class="f-row" v-if="notice">
        <span class="f-count" data-testid="export_notice">{{ notice }}</span>
      </div>

      <div class="export-log" data-testid="export_log">
        <div v-for="(line, i) in logLines" :key="i" class="export-log-line">{{ line }}</div>
        <div v-if="logLines.length === 0" class="export-log-line">（导出日志会显示在这里）</div>
      </div>
    </div>
  </div>
</template>
