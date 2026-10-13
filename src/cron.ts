// 排程：每 5 分鐘執行一次。所有步驟都可重複執行，漏跑一次下一輪會補上。
//
// 容量：免費方案每次執行只有 10 ms 的 CPU。推進場次狀態是每輪對所有球團做（三句 SQL，和球團數無關）；
// 補場次則是每輪只輪到 CLUBS_PER_RUN 個球團，球團多了就是每個球團隔比較久才輪到一次，不會讓單輪的工作量跟著變大。
// 管理員新增／修改時段、建立季期時會立刻對自己的球團補一次（generateSessions 帶 onlyClubId），不用等輪到。

import type { Club, Env, Schedule, Season, Session } from './types';
import { deliverFeedback } from './feedback';
import { announceOpened } from './notify';
import { addDays, iso, localDate, weekdayOfDate, zonedToUtc } from './time';

const DAYS_AHEAD = 28;
export const DAY_MS = 86_400_000;
/** 排程多久跑一次，用來算這一輪輪到哪幾個球團。要和 wrangler.toml 的 crons 一致（test/cron.test.mts 會檢查），否則有些球團可能永遠輪不到。 */
export const RUN_EVERY_MS = 5 * 60_000;
/** 每輪補場次的球團數。球團數不超過這個數字時，每輪都是全部處理。 */
export const CLUBS_PER_RUN = 5;

export async function runCron(env: Env, now = Date.now()): Promise<void> {
  await generateSessions(env, now);
  await advanceStatuses(env, now);
  // 通知出問題不能拖累排場次、推進狀態
  await announceOpened(env, now).catch((e) => console.error('announceOpened failed', e));
  await deliverFeedback(env, now).catch((e) => console.error('deliverFeedback failed', e));
}

/** 依球團規則算出某場的報名開放與截止時間。 */
export function regWindow(club: Club, startTs: number): { openTs: number; closeTs: number } {
  const date = localDate(startTs, club.timezone);
  return {
    openTs: zonedToUtc(addDays(date, -club.reg_open_days_before), club.reg_open_time, club.timezone),
    closeTs: startTs - club.reg_close_minutes_before * 60_000,
  };
}

/** 某個時段在某個當地日期的開始與結束時間（結束早於開始視為跨午夜）。 */
export function slotTimes(club: Club, date: string, startTime: string, endTime: string): { startTs: number; endTs: number } {
  const startTs = zonedToUtc(date, startTime, club.timezone);
  let endTs = zonedToUtc(date, endTime, club.timezone);
  if (endTs <= startTs) endTs += DAY_MS;
  return { startTs, endTs };
}

/** 季打成員自動佔位；已存在的那筆（含請假）不動。id 固定，所以重跑不會重複。 */
export function seedSeasonStmt(db: D1Database, sessionId: string, seasonId: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO registrations (id, session_id, user_id, kind, status, queued_at, updated_at)
       SELECT ?1 || '_s_' || sm.user_id, ?1, sm.user_id, 'season', 'confirmed', ?2, ?2
       FROM season_members sm
       JOIN sessions s ON s.id = ?1 AND s.season_id = sm.season_id
       WHERE sm.season_id = ?3 AND s.status NOT IN ('cancelled', 'done')`,
    )
    .bind(sessionId, now, seasonId);
}

/**
 * 這一輪要補場次的球團：依 id 排成一圈，每輪往後取 CLUBS_PER_RUN 個，到底就繞回開頭。
 * 球團數不超過 CLUBS_PER_RUN 時每輪都是全部；更多時，每個球團最慢每「球團數 ÷ CLUBS_PER_RUN」輪（無條件進位）輪到一次。
 * 從哪裡取起是用時間算的（第幾輪 × CLUBS_PER_RUN），不用另外記進度；回傳的列多了 turn_pos、turn_total 兩欄，不影響使用。
 */
export function clubsForRun(db: D1Database, now: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT * FROM (SELECT clubs.*, ROW_NUMBER() OVER (ORDER BY id) - 1 AS turn_pos, COUNT(*) OVER () AS turn_total FROM clubs)
       WHERE turn_total <= ?1
          OR (turn_pos - (CAST(?2 AS INTEGER) * ?1) % turn_total + turn_total) % turn_total < ?1
       ORDER BY turn_pos`,
    )
    .bind(CLUBS_PER_RUN, Math.floor(now / RUN_EVERY_MS));
}

