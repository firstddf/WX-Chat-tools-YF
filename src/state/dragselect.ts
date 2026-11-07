// 微信式选区/多选（docs/04 A1 #12–#18/#21/#22）——Tk gui_chatview 的
// _on_press / _on_drag / _on_release / _cross_to / _end_cross / _build_context_menu
// 的 web 移植。文字选区交给浏览器原生 Selection（docs/01 D4：选区限单条，
// 虚拟滚动无副作用）；本模块只负责三件事：
//   1) 把原生选区钳在按下时那一颗气泡内（留白处回落到最近文字，同 _run_in_bubble）；
//   2) 指针跨到其它气泡时作废文字选区、按显示顺序转多选框选（同 _cross_to）；
//   3) 右键菜单四项的文案/可用状态（同 _build_context_menu / test_context_menu_states）。
// 纯函数（buildMenuItems/crossSelection/compose*）不碰 DOM，可在 Vitest 直接断言；
// 手势部分依赖真实布局（caretRangeFromPoint/elementFromPoint），由 Playwright 覆盖。
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue';
import type { Message } from '../ipc/types';
import type { PlanEvent } from '../logic/plan';
import { typeLabel } from '../logic/typelabels';
import type { SelectionApi } from './store';

/** 拖动判定阈值（同 Tk DRAG_SLOP）：小于它仍算单击附件/勾选框 */
export const DRAG_SLOP = 4;

/** 右键菜单项 key */
export type MenuKey = 'copy_text' | 'copy_message' | 'copy_visible' | 'multi_toggle';

export interface MenuItem {
  key: MenuKey;
  label: string;
  disabled: boolean;
}

export interface MenuStateInput {
  hasTextSelection: boolean;
  /** 右键落点是否在一条消息的文字上（Tk _run_at 命中，气泡留白不算） */
  msgValid: boolean;
  /** 当前已显示（渲染窗口内）的消息数 */
  shownCount: number;
  selectable: boolean;
  multi: boolean;
}

/**
 * 右键菜单四项（Tk _build_context_menu）：
 * - 复制选中文字：有文字选区才可用；
 * - 复制整条消息：右键点在消息文字上才可用；
 * - 复制全部已显示消息：有已显示消息就可用；
 * - 多选开关：仅可勾选视图有；多选中显示「退出多选（清空选择）」。
 */
export function buildMenuItems(input: MenuStateInput): MenuItem[] {
  const items: MenuItem[] = [
    { key: 'copy_text', label: '复制选中文字（Ctrl+C）', disabled: !input.hasTextSelection },
    { key: 'copy_message', label: '复制整条消息', disabled: !input.msgValid },
    { key: 'copy_visible', label: '复制全部已显示消息', disabled: input.shownCount <= 0 },
  ];
  if (input.selectable) {
    items.push(
      input.multi
        ? { key: 'multi_toggle', label: '退出多选（清空选择）', disabled: false }
        : { key: 'multi_toggle', label: '多选（勾选这条消息）', disabled: false },
    );
  }
  return items;
}

/** plan 事件 → 消息显示顺序（跨选按这个顺序取区间，同 Tk _display_order） */
export function messageOrder(events: readonly PlanEvent[]): number[] {
  const out: number[] = [];
  for (const ev of events) if (ev.kind === 'msg') out.push(ev.index);
  return out;
}

/** 跨选区间内（含两端）的显示下标；任一端不在显示序列里返回空 */
export function rangeIndexes(
  order: readonly number[],
  anchor: number,
  hover: number,
): number[] {
  const a = order.indexOf(anchor);
  const b = order.indexOf(hover);
  if (a < 0 || b < 0) return [];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** 跨选后的勾选集合 = 拖动前已勾的 ∪ 区间（Tk _cross_to 的 sel0 语义：拖回会缩回） */
export function crossSelection(
  order: readonly number[],
  anchor: number,
  hover: number,
  base: ReadonlySet<number>,
): Set<number> {
  const next = new Set(base);
  for (const i of rangeIndexes(order, anchor, hover)) next.add(i);
  return next;
}

/** 一条消息用于复制的纯文本：正文 + 附件名（同 Tk _compose_message_text） */
export function composeMessageText(m: Message): string {
  const text = (m.text || '').trim();
  const parts: string[] = [];
  if (text) parts.push(text);
  for (const med of m.media || []) {
    const name = (med.name || '').trim();
    if (name && !text.includes(name)) parts.push(name);
  }
  if (parts.length > 0) return parts.join('\n');
  return `[${typeLabel(m.mtype)}]`; // 同 Tk：无正文无附件的兜底
}

/** 按显示顺序拼接若干条消息的纯文本（「复制全部已显示消息」） */
export function composeVisibleText(
  indexes: readonly number[],
  messageAt: (index: number) => Message | undefined,
): string {
  const chunks: string[] = [];
  for (const index of indexes) {
    const m = messageAt(index);
    if (!m) continue;
    const text = composeMessageText(m);
    if (text) chunks.push(text);
  }
  return chunks.join('\n');
}

// ---------------------------------------------------------------- 原生选区/坐标工具

interface CaretPoint {
  node: Node;
  offset: number;
}

/** 气泡内非空白文本节点（按 DOM 顺序；用于留白处回落到最近文字） */
function textNodesIn(root: Node): Text[] {
  const out: Text[] = [];
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if ((text.nodeValue || '').trim()) out.push(text);
  }
  return out;
}

