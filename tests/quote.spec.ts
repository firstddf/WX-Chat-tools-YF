// 引用回复：引用块 + 单击跳转/闪烁 + 回跳 + 内容匹配定位（docs/04 A1 #19/#20）。
// 分组：
//   #20 纯函数向量 —— quoteOf/quoteLabel/findQuoted 逐字段对齐 Tk gui_chatview
//       `_quote_of` / `_draw_quote` / `_find_quoted`（源用例 tests/test_chatview.py 的
//       test_quote_block_render_and_jump / test_quote_jump_by_content_without_svrid）；
//   #19 组件级交互（jsdom 无布局/动画）—— 单击跳转 → 目标气泡带 .flash、animationend 摘类、
//       拖动选引用文字不跳、找不到出提示条、回跳记录与返回（按钮 + Esc）。
// 真实鼠标手势与 1.4s 动画消失必须在浏览器里跑，见 e2e/quote.spec.ts。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import MessageList from '@/components/MessageList.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';
import { makeMessages } from '@/ipc/fixtures';
import { filterIndexed } from '@/logic/filter';
import type { Indexed } from '@/logic/plan';
import type { Message } from '@/ipc/types';
import {
  findQuoted,
  quoteLabel,
  quoteOf,
  QUOTE_NOT_FOUND_TEXT,
} from '@/logic/quote';
import { createSelection } from '@/state/store';

// Tk 测试里用的同一批原文（逐字对齐，避免「规则一致但向量不同」的自欺欺人）
const ADDR = '门店地址，黑龙江省齐齐哈尔市龙沙区龙沙小区9号楼1单元7门市西龄鸟';
const EXPRESS = '明天下午发顺丰，单号 JT0000000000000';

