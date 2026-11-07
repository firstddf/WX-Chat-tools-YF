// 应用流程测试（docs/04 A2：标签页流程，M-A2 口径）——
// #24 加载+四条件筛选+状态行 / #25 勾选导出参数 / #26 管理页回填群号 /
// #27 会话树浏览复制 / #28 浏览会话 / #29 空数据引导 / #30 加载错误引导。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '@/App.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc, type MockIpcOptions } from '@/ipc/mock';

async function mountApp(opts: MockIpcOptions = {}) {
  const ipc = new MockIpc(opts);
  const wrapper = mount(App, {
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
  await flushPromises(); // store.init（appInfo 握手）
  return { wrapper, ipc };
}

async function load(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-testid="btn_load"]').trigger('click');
  await flushPromises();
}

function status(wrapper: VueWrapper): string {
  return wrapper.find('[data-testid="lbl_status"]').text();
}

describe('A2 #24 加载数据 + 四条件筛选 + 状态行', () => {
  it('共/匹配状态行、会话与类型下拉重建、关键词/群号/类型/日期筛选', async () => {
    const { wrapper } = await mountApp({ messageCount: 6 });
    await load(wrapper);

    expect(status(wrapper)).toContain('共 6 条消息');
    expect(status(wrapper)).toContain('5 个会话');
    // Tk FilterTab.load_data() 末尾 apply_filters()：加载完成即显示「匹配 N 条 · 已选 0 条」
    expect(status(wrapper)).toContain('匹配 6 条 · 已选 0 条');

    // 下拉按数据重建：全部会话/全部类型 在首位
    const chatOptions = wrapper.find('[data-testid="cmb_chat"]').findAll('option');
    expect(chatOptions).toHaveLength(6); // 5 会话 + 全部
    expect(chatOptions[0]!.text()).toBe('全部会话');
    const typeOptions = wrapper.find('[data-testid="cmb_type"]').findAll('option');
    expect(typeOptions[0]!.text()).toBe('全部类型');
    expect(typeOptions.length).toBeGreaterThan(1);

    // 关键词（空格分词 AND）
    const q = wrapper.find('[data-testid="entry_query"]');
    await q.setValue('报价');
    await q.trigger('keydown.enter');
    expect(status(wrapper)).toContain('匹配 1 条'); // 6 条中只有 i=0 含「报价」
    await q.setValue('');
    await q.trigger('keydown.enter');
    expect(status(wrapper)).toContain('匹配 6 条');

    // 群号/会话ID
    const c = wrapper.find('[data-testid="entry_chat"]');
    await c.setValue('110223344');
    await c.trigger('keydown.enter');
    expect(status(wrapper)).toContain('匹配 1 条'); // 产品讨论群 1 条
    await c.setValue('');
    await c.trigger('keydown.enter');
    expect(status(wrapper)).toContain('匹配 6 条');

    // 类型（i=1 是 image）
    await wrapper.find('[data-testid="cmb_type"]').setValue('image');
    expect(status(wrapper)).toContain('匹配 1 条');
    await wrapper.find('[data-testid="cmb_type"]').setValue('');
    expect(status(wrapper)).toContain('匹配 6 条');

    // 快捷日期：今天（合成数据在 10 月）→ 0 匹配
    await wrapper.find('[data-quick="today"]').trigger('click');
    expect(status(wrapper)).toContain('匹配 0 条');

    // 重置恢复
    await wrapper.find('[data-testid="btn_reset"]').trigger('click');
    expect(status(wrapper)).toContain('匹配 6 条');
  });
});

describe('A2 #25 勾选 + 导出（mock 对话框）', () => {
  it('无选中导出警告；全选后导出参数 scope.indexes 与选中一致', async () => {
    const { wrapper, ipc } = await mountApp({ messageCount: 6 });
    await load(wrapper);

    // 未选中 → 警告且不产生导出调用
    await wrapper.find('[data-testid="btn_json"]').trigger('click');
    await flushPromises();
    expect(status(wrapper)).toContain('请先勾选要导出的消息');
    expect(ipc.calls.filter((c) => c.method === 'exportMessages')).toHaveLength(0);

    // 全选 → 导出选中 JSON
    await wrapper.find('[data-testid="btn_select_all"]').trigger('click');
    await wrapper.find('[data-testid="btn_json"]').trigger('click');
    await flushPromises();
    const call = ipc.calls.find((c) => c.method === 'exportMessages');
    expect(call).toBeTruthy();
    const params = call!.params as { format: string; scope: { type: string; indexes: number[] }; out_path: string };
    expect(params.format).toBe('json');
    expect(params.scope.type).toBe('indexes');
    expect(params.scope.indexes).toEqual([0, 1, 2, 3, 4, 5]);
    expect(params.out_path).toBe('选中.json');
    expect(status(wrapper)).toContain('已导出 6 条');

    // 全部匹配 CSV → scope.filter 与当前筛选一致
    await wrapper.find('[data-testid="btn_all_csv"]').trigger('click');
    await flushPromises();
    const all = ipc.calls.filter((c) => c.method === 'exportMessages').at(-1)!;
    const p2 = all.params as { format: string; scope: { type: string; filter: { query: string } }; out_path: string };
    expect(p2.format).toBe('csv');
    expect(p2.scope.type).toBe('filter');
    expect(p2.out_path).toBe('全部匹配.csv');
  });
});

describe('A2 #26 管理页 → 筛选页预填群号', () => {
  it('在筛选中查找：切页 + entry_chat 预填 + 结果只剩该会话', async () => {
    const { wrapper } = await mountApp({ messageCount: 6 });
    await load(wrapper);
    await wrapper.find('[data-testid="tab_manage"]').trigger('click');

    const row = wrapper
      .findAll('[data-testid="chat_row"]')
      .find((r) => r.text().includes('产品讨论群'));
    expect(row, '会话树应有「产品讨论群」').toBeTruthy();
    await row!.trigger('click');
    await wrapper.find('[data-testid="btn_to_filter"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="page_filter"]').isVisible()).toBe(true);
    expect((wrapper.find('[data-testid="entry_chat"]').element as HTMLInputElement).value).toBe(
      '110223344@chatroom',
    );
    expect(status(wrapper)).toContain('匹配 1 条');
  });
});

