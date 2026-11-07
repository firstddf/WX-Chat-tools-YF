// 类型标签与类型选项 —— 与 wxchart-tool exporter.TYPE_LABELS / guidata.type_options 一致。
import type { Message } from '../ipc/types';

export const TYPE_LABELS: Record<string, string> = {
  text: '文本',
  image: '图片',
  voice: '语音',
  video: '视频',
  file: '文件',
  link: '链接',
  quote: '引用',
  system: '系统',
  card: '名片',
  sticker: '表情',
  location: '位置',
  call: '通话',
  miniapp: '小程序',
  forward: '合并转发',
  transfer: '转账',
  redpacket: '红包',
};

/** 展示顺序（未知类型排最后）—— 同 guidata.TYPE_ORDER */
export const TYPE_ORDER = [
  'text', 'image', 'file', 'video', 'voice',
  'link', 'quote', 'forward', 'miniapp', 'card', 'sticker',
  'location', 'call', 'transfer', 'redpacket', 'system',
];

export function typeLabel(code: string): string {
  return TYPE_LABELS[code] ?? (code || '未知');
}

export interface TypeOption {
  code: string;
  label: string;
  count: number;
}

/** 同 guidata.type_options：去重、带计数、按固定顺序 */
export function deriveTypes(messages: readonly Message[]): TypeOption[] {
  const counts = new Map<string, number>();
  for (const m of messages) counts.set(m.mtype, (counts.get(m.mtype) ?? 0) + 1);
  const order = new Map(TYPE_ORDER.map((c, i) => [c, i]));
  const codes = [...counts.keys()].sort((a, b) => (order.get(a) ?? TYPE_ORDER.length) - (order.get(b) ?? TYPE_ORDER.length) || (a < b ? -1 : a > b ? 1 : 0));
  return codes.map((code) => ({ code, label: typeLabel(code), count: counts.get(code) ?? 0 }));
}
