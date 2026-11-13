<script setup lang="ts">
// 快递单号提取页（docs/07 #19，2026-11-13）：源工具「快递单号增量提取工具」并入主程序。
// 拍板①：本地宽筛/规则提取为默认路径（UI 明示「纯本地准确率有限」），联网 AI 审核
// 用户可选（默认关、显式开启、可随时不用）；联网声明按页隔离——本页是全程序唯一
// 可联网处，零外链断言（security.spec C）在默认态仍须 0（披露文案为纯文本，不加 <a>）。
// 拍板③：API Key DPAPI 加密存本机（不回传不入库）；上传去隐私——UI 明示将发送行数
// 与去向（api.xiaomimimo.com），行数取 preflight 的 send_rows（候选 + 回检抽样）。
// 参数走 docs/02 §1.2 extract_tracking（preflight/run）。
import { computed, inject, ref, watch } from 'vue';
import { pickOpenPath, pickSavePath } from '../ipc/dialog';
import type {
  ExtractTrackingParams, ProtocolError, TrackingPreflight,
} from '../ipc/types';
import { STORE_KEY } from '../state/store';

const store = inject(STORE_KEY)!;

// ---------------------------------------------------------------- 文件与选项

const inPath = ref('');    // 新导出 CSV（本程序导出列）
const oldPath = ref('');   // 旧成品 CSV（可选，增量复用）
const outPath = ref('');   // 输出文件（选输入后自动推导，可改）
const useReuse = ref(true); // 增量复用旧成品
const useAudit = ref(true); // 抽样回检 300 行（仅联网有意义）
const resume = ref(true);   // 断点续跑

// ---------------------------------------------------------------- 联网（默认关）

const network = ref(false); // 拍板①：默认纯本地
const apiKey = ref('');      // 显式填写才传（DPAPI 落盘在 sidecar）
const preflight = ref<TrackingPreflight | null>(null);
const keyStored = ref(false); // preflight 回显：本机是否已存 Key

const running = ref(false);
const notice = ref('');
const logLines = ref<string[]>([]);

/** 披露行数：联网开启时明示「将把 N 行消息文本发送到第三方 API」（拍板③） */
const sendRows = computed(() => (network.value ? (preflight.value?.send_rows ?? 0) : 0));
const disclosure = computed(() =>
  network.value
    ? `将把 ${sendRows.value} 行消息文本发送到第三方 API（api.xiaomimimo.com）`
    : '',
);

/** 进度（复用 data://progress 的 done/total；A3 口径同导出页） */
const progressPct = computed(() => {
  const p = store.data.progress;
  if (!running.value || !p || p.phase !== 'extract_tracking' || !p.total) return 0;
  return Math.round((p.done / p.total) * 100);
});
const progressText = computed(() => {
  const p = store.data.progress;
  return running.value && p && p.phase === 'extract_tracking'
    ? `处理中… ${p.message}`
    : '';
});

function asError(e: unknown): ProtocolError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return e as ProtocolError;
  return { code: 'INTERNAL', message: '内部错误', detail: String(e) };
}

/** 日志框写一行（带时间戳，同导出页；只留最近 200 行） */
function log(msg: string): void {
  const t = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const line = `[${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}] ${msg}`;
  logLines.value = [...logLines.value.slice(-199), line];
}

// ---------------------------------------------------------------- 文件选择

async function browseIn(): Promise<void> {
  // 建议路径用绝对路径（浏览器态直接回它，便于断言；真实态仅作 defaultPath 定位）
  const p = await pickOpenPath(inPath.value || 'C:/mock/微信导出.csv');
  if (!p) return;
  inPath.value = p;
  // 输出文件自动推导（源工具 _auto_out 同款）：base + _提取快递单号.csv
  if (!outPath.value) {
    const dot = p.lastIndexOf('.');
    outPath.value = (dot > 0 ? p.slice(0, dot) : p) + '_提取快递单号.csv';
  }
  invalidatePreflight();
}

async function browseOld(): Promise<void> {
  const p = await pickOpenPath(oldPath.value || 'C:/mock/上次_提取快递单号.csv');
  if (!p) return;
  oldPath.value = p;
  invalidatePreflight();
}

async function browseOut(): Promise<void> {
  const p = await pickSavePath(outPath.value || 'C:/mock/微信导出_提取快递单号.csv');
  if (p) outPath.value = p;
}

function clearOld(): void {
  oldPath.value = '';
  invalidatePreflight();
}

