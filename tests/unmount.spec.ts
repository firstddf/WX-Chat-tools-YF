// A1 #10 组件卸载无泄漏（docs/04 A1 #10）——等价 Tk
// `test_frame_parent_and_destroy_without_tcl_error`：销毁后不能再有残留定时器/全局监听/异常。
//
// MessageList 里真正挂 setTimeout 的只有两处：引用跳转的「↩ 返回」（3s）与
// 「找不到原消息」提示条（4s）；两处都在 onBeforeUnmount 清理。这里先让它们真正挂上，
// 再做滚动/拖动手势，然后 unmount，断言：
//   - fake timers 计数归零（且卸载前确实 >0，证明测的是真清理而不是没挂上）；
//   - clearTimeout 被调用、window 上的 mousemove/mouseup/keydown 监听被摘除；
//   - 全流程 console.error 零输出。
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MessageList from '@/components/MessageList.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';
import { makeMessages } from '@/ipc/fixtures';
import { createSelection } from '@/state/store';
import { filterIndexed } from '@/logic/filter';
import type { Message } from '@/ipc/types';

const COUNT = 200;

/**
 * 200 条确定性 fixture：
 * - 77 号是带 svrid 的引用（能找到 → 挂「返回」定时器）；
 * - 154 号改成找不到的引用（svrid 清零 + 内容不存在 → 挂「提示条」定时器）。
 */
function buildFixture(): Message[] {
  const messages = makeMessages(COUNT);
  const quote = messages[77] as Message;
  messages[77] = { ...quote, quote_text: `消息 ${76}：发`, quote_svrid: (76 * 7 + 1) };
  const missing = messages[154] as Message;
  messages[154] = {
    ...missing,
    quote_sender: '王五',
    quote_text: '完全不存在的引用内容甲乙丙丁戊己庚辛',
    quote_svrid: 0,
  };
  return messages;
}

function mountView(messages: Message[]) {
  const ipc = new MockIpc({ messageCount: 0 });
  const selection = createSelection(true);
  const items = filterIndexed(messages, {});
  return mount(MessageList, {
    props: { items, messages, groupByChat: true, selection },
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
}

interface MessageListExposed {
  jumpToQuote: (originIndex: number) => Promise<boolean>;
  eventCount: number;
}

describe('A1 #10 组件卸载无泄漏（定时器 / 全局监听 / console.error）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('滚动/拖动后卸载：pending timer 全清、window 监听全摘、无 console.error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const messages = buildFixture();
    const wrapper = mountView(messages);
    await nextTick();
    const exposed = wrapper.vm as unknown as MessageListExposed;
    // 小数据量级下 200 条全渲染（无窗口裁剪），跳转目标必然在 eligible 集合里
    expect(exposed.eventCount).toBeGreaterThan(COUNT);

    // 1) 滚动若干次：触发虚滚动窗口重算与提示条/返回按钮的 scrollTop 补偿
    const list = wrapper.get('[data-testid="message_view"]');
    for (const top of [0, 480, 2000, 8000]) {
      (list.element as HTMLElement).scrollTop = top;
      await list.trigger('scroll');
    }
    await nextTick();

    // 2) 拖动手势：气泡按下 → window mousemove/mouseup（dragselect 的全局监听路径）
    const bubble = wrapper.find('.msg-row[data-index] .bubble');
    expect(bubble.exists()).toBe(true);
    expect((bubble.element as HTMLElement).closest('[data-index]')).not.toBeNull();
    await bubble.trigger('mousedown', { button: 0, clientX: 20, clientY: 20 });
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, clientX: 64, clientY: 96 }));
    window.dispatchEvent(new MouseEvent('mouseup'));
    await nextTick();

    // 3) 挂上两个真实定时器：成功跳转（返回入口 3s）+ 找不到（提示条 4s）
    const pendingBefore = vi.getTimerCount();
    await exposed.jumpToQuote(77);
    await nextTick();
    expect(vi.getTimerCount()).toBe(pendingBefore + 1);
    await exposed.jumpToQuote(154);
    await nextTick();
    expect(vi.getTimerCount()).toBe(pendingBefore + 2);

    // 4) 卸载：两个定时器必须全部清掉（Tk 口径：destroy 后无残留 after）
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(clearSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // 5) 全局监听摘除（dragselect 3 个 + MessageList 捕获 keydown + ContextMenu mousedown）
    const removed = removeSpy.mock.calls.map((call) => call[0]);
    expect(removed).toEqual(
      expect.arrayContaining(['mousemove', 'mouseup', 'keydown', 'mousedown']),
    );

    // 6) 全流程无 Vue 运行时错误
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
