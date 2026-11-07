// 微信式选区/多选（docs/04 A1 #12–#18/#21/#22）——Vitest 只测状态机与纯函数：
// #15/#18 菜单四项状态矩阵（Tk test_context_menu_states）、#13/#14 跨选集合语义、
// #17 复制整条文案、右键菜单组件行为、Esc/点空白/点勾选框与选区的相互影响。
// 真实鼠标拖选与跨气泡手势依赖布局（caretRangeFromPoint），放 e2e/selection.spec.ts。
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import MessageList from '@/components/MessageList.vue';
import ContextMenu from '@/components/ContextMenu.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';
import { filterIndexed } from '@/logic/filter';
import type { Message } from '@/ipc/types';
import { createSelection } from '@/state/store';
import {
  buildMenuItems,
  composeMessageText,
  composeVisibleText,
  crossSelection,
  messageOrder,
  rangeIndexes,
  type MenuItem,
} from '@/state/dragselect';
import type { PlanEvent } from '@/logic/plan';

function msg(partial: Partial<Message>): Message {
  return {
    ts: 0,
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '测试群',
    chat_id: '111@chatroom',
    sender: '张三',
    sender_id: 'wxid_a',
    is_mine: false,
    mtype: 'text',
    text: '',
    truncated: false,
    is_group: true,
    local_id: 0,
    server_id: 0,
    quote_sender: '',
    quote_text: '',
    quote_svrid: 0,
    media: [],
    source: 'store',
    day_page: '',
    chat_dir: '',
    ...partial,
  };
}

const VISIBLE_MESSAGES: Message[] = [
  msg({ ts: 1, local_id: 0, text: '第一条消息甲乙丙丁' }),
  msg({ ts: 2, local_id: 1, text: '第二条消息甲乙丙丁' }),
  msg({ ts: 3, local_id: 2, text: '第三条消息甲乙丙丁' }),
];

function mountView(
  messages: Message[] = VISIBLE_MESSAGES,
  opts: { selection?: ReturnType<typeof createSelection> } = {},
): { wrapper: VueWrapper; selection: ReturnType<typeof createSelection> } {
  const ipc = new MockIpc({ messageCount: 0 });
  const selection = opts.selection ?? createSelection(true);
  const items = filterIndexed(messages, {});
  const wrapper = mount(MessageList, {
    props: { items, messages, groupByChat: false, selection },
    global: { provide: { [IPC_KEY as symbol]: ipc } },
    attachTo: document.body,
  });
  return { wrapper, selection };
}

/** 在元素内造一段原生文字选区（jsdom 有 Selection/Range，没有布局命中测试） */
function selectInside(el: Element): void {
  const node = el.firstChild as Text | null;
  if (!node) throw new Error('元素内没有文本节点');
  const selection = window.getSelection();
  if (!selection) throw new Error('没有 Selection');
  selection.removeAllRanges();
  selection.setBaseAndExtent(node, 0, node, (node.nodeValue ?? '').length);
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

function menuOf(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="ctx_menu"]');
}

function menuStates(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[data-testid="ctx_item"]')
    .map((el) => (el.attributes('aria-disabled') === 'true' ? 'disabled' : 'normal'));
}

function menuLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-testid="ctx_item"]').map((el) => el.text());
}

let mounted: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of mounted) wrapper.unmount();
  mounted = [];
  clearSelection();
});

function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper);
  return wrapper;
}

// ---------------------------------------------------------------- 纯函数

describe('A1 #18 右键菜单四项状态矩阵（Tk test_context_menu_states）', () => {
  it('无选区 + 点在消息上：复制选中文字禁用，其余可用', () => {
    const items = buildMenuItems({
      hasTextSelection: false,
      msgValid: true,
      shownCount: 2,
      selectable: true,
      multi: false,
    });
    expect(items).toHaveLength(4);
    expect(items.map((i) => i.disabled)).toEqual([true, false, false, false]);
    expect(items[0]!.label).toBe('复制选中文字（Ctrl+C）');
    expect(items[1]!.label).toBe('复制整条消息');
    expect(items[2]!.label).toBe('复制全部已显示消息');
    expect(items[3]!.label).toBe('多选（勾选这条消息）');
  });

  it('有选区 + 点在消息上：四项全可用', () => {
    const items = buildMenuItems({
      hasTextSelection: true,
      msgValid: true,
      shownCount: 2,
      selectable: true,
      multi: false,
    });
    expect(items.map((i) => i.disabled)).toEqual([false, false, false, false]);
  });

  it('有选区 + 点在空白处：复制整条消息禁用，其余可用', () => {
    const items = buildMenuItems({
      hasTextSelection: true,
      msgValid: false,
      shownCount: 2,
      selectable: true,
      multi: false,
    });
    expect(items.map((i) => i.disabled)).toEqual([false, true, false, false]);
  });

  it('多选模式：第四项文案改为退出多选；纯浏览视图没有第四项', () => {
    const multi = buildMenuItems({
      hasTextSelection: false,
      msgValid: true,
      shownCount: 2,
      selectable: true,
      multi: true,
    });
    expect(multi[3]!.label).toBe('退出多选（清空选择）');
    expect(multi[3]!.disabled).toBe(false);

    const browse = buildMenuItems({
      hasTextSelection: true,
      msgValid: true,
      shownCount: 2,
      selectable: false,
      multi: false,
    });
    expect(browse.map((i) => i.key)).toEqual(['copy_text', 'copy_message', 'copy_visible']);
  });
});

