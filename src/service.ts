// 報名、取消、請假、銷假、遞補的核心規則。群組指令和 LIFF API 共用這裡。

import type { Club, Env, Gender, RegKind, RegStatus, Registration, Session } from './types';
import { UserError } from './types';
import { formatLocal, iso, nowIso } from './time';

export interface Promoted {
  id: string;
  user_id: string;
  guest_name: string | null;
}

export interface QueueResult {
  status: 'confirmed' | 'waitlist';
  /** 候補順位；正取為 0 */
  position: number;
}

/** 臨打費：報名時選女生、球團又有另外設定女生臨打費時用女生的；其他都用 casual_fee。 */
export function casualFeeFor(club: Club, gender: Gender | null): number {
  return gender === 'F' && club.casual_fee_female != null ? club.casual_fee_female : club.casual_fee;
}

/** 有空位時，把候補第一位改為正取。名額判斷與寫入在同一句 SQL，不會超賣。 */
export function promoteStmt(db: D1Database, sessionId: string, now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE registrations SET status = 'confirmed', updated_at = ?1
       WHERE id = (SELECT id FROM registrations WHERE session_id = ?2 AND status = 'waitlist'
                   ORDER BY queued_at, rowid LIMIT 1)
         AND (SELECT COUNT(*) FROM registrations WHERE session_id = ?2 AND status = 'confirmed')
           < (SELECT capacity FROM sessions WHERE id = ?2)
       RETURNING id, user_id, guest_name`,
    )
    .bind(now, sessionId);
}

function assertOpen(club: Club, s: Session): void {
  switch (s.status) {
    case 'open':
      return;
    case 'scheduled':
      throw new UserError(`這場還沒開放，${formatLocal(Date.parse(s.reg_open_at), club.timezone)} 開放報名`);
    case 'closed':
      throw new UserError('這場報名已截止');
    case 'cancelled':
      throw new UserError(`這場已取消${s.cancel_reason ? `（${s.cancel_reason}）` : ''}`);
    default:
      throw new UserError('這場已結束');
  }
}

function assertNotStarted(s: Session): void {
  if (s.status === 'cancelled') throw new UserError('這場已取消');
  if (s.status === 'done' || Date.parse(s.start_at) <= Date.now()) throw new UserError('這場已經開始了');
}

export function findOwn(db: D1Database, sessionId: string, userId: string, guestName?: string) {
  const sql = guestName
    ? `SELECT * FROM registrations WHERE session_id = ? AND user_id = ? AND guest_name = ? AND status <> 'cancelled'`
    : `SELECT * FROM registrations WHERE session_id = ? AND user_id = ? AND guest_name IS NULL AND status <> 'cancelled'`;
  const stmt = guestName ? db.prepare(sql).bind(sessionId, userId, guestName) : db.prepare(sql).bind(sessionId, userId);
  return stmt.first<Registration>();
}

export async function waitlistPosition(db: D1Database, reg: Registration): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM registrations w, registrations me
       WHERE me.id = ? AND w.session_id = me.session_id AND w.status = 'waitlist'
         AND (w.queued_at < me.queued_at OR (w.queued_at = me.queued_at AND w.rowid <= me.rowid))`,
    )
    .bind(reg.id)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function toQueueResult(db: D1Database, id: string): Promise<QueueResult> {
  const reg = await db.prepare('SELECT * FROM registrations WHERE id = ?').bind(id).first<Registration>();
  if (!reg) throw new Error(`registration ${id} not found`);
  if (reg.status === 'confirmed') return { status: 'confirmed', position: 0 };
  return { status: 'waitlist', position: await waitlistPosition(db, reg) };
}

