// 時區工具：資料庫存 UTC，顯示與排程依球團時區換算。

const ZH_WEEKDAY = '日一二三四五六';

// 每個時區的格式器只建一次：new Intl.DateTimeFormat 很貴（實測約是格式化本身的 20 倍），
// 排程一輪要換算幾十次時間，每次都新建的話 1 個球團就用掉免費方案 CPU 上限（10 ms）的六成。
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function partsIn(ts: number, tz: string): Record<string, string> {
  const p: Record<string, string> = {};
  for (const x of formatterFor(tz).formatToParts(new Date(ts))) p[x.type] = x.value;
  return p;
}

/** 該時區在某一瞬間相對 UTC 的位移（毫秒）。 */
function tzOffsetMs(ts: number, tz: string): number {
  const p = partsIn(ts, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** 當地日期 'YYYY-MM-DD' + 當地時刻 'HH:mm' → UTC 時間戳。 */
export function zonedToUtc(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz); // 再算一次，處理日光節約時間交界
  return ts;
}

/** UTC 時間戳 → 當地日期 'YYYY-MM-DD'。 */
export function localDate(ts: number, tz: string): string {
  const p = partsIn(ts, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 'YYYY-MM-DD' 加減天數。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 是星期幾（0 = 週日）。 */
export function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** UTC 時間戳在當地是星期幾。 */
export function localWeekday(ts: number, tz: string): number {
  return weekdayOfDate(localDate(ts, tz));
}

/** 顯示用：'10/14（三）20:00' */
export function formatLocal(ts: number, tz: string): string {
  const p = partsIn(ts, tz);
  const wd = ZH_WEEKDAY[weekdayOfDate(`${p.year}-${p.month}-${p.day}`)];
  return `${+p.month}/${+p.day}（${wd}）${p.hour}:${p.minute}`;
}

export const iso = (ts: number): string => new Date(ts).toISOString();
export const nowIso = (): string => iso(Date.now());
export const zhWeekday = (n: number): string => ZH_WEEKDAY[n];
