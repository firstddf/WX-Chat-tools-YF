// 图片懒解码（docs/02 §1.2/§2 `resolve_media`；docs/05 §8.1 P0）——
// store.queueResolveMedia 的完整口径：
//   1) 微任务合批（零定时器：unmount.spec 的 pending timer 归零口径同样适用）；
//   2) 单次 IPC ≤32 个下标，多余下标排队走下一批；
//   3) 同下标 in-flight 去重（同消息多图共用一个下标天然合并）；
//   4) 代际守卫：load() 开始 / discardLoaded()（换账号）时 generation+1，旧代响应丢弃；
//   5) 响应 patch：`data.messages[idx].media = item.media`；
//   6) 仍 decoded=false 的图片记入「解码失败」key → 不再排队（无请求死循环）；
//   7) 错误静默吞掉（不写 data.error、不弹错误条）；
// 外加 Tk 口径：load 成功后状态行立即显示「匹配 N 条」（FilterTab.load_data → apply_filters），
// 以及 MediaThumb 的触发/占位不重试链路。
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import MessageList from '@/components/MessageList.vue';
import { filterIndexed } from '@/logic/filter';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';
import type { Media, ResolveMediaResult } from '@/ipc/types';
import { createSelection, createStore, STORE_KEY, type AppStore } from '@/state/store';

afterEach(() => {
  vi.useRealTimers();
});

function resolveCalls(ipc: MockIpc): Array<{ indexes: number[] }> {
  return ipc.calls
    .filter((c) => c.method === 'resolveMedia')
    .map((c) => c.params as { indexes: number[] });
}

async function makeStore(ipc: MockIpc): Promise<AppStore> {
  const store = createStore(ipc);
  await store.init(); // 握手 + 启动扫描账号
  await store.load({ kind: 'store' });
  return store;
}