/** 臨打報名（自己或代朋友）。 */
export async function register(
  env: Env,
  club: Club,
  s: Session,
  userId: string,
  guestName?: string,
  opts: { byAdmin?: boolean; gender?: Gender | null; level?: number | null } = {},
): Promise<QueueResult> {
  // 管理員代報名不受開放與截止時間限制，只要還沒開打
  if (opts.byAdmin) assertNotStarted(s);
  else assertOpen(club, s);
  const existing = await findOwn(env.DB, s.id, userId, guestName);
  if (existing) {
    if (existing.kind === 'season') {
      throw new UserError(existing.status === 'leave' ? '你這場已請假，要回來請輸入「銷假」' : '你是這場的季打成員，已經在名單上了');
    }
    const who = guestName ? `${guestName} 已經報名了` : '你已經報名了';
    if (existing.status === 'waitlist') {
      throw new UserError(`${who}（候補第 ${await waitlistPosition(env.DB, existing)} 位）`);
    }
    throw new UserError(`${who}（正取）`);
  }

  const id = crypto.randomUUID();
  const now = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO registrations (id, session_id, user_id, guest_name, gender, level, kind, status, queued_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?6, ?7, 'casual',
         CASE WHEN (SELECT COUNT(*) FROM registrations WHERE session_id = ?2 AND status = 'confirmed')
                 < (SELECT capacity FROM sessions WHERE id = ?2)
              THEN 'confirmed' ELSE 'waitlist' END,
         ?5, ?5`,
    )
      .bind(id, s.id, userId, guestName ?? null, now, opts.gender ?? null, opts.level ?? null)
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new UserError(guestName ? `${guestName} 已經報名了` : '你已經報名了');
    throw e;
  }
  return toQueueResult(env.DB, id);
}

export async function changeAndPromote(db: D1Database, reg: Registration, status: 'cancelled' | 'leave'): Promise<Promoted | null> {
  const now = nowIso();
  const [, promoted] = await db.batch([
    db.prepare('UPDATE registrations SET status = ?, updated_at = ? WHERE id = ?').bind(status, now, reg.id),
    promoteStmt(db, reg.session_id, now),
  ]);
  return ((promoted.results as Promoted[])[0] as Promoted | undefined) ?? null;
}

/** 取消臨打報名；有人遞補時回傳被遞補的那筆。 */
export async function cancel(
  env: Env,
  club: Club,
  s: Session,
  userId: string,
  guestName: string | undefined,
  byAdmin: boolean,
): Promise<Promoted | null> {
  assertNotStarted(s);
  const reg = await findOwn(env.DB, s.id, userId, guestName);
  if (!reg) throw new UserError(guestName ? `沒有找到 ${guestName} 的報名` : '你沒有報名這場');
  if (reg.kind === 'season') throw new UserError('季打成員請輸入「請假」');
  const deadline = club.cancel_deadline_minutes_before;
  if (!byAdmin && deadline != null && Date.now() > Date.parse(s.start_at) - deadline * 60_000) {
    throw new UserError(`已超過取消期限（開打前 ${deadline} 分鐘），請找管理員協助`);
  }
  return changeAndPromote(env.DB, reg, 'cancelled');
}

/** 季打請假：釋出名額並遞補。 */
export async function leave(env: Env, s: Session, userId: string): Promise<Promoted | null> {
  assertNotStarted(s);
  const reg = await findOwn(env.DB, s.id, userId);
  if (!reg || reg.kind !== 'season') throw new UserError('你不是這場的季打成員；臨打請用「-1」取消');
  if (reg.status === 'leave') throw new UserError('你這場已經請過假了');
  return changeAndPromote(env.DB, reg, 'leave');
}

/** 季打銷假：有空位恢復正取；名額已被遞補時排入候補第一位，不擠掉已遞補的人。 */
export async function unleave(env: Env, s: Session, userId: string): Promise<QueueResult> {
  assertNotStarted(s);
  const reg = await findOwn(env.DB, s.id, userId);
  if (!reg || reg.kind !== 'season' || reg.status !== 'leave') throw new UserError('你這場沒有請假');
  const first = await env.DB.prepare(
    `SELECT MIN(queued_at) AS q FROM registrations WHERE session_id = ? AND status = 'waitlist'`,
  )
    .bind(s.id)
    .first<{ q: string | null }>();
  const now = nowIso();
  const queuedAt = first?.q ? new Date(Date.parse(first.q) - 1).toISOString() : now;
  await env.DB.prepare(
    `UPDATE registrations SET
       status = CASE WHEN (SELECT COUNT(*) FROM registrations WHERE session_id = ?1 AND status = 'confirmed')
                        < (SELECT capacity FROM sessions WHERE id = ?1)
                     THEN 'confirmed' ELSE 'waitlist' END,
       queued_at = ?2, updated_at = ?3
     WHERE id = ?4 AND status = 'leave'`,
  )
    .bind(s.id, queuedAt, now, reg.id)
    .run();
  return toQueueResult(env.DB, reg.id);
}

/**
 * 讓正取人數符合上限：有空位就依序遞補；超額就從最後報名的臨打正取開始退回候補
 * （保留原本的排隊時間，所以會排在候補最前面）。季打不會被退回。
 */
export async function rebalance(db: D1Database, sessionId: string): Promise<{ promoted: Promoted[]; demoted: Promoted[] }> {
  const now = nowIso();
  const promoted: Promoted[] = [];
  for (let i = 0; i < 200; i++) {
    const r = await promoteStmt(db, sessionId, now).all<Promoted>();
    if (!r.results.length) break;
    promoted.push(r.results[0]);
  }
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM registrations WHERE session_id = ?1 AND status = 'confirmed') AS confirmed,
              (SELECT capacity FROM sessions WHERE id = ?1) AS capacity`,
    )
    .bind(sessionId)
    .first<{ confirmed: number; capacity: number }>();
  const excess = (counts?.confirmed ?? 0) - (counts?.capacity ?? 0);
  let demoted: Promoted[] = [];
  if (excess > 0) {
    const r = await db
      .prepare(
        `UPDATE registrations SET status = 'waitlist', updated_at = ?1
         WHERE id IN (SELECT id FROM registrations WHERE session_id = ?2 AND status = 'confirmed' AND kind = 'casual'
                      ORDER BY queued_at DESC, rowid DESC LIMIT ?3)
         RETURNING id, user_id, guest_name`,
      )
      .bind(now, sessionId, excess)
      .all<Promoted>();
    demoted = r.results;
  }
  return { promoted, demoted };
}

