<script setup lang="ts">
// 日期控件（M-A2）：输入框 + 📅 月历弹层，语义照搬 wxchart-tool gui_datepicker.py：
// - 弹层初始年月：有值用值（parseDate），无值/非法用今天；选中日高亮 #1f6feb
// - 月历固定 42 格（周一~周日），含闰年月长；多余格禁用且无文字（短月切换无残留日）
// - ◀▶ 跨年翻月、年份输入框+月份下拉直跳（年份非法不跳转、月份夹取 1..12）
// - 今天/清除（清除=空=不限）、点日回填并关闭、Escape 关闭
// - 弹层单实例：连点 📅 旧弹层销毁重建（:key 递增，等价 Tk 先 destroy 旧 popup）
// - apply 契约：回车、点日、今天/清除、失焦规整后值变化 → 提交；FilterPanel 收到才重筛
import { computed, ref, watch } from 'vue';
import {
  clampMonth,
  clampYear,
  daysInMonth,
  formatDate,
  normalizeDate,
  pad2,
  parseDate,
  todayString,
} from '../utils/date';

// 运行时声明（而非纯类型声明）：类型声明 `modelValue: string` 会编译成 required:true，
// 传 null（等价 Tk set(None)）会触发 "Invalid prop" 告警；运行时默认值 '' 下无此问题。
const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: 'YYYY-MM-DD' },
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  apply: [value: string];
}>();

const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const MONTH_OPTIONS = Array.from({ length: 12 }, (_, i) => pad2(i + 1));

// ---------------------------------------------------------------- 输入框
/** 本地输入缓冲：键入即 emit update:modelValue；规整/提交时回填。 */
const text = ref(String(props.modelValue ?? ''));

watch(
  () => props.modelValue,
  (v) => {
    text.value = v ?? '';
  },
);

function onInput(e: Event): void {
  text.value = (e.target as HTMLInputElement).value;
  emit('update:modelValue', text.value);
}

/** 回车提交：能规整先规整，非法输入按原样提交；值未变也照常 apply（Tk Return → _notify）。 */
function onEnter(): void {
  const normalized = normalizeDate(text.value);
  const value = normalized || text.value;
  if (value !== text.value) {
    text.value = value;
    emit('update:modelValue', value);
  }
  emit('apply', value);
}

/**
 * 失焦规整（Tk <FocusOut> → _normalize）：仅当「规整结果非空且与当前（去空白）值不同」
 * 才回填；值真正变化时补发 apply（规格：失焦规整后值变化 = 提交）。
 * 非法输入保持原样、不提交。
 */
function onBlur(): void {
  const current = text.value;
  const trimmed = current.trim();
  const normalized = normalizeDate(trimmed);
  if (normalized && normalized !== trimmed) {
    text.value = normalized;
    emit('update:modelValue', normalized);
    emit('apply', normalized);
  }
}

// ---------------------------------------------------------------- 月历弹层
interface DayCell {
  key: number;
  day: number; // 0 = 占位格（无日期文字）
  disabled: boolean;
  selected: boolean;
  today: boolean;
  style: { backgroundColor: string; color: string };
}

const showPopup = ref(false);
const popupKey = ref(0); // 每次打开递增 → 旧弹层销毁重建（单实例）
const viewYear = ref(2026);
const viewMonth = ref(1);
const selected = ref(''); // 'YYYY-MM-DD' 或 ''
const yearText = ref('2026'); // 对应 Tk var_year
const monthText = ref('01'); // 对应 Tk var_month（'01'..'12'）

const viewLabel = computed(() => `${viewYear.value}-${pad2(viewMonth.value)}`);

/** 打开月历：初始年月来自输入值（无值/非法 → 今天所在月），选中日 = 该日期/今天。 */
function openCalendar(): void {
  const initial = parseDate(text.value) || todayString();
  const [y, m] = initial.split('-').map(Number);
  viewYear.value = y;
  viewMonth.value = m;
  selected.value = initial;
  yearText.value = String(y);
  monthText.value = pad2(m);
  popupKey.value += 1;
  showPopup.value = true;
}

