// 管理員功能的規則：球團設定、時段、季期與季打名單、場次管理、點名收費、角色。
// 只處理資料與規則，不碰 HTTP，方便測試；路由在 admin.ts。

import type { Club, Env, Gender, RegKind, RegStatus, Registration, Role, Schedule, Season, Session } from './types';
import { EXTERNAL_PREFIX, UserError, isExternal, openNoticeEnabled } from './types';
import { advanceStatuses, generateSessions, regWindow, seedSeasonStmt, slotTimes } from './cron';
import { type Promoted, type QueueResult, casualFeeFor, changeAndPromote, rebalance, register, releaseLeftMember, unleave } from './service';
import { iso, localDate, nowIso } from './time';

// ---------- 輸入檢查 ----------

export function int(v: unknown, min: number, max: number, label: string): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new UserError(`${label}需為 ${min}–${max} 的整數`);
  }
  return n;
}

export function str(v: unknown, maxLen: number, label: string, required = true): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) {
    if (required) throw new UserError(`請填寫${label}`);
    return null;
  }
  if (s.length > maxLen) throw new UserError(`${label}最多 ${maxLen} 個字`);
  return s;
}

export function hhmm(v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new UserError(`${label}格式需為 HH:mm`);
  return v;
}

export function ymd(v: unknown, label: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new UserError(`${label}格式需為 YYYY-MM-DD`);
  }
  return v;
}

/** 臨打報名時選的性別：'M' / 'F'；空值 = 沒選。 */
export function gender(v: unknown): Gender | null {
  if (v === null || v === undefined || v === '') return null;
  if (v !== 'M' && v !== 'F') throw new UserError('性別只能是男或女');
  return v;
}