/** 文字节点逐行外框（pre-wrap 的一个文本节点可能有多行 rect） */
function textLineRects(texts: readonly Text[], doc: Document): DOMRect[] {
  const out: DOMRect[] = [];
  for (const text of texts) {
    try {
      const range = doc.createRange();
      range.selectNodeContents(text);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width > 0 || rect.height > 0) out.push(rect);
      }
    } catch {
      /* 排版未就绪时忽略，退回气泡矩形判断 */
    }
  }
  return out;
}

/** 浏览器命中测试：优先 caretRangeFromPoint（Chromium/WebKit），退回 caretPositionFromPoint */
function caretFromPoint(doc: Document, x: number, y: number): CaretPoint | null {
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
  }
  if (typeof doc.caretPositionFromPoint === 'function') {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
  }
  return null;
}

/**
 * 把视口坐标换算成 `el`（气泡）内的文字光标位置。
 *
 * 对应 Tk `_run_in_bubble` + `_offset_at`：气泡内边距/行间空隙里命中不到文字时，
 * 回落到本条消息最近的文字——块下方取最后一行行尾、块上方取第一行行首，
 * 左右留白按最近行处理（caretRangeFromPoint 会给出该行行首/行尾）。
 * 关键在于**永远返回气泡内部**的节点：这样原生选区不会跨出本条消息（A1 #13）。
 */
export function caretInElement(el: HTMLElement, x: number, y: number): CaretPoint | null {
  const doc = el.ownerDocument;
  const texts = textNodesIn(el);
  if (texts.length === 0) return null;
  const first = texts[0] as Text;
  const last = texts[texts.length - 1] as Text;
  const lastOffset = (last.nodeValue || '').length;
  const rect = el.getBoundingClientRect();

  // 用**文字行框**（不是气泡矩形）判断指针是否已经离开正文：
  // 气泡留白/下方行间隙里 caretRangeFromPoint 可能给出整行行首（实测 Chromium 如此），
  // 直接采用会把「拖出气泡」错误地折回起点；Tk _offset_at 也是按文字 bbox 判上下界的。
  const lines = textLineRects(texts, doc);
  const tolerance = 2;
  if (lines.length > 0) {
    const top = Math.min(...lines.map((r) => r.top));
    const bottom = Math.max(...lines.map((r) => r.bottom));
    if (y < top - tolerance) return { node: first, offset: 0 };
    if (y > bottom + tolerance) return { node: last, offset: lastOffset };
  } else {
    if (y <= rect.top + 1) return { node: first, offset: 0 };
    if (y >= rect.bottom - 1) return { node: last, offset: lastOffset };
  }

  const cx = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
  const cy = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
  const hit = caretFromPoint(doc, cx, cy);
  if (hit && el.contains(hit.node)) return hit;
  if (x <= rect.left + 1) return { node: first, offset: 0 };
  // 左右留白但 caret 未命中：按本条末尾处理（拖出气泡 = 选到本条结尾）
  return { node: last, offset: lastOffset };
}

/** 用原生 Selection 表达 [anchor, focus]（方向任意；失败时静默） */
export function setCaretSelection(anchor: CaretPoint, focus: CaretPoint): void {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!sel) return;
  try {
    sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return;
  } catch {
    /* 老引擎退回 Range 路径 */
  }
  try {
    const range = document.createRange();
    const a = anchor.node.ownerDocument?.createRange();
    const f = focus.node.ownerDocument?.createRange();
    if (!a || !f) return;
    a.setStart(anchor.node, anchor.offset);
    f.setStart(focus.node, focus.offset);
    const backward = a.compareBoundaryPoints(Range.START_TO_START, f) > 0;
    const start = backward ? focus : anchor;
    const end = backward ? anchor : focus;
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* 选区不可用：不影响界面（同 Tk 剪贴板失败静默） */
  }
}

function selectedText(): string {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  return sel ? String(sel) : '';
}

function clearNativeSelection(): void {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (sel && sel.rangeCount > 0) sel.removeAllRanges();
}

async function copyText(text: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 非安全上下文/权限拒绝时退回 textarea + execCommand */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  } catch {
    /* 剪贴板不可用：静默（同 Tk _set_clipboard） */
  }
}