function msg(partial: Partial<Message> & { ts?: number }): Message {
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

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

// 不显式标注返回类型：让 mount() 的暴露成员类型（defineExpose）进入 wrapper.vm
// （显式 `VueWrapper` 会把 vm 退化成只有 ComponentPublicInstance 基础成员）
function mountView(
  messages: Message[],
  opts: { groupByChat?: boolean; selection?: ReturnType<typeof createSelection>; items?: Indexed[] } = {},
) {
  const ipc = new MockIpc({ messageCount: 0 });
  const selection = opts.selection ?? createSelection(true);
  const items = opts.items ?? filterIndexed(messages, {});
  const wrapper = mount(MessageList, {
    props: { items, messages, groupByChat: opts.groupByChat ?? false, selection },
    global: { provide: { [IPC_KEY as symbol]: ipc } },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return { wrapper, selection };
}

// ================================================================ #20 纯函数：引用块解析

describe('A1 #20 quoteOf：store 结构化字段 + export 拍平正文（Tk _quote_of）', () => {
  it('store 来源：结构化字段优先，正文剥掉引用行', () => {
    const reply = msg({
      ts: 2,
      mtype: 'quote',
      text: `收到，安排\n[引用 遇见] ${ADDR}`,
      quote_sender: '遇见',
      quote_text: ADDR,
      quote_svrid: 123456789,
    });
    const quote = quoteOf(reply);
    expect(quote).not.toBeNull();
    expect(quote!.sender).toBe('遇见');
    expect(quote!.content).toBe(ADDR);
    expect(quote!.svrid).toBe(123456789);
    expect(quote!.body).toBe('收到，安排'); // 正文剥离：气泡只显示回复正文
    expect(quoteLabel(quote!)).toBe(`遇见: ${ADDR}`);
    expect(reply.text).toContain('[引用'); // 原 text 不动（复制整条消息仍是完整拍平文本）
  });

  it('export 来源：没有结构化字段，按拍平正文解析', () => {
    const flat = msg({ ts: 2, mtype: 'quote', text: `回复丙\n[引用 老王] ${EXPRESS}` });
    const quote = quoteOf(flat);
    expect(quote).not.toBeNull();
    expect(quote!.sender).toBe('老王');
    expect(quote!.content).toBe(EXPRESS);
    expect(quote!.svrid).toBe(0);
    expect(quote!.body).toBe('回复丙');
    expect(quoteLabel(quote!)).toBe(`老王: ${EXPRESS}`);
  });

  it('引用内容可跨行：只显示首行文案，content 保留全文', () => {
    const flat = msg({ ts: 3, mtype: 'quote', text: '收到\n[引用 甲] 第一行\n第二行' });
    const quote = quoteOf(flat)!;
    expect(quote.content).toBe('第一行\n第二行');
    expect(quote.body).toBe('收到');
    expect(quoteLabel(quote)).toBe('甲: 第一行');
  });

  it('没有发送者时文案就是内容首行；全空兜底 [引用]', () => {
    const quote = quoteOf(msg({ ts: 4, mtype: 'quote', text: '[引用 ] 只有内容' }))!;
    expect(quote.sender).toBe('');
    expect(quote.content).toBe('只有内容');
    expect(quoteLabel(quote)).toBe('只有内容');
    expect(quoteLabel({ sender: '', content: '', svrid: 0, body: '' })).toBe('[引用]');
  });

  it('回复正文为空（正文只有引用行）时 body 为空串', () => {
    const quote = quoteOf(msg({ ts: 5, mtype: 'quote', text: '[引用 甲] 被引用内容' }))!;
    expect(quote.body).toBe('');
    expect(quote.content).toBe('被引用内容');
  });

  it('不是引用消息返回 null：非 quote 类型且无字段（即使正文里有引用行）', () => {
    expect(quoteOf(msg({ ts: 6, text: `普通消息\n[引用 老王] ${EXPRESS}` }))).toBeNull();
    expect(quoteOf(msg({ ts: 7, text: '普通消息' }))).toBeNull();
  });

  it('quote 类型但字段与正文都解析不出内容 → null（不画空引用块）', () => {
    expect(quoteOf(msg({ ts: 8, mtype: 'quote', text: '只有正文' }))).toBeNull();
    expect(quoteOf(msg({ ts: 9, mtype: 'quote', text: '' }))).toBeNull();
  });
});

// ================================================================ #20 纯函数：定位规则

describe('A1 #20 findQuoted：svrid 优先 / 同会话 / 取引用之前最近一条（Tk _find_quoted）', () => {
  it('store 来源：按 quote_svrid 定位到原消息（Tk test_quote_block_render_and_jump）', () => {
    const original = msg({ ts: 1, text: ADDR, server_id: 123456789 });
    const reply = msg({
      ts: 2,
      mtype: 'quote',
      text: `收到，安排\n[引用 遇见] ${ADDR}`,
      quote_sender: '遇见',
      quote_text: ADDR,
      quote_svrid: 123456789,
    });
    const messages = [original, reply];
    const quote = quoteOf(reply)!;
    expect(findQuoted(messages, quote, 1)).toBe(0);
  });

  it('export 来源无 svrid：按内容匹配到前面的原消息（Tk test_quote_jump_by_content_without_svrid）', () => {
    const original = msg({ ts: 1, text: EXPRESS });
    const reply = msg({ ts: 2, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` });
    const messages = [original, reply];
    expect(findQuoted(messages, quoteOf(reply)!, 1)).toBe(0);
  });

  it('svrid 命中多条：同会话优先，再取引用之前最近的一条', () => {
    const other = msg({ ts: 1, text: '别的会话', chat_id: '222@chatroom', server_id: 42 });
    const same1 = msg({ ts: 2, text: '同会话较早', server_id: 42 });
    const same2 = msg({ ts: 3, text: '同会话最近', server_id: 42 });
    const reply = msg({ ts: 4, mtype: 'quote', text: '回复' });
    const messages = [other, same1, same2, reply];
    // 同会话两条都在引用之前 → 取最近（下标 2），不是别的会话的 0
    expect(findQuoted(messages, { content: '', svrid: 42 }, 3)).toBe(2);
  });

  it('svrid 命中但都在引用之后：取池里最早一条（Tk min(pool)）', () => {
    const reply = msg({ ts: 1, mtype: 'quote', text: '回复' });
    const later1 = msg({ ts: 2, text: '之后一', server_id: 7 });
    const later2 = msg({ ts: 3, text: '之后二', server_id: 7 });
    expect(findQuoted([reply, later1, later2], { content: '', svrid: 7 }, 0)).toBe(1);
  });

  it('svrid 找不到 → 退回内容匹配', () => {
    const original = msg({ ts: 1, text: EXPRESS });
    const reply = msg({ ts: 2, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` });
    expect(findQuoted([original, reply], { content: EXPRESS, svrid: 999999 }, 1)).toBe(0);
  });

  it('内容匹配同样会话优先：同会话更早的一条胜过别的会话更近的一条', () => {
    const sameEarly = msg({ ts: 1, text: EXPRESS }); // 同会话、较早
    const otherNear = msg({ ts: 2, text: EXPRESS, chat_id: '222@chatroom' }); // 别的会话、更近
    const reply = msg({ ts: 3, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` });
    const quote = quoteOf(reply)!;
    expect(findQuoted([sameEarly, otherNear, reply], quote, 2)).toBe(0);
  });

  it('内容匹配都在引用之后：取同会话最早一条', () => {
    const reply = msg({ ts: 1, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` });
    const other = msg({ ts: 2, text: EXPRESS, chat_id: '222@chatroom' });
    const same = msg({ ts: 3, text: EXPRESS });
    expect(findQuoted([reply, other, same], quoteOf(reply)!, 0)).toBe(2);
  });

  it('允许截断匹配：引用内容开头在正文里 / 正文开头在引用内容里', () => {
    const longQuote = msg({ ts: 1, text: `前缀 ${EXPRESS} 后缀` });
    const reply = msg({ ts: 2, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` });
    expect(findQuoted([longQuote, reply], quoteOf(reply)!, 1)).toBe(0);

    const shortText = msg({ ts: 1, text: '明天下午发顺丰' });
    const longContent = msg({
      ts: 2,
      mtype: 'quote',
      text: '好的\n[引用 王五] 明天下午发顺丰，单号 JT0000000000000',
    });
    expect(findQuoted([shortText, longContent], quoteOf(longContent)!, 1)).toBe(0);
  });

  it('内容不足 4 字不匹配；不能定位到引用消息自己', () => {
    const short = msg({ ts: 1, text: '收到' });
    const reply = msg({ ts: 2, mtype: 'quote', text: '好的\n[引用 甲] 收到' });
    expect(findQuoted([short, reply], quoteOf(reply)!, 1)).toBeNull();

    // 只有引用消息自己的拍平正文含该内容 → 跳过自己，无候选
    const self = msg({ ts: 3, mtype: 'quote', text: `好的\n[引用 甲] ${EXPRESS}` });
    expect(findQuoted([self], quoteOf(self)!, 0)).toBeNull();
  });

  it('候选正文不足 4 字跳过（Tk `len(text) < 4`）', () => {
    const tiny = msg({ ts: 1, text: '收到' }); // 太短，即使被引用内容包含它也不当目标
    const reply = msg({ ts: 2, mtype: 'quote', text: `好的\n[引用 甲] ${EXPRESS}` });
    expect(findQuoted([tiny, reply], quoteOf(reply)!, 1)).toBeNull();
  });

  it('originIndex 越界按最后一条处理；空列表返回 null', () => {
    const original = msg({ ts: 1, text: EXPRESS });
    const reply = msg({ ts: 2, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` });
    expect(findQuoted([original, reply], quoteOf(reply)!, 99)).toBe(0);
    expect(findQuoted([], { content: EXPRESS, svrid: 0 }, 0)).toBeNull();
  });

  it('eligible 白名单：目标被筛选过滤掉时不定位（A1 #19「不在当前列表里」）', () => {
    const original = msg({ ts: 1, text: ADDR, server_id: 123456789 });
    const reply = msg({
      ts: 2,
      mtype: 'quote',
      text: `收到\n[引用 遇见] ${ADDR}`,
      quote_sender: '遇见',
      quote_text: ADDR,
      quote_svrid: 123456789,
    });
    expect(findQuoted([original, reply], quoteOf(reply)!, 1, { eligible: new Set([1]) })).toBeNull();
    expect(findQuoted([original, reply], quoteOf(reply)!, 1, { eligible: new Set([0, 1]) })).toBe(0);
  });
});

// ================================================================ #19 组件：渲染/跳转/闪烁

const QUOTE_FIXTURE: Message[] = [
  msg({ ts: 1, text: ADDR, server_id: 123456789 }),
  msg({
    ts: 2,
    mtype: 'quote',
    text: `收到，安排\n[引用 遇见] ${ADDR}`,
    quote_sender: '遇见',
    quote_text: ADDR,
    quote_svrid: 123456789,
  }),
  // 导出来源：没有结构化字段，不指向任何已有消息（找不到 → 提示条）
  msg({ ts: 3, mtype: 'quote', text: `回复丙\n[引用 老王] ${EXPRESS}` }),
];

describe('A1 #19 引用块渲染：单行文案 + 正文剥离', () => {
  it('引用块显示「发送者: 内容」；气泡正文不含 [引用 行', () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const blocks = wrapper.findAll('[data-testid="quote_block"]');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.text()).toBe(`遇见: ${ADDR}`);
    expect(blocks[1]!.text()).toBe(`老王: ${EXPRESS}`);

    const rows = wrapper.findAll('[data-testid="msg_row"]');
    expect(rows[1]!.find('.text').text()).toBe('收到，安排');
    expect(rows[1]!.text()).not.toContain('[引用');
    expect(rows[2]!.find('.text').text()).toBe('回复丙');
    // 单行省略由 CSS 完成（e2e 断言计算样式）
    expect(blocks[0]!.classes()).toContain('quote-block');
  });
});

describe('A1 #19 单击引用块：跳转定位 + .flash 闪烁（animationend 摘类）', () => {
  it('单击 → 目标气泡带 .flash；animationend 后移除；回跳记录已写入', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const blocks = wrapper.findAll('[data-testid="quote_block"]');

    await blocks[0]!.trigger('click');
    await flushPromises();
    await nextTick();

    expect(wrapper.vm.flashIndex as number).toBe(0); // 目标是第 0 条原消息
    const flash = wrapper.find('.bubble.flash');
    expect(flash.exists()).toBe(true);
    const targetRow = wrapper.find('[data-index="0"]');
    expect(targetRow.find('.bubble.flash').exists()).toBe(true);

    // CSS 动画结束（animationend）由组件摘类，不残留定时器
    await flash.trigger('animationend');
    await nextTick();
    expect(wrapper.vm.flashIndex as number).toBe(-1);
    expect(wrapper.find('.bubble.flash').exists()).toBe(false);
  });

  it('无 svrid 按内容匹配跳转（#20 的界面路径）', async () => {
    const messages = [
      msg({ ts: 1, text: EXPRESS }),
      msg({ ts: 2, mtype: 'quote', text: `好的\n[引用 王五] ${EXPRESS}` }),
    ];
    const { wrapper } = mountView(messages);
    await wrapper.find('[data-testid="quote_block"]').trigger('click');
    await flushPromises();
    await nextTick();
    expect(wrapper.vm.flashIndex as number).toBe(0);
  });

  it('重复单击同一条：动画重播（先摘类再挂类）', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const block = wrapper.find('[data-testid="quote_block"]');
    await block.trigger('click');
    await flushPromises();
    await nextTick();
    await wrapper.find('.bubble.flash').trigger('animationend');
    await nextTick();
    expect(wrapper.find('.bubble.flash').exists()).toBe(false);

    await block.trigger('click');
    await flushPromises();
    await nextTick();
    expect(wrapper.vm.flashIndex as number).toBe(0);
    expect(wrapper.find('.bubble.flash').exists()).toBe(true);
  });
});

