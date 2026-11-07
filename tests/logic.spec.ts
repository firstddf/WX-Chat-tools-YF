// 纯逻辑层测试：筛选语义（对齐 guidata.filter_messages）+ 平铺计划（对齐 Tk _plan）。
// docs/04 C 双轨与 A1 #3 的向量都在这里落桩。
import { describe, expect, it } from 'vitest';
import { filterIndexed, filterMessages } from '@/logic/filter';
import { buildPlan, dayText, timeText, TIME_GAP, type Indexed } from '@/logic/plan';
import { deriveChats, deriveStats } from '@/logic/derive';
import { makeMessages } from '@/ipc/fixtures';
import type { Message } from '@/ipc/types';

function msg(partial: Partial<Message>): Message {
  return {
    ts: 0,
    day: '2026-10-01',
    time_text: '09:00:00',
    chat: '测试群',
    chat_id: '111@chatroom',
    sender: '张三',
    sender_id: 'wxid_a',
    is_mine: false,
    mtype: 'text',
    text: '',
    truncated: false,
    is_group: true,
    local_id: 0,
    server_id: 0,
    quote_sender: '',
    quote_text: '',
    quote_svrid: 0,
    media: [],
    source: 'store',
    day_page: '',
    chat_dir: '',
    ...partial,
  };
}

describe('filterMessages（guidata 语义）', () => {
  const messages = [
    msg({ ts: 3, day: '2026-10-03', text: '报价单已发', chat: '武汉云仓', chat_id: '480@chatroom', sender: '王五', local_id: 2 }),
    msg({ ts: 1, day: '2026-10-01', text: '普通消息', chat: '张三', chat_id: 'wxid_zs', is_group: false, sender: '李四', local_id: 1 }),
    msg({ ts: 2, day: '2026-10-02', text: '报价 张三 一起看', chat: '产品讨论群', chat_id: '110@chatroom', mtype: 'image', media: [{ kind: 'image', name: '报价表.png', path: '', rel_path: '', size: 0, decoded: false }], local_id: 0 }),
  ];

  it('关键词空格分词 AND，匹配正文/发送人/群名/群号/附件名', () => {
    expect(filterMessages(messages, { query: '报价' })).toHaveLength(2);
    expect(filterMessages(messages, { query: '报价 张三' })).toHaveLength(1);
    expect(filterMessages(messages, { query: '李四' })).toHaveLength(1);
    expect(filterMessages(messages, { query: '报价表.png' })).toHaveLength(1); // 附件名
    expect(filterMessages(messages, { query: '110@' })).toHaveLength(1); // 群号
    expect(filterMessages(messages, { query: '不存在的词' })).toHaveLength(0);
    // 全角空格当半角分词
    expect(filterMessages(messages, { query: '报价\u3000张三' })).toHaveLength(1);
  });

  it('chat_id 子串匹配 chat_id 或 chat 名称', () => {
    expect(filterMessages(messages, { chat_id: 'wxid_zs' })).toHaveLength(1);
    expect(filterMessages(messages, { chat_id: '武汉云仓' })).toHaveLength(1);
    expect(filterMessages(messages, { chat_id: '' })).toHaveLength(3);
  });

  it('日期含端点、颠倒自动交换', () => {
    expect(filterMessages(messages, { date_from: '2026-10-02', date_to: '2026-10-03' })).toHaveLength(2);
    expect(filterMessages(messages, { date_from: '2026-10-02', date_to: '2026-10-02' })).toHaveLength(1);
    // 颠倒
    expect(filterMessages(messages, { date_from: '2026-10-03', date_to: '2026-10-01' })).toHaveLength(3);
    expect(filterMessages(messages, { date_from: '2026-10-04' })).toHaveLength(0);
  });

  it('type 精确匹配', () => {
    expect(filterMessages(messages, { type: 'image' })).toHaveLength(1);
    expect(filterMessages(messages, { type: 'text' })).toHaveLength(2);
    expect(filterMessages(messages, { type: 'quote' })).toHaveLength(0);
  });

  it('结果按 (ts, local_id) 正序，index 是全量下标', () => {
    const out = filterIndexed(messages, {});
    expect(out.map((p) => p.m.ts)).toEqual([1, 2, 3]);
    expect(out.map((p) => p.index)).toEqual([1, 2, 0]); // 全量下标 → 导出 scope 直接可用
  });

  it('组合条件', () => {
    expect(filterMessages(messages, { query: '报价', type: 'image' })).toHaveLength(1);
    expect(filterMessages(messages, { query: '报价', chat_id: '480' })).toHaveLength(1);
    expect(filterMessages(messages, { query: '报价', type: 'text', date_from: '2026-10-03' })).toHaveLength(1);
  });
});

