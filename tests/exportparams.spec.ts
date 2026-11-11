// #14 导出设置页 · 协议层（docs/02 §1.2/§2 冻结，2026-11-11 实现）：
// 1) TauriIpc.exportMessages 的 invoke 参数组装——camelCase `outPath`、`options` 仅 bundle 带；
// 2) MockIpc bundle 的 mode/new_messages 语义（同 exporter：incremental 且该目录已有数据包）。
import { describe, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  convertFileSrc: (p: string) => p,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { MockIpc } from '@/ipc/mock';
import { TauriIpc } from '@/ipc/tauri';

describe('export_messages 参数组装（docs/02 §2 camelCase）', () => {
  it('bundle 带 options 原样透传，result 的 mode/newMessages 直读', async () => {
    invoke.mockResolvedValue({ path: 'D:/pkg', count: 3, bytes: 9, mode: 'full', newMessages: 3 });
    const ipc = new TauriIpc();
    const options = {
      chats: ['48025936916@chatroom'],
      start_ts: 1793676480,
      end_ts: 1793762879,
      include: ['text', 'image'],
      artifacts: { csv: false },
      incremental: true,
    };
    const r = await ipc.exportMessages({ format: 'bundle', out_path: 'D:/pkg', options });

    expect(invoke).toHaveBeenCalledWith('export_messages', {
      format: 'bundle',
      scope: null, // bundle 不带 scope（docs/02 §1.2）
      outPath: 'D:/pkg',
      options,
    });
    expect(r.mode).toBe('full');
    expect(r.newMessages).toBe(3);
  });

  it('缺省 options → null（= Phase 1 全量）；json/csv 恒不带 options', async () => {
    invoke.mockResolvedValue({ path: 'D:/pkg', count: 1, bytes: 1 });
    const ipc = new TauriIpc();

    await ipc.exportMessages({ format: 'bundle', out_path: 'D:/pkg' });
    expect(invoke.mock.calls.at(-1)![1]).toEqual({
      format: 'bundle', scope: null, outPath: 'D:/pkg', options: null,
    });

    await ipc.exportMessages({
      format: 'json', out_path: 'D:/a.json', scope: { type: 'indexes', indexes: [1, 2] },
    });
    expect(invoke.mock.calls.at(-1)![1]).toEqual({
      format: 'json',
      scope: { type: 'indexes', indexes: [1, 2] },
      outPath: 'D:/a.json',
      options: null,
    });
  });
});

describe('MockIpc bundle mode/new_messages（exporter 语义）', () => {
  it('首跑 full；同目录 + incremental 二跑 incremental；不同目录/不带增量位仍 full', async () => {
    const ipc = new MockIpc({ messageCount: 5 });

    const first = await ipc.exportMessages({
      format: 'bundle', out_path: 'C:/pkg', options: { incremental: true },
    });
    expect(first.mode).toBe('full');
    expect(first.newMessages).toBe(5); // full 的 new_messages = 导出条数（exporter:386）

    const second = await ipc.exportMessages({
      format: 'bundle', out_path: 'C:/pkg', options: { incremental: true },
    });
    expect(second.mode).toBe('incremental');
    expect(second.newMessages).toBe(0); // mock 不造新消息

    const other = await ipc.exportMessages({
      format: 'bundle', out_path: 'C:/pkg2', options: { incremental: true },
    });
    expect(other.mode).toBe('full'); // 无 state 的目录按全量执行

    const noFlag = await ipc.exportMessages({ format: 'bundle', out_path: 'C:/pkg' });
    expect(noFlag.mode).toBe('full'); // incremental=False → 不看 state

    const asJson = await ipc.exportMessages({
      format: 'json', out_path: 'D:/a.json', scope: { type: 'indexes', indexes: [0] },
    });
    expect(asJson.mode).toBeUndefined(); // json/csv result 不带 mode（docs/02 §1.2）
  });
});
