// 引用回复：引用块解析 + 单击跳转定位（docs/04 A1 #19/#20；docs/01 D5）。
//
// 逐字段移植 Tk gui_chatview 的三个函数（Tk 版已验收，规则不能走样）：
//   - `_quote_of`   → quoteOf()   引用块数据（sender/content/svrid + 剥掉引用行的正文）；
//   - `_draw_quote` → quoteLabel() 单行文案「发送者: 内容首行」，省略号交给 CSS；
//   - `_find_quoted` → findQuoted() 在原消息列表里定位被引用的那条（svrid 优先，其次内容）。
//
// 纯函数、不碰 DOM：MessageList 用它渲染引用块/跳转，Vitest 用同一批向量断言规则
// （tests/quote.spec.ts 的用例逐条对齐 Tk tests/test_chatview.py #19/#20）。
import type { Message } from '../ipc/types';

/** 引用块数据（Tk `_quote_of` 的返回形状 `{sender, content, svrid, body}`） */
export interface QuoteBlock {
  /** 被引用消息的发送人（export 来源由拍平正文解析，可能为空） */
  sender: string;
  /** 被引用的正文（可能多行；引用块只显示首行） */
  content: string;
  /** 原消息服务端 ID（store 来源才有；0 = 没有，只能按内容匹配） */
  svrid: number;
  /**
   * 气泡正文：拍平正文里剥掉 `[引用 发送者] 内容` 行之后剩下的回复正文。
   * 原 text 字段不动 —— 「复制整条消息」拿到的仍是完整拍平文本（Tk 同）。
   */
  body: string;
}

/** 引用块文案里发送者与内容的分隔（Tk `_draw_quote`：`f"{sender}: {first_line}"`） */
export const QUOTE_LABEL_SEP = ': ';

/** 找不到原消息的提示条文案（沿用 Tk `_jump_to_quote` 里 `_warn` 的第一段） */
export const QUOTE_NOT_FOUND_TEXT =
  '没有找到被引用的原消息：它可能不在当前列表里（被筛选条件过滤），或正文匹配不上。';

/** 跳转定位闪烁时长（ms）——与 bubbles.css 的 `quote-flash` 动画同值，e2e 用它对时 */
export const QUOTE_FLASH_MS = 1400;

/** 跳转后「↩ 返回」入口的可见时长（ms） */
export const QUOTE_RETURN_VISIBLE_MS = 3000;

/**
 * 拍平正文里的引用行：`[引用 发送者] 被引用内容`（内容可跨行）。
 * 同 Tk `_QUOTE_LINE_RE = re.compile(r"(?ms)^\[引用 ?(.*?)\] (.*)$")`：
 * `^` 只认行首（避免正文中间的方括号误伤），`[\s\S]` 相当于 DOTALL。
 */
const QUOTE_LINE_RE = /^\[引用 ?([\s\S]*?)\] ([\s\S]*)$/m;

/** 宽容转整数：None/空串/非法值一律按 0（同 Tk `_safe_int` / `_server_id_of`） */
function safeInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** 只去掉首尾换行（同 Tk `str.strip("\n")`；正文里的空行保留） */
function stripNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 引用消息 → 引用块数据；不是引用消息返回 null（Tk `_quote_of`）。
 *
 * 两条数据来源：
 * - store：`quote_sender/quote_text/quote_svrid` 有结构化字段；
 * - export：结构化字段为空，只有拍平正文 `回复\n[引用 发送者] 被引用内容`，按行解析。
 *
 * 注意 Tk 的判断顺序：先「不是 quote 类型且字段全空 → 不是引用」提前退出，
 * 解析后再兜一次「sender/content 都为空 → 不画引用块」。
 */
export function quoteOf(m: Message): QuoteBlock | null {
  let sender = m.quote_sender || '';
  let content = m.quote_text || '';
  const svrid = safeInt(m.quote_svrid);
  if (m.mtype !== 'quote' && !(sender || content)) return null;

  const text = m.text || '';
  const match = QUOTE_LINE_RE.exec(text);
  let body: string;
  if (match) {
    // 结构化字段优先；缺失的才用拍平正文补（Tk：`sender = sender or match.group(1).strip()`）
    sender = sender || (match[1] ?? '').trim();
    content = content || (match[2] ?? '');
    body = stripNewlines(text.slice(0, match.index) + text.slice(match.index + match[0].length));
  } else {
    body = text;
  }
  if (!sender && !content) return null; // 字段和正文都解析不出引用内容 → 不画引用块
  return { sender, content, svrid, body };
}

