// 本地数据 Phase 2（docs/07 #2 / docs/06 Phase 2）：
// #6 最近数据目录记忆（pickDir 定位 + 打开成功持久化 + 一键回到）
// #7 KEY_NOT_FOUND/NO_ACCOUNT → 状态行「打开本地数据」出口（跳管理页触发选目录）
// #8 数据源信息卡（来源/条数/附件数/导出时间，exported_at 协议键）
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App.vue';
import { IPC_KEY } from '@/ipc/context';
import { MOCK_SETTINGS_KEY, MockIpc, type MockIpcOptions } from '@/ipc/mock';

async function mountApp(opts: MockIpcOptions = {}) {
  const ipc = new MockIpc(opts);
  const wrapper = mount(App, {
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
  await flushPromises();
  return { wrapper, ipc };
}

function managePage(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="page_manage"]');
}

describe('#7 KEY_NOT_FOUND 出口：状态行按钮 → 跳管理页触发选目录', () => {
  it('KEY_NOT_FOUND → 出「打开本地数据」按钮；点击后切页并以 export 来源回读', async () => {
    const { wrapper, ipc } = await mountApp({ errors: { loadData: 'KEY_NOT_FOUND' } });
    await wrapper.find('[data-testid="btn_load"]').trigger('click');
    await flushPromises();

    const status = wrapper.find('[data-testid="lbl_status"]');
    expect(status.text()).toContain('微信刚启动还没解锁');
    const btn = wrapper.find('[data-testid="btn_open_local_error"]');
    expect(btn.exists()).toBe(true);

    // 点击前还在筛选页
    expect(wrapper.find('[data-testid="page_filter"]').isVisible()).toBe(true);

    // 注入错误只挡 store 加载；点出口后 export 回读要能成功（清掉注入模拟「本地数据可用」）
    delete ipc.errors.loadData;
    await btn.trigger('click');
    await flushPromises();

    // 跳到管理页 + 触发了选目录（mock pickDir 固定路径）→ load kind=export
    expect(managePage(wrapper).isVisible()).toBe(true);
    const loads = ipc.calls.filter((c) => c.method === 'loadData');
    expect(loads.some((c) => (c.params as { kind: string }).kind === 'export')).toBe(true);
    // 出口按钮随错误清除而消失
    expect(wrapper.find('[data-testid="btn_open_local_error"]').exists()).toBe(false);
  });

  it('NO_ACCOUNT 同样给出口；非错误码（成功加载）不出现按钮', async () => {
    const { wrapper } = await mountApp({ errors: { loadData: 'NO_ACCOUNT' } });
    await wrapper.find('[data-testid="btn_load"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="btn_open_local_error"]').exists()).toBe(true);

    // 成功路径（无错误注入）→ 无按钮
    const ok = await mountApp({ messageCount: 3 });
    await ok.wrapper.find('[data-testid="btn_load"]').trigger('click');
    await flushPromises();
    expect(ok.wrapper.find('[data-testid="btn_open_local_error"]').exists()).toBe(false);
  });
});

describe('#6 最近本地数据目录记忆', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('打开本地数据成功 → last_export_dir 落盘 + 「打开最近数据」按钮出现且可一键回读', async () => {
    const { wrapper, ipc } = await mountApp();
    // 打开本地数据（mock pickDir 固定 C:/mock/local-data）
    await managePage(wrapper).find('[data-testid="btn_open_local"]').trigger('click');
    await flushPromises();

    // 记忆写入 localStorage（mock 持久层与壳同口径）
    const saved = JSON.parse(localStorage.getItem(MOCK_SETTINGS_KEY) ?? '{}');
    expect(saved.last_export_dir).toBe('C:/mock/local-data');
    expect(ipc.calls.some((c) => c.method === 'setSettings')).toBe(true);

    // 按钮出现（v-if 记忆目录）→ 点击直接回读，不再走选择框
    const recent = managePage(wrapper).find('[data-testid="btn_open_recent"]');
    expect(recent.exists()).toBe(true);
    const before = ipc.calls.filter((c) => c.method === 'loadData').length;
    await recent.trigger('click');
    await flushPromises();
    const loads = ipc.calls.filter((c) => c.method === 'loadData');
    expect(loads.length).toBe(before + 1);
    expect(loads.at(-1)!.params).toEqual({ kind: 'export', out_dir: 'C:/mock/local-data' });
  });

  it('初始无记忆 → 无「打开最近数据」按钮', async () => {
    const { wrapper } = await mountApp();
    expect(managePage(wrapper).find('[data-testid="btn_open_recent"]').exists()).toBe(false);
  });
});

describe('#8 数据源信息卡', () => {
  it('export 来源：来源/条数/附件/导出时间四行齐全', async () => {
    const { wrapper } = await mountApp();
    await managePage(wrapper).find('[data-testid="btn_open_local"]').trigger('click');
    await flushPromises();

    const card = managePage(wrapper).find('[data-testid="source_card"]');
    expect(card.exists()).toBe(true);
    expect(managePage(wrapper).find('[data-testid="card_source"]').text()).toBe('来源：导出目录');
    expect(managePage(wrapper).find('[data-testid="card_count"]').text()).toMatch(/^条数 \d+/);
    expect(managePage(wrapper).find('[data-testid="card_media"]').text()).toMatch(/^附件 \d+/);
    // mock 的 loadData 对 export 来源回 exported_at（与 sidecar 同口径）
    expect(managePage(wrapper).find('[data-testid="card_exported_at"]').text()).toBe(
      '导出于 2026-11-09 21:30:00',
    );
  });

  it('store 来源：有来源/条数/附件，无导出时间行', async () => {
    const { wrapper } = await mountApp({ messageCount: 5 });
    await wrapper.find('[data-testid="btn_load"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="tab_manage"]').trigger('click');

    const card = managePage(wrapper).find('[data-testid="source_card"]');
    expect(card.exists()).toBe(true);
    expect(managePage(wrapper).find('[data-testid="card_source"]').text()).toBe('来源：扫描');
    expect(managePage(wrapper).find('[data-testid="card_exported_at"]').exists()).toBe(false);
  });

  it('未加载 → 无信息卡', async () => {
    const { wrapper } = await mountApp();
    await wrapper.find('[data-testid="tab_manage"]').trigger('click');
    expect(managePage(wrapper).find('[data-testid="source_card"]').exists()).toBe(false);
  });
});