function closePopup(): void {
  showPopup.value = false;
}

/** 跳到指定年月（Tk _goto：年夹 1970..2100、月夹 1..12，并回写年/月输入）。 */
function goto(year: number, month: number): void {
  viewYear.value = clampYear(year);
  viewMonth.value = clampMonth(month);
  yearText.value = String(viewYear.value);
  monthText.value = pad2(viewMonth.value);
}

function prevMonth(): void {
  let y = viewYear.value;
  let m = viewMonth.value - 1;
  if (m < 1) {
    y -= 1;
    m = 12;
  }
  goto(y, m);
}

function nextMonth(): void {
  let y = viewYear.value;
  let m = viewMonth.value + 1;
  if (m > 12) {
    y += 1;
    m = 1;
  }
  goto(y, m);
}

/** 严格整数解析（Python int()：去空白、拒绝 'abc'/'12abc'）。 */
function strictInt(s: string): number | null {
  const t = s.trim();
  return /^[+-]?\d+$/.test(t) ? Number(t) : null;
}

/** 年/月直跳（Tk _on_jump）：任一非法 → 不跳转且不回写输入。 */
function jump(): void {
  const y = strictInt(yearText.value);
  const m = strictInt(monthText.value);
  if (y === null || m === null) return;
  goto(y, m);
}

function onYearInput(e: Event): void {
  yearText.value = (e.target as HTMLInputElement).value;
}

function onMonthChange(e: Event): void {
  monthText.value = (e.target as HTMLSelectElement).value;
  jump();
}

/** 月历格子：周一开头、固定 42 格；格内样式与 Tk _render 一致。 */
const cells = computed<DayCell[]>(() => {
  const y = viewYear.value;
  const m = viewMonth.value;
  const offset = (weekday(y, m, 1) + 6) % 7; // 周一为第 0 列
  const dim = daysInMonth(y, m);
  const today = todayString();
  const out: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const day = i - offset + 1;
    if (day < 1 || day > dim) {
      out.push({
        key: i,
        day: 0,
        disabled: true,
        selected: false,
        today: false,
        style: { backgroundColor: '#ffffff', color: '#bbbbbb' },
      });
      continue;
    }
    const iso = formatDate(y, m, day);
    const isSelected = iso === selected.value;
    const isToday = iso === today;
    const weekend = weekday(y, m, day) === 0 || weekday(y, m, day) === 6;
    let bg = '#ffffff';
    let fg = '#222222';
    if (isSelected) {
      bg = '#1f6feb';
      fg = '#ffffff';
    } else if (isToday) {
      bg = '#e8f0fe';
    }
    if (weekend && !isSelected) fg = '#c0392b';
    out.push({
      key: i,
      day,
      disabled: false,
      selected: isSelected,
      today: isToday,
      style: { backgroundColor: bg, color: fg },
    });
  }
  return out;
});

/** 星期几（0=周日..6=周六）；用 UTC 避免 JS 日期构造的 1900 年映射坑。 */
function weekday(year: number, month: number, day: number): number {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (year >= 0 && year < 100) dt.setUTCFullYear(year);
  return dt.getUTCDay();
}

function onDayClick(cell: DayCell): void {
  if (cell.disabled) return;
  pick(formatDate(viewYear.value, viewMonth.value, cell.day));
}

/** 提交一个值并关闭弹层（Tk _pick/_clear：先回调再 destroy）。 */
function pick(value: string): void {
  text.value = value;
  emit('update:modelValue', value);
  emit('apply', value);
  showPopup.value = false;
}

function pickToday(): void {
  pick(todayString());
}

function clearValue(): void {
  pick('');
}
</script>

