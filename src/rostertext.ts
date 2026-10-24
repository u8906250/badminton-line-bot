// 文字名單：管理員把某一場的名單複製貼到 LINE 群組用（格式照球團原本在群組貼的那份）。
//
//   115年第四季（4）
//
//   日期：10月25日（日）
//   時間：晚上6:00至8:00
//   地點：體育館 第 2 & 4 號球場
//   人數：16人
//
//   📌 注意
//
//   （球團規則）
//
//   1. 季打成員
//   2. 臨打0打
//
//   候補：
//   1. 臨打0打
//
//   請假：小王、小李
//   —

import type { Club, Env, RegKind, RegStatus } from './types';
import { getSessionOrThrow } from './manage';
import { localDate, partsIn, weekdayOfDate, zhWeekday } from './time';

/** 時段的說法：凌晨／上午／中午／下午／晚上，加 12 小時制的時間，例如「晚上6:00」。 */
export function clockText(hour: number, minute: number): { period: string; time: string } {
  const period = hour < 5 ? '凌晨' : hour < 12 ? '上午' : hour === 12 ? '中午' : hour < 18 ? '下午' : '晚上';
  return { period, time: `${hour % 12 || 12}:${String(minute).padStart(2, '0')}` };
}

/** 「晚上6:00至8:00」；結束的時段和開始不同時才寫出來，例如「下午5:00至晚上7:00」。 */
export function timeRangeText(startTs: number, endTs: number, tz: string): string {
  const a = partsIn(startTs, tz);
  const b = partsIn(endTs, tz);
  const s = clockText(+a.hour, +a.minute);
  const e = clockText(+b.hour, +b.minute);
  return `${s.period}${s.time}至${e.period === s.period ? '' : e.period}${e.time}`;
}

/** 從季期開始日（含）到 date（含），和 date 同一個星期幾的日子有幾天。兩個都是當地日期 'YYYY-MM-DD'。 */
export function weekOfSeason(startDate: string, date: string): number {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  return days < 0 ? 0 : Math.floor(days / 7) + 1;
}

export function dateText(ts: number, tz: string): string {
  const p = partsIn(ts, tz);
  return `${+p.month}月${+p.day}日（${zhWeekday(weekdayOfDate(`${p.year}-${p.month}-${p.day}`))}）`;
}

interface Row {
  kind: RegKind;
  status: RegStatus;
  guest_name: string | null;
  name: string;
}

/** 名單上一個人的寫法：季打寫名字；臨打加「0打」；幫朋友報的寫「朋友名字（報名人友）0打」。 */
const entryText = (r: Row): string =>
  r.kind === 'season' ? r.name : r.guest_name ? `${r.guest_name}（${r.name}友）0打` : `${r.name}0打`;

/**
 * 產生某一場的文字名單。編號的名單只有會來的人：季打 → 正取的臨打（依報名先後）；候補、請假另外寫在最下面
 * （使用者 2026-10-23 要求請假的不要佔名單的編號）。
 * 標題是季期名稱加「這是這一季的第幾週」：從季期開始日算到這一場，同一個星期幾出現了幾次（例如季期 10/1 開始，
 * 10/25 週日是第 4 個週日）。用日期算、不數資料庫裡的場次：系統是季中才開始用的話，前幾週的場次根本不在資料庫裡。
 * 停打（取消）的那週也算一週。沒有季期的場次（例如臨時加場）用球團名稱。
 */
export async function rosterText(env: Env, club: Club, sessionId: string): Promise<string> {
  const s = await getSessionOrThrow(env, club, sessionId);
  const [season, rows] = await env.DB.batch([
    env.DB.prepare('SELECT name, start_date FROM seasons WHERE id = ?').bind(s.season_id),
    env.DB.prepare(
      `SELECT r.kind, r.status, r.guest_name, COALESCE(m.nickname, u.display_name) AS name
       FROM registrations r
       JOIN users u ON u.line_user_id = r.user_id
       LEFT JOIN club_members m ON m.club_id = ?1 AND m.user_id = r.user_id
       WHERE r.session_id = ?2 AND r.status <> 'cancelled'
       ORDER BY r.queued_at, r.rowid`,
    ).bind(club.id, s.id),
  ]);
  const se = season.results[0] as { name: string; start_date: string } | undefined;
  const list = rows.results as Row[];
  const tz = club.timezone;

  const lines: string[] = [];
  lines.push(se ? `${se.name}（${weekOfSeason(se.start_date, localDate(Date.parse(s.start_at), tz))}）` : club.name, '');
  lines.push(`日期：${dateText(Date.parse(s.start_at), tz)}`);
  lines.push(`時間：${timeRangeText(Date.parse(s.start_at), Date.parse(s.end_at), tz)}`);
  const where = [s.venue, s.court_no].filter(Boolean).join(' ');
  if (where) lines.push(`地點：${where}`);
  lines.push(`人數：${s.capacity}人`);
  if (s.status === 'cancelled') lines.push(`（這場已取消${s.cancel_reason ? `：${s.cancel_reason}` : ''}）`);
  if (club.rules) lines.push('', '📌 注意', '', club.rules.trim());
  lines.push('');

  const main = [
    ...list.filter((r) => r.kind === 'season' && r.status === 'confirmed'),
    ...list.filter((r) => r.kind === 'casual' && r.status === 'confirmed'),
  ];
  main.forEach((r, i) => lines.push(`${i + 1}. ${entryText(r)}`));
  if (!main.length) lines.push('（還沒有人）');
  const waitlist = list.filter((r) => r.status === 'waitlist');
  if (waitlist.length) {
    lines.push('', '候補：');
    waitlist.forEach((r, i) => lines.push(`${i + 1}. ${entryText(r)}`));
  }
  const leave = list.filter((r) => r.status === 'leave');
  if (leave.length) lines.push('', `請假：${leave.map((r) => r.name).join('、')}`);
  lines.push('—');
  return lines.join('\n');
}
