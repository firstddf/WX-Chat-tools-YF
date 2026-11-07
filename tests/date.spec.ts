// 纯函数向量（M-A2）：逐条对应 wxchart-tool/tests/test_datepicker.py 的
// test_parse_date / test_normalize_date（Tk 契约，16 项验收之一部分）。
import { describe, expect, it } from 'vitest';
import { DATE_FORMATS, normalizeDate, parseDate } from '../src/utils/date';

// Tk 测试直接传 None；TS 侧以 null 模拟同一运行时语义。
const P = (v: unknown) => parseDate(v as string);
const N = (v: unknown) => normalizeDate(v as string);

describe('test_parse_date —— 多格式解析向量（Tk test_parse_date）', () => {
  it('test_parse_date', () => {
    // DATE_FORMATS == ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d")
    expect([...DATE_FORMATS]).toEqual(['%Y-%m-%d', '%Y/%m/%d', '%Y%m%d']);

    // 合法输入 → 'YYYY-MM-DD'
    expect(P('2026-09-01')).toBe('2026-09-01');
    expect(P('2026/9/1')).toBe('2026-09-01');
    expect(P('20260901')).toBe('2026-09-01');
    expect(P(' 2026-09-01 ')).toBe('2026-09-01'); // 应 strip 空白
    expect(P('2026-9-1')).toBe('2026-09-01'); // 非零填充也应能解析

    // 空 / 非法 → ''（Tk 返回 None）
    expect(P('')).toBe('');
    expect(P(null)).toBe('');
    expect(P('   ')).toBe('');
    expect(P('bad')).toBe('');
    expect(P('2026-13-01')).toBe('');
    expect(P('2026-02-30')).toBe('');
  });
});

describe('test_normalize_date —— 规整向量（Tk test_normalize_date）', () => {
  it('test_normalize_date', () => {
    expect(N('2026-09-01')).toBe('2026-09-01');
    expect(N('2026/9/1')).toBe('2026-09-01');
    expect(N('20260901')).toBe('2026-09-01');
    expect(N(' 2026/9/1 ')).toBe('2026-09-01');
    expect(N('')).toBe('');
    expect(N(null)).toBe('');
    expect(N('   ')).toBe('');
    expect(N('bad')).toBe('');
    expect(N('2026-02-30')).toBe('');
  });
});