describe('A2 #27/#28 管理会话树与浏览', () => {
  it('树行数/汇总/搜索过滤/复制群号', async () => {
    const { wrapper } = await mountApp({ messageCount: 6 });
    await load(wrapper);
    await wrapper.find('[data-testid="tab_manage"]').trigger('click');

    const rows = () => wrapper.findAll('[data-testid="chat_row"]');
    expect(rows()).toHaveLength(5);
    const summary = wrapper.find('[data-testid="lbl_summary"]').text();
    expect(summary).toContain('5');
    expect(summary).toContain('6');

    // 搜索过滤
    const search = wrapper.find('[data-testid="entry_search"]');
    await search.setValue('产品');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.text()).toContain('产品讨论群');
    await search.setValue('');
    expect(rows()).toHaveLength(5);

    // 选行 + 复制群号（不抛错，给出回执）
    await rows()[0]!.trigger('click');
    await wrapper.find('[data-testid="btn_copy_id"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="manage_notice"]').text()).toMatch(/已复制|群号/);
  });

  it('浏览会话：消息视图只显示该会话（纯浏览无勾选）', async () => {
    const { wrapper } = await mountApp({ messageCount: 6 });
    await load(wrapper);
    await wrapper.find('[data-testid="tab_manage"]').trigger('click');

    const row = wrapper
      .findAll('[data-testid="chat_row"]')
      .find((r) => r.text().includes('产品讨论群'));
    await row!.trigger('click');
    await wrapper.find('[data-testid="btn_browse"]').trigger('click');
    await flushPromises();

    const browseRows = wrapper.findAll('.browse-pane [data-testid="msg_row"]');
    expect(browseRows).toHaveLength(1); // 产品讨论群 1 条
    expect(browseRows[0]!.text()).toContain('消息 2：');
    expect(wrapper.findAll('.browse-pane [data-testid="checkbox"]')).toHaveLength(0);
  });
});

describe('A2 #29/#30 空数据与加载错误引导（不白屏）', () => {
  it('空数据显示引导文案（两个标签页）', async () => {
    const { wrapper } = await mountApp({ messageCount: 0 });
    await load(wrapper);
    expect(status(wrapper)).toContain('没有可用的聊天数据');
    expect(status(wrapper)).toContain('扫描会话');

    await wrapper.find('[data-testid="tab_manage"]').trigger('click');
    const summary = wrapper.find('[data-testid="lbl_summary"]').text();
    expect(summary).toContain('没有可用的聊天数据');
  });

  it('注入 KEY_NOT_FOUND：展示中文文案、应用不白屏', async () => {
    const { wrapper } = await mountApp({ messageCount: 6, errors: { loadData: 'KEY_NOT_FOUND' } });
    await load(wrapper);
    expect(status(wrapper)).toContain('微信刚启动还没解锁');
    expect(wrapper.find('[data-testid="tab_filter"]').exists()).toBe(true);

    await wrapper.find('[data-testid="tab_manage"]').trigger('click');
    expect(wrapper.find('[data-testid="lbl_summary"]').text()).toContain('微信刚启动还没解锁');
  });
});

describe('sidecar 状态横幅（docs/02 §3）', () => {
  it('failed 时显示降级横幅，ready 时无横幅', async () => {
    const { wrapper, ipc } = await mountApp();
    expect(wrapper.find('[data-testid="sidecar_banner"]').exists()).toBe(false);
    ipc.emitSidecarStatus({ state: 'failed', detail: 'crashed' });
    await flushPromises();
    const banner = wrapper.find('[data-testid="sidecar_banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain('sidecar');
    ipc.emitSidecarStatus({ state: 'ready' });
    await flushPromises();
    expect(wrapper.find('[data-testid="sidecar_banner"]').exists()).toBe(false);
  });
});