describe('buildPlan（Tk 平铺计划同构）', () => {
  it('分组：组按 last_ts 倒序、组内正序、组标题带 群号/会话ID · N 条', () => {
    const items: Indexed[] = [
      { index: 0, m: msg({ ts: 100, local_id: 0, chat: '测试群甲', chat_id: '111@chatroom' }) },
      { index: 1, m: msg({ ts: 110, local_id: 1, chat: '测试群甲', chat_id: '111@chatroom' }) },
      { index: 2, m: msg({ ts: 200, local_id: 2, chat: '测试群乙', chat_id: '222@chatroom' }) },
      { index: 3, m: msg({ ts: 210, local_id: 3, chat: '测试群乙', chat_id: '222@chatroom' }) },
    ];
    const plan = buildPlan(items, true);
    const groups = plan.filter((e) => e.kind === 'group');
    expect(groups.map((g) => (g.kind === 'group' ? g.chat : ''))).toEqual(['测试群乙', '测试群甲']);
    expect(groups.every((g) => g.kind === 'group' && g.count === 2)).toBe(true);

    // 组内正序：乙组的两条先出现且 ts 递增
    const msgEvents = plan.filter((e) => e.kind === 'msg');
    expect(msgEvents.map((e) => (e.kind === 'msg' ? e.index : -1))).toEqual([2, 3, 0, 1]);
  });

  it('单列表模式：全部按时间正序', () => {
    const items: Indexed[] = [
      { index: 5, m: msg({ ts: 300, local_id: 5 }) },
      { index: 2, m: msg({ ts: 100, local_id: 2 }) },
      { index: 9, m: msg({ ts: 200, local_id: 9 }) },
    ];
    const plan = buildPlan(items, false);
    expect(plan.filter((e) => e.kind === 'msg').map((e) => (e.kind === 'msg' ? e.index : -1))).toEqual([2, 9, 5]);
  });

  it('日期条换天出现，格式 YYYY-MM-DD 周X', () => {
    const items: Indexed[] = [
      { index: 0, m: msg({ ts: 1, day: '2026-11-05' }) },
      { index: 1, m: msg({ ts: 2, day: '2026-11-05' }) },
      { index: 2, m: msg({ ts: 3, day: '2026-11-06' }) },
    ];
    const days = buildPlan(items, false).filter((e) => e.kind === 'day');
    expect(days.map((d) => (d.kind === 'day' ? d.text : ''))).toEqual(['2026-11-05 周四', '2026-11-06 周五']);
    expect(dayText('2026-11-06')).toBe('2026-11-06 周五');
    expect(dayText('坏日期')).toBe('坏日期');
  });

  it('时间条：间隔 ≥5 分钟才出现，首条必现', () => {
    const items: Indexed[] = [
      { index: 0, m: msg({ ts: 1000, time_text: '10:00:00' }) },
      { index: 1, m: msg({ ts: 1000 + 100, time_text: '10:01:40' }) }, // 100s < TIME_GAP
      { index: 2, m: msg({ ts: 1000 + 100 + TIME_GAP, time_text: '10:06:40' }) }, // 恰好 300s
    ];
    const plan = buildPlan(items, false);
    const times = plan.filter((e) => e.kind === 'time');
    expect(times).toHaveLength(2);
    expect(times[0]!.kind === 'time' && times[0]!.text).toBe('10:00');
    expect(times[1]!.kind === 'time' && times[1]!.text).toBe('10:06');
    expect(timeText(msg({ time_text: '' }))).toBe('');
    expect(timeText(msg({ time_text: '09:05:07' }))).toBe('09:05'); // 截到 HH:MM
  });

  it('空列表 → 空计划', () => {
    expect(buildPlan([], true)).toEqual([]);
  });
});

describe('derive（chats/stats 同 mapping.load_result）', () => {
  it('派生会话行与统计', () => {
    const messages = makeMessages(50);
    const chats = deriveChats(messages);
    expect(chats.length).toBeGreaterThan(0);
    for (const c of chats) {
      expect(Object.keys(c).sort()).toEqual(['chat', 'chat_id', 'count', 'is_group', 'last_ts']);
    }
    const stats = deriveStats(messages);
    expect(stats.messages).toBe(50);
    expect(stats.chats).toBe(chats.length);
    expect(stats.first_ts).toBeLessThan(stats.last_ts);
    expect(stats.media).toBe(messages.reduce((n, m) => n + m.media.length, 0));
  });
});