describe('A1 #13/#14 跨选集合语义（Tk _cross_to / _display_order）', () => {
  const events: PlanEvent[] = [
    { kind: 'group', key: 'k', chat: '群', chat_id: 'c', is_group: true, count: 4 },
    { kind: 'day', text: '2026-10-01 周四' },
    { kind: 'time', text: '09:00' },
    { kind: 'msg', index: 0 },
    { kind: 'msg', index: 1 },
    { kind: 'msg', index: 2 },
    { kind: 'msg', index: 3 },
  ];

  it('显示顺序只取 msg 事件', () => {
    expect(messageOrder(events)).toEqual([0, 1, 2, 3]);
  });

  it('区间含两端、方向无关；端点不在序列里返回空', () => {
    expect(rangeIndexes([0, 1, 2, 3], 1, 3)).toEqual([1, 2, 3]);
    expect(rangeIndexes([0, 1, 2, 3], 3, 1)).toEqual([1, 2, 3]);
    expect(rangeIndexes([0, 1, 2, 3], 7, 1)).toEqual([]);
  });

  it('跨选保留拖动前已勾的；拖回会缩回 | 已勾的保留（#14）', () => {
    const base = new Set([0]);
    expect([...crossSelection([0, 1, 2, 3], 1, 3, base)]).toEqual([0, 1, 2, 3]);
    // 指针从 3 拖回 1：仍保留 base 与区间，不回退成空
    expect([...crossSelection([0, 1, 2, 3], 1, 3, base)]).toEqual([0, 1, 2, 3]);
    // 指针退回起点：区间只剩 1，但 base 的第 0 条仍在
    expect([...crossSelection([0, 1, 2, 3], 1, 1, base)]).toEqual([0, 1]);
  });
});

describe('A1 #17 复制文案（Tk _compose_message_text / copy_all_visible）', () => {
  it('正文 + 附件名；无正文回退类型标签', () => {
    expect(
      composeMessageText(
        msg({
          text: '正文',
          media: [
            { kind: 'file', name: '运单.xlsx', path: 'D:/x.xlsx', rel_path: '', size: 1, decoded: false },
          ],
        }),
      ),
    ).toBe('正文\n运单.xlsx');
    expect(composeMessageText(msg({ text: '', mtype: 'image' }))).toBe('[图片]');
  });

  it('复制全部已显示消息按显示顺序拼接', () => {
    expect(composeVisibleText([0, 1], (i) => VISIBLE_MESSAGES[i])).toBe(
      '第一条消息甲乙丙丁\n第二条消息甲乙丙丁',
    );
  });
});

// ---------------------------------------------------------------- ContextMenu 组件