/** 输入/选项变化 → preflight 结果作废（行数披露必须与当前参数一致） */
function invalidatePreflight(): void {
  preflight.value = null;
}

watch([network, useAudit], invalidatePreflight);

// ---------------------------------------------------------------- 预检 / 提取

function baseParams(mode: 'preflight' | 'run'): ExtractTrackingParams {
  const params: ExtractTrackingParams = {
    mode,
    in_path: inPath.value.trim(),
    network: network.value,
    audit: useAudit.value,
    resume: resume.value,
  };
  if (useReuse.value && oldPath.value) params.old_path = oldPath.value.trim();
  if (network.value && apiKey.value) params.api_key = apiKey.value; // 显式填写才传
  if (mode === 'run') params.out_path = outPath.value.trim();
  return params;
}

function validateInputs(): boolean {
  if (!inPath.value.trim()) {
    notice.value = '⚠ 请先选择新导出 CSV 文件';
    log(notice.value);
    return false;
  }
  if (outPath.value.trim() && !/^[a-zA-Z]:[\\/]/.test(outPath.value.trim())) {
    notice.value = '⚠ 输出文件必须是绝对路径';
    log(notice.value);
    return false;
  }
  return true;
}

/** ① 预检（不调 API、不写产物）：拿行数规模 + 联网披露行数 */
async function runPreflight(): Promise<void> {
  if (running.value || !validateInputs()) return;
  notice.value = '';
  try {
    const r = await store.ipc.extractTracking(baseParams('preflight'));
    if (r.mode !== 'preflight') return;
    preflight.value = r;
    keyStored.value = r.key_stored;
    const line =
      `预检：输入 ${r.rows} 行 · 宽筛候选 ${r.candidates} 行 · 复用 ${r.reuse_rows} 行` +
      (network.value
        ? ` · 联网 ${r.batches} 批 · 将发送 ${r.send_rows} 行`
        : ' · 纯本地（不发送任何数据）');
    notice.value = line;
    log(line);
    if (network.value) log(disclosure.value); // 明示去向与行数（拍板③）
  } catch (e) {
    notice.value = `⚠ ${asError(e).message}`;
    log(notice.value);
  }
}

/** ② 开始提取（run） */
async function startExtract(): Promise<void> {
  if (running.value || !validateInputs()) return;
  notice.value = '';
  running.value = true;
  log(network.value ? '开始提取（联网 AI 审核）…' : '开始提取（纯本地）…');
  if (network.value && disclosure.value) log(disclosure.value);
  try {
    const r = await store.ipc.extractTracking(baseParams('run'));
    if (r.mode !== 'run') return;
    notice.value =
      `提取完成：有单号行 ${r.with_numbers} · 单号 ${r.numbers} 个` +
      (r.reused_rows ? ` · 复用 ${r.reused_rows} 行` : '') +
      (r.network ? ` · 发送 ${r.sent_rows} 行 / ${r.tokens} token` : '') +
      ` → ${r.path}`;
    log(notice.value);
    keyStored.value = keyStored.value || Boolean(apiKey.value);
    apiKey.value = ''; // 用完即清，不留在界面
  } catch (e) {
    notice.value = `⚠ ${asError(e).message}`;
    log(notice.value);
  } finally {
    running.value = false;
  }
}

/** 打开输出文件所在目录（复用 reveal_path，run 成功后壳已把父目录进 scope） */
function revealOut(): void {
  const p = outPath.value.trim();
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const dir = idx > 0 ? p.slice(0, idx) : p;
  void store.ipc.revealPath(dir).catch(() => {
    notice.value = '⚠ 打开输出目录失败';
    log(notice.value);
  });
}
</script>