/** 臨打報名時填的程度：18 級羽球分級表的 1–18；空值 = 沒填。 */
export function level(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  return int(v, 1, 18, '程度');
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const WEEK = 7 * 24 * 60;

export interface Changes {
  promoted: { session: Session; p: Promoted }[];
  demoted: { session: Session; p: Promoted }[];
}
const noChanges = (): Changes => ({ promoted: [], demoted: [] });

async function rebalanceInto(db: D1Database, s: Session, out: Changes): Promise<void> {
  const r = await rebalance(db, s.id);
  for (const p of r.promoted) out.promoted.push({ session: s, p });
  for (const p of r.demoted) out.demoted.push({ session: s, p });
}

/** 尚未開打、未取消的場次。 */
function futureSessionsWhere(extra: string): string {
  return `SELECT * FROM sessions WHERE club_id = ?1 AND start_at > ?2 AND status NOT IN ('cancelled', 'done') ${extra} ORDER BY start_at`;
}

// ---------- 球團設定 ----------

export async function updateSettings(env: Env, club: Club, input: Record<string, unknown>): Promise<Club> {
  const next: Club = { ...club };
  if (has(input, 'name')) next.name = str(input.name, 30, '球團名稱')!;
  if (has(input, 'casualFee')) next.casual_fee = int(input.casualFee, 0, 100_000, '臨打費');
  if (has(input, 'casualFeeFemale')) {
    const v = input.casualFeeFemale;
    next.casual_fee_female = v === null || v === '' ? null : int(v, 0, 100_000, '女生臨打費');
  }
  if (has(input, 'rules')) next.rules = str(input.rules, 1000, '球團規則', false);
  if (has(input, 'ledgerVisible')) next.ledger_visible = input.ledgerVisible ? 1 : 0;
  // 開放報名通知鎖住時不改開關（設定頁不會送這一欄；還開著舊頁面的人送來的也不理）
  if (has(input, 'notifyOnOpen') && openNoticeEnabled(env)) next.notify_on_open = input.notifyOnOpen ? 1 : 0;
  if (has(input, 'regOpenDaysBefore')) next.reg_open_days_before = int(input.regOpenDaysBefore, 0, 30, '開放天數');
  if (has(input, 'regOpenTime')) next.reg_open_time = hhmm(input.regOpenTime, '開放時刻');
  if (has(input, 'regCloseMinutesBefore')) next.reg_close_minutes_before = int(input.regCloseMinutesBefore, 0, WEEK, '截止分鐘');
  if (has(input, 'cancelDeadlineMinutesBefore')) {
    const v = input.cancelDeadlineMinutesBefore;
    next.cancel_deadline_minutes_before = v === null || v === '' ? null : int(v, 0, WEEK, '取消期限');
  }
  await env.DB.prepare(
    `UPDATE clubs SET name = ?, casual_fee = ?, casual_fee_female = ?, rules = ?, ledger_visible = ?, notify_on_open = ?, reg_open_days_before = ?, reg_open_time = ?,
       reg_close_minutes_before = ?, cancel_deadline_minutes_before = ? WHERE id = ?`,
  )
    .bind(next.name, next.casual_fee, next.casual_fee_female, next.rules, next.ledger_visible, next.notify_on_open, next.reg_open_days_before, next.reg_open_time, next.reg_close_minutes_before, next.cancel_deadline_minutes_before, club.id)
    .run();
  if (
    next.reg_open_days_before !== club.reg_open_days_before ||
    next.reg_open_time !== club.reg_open_time ||
    next.reg_close_minutes_before !== club.reg_close_minutes_before
  ) {
    await recomputeWindows(env, next);
  }
  return next;
}

/** 報名規則改變後，重算未開打場次的開放與截止時間，並重新推進狀態。 */
export async function recomputeWindows(env: Env, club: Club, now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare(futureSessionsWhere('')).bind(club.id, iso(now)).all<Session>();
  if (!results.length) return;
  await env.DB.batch(
    results.map((s) => {
      const { openTs, closeTs } = regWindow(club, Date.parse(s.start_at));
      return env.DB.prepare(`UPDATE sessions SET reg_open_at = ?, reg_close_at = ?, status = 'scheduled' WHERE id = ?`).bind(
        iso(openTs),
        iso(closeTs),
        s.id,
      );
    }),
  );
  await advanceStatuses(env, now);
}

// ---------- 每週時段 ----------

function scheduleFields(input: Record<string, unknown>, base?: Schedule) {
  const pick = <T>(k: string, f: (v: unknown) => T, fallback: T | undefined): T => {
    if (has(input, k)) return f(input[k]);
    if (fallback === undefined) throw new UserError(`缺少欄位 ${k}`);
    return fallback;
  };
  return {
    startTime: pick('startTime', (v) => hhmm(v, '開始時間'), base?.start_time),
    endTime: pick('endTime', (v) => hhmm(v, '結束時間'), base?.end_time),
    venue: pick('venue', (v) => str(v, 40, '場地', false), base ? base.venue : null),
    courtNo: pick('courtNo', (v) => str(v, 20, '第幾場地', false), base ? base.court_no : null),
    courts: pick('courts', (v) => int(v, 1, 50, '場地數'), base?.courts),
    capacity: pick('capacity', (v) => int(v, 1, 200, '人數上限'), base?.capacity),
  };
}

export async function listSchedules(env: Env, club: Club): Promise<Schedule[]> {
  const { results } = await env.DB.prepare('SELECT * FROM schedules WHERE club_id = ? ORDER BY active DESC, weekday, start_time')
    .bind(club.id)
    .all<Schedule>();
  return results;
}

export async function createSchedule(env: Env, club: Club, input: Record<string, unknown>, now = Date.now()): Promise<Schedule> {
  const weekday = int(input.weekday, 0, 6, '星期');
  const f = scheduleFields(input);
  const id = `sch_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO schedules (id, club_id, weekday, start_time, end_time, venue, court_no, courts, capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, club.id, weekday, f.startTime, f.endTime, f.venue, f.courtNo, f.courts, f.capacity)
    .run();
  await generateSessions(env, now, club.id);
  await advanceStatuses(env, now);
  return (await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(id).first<Schedule>())!;
}

/**
 * 修改時段（星期不能改，要換星期請停用後新增）。
 * 已產生、尚未開打的場次會一起套用新的時間、場地與上限；第幾場地有改才套用，不蓋掉單場另外改過的。
 */
export async function updateSchedule(
  env: Env,
  club: Club,
  scheduleId: string,
  input: Record<string, unknown>,
  now = Date.now(),
): Promise<Changes> {
  const sc = await env.DB.prepare('SELECT * FROM schedules WHERE id = ? AND club_id = ?').bind(scheduleId, club.id).first<Schedule>();
  if (!sc) throw new UserError('找不到這個時段');
  if (has(input, 'weekday') && Number(input.weekday) !== sc.weekday) {
    throw new UserError('星期不能修改，請停用這個時段後新增一個');
  }
  const f = scheduleFields(input, sc);
  await env.DB.prepare('UPDATE schedules SET start_time = ?, end_time = ?, venue = ?, court_no = ?, courts = ?, capacity = ? WHERE id = ?')
    .bind(f.startTime, f.endTime, f.venue, f.courtNo, f.courts, f.capacity, sc.id)
    .run();

  const { results } = await env.DB.prepare(futureSessionsWhere('AND schedule_id = ?3')).bind(club.id, iso(now), sc.id).all<Session>();
  const out = noChanges();
  for (const s of results) {
    const date = localDate(Date.parse(s.start_at), club.timezone);
    const { startTs, endTs } = slotTimes(club, date, f.startTime, f.endTime);
    const { openTs, closeTs } = regWindow(club, startTs);
    await env.DB.prepare(
      `UPDATE sessions SET start_at = ?, end_at = ?, venue = ?, court_no = ?, courts = ?, capacity = ?, reg_open_at = ?, reg_close_at = ?, status = 'scheduled'
       WHERE id = ?`,
    )
      .bind(iso(startTs), iso(endTs), f.venue, f.courtNo !== sc.court_no ? f.courtNo : s.court_no, f.courts, f.capacity, iso(openTs), iso(closeTs), s.id)
      .run();
    if (f.capacity !== s.capacity) await rebalanceInto(env.DB, { ...s, capacity: f.capacity }, out);
  }
  await advanceStatuses(env, now);
  return out;
}

/**
 * 停用或啟用時段。停用時，還沒有臨打報名的未來場次直接刪除；
 * 已有人報名的場次保留，回傳數量讓管理員決定要不要取消。
 */
export async function setScheduleActive(
  env: Env,
  club: Club,
  scheduleId: string,
  active: boolean,
  now = Date.now(),
): Promise<{ removed: number; kept: number }> {
  const sc = await env.DB.prepare('SELECT * FROM schedules WHERE id = ? AND club_id = ?').bind(scheduleId, club.id).first<Schedule>();
  if (!sc) throw new UserError('找不到這個時段');
  await env.DB.prepare('UPDATE schedules SET active = ? WHERE id = ?').bind(active ? 1 : 0, sc.id).run();
  if (active) {
    await generateSessions(env, now, club.id);
    await advanceStatuses(env, now);
    return { removed: 0, kept: 0 };
  }
  const { results } = await env.DB.prepare(futureSessionsWhere('AND schedule_id = ?3')).bind(club.id, iso(now), sc.id).all<Session>();
  let removed = 0;
  let kept = 0;
  for (const s of results) {
    const casual = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM registrations WHERE session_id = ? AND kind = 'casual' AND status <> 'cancelled'`,
    )
      .bind(s.id)
      .first<{ n: number }>();
    if (casual?.n) {
      kept++;
      continue;
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM registrations WHERE session_id = ?').bind(s.id),
      env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.id),
    ]);
    removed++;
  }
  return { removed, kept };
}

