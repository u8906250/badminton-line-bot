// 記帳：季打費、臨打費的收入從繳費紀錄彙總；場地費、羽球費等收支用 ledger_entries 手動登記。
// 只處理資料與規則，不碰 HTTP，方便測試；路由在 admin.ts。

import type { Club, Env, LedgerCategory, LedgerEntry, Role } from './types';
import { UserError, isAdmin } from './types';
import { int, str, ymd } from './manage';
import { casualFeeFor } from './service';
import { addDays, iso, localDate, nowIso, zonedToUtc } from './time';

const CATEGORIES: readonly LedgerCategory[] = ['venue', 'shuttle', 'other_expense', 'other_income'];

/**
 * 誰可以看帳本（唯讀）：管理員，以及季打成員。新增、刪除只有管理員可以（路由在 admin.ts）。
 * 球團在「設定」關掉「讓季打成員看帳本」（clubs.ledger_visible = 0）時，只有管理員看得到。
 * 季打成員 = 在還沒結束的季期（進行中或之後的）名單上的人；
 * 球團沒有這樣的季期時（兩季之間的空檔），看最後一季的名單，免得空檔期間大家突然看不到。
 */
export async function canViewLedger(env: Env, club: Club, userId: string, role: Role, now = Date.now()): Promise<boolean> {
  if (isAdmin(role)) return true;
  if (!club.ledger_visible) return false;
  // 從這個球團自己的季期查起（idx_seasons_club），再用主鍵看這個人在不在名單上；
  // 寫成 JOIN 的話 SQLite 會從 season_members 掃起，把所有球團的季打名單都讀一遍
  const r = await env.DB.prepare(
    `SELECT 1 AS ok FROM seasons se
     WHERE se.club_id = ?1
       AND EXISTS (SELECT 1 FROM season_members sm WHERE sm.season_id = se.id AND sm.user_id = ?2)
       AND (se.end_date >= ?3
            OR (NOT EXISTS (SELECT 1 FROM seasons x WHERE x.club_id = ?1 AND x.end_date >= ?3)
                AND se.start_date = (SELECT MAX(start_date) FROM seasons WHERE club_id = ?1)))
     LIMIT 1`,
  )
    .bind(club.id, userId, localDate(now, club.timezone))
    .first();
  return !!r;
}

/** 統計期間：球團時區的日期，含頭尾；null = 不限。 */
export interface Period {
  from: string | null;
  to: string | null;
}

/**
 * 查詢參數 → 期間。all = 不限；有 from / to 就照給的；
 * 都沒給時，今天落在哪個季期就看那一季，不在任何季期內則不限。
 */
export async function resolvePeriod(
  env: Env,
  club: Club,
  q: Record<string, string | undefined>,
  now = Date.now(),
): Promise<Period> {
  if (q.all) return { from: null, to: null };
  if (q.from || q.to) {
    const from = q.from ? ymd(q.from, '開始日期') : null;
    const to = q.to ? ymd(q.to, '結束日期') : null;
    if (from && to && to < from) throw new UserError('結束日期不能早於開始日期');
    return { from, to };
  }
  const today = localDate(now, club.timezone);
  const se = await env.DB.prepare('SELECT start_date, end_date FROM seasons WHERE club_id = ? AND start_date <= ? AND end_date >= ?')
    .bind(club.id, today, today)
    .first<{ start_date: string; end_date: string }>();
  return se ? { from: se.start_date, to: se.end_date } : { from: null, to: null };
}

export interface FeeTotals {
  paid: number;
  paidCount: number;
  unpaid: number;
  unpaidCount: number;
}

export interface LedgerSummary {
  season: FeeTotals; // 人數
  casual: FeeTotals; // 人次
  otherIncome: number;
  venue: number;
  shuttle: number;
  otherExpense: number;
  income: number; // 已收的季打費 + 臨打費 + 其他收入
  expense: number;
  balance: number; // income − expense，未收的不算
}

/**
 * 期間內的收支彙總。歸屬日期：
 * - 季打費：季期開始日（整季算一次，不看哪天勾已繳）；免季費的人（fee_exempt）已繳、未繳都不算
 * - 臨打費：場次當天。未收 = 已開打、未取消的場次裡，正取、沒被點名為缺席、還沒勾已收的臨打；
 *   金額沒填的用球團的臨打費估算（報名時選女生的用女生臨打費）
 * - 手動登記的收支：登記時填的日期
 */