/** 排干微任务队列：合批 flush → IPC → 响应 patch 全是微任务链（不依赖任何定时器） */
async function drainMicrotasks(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function image(over: Partial<Media> = {}): Media {
  return { kind: 'image', name: '照片.png', path: '', rel_path: '', size: 0, decoded: false, ...over };
}

/** fixture 只有 i%50===0 才带附件：给指定下标补一张「未解码图片」，让该下标可排队解码 */
function withImages(store: AppStore, indexes: number[]): void {
  for (const i of indexes) store.data.messages[i]!.media = [image()];
}

/** 模拟 sidecar 解码成功：把该下标消息的图片全部回填 decoded+path */
function decodedFor(store: AppStore, indexes: number[]): ResolveMediaResult {
  return {
    items: indexes.map((index) => ({
      index,
      media: store.data.messages[index]!.media.map((m, mi) =>
        m.kind === 'image'
          ? { ...m, decoded: true, path: `D:/cache/decoded/${index}-${mi}.png` }
          : { ...m },
      ),
    })),
  };
}

function mountList(store: AppStore, ipc: MockIpc, withStore = true) {
  const provide: Record<symbol, unknown> = { [IPC_KEY as symbol]: ipc };
  if (withStore) provide[STORE_KEY as symbol] = store;
  return mount(MessageList, {
    props: {
      items: filterIndexed(store.data.messages, {}),
      messages: store.data.messages,
      groupByChat: true,
      selection: createSelection(true),
    },
    global: { provide },
  });
}

describe('懒解码队列 store.queueResolveMedia', () => {
  it('微任务合批：同 tick 40 个下标 → 单次 32 + 8 两批，且全程零定时器', async () => {
    vi.useFakeTimers();
    const ipc = new MockIpc({ messageCount: 60 });
    const store = await makeStore(ipc);
    withImages(store, Array.from({ length: 40 }, (_, i) => i)); // 40 条都带未解码图片
    expect(resolveCalls(ipc)).toHaveLength(0);

    for (let i = 0; i < 40; i++) store.queueResolveMedia(i);
    await drainMicrotasks();

    const batches = resolveCalls(ipc);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.indexes).toHaveLength(32); // 单次 IPC 上限
    expect(batches[0]!.indexes).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(batches[1]!.indexes).toEqual(Array.from({ length: 8 }, (_, i) => i + 32));
    // 合批靠微任务（queueMicrotask），不挂 setTimeout/interval —— pending timer 归零
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('同下标去重：重复排队与在途期间再排都只发一次 IPC', async () => {
    const ipc = new MockIpc({ messageCount: 60 });
    const store = await makeStore(ipc);
    withImages(store, [5, 7]);
    const gate = deferred<ResolveMediaResult>();
    ipc.resolveMediaHook = () => gate.promise;

    store.queueResolveMedia(5);
    store.queueResolveMedia(5);
    store.queueResolveMedia(5);
    store.queueResolveMedia(7);
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);
    expect(resolveCalls(ipc)[0]!.indexes).toEqual([5, 7]);

    // 响应回来之前再排同一个下标：in-flight 去重，不发第二批
    store.queueResolveMedia(5);
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);

    gate.resolve({
      items: [5, 7].map((index) => ({ index, media: [image({ decoded: true, path: `D:/c/${index}.png` })] })),
    });
    await drainMicrotasks();
    expect(store.data.messages[5]!.media[0]!.decoded).toBe(true);
    expect(store.data.messages[7]!.media[0]!.decoded).toBe(true);
    // 解码成功后该消息不再有「未解码且未失败」的图片 → 再排队也不发请求
    store.queueResolveMedia(5);
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);
  });

  it('代际守卫：load() 开始后，旧代响应直接丢弃（不 patch 新消息）', async () => {
    const ipc = new MockIpc({ messageCount: 10 });
    const store = await makeStore(ipc);
    const gate = deferred<ResolveMediaResult>();
    ipc.resolveMediaHook = () => gate.promise;

    store.queueResolveMedia(0); // 旧数据的在途请求
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);

    await store.load({ kind: 'store' }); // 新一代加载（generation+1）
    gate.resolve(decodedFor(store, [0])); // 旧代响应迟到
    await drainMicrotasks();

    expect(store.data.messages[0]!.media[0]!.decoded).toBe(false); // 被丢弃，没 patch 上
  });

  it('代际守卫：discardLoaded（换账号）后，旧代响应直接丢弃', async () => {
    const ipc = new MockIpc({ messageCount: 10 });
    const store = await makeStore(ipc);
    const gate = deferred<ResolveMediaResult>();
    ipc.resolveMediaHook = () => gate.promise;

    store.queueResolveMedia(0);
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);

    store.setAccount('wxid_mock_beta'); // 换账号 → discardLoaded → generation+1
    expect(store.data.loaded).toBe(false);
    await store.load({ kind: 'store' }); // 新数据就位
    gate.resolve(decodedFor(store, [0]));
    await drainMicrotasks();

    expect(store.data.messages[0]!.media[0]!.decoded).toBe(false); // 旧代响应不落新数据
  });

  it('响应 patch：data.messages[idx].media 写回解码结果', async () => {
    const ipc = new MockIpc({ messageCount: 6 });
    const store = await makeStore(ipc);
    expect(store.data.messages[0]!.media[0]!.decoded).toBe(false); // 加载期只定位不解码
    ipc.resolveMediaHook = (indexes) => decodedFor(store, indexes);

    store.queueResolveMedia(0);
    await drainMicrotasks();

    expect(resolveCalls(ipc)).toEqual([{ indexes: [0] }]);
    const med = store.data.messages[0]!.media[0]!;
    expect(med.decoded).toBe(true);
    expect(med.path).toBe('D:/cache/decoded/0-0.png');
  });

  it('解码失败 key：响应仍 decoded=false → isDecodeFailed=true，再次排队不再发请求', async () => {
    const ipc = new MockIpc({ messageCount: 6 }); // 默认 resolveMedia = 原样返回（解不出）
    const store = await makeStore(ipc);

    store.queueResolveMedia(0);
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);

    const msg = store.data.messages[0]!;
    expect(store.isDecodeFailed(msg, 0)).toBe(true); // isDecodeFailed(msg, mi)
    expect(store.isDecodeFailed(msg, 0, 0)).toBe(true); // isDecodeFailed(msg, index, mi)

    // key 命中 → 排队被拦下：没有第二次 IPC（无请求死循环）
    store.queueResolveMedia(0);
    await drainMicrotasks();
    expect(resolveCalls(ipc)).toHaveLength(1);
  });

  it('错误静默：resolveMedia 注入 EXPORTING_BUSY → 调用发出但不写 data.error、不弹错误条', async () => {
    const ipc = new MockIpc({
      messageCount: 6,
      errors: { resolveMedia: 'EXPORTING_BUSY' },
    });
    const store = await makeStore(ipc);

    store.queueResolveMedia(0);
    await drainMicrotasks();

    expect(resolveCalls(ipc)).toHaveLength(1); // 确实发起了请求
    expect(store.data.error).toBeNull(); // 静默吞掉（懒解码失败不打扰用户）
    expect(store.statusText.value).not.toContain('正在加载或导出');
  });
});