// ---------- 季期與季打名單 ----------

export interface SeasonView extends Season {
  /** feeExempt = 不收季費；external = 不在 LINE 上、由管理員手動加入的人 */
  members: { userId: string; name: string; feePaid: boolean; paidAt: string | null; feeExempt: boolean; external: boolean }[];
}

export async function listSeasons(env: Env, club: Club): Promise<SeasonView[]> {
  const { results: seasons } = await env.DB.prepare('SELECT * FROM seasons WHERE club_id = ? ORDER BY start_date DESC')
    .bind(club.id)
    .all<Season>();
  const out: SeasonView[] = [];
  for (const se of seasons) {
    const { results } = await env.DB.prepare(
      `SELECT sm.user_id, COALESCE(m.nickname, u.display_name) AS name, sm.fee_paid, sm.paid_at, sm.fee_exempt
       FROM season_members sm
       JOIN users u ON u.line_user_id = sm.user_id
       LEFT JOIN club_members m ON m.club_id = ? AND m.user_id = sm.user_id
       WHERE sm.season_id = ? ORDER BY name`,
    )
      .bind(club.id, se.id)
      .all<{ user_id: string; name: string; fee_paid: number; paid_at: string | null; fee_exempt: number }>();
    out.push({
      ...se,
      members: results.map((r) => ({
        userId: r.user_id,
        name: r.name,
        feePaid: !!r.fee_paid,
        paidAt: r.paid_at,
        feeExempt: !!r.fee_exempt,
        external: isExternal(r.user_id),
      })),
    });
  }
  return out;
}

