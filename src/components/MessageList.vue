<script setup lang="ts">
// 虚拟滚动消息列表（M-A2 核心）——平铺计划 + 行高缓存 + 可视窗口±overscan，
// 与 Tk gui_chatview._build_plan 同构（docs/01 §3 自研 windowing 决策）。
// M-A3：微信式选区/多选（docs/04 A1 #12–#18/#21/#22）——单气泡原生拖选、
// 拖过气泡转多选、右键菜单、附件单击/拖选区分，逻辑在 state/dragselect.ts。
// M-A3：引用回复（docs/04 A1 #19/#20；docs/01 D5）——引用块渲染 + 单击跳转/闪烁 + 回跳。
// 定位规则（svrid 优先、其次内容匹配，同会话优先、取引用之前最近一条）是纯函数
// logic/quote.ts；本组件只负责手势判定、滚动窗口切换与 CSS 动画类的挂/摘。
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import type { Message, Media } from '../ipc/types';
import { useIpc } from '../ipc/context';
import type { Indexed, PlanEvent } from '../logic/plan';
import { buildPlan } from '../logic/plan';
import {
  findQuoted,
  quoteLabel,
  quoteOf,
  QUOTE_NOT_FOUND_TEXT,
  QUOTE_RETURN_VISIBLE_MS,
  type QuoteBlock,
} from '../logic/quote';
import { typeLabel } from '../logic/typelabels';
import type { SelectionApi } from '../state/store';
import { messageOrder, useDragSelect } from '../state/dragselect';
import ContextMenu from './ContextMenu.vue';
import MediaThumb from './MediaThumb.vue';
import '../styles/bubbles.css';

const ipc = useIpc();

const props = withDefaults(
  defineProps<{
    items: readonly Indexed[];
    messages: readonly Message[];
    groupByChat?: boolean;
    selection: SelectionApi;
    overscan?: number;
  }>(),
  { groupByChat: true, overscan: 6 },
);

const container = ref<HTMLElement | null>(null);
const events = computed<PlanEvent[]>(() => buildPlan(props.items, props.groupByChat));

// ---- 行高：估算起步，渲染后用 offsetHeight 校正（jsdom 实测=0 → 保持估算，确定性）
const heights = ref<number[]>([]);
const offsets = ref<number[]>([0]);
const totalHeight = ref(0);
const start = ref(0);
const end = ref(0);

const VIEWPORT_FALLBACK = 640; // jsdom clientHeight=0 时的视口，保证窗口可测
const RENDER_ALL_LIMIT = 500; // 小列表直接全渲染（A1 #1「30 条全渲染」；11k 才走窗口）

// ---- 微信式选区/多选：手势与右键菜单状态全在 dragselect 组合式里（#12–#18/#21/#22）
const displayOrder = computed(() => messageOrder(events.value));
const shownMessageIndexes = computed(() => {
  const out: number[] = [];
  for (const ev of events.value.slice(start.value, end.value)) if (ev.kind === 'msg') out.push(ev.index);
  return out;
});
const {
  crossSet,
  menuOpen,
  menuX,
  menuY,
  menuItems,
  onMouseDown,
  onContextMenu,
  onMenuSelect,
  onMenuClose,
  consumeDragClick,
} = useDragSelect({
  container,
  selection: props.selection,
  order: () => displayOrder.value,
  shown: () => shownMessageIndexes.value,
  messageAt: (index) => props.messages[index],
});