// ---------------------------------------------------------------- 手势组合式

export interface DragSelectOptions {
  container: Ref<HTMLElement | null>;
  selection: SelectionApi;
  /** 全量显示顺序（plan 中 msg 事件顺序） */
  order: () => readonly number[];
  /** 当前渲染窗口内的消息下标（「复制全部已显示消息」） */
  shown: () => readonly number[];
  messageAt: (index: number) => Message | undefined;
}

export interface DragSelectApi {
  /** 跨选期间要画蓝色外框的消息下标（松开/退出清空，A1 #14） */
  crossSet: Ref<ReadonlySet<number>>;
  menuOpen: Ref<boolean>;
  menuX: Ref<number>;
  menuY: Ref<number>;
  menuItems: Ref<readonly MenuItem[]>;
  onMouseDown: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
  onMenuSelect: (key: MenuKey) => void;
  onMenuClose: () => void;
  /** 单击附件按钮前调用：刚拖动过返回 true（Tk 用 DRAG_SLOP 区分单击/拖选） */
  consumeDragClick: () => boolean;
  clearTextSelection: () => void;
}

interface DragState {
  anchorMsg: number;
  bubble: HTMLElement;
  anchor: CaretPoint | null;
  /** 本次按下前已勾的集合（跨选保留，Tk _press['sel0']） */
  base: Set<number>;
  startX: number;
  startY: number;
  /** 已转为跨气泡框选（此后不再有文字选区） */
  cross: boolean;
}

const NO_CROSS: ReadonlySet<number> = new Set<number>();

