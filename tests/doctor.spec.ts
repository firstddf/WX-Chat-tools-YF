// 数据层自检 doctor（docs/02 §1.2 冻结形状 / docs/07 #3）：mock 结果形状 + 错误注入。
// 管理页面板的渲染断言在 e2e/tabs.spec.ts（真浏览器点击流程）。
import { describe, expect, it } from 'vitest';
import { MockIpc } from '../src/ipc/mock';

describe('doctor（docs/07 #3 数据层自检）', () => {
  it('返回冻结形状（顶层五键 / key_sources 五键 / dbs 两键）并进 calls 录制', async () => {
    const ipc = new MockIpc();
    const r = await ipc.doctor();
    expect(Object.keys(r).sort()).toEqual(['account', 'dbs', 'key_sources', 'messages', 'version']);
    expect(Object.keys(r.key_sources).sort()).toEqual(['hit', 'missing', 'mode', 'pid', 'total']);
    expect(r.key_sources.hit).toBeLessThanOrEqual(r.key_sources.total);
    expect(r.dbs.length).toBeGreaterThan(0);
    for (const db of r.dbs) {
      expect(Object.keys(db).sort()).toEqual(['name', 'ok']);
      expect(typeof db.ok).toBe('boolean');
    }
    expect(typeof r.messages).toBe('number');
    expect(ipc.calls.some((c) => c.method === 'doctor')).toBe(true);
  });

  it('注入 KEY_NOT_FOUND → 协议错误（微信未运行文案），面板可展示不崩', async () => {
    const ipc = new MockIpc({ errors: { doctor: 'KEY_NOT_FOUND' } });
    await expect(ipc.doctor()).rejects.toMatchObject({
      code: 'KEY_NOT_FOUND',
      message: expect.stringContaining('微信'),
    });
  });
});