/** 管理員取消整場。 */
export async function cancelSession(env: Env, s: Session, reason: string | undefined): Promise<void> {
  if (s.status === 'cancelled') throw new UserError('這場已經取消了');
  if (s.status === 'done') throw new UserError('這場已經結束了');
  await env.DB.prepare(`UPDATE sessions SET status = 'cancelled', cancel_reason = ? WHERE id = ?`)
    .bind(reason ?? null, s.id)
    .run();
}

export interface RosterEntry {
  id: string;
  userId: string;
  name: string;
  kind: RegKind;
  status: RegStatus;
  guestName: string | null;
  /** 臨打報名時填的程度；沒填或季打為 null */
  level: number | null;
}

export interface Roster {
  confirmed: RosterEntry[];
  waitlist: RosterEntry[];
  leave: RosterEntry[];
}

interface RosterRow {
  id: string;
  session_id: string;
  user_id: string;
  kind: RegKind;
  status: RegStatus;
  guest_name: string | null;
  level: number | null;
  name: string;
}

/** 名單要的欄位與順序。where 是對 r 的條件；?1 一律是球團 id（用來帶出球團裡的暱稱）。 */
const rosterSql = (where: string): string =>
  `SELECT r.id, r.session_id, r.user_id, r.kind, r.status, r.guest_name, r.level,
          COALESCE(m.nickname, u.display_name) AS name
   FROM registrations r
   JOIN users u ON u.line_user_id = r.user_id
   LEFT JOIN club_members m ON m.club_id = ?1 AND m.user_id = r.user_id
   WHERE ${where} AND r.status <> 'cancelled'
   ORDER BY r.queued_at, r.rowid`;

/** 同一場的報名（已依報名先後排好）整理成正取／候補／請假三份名單。 */
function toRoster(rows: RosterRow[]): Roster {
  const entries: RosterEntry[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.guest_name ? `${r.guest_name}（${r.name} 的朋友）` : r.name,
    kind: r.kind,
    status: r.status,
    guestName: r.guest_name,
    level: r.level,
  }));
  // 正取名單中季打排前面，其餘維持報名先後
  const confirmed = entries
    .filter((e) => e.status === 'confirmed')
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'season' ? -1 : 1));
  return {
    confirmed,
    waitlist: entries.filter((e) => e.status === 'waitlist'),
    leave: entries.filter((e) => e.status === 'leave'),
  };
}

export async function roster(db: D1Database, clubId: string, sessionId: string): Promise<Roster> {
  const { results } = await db.prepare(rosterSql('r.session_id = ?2')).bind(clubId, sessionId).all<RosterRow>();
  return toRoster(results);
}

/** 報名頁上一場要顯示的東西。 */
export interface SessionOverview {
  session: Session;
  confirmed: number;
  waitlist: number;
  /** 這個人在這一場的報名（自己和幫朋友報的），依報名先後；position 是候補第幾位，不是候補就是 null */
  mine: { id: string; kind: RegKind; status: RegStatus; guestName: string | null; position: number | null }[];
  /** 報名中、已截止的場次直接附上名單；其他場次點進去才查 */
  roster: Roster | null;
}