export async function createSeason(env: Env, club: Club, input: Record<string, unknown>, now = Date.now()): Promise<Season> {
  const name = str(input.name, 30, '季期名稱')!;
  const startDate = ymd(input.startDate, '開始日期');
  const endDate = ymd(input.endDate, '結束日期');
  const fee = int(input.fee, 0, 1_000_000, '季費');
  if (endDate < startDate) throw new UserError('結束日期不能早於開始日期');
  const overlap = await env.DB.prepare(
    'SELECT name FROM seasons WHERE club_id = ? AND NOT (end_date < ? OR start_date > ?) LIMIT 1',
  )
    .bind(club.id, startDate, endDate)
    .first<{ name: string }>();
  if (overlap) throw new UserError(`日期和「${overlap.name}」重疊`);
  const id = `sea_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare('INSERT INTO seasons (id, club_id, name, start_date, end_date, fee) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, club.id, name, startDate, endDate, fee)
    .run();
  await generateSessions(env, now, club.id); // 讓已產生的場次掛上這個季期
  return (await env.DB.prepare('SELECT * FROM seasons WHERE id = ?').bind(id).first<Season>())!;
}

/** 季期只開放修改名稱與季費；日期影響已排好的場次，要改日期請刪掉重建。 */
export async function updateSeason(env: Env, club: Club, seasonId: string, input: Record<string, unknown>): Promise<void> {
  const se = await getSeason(env, club, seasonId);
  const name = has(input, 'name') ? str(input.name, 30, '季期名稱')! : se.name;
  const fee = has(input, 'fee') ? int(input.fee, 0, 1_000_000, '季費') : se.fee;
  await env.DB.prepare('UPDATE seasons SET name = ?, fee = ? WHERE id = ?').bind(name, fee, se.id).run();
}

async function getSeason(env: Env, club: Club, seasonId: string): Promise<Season> {
  const se = await env.DB.prepare('SELECT * FROM seasons WHERE id = ? AND club_id = ?').bind(seasonId, club.id).first<Season>();
  if (!se) throw new UserError('找不到這個季期');
  return se;
}

/** 加入季打成員，並立即在這季未開打的場次佔位（超額時退回最後報名的臨打）。不在 LINE 上的人不收季費。 */
export async function addSeasonMembers(
  env: Env,
  club: Club,
  seasonId: string,
  userIds: string[],
  now = Date.now(),
): Promise<Changes> {
  const se = await getSeason(env, club, seasonId);
  if (!userIds.length) throw new UserError('請選擇成員');
  for (const uid of userIds) {
    const m = await env.DB.prepare('SELECT 1 AS ok FROM club_members WHERE club_id = ? AND user_id = ?').bind(club.id, uid).first();
    if (!m) throw new UserError('只能加入球團成員');
  }
  await env.DB.batch(
    userIds.map((uid) =>
      env.DB.prepare('INSERT OR IGNORE INTO season_members (season_id, user_id, fee_exempt) VALUES (?, ?, ?)').bind(se.id, uid, isExternal(uid) ? 1 : 0),
    ),
  );

  const nowStr = iso(now);
  const { results: sessions } = await env.DB.prepare(futureSessionsWhere('AND season_id = ?3')).bind(club.id, nowStr, se.id).all<Session>();
  const out = noChanges();
  for (const s of sessions) {
    const stmts: D1PreparedStatement[] = [seedSeasonStmt(env.DB, s.id, se.id, nowStr)];
    for (const uid of userIds) {
      // 之前被移出季打（那筆是 cancelled）又加回來：恢復為正取
      stmts.push(
        env.DB.prepare(
          `UPDATE registrations SET status = 'confirmed', queued_at = ?, updated_at = ?
           WHERE id = ? AND kind = 'season' AND status = 'cancelled'`,
        ).bind(nowStr, nowStr, `${s.id}_s_${uid}`),
      );
      // 原本以臨打身分報名這場：季打那筆取代它
      stmts.push(
        env.DB.prepare(
          `UPDATE registrations SET status = 'cancelled', updated_at = ?
           WHERE session_id = ? AND user_id = ? AND kind = 'casual' AND guest_name IS NULL AND status <> 'cancelled'`,
        ).bind(nowStr, s.id, uid),
      );
    }
    await env.DB.batch(stmts);
    // 臨打那筆若佔著唯一索引，季打那筆在上一步才寫得進去；再補一次
    await seedSeasonStmt(env.DB, s.id, se.id, nowStr).run();
    await rebalanceInto(env.DB, s, out);
  }
  return out;
}

/**
 * 把不在 LINE 上的人（例如教練）加進季打：佔一個季打名額、出現在名單上，不收季費。
 * 球團裡已經有同名的非 LINE 成員就沿用，沒有才建立。
 */
export async function addExternalSeasonMember(
  env: Env,
  club: Club,
  seasonId: string,
  name: unknown,
  now = Date.now(),
): Promise<{ userId: string; name: string; changes: Changes }> {
  await getSeason(env, club, seasonId); // 先確認季期存在，免得建了人卻加不進去
  const n = str(name, 20, '名字')!;
  const { results } = await env.DB.prepare(
    `SELECT m.user_id, COALESCE(m.nickname, u.display_name) AS name FROM club_members m
     JOIN users u ON u.line_user_id = m.user_id WHERE m.club_id = ?`,
  )
    .bind(club.id)
    .all<{ user_id: string; name: string }>();
  let userId = results.find((r) => isExternal(r.user_id) && r.name === n)?.user_id;
  if (!userId) {
    userId = `${EXTERNAL_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    const nowStr = iso(now);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (line_user_id, display_name, updated_at) VALUES (?, ?, ?)').bind(userId, n, nowStr),
      env.DB.prepare(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`).bind(club.id, userId, nowStr),
    ]);
  }
  return { userId, name: n, changes: await addSeasonMembers(env, club, seasonId, [userId], now) };
}

/** 移出季打成員：這季未開打的場次取消他的名額並遞補。 */
export async function removeSeasonMember(
  env: Env,
  club: Club,
  seasonId: string,
  userId: string,
  now = Date.now(),
): Promise<Changes> {
  const se = await getSeason(env, club, seasonId);
  await env.DB.prepare('DELETE FROM season_members WHERE season_id = ? AND user_id = ?').bind(se.id, userId).run();
  const { results } = await env.DB.prepare(
    `SELECT r.* FROM registrations r JOIN sessions s ON s.id = r.session_id
     WHERE s.club_id = ?1 AND s.start_at > ?2 AND s.status NOT IN ('cancelled', 'done')
       AND s.season_id = ?3 AND r.user_id = ?4 AND r.kind = 'season' AND r.status <> 'cancelled'`,
  )
    .bind(club.id, iso(now), se.id, userId)
    .all<Registration>();
  const out = noChanges();
  for (const reg of results) {
    const p = await changeAndPromote(env.DB, reg, 'cancelled');
    const s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ?').bind(reg.session_id).first<Session>();
    if (p && s) out.promoted.push({ session: s, p });
  }
  return out;
}

export async function setSeasonFeePaid(env: Env, club: Club, seasonId: string, userId: string, paid: boolean): Promise<void> {
  const se = await getSeason(env, club, seasonId);
  const sm = await env.DB.prepare('SELECT fee_exempt FROM season_members WHERE season_id = ? AND user_id = ?')
    .bind(se.id, userId)
    .first<{ fee_exempt: number }>();
  if (sm?.fee_exempt) throw new UserError('這位不收季費');
  await env.DB.prepare('UPDATE season_members SET fee_paid = ?, paid_at = ? WHERE season_id = ? AND user_id = ?')
    .bind(paid ? 1 : 0, paid ? nowIso() : null, se.id, userId)
    .run();
}

// ---------- 場次管理 ----------

export interface AdminSessionView extends Session {
  confirmed: number;
  waitlist: number;
  leave: number;
}

/** 管理用場次清單：近兩週已結束的（方便補點名）＋未來場次。 */
export async function listAdminSessions(env: Env, club: Club, now = Date.now()): Promise<AdminSessionView[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.*,
       (SELECT COUNT(*) FROM registrations r WHERE r.session_id = s.id AND r.status = 'confirmed') AS confirmed,
       (SELECT COUNT(*) FROM registrations r WHERE r.session_id = s.id AND r.status = 'waitlist') AS waitlist,
       (SELECT COUNT(*) FROM registrations r WHERE r.session_id = s.id AND r.status = 'leave') AS leave
     FROM sessions s WHERE s.club_id = ? AND s.end_at > ? ORDER BY s.start_at LIMIT 30`,
  )
    .bind(club.id, iso(now - 14 * 86_400_000))
    .all<AdminSessionView>();
  return results;
}

export async function getSessionOrThrow(env: Env, club: Club, sessionId: string): Promise<Session> {
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND club_id = ?').bind(sessionId, club.id).first<Session>();
  if (!s) throw new UserError('找不到這個場次');
  return s;
}

/** 臨時加場：沒有季打佔位，全部開放臨打。 */
export async function createExtraSession(env: Env, club: Club, input: Record<string, unknown>, now = Date.now()): Promise<Session> {
  const date = ymd(input.date, '日期');
  const { startTs, endTs } = slotTimes(club, date, hhmm(input.startTime, '開始時間'), hhmm(input.endTime, '結束時間'));
  if (endTs <= now) throw new UserError('這個時間已經過了');
  const venue = str(input.venue, 40, '場地', false);
  const courtNo = str(input.courtNo, 20, '第幾場地', false);
  const courts = int(input.courts, 1, 50, '場地數');
  const capacity = int(input.capacity, 1, 200, '人數上限');
  const { openTs, closeTs } = regWindow(club, startTs);
  const id = `x_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO sessions (id, club_id, schedule_id, season_id, start_at, end_at, venue, court_no, courts, capacity, reg_open_at, reg_close_at, status)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
  )
    .bind(id, club.id, iso(startTs), iso(endTs), venue, courtNo, courts, capacity, iso(openTs), iso(closeTs))
    .run();
  await advanceStatuses(env, now);
  return getSessionOrThrow(env, club, id);
}

export async function setSessionCapacity(env: Env, club: Club, sessionId: string, capacity: unknown): Promise<Changes> {
  const s = await getSessionOrThrow(env, club, sessionId);
  if (s.status === 'cancelled' || s.status === 'done') throw new UserError('這場已取消或結束');
  const cap = int(capacity, 1, 200, '人數上限');
  await env.DB.prepare('UPDATE sessions SET capacity = ? WHERE id = ?').bind(cap, s.id).run();
  const out = noChanges();
  await rebalanceInto(env.DB, { ...s, capacity: cap }, out);
  return out;
}

/** 單場修改第幾場地（每週拿到的場地不固定時用）；空值 = 清除。回傳存進去的值。 */
export async function setSessionCourt(env: Env, club: Club, sessionId: string, courtNo: unknown): Promise<string | null> {
  const s = await getSessionOrThrow(env, club, sessionId);
  if (s.status === 'cancelled' || s.status === 'done') throw new UserError('這場已取消或結束');
  const saved = str(courtNo, 20, '第幾場地', false);
  await env.DB.prepare('UPDATE sessions SET court_no = ? WHERE id = ?').bind(saved, s.id).run();
  return saved;
}

/** 管理員代成員報名（不受開放、截止時間限制）。fields = 報名時選的臨打費（性別）與程度。 */
export async function adminRegister(
  env: Env,
  club: Club,
  sessionId: string,
  userId: string,
  guestName?: string,
  fields: { gender?: Gender | null; level?: number | null } = {},
): Promise<QueueResult> {
  const s = await getSessionOrThrow(env, club, sessionId);
  const m = await env.DB.prepare('SELECT 1 AS ok FROM club_members WHERE club_id = ? AND user_id = ?').bind(club.id, userId).first();
  if (!m) throw new UserError('只能幫球團成員報名');
  return register(env, club, s, userId, guestName, { byAdmin: true, ...fields });
}

/** 管理員取消任一筆報名：臨打改為取消，季打改為請假；不受取消期限限制。 */
export async function adminCancelRegistration(
  env: Env,
  club: Club,
  sessionId: string,
  registrationId: string,
): Promise<Changes> {
  const s = await getSessionOrThrow(env, club, sessionId);
  if (s.status === 'cancelled' || s.status === 'done') throw new UserError('這場已取消或結束');
  const reg = await env.DB.prepare(`SELECT * FROM registrations WHERE id = ? AND session_id = ? AND status <> 'cancelled'`)
    .bind(registrationId, s.id)
    .first<Registration>();
  if (!reg) throw new UserError('找不到這筆報名');
  if (reg.status === 'leave') throw new UserError('這位季打已經請假了');
  const p = await changeAndPromote(env.DB, reg, reg.kind === 'season' ? 'leave' : 'cancelled');
  const out = noChanges();
  if (p) out.promoted.push({ session: s, p });
  return out;
}

/** 管理員代季打成員銷假（不在 LINE 上的人只能這樣銷假）。規則和自己銷假相同。 */
export async function adminUnleave(env: Env, club: Club, sessionId: string, registrationId: string): Promise<QueueResult> {
  const s = await getSessionOrThrow(env, club, sessionId);
  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ? AND session_id = ?').bind(registrationId, s.id).first<Registration>();
  if (!reg || reg.kind !== 'season' || reg.status !== 'leave') throw new UserError('這位沒有請假');
  return unleave(env, s, reg.user_id);
}

// ---------- 點名與收費 ----------

export interface AttendanceRow {
  id: string;
  userId: string;
  name: string;
  kind: RegKind;
  status: RegStatus;
  attended: boolean | null;
  feeAmount: number | null;
  feePaid: boolean;
  /** 臨打報名時填的程度；沒填或季打為 null */
  level: number | null;
  /** 臨打勾已收、金額沒填時會帶入的金額；季打為 null */
  defaultFee: number | null;
}

/** 點名名單：正取的人（季打在前）。 */
export async function attendanceList(env: Env, club: Club, sessionId: string): Promise<{ session: Session; rows: AttendanceRow[] }> {
  const s = await getSessionOrThrow(env, club, sessionId);
  const { results } = await env.DB.prepare(
    `SELECT r.*, COALESCE(m.nickname, u.display_name) AS name
     FROM registrations r
     JOIN users u ON u.line_user_id = r.user_id
     LEFT JOIN club_members m ON m.club_id = ? AND m.user_id = r.user_id
     WHERE r.session_id = ? AND r.status = 'confirmed'
     ORDER BY r.kind DESC, r.queued_at, r.rowid`,
  )
    .bind(club.id, s.id)
    .all<Registration & { name: string }>();
  return {
    session: s,
    rows: results.map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.guest_name ? `${r.guest_name}（${r.name} 的朋友）` : r.name,
      kind: r.kind,
      status: r.status,
      attended: r.attended === null ? null : !!r.attended,
      feeAmount: r.fee_amount,
      feePaid: !!r.fee_paid,
      level: r.level,
      defaultFee: r.kind === 'casual' ? casualFeeFor(club, r.gender) : null,
    })),
  };
}

/** 記錄出席與臨打收費。勾已收時，金額沒填就帶入球團的臨打費（報名時選女生的用女生臨打費）。 */
export async function setAttendance(
  env: Env,
  club: Club,
  sessionId: string,
  registrationId: string,
  input: Record<string, unknown>,
  actorId: string,
): Promise<void> {
  const s = await getSessionOrThrow(env, club, sessionId);
  if (s.status === 'cancelled') throw new UserError('這場已取消');
  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ? AND session_id = ?').bind(registrationId, s.id).first<Registration>();
  if (!reg) throw new UserError('找不到這筆報名');

  let attended = reg.attended;
  let feePaid = reg.fee_paid;
  let feeAmount = reg.fee_amount;
  if (has(input, 'attended')) attended = input.attended === null ? null : input.attended ? 1 : 0;
  if (has(input, 'feeAmount')) feeAmount = input.feeAmount === null || input.feeAmount === '' ? null : int(input.feeAmount, 0, 100_000, '金額');
  if (has(input, 'feePaid')) {
    if (reg.kind === 'season') throw new UserError('季打成員繳的是季費，請到季打名單登記');
    feePaid = input.feePaid ? 1 : 0;
    if (feePaid && feeAmount === null) feeAmount = casualFeeFor(club, reg.gender);
    if (feePaid && attended === null) attended = 1; // 有收錢就是有來
  }
  await env.DB.prepare(
    'UPDATE registrations SET attended = ?, fee_paid = ?, fee_amount = ?, fee_recorded_by = ?, updated_at = ? WHERE id = ?',
  )
    .bind(attended, feePaid, feeAmount, actorId, nowIso(), reg.id)
    .run();
}

// ---------- 成員與角色 ----------

export interface MemberView {
  userId: string;
  displayName: string;
  nickname: string | null;
  role: Role;
  /** 不在 LINE 上、由管理員手動加入的人：不能當管理員，可以從成員名單移除 */
  external: boolean;
}

export async function listMembers(env: Env, club: Club): Promise<MemberView[]> {
  const { results } = await env.DB.prepare(
    `SELECT m.user_id, u.display_name, m.nickname, m.role FROM club_members m
     JOIN users u ON u.line_user_id = m.user_id
     WHERE m.club_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, COALESCE(m.nickname, u.display_name)`,
  )
    .bind(club.id)
    .all<{ user_id: string; display_name: string; nickname: string | null; role: Role }>();
  return results.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    nickname: r.nickname,
    role: r.role,
    external: isExternal(r.user_id),
  }));
}

export async function setNickname(env: Env, club: Club, userId: string, nickname: unknown): Promise<void> {
  const nick = str(nickname, 20, '暱稱', false);
  await env.DB.prepare('UPDATE club_members SET nickname = ? WHERE club_id = ? AND user_id = ?').bind(nick, club.id, userId).run();
}

/** 只有擁有者能指定或移除管理員。 */
export async function setRole(env: Env, club: Club, actorRole: Role, userId: string, role: unknown): Promise<void> {
  if (actorRole !== 'owner') throw new UserError('只有擁有者可以設定管理員');
  if (role !== 'admin' && role !== 'member') throw new UserError('角色只能是管理員或一般成員');
  if (isExternal(userId)) throw new UserError('不在 LINE 上的人不能設為管理員');
  await env.DB.prepare(`UPDATE club_members SET role = ? WHERE club_id = ? AND user_id = ? AND role <> 'owner'`)
    .bind(role, club.id, userId)
    .run();
}

/** 轉移擁有者：新擁有者必須是成員，原擁有者改為管理員。 */
export async function transferOwner(env: Env, club: Club, actorId: string, actorRole: Role, newOwnerId: string): Promise<void> {
  if (actorRole !== 'owner') throw new UserError('只有擁有者可以轉移');
  if (newOwnerId === actorId) throw new UserError('你已經是擁有者了');
  if (isExternal(newOwnerId)) throw new UserError('不能轉移給不在 LINE 上的人');
  const m = await env.DB.prepare('SELECT 1 AS ok FROM club_members WHERE club_id = ? AND user_id = ?').bind(club.id, newOwnerId).first();
  if (!m) throw new UserError('只能轉移給球團成員');
  await env.DB.batch([
    env.DB.prepare(`UPDATE club_members SET role = 'admin' WHERE club_id = ? AND user_id = ?`).bind(club.id, actorId),
    env.DB.prepare(`UPDATE club_members SET role = 'owner' WHERE club_id = ? AND user_id = ?`).bind(club.id, newOwnerId),
  ]);
}

/**
 * 從成員名單移除手動加入的非 LINE 成員（LINE 上的成員不能移除）。
 * 還在沒結束的季期裡要先移出季打；他尚未開打的報名會取消並遞補，過去的紀錄保留。
 */
export async function removeExternalMember(env: Env, club: Club, userId: string, now = Date.now()): Promise<Changes> {
  if (!isExternal(userId)) throw new UserError('只能移除不在 LINE 上的人');
  const m = await env.DB.prepare('SELECT 1 AS ok FROM club_members WHERE club_id = ? AND user_id = ?').bind(club.id, userId).first();
  if (!m) throw new UserError('找不到這位成員');
  const season = await env.DB.prepare(
    `SELECT se.name FROM season_members sm JOIN seasons se ON se.id = sm.season_id
     WHERE se.club_id = ? AND sm.user_id = ? AND se.end_date >= ? LIMIT 1`,
  )
    .bind(club.id, userId, localDate(now, club.timezone))
    .first<{ name: string }>();
  if (season) throw new UserError(`他還在「${season.name}」的季打名單裡，請先到「季打」把他移出`);
  const out = noChanges();
  for (const { session, promoted } of await releaseLeftMember(env, club.id, userId)) out.promoted.push({ session, p: promoted });
  await env.DB.prepare('DELETE FROM club_members WHERE club_id = ? AND user_id = ?').bind(club.id, userId).run();
  return out;
}

// ---------- 刪除球團 ----------

/**
 * 刪除整個球團（只有擁有者可以）：成員名單、時段、季期與季打名單、場次與報名、記帳、設定全部刪掉，無法復原。
 * confirmName 要和球團名稱一模一樣才會執行。刪除後，群組可以重新「/綁定」一個新的球團。
 * audit_logs 保留（查得到是誰在什麼時候刪的）；LINE 使用者的基本資料也保留，手動建立的非 LINE 成員沒有別處用到就一併清掉。
 * 回傳刪掉的筆數，寫進稽核紀錄用。
 */
export async function deleteClub(env: Env, club: Club, actorRole: Role, confirmName: unknown): Promise<Record<string, number>> {
  if (actorRole !== 'owner') throw new UserError('只有擁有者可以刪除球團');
  if (typeof confirmName !== 'string' || confirmName.trim() !== club.name) throw new UserError('輸入的球團名稱不一樣，沒有刪除');
  const removed = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM club_members WHERE club_id = ?1) AS members,
            (SELECT COUNT(*) FROM schedules WHERE club_id = ?1) AS schedules,
            (SELECT COUNT(*) FROM seasons WHERE club_id = ?1) AS seasons,
            (SELECT COUNT(*) FROM sessions WHERE club_id = ?1) AS sessions,
            (SELECT COUNT(*) FROM registrations WHERE session_id IN (SELECT id FROM sessions WHERE club_id = ?1)) AS registrations,
            (SELECT COUNT(*) FROM ledger_entries WHERE club_id = ?1) AS ledgerEntries,
            (SELECT COUNT(*) FROM draws WHERE club_id = ?1) AS draws`,
  )
    .bind(club.id)
    .first<Record<string, number>>();
  const del = (sql: string) => env.DB.prepare(sql).bind(club.id);
  // 同一個交易裡依外鍵順序刪：先刪參照別人的那一邊
  await env.DB.batch([
    del('DELETE FROM registrations WHERE session_id IN (SELECT id FROM sessions WHERE club_id = ?)'),
    del('DELETE FROM sessions WHERE club_id = ?'),
    del('DELETE FROM season_members WHERE season_id IN (SELECT id FROM seasons WHERE club_id = ?)'),
    del('DELETE FROM seasons WHERE club_id = ?'),
    del('DELETE FROM schedules WHERE club_id = ?'),
    del('DELETE FROM ledger_entries WHERE club_id = ?'),
    del('DELETE FROM draw_entries WHERE draw_id IN (SELECT id FROM draws WHERE club_id = ?)'),
    del('DELETE FROM draws WHERE club_id = ?'),
    del('DELETE FROM club_members WHERE club_id = ?'),
    del('DELETE FROM clubs WHERE id = ?'),
    env.DB.prepare(
      `DELETE FROM users WHERE substr(line_user_id, 1, ?1) = ?2
         AND line_user_id NOT IN (SELECT user_id FROM club_members)
         AND line_user_id NOT IN (SELECT user_id FROM season_members)
         AND line_user_id NOT IN (SELECT user_id FROM registrations)`,
    ).bind(EXTERNAL_PREFIX.length, EXTERNAL_PREFIX),
  ]);
  return removed ?? {};
}
