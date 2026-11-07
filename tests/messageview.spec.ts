// 消息视图组件测试（docs/04 A1 渲染类，M-A2 口径：非手势项）——
// #1 小数据全渲染+勾选隐藏 / #2 空状态 / #3 分组顺序 / #7 虚拟滚动窗口 /
// #9 图片占位 / #5 选择 API / #6 纯浏览模式。
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';
import MessageList from '@/components/MessageList.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';
import { makeMessages } from '@/ipc/fixtures';
import { createSelection } from '@/state/store';
import { filterIndexed } from '@/logic/filter';
import type { Message } from '@/ipc/types';

function mountView(
  messages: Message[],
  opts: { groupByChat?: boolean; selection?: ReturnType<typeof createSelection> } = {},
) {
  const ipc = new MockIpc({ messageCount: 0 });
  const selection = opts.selection ?? createSelection(true);
  const items = filterIndexed(messages, {});
  const wrapper = mount(MessageList, {
    props: { items, messages, groupByChat: opts.groupByChat ?? true, selection },
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
  return { wrapper, selection };
}

function msg(partial: Partial<Message>): Message {
  return {
    ts: 0, day: '2026-10-01', time_text: '09:00:00', chat: '测试群甲',
    chat_id: '111@chatroom', sender: '张三', sender_id: 'wxid_a', is_mine: false,
    mtype: 'text', text: '', truncated: false, is_group: true, local_id: 0,
    server_id: 0, quote_sender: '', quote_text: '', quote_svrid: 0, media: [],
    source: 'store', day_page: '', chat_dir: '',
    ...partial,
  };
}

describe('A1 #1 小数据全渲染（勾选框默认隐藏）', () => {
  it('30 条全部渲染；初始 0 个勾选框；setMulti(true) 后 30 个；无分页栏', async () => {
    const { wrapper, selection } = mountView(makeMessages(30), { groupByChat: false });
    expect(wrapper.findAll('[data-testid="msg_row"]')).toHaveLength(30);
    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('加载更多');

    selection.setMulti(true);
    await nextTick();
    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(30);
    expect(wrapper.find('[data-testid="empty_state"]').exists()).toBe(false);
  });
});

describe('A1 #2 空状态', () => {
  it('显示同文案与引导', () => {
    const { wrapper } = mountView([]);
    const empty = wrapper.find('[data-testid="empty_state"]');
    expect(empty.exists()).toBe(true);
    expect(empty.text()).toContain('没有匹配的消息');
    expect(empty.text()).toContain('换个关键词，或放宽群号 / 日期 / 类型筛选条件。');
    expect(wrapper.findAll('[data-testid="msg_row"]')).toHaveLength(0);
  });
});

describe('A1 #3 分组倒序 / 组内正序 / 组标题字段', () => {
  it('组标题 群号 xxx · N 条，组按最近消息倒序', () => {
    const items = [
      msg({ ts: 100, local_id: 0, chat: '测试群甲', chat_id: '111@chatroom' }),
      msg({ ts: 110, local_id: 1, chat: '测试群甲', chat_id: '111@chatroom' }),
      msg({ ts: 200, local_id: 2, chat: '测试群乙', chat_id: '222@chatroom', day: '2026-10-02' }),
      msg({ ts: 210, local_id: 3, chat: '测试群乙', chat_id: '222@chatroom', day: '2026-10-02' }),
    ];
    const { wrapper } = mountView(items, { groupByChat: true });
    const headers = wrapper.findAll('[data-testid="group_header"]');
    expect(headers).toHaveLength(2);
    expect(headers[0]!.text()).toContain('测试群乙');
    expect(headers[0]!.text()).toContain('群号 222@chatroom · 2 条');
    expect(headers[1]!.text()).toContain('测试群甲');
    expect(headers[1]!.text()).toContain('群号 111@chatroom · 2 条');
    expect(wrapper.findAll('[data-testid="msg_row"]')).toHaveLength(4);
  });

  it('单聊组标题用 会话ID 标签', () => {
    const { wrapper } = mountView([msg({ chat: '张三', chat_id: 'wxid_zs', is_group: false })]);
    expect(wrapper.find('[data-testid="group_header"]').text()).toContain('会话ID wxid_zs · 1 条');
  });
});

describe('A1 #7 虚拟滚动（11k 只渲染可视窗口±overscan）', () => {
  it('11796 条只渲染窗口内行；全量计划完整；可跳转', async () => {
    const messages = makeMessages(11796);
    const { wrapper } = mountView(messages, { groupByChat: true });
    await nextTick();

    const eventCount = wrapper.vm.eventCount as number;
    expect(eventCount).toBeGreaterThan(11796); // 消息 + 分组/日期/时间行
    const rendered = wrapper.findAll('[data-testid="msg_row"]');
    expect(rendered.length).toBeLessThan(100);
    expect(rendered.length).toBeGreaterThan(0);
    expect(wrapper.vm.renderedCount as number).toBeGreaterThanOrEqual(rendered.length);
    expect(wrapper.vm.renderedCount as number).toBeLessThan(eventCount);

    // 跳到第 6000 条（全量下标），该行应进入窗口
    wrapper.vm.scrollToMessage(6000);
    await nextTick();
    const indexes = wrapper
      .findAll('[data-index]')
      .map((el) => Number(el.attributes('data-index')));
    expect(indexes).toContain(6000);
    expect(wrapper.findAll('[data-testid="msg_row"]').length).toBeLessThan(100);
  });

  it('窗口内渲染数随滚动位置变化（滚动确实生效）', async () => {
    const messages = makeMessages(11796);
    const { wrapper } = mountView(messages, { groupByChat: false });
    await nextTick();
    const firstWindow = (wrapper.vm.windowStart as number);
    wrapper.vm.scrollToEvent(8000);
    await nextTick();
    expect(wrapper.vm.windowStart as number).toBeGreaterThan(firstWindow);
  });
});

describe('A1 #9 图片与缺失占位', () => {
  it('缺失图显示 [图片] 文件名 占位；存在图渲染 img', () => {
    const messages = [
      msg({
        ts: 1, mtype: 'image', is_mine: true, sender: '我',
        media: [{ kind: 'image', name: '照片.png', path: 'D:/mock/照片.png', rel_path: '', size: 0, decoded: true }],
      }),
      msg({
        ts: 2, local_id: 1, mtype: 'image', sender: '张三',
        media: [{ kind: 'image', name: '不存在.png', path: '', rel_path: '', size: 0, decoded: false }],
      }),
    ];
    const { wrapper } = mountView(messages, { groupByChat: false });
    const missing = wrapper.findAll('[data-testid="media_missing"]');
    expect(missing).toHaveLength(1);
    expect(missing[0]!.text()).toBe('[图片] 不存在.png');
    expect(wrapper.find('img.thumb').exists()).toBe(true);
    expect(wrapper.find('img.thumb').attributes('src')).toBe('D:/mock/照片.png');
  });
});

describe('A1 #5 选择 API（状态机 + 计数回调）', () => {
  it('toggle/全选/清空/反选/回调序列', () => {
    const sel = createSelection(true);
    const events: number[] = [];
    sel.onSelectionChange((c) => events.push(c));

    expect(sel.count()).toBe(0);
    sel.toggle(0);
    expect(sel.count()).toBe(1);
    expect(sel.indices()).toEqual([0]);
    expect(events).toEqual([1]);
    sel.toggle(0);
    expect(sel.count()).toBe(0);
    expect(events).toEqual([1, 0]);

    sel.selectAll([0, 1, 2]);
    expect(sel.count()).toBe(3);
    expect(sel.multi.value).toBe(true);
    sel.selectNone();
    expect(sel.count()).toBe(0);
    sel.invert([0, 1, 2]);
    expect(sel.count()).toBe(3);
    sel.invert([0, 1, 2]);
    expect(sel.count()).toBe(0);

    sel.selectAll([0, 1, 2]);
    sel.reset(); // 等价 set_messages：清空 + 退多选 + 回调 0
    expect(sel.count()).toBe(0);
    expect(sel.multi.value).toBe(false);
    expect(events[events.length - 1]).toBe(0);
  });

  it('勾选框点击切换对应消息', async () => {
    const { wrapper, selection } = mountView(makeMessages(4), { groupByChat: false });
    selection.setMulti(true);
    await nextTick();
    await wrapper.findAll('[data-testid="checkbox"]')[0]!.trigger('click');
    expect(selection.count()).toBe(1);
    expect(selection.isSel(0)).toBe(true);
    expect(wrapper.findAll('[data-testid="checkbox"]')[0]!.text()).toBe('☑');
  });
});

describe('A1 #6 纯浏览模式（无勾选、选择 API 恒空）', () => {
  it('不渲染勾选框、选择操作全为空操作、消息照常渲染', async () => {
    const events: number[] = [];
    const sel = createSelection(false);
    sel.onSelectionChange((c) => events.push(c));
    const { wrapper } = mountView(makeMessages(10), { selection: sel });

    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(0);
    expect(wrapper.findAll('.msg-row.no-sel').length).toBeGreaterThan(0);

    sel.setMulti(true);
    sel.selectAll([0, 1]);
    sel.invert([0, 1]);
    sel.toggle(0);
    sel.selectNone();
    await nextTick();
    expect(sel.count()).toBe(0);
    expect(sel.multi.value).toBe(false);
    expect(events).toEqual([]);
    expect(wrapper.findAll('[data-testid="msg_row"]')).toHaveLength(10);
    expect(wrapper.findAll('[data-testid="checkbox"]')).toHaveLength(0);
  });
});