describe('A1 #19 拖动引用文字不触发跳转（复用 DRAG_SLOP=4 判定）', () => {
  it('按下后移动 >4px 再松手 → 单击不跳转；随后真正的单击仍可跳转', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const rows = wrapper.findAll('[data-testid="msg_row"]');
    const bubble = rows[1]!.find('.bubble');

    // 在引用气泡上按下并拖动（dragselect 记录 suppressClick）
    await bubble.trigger('mousedown', { button: 0, clientX: 20, clientY: 20 });
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 60, clientY: 20 }));
    window.dispatchEvent(new MouseEvent('mouseup', { buttons: 0, clientX: 60, clientY: 20 }));

    await wrapper.find('[data-testid="quote_block"]').trigger('click');
    await flushPromises();
    expect(wrapper.vm.flashIndex as number).toBe(-1);
    expect(wrapper.vm.notice as string).toBe('');

    // 拖动判定是一次性的：没有拖动后的下一次单击照常跳转
    await wrapper.find('[data-testid="quote_block"]').trigger('click');
    await flushPromises();
    await nextTick();
    expect(wrapper.vm.flashIndex as number).toBe(0);
  });
});

describe('A1 #19 找不到原消息：提示条，不滚动不闪烁', () => {
  it('引用指向不存在的消息 → 提示文案（Tk _warn 同文），无 .flash、无回跳记录', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const el = wrapper.find('[data-testid="message_view"]').element as HTMLElement;
    el.scrollTop = 100;

    await wrapper.findAll('[data-testid="quote_block"]')[1]!.trigger('click');
    await flushPromises();

    const notice = wrapper.find('[data-testid="quote_notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toBe(QUOTE_NOT_FOUND_TEXT);
    expect(notice.text()).toContain('没有找到被引用的原消息');
    expect(wrapper.vm.flashIndex as number).toBe(-1);
    expect(wrapper.vm.returnVisible as boolean).toBe(false);
    expect(wrapper.vm.returnPoint as unknown).toBeNull();
    expect(el.scrollTop).toBe(100); // 不滚动
  });

  it('目标被筛选过滤掉（不在当前渲染集合）→ 同样只出提示条', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE, {
      items: [{ index: 1, m: QUOTE_FIXTURE[1]! }], // 视图里只有引用消息，原消息被筛掉
    });
    await wrapper.find('[data-testid="quote_block"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="quote_notice"]').text()).toBe(QUOTE_NOT_FOUND_TEXT);
    expect(wrapper.find('.bubble.flash').exists()).toBe(false);
  });
});

