// 合成数据生成器（docs/02 §6）——测试与浏览器 dev mock 共用；
// **不使用真实聊天记录**。全部确定性（固定种子），断言可复现。
import type { Account, Message } from './types';

export const CHATS_SEED = [
  { chat: '武汉云仓 荆 发货售后', chat_id: '48025936916@chatroom', is_group: true },
  { chat: '张三', chat_id: 'wxid_zhangsan', is_group: false },
  { chat: '产品讨论群', chat_id: '110223344@chatroom', is_group: true },
  { chat: '李四', chat_id: 'wxid_lisi', is_group: false },
  { chat: 'Family', chat_id: '188277366@chatroom', is_group: true },
] as const;

const SENDERS = ['王五', '遇见', '张三', '李四'];
const MTYPES = [
  'text', 'image', 'file', 'video', 'voice', 'quote', 'link', 'forward',
  'miniapp', 'card', 'sticker', 'location', 'call', 'transfer', 'redpacket', 'system',
];

/** UTC+8 的 YYYY-MM-DD（与 guidata.TZ 一致） */
export function dayOf(ts: number): string {
  const d = new Date((ts + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function timeOf(ts: number): string {
  const d = new Date((ts + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 确定性 LCG（避免 Math.random 的不可复现断言） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * 生成 count 条按 (ts, local_id) 正序的合成消息。
 * 规律埋点（供筛选/渲染断言）：
 * - 每 97 条含「报价」关键词；每 50 条带附件；每 77 条带引用；每 211 条截断；
 * - 每 3 条一条是我发的；类型按 MTYPES 轮转。
 */
export function makeMessages(count: number, source: 'store' | 'export' = 'store'): Message[] {
  const rand = lcg(20261106);
  const out: Message[] = [];
  let ts = 1790918400; // 2026-10-01 00:00:00 +08
  for (let i = 0; i < count; i++) {
    ts += 11 + Math.floor(rand() * 700); // 约 12 秒/条，11796 条 ≈ 40 天
    const chat = CHATS_SEED[i % CHATS_SEED.length];
    const mtype = MTYPES[i % MTYPES.length];
    const isMine = i % 3 === 0;
    const sender = isMine ? '我' : SENDERS[i % SENDERS.length];
    const withQuote = i % 77 === 0 && i > 0;
    const text = i % 97 === 0
      ? `报价单 ${i} 请查收`
      : i % 997 === 996
        ? `长串测试 ${i} ${'x'.repeat(300)}` // 超长无空格串：#11 换行验收用
        : `消息 ${i}：今天${i % 2 ? '发' : '收'}货安排确认一下，收到请回复。`;
    const media: Message['media'] = i % 50 === 0
      ? [{ kind: i % 100 === 0 ? 'image' : 'file', name: `运单_${i}.xlsx`, path: '', rel_path: `会话/2026-10/运单_${i}.xlsx`, size: 24962, decoded: false }]
      : [];
    out.push({
      ts,
      day: dayOf(ts),
      time_text: timeOf(ts),
      chat: chat.chat,
      chat_id: chat.chat_id,
      sender,
      sender_id: isMine ? 'wxid_me' : `wxid_${i % 4}`,
      is_mine: isMine,
      mtype,
      text: i % 211 === 0 ? `${text}……（内容过长已截断）` : text,
      truncated: i % 211 === 0,
      is_group: chat.is_group,
      local_id: i,
      server_id: i === 0 ? 0 : i * 7 + 1,
      quote_sender: withQuote ? SENDERS[(i + 1) % SENDERS.length] : '',
      quote_text: withQuote ? `消息 ${i - 1}：发` : '',
      quote_svrid: withQuote && i > 1 ? (i - 1) * 7 + 1 : 0,
      media,
      source,
      day_page: source === 'export' ? `${dayOf(ts)}.html` : '',
      chat_dir: source === 'export' ? `${chat.chat}_${chat.chat_id}` : '',
    });
  }
  out.sort((a, b) => a.ts - b.ts || a.local_id - b.local_id);
  return out;
}

export function makeAccounts(): Account[] {
  return [
    { wxid: 'wxid_mock_alpha', nickname: 'wxid_mock_alpha', active: 1793600000, root: 'C:/mock/xwechat_files/wxid_mock_alpha' },
    { wxid: 'wxid_mock_beta', nickname: 'wxid_mock_beta', active: 1793000000, root: 'C:/mock/xwechat_files/wxid_mock_beta' },
  ];
}
