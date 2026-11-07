// 从全量 messages 派生 chats/stats —— 语义与 wxchart-tool guidata.chat_options
// 逐字段一致（B 类 23 项测试守护的那套语义），供 MockIpc 与测试共用。
import type { Chat, LoadStats, Message } from '../ipc/types';

/** 同 guidata.chat_options：按 chat_id||chat 去重，按名称排序 */
export function deriveChats(messages: readonly Message[]): Chat[] {
  const groups = new Map<string, Chat>();
  for (const item of messages) {
    const key = item.chat_id || item.chat;
    let row = groups.get(key);
    if (!row) {
      row = { chat: item.chat, chat_id: item.chat_id, is_group: item.is_group, count: 0, last_ts: 0 };
      groups.set(key, row);
    }
    row.count += 1;
    row.last_ts = Math.max(row.last_ts, item.ts);
    if (item.chat && !row.chat) row.chat = item.chat;
  }
  const rows = [...groups.values()];
  rows.sort((a, b) => (a.chat < b.chat ? -1 : a.chat > b.chat ? 1 : a.chat_id < b.chat_id ? -1 : a.chat_id > b.chat_id ? 1 : 0));
  return rows;
}

/** 同 mapping.load_result 的 stats */
export function deriveStats(messages: readonly Message[]): LoadStats {
  let media = 0;
  let first = 0;
  let last = 0;
  const seen = new Set<string>();
  for (const m of messages) {
    media += m.media.length;
    if (m.ts) {
      if (!first || m.ts < first) first = m.ts;
      if (m.ts > last) last = m.ts;
    }
    seen.add(m.chat_id || m.chat);
  }
  return { messages: messages.length, chats: seen.size, media, first_ts: first, last_ts: last };
}