<template>
  <div class="datepicker">
    <div class="dp-field">
      <input
        class="dp-input"
        type="text"
        :value="text"
        :placeholder="placeholder"
        @input="onInput"
        @keydown.enter.prevent="onEnter"
        @blur="onBlur"
      />
      <button type="button" class="dp-btn-calendar" title="选择日期" @click="openCalendar">📅</button>
    </div>

    <div
      v-if="showPopup"
      :key="popupKey"
      class="dp-popup"
      role="dialog"
      aria-label="选择日期"
      tabindex="-1"
      @keydown.esc="closePopup"
    >
      <div class="dp-head">
        <button type="button" class="dp-nav dp-prev" aria-label="上一月" @click="prevMonth">◀</button>
        <span class="dp-view-label">{{ viewLabel }}</span>
        <button type="button" class="dp-nav dp-next" aria-label="下一月" @click="nextMonth">▶</button>
        <label class="dp-jump">
          年
          <input
            class="dp-year"
            type="text"
            :value="yearText"
            @input="onYearInput"
            @change="jump"
            @keydown.enter.prevent="jump"
          />
        </label>
        <label class="dp-jump">
          月
          <select class="dp-month" :value="monthText" @change="onMonthChange">
            <option v-for="m in MONTH_OPTIONS" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </div>

      <div class="dp-grid">
        <span v-for="w in WEEK_NAMES" :key="w" class="dp-weekday">{{ w }}</span>
        <button
          v-for="cell in cells"
          :key="cell.key"
          type="button"
          class="dp-day"
          :class="{ 'is-selected': cell.selected, 'is-today': cell.today }"
          :style="cell.style"
          :disabled="cell.disabled"
          :data-day="cell.day > 0 ? String(cell.day) : ''"
          @click="onDayClick(cell)"
        >{{ cell.day > 0 ? cell.day : '' }}</button>
      </div>

      <div class="dp-foot">
        <button type="button" class="dp-foot-btn dp-today" @click="pickToday">今天</button>
        <button type="button" class="dp-foot-btn dp-clear" @click="clearValue">清除</button>
        <button type="button" class="dp-foot-btn dp-foot-close" @click="closePopup">关闭</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.datepicker {
  position: relative;
  display: inline-block;
  font-family: 'Microsoft YaHei', sans-serif;
}

.dp-field {
  display: flex;
  align-items: center;
  gap: 2px;
}

.dp-input {
  width: 110px;
  padding: 3px 6px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  font-size: 13px;
  outline: none;
}

.dp-input:focus {
  border-color: #1f6feb;
}

.dp-btn-calendar {
  padding: 3px 6px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: #f6f8fa;
  cursor: pointer;
  font-size: 13px;
}

.dp-popup {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  padding: 8px;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.dp-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 4px;
}

.dp-nav {
  width: 28px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
}

.dp-view-label {
  width: 66px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
}

.dp-jump {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
  color: #555555;
}

.dp-year {
  width: 52px;
  padding: 2px 4px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  font-size: 12px;
}

.dp-month {
  padding: 2px 2px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  font-size: 12px;
}

.dp-grid {
  display: grid;
  grid-template-columns: repeat(7, 32px);
  gap: 1px;
}

.dp-weekday {
  width: 32px;
  text-align: center;
  font-size: 12px;
  color: #888888;
  padding: 2px 0;
}

.dp-day {
  width: 32px;
  height: 28px;
  border: none;
  border-radius: 4px;
  background: #ffffff;
  color: #222222;
  font-size: 13px;
  cursor: pointer;
}

.dp-day:disabled {
  cursor: default;
}

.dp-day.is-today:not(.is-selected) {
  font-weight: 600;
}

.dp-foot {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.dp-foot-btn {
  padding: 3px 10px;
  border: 1px solid #d0d7de;
  border-radius: 4px;
  background: #f6f8fa;
  font-size: 12px;
  cursor: pointer;
}

.dp-foot-close {
  margin-left: auto;
}
</style>