// ---- 引用跳转 / 闪烁 / 回跳状态（docs/04 A1 #19；docs/01 D5）
// 提示条与「↩ 返回」按钮是 .vlist 内的绝对定位元素（会随内容一起滚），
// 所以用 scrollTopPx 复制一份滚动位置、按 scrollTop + 8px 定位，视觉上固定在容器顶部。
const NOTICE_VISIBLE_MS = 4000; // 找不到原消息提示条的停留时长（自动消失，不挡后续操作）
const scrollTopPx = ref(0);
const flashIndex = ref(-1); // 正在闪烁的消息全量下标；-1 = 无（animationend 摘类，不用定时器）
const notice = ref(''); // 找不到原消息的提示条；空串 = 不显示
const returnPoint = ref<{ scrollTop: number; index: number } | null>(null); // 跳转前位置（回跳用）
const returnVisible = ref(false); // 「↩ 返回」入口在跳转后 QUOTE_RETURN_VISIBLE_MS 内可见
let returnTimer: ReturnType<typeof setTimeout> | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** 小列表全渲染：无窗口裁剪、无估算高度（内容自撑开） */
const renderAll = computed(() => events.value.length <= RENDER_ALL_LIMIT);

/** 文本宽度单位：CJK≈1、ASCII≈0.55（与 Tk 自行换行的量级一致） */
function textUnits(text: string): number {
  let u = 0;
  for (const ch of text) u += ch.charCodeAt(0) > 0x2e7f ? 1 : 0.55;
  return u;
}

function estimate(ev: PlanEvent): number {
  switch (ev.kind) {
    case 'group':
      return 38; // Tk 30px 标题条 + 8px 间距
    case 'day':
      return 24;
    case 'time':
      return 20;
    case 'msg': {
      const m = props.messages[ev.index];
      if (!m) return 60;
      if (m.mtype === 'system') return 28;
      // 引用块占一行；正文按「剥掉引用行后的 body」估（与 Tk 渲染的正文一致）
      const quote = quoteOf(m);
      const units = textUnits((quote ? quote.body : m.text) || m.media.map((x) => x.name).join(' '));
      const lines = Math.max(1, Math.min(14, Math.ceil(units / 44)));
      let h = 10 + 16 + lines * 21; // 行内边距 + 气泡内边距 + 正文行高
      const head = (m.is_group && !m.is_mine) || m.mtype !== 'text';
      if (head) h += 21;
      if (quote) h += 26;
      if (m.media.length) h += 70;
      return h;
    }
  }
}

function recomputeOffsets(): void {
  const n = events.value.length;
  const offs = new Array<number>(n + 1);
  offs[0] = 0;
  for (let i = 0; i < n; i++) offs[i + 1] = offs[i] + (heights.value[i] ?? 60);
  offsets.value = offs;
  totalHeight.value = offs[n] ?? 0;
}

function rebuild(): void {
  const n = events.value.length;
  const hs = new Array<number>(n);
  for (let i = 0; i < n; i++) hs[i] = estimate(events.value[i]);
  heights.value = hs;
  recomputeOffsets();
  updateWindow();
}

/** 最大的 i 满足 offs[i] <= target */
function findIndex(offs: readonly number[], target: number): number {
  let lo = 0;
  let hi = offs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offs[mid] ?? 0) <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function positionWindow(top: number): void {
  if (renderAll.value) {
    start.value = 0;
    end.value = events.value.length;
    return;
  }
  const vh = container.value && container.value.clientHeight > 0 ? container.value.clientHeight : VIEWPORT_FALLBACK;
  const offs = offsets.value;
  const s = findIndex(offs, top);
  const e = findIndex(offs, top + vh);
  start.value = Math.max(0, s - props.overscan);
  end.value = Math.min(events.value.length, e + 1 + props.overscan);
}

function updateWindow(): void {
  positionWindow(container.value?.scrollTop ?? 0);
}

function onScroll(): void {
  scrollTopPx.value = container.value?.scrollTop ?? 0; // 提示条/返回按钮靠它固定在可视区顶部
  updateWindow();
}

function measure(): void {
  const el = container.value;
  if (!el) return;
  let changed = false;
  for (const row of el.querySelectorAll<HTMLElement>('[data-ev]')) {
    const i = Number(row.dataset.ev);
    const h = row.offsetHeight;
    if (h > 0 && heights.value[i] !== undefined && Math.abs((heights.value[i] ?? 0) - h) > 1) {
      heights.value[i] = h;
      changed = true;
    }
  }
  if (changed) {
    recomputeOffsets();
    updateWindow();
  }
}

