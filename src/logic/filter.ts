// 客户端筛选（D2：全量内存筛选，零 IPC 往返）——
// 语义与 wxchart-tool guidata.filter_messages 逐条一致（guidata 23 项测试即其契约）：
// - query：全角空格→半角，小写，按半角空格分词，AND 匹配 正文/发送人/群名/群号/附件名
// - chat_id：子串匹配 chat_id 或 chat（不区分大小写），空=全部
// - 日期：含端点；颠倒自动交换
// - type：类型码精确匹配，空=全部
// - 结果按 (ts, local_id) 正序
import type { FilterSpec, Message } from '../ipc/types';
import type { Indexed } from './plan';

function haystack(m: Message): string {
  const names = m.media.map((x) => x.name).filter(Boolean).join(' ');
  return `${m.text} ${m.sender} ${m.chat} ${m.chat_id} ${names}`.toLowerCase();
}

function terms(query: string): string[] {
  return query
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((t) => t.trim().length > 0);
}

/** 带全量下标的筛选：index 即 data.messages 中的位置（导出 scope.indexes 直接可用） */
export function filterIndexed(messages: readonly Message[], spec: Partial<FilterSpec>): Indexed[] {
  const { query = '', chat_id: chat = '', date_from = '', date_to = '', type = '' } = spec;
  const termsList = terms(query);
  const chatKey = chat.trim().toLowerCase();
  let from = date_from.trim();
  let to = date_to.trim();
  if (from && to && from > to) [from, to] = [to, from];

  const out: Indexed[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (from && m.day < from) continue;
    if (to && m.day > to) continue;
    if (type && m.mtype !== type) continue;
    if (chatKey && !m.chat_id.toLowerCase().includes(chatKey) && !m.chat.toLowerCase().includes(chatKey)) continue;
    if (termsList.length > 0) {
      const hay = haystack(m);
      if (termsList.some((t) => !hay.includes(t))) continue;
    }
    out.push({ index: i, m });
  }
  out.sort((a, b) => a.m.ts - b.m.ts || a.m.local_id - b.m.local_id);
  return out;
}

/** 纯 Message 版（测试/简单场景用） */
export function filterMessages(messages: readonly Message[], spec: Partial<FilterSpec>): Message[] {
  return filterIndexed(messages, spec).map((p) => p.m);
}