describe('A1 #19 虚拟滚动列表里的跳转（目标不在当前渲染窗口）', () => {
  it('11796 条：滚到引用消息 → 单击 → 目标行切进渲染窗口并带 .flash', async () => {
    const messages = makeMessages(11796);
    const { wrapper } = mountView(messages);
    await nextTick();

    // fixtures 每 77 条一条引用（i%77===0 且 i>0），引用的 svrid 指向前一条
    const quoteIndex = 77;
    expect(messages[quoteIndex]!.quote_svrid).toBe((quoteIndex - 1) * 7 + 1);
    wrapper.vm.scrollToMessage(quoteIndex);
    await nextTick();

    const block = wrapper.find(`[data-index="${quoteIndex}"] [data-testid="quote_block"]`);
    expect(block.exists()).toBe(true);
    await block.trigger('click');
    await flushPromises();
    await nextTick();

    expect(wrapper.vm.flashIndex as number).toBe(quoteIndex - 1);
    // 目标行本来不在渲染窗口里：跳转后应被切进来（虚拟列表 scrollToMessage 生效）
    expect(wrapper.find(`[data-index="${quoteIndex - 1}"] .bubble.flash`).exists()).toBe(true);
  });
});

describe('A1 #19 回跳：记录跳转前位置，返回按钮 / Esc 回到原位置', () => {
  it('跳转后出现「↩ 返回」；点击回到原 scrollTop 并清记录', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const el = wrapper.find('[data-testid="message_view"]').element as HTMLElement;
    el.scrollTop = 240;

    await wrapper.find('[data-testid="quote_block"]').trigger('click');
    await flushPromises();
    await nextTick();

    expect(wrapper.vm.returnVisible as boolean).toBe(true);
    expect(wrapper.vm.returnPoint as unknown).toEqual({ scrollTop: 240, index: 1 });
    const back = wrapper.find('[data-testid="quote_return"]');
    expect(back.exists()).toBe(true);
    expect(back.text()).toContain('返回');

    const jumpedTop = el.scrollTop;
    expect(jumpedTop).not.toBe(240);

    await back.trigger('click');
    await nextTick();
    expect(el.scrollTop).toBe(240);
    expect(wrapper.vm.returnVisible as boolean).toBe(false);
    expect(wrapper.vm.returnPoint as unknown).toBeNull();
  });

  it('Esc 也能回跳（无文字选区/多选时）；有选中文字时不抢 Esc', async () => {
    const { wrapper } = mountView(QUOTE_FIXTURE);
    const el = wrapper.find('[data-testid="message_view"]').element as HTMLElement;

    // 有文字选区：Esc 让位给「清选区」，不回跳
    el.scrollTop = 180;
    await wrapper.find('[data-testid="quote_block"]').trigger('click');
    await flushPromises();
    await nextTick();
    const jumped = el.scrollTop;
    const saved = wrapper.vm.returnPoint as unknown as { scrollTop: number };
    expect(saved.scrollTop).toBe(180);

    const textNode = wrapper.findAll('[data-testid="msg_row"]')[1]!.find('.text').element.firstChild!;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(el.scrollTop).toBe(jumped); // 没回跳
    selection.removeAllRanges();

    // 无选区：Esc 回跳
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(el.scrollTop).toBe(180);
    expect(wrapper.vm.returnVisible as boolean).toBe(false);
  });
});