watch(events, () => rebuild(), { immediate: true });
onMounted(() => updateWindow());
onUpdated(() => measure());

// ---- 消息渲染辅助
function msgAt(index: number): Message {
  return props.messages[index] as Message;
}

function headVisible(m: Message): boolean {
  return (m.is_group && !m.is_mine) || (m.mtype !== 'text' && m.mtype !== 'system');
}

const AVATAR_COLORS = ['#8e8e93', '#a2845e', '#5e8d87', '#7d7fa3', '#b06f8a', '#6f8fa3', '#9a8c5e'];

function avatarChar(m: Message): string {
  const name = m.is_mine ? '我' : m.sender || '?';
  return name.slice(0, 1);
}

function avatarColor(m: Message): string {
  const name = m.is_mine ? '我' : m.sender || '?';
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

async function openMedia(med: Media): Promise<void> {
  if (!med.path) return;
  try {
    await ipc.openPath(med.path);
  } catch {
    /* 打开失败静默（壳会给出 PATH_NOT_ALLOWED 等错误提示） */
  }
}

/** 附件单击打开 vs 按住拖选文件名（A1 #17）：刚拖动过就不打开（同 Tk DRAG_SLOP） */
async function onMediaClick(med: Media): Promise<void> {
  if (consumeDragClick()) return;
  await openMedia(med);
}

// ---- 测试/宿主接口
const renderedCount = computed(() => Math.max(0, end.value - start.value));
const eventCount = computed(() => events.value.length);

function scrollToEvent(i: number): void {
  const el = container.value;
  const target = offsets.value[Math.max(0, Math.min(i, events.value.length))] ?? 0;
  if (el) el.scrollTop = target;
  scrollTopPx.value = el ? el.scrollTop : target; // 浏览器会把 scrollTop 钳到可滚动范围，回读真实值
  positionWindow(target); // 不依赖 scrollTop 回读（jsdom 兼容）
}

function scrollToMessage(fullIndex: number): void {
  const i = events.value.findIndex((ev) => ev.kind === 'msg' && ev.index === fullIndex);
  if (i >= 0) scrollToEvent(i);
}

// ---- 引用块渲染 + 单击跳转 + 回跳（docs/04 A1 #19/#20；docs/01 D5）
// 模板按行调用下面三个辅助（quoteOf 对非引用消息常数时间短路，实际只有可视窗口的行参与渲染）。

/** 该消息的引用块数据；不是引用回复 → null（模板据此 v-if） */
function quoteBlockOf(m: Message): QuoteBlock | null {
  return quoteOf(m);
}

/** 引用块单行文案：`发送者: 内容首行`（超宽省略由 CSS text-overflow 完成） */
function quoteLabelOf(m: Message): string {
  const quote = quoteOf(m);
  return quote ? quoteLabel(quote) : '';
}

/** 气泡正文：引用消息用剥掉拍平引用行后的 body（「正文剥离」），其它消息原样 */
function bodyOf(m: Message): string {
  const quote = quoteOf(m);
  return quote ? quote.body : m.text;
}

/** 当前虚拟列表里实际出现的消息下标集合：引用目标必须在这里面才跳得过去（同 Tk 的 self._messages） */
function shownMessageSet(): Set<number> {
  const set = new Set<number>();
  for (const ev of events.value) if (ev.kind === 'msg') set.add(ev.index);
  return set;
}

function clearNotice(): void {
  notice.value = '';
  if (noticeTimer !== null) {
    clearTimeout(noticeTimer);
    noticeTimer = null;
  }
}

/** 提示条：找不到原消息时显示，NOTICE_VISIBLE_MS 后自动消失（定时器在卸载时清，A1 #10） */
function showNotice(text: string): void {
  clearNotice();
  notice.value = text;
  noticeTimer = setTimeout(() => {
    notice.value = '';
    noticeTimer = null;
  }, NOTICE_VISIBLE_MS);
}

/** 回跳记录：跳转后 QUOTE_RETURN_VISIBLE_MS 内可用「↩ 返回」或 Esc 回到原位置，过期作废（避免误按 Esc 被弹走） */
function showReturn(point: { scrollTop: number; index: number }): void {
  returnPoint.value = point;
  returnVisible.value = true;
  if (returnTimer !== null) clearTimeout(returnTimer);
  returnTimer = setTimeout(() => {
    returnVisible.value = false;
    returnPoint.value = null;
    returnTimer = null;
  }, QUOTE_RETURN_VISIBLE_MS);
}

function clearReturn(): void {
  returnVisible.value = false;
  returnPoint.value = null;
  if (returnTimer !== null) {
    clearTimeout(returnTimer);
    returnTimer = null;
  }
}

/**
 * 单击引用块：定位被引用的原消息 → 虚拟列表滚动到它 → 气泡加 `.flash` 播 CSS 闪烁（A1 #19）。
 * - 定位规则在 logic/quote.ts：先 quote_svrid（同会话优先、取引用之前最近一条），
 *   没有 svrid（导出来源）再按 quote_text 内容匹配（#20）；
 * - 找不到（被筛选过滤 / 内容匹配不上）→ 只出提示条，不滚动不闪烁（同 Tk `_jump_to_quote`）；
 * - 回跳：跳转前记录 scrollTop 与来源消息下标，返回按钮/Esc 用。
 */
async function jumpToQuote(originIndex: number): Promise<boolean> {
  const origin = props.messages[originIndex];
  const quote = origin ? quoteOf(origin) : null;
  if (!quote) return false;
  const target = findQuoted(props.messages, quote, originIndex, { eligible: shownMessageSet() });
  if (target === null) {
    showNotice(QUOTE_NOT_FOUND_TEXT);
    return false;
  }
  showReturn({ scrollTop: container.value?.scrollTop ?? 0, index: originIndex });
  clearNotice();
  scrollToMessage(target);
  // 目标行进入渲染窗口后再挂 .flash；先清一次再挂，重复单击同一条也能重播动画
  await nextTick();
  flashIndex.value = -1;
  await nextTick();
  flashIndex.value = target;
  return true;
}

/**
 * 引用块单击入口：刚拖动过（>4px，复用 dragselect 的 DRAG_SLOP 判定）说明用户在拖选
 * 引用文字，不跳转（A1 #19：Tk 里单击才跳、拖动只选字）。
 */
function onQuoteClick(originIndex: number): void {
  if (consumeDragClick()) return;
  void jumpToQuote(originIndex);
}

/** 闪烁动画结束（animationend）时摘掉 `.flash` —— 不挂定时器，卸载即无残留（A1 #10/#19） */
function onFlashEnd(index: number, event: Event): void {
  if (event.target !== event.currentTarget) return; // 只认气泡自身的动画，忽略子元素冒泡上来的事件
  if (flashIndex.value === index) flashIndex.value = -1;
}

/**
 * 回到跳转前的位置：恢复 scrollTop 并重建渲染窗口（虚拟列表用 scrollTop + 窗口下标定位，
 * 不能只改 DOM，否则目标行可能被窗口裁剪掉）。
 */
function returnToPrevious(): void {
  const point = returnPoint.value;
  if (!point) return;
  const el = container.value;
  if (el) el.scrollTop = point.scrollTop;
  scrollTopPx.value = el ? el.scrollTop : point.scrollTop;
  positionWindow(point.scrollTop); // 不依赖 scrollTop 回读（jsdom 兼容）
  clearReturn();
}

/**
 * Esc 回跳（A1 #19）：只在「没有文字选区 / 没进多选 / 没有右键菜单」时生效，
 * 有选区或多选时让位给 dragselect 的既有 Esc 语义（先清选区、退多选）。
 * 用捕获阶段监听：dragselect 在冒泡阶段会先清掉选区，到这里就判断不出「原本有选区」了。
 */
function onReturnKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  ) {
    return; // 表单里的 Esc 不抢（与 dragselect 一致）
  }
  if (!returnPoint.value || menuOpen.value) return;
  if (props.selection.multi.value) return;
  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (selection && String(selection).length > 0) return; // 有文字选区：先清选区
  returnToPrevious();
}