export function useDragSelect(opts: DragSelectOptions): DragSelectApi {
  const { container, selection } = opts;

  const crossSet = ref<ReadonlySet<number>>(NO_CROSS);
  const menuOpen = ref(false);
  const menuX = ref(0);
  const menuY = ref(0);
  const menuItems = ref<readonly MenuItem[]>([]);

  let drag: DragState | null = null;
  let suppressClick = false;
  let menuMsg: number | null = null;
  let menuText = '';

  function closeMenu(): void {
    menuOpen.value = false;
  }

  function rowMessageIndex(el: Element | null): number | null {
    const row = el?.closest('[data-index]') as HTMLElement | null;
    if (!row || !container.value?.contains(row)) return null;
    const index = Number(row.dataset.index);
    return Number.isFinite(index) ? index : null;
  }

  /** 指针下的气泡属于哪条消息；行内头像/头部/行间隙不算（同 Tk _bubble_msg_at） */
  function messageAtPoint(x: number, y: number): number | null {
    const doc = container.value?.ownerDocument;
    if (!doc || typeof doc.elementFromPoint !== 'function') return null;
    const el = doc.elementFromPoint(x, y) as HTMLElement | null;
    const bubble = el?.closest('.bubble') ?? null;
    return rowMessageIndex(bubble);
  }

  /** 把勾选集合改成 desired：只切变化项，保住跨选 base（不整表重算） */
  function applySelected(desired: ReadonlySet<number>): void {
    const current = new Set(selection.selected);
    for (const index of desired) {
      if (!current.has(index)) selection.toggle(index);
    }
    for (const index of current) {
      if (!desired.has(index)) selection.toggle(index);
    }
  }

  function crossTo(anchorMsg: number, hoverMsg: number): void {
    if (!drag) return;
    if (!drag.cross) {
      drag.cross = true;
      drag.anchor = null; // 文字选区作废，后续不再碰原生 Selection
      clearNativeSelection();
    }
    const order = opts.order();
    crossSet.value = new Set(rangeIndexes(order, anchorMsg, hoverMsg));
    applySelected(crossSelection(order, anchorMsg, hoverMsg, drag.base));
  }

  function endCross(): void {
    crossSet.value = NO_CROSS;
    // Tk _end_cross：松开才进入多选（勾选框此时才出现；跨选中只画外框）
    if (selection.selectable && !selection.multi.value) selection.setMulti(true);
  }

  function onMouseDown(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    // 菜单自身：阻止默认行为以保住文字选区，旧菜单等 click 自己关
    if (target.closest('.ctx-menu')) {
      event.preventDefault();
      return;
    }
    if (event.button === 2) {
      // 右键也要保住已有文字选区（A1 #18 第三组）：浏览器默认会把选区折叠掉
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return; // 其它键交给 contextmenu/浏览器
    closeMenu();

    // 勾选框/图片是它们自己的点击交互：保留文字选区（A1 #12；Tk _on_passive_item）
    if (target.closest('.sel') || target.closest('img.thumb')) {
      event.preventDefault();
      return;
    }

    const bubble = target.closest('.bubble') as HTMLElement | null;
    const anchorMsg = bubble ? rowMessageIndex(bubble) : null;
    if (bubble && anchorMsg !== null) {
      // 阻止浏览器默认选区：单条选区由下面的 mousemove 自己钳（A1 #13/#21）
      event.preventDefault();
      clearNativeSelection();
      suppressClick = false;
      drag = {
        anchorMsg,
        bubble,
        anchor: caretInElement(bubble, event.clientX, event.clientY),
        base: new Set(selection.selected),
        startX: event.clientX,
        startY: event.clientY,
        cross: false,
      };
      return;
    }

    // 点空白（含分组头/日期条/头像/发送者）：清除文字选区（A1 #12；Tk _on_press 同）
    clearNativeSelection();
  }

  function onWindowMouseMove(event: MouseEvent): void {
    if (!drag) return;
    if ((event.buttons & 1) === 0) {
      // 指针移出窗口后松开（收不到 mouseup）：下一次进入时按松开收尾，避免选区粘住
      onWindowMouseUp();
      return;
    }
    const dx = Math.abs(event.clientX - drag.startX);
    const dy = Math.abs(event.clientY - drag.startY);
    if (dx + dy > DRAG_SLOP) suppressClick = true;
    const hover = messageAtPoint(event.clientX, event.clientY);
    if (selection.selectable && hover !== null && (drag.cross || hover !== drag.anchorMsg)) {
      crossTo(drag.anchorMsg, hover);
      return;
    }
    if (!drag.anchor) return; // 已转跨选：指针回到间隙/本条时不改框选结果
    const focus = caretInElement(drag.bubble, event.clientX, event.clientY);
    if (focus) setCaretSelection(drag.anchor, focus);
  }

  function onWindowMouseUp(): void {
    if (!drag) return;
    const wasCross = drag.cross;
    drag = null;
    if (wasCross && selection.selectable) endCross();
  }

  function onWindowKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
      return; // 表单里的 Esc 不抢
    }
    if (event.key !== 'Escape') return;
    if (menuOpen.value) {
      closeMenu();
      return;
    }
    if (selection.multi.value) {
      // Tk _on_escape：多选中 Esc = 退出多选并清空勾选
      selection.reset();
      clearNativeSelection();
      return;
    }
    clearNativeSelection();
  }

  function onContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.ctx-menu')) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const row = target.closest('[data-index]') as HTMLElement | null;
    // Tk _run_at 只命中文字项：气泡留白/图片上右键时「复制整条消息」禁用
    const run = target.closest('.text, .quote-block, .file-link, .media .missing');
    const rawMessage = row && run ? rowMessageIndex(row) : null;
    const message = rawMessage !== null ? opts.messageAt(rawMessage) : undefined;
    menuMsg = message && rawMessage !== null ? rawMessage : null;
    menuText = selectedText();
    menuItems.value = buildMenuItems({
      hasTextSelection: menuText.length > 0,
      msgValid: menuMsg !== null,
      shownCount: opts.shown().length,
      selectable: selection.selectable,
      multi: selection.multi.value,
    });

    const width = 210;
    const height = menuItems.value.length * 31 + 10;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    menuX.value = Math.max(4, Math.min(event.clientX, vw - width - 4));
    menuY.value = Math.max(4, Math.min(event.clientY, vh - height - 4));
    menuOpen.value = true;
  }

  function onMenuSelect(key: MenuKey): void {
    switch (key) {
      case 'copy_text':
        void copyText(menuText);
        break;
      case 'copy_message': {
        const message = menuMsg !== null ? opts.messageAt(menuMsg) : undefined;
        if (message) void copyText(composeMessageText(message));
        break;
      }
      case 'copy_visible':
        void copyText(composeVisibleText(opts.shown(), opts.messageAt));
        break;
      case 'multi_toggle':
        if (selection.multi.value) {
          // Tk set_multi_select(False)：退出多选清空勾选 + 清文字高亮
          selection.reset();
          clearNativeSelection();
        } else {
          selection.setMulti(true);
          clearNativeSelection(); // Tk：进入多选行要平移，先清文字高亮
          if (menuMsg !== null && !selection.isSel(menuMsg)) selection.toggle(menuMsg);
        }
        break;
    }
    closeMenu();
  }

  function consumeDragClick(): boolean {
    if (!suppressClick) return false;
    suppressClick = false;
    return true;
  }

  onMounted(() => {
    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    window.addEventListener('keydown', onWindowKeyDown);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onWindowMouseMove);
    window.removeEventListener('mouseup', onWindowMouseUp);
    window.removeEventListener('keydown', onWindowKeyDown);
    drag = null;
  });

  return {
    crossSet,
    menuOpen,
    menuX,
    menuY,
    menuItems,
    onMouseDown,
    onContextMenu,
    onMenuSelect,
    onMenuClose: closeMenu,
    consumeDragClick,
    clearTextSelection: clearNativeSelection,
  };
}