describe('ContextMenu 组件（#15/#18）', () => {
  const items: MenuItem[] = buildMenuItems({
    hasTextSelection: false,
    msgValid: true,
    shownCount: 3,
    selectable: true,
    multi: false,
  });

  it('按状态渲染四项（禁用项 aria-disabled / 文案逐字对齐 Tk）', () => {
    const wrapper = mount(ContextMenu, {
      props: { open: true, x: 20, y: 30, items },
      attachTo: document.body,
    });
    track(wrapper);
    expect(wrapper.find('[data-testid="ctx_menu"]').attributes('role')).toBe('menu');
    expect(wrapper.find('[data-testid="ctx_menu"]').attributes('style')).toContain('left: 20px');
    expect(wrapper.find('[data-testid="ctx_menu"]').attributes('style')).toContain('top: 30px');
    expect(menuLabels(wrapper)).toEqual([
      '复制选中文字（Ctrl+C）',
      '复制整条消息',
      '复制全部已显示消息',
      '多选（勾选这条消息）',
    ]);
    expect(menuStates(wrapper)).toEqual(['disabled', 'normal', 'normal', 'normal']);
  });

  it('点可用项 emit select 对应 key；禁用项不发事件', async () => {
    const wrapper = mount(ContextMenu, {
      props: { open: true, x: 0, y: 0, items },
      attachTo: document.body,
    });
    track(wrapper);
    await wrapper.findAll('[data-testid="ctx_item"]')[0]!.trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    await wrapper.findAll('[data-testid="ctx_item"]')[1]!.trigger('click');
    expect(wrapper.emitted('select')?.[0]).toEqual(['copy_message']);
  });

  it('点菜单外部关闭；点菜单内部不关闭', async () => {
    const wrapper = mount(ContextMenu, {
      props: { open: true, x: 0, y: 0, items },
      attachTo: document.body,
    });
    track(wrapper);
    wrapper.find('[data-testid="ctx_item"]').element.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true }),
    );
    expect(wrapper.emitted('close')).toBeUndefined();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('open=false 不渲染', () => {
    const wrapper = mount(ContextMenu, {
      props: { open: false, x: 0, y: 0, items },
      attachTo: document.body,
    });
    track(wrapper);
    expect(wrapper.find('[data-testid="ctx_menu"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------- MessageList 集成

describe('A1 #15 右键进/出多选（MessageList 集成）', () => {
  it('右键气泡 → 菜单；点「多选」勾中点着的条；再右键可退出并清空', async () => {
    const { wrapper, selection } = mountView();
    track(wrapper);

    await wrapper.find('.text').trigger('contextmenu', { clientX: 30, clientY: 30 });
    expect(menuOf(wrapper).exists()).toBe(true);
    expect(menuStates(wrapper)).toEqual(['disabled', 'normal', 'normal', 'normal']);

    await wrapper.findAll('[data-testid="ctx_item"]')[3]!.trigger('click');
    await nextTick();
    expect(selection.multi.value).toBe(true);
    expect(selection.indices()).toEqual([0]);
    expect(menuOf(wrapper).exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(VISIBLE_MESSAGES.length);

    await wrapper.findAll('.text')[1]!.trigger('contextmenu', { clientX: 30, clientY: 60 });
    expect(menuLabels(wrapper)[3]).toBe('退出多选（清空选择）');
    await wrapper.findAll('[data-testid="ctx_item"]')[3]!.trigger('click');
    await nextTick();
    expect(selection.multi.value).toBe(false);
    expect(selection.count()).toBe(0);
    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(0);
  });

  it('点外部关闭菜单', async () => {
    const { wrapper } = mountView();
    track(wrapper);
    await wrapper.find('.text').trigger('contextmenu', { clientX: 30, clientY: 30 });
    expect(menuOf(wrapper).exists()).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await nextTick();
    expect(menuOf(wrapper).exists()).toBe(false);
  });

  it('纯浏览视图（selectable=false）右键只有三项', async () => {
    const { wrapper } = mountView(VISIBLE_MESSAGES, { selection: createSelection(false) });
    track(wrapper);
    await wrapper.find('.text').trigger('contextmenu', { clientX: 30, clientY: 30 });
    expect(menuLabels(wrapper)).toEqual([
      '复制选中文字（Ctrl+C）',
      '复制整条消息',
      '复制全部已显示消息',
    ]);
  });
});

describe('A1 #12 点空白/勾选框、Esc 与文字选区', () => {
  it('点空白清除文字选区', async () => {
    const { wrapper } = mountView();
    track(wrapper);
    selectInside(wrapper.find('.text').element);
    expect(String(window.getSelection())).toContain('第一条');

    await wrapper.find('[data-testid="message_view"]').trigger('mousedown', { button: 0 });
    expect(String(window.getSelection())).toBe('');
  });

  it('点勾选框不清文字选区', async () => {
    const { wrapper, selection } = mountView();
    track(wrapper);
    selection.setMulti(true);
    await nextTick();
    selectInside(wrapper.find('.text').element);

    const checkbox = wrapper.findAll('[data-testid="checkbox"]')[1]!;
    await checkbox.trigger('mousedown', { button: 0 });
    expect(String(window.getSelection())).toContain('第一条');

    await checkbox.trigger('click');
    expect(selection.count()).toBe(1);
    expect(String(window.getSelection())).toContain('第一条');
  });

  it('Esc：多选中退出多选并清空；否则清文字选区', async () => {
    const { wrapper, selection } = mountView();
    track(wrapper);

    selectInside(wrapper.find('.text').element);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(String(window.getSelection())).toBe('');
    expect(selection.multi.value).toBe(false);

    selection.setMulti(true);
    selection.toggle(0);
    selectInside(wrapper.find('.text').element);
    await nextTick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(selection.multi.value).toBe(false);
    expect(selection.count()).toBe(0);
    expect(String(window.getSelection())).toBe('');
    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(0);
  });

  it('输入框里的 Esc 不抢（筛选面板等）', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const { wrapper, selection } = mountView();
      track(wrapper);
      selection.setMulti(true);
      selection.toggle(0);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(selection.multi.value).toBe(true);
    } finally {
      input.remove();
    }
  });
});