// 報名頁要顯示的場次：還沒結束（包含已截止、已取消）的最近 8 場。?1 球團、?2 開始時間的下限、?3 現在。
// 下限讓 (club_id, start_at) 的索引直接從最近的場次讀起，不用把歷年的場次都掃過；
// 一場最長不到一天，所以還沒結束的場次一定是兩天內才開始的。
const UPCOMING = `FROM sessions WHERE club_id = ?1 AND start_at > ?2 AND end_at > ?3 AND status <> 'done' ORDER BY start_at LIMIT 8`;

/**
 * 報名頁載入時要的全部資料：場次、各場人數、自己的報名與候補順位、報名中／已截止場次的名單。
 * 這是最常被呼叫的請求，所以四句 SQL 用一次 batch 送出：只有一次資料庫往返，CPU 也省
 * （之前是每一場各查三、四次，正式環境量到 9–12 ms，貼著免費方案的 10 ms 上限）。
 */
export async function sessionsOverview(db: D1Database, clubId: string, userId: string, now = Date.now()): Promise<SessionOverview[]> {
  const base = [clubId, iso(now - 2 * 86_400_000), iso(now)];
  const [ses, cnt, mine, ros] = await db.batch([
    db.prepare(`SELECT * ${UPCOMING}`).bind(...base),
    db
      .prepare(
        `SELECT session_id, COALESCE(SUM(status = 'confirmed'), 0) AS confirmed, COALESCE(SUM(status = 'waitlist'), 0) AS waitlist
         FROM registrations WHERE session_id IN (SELECT id ${UPCOMING}) GROUP BY session_id`,
      )
      .bind(...base),
    db
      .prepare(
        // 候補順位的算法和 waitlistPosition() 一樣：同一場排在自己前面（含自己）的候補有幾筆
        `SELECT r.id, r.session_id, r.kind, r.status, r.guest_name,
                CASE WHEN r.status = 'waitlist' THEN
                  (SELECT COUNT(*) FROM registrations w
                   WHERE w.session_id = r.session_id AND w.status = 'waitlist'
                     AND (w.queued_at < r.queued_at OR (w.queued_at = r.queued_at AND w.rowid <= r.rowid)))
                END AS position
         FROM registrations r
         WHERE r.session_id IN (SELECT id ${UPCOMING}) AND r.user_id = ?4 AND r.status <> 'cancelled'
         ORDER BY r.queued_at, r.rowid`,
      )
      .bind(...base, userId),
    db.prepare(rosterSql(`r.session_id IN (SELECT id FROM (SELECT id, status ${UPCOMING}) WHERE status IN ('open', 'closed'))`)).bind(...base),
  ]);

  const group = <T extends { session_id: string }>(rows: T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.session_id, [...(m.get(r.session_id) ?? []), r]);
    return m;
  };
  type Count = { session_id: string; confirmed: number; waitlist: number };
  type Mine = { id: string; session_id: string; kind: RegKind; status: RegStatus; guest_name: string | null; position: number | null };
  const counts = group(cnt.results as Count[]);
  const mineBy = group(mine.results as Mine[]);
  const rosterBy = group(ros.results as RosterRow[]);

  return (ses.results as Session[]).map((s) => ({
    session: s,
    confirmed: counts.get(s.id)?.[0].confirmed ?? 0,
    waitlist: counts.get(s.id)?.[0].waitlist ?? 0,
    mine: (mineBy.get(s.id) ?? []).map((r) => ({ id: r.id, kind: r.kind, status: r.status, guestName: r.guest_name, position: r.position })),
    roster: s.status === 'open' || s.status === 'closed' ? toRoster(rosterBy.get(s.id) ?? []) : null,
  }));
}

/** 成員退出群組：取消他尚未開打的報名，季打改為請假，並處理遞補。 */
export async function releaseLeftMember(
  env: Env,
  clubId: string,
  userId: string,
): Promise<{ session: Session; promoted: Promoted }[]> {
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM registrations r JOIN sessions s ON s.id = r.session_id
     WHERE s.club_id = ? AND r.user_id = ? AND s.start_at > ?
       AND s.status NOT IN ('cancelled', 'done') AND r.status IN ('confirmed', 'waitlist')`,
  )
    .bind(clubId, userId, nowIso())
    .all<Registration>();
  const out: { session: Session; promoted: Promoted }[] = [];
  for (const reg of results) {
    const promoted = await changeAndPromote(env.DB, reg, reg.kind === 'season' ? 'leave' : 'cancelled');
    if (promoted) {
      const session = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(reg.session_id).first<Session>();
      if (session) out.push({ session, promoted });
    }
  }
  return out;
}
