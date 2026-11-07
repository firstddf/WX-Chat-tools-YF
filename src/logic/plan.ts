// 平铺渲染计划 —— 与 Tk gui_chatview._build_plan / _group_plan / _iter_message_events 同构。
// 事件序列：[group] → (day / time / msg)*，虚拟列表按可视窗口渲染这些事件。
import type { Message } from '../ipc/types';

export const TIME_GAP = 300; // 与上一条间隔 ≥5 分钟才显示时间条（秒）
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 带全量下标的消息（index = data.messages 里的位置，导出 scope.indexes 用它） */
export interface Indexed {
  index: number;
  m: Message;
}

export type PlanEvent =
  | { kind: 'group'; key: string; chat: string; chat_id: string; is_group: boolean; count: number }
  | { kind: 'day'; text: string }
  | { kind: 'time'; text: string }
  | { kind: 'msg'; index: number };

/** 日期条文字：`2026-09-17 周四`（同 Tk _day_text） */
export function dayText(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  const weekday = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${day} ${WEEKDAYS[(weekday + 6) % 7]}`; // 周一=0
}

/** 时间条文字（HH:MM，同 Tk _time_text）：优先 time_text，缺失用 ts(+08) 换算 */
export function timeText(m: Message): string {
  if (m.time_text) return m.time_text.slice(0, 5);
  if (!m.ts) return '';
  const d = new Date((m.ts + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function byTime(a: Indexed, b: Indexed): number {
  return a.m.ts - b.m.ts || a.m.local_id - b.m.local_id || a.index - b.index;
}

function* messageEvents(items: Indexed[]): Generator<PlanEvent> {
  let lastDay = '';
  let lastTs = 0;
  for (const { index, m } of items) {
    if (m.day !== lastDay) {
      lastDay = m.day;
      lastTs = 0;
      if (lastDay) yield { kind: 'day', text: dayText(lastDay) };
    }
    if (!lastTs || (m.ts && m.ts - lastTs >= TIME_GAP)) {
      yield { kind: 'time', text: timeText(m) };
    }
    lastTs = m.ts;
    yield { kind: 'msg', index };
  }
}

/**
 * 构建平铺计划。
 * - groupByChat：组内时间正序，组按 (last_ts, count) 倒序（与 Tk/_导出页一致）；
 * - 否则：全部按 (ts, local_id, 原下标) 正序。
 */
export function buildPlan(items: readonly Indexed[], groupByChat: boolean): PlanEvent[] {
  const out: PlanEvent[] = [];
  if (items.length === 0) return out;
  if (!groupByChat) {
    out.push(...messageEvents([...items].sort(byTime)));
    return out;
  }
  const groups = new Map<
    string,
    { key: string; chat: string; chat_id: string; is_group: boolean; items: Indexed[]; last_ts: number }
  >();
  for (const it of items) {
    const chatId = it.m.chat_id || '';
    const key = chatId || it.m.chat || '?';
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        chat: it.m.chat || key,
        chat_id: chatId,
        is_group: it.m.is_group || chatId.endsWith('@chatroom'),
        items: [],
        last_ts: 0,
      };
      groups.set(key, g);
    }
    g.items.push(it);
    g.last_ts = Math.max(g.last_ts, it.m.ts);
  }
  const ordered = [...groups.values()].sort((a, b) => b.last_ts - a.last_ts || b.items.length - a.items.length);
  for (const g of ordered) {
    g.items.sort(byTime); // JS sort 稳定，等价 Tk 的 (ts, local_id, 传入下标)
    out.push({ kind: 'group', key: g.key, chat: g.chat, chat_id: g.chat_id, is_group: g.is_group, count: g.items.length });
    out.push(...messageEvents(g.items));
  }
  return out;
}