/**
 * 引用块单行文案（Tk `_draw_quote`）：有发送者 `发送者: 内容首行`，否则内容首行，全空兜底 `[引用]`。
 * 超宽省略由 CSS `text-overflow: ellipsis` 完成，这里不裁剪（Tk 用 `_ellipsize` 手量宽度）。
 */
export function quoteLabel(quote: QuoteBlock): string {
  const firstLine = quote.content ? quote.content.split('\n')[0]! : '';
  return quote.sender ? `${quote.sender}${QUOTE_LABEL_SEP}${firstLine}` : firstLine || '[引用]';
}

/** 定位用的引用信息（只要内容和服务端 ID；QuoteBlock 可直接传入） */
export type QuoteQuery = Pick<QuoteBlock, 'content' | 'svrid'>;

export interface FindQuotedOptions {
  /**
   * 允许命中的消息下标白名单（默认全部）。
   * 引用块只可能在「当前视图的消息集合」里定位，与 Tk 的 `self._messages`
   * （筛选后的列表）一致：被筛选条件过滤掉的原消息定位不到 → 界面出提示条（A1 #19）。
   */
  eligible?: ReadonlySet<number>;
}

/** 同群优先之后：取引用消息之前的最近一条；都在引用之后则取池里最早一条（Tk 同） */
function pickNearest(pool: readonly number[], from: number): number {
  const before = pool.filter((i) => i < from);
  return before.length > 0 ? Math.max(...before) : Math.min(...pool);
}

/**
 * 在 `messages` 里找被引用原消息的下标（Tk `_find_quoted`，逐字段对齐）。
 *
 * 顺序：
 * 1. 有 `svrid` 且命中同 ID 消息 → 同会话优先；取引用消息之前的最近一条，
 *    引用之后才出现则取池里最早一条；
 * 2. 没命中（或本来就没有 svrid，如导出来源）→ 按内容匹配：
 *    内容去空白后至少 4 字符，允许截断（引用内容开头在正文里 / 正文开头在引用内容里），
 *    跳过引用消息自己；同会话优先、取之前的最近一条，没有之前的取同会话最早一条。
 * 3. 都不满足 → null（界面提示「找不到原消息」）。
 *
 * `originIndex` 越界时按最后一条处理（同 Tk）；`messages` 为空返回 null。
 */
export function findQuoted(
  messages: readonly Message[],
  quote: QuoteQuery,
  originIndex: number,
  options: FindQuotedOptions = {},
): number | null {
  const total = messages.length;
  if (total === 0) return null;
  const from = originIndex >= 0 && originIndex < total ? originIndex : total - 1;
  const originChat = (messages[from] as Message).chat_id || '';

  const eligible = options.eligible;
  const inPool: number[] = [];
  for (let i = 0; i < total; i++) {
    if (eligible && !eligible.has(i)) continue;
    inPool.push(i);
  }

  const svrid = safeInt(quote.svrid);
  if (svrid) {
    const hits = inPool.filter((i) => safeInt((messages[i] as Message).server_id) === svrid);
    if (hits.length > 0) {
      const same = hits.filter((i) => ((messages[i] as Message).chat_id || '') === originChat);
      return pickNearest(same.length > 0 ? same : hits, from);
    }
  }

  const needle = (quote.content || '').trim();
  if (needle.length >= 4) {
    const needleHead = needle.slice(0, 30);
    const hit = (i: number): boolean => {
      if (i === from) return false; // 引用消息自己的正文里就含引用内容，不能定位到自己
      const text = (messages[i] as Message).text || '';
      if (text.length < 4) return false;
      // 允许截断：引用内容的开头在正文里，或正文开头在引用内容里（Tk 同）
      return text.includes(needleHead) || needle.includes(text.slice(0, 40));
    };
    const pool = inPool.filter(hit);
    if (pool.length > 0) {
      const same = pool.filter((i) => ((messages[i] as Message).chat_id || '') === originChat);
      for (const group of [same, pool]) {
        const before = group.filter((i) => i < from);
        if (before.length > 0) return Math.max(...before);
      }
      return Math.min(...(same.length > 0 ? same : pool));
    }
  }
  return null;
}
