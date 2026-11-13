// #19 快递单号提取 · 协议层（docs/02 §1.2/§2 增补，2026-11-13 实现）：
// 1) TauriIpc.extractTracking 的 invoke 参数组装——camelCase inPath/outPath/apiKey/
//    provider/baseUrl/model/clearKey，network 默认 false（拍板①：默认纯本地）、
//    apiKey 仅填写时非空；
// 2) MockIpc preflight/run 语义——send_rows 按 network/audit 计算（披露行数断言源）；
// 3) mode=key（2026-11-13 BUG2）——按 provider 分槽保存/清除/查询。
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

describe('extract_tracking 参数组装（docs/02 §2 camelCase）', () => {
  it('preflight：inPath/oldPath 平铺，network 缺省 false，apiKey 未填不传', async () => {
    invoke.mockResolvedValue({
      mode: 'preflight', rows: 10, candidates: 2, reuse_rows: 0,
      batches: 0, send_rows: 0, key_stored: false,
    });
    const ipc = new TauriIpc();
    const r = await ipc.extractTracking({
      mode: 'preflight', in_path: 'D:/a.csv', old_path: 'D:/old.csv',
    });

    expect(invoke).toHaveBeenCalledWith('extract_tracking', {
      mode: 'preflight',
      inPath: 'D:/a.csv',
      oldPath: 'D:/old.csv',
      outPath: null,
      network: false, // 拍板①：默认纯本地
      provider: null, // 2026-11-13 BUG2：缺省交 sidecar 落 mimo 槽（旧口径）
      baseUrl: null,
      model: null,
      clearKey: false,
      apiKey: null,
      audit: true,
      resume: true,
      force: false,
    });
    expect(r.mode).toBe('preflight');
  });

  it('run 联网：outPath/apiKey/network=true/provider 透传', async () => {
    invoke.mockResolvedValue({
      mode: 'run', path: 'D:/out.csv', rows: 10, out_rows: 11,
      with_numbers: 3, numbers: 4, reused_rows: 0, sent_rows: 5,
      tokens: 150, elapsed: 1.2, network: true,
    });
    const ipc = new TauriIpc();
    const r = await ipc.extractTracking({
      mode: 'run', in_path: 'D:/a.csv', out_path: 'D:/out.csv',
      network: true, api_key: 'K-123', audit: false, provider: 'deepseek',
    });

    expect(invoke).toHaveBeenCalledWith('extract_tracking', {
      mode: 'run',
      inPath: 'D:/a.csv',
      oldPath: null,
      outPath: 'D:/out.csv',
      network: true,
      provider: 'deepseek',
      baseUrl: null,
      model: null,
      clearKey: false,
      apiKey: 'K-123',
      audit: false,
      resume: true,
      force: false,
    });
    expect(r.mode).toBe('run');
    if (r.mode === 'run') expect(r.sent_rows).toBe(5);
  });

  it('mode=key：保存带 apiKey、清除带 clearKey，inPath 省略', async () => {
    invoke.mockResolvedValue({ mode: 'key', key_stored: true });
    const ipc = new TauriIpc();
    await ipc.extractTracking({ mode: 'key', provider: 'minimax', api_key: 'K' });
    expect(invoke).toHaveBeenLastCalledWith('extract_tracking', {
      mode: 'key',
      inPath: null,
      oldPath: null,
      outPath: null,
      network: false,
      provider: 'minimax',
      baseUrl: null,
      model: null,
      clearKey: false,
      apiKey: 'K',
      audit: true,
      resume: true,
      force: false,
    });

    invoke.mockResolvedValue({ mode: 'key', key_stored: false });
    await ipc.extractTracking({ mode: 'key', provider: 'minimax', clear_key: true });
    expect(invoke).toHaveBeenLastCalledWith(
      'extract_tracking',
      expect.objectContaining({ mode: 'key', clearKey: true, apiKey: null }),
    );
  });

  it('mode=key + custom：base_url/model 透传', async () => {
    invoke.mockResolvedValue({ mode: 'key', key_stored: true });
    const ipc = new TauriIpc();
    await ipc.extractTracking({
      mode: 'key', provider: 'custom', api_key: 'K',
      base_url: 'https://api.example.com/v1', model: 'my-model',
    });
    expect(invoke).toHaveBeenLastCalledWith(
      'extract_tracking',
      expect.objectContaining({ baseUrl: 'https://api.example.com/v1', model: 'my-model' }),
    );
  });
});