onMounted(() => {
  window.addEventListener('keydown', onReturnKeydown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onReturnKeydown, true);
  if (returnTimer !== null) clearTimeout(returnTimer);
  if (noticeTimer !== null) clearTimeout(noticeTimer);
});

defineExpose({
  renderedCount,
  eventCount,
  totalHeight,
  windowStart: start,
  windowEnd: end,
  scrollToEvent,
  scrollToMessage,
  scrollTop: scrollTopPx,
  flashIndex,
  notice,
  returnVisible,
  returnPoint,
  jumpToQuote,
  returnToPrevious,
  handleScroll: onScroll,
});
</script>

<template>
  <div
    ref="container"
    class="vlist"
    data-testid="message_view"
    @scroll="onScroll"
    @mousedown="onMouseDown"
    @contextmenu="onContextMenu"
  >
    <!-- 引用跳转提示条（A1 #19）：找不到原消息时出现；绝对定位 + scrollTop 补偿 = 视觉上钉在容器顶部 -->
    <div
      v-if="notice"
      class="quote-notice"
      :style="{ top: `${scrollTopPx + 8}px` }"
      data-testid="quote_notice"
      role="status"
    >
      {{ notice }}
    </div>
    <!-- 回跳入口（A1 #19）：跳转后 3s 内可见，点击回到跳转前的位置；Esc 同效（无选区/多选时） -->
    <button
      v-if="returnVisible"
      type="button"
      class="quote-return"
      :style="{ top: `${scrollTopPx + 8}px` }"
      data-testid="quote_return"
      @click="returnToPrevious"
    >
      ↩ 返回
    </button>
    <div v-if="events.length === 0" class="f-empty" data-testid="empty_state">
      <div class="title">没有匹配的消息</div>
      <div class="hint">换个关键词，或放宽群号 / 日期 / 类型筛选条件。</div>
    </div>
    <div
      v-else
      class="vlist-inner"
      :style="renderAll ? { height: 'auto' } : { height: `${totalHeight}px` }"
    >
      <div class="vspacer" :style="{ height: `${offsets[start] ?? 0}px` }"></div>

      <template v-for="(ev, wi) in events.slice(start, end)" :key="`${start + wi}`">
        <!-- 分组标题条 -->
        <div
          v-if="ev.kind === 'group'"
          class="group-header"
          :data-ev="start + wi"
          data-testid="group_header"
        >
          <span class="name">{{ ev.chat || ev.chat_id || '未知会话' }}</span>
          <span class="meta"
            >{{ ev.is_group ? '群号' : '会话ID' }} {{ ev.chat_id || '—' }} · {{ ev.count }} 条</span
          >
        </div>

        <!-- 日期分隔条 -->
        <div v-else-if="ev.kind === 'day'" class="day-bar" :data-ev="start + wi" data-testid="day_bar">
          {{ ev.text }}
        </div>

        <!-- 时间条 -->
        <div
          v-else-if="ev.kind === 'time' && ev.text"
          class="time-bar"
          :data-ev="start + wi"
          data-testid="time_bar"
        >
          {{ ev.text }}
        </div>

        <!-- 系统消息 -->
        <div
          v-else-if="ev.kind === 'msg' && msgAt(ev.index).mtype === 'system'"
          class="msg-row system"
          :class="{ 'no-sel': !selection.selectable, 'cross-hl': crossSet.has(ev.index) }"
          :data-ev="start + wi"
          :data-index="ev.index"
          data-testid="msg_row"
        >
          <span
            v-if="selection.multi.value"
            class="sel checkbox"
            data-testid="checkbox"
            @click.stop="selection.toggle(ev.index)"
            >{{ selection.isSel(ev.index) ? '☑' : '☐' }}</span
          >
          <span class="system-text">{{ msgAt(ev.index).text }}</span>
        </div>

        <!-- 普通消息 -->
        <div
          v-else-if="ev.kind === 'msg'"
          class="msg-row"
          :class="{
            mine: msgAt(ev.index).is_mine,
            'no-sel': !selection.selectable,
            'cross-hl': crossSet.has(ev.index),
          }"
          :data-ev="start + wi"
          :data-index="ev.index"
          data-testid="msg_row"
        >
          <span
            v-if="selection.multi.value"
            class="sel checkbox"
            data-testid="checkbox"
            @click.stop="selection.toggle(ev.index)"
            >{{ selection.isSel(ev.index) ? '☑' : '☐' }}</span
          >
          <div class="avatar" :style="{ background: avatarColor(msgAt(ev.index)) }">
            {{ avatarChar(msgAt(ev.index)) }}
          </div>
          <div class="msg-body">
            <div v-if="headVisible(msgAt(ev.index))" class="msg-head">
              <span v-if="msgAt(ev.index).is_group && !msgAt(ev.index).is_mine" class="msg-sender">{{
                msgAt(ev.index).sender
              }}</span>
              <span v-if="msgAt(ev.index).mtype !== 'text'" class="msg-type">{{
                typeLabel(msgAt(ev.index).mtype)
              }}</span>
            </div>
            <div
              class="bubble"
              :class="{
                'media-only': !bodyOf(msgAt(ev.index)) && msgAt(ev.index).media.length > 0,
                flash: flashIndex === ev.index,
              }"
              @animationend="onFlashEnd(ev.index, $event)"
            >
              <!-- 引用块（A1 #19）：单行省略；单击跳回原消息（拖动选引用文字不跳，见 onQuoteClick） -->
              <div
                v-if="quoteBlockOf(msgAt(ev.index))"
                class="quote-block"
                data-testid="quote_block"
                :title="quoteLabelOf(msgAt(ev.index))"
                @click="onQuoteClick(ev.index)"
              >
                {{ quoteLabelOf(msgAt(ev.index)) }}
              </div>
              <!-- 正文：引用消息剥掉拍平正文里的引用行（A1 #19「正文剥离」），其余原样 -->
              <p v-if="bodyOf(msgAt(ev.index))" class="text">{{ bodyOf(msgAt(ev.index)) }}</p>
              <div v-if="msgAt(ev.index).media.length" class="media">
                <template v-for="(med, mi) in msgAt(ev.index).media" :key="mi">
                  <!-- 图片：缩略图组件（A1 #9；asset: 协议 + path LRU 缓存都在组件里）；
                       index=消息全量下标，懒解码按它排队 resolve_media（docs/02 §1.2） -->
                  <MediaThumb
                    v-if="med.kind === 'image'"
                    :msg="msgAt(ev.index)"
                    :med="med"
                    :index="ev.index"
                    :guard="consumeDragClick"
                  />
                  <button
                    v-else-if="med.path"
                    type="button"
                    class="file-link"
                    data-testid="media_file"
                    @click.stop="onMediaClick(med)"
                  >
                    📎 {{ med.name }}
                  </button>
                  <span v-else class="missing" data-testid="media_missing"
                    >[文件] {{ med.name }}</span
                  >
                </template>
              </div>
            </div>
          </div>
        </div>
      </template>

      <div
        class="vspacer"
        :style="{ height: `${Math.max(0, totalHeight - (offsets[end] ?? totalHeight))}px` }"
      ></div>
    </div>

    <!-- 右键菜单（A1 #15/#18）：四项文案/可用状态见 dragselect.buildMenuItems -->
    <ContextMenu
      :open="menuOpen"
      :x="menuX"
      :y="menuY"
      :items="menuItems"
      @select="onMenuSelect"
      @close="onMenuClose"
    />
  </div>
</template>
