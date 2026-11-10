// 启动骨架屏（docs/07 #8，R3 对策补完）：sidecar starting 期内容区占位，
// ready 后切换为真实内容；appInfo 失败不留骨架（错误文案可见，不白屏）。
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import App from '@/App.vue';
import { IPC_KEY } from '@/ipc/context';
import { MockIpc } from '@/ipc/mock';

function mountApp(opts?: ConstructorParameters<typeof MockIpc>[0]) {
  const ipc = new MockIpc(opts);
  const wrapper = mount(App, {
    global: { provide: { [IPC_KEY as symbol]: ipc } },
  });
  return { wrapper, ipc };
}

describe('启动骨架屏（docs/07 #8）', () => {
  it('starting（appInfo 未就绪）→ 骨架可见 + 账号栏灰化 + 标签页未挂载；ready 后切换', async () => {
    const { wrapper } = mountApp();
    // appInfo 的微任务尚未执行 → sidecar 停留初始 starting
    expect(wrapper.find('[data-testid="boot_skeleton"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="account_bar"]').classes()).toContain('boot-dim');
    expect(wrapper.find('[data-testid="page_filter"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="page_manage"]').exists()).toBe(false);

    await flushPromises(); // init：appInfo ready → 切换
    expect(wrapper.find('[data-testid="boot_skeleton"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="account_bar"]').classes()).not.toContain('boot-dim');
    expect(wrapper.find('[data-testid="page_filter"]').exists()).toBe(true);
  });

  it('appInfo 失败 → 不留骨架（错误文案可见、内容区照常渲染，不白屏）', async () => {
    const { wrapper } = mountApp({ errors: { appInfo: 'INTERNAL' } });
    await flushPromises();
    expect(wrapper.find('[data-testid="boot_skeleton"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="page_filter"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="lbl_status"]').text()).toContain('内部错误');
  });
});
