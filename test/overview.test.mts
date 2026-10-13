// 報名頁載入場次（sessionsOverview）：一次 batch 查完，結果要和「每一場各自查」完全一樣。
import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const svc = await import(SRC + '/src/service.ts');
const dbh = await import(SRC + '/src/db.ts');

const { DB: inner, q } = createTestDb(SRC + '/schema.sql');
// 計數：一次請求打了幾次資料庫（單句、batch 各算一次）
const calls = { single: 0, batches: 0, statements: 0 };
const wrap = (s: any): any => ({
  bind: (...v: any[]) => wrap(s.bind(...v)),
  first: async () => { calls.single++; return s._exec()[0] ?? null; },
  all: async () => { calls.single++; return { results: s._exec(), success: true }; },
  run: async () => { calls.single++; s._exec(); return { results: [], success: true }; },
  _exec: () => s._exec(),
});
const DB: any = { prepare: (sql: string) => wrap(inner.prepare(sql)), batch: async (l: any[]) => { calls.batches++; calls.statements += l.length; return inner.batch(l); } };
const env: any = { DB, LIFF_ID: 'x', LINE_CHANNEL_ACCESS_TOKEN: 'x' };

const NOW = Date.parse('2026-10-14T04:00:00.000Z');
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const USERS = ['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8'];
for (const u of USERS) q('INSERT INTO users VALUES (?,?,NULL,?)', u, `名字${u}`, at(0));
for (const c of ['c1', 'c2']) {
  q(`INSERT INTO clubs (id, line_group_id, name, casual_fee, created_at) VALUES (?,?,?,250,?)`, c, `G-${c}`, c, at(0));
  for (const u of USERS) q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?,?,?,?)`, c, u, u === 'U1' ? 'owner' : 'member', at(0));
}
q(`UPDATE club_members SET nickname='小二' WHERE club_id='c1' AND user_id='U2'`);
q(`UPDATE club_members SET nickname='別團的暱稱' WHERE club_id='c2' AND user_id='U3'`);

const session = (id: string, club: string, start: number, end: number, status: string, capacity = 3) =>
  q(`INSERT INTO sessions (id, club_id, start_at, end_at, venue, courts, capacity, reg_open_at, reg_close_at, status) VALUES (?,?,?,?,'體育館',2,?,?,?,?)`,
    id, club, at(start), at(end), capacity, at(start - 3 * DAY), at(start), status);
let seq = 0;
/** 直接寫一筆報名。queuedMin 相同的幾筆用寫入順序分先後（測同一毫秒的情況）。 */
const reg = (sid: string, user: string, kind: string, status: string, queuedMin: number, o: { guest?: string; level?: number } = {}) =>
  q(`INSERT INTO registrations (id, session_id, user_id, guest_name, kind, status, queued_at, updated_at, level) VALUES (?,?,?,?,?,?,?,?,?)`,
    `r${++seq}`, sid, user, o.guest ?? null, kind, status, at(queuedMin * MIN), at(0), o.level ?? null);

// ---- 場次 ----
session('running', 'c1', -1 * HOUR, 1 * HOUR, 'closed');           // 正在打：還沒結束，要出現
session('ended', 'c1', -3 * HOUR, -1 * MIN, 'closed');             // 剛結束、狀態還沒被排程改成 done：不出現
session('done', 'c1', -1 * DAY - 2 * HOUR, -1 * DAY, 'done');      // 昨天打完
session('open', 'c1', 2 * DAY, 2 * DAY + 2 * HOUR, 'open');
session('cancelled', 'c1', 4 * DAY, 4 * DAY + 2 * HOUR, 'cancelled');
session('sched', 'c1', 9 * DAY, 9 * DAY + 2 * HOUR, 'scheduled', 2);
session('empty-open', 'c1', 3 * DAY, 3 * DAY + 2 * HOUR, 'open');   // 開放了但還沒人報名
session('other-club', 'c2', 2 * DAY, 2 * DAY + 2 * HOUR, 'open');   // 別的球團
for (let i = 0; i < 6; i++) session(`later${i}`, 'c1', (16 + 7 * i) * DAY, (16 + 7 * i) * DAY + 2 * HOUR, 'scheduled'); // 超過 8 場

// ---- 報名 ----
// open：季打 2（其中 1 請假）、臨打正取、朋友、候補 3（含同一毫秒的兩筆、朋友）、取消過的
reg('open', 'U1', 'season', 'confirmed', -5000);
reg('open', 'U2', 'season', 'leave', -5000);
reg('open', 'U3', 'casual', 'confirmed', -100, { level: 6 });
reg('open', 'U3', 'casual', 'confirmed', -90, { guest: '阿明', level: 4 });
reg('open', 'U4', 'casual', 'cancelled', -80);
reg('open', 'U4', 'casual', 'waitlist', -70);
reg('open', 'U5', 'casual', 'waitlist', -60, { level: 9 });
reg('open', 'U6', 'casual', 'waitlist', -60);                       // 和 U5 同一毫秒，晚寫入的排後面
reg('open', 'U5', 'casual', 'waitlist', -50, { guest: '小美' });
reg('open', 'U7', 'season', 'confirmed', -4000);                    // 季打排在正取前面，即使比臨打晚寫入
// running（已截止）：也要附名單
reg('running', 'U1', 'season', 'confirmed', -9000);
reg('running', 'U8', 'casual', 'confirmed', -300);
reg('running', 'U6', 'casual', 'waitlist', -200);
// sched（尚未開放）：季打佔位、銷假後排候補的季打、管理員代報名的候補。不附名單，但人數和自己的順位要有
reg('sched', 'U1', 'season', 'confirmed', -8000);
reg('sched', 'U7', 'season', 'confirmed', -8000);
reg('sched', 'U2', 'season', 'waitlist', -8001);                    // 銷假：queued_at 比別人早，排候補第一
reg('sched', 'U8', 'casual', 'waitlist', -10);
// cancelled：場次取消時報名都被取消
reg('cancelled', 'U3', 'casual', 'cancelled', -40);
// 沒出現在報名頁的場次、別的球團：不能混進來
reg('ended', 'U3', 'casual', 'confirmed', -400);
reg('done', 'U3', 'casual', 'confirmed', -4000);
reg('other-club', 'U3', 'casual', 'waitlist', -30);
reg('later5', 'U3', 'casual', 'confirmed', -20);                     // 第 9 場以後的（超過 8 場的上限）

// ---- 參考答案：改寫前的做法，每一場各自查 ----
const plain = (x: any) => JSON.parse(JSON.stringify(x));
async function reference(club: string, user: string) {
  const sessions = q(`SELECT * FROM sessions WHERE club_id = ? AND end_at > ? AND status <> 'done' ORDER BY start_at LIMIT 8`, club, at(0));
  const out = [];
  for (const s of sessions) {
    const c = q(`SELECT COALESCE(SUM(status = 'confirmed'), 0) AS confirmed, COALESCE(SUM(status = 'waitlist'), 0) AS waitlist FROM registrations WHERE session_id = ?`, s.id)[0];
    const mine = q(`SELECT * FROM registrations WHERE session_id = ? AND user_id = ? AND status <> 'cancelled' ORDER BY queued_at, rowid`, s.id, user);
    out.push({
      session: { ...s }, confirmed: c.confirmed, waitlist: c.waitlist,
      mine: await Promise.all(mine.map(async (r: any) => ({ id: r.id, kind: r.kind, status: r.status, guestName: r.guest_name, position: r.status === 'waitlist' ? await svc.waitlistPosition(inner, r) : null }))),
      roster: s.status === 'open' || s.status === 'closed' ? await svc.roster(inner, club, s.id) : null,
    });
  }
  return plain(out);
}

// ---- 每個人、兩個球團：新舊結果完全相同，而且只打一次資料庫 ----
for (const club of ['c1', 'c2']) {
  for (const user of [...USERS, 'U-不存在']) {
    Object.assign(calls, { single: 0, batches: 0, statements: 0 });
    const got = plain(await svc.sessionsOverview(DB, club, user, NOW));
    assert.deepEqual(calls, { single: 0, batches: 1, statements: 4 }, '一次 batch、四句');
    assert.deepEqual(got, await reference(club, user), `${club} ${user}`);
  }
}

// ---- 幾個具體的預期（不只是和舊寫法互相比對）----
const view = async (user: string) => plain(await svc.sessionsOverview(DB, 'c1', user, NOW)) as any[];
const u3 = await view('U3');
// 還沒結束的最近 8 場，依時間排序；剛結束的、已結束的、別團的、第 9 場以後的都不在
assert.deepEqual(u3.map((o) => o.session.id), ['running', 'open', 'empty-open', 'cancelled', 'sched', 'later0', 'later1', 'later2']);
const by = (list: any[], id: string) => list.find((o) => o.session.id === id);
// open：正取 4（季打 U1、U7 排前面，再來是 U3 和他的朋友）、候補 4、請假 1
assert.deepEqual([by(u3, 'open').confirmed, by(u3, 'open').waitlist], [4, 4]);
assert.deepEqual(by(u3, 'open').roster.confirmed.map((e: any) => [e.name, e.kind, e.level]), [['名字U1', 'season', null], ['名字U7', 'season', null], ['名字U3', 'casual', 6], ['阿明（名字U3 的朋友）', 'casual', 4]]);
assert.deepEqual(by(u3, 'open').roster.waitlist.map((e: any) => e.name), ['名字U4', '名字U5', '名字U6', '小美（名字U5 的朋友）']);
assert.deepEqual(by(u3, 'open').roster.leave.map((e: any) => e.name), ['小二'], '請假的季打；名字用這個球團的暱稱');
// 自己的報名：U3 本人和幫朋友報的各一筆，都是正取
assert.deepEqual(by(u3, 'open').mine, [{ id: 'r3', kind: 'casual', status: 'confirmed', guestName: null, position: null }, { id: 'r4', kind: 'casual', status: 'confirmed', guestName: '阿明', position: null }]);
// 候補順位：U4 第 1；U5 第 2、他的朋友第 4；U6 和 U5 同一毫秒但晚寫入，第 3；取消過的那筆不算
assert.deepEqual(by(await view('U4'), 'open').mine.map((m: any) => [m.status, m.position]), [['waitlist', 1]]);
assert.deepEqual(by(await view('U5'), 'open').mine.map((m: any) => [m.guestName, m.position]), [[null, 2], ['小美', 4]]);
assert.deepEqual(by(await view('U6'), 'open').mine.map((m: any) => m.position), [3]);
// 請假的季打看得到自己那筆（狀態是請假，沒有順位）
assert.deepEqual(by(await view('U2'), 'open').mine.map((m: any) => [m.kind, m.status, m.position]), [['season', 'leave', null]]);
// 開放了但沒人報名：名單是三份空的，不是 null
assert.deepEqual(by(u3, 'empty-open'), { session: by(u3, 'empty-open').session, confirmed: 0, waitlist: 0, mine: [], roster: { confirmed: [], waitlist: [], leave: [] } });
// 正在打（已截止）：附名單
assert.deepEqual(by(u3, 'running').roster.confirmed.map((e: any) => e.name), ['名字U1', '名字U8']);
// 尚未開放：不附名單，但人數和自己的候補順位有（銷假的季打排第一，管理員代報的臨打第二）
assert.deepEqual([by(u3, 'sched').roster, by(u3, 'sched').confirmed, by(u3, 'sched').waitlist], [null, 2, 2]);
assert.deepEqual(by(await view('U2'), 'sched').mine.map((m: any) => [m.kind, m.status, m.position]), [['season', 'waitlist', 1]]);
assert.deepEqual(by(await view('U8'), 'sched').mine.map((m: any) => m.position), [2]);
// 已取消的場次：出現在清單上，沒有名單，自己被取消的報名不算
assert.deepEqual([by(u3, 'cancelled').session.status, by(u3, 'cancelled').roster, by(u3, 'cancelled').mine, by(u3, 'cancelled').confirmed], ['cancelled', null, [], 0]);
// 別的球團：只看得到那個球團的場次與暱稱
const other = plain(await svc.sessionsOverview(DB, 'c2', 'U3', NOW));
assert.deepEqual(other.map((o: any) => [o.session.id, o.waitlist, o.mine.map((m: any) => m.position), o.roster.waitlist.map((e: any) => e.name)]), [['other-club', 1, [1], ['別團的暱稱']]]);
// 沒有場次的球團
q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES ('c3','G-c3','c3',?)`, at(0));
assert.deepEqual(await svc.sessionsOverview(DB, 'c3', 'U1', NOW), []);