describe('MockIpc extract_tracking 语义', () => {
  it('preflight：本地 send_rows=0；联网+回检 = 候选 42 + 抽样 300 = 342', async () => {
    const ipc = new MockIpc();

    const local = await ipc.extractTracking({ mode: 'preflight', in_path: 'D:/a.csv' });
    expect(local.mode).toBe('preflight');
    if (local.mode === 'preflight') {
      expect(local.send_rows).toBe(0); // 本地不发送（拍板③披露行数）
      expect(local.batches).toBe(0);
      expect(local.key_stored).toBe(false);
    }

    const net = await ipc.extractTracking({
      mode: 'preflight', in_path: 'D:/a.csv', network: true, audit: true,
    });
    expect(net.mode).toBe('preflight');
    if (net.mode === 'preflight') {
      expect(net.send_rows).toBe(342);
      expect(net.batches).toBe(1);
    }

    const netNoAudit = await ipc.extractTracking({
      mode: 'preflight', in_path: 'D:/a.csv', network: true, audit: false,
    });
    expect(netNoAudit.mode).toBe('preflight');
    if (netNoAudit.mode === 'preflight') expect(netNoAudit.send_rows).toBe(42);
  });

  it('run：带 api_key 后 preflight 回 key_stored=true；进 calls 供断言', async () => {
    const ipc = new MockIpc();
    await ipc.extractTracking({
      mode: 'run', in_path: 'D:/a.csv', out_path: 'D:/out.csv',
      network: true, api_key: 'K',
    });
    const pf = await ipc.extractTracking({ mode: 'preflight', in_path: 'D:/a.csv' });
    expect(pf.mode).toBe('preflight');
    if (pf.mode === 'preflight') expect(pf.key_stored).toBe(true);

    const runCall = ipc.calls.find((c) => c.method === 'extractTracking');
    expect(runCall).toBeTruthy();
    expect((runCall!.params as { network: boolean }).network).toBe(true);
  });

  it('错误注入 extractTracking → 抛协议错误', async () => {
    const ipc = new MockIpc({ errors: { extractTracking: 'INTERNAL' } });
    await expect(
      ipc.extractTracking({ mode: 'preflight', in_path: 'D:/a.csv' }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('mode=key（BUG2）：按 provider 分槽保存/查询/清除，互不覆盖', async () => {
    const ipc = new MockIpc();

    // 初始未存
    let r = await ipc.extractTracking({ mode: 'key', provider: 'deepseek' });
    expect(r).toEqual({ mode: 'key', key_stored: false });

    // 保存 deepseek → deepseek 已存、mimo 仍缺
    r = await ipc.extractTracking({ mode: 'key', provider: 'deepseek', api_key: 'K1' });
    expect(r).toEqual({ mode: 'key', key_stored: true });
    const mimo = await ipc.extractTracking({ mode: 'key', provider: 'mimo' });
    expect(mimo).toEqual({ mode: 'key', key_stored: false });

    // 清除 deepseek → 只清本槽
    r = await ipc.extractTracking({ mode: 'key', provider: 'deepseek', clear_key: true });
    expect(r).toEqual({ mode: 'key', key_stored: false });

    // 缺省 provider（旧口径）= mimo 槽
    await ipc.extractTracking({ mode: 'key', api_key: 'K2' });
    const pf = await ipc.extractTracking({ mode: 'preflight', in_path: 'D:/a.csv' });
    expect(pf.mode).toBe('preflight');
    if (pf.mode === 'preflight') expect(pf.key_stored).toBe(true);
  });
});