describe('加载完成即显示「匹配 N 条」（Tk FilterTab.load_data → apply_filters）', () => {
  it('load 成功 → filterApplied 置位，状态行含「匹配 N 条 · 已选 0 条」', async () => {
    const ipc = new MockIpc({ messageCount: 6 });
    const store = await makeStore(ipc);

    expect(store.data.filterApplied).toBe(true);
    expect(store.statusText.value).toContain('共 6 条消息');
    expect(store.statusText.value).toContain('匹配 6 条 · 已选 0 条');
    expect(store.statusText.value).toContain('来源：扫描');
  });

  it('load 失败（错误路径）→ 不置位，状态行不含「匹配」', async () => {
    const ipc = new MockIpc({ messageCount: 6, errors: { loadData: 'KEY_NOT_FOUND' } });
    const store = createStore(ipc);
    await store.init();
    await store.load({ kind: 'store' });

    expect(store.data.filterApplied).toBe(false);
    expect(store.data.error?.code).toBe('KEY_NOT_FOUND');
    expect(store.statusText.value).not.toContain('匹配');
  });
});

describe('MediaThumb 懒解码触发与占位不重试', () => {
  it('未解码图片 + index + store → 挂载即排队解码，响应回来渲染 <img>', async () => {
    const ipc = new MockIpc({ messageCount: 4 }); // i=0 是 decoded=false 的图片
    const store = await makeStore(ipc);
    ipc.resolveMediaHook = (indexes) => decodedFor(store, indexes);

    const wrapper = mountList(store, ipc);
    await flushPromises();
    await nextTick();

    const calls = resolveCalls(ipc);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.indexes).toEqual([0]); // MessageList 传进来的 ev.index
    expect(wrapper.find('[data-testid="media_thumb_img"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="media_thumb_img"]').attributes('src')).toBe(
      'D:/cache/decoded/0-0.png',
    );
    expect(wrapper.find('[data-testid="media_missing"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('解不出（默认 mock 原样返回）→ 占位保持；key 命中后重建组件也不再发请求', async () => {
    const ipc = new MockIpc({ messageCount: 4 });
    const store = await makeStore(ipc); // 不设 hook：默认原样返回（decoded 仍 false）

    const first = mountList(store, ipc);
    await flushPromises();
    await nextTick();
    expect(resolveCalls(ipc)).toHaveLength(1);
    expect(first.find('[data-testid="media_missing"]').text()).toContain('[图片]');
    expect(first.find('[data-testid="media_thumb_img"]').exists()).toBe(false);
    expect(store.isDecodeFailed(store.data.messages[0]!, 0)).toBe(true);
    first.unmount();

    // 虚拟滚动往返（销毁重建）等价场景：失败 key 命中 → 零新请求
    const second = mountList(store, ipc);
    await flushPromises();
    await nextTick();
    expect(resolveCalls(ipc)).toHaveLength(1);
    expect(second.find('[data-testid="media_missing"]').exists()).toBe(true);
    second.unmount();
  });

  it('无 store provider（MediaThumb 单测环境）→ 不发任何 resolve 请求', async () => {
    const ipc = new MockIpc({ messageCount: 4 });
    const store = await makeStore(ipc);

    const wrapper = mountList(store, ipc, false); // 不 provide STORE_KEY
    await flushPromises();
    await drainMicrotasks();

    expect(resolveCalls(ipc)).toHaveLength(0);
    expect(wrapper.find('[data-testid="media_missing"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