/**
 * 依每週時段補齊未來 4 週的場次；有進行中季期時，把季打成員寫入正取。
 * onlyClubId：只處理這個球團（管理員改了時段或季期，要立刻生效）；沒帶就是排程，處理這一輪輪到的球團。
 */
export async function generateSessions(env: Env, now: number, onlyClubId?: string): Promise<void> {
  const { results: clubs } = onlyClubId
    ? await env.DB.prepare('SELECT * FROM clubs WHERE id = ?').bind(onlyClubId).all<Club>()
    : await clubsForRun(env.DB, now).all<Club>();
  const nowStr = iso(now);

  for (const club of clubs) {
    const [sch, sea, ses] = await env.DB.batch([
      env.DB.prepare('SELECT * FROM schedules WHERE club_id = ? AND active = 1').bind(club.id),
      env.DB.prepare('SELECT * FROM seasons WHERE club_id = ?').bind(club.id),
      // 已經建好的場次。還沒打完的場次最早也是一天內開始的，往前多抓一天當餘裕
      env.DB.prepare('SELECT id, season_id, end_at FROM sessions WHERE club_id = ? AND start_at > ?').bind(club.id, iso(now - 2 * DAY_MS)),
    ]);
    const schedules = sch.results as Schedule[];
    const seasons = sea.results as Season[];
    if (!schedules.length) continue;
    const existing = new Map((ses.results as Pick<Session, 'id' | 'season_id' | 'end_at'>[]).map((s) => [s.id, s]));

    const today = localDate(now, club.timezone);
    const stmts: D1PreparedStatement[] = [];

    for (let i = 0; i <= DAYS_AHEAD; i++) {
      const date = addDays(today, i);
      const weekday = weekdayOfDate(date);
      const season = seasons.find((se) => se.start_date <= date && date <= se.end_date);

      for (const sc of schedules) {
        if (sc.weekday !== weekday) continue;
        const sid = `${sc.id}_${date}`;
        const have = existing.get(sid);

        if (have) {
          // 已經有這一場：不用重算時間（換算時區是這裡最花 CPU 的部分），只看它結束了沒
          if (Date.parse(have.end_at) <= now) continue;
        } else {
          const { startTs, endTs } = slotTimes(club, date, sc.start_time, sc.end_time);
          if (endTs <= now) continue;
          const { openTs, closeTs } = regWindow(club, startTs);
          stmts.push(
            env.DB.prepare(
              `INSERT OR IGNORE INTO sessions
                 (id, club_id, schedule_id, season_id, start_at, end_at, venue, court_no, courts, capacity, reg_open_at, reg_close_at, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
            ).bind(sid, club.id, sc.id, season?.id ?? null, iso(startTs), iso(endTs), sc.venue, sc.court_no, sc.courts, sc.capacity, iso(openTs), iso(closeTs)),
          );
        }

        if (season) {
          // 季期晚於場次建立時，補上 season_id
          if (!have || have.season_id === null) {
            stmts.push(env.DB.prepare('UPDATE sessions SET season_id = ? WHERE id = ? AND season_id IS NULL').bind(season.id, sid));
          }
          // 每輪都補一次季打佔位：用 SQL 直接加進季打名單的人（seed.sql）靠這裡才會出現在已建好的場次
          stmts.push(seedSeasonStmt(env.DB, sid, season.id, nowStr));
        }
      }
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
}

/** 依時間推進場次狀態：scheduled → open → closed → done。 */
export async function advanceStatuses(env: Env, now: number): Promise<void> {
  const t = iso(now);
  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET status = 'done' WHERE status IN ('scheduled', 'open', 'closed') AND end_at <= ?`).bind(t),
    env.DB.prepare(`UPDATE sessions SET status = 'closed' WHERE status IN ('scheduled', 'open') AND reg_close_at <= ?`).bind(t),
    env.DB.prepare(`UPDATE sessions SET status = 'open' WHERE status = 'scheduled' AND reg_open_at <= ? AND reg_close_at > ?`).bind(t, t),
  ]);
}