export async function ledgerSummary(env: Env, club: Club, p: Period, now = Date.now()): Promise<LedgerSummary> {
  // 當地日期範圍 → UTC 時間範圍 [lo, hi)，用來比對場次的 start_at
  const lo = p.from ? iso(zonedToUtc(p.from, '00:00', club.timezone)) : '';
  const hi = p.to ? iso(zonedToUtc(addDays(p.to, 1), '00:00', club.timezone)) : '9999';
  const { results } = await env.DB.prepare(
    `SELECT 'seasonPaid' AS k, COALESCE(SUM(se.fee), 0) AS total, COUNT(*) AS n
       FROM season_members sm JOIN seasons se ON se.id = sm.season_id
      WHERE se.club_id = ?1 AND sm.fee_paid = 1 AND sm.fee_exempt = 0 AND se.fee > 0 AND se.start_date >= ?4 AND se.start_date <= ?5
     UNION ALL
     SELECT 'seasonUnpaid', COALESCE(SUM(se.fee), 0), COUNT(*)
       FROM season_members sm JOIN seasons se ON se.id = sm.season_id
      WHERE se.club_id = ?1 AND sm.fee_paid = 0 AND sm.fee_exempt = 0 AND se.fee > 0 AND se.start_date >= ?4 AND se.start_date <= ?5
     UNION ALL
     SELECT 'casualPaid', COALESCE(SUM(r.fee_amount), 0), COUNT(*)
       FROM registrations r JOIN sessions s ON s.id = r.session_id
      WHERE s.club_id = ?1 AND r.kind = 'casual' AND r.fee_paid = 1 AND s.start_at >= ?2 AND s.start_at < ?3
     UNION ALL
     SELECT 'casualUnpaid', COALESCE(SUM(d.fee), 0), COUNT(*) FROM (
       SELECT COALESCE(r.fee_amount, CASE WHEN r.gender = 'F' THEN ?8 ELSE ?6 END) AS fee
         FROM registrations r JOIN sessions s ON s.id = r.session_id
        WHERE s.club_id = ?1 AND r.kind = 'casual' AND r.status = 'confirmed' AND r.fee_paid = 0
          AND (r.attended IS NULL OR r.attended = 1)
          AND s.status <> 'cancelled' AND s.start_at <= ?7 AND s.start_at >= ?2 AND s.start_at < ?3
     ) d WHERE d.fee > 0
     UNION ALL
     SELECT category, COALESCE(SUM(amount), 0), COUNT(*)
       FROM ledger_entries WHERE club_id = ?1 AND occurred_on >= ?4 AND occurred_on <= ?5 GROUP BY category`,
  )
    .bind(club.id, lo, hi, p.from ?? '0000-00-00', p.to ?? '9999-12-31', club.casual_fee, iso(now), casualFeeFor(club, 'F'))
    .all<{ k: string; total: number; n: number }>();

  const get = (k: string) => results.find((r) => r.k === k) ?? { total: 0, n: 0 };
  const fees = (paid: string, unpaid: string): FeeTotals => ({
    paid: get(paid).total,
    paidCount: get(paid).n,
    unpaid: get(unpaid).total,
    unpaidCount: get(unpaid).n,
  });
  const season = fees('seasonPaid', 'seasonUnpaid');
  const casual = fees('casualPaid', 'casualUnpaid');
  const otherIncome = get('other_income').total;
  const venue = get('venue').total;
  const shuttle = get('shuttle').total;
  const otherExpense = get('other_expense').total;
  const income = season.paid + casual.paid + otherIncome;
  const expense = venue + shuttle + otherExpense;
  return { season, casual, otherIncome, venue, shuttle, otherExpense, income, expense, balance: income - expense };
}

export interface LedgerEntryView {
  id: string;
  category: LedgerCategory;
  amount: number;
  date: string;
  note: string | null;
}

const ENTRY_LIMIT = 200;

/** 期間內手動登記的收支，新的在前。 */
export async function listLedgerEntries(env: Env, club: Club, p: Period): Promise<LedgerEntryView[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ledger_entries WHERE club_id = ? AND occurred_on >= ? AND occurred_on <= ?
     ORDER BY occurred_on DESC, created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(club.id, p.from ?? '0000-00-00', p.to ?? '9999-12-31', ENTRY_LIMIT)
    .all<LedgerEntry>();
  return results.map((e) => ({ id: e.id, category: e.category, amount: e.amount, date: e.occurred_on, note: e.note }));
}

/** 記帳頁一次要用到的資料：期間、彙總、明細，以及用來組期間選單的季期。 */
export async function ledgerView(env: Env, club: Club, q: Record<string, string | undefined>, now = Date.now()) {
  const period = await resolvePeriod(env, club, q, now);
  const [summary, entries, seasons] = await Promise.all([
    ledgerSummary(env, club, period, now),
    listLedgerEntries(env, club, period),
    env.DB.prepare('SELECT name, start_date, end_date FROM seasons WHERE club_id = ? ORDER BY start_date DESC')
      .bind(club.id)
      .all<{ name: string; start_date: string; end_date: string }>(),
  ]);
  return {
    ...period,
    summary,
    entries,
    seasons: seasons.results.map((se) => ({ name: se.name, startDate: se.start_date, endDate: se.end_date })),
  };
}

export async function addLedgerEntry(env: Env, club: Club, input: Record<string, unknown>, actorId: string): Promise<LedgerEntry> {
  const category = CATEGORIES.find((c) => c === input.category);
  if (!category) throw new UserError('請選擇類別');
  const amount = int(input.amount, 1, 10_000_000, '金額');
  const date = ymd(input.date, '日期');
  const note = str(input.note, 60, '備註', false);
  const id = `led_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    'INSERT INTO ledger_entries (id, club_id, category, amount, occurred_on, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, club.id, category, amount, date, note, actorId, nowIso())
    .run();
  return (await env.DB.prepare('SELECT * FROM ledger_entries WHERE id = ?').bind(id).first<LedgerEntry>())!;
}

/** 刪除一筆手動登記的收支；回傳被刪的內容，讓稽核紀錄留得下來。 */
export async function deleteLedgerEntry(env: Env, club: Club, entryId: string): Promise<LedgerEntry> {
  const e = await env.DB.prepare('SELECT * FROM ledger_entries WHERE id = ? AND club_id = ?').bind(entryId, club.id).first<LedgerEntry>();
  if (!e) throw new UserError('找不到這筆紀錄');
  await env.DB.prepare('DELETE FROM ledger_entries WHERE id = ?').bind(e.id).run();
  return e;
}
