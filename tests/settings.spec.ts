// 应用设置（docs/02 §2 冻结字段 / docs/07 #4）：读写、损坏回退、白名单。
// mock 持久层 = localStorage：跨实例（模拟重开页面）读写即记忆语义，e2e #4 同源。
import { beforeEach, describe, expect, it } from 'vitest';
import { MOCK_SETTINGS_KEY, MockIpc } from '../src/ipc/mock';

describe('settings（docs/07 #4 get_settings/set_settings）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('合并写入 → 新实例读回（跨重开记忆）+ 部分字段不互相覆盖', async () => {
    const first = new MockIpc();
    const written = await first.setSettings({ last_account: 'wxid_mock_beta' });
    expect(written).toEqual({ last_account: 'wxid_mock_beta', last_export_dir: '' });
    expect(first.calls.some((c) => c.method === 'setSettings')).toBe(true);

    const reopened = new MockIpc(); // 模拟重开页面（持久层共享）
    expect((await reopened.getSettings()).last_account).toBe('wxid_mock_beta');
    const merged = await reopened.setSettings({ last_export_dir: 'D:/out' });
    expect(merged).toEqual({ last_account: 'wxid_mock_beta', last_export_dir: 'D:/out' });
  });

  it('损坏的持久层数据 → 回默认不抛错（镜像壳的损坏容忍）', async () => {
    localStorage.setItem(MOCK_SETTINGS_KEY, '{oops not json');
    const ipc = new MockIpc();
    expect(await ipc.getSettings()).toEqual({ last_account: '', last_export_dir: '' });
  });

  it('白名单：未知字段/非字符串 → INTERNAL 且不落盘', async () => {
    const ipc = new MockIpc();
    await ipc.setSettings({ last_account: 'wxid_keep' });
    // 拼写变体 lastAccount（camelCase 陷阱，docs/02 §2 明确要炸出来）
    await expect(ipc.setSettings({ lastAccount: 'x' } as never)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('白名单'),
    });
    await expect(ipc.setSettings({ last_account: 123 } as never)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('字符串'),
    });
    expect((await ipc.getSettings()).last_account).toBe('wxid_keep');
  });
});