// 時間往後：正在打的那場結束後就不再出現；9 場以後的往前遞補
const later = plain(await svc.sessionsOverview(DB, 'c1', 'U3', NOW + 2 * HOUR));
assert.deepEqual(later.map((o: any) => o.session.id), ['open', 'empty-open', 'cancelled', 'sched', 'later0', 'later1', 'later2', 'later3']);

// ---- 真的報名流程跑出來的狀態也一致 ----
const club = q(`SELECT * FROM clubs WHERE id='c1'`)[0];
session('live', 'c1', 1 * DAY, 1 * DAY + 2 * HOUR, 'open', 2);
const live = q(`SELECT * FROM sessions WHERE id='live'`)[0];
const realNow = Date.now;
Date.now = () => NOW; // 報名的開放時間用系統時間判斷
try {
  await svc.register(env, club, live, 'U4');
  await svc.register(env, club, live, 'U4', '朋友甲', { level: 5 });
  const r = await svc.register(env, club, live, 'U5');
  assert.deepEqual([r.status, r.position], ['waitlist', 1]);
  await svc.register(env, club, live, 'U6', '朋友乙');
  for (const user of USERS) assert.deepEqual(plain(await svc.sessionsOverview(DB, 'c1', user, NOW)), await reference('c1', user), `報名後 ${user}`);
  assert.deepEqual(by(await view('U6'), 'live').mine, [{ id: by(await view('U6'), 'live').mine[0].id, kind: 'casual', status: 'waitlist', guestName: '朋友乙', position: 2 }]);
  // 正取取消 → 候補第一位遞補，後面的順位往前
  await svc.cancel(env, club, live, 'U4');
  for (const user of USERS) assert.deepEqual(plain(await svc.sessionsOverview(DB, 'c1', user, NOW)), await reference('c1', user), `取消後 ${user}`);
  assert.deepEqual(by(await view('U5'), 'live').mine.map((m: any) => [m.status, m.position]), [['confirmed', null]]);
  assert.deepEqual(by(await view('U6'), 'live').mine.map((m: any) => [m.status, m.position]), [['waitlist', 1]]);
} finally {
  Date.now = realNow;
}

// ---- 球團與成員身分一次查 ----
Object.assign(calls, { single: 0, batches: 0, statements: 0 });
const ok = await dbh.getClubAndRole(DB, 'c1', 'U1');
assert.deepEqual([ok.club.id, ok.club.name, ok.role], ['c1', 'c1', 'owner']);
assert.deepEqual(calls, { single: 0, batches: 1, statements: 2 });
assert.deepEqual((await dbh.getClubAndRole(DB, 'c1', 'U2')).role, 'member');
const stranger = await dbh.getClubAndRole(DB, 'c1', 'U-不存在');
assert.deepEqual([stranger.club.id, stranger.role], ['c1', null], '球團存在但不是成員');
const none = await dbh.getClubAndRole(DB, '不存在的球團', 'U1');
assert.deepEqual([none.club, none.role], [null, null]);
// 和原本分開查的結果一樣
assert.deepEqual({ ...ok.club }, { ...(await dbh.getClub(inner, 'c1')) });
assert.equal(ok.role, await dbh.getRole(inner, 'c1', 'U1'));

console.log('ALL OVERVIEW TESTS PASSED');
