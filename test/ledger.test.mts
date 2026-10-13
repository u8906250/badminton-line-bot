import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const L = await import(SRC + '/src/ledger.ts');
const { UserError } = await import(SRC + '/src/types.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
const env: any = { DB };
const t0 = '2026-01-01T00:00:00.000Z';
for (const [id, n] of [['U1','甲'],['U2','乙'],['U3','丙'],['U4','丁'],['U5','戊']]) q('INSERT INTO users VALUES (?,?,NULL,?)', id, n, t0);
for (const c of ['c1', 'c2']) {
  q(`INSERT INTO clubs (id, line_group_id, name, casual_fee, created_at) VALUES (?,?,?,200,?)`, c, `G-${c}`, c, t0);
  q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?,'U1','owner',?)`, c, t0);
}
const club = (id = 'c1') => q(`SELECT * FROM clubs WHERE id=?`, id)[0];
const isUserError = (re: RegExp) => (e: any) => e instanceof UserError && re.test(e.message);

// 現在：2026-10-10 12:00（台北）
const NOW = Date.parse('2026-10-10T04:00:00.000Z');
const Q3 = { from: '2026-07-01', to: '2026-09-30' };
const Q4 = { from: '2026-10-01', to: '2026-12-31' };
const ALL = { from: null, to: null };

// 季期：Q3 一人已繳；Q4 兩人已繳、一人未繳。甲早在 9/20 就繳了 Q4 的季費，仍算在 Q4
q(`INSERT INTO seasons VALUES ('q3','c1','第三季','2026-07-01','2026-09-30',2500)`);
q(`INSERT INTO seasons VALUES ('q4','c1','第四季','2026-10-01','2026-12-31',3000)`);
const seasonMember = (season: string, uid: string, paidAt: string | null, exempt = 0) =>
  q(`INSERT INTO season_members (season_id, user_id, fee_paid, paid_at, fee_exempt) VALUES (?,?,?,?,?)`, season, uid, paidAt ? 1 : 0, paidAt, exempt);
seasonMember('q3', 'U1', '2026-07-02T00:00:00.000Z');
seasonMember('q4', 'U1', '2026-09-20T00:00:00.000Z');
seasonMember('q4', 'U2', '2026-10-05T00:00:00.000Z');
seasonMember('q4', 'U3', null);
// 免季費的人（例如不在 LINE 上的教練）：已繳、未繳都不算他
q('INSERT INTO users VALUES (?,?,NULL,?)', 'ext_coach', '教練', t0);
seasonMember('q4', 'ext_coach', null, 1);

// 場次（台北時間）。edge9 與 edge10 的 UTC 日期都是 9/30，但當地日期分屬 9/30 與 10/1
const session = (id: string, startUtc: string, status = 'done') =>
  q(`INSERT INTO sessions (id, club_id, start_at, end_at, courts, capacity, reg_open_at, reg_close_at, status) VALUES (?,'c1',?,?,2,15,?,?,?)`,
    id, startUtc, startUtc, startUtc, startUtc, status);
session('edge9', '2026-09-30T15:30:00.000Z');          // 9/30 23:30
session('edge10', '2026-09-30T16:30:00.000Z');         // 10/1 00:30
session('oct7', '2026-10-07T12:00:00.000Z');           // 10/7 20:00
session('rain', '2026-10-08T12:00:00.000Z', 'cancelled');
session('oct14', '2026-10-14T12:00:00.000Z', 'open');  // 還沒開打

let n = 0;
const REG_COLS = '(id, session_id, user_id, guest_name, kind, status, queued_at, attended, fee_amount, fee_paid, updated_at, gender)';
const casual = (sid: string, uid: string, o: { guest?: string; gender?: string; status?: string; attended?: number | null; amount?: number | null; paid?: number } = {}) =>
  q(`INSERT INTO registrations ${REG_COLS} VALUES (?,?,?,?,'casual',?,?,?,?,?,?,?)`,
    `r${++n}`, sid, uid, o.guest ?? null, o.status ?? 'confirmed', t0, o.attended ?? null, o.amount ?? null, o.paid ?? 0, t0, o.gender ?? null);
casual('edge9', 'U4', { attended: 1, amount: 200, paid: 1 });  // Q3 已收 200
casual('edge10', 'U4', { attended: 1, amount: 200, paid: 1 }); // Q4 已收 200
casual('oct7', 'U4', { attended: 1, amount: 200, paid: 1 });   // Q4 已收 200
casual('oct7', 'U4', { guest: '朋友', attended: 1, amount: 150, paid: 1 }); // Q4 已收 150（自訂金額）
casual('oct7', 'U5');                                          // Q4 未收 200（還沒點名，用球團臨打費）
casual('oct7', 'U5', { guest: '半價', attended: 1, amount: 100 }); // Q4 未收 100
casual('oct7', 'U5', { guest: '沒來', attended: 0 });          // 點名缺席：不算未收
casual('oct7', 'U5', { guest: '候補', status: 'waitlist' });   // 沒上場：不算
casual('rain', 'U5');                                          // 場次取消：不算
casual('oct14', 'U5');                                         // 還沒開打：不算
q(`INSERT INTO registrations ${REG_COLS} VALUES ('rs','oct7','U1',NULL,'season','confirmed',?,1,NULL,0,?,NULL)`, t0, t0); // 季打不收臨打費

// 手動登記
const add = (category: string, amount: number, date: string, note?: string, c = 'c1') =>
  L.addLedgerEntry(env, club(c), { category, amount, date, note }, 'U1');
await add('other_expense', 100, '2026-09-15', '急救包');
await add('venue', 1200, '2026-09-30');
const v1 = await add('venue', 1200, '2026-10-01', '10/1 場租');
await add('venue', 1200, '2026-10-07');
await add('shuttle', 800, '2026-10-07', '比賽級 2 筒');
await add('other_income', 500, '2026-10-20', '贊助');
await add('venue', 99999, '2026-10-07', '別的球團', 'c2');
assert.equal(v1.created_by, 'U1');
assert.equal(v1.note, '10/1 場租');

// Q4：季打費整季算在季期開始日；臨打費依場次的當地日期
const s4 = await L.ledgerSummary(env, club(), Q4, NOW);
assert.deepEqual(s4.season, { paid: 6000, paidCount: 2, unpaid: 3000, unpaidCount: 1 });
assert.deepEqual(s4.casual, { paid: 550, paidCount: 3, unpaid: 300, unpaidCount: 2 });
assert.equal(s4.otherIncome, 500);
assert.equal(s4.venue, 2400);
assert.equal(s4.shuttle, 800);
assert.equal(s4.otherExpense, 0);
assert.equal(s4.income, 7050);
assert.equal(s4.expense, 3200);
assert.equal(s4.balance, 3850, '結餘不含未收');

// Q3
const s3 = await L.ledgerSummary(env, club(), Q3, NOW);
assert.deepEqual(s3.season, { paid: 2500, paidCount: 1, unpaid: 0, unpaidCount: 0 });
assert.deepEqual(s3.casual, { paid: 200, paidCount: 1, unpaid: 0, unpaidCount: 0 });
assert.equal(s3.venue, 1200);
assert.equal(s3.otherExpense, 100);
assert.equal(s3.balance, 2700 - 1300);

// 全部 = Q3 + Q4；月份加總也對得起來（季打費只在季期開始的那個月算一次）
const sa = await L.ledgerSummary(env, club(), ALL, NOW);
assert.equal(sa.balance, s3.balance + s4.balance);
assert.equal(sa.season.paid, 8500);
const oct = await L.ledgerSummary(env, club(), { from: '2026-10-01', to: '2026-10-31' }, NOW);
const nov = await L.ledgerSummary(env, club(), { from: '2026-11-01', to: '2026-11-30' }, NOW);
assert.equal(oct.season.paid, 6000);
assert.equal(nov.season.paid, 0);
assert.equal(nov.season.unpaidCount, 0);
assert.equal(oct.balance, s4.balance);

// 開打之後才算未收
const later = await L.ledgerSummary(env, club(), Q4, Date.parse('2026-10-15T00:00:00.000Z'));
assert.deepEqual([later.casual.unpaid, later.casual.unpaidCount], [500, 3]);

// 球團之間互不影響
const other = await L.ledgerSummary(env, club('c2'), ALL, NOW);
assert.equal(other.venue, 99999);
assert.equal(other.income, 0);

// 明細：期間內、新的在前
const e4 = await L.listLedgerEntries(env, club(), Q4);
assert.deepEqual(e4.map((e: any) => e.date), ['2026-10-20', '2026-10-07', '2026-10-07', '2026-10-01']);
assert.deepEqual(e4.slice(1, 3).map((e: any) => e.category), ['shuttle', 'venue'], '同一天後記的在前');
assert.equal((await L.listLedgerEntries(env, club(), ALL)).length, 6);

// 預設期間：今天所在的季期；不在任何季期內則全部
assert.deepEqual(await L.resolvePeriod(env, club(), {}, NOW), Q4);
assert.deepEqual(await L.resolvePeriod(env, club(), {}, Date.parse('2027-02-01T00:00:00.000Z')), ALL);
assert.deepEqual(await L.resolvePeriod(env, club(), { all: '1' }, NOW), ALL);
assert.deepEqual(await L.resolvePeriod(env, club(), Q3, NOW), Q3);
// 台北 10/1 00:30 已經是 Q4（UTC 還在 9/30）
assert.deepEqual(await L.resolvePeriod(env, club(), {}, Date.parse('2026-09-30T16:30:00.000Z')), Q4);
await assert.rejects(L.resolvePeriod(env, club(), { from: '2026-10-01', to: '2026-09-01' }, NOW), isUserError(/不能早於/));
await assert.rejects(L.resolvePeriod(env, club(), { from: '10/1' }, NOW), isUserError(/YYYY-MM-DD/));

// 記帳頁資料
const view = await L.ledgerView(env, club(), {}, NOW);
assert.equal(view.from, '2026-10-01');
assert.equal(view.summary.balance, 3850);
assert.equal(view.entries.length, 4);
assert.deepEqual(view.seasons[0], { name: '第四季', startDate: '2026-10-01', endDate: '2026-12-31' });

// 輸入檢查
await assert.rejects(add('beer', 100, '2026-10-01'), isUserError(/類別/));
await assert.rejects(add('venue', 0, '2026-10-01'), isUserError(/金額/));
await assert.rejects(add('venue', 12.5, '2026-10-01'), isUserError(/金額/));
await assert.rejects(add('venue', 100, ''), isUserError(/日期/));
await assert.rejects(add('venue', 100, '2026-10-01', 'x'.repeat(61)), isUserError(/備註/));

// 刪除：只能刪自己球團的
await assert.rejects(L.deleteLedgerEntry(env, club('c2'), v1.id), isUserError(/找不到/));
const removed = await L.deleteLedgerEntry(env, club(), v1.id);
assert.equal(removed.amount, 1200);
assert.equal((await L.ledgerSummary(env, club(), Q4, NOW)).venue, 1200);
await assert.rejects(L.deleteLedgerEntry(env, club(), v1.id), isUserError(/找不到/));

// 臨打費分男女：金額還沒填的未收，報名時選女生的用女生臨打費估算
q(`UPDATE clubs SET casual_fee_female = 150 WHERE id='c1'`);
const unpaid = async () => { const s = await L.ledgerSummary(env, club(), Q4, NOW); return [s.casual.unpaid, s.casual.unpaidCount]; };
assert.deepEqual(await unpaid(), [300, 2], '報名時沒選的照一般臨打費');
q(`UPDATE registrations SET gender = 'F' WHERE session_id='oct7' AND user_id='U5' AND guest_name IS NULL`);
assert.deepEqual(await unpaid(), [250, 2], '戊（女）150 + 已填金額的 100');
casual('oct7', 'U4', { guest: '女友', gender: 'F' });
assert.deepEqual(await unpaid(), [400, 3]);
casual('oct7', 'U5', { guest: '男友' }); // 朋友沒選：不沿用報名人（女）的價錢
assert.deepEqual(await unpaid(), [600, 4]);
q(`UPDATE clubs SET casual_fee_female = 0 WHERE id='c1'`); // 女生免費：不算未收
assert.deepEqual(await unpaid(), [300, 2]);

// 誰可以看帳本（唯讀）：管理員，以及季打成員
const can = (uid: string, role = 'member', now = NOW, c = 'c1') => L.canViewLedger(env, club(c), uid, role, now);
assert.equal(await can('U4', 'owner'), true);
assert.equal(await can('U4', 'admin'), true);
assert.equal(await can('U2'), true, '本季的季打成員');
assert.equal(await can('U3'), true, '季費還沒繳也是季打成員');
assert.equal(await can('U4'), false, '臨打看不到');
assert.equal(await can('U2', 'member', NOW, 'c2'), false, '別的球團的季打不算');
// 只在已經結束的季期名單上（現在有進行中的季期）：看不到
seasonMember('q3', 'U5', null);
assert.equal(await can('U5'), false, '上一季是季打、這一季不是');
// 還沒開始的下一季名單也算
q(`INSERT INTO seasons VALUES ('n1','c1','明年第一季','2027-01-01','2027-03-31',3000)`);
seasonMember('n1', 'U4', null);
assert.equal(await can('U4'), true);
// 所有季期都結束了（新的一季還沒建立）：看最後一季的名單，空檔期間不會突然看不到
const GAP = Date.parse('2027-06-01T04:00:00.000Z');
assert.equal(await can('U4', 'member', GAP), true, '最後一季的季打成員');
assert.equal(await can('U2', 'member', GAP), false, '更早的季期不算');
// 季期的最後一天還算進行中（球團時區）
assert.equal(await can('U2', 'member', Date.parse('2026-12-31T15:00:00.000Z')), true);

// 設定可以關掉：關掉後只有管理員看得到，再打開就恢復；預設是開的
const M = await import(SRC + '/src/manage.ts');
assert.equal(club('c1').ledger_visible, 1, '預設給季打成員看');
await M.updateSettings(env, club('c1'), { ledgerVisible: false });
assert.equal(club('c1').ledger_visible, 0);
assert.equal(await can('U2'), false, '關掉後季打成員看不到');
assert.equal(await can('U4', 'member', GAP), false);
assert.deepEqual([await can('U4', 'owner'), await can('U4', 'admin')], [true, true], '管理員不受影響');
await M.updateSettings(env, club('c1'), { casualFee: club('c1').casual_fee });
assert.equal(club('c1').ledger_visible, 0, '沒帶的欄位不動');
await M.updateSettings(env, club('c1'), { ledgerVisible: true });
assert.deepEqual([club('c1').ledger_visible, await can('U2'), await can('U4')], [1, true, true]);

console.log('ALL LEDGER TESTS PASSED');
