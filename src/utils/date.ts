// 日期纯函数（M-A2）：解析/规整语义与 wxchart-tool 的
// wxchart/gui_datepicker.py 中 parse_date / normalize_date 逐条一致。
// 契约 = wxchart-tool/tests/test_datepicker.py 的 test_parse_date / test_normalize_date。

/** 支持的输入格式，顺序与 Tk `DATE_FORMATS` 完全一致（%Y-%m-%d → %Y/%m/%d → %Y%m%d）。 */
export const DATE_FORMATS = ['%Y-%m-%d', '%Y/%m/%d', '%Y%m%d'] as const;

// 与 strptime 的 \d{1,2}（零填充或非零填充均可）语义对齐；整串必须全部匹配。
const PATTERNS: readonly RegExp[] = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  /^(\d{4})(\d{1,2})(\d{1,2})$/,
];

/** 闰年：能被 4 整除但不能被 100 整除，或能被 400 整除。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** 月长（1..12，含闰年 2 月 29 天）；越界返回 0。 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return MONTH_LENGTHS[month - 1] ?? 0;
}

/** 补零到 2 位（月份/日期用）。 */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 组装 `YYYY-MM-DD`（年补零到 4 位，等价 Tk strftime('%Y-%m-%d')）。 */
export function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Tk `str(text or "").strip()`：None/undefined → ''，其余转字符串后去首尾空白。 */
function toRaw(text: string): string {
  return text == null ? '' : String(text).trim();
}

/**
 * 宽松解析日期为 `YYYY-MM-DD`；失败返回 `''`（Tk parse_date 失败返回 None）。
 * 按 DATE_FORMATS 顺序逐个尝试；任一格式命中但日期非法（月>12、2 月 30 日等）即视为失败。
 */
export function parseDate(text: string): string {
  const raw = toRaw(text);
  if (!raw) return '';
  for (const pattern of PATTERNS) {
    const m = pattern.exec(raw);
    if (!m) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < 1) continue; // datetime 不接受 0 年
    if (month < 1 || month > 12) continue;
    if (day < 1 || day > daysInMonth(year, month)) continue;
    return formatDate(year, month, day);
  }
  return '';
}

/** 规整成 `YYYY-MM-DD`；空/非法返回 `''`（与 Tk normalize_date 完全一致）。 */
export function normalizeDate(text: string): string {
  return parseDate(text);
}

/** 本地今天的 `YYYY-MM-DD`（Tk date.today() 语义）。 */
export function todayString(): string {
  const d = new Date();
  return formatDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 年份夹取到 1970..2100（Tk CalendarPopup._goto）。 */
export function clampYear(year: number): number {
  return Math.max(1970, Math.min(2100, year));
}

/** 月份夹取到 1..12（Tk CalendarPopup._goto）。 */
export function clampMonth(month: number): number {
  return Math.max(1, Math.min(12, month));
}