<template>
  <div class="tracking-page">
    <!-- 输入区：新导出 CSV / 旧成品（可选）/ 输出文件 -->
    <div class="f-panel" data-testid="trk_inputs">
      <div class="f-row">
        <span class="f-label">新导出CSV:</span>
        <input
          class="f-input f-grow"
          data-testid="trk_entry_in"
          :value="inPath"
          readonly
          placeholder="选择本程序导出的 CSV 文件"
        />
        <button type="button" class="f-btn" data-testid="btn_trk_in" @click="browseIn">
          浏览…
        </button>
      </div>
      <div class="f-row">
        <span class="f-label">旧成品CSV:</span>
        <input
          class="f-input f-grow"
          data-testid="trk_entry_old"
          :value="oldPath"
          readonly
          placeholder="可选：上次的 …_提取快递单号.csv（选了只审新增行，省钱）"
        />
        <button type="button" class="f-btn" data-testid="btn_trk_old" @click="browseOld">
          浏览…
        </button>
        <button
          v-if="oldPath"
          type="button"
          class="f-btn"
          data-testid="btn_trk_old_clear"
          @click="clearOld"
        >
          清除
        </button>
      </div>
      <div class="f-row">
        <span class="f-label">输出文件:</span>
        <input
          class="f-input f-grow"
          data-testid="trk_entry_out"
          :value="outPath"
          readonly
          placeholder="选择输入文件后自动生成"
        />
        <button type="button" class="f-btn" data-testid="btn_trk_out" @click="browseOut">
          浏览…
        </button>
      </div>
    </div>

    <!-- 选项 + 联网审核（默认关） -->
    <div class="f-panel" data-testid="trk_options">
      <div class="f-row">
        <label class="f-label">
          <input v-model="useReuse" type="checkbox" data-testid="trk_var_reuse" />
          增量复用旧成品
        </label>
        <label class="f-label">
          <input
            v-model="useAudit"
            type="checkbox"
            data-testid="trk_var_audit"
            :disabled="!network"
          />
          抽样回检300行（仅联网）
        </label>
        <label class="f-label">
          <input v-model="resume" type="checkbox" data-testid="trk_var_resume" />
          断点续跑
        </label>
        <span class="f-sep"></span>
        <!-- 拍板①：联网审核默认关、显式开启、可随时不用 -->
        <label class="f-label trk-net-label">
          <input
            v-model="network"
            type="checkbox"
            data-testid="trk_var_network"
            @change="apiKey = ''"
          />
          联网 AI 审核（可选，默认关闭）
        </label>
      </div>

      <!-- 联网披露（拍板③）：明示行数与去向；纯文本不加 <a>（零外链口径） -->
      <div
        v-if="network"
        class="trk-disclosure"
        data-testid="trk_disclosure"
        role="note"
      >
        ⚠ {{ disclosure }}。仅发送宽筛命中的「行号+类型+内容」三字段，用于本次语义审核；
        内容不落盘、不写入日志。关闭本开关即回到纯本地（可随时不用）。
      </div>
      <div v-else class="trk-local-hint" data-testid="trk_local_hint">
        纯本地模式：宽筛 + 规则提取，<b>准确率有限</b>（语义歧义、订单号、XML 字段等需 AI 判断）。
        需要更高准确率可开启上方「联网 AI 审核」。
      </div>

      <div v-if="network" class="f-row">
        <span class="f-label">API Key:</span>
        <input
          v-model="apiKey"
          class="f-input f-grow"
          data-testid="trk_entry_key"
          type="password"
          :placeholder="
            keyStored ? '已保存（DPAPI 加密存本机）；留空则用已保存的' : 'platform.xiaomimimo.com 控制台获取'
          "
          autocomplete="off"
        />
        <span class="f-count" data-testid="trk_key_state">
          {{ keyStored ? '本机已存 Key（加密）' : '未保存 Key' }}
        </span>
      </div>
    </div>

    <!-- 动作条：预检 / 开始提取 / 进度 / 日志 -->
    <div class="export-bottom">
      <div class="f-row">
        <button
          type="button"
          class="f-btn"
          data-testid="btn_trk_preflight"
          :disabled="running"
          @click="runPreflight"
        >
          ① 预检（不调API）
        </button>
        <button
          type="button"
          class="f-btn primary"
          data-testid="btn_trk_start"
          :disabled="running"
          @click="startExtract"
        >
          ② 开始提取
        </button>
        <button
          v-if="outPath"
          type="button"
          class="f-btn"
          data-testid="btn_trk_reveal"
          @click="revealOut"
        >
          打开输出目录
        </button>
        <div class="export-progress" aria-hidden="true">
          <i :style="{ width: `${progressPct}%` }"></i>
        </div>
        <span class="f-count" data-testid="trk_progress">{{ progressText }}</span>
      </div>

      <div class="f-row" v-if="notice">
        <span class="f-count" data-testid="trk_notice">{{ notice }}</span>
      </div>

      <div class="export-log" data-testid="trk_log">
        <div v-for="(line, i) in logLines" :key="i" class="export-log-line">{{ line }}</div>
        <div v-if="logLines.length === 0" class="export-log-line">
          （提取日志会显示在这里：预检规模、批次进度、导出结果）
        </div>
      </div>
    </div>
  </div>
</template>
