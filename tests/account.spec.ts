// 账号选择测试（Phase 2A 缺口：真实壳顶部缺 Tk 版「账号: 下拉 + 刷新账号」）——
// 对应 Tk gui.py：_build_ui 85-96 行（账号栏）、refresh_accounts / _on_account_change
// 217-242 行（扫描/默认第一个/换账号）、325-327 & 345-347 行（未选账号先提示）。
// Web 侧口径：账号栏在 App 顶部（两个标签页共用），状态行走现有 lbl_status/account_status，不弹新组件。
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import App from '@/App.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc, type MockIpcOptions } from '@/ipc/mock';
import type { Account } from '@/ipc/types';

async function mountApp(opts: MockIpcOptions = {}) {
  const ipc = new MockIpc(opts);
  const wrapper = mount(App, {
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
  await flushPromises(); // store.init（appInfo 握手 + 启动扫描账号）
  return { wrapper, ipc };
}

function acc(wxid: string, nickname = wxid): Account {
  return { wxid, nickname, active: 1793600000, root: `C:/mock/xwechat_files/${wxid}` };
}

function status(wrapper: VueWrapper): string {
  return wrapper.find('[data-testid="lbl_status"]').text();
}

function accountStatus(wrapper: VueWrapper): string {
  return wrapper.find('[data-testid="account_status"]').text();
}

function accountOptions(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="cmb_account"]').findAll('option');
}

function selectedAccount(wrapper: VueWrapper): string {
  return (wrapper.find('[data-testid="cmb_account"]').element as HTMLSelectElement).value;
}

function loadDataCalls(ipc: MockIpc): Array<{ method: string; params: unknown }> {
  return ipc.calls.filter((c) => c.method === 'loadData');
}

async function clickLoad(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-testid="btn_load"]').trigger('click');
  await flushPromises();
}

describe('账号栏（Tk refresh_accounts / _on_account_change）', () => {
  it('顶部渲染账号栏：下拉列出账号并默认选中第一个（current(0)），状态行报数量与已选', async () => {
    const { wrapper } = await mountApp();
    expect(wrapper.find('[data-testid="account_bar"]').exists()).toBe(true);

    const options = accountOptions(wrapper);
    expect(options.map((o) => o.attributes('value'))).toEqual([
      'wxid_mock_alpha',
      'wxid_mock_beta',
    ]);
    expect(options[0]!.text()).toBe('wxid_mock_alpha');
    expect(selectedAccount(wrapper)).toBe('wxid_mock_alpha');
    expect(accountStatus(wrapper)).toContain('发现 2 个账号');
    expect(accountStatus(wrapper)).toContain('已选账号：wxid_mock_alpha');

    // 账号栏在标签页之上，且切到管理页仍可见（两个标签页共用）
    await wrapper.find('[data-testid="tab_manage"]').trigger('click');
    expect(wrapper.find('[data-testid="account_bar"]').isVisible()).toBe(true);
  });

  it('昵称非空且不同于 wxid 时显示「昵称 (wxid)」', async () => {
    const { wrapper } = await mountApp({
      accounts: [acc('wxid_zhangsan', '张三'), acc('wxid_lisi')],
    });
    const labels = accountOptions(wrapper).map((o) => o.text());
    expect(labels).toEqual(['张三 (wxid_zhangsan)', 'wxid_lisi']);
  });

  it('刷新账号：再次调用 scanAccounts 并按新结果重建选项（默认选新列表第一个）', async () => {
    const { wrapper, ipc } = await mountApp();
    expect(ipc.calls.filter((c) => c.method === 'scanAccounts')).toHaveLength(1);

    const spy = vi
      .spyOn(ipc, 'scanAccounts')
      .mockResolvedValueOnce({ accounts: [acc('wxid_gamma'), acc('wxid_delta'), acc('wxid_epsilon')] });
    await wrapper.find('[data-testid="btn_refresh_accounts"]').trigger('click');
    await flushPromises();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(accountOptions(wrapper)).toHaveLength(3);
    expect(selectedAccount(wrapper)).toBe('wxid_gamma');
    expect(accountStatus(wrapper)).toContain('发现 3 个账号');
    spy.mockRestore();
  });
});

describe('无账号 / 扫描失败（不白屏，给引导文案）', () => {
  it('没有账号目录：显示 Tk 引导文案，下拉只有占位项', async () => {
    const { wrapper } = await mountApp({ accounts: [] });
    expect(accountStatus(wrapper)).toContain('没有发现微信账号目录，请确认微信已安装并登录');
    expect(accountOptions(wrapper)).toHaveLength(1);
    expect(accountOptions(wrapper)[0]!.text()).toBe('（未发现账号）');
    expect(selectedAccount(wrapper)).toBe('');
  });

  it('扫描失败（注入 NO_ACCOUNT）：账号栏显示错误 message，应用不白屏', async () => {
    const { wrapper } = await mountApp({ errors: { scanAccounts: 'NO_ACCOUNT' } });
    expect(accountStatus(wrapper)).toContain('没有发现微信账号目录');
    expect(wrapper.find('[data-testid="tab_filter"]').exists()).toBe(true);

    // 再点一次刷新仍失败，只更新文案、不抛错白屏
    await wrapper.find('[data-testid="btn_refresh_accounts"]').trigger('click');
    await flushPromises();
    expect(accountStatus(wrapper)).toContain('没有发现微信账号目录');
    expect(wrapper.find('[data-testid="account_bar"]').exists()).toBe(true);
  });

  it('未选账号点「加载/刷新数据」：不调用 loadData，状态行显示「请先选择账号」', async () => {
    const { wrapper, ipc } = await mountApp({ accounts: [] });
    await clickLoad(wrapper);
    expect(status(wrapper)).toContain('请先选择账号');
    expect(loadDataCalls(ipc)).toHaveLength(0);
    // 与 Tk messagebox 同口径：不弹新组件、不白屏
    expect(wrapper.find('[data-testid="tab_filter"]').exists()).toBe(true);
  });
});

describe('加载数据时传 account（docs/02 §2 load_data）', () => {
  it('选中账号后加载：loadData 收到 {kind:"store", account}；切账号后传新 wxid', async () => {
    const { wrapper, ipc } = await mountApp({ messageCount: 6 });
    await clickLoad(wrapper);

    expect(loadDataCalls(ipc)).toHaveLength(1);
    expect(loadDataCalls(ipc)[0]!.params).toMatchObject({
      kind: 'store',
      account: 'wxid_mock_alpha',
    });
    expect(status(wrapper)).toContain('共 6 条消息');

    // 下拉切到第二个账号：旧数据作废（Tk _on_account_change 清空会话列表）
    await wrapper.find('[data-testid="cmb_account"]').setValue('wxid_mock_beta');
    await flushPromises();
    expect(accountStatus(wrapper)).toContain('已选账号：wxid_mock_beta');
    expect(status(wrapper)).not.toContain('共 6 条消息');

    // 重新加载 → 传新的 wxid
    await clickLoad(wrapper);
    const calls = loadDataCalls(ipc);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.params).toMatchObject({ kind: 'store', account: 'wxid_mock_beta' });
    expect(status(wrapper)).toContain('共 6 条消息');
  });
});
