import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const m = await import(SRC + '/src/manage.ts');
const svc = await import(SRC + '/src/service.ts');
const notify = await import(SRC + '/src/notify.ts');
const { UserError } = await import(SRC + '/src/types.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
const env: any = { DB };
const now = new Date().toISOString();
for (const [id, n] of [['U1','甲'],['U2','乙'],['U3','丙'],['U4','丁'],['U5','戊']]) q('INSERT INTO users VALUES (?,?,NULL,?)', id, n, now);
q(`INSERT INTO clubs (id, line_group_id, name, casual_fee, created_at) VALUES ('c1','G1','測試',200,?)`, now);
q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c1','U1','owner',?)`, now);
for (const u of ['U2','U3','U4','U5']) q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c1',?,'member',?)`, u, now);
const club = () => q(`SELECT * FROM clubs WHERE id='c1'`)[0];
const reg = (sid: string, uid: string, kind = '%') => q(`SELECT * FROM registrations WHERE session_id=? AND user_id=? AND kind LIKE ? AND status<>'cancelled'`, sid, uid, kind)[0];
const isUserError = (re: RegExp) => (e: any) => e instanceof UserError && re.test(e.message);

// 時段 → 季期 → 季打成員
const sc = await m.createSchedule(env, club(), { weekday: 3, startTime: '20:00', endTime: '22:00', venue: '體育館', courtNo: ' 第 5 場 ', courts: 1, capacity: 3 });
assert.equal(sc.court_no, '第 5 場');
const futureYear = new Date().getFullYear();
const se = await m.createSeason(env, club(), { name: '本季', startDate: `${futureYear}-01-01`, endDate: `${futureYear + 1}-12-31`, fee: 3000 });
await assert.rejects(m.createSeason(env, club(), { name: '重疊', startDate: `${futureYear}-06-01`, endDate: `${futureYear}-07-01`, fee: 1 }), isUserError(/重疊/));
await m.addSeasonMembers(env, club(), se.id, ['U1', 'U2']);
const sessions = q(`SELECT * FROM sessions WHERE schedule_id=? ORDER BY start_at`, sc.id);
assert.ok(sessions.length >= 4, '產生場次');
assert.ok(sessions.every((s: any) => s.season_id === se.id), '場次掛上季期');
assert.ok(sessions.every((s: any) => s.court_no === '第 5 場'), '場次帶入時段的第幾場地');
const sid = sessions[0].id;
assert.equal(q(`SELECT COUNT(*) n FROM registrations WHERE session_id=? AND kind='season' AND status='confirmed'`, sid)[0].n, 2);

// 臨打報名（先把這場打開）
q(`UPDATE sessions SET status='open' WHERE id=?`, sid);
const S = () => q(`SELECT * FROM sessions WHERE id=?`, sid)[0];
await svc.register(env, club(), S(), 'U3');
await svc.register(env, club(), S(), 'U4');
assert.equal(reg(sid, 'U3').status, 'confirmed');
assert.equal(reg(sid, 'U4').status, 'waitlist');

// 調低上限：最後報名的臨打正取（丙）退回候補，排在丁前面
let ch = await m.setSessionCapacity(env, club(), sid, 2);
assert.deepEqual(ch.demoted.map((x: any) => x.p.user_id), ['U3']);
assert.equal(reg(sid, 'U3').status, 'waitlist');
assert.equal((await m.listAdminSessions(env, club())).length > 0, true);
assert.equal(await svc.waitlistPosition(DB, reg(sid, 'U3')), 1, '丙排在丁前面');
// 調高上限：依序遞補
ch = await m.setSessionCapacity(env, club(), sid, 4);
assert.deepEqual(ch.promoted.map((x: any) => x.p.user_id), ['U3', 'U4']);

// 臨打成員改成季打：季打那筆取代臨打那筆
await m.addSeasonMembers(env, club(), se.id, ['U4']);
assert.equal(reg(sid, 'U4').kind, 'season');
assert.equal(reg(sid, 'U4', 'casual'), undefined);
// 移出季打再加回：恢復為正取
await m.removeSeasonMember(env, club(), se.id, 'U4');
assert.equal(reg(sid, 'U4'), undefined);
await m.addSeasonMembers(env, club(), se.id, ['U4']);
assert.equal(reg(sid, 'U4').status, 'confirmed');
await assert.rejects(m.addSeasonMembers(env, club(), se.id, ['NOPE']), isUserError(/球團成員/));

// 季費
await m.setSeasonFeePaid(env, club(), se.id, 'U1', true);
const seasons = await m.listSeasons(env, club());
assert.equal(seasons[0].members.find((x: any) => x.userId === 'U1').feePaid, true);

// 修改時段：上限 3 → 這場正取 4 人（季打 3 + 丙），退回丙
ch = await m.updateSchedule(env, club(), sc.id, { capacity: 3, startTime: '19:30' });
assert.ok(ch.demoted.some((x: any) => x.session.id === sid && x.p.user_id === 'U3'));
assert.ok(S().start_at.endsWith('11:30:00.000Z'), '開始時間改為 19:30（台北）');
await assert.rejects(m.updateSchedule(env, club(), sc.id, { weekday: 4 }), isUserError(/星期不能修改/));

// 第幾場地：單場可以另外改；時段的第幾場地沒動時，改時段不會蓋掉單場改過的
const sid2 = sessions[1].id;
const courtOf = (id: string) => q(`SELECT court_no FROM sessions WHERE id=?`, id)[0].court_no;
assert.equal(await m.setSessionCourt(env, club(), sid2, ' 第 1、2 場 '), '第 1、2 場');
await m.updateSchedule(env, club(), sc.id, { venue: '新體育館' });
assert.deepEqual([courtOf(sid), courtOf(sid2), S().venue], ['第 5 場', '第 1、2 場', '新體育館']);
// 時段的第幾場地改了：還沒開打的場次全部跟著換
await m.updateSchedule(env, club(), sc.id, { courtNo: '第 7、8 場' });
assert.deepEqual([courtOf(sid), courtOf(sid2)], ['第 7、8 場', '第 7、8 場']);
assert.equal(await m.setSessionCourt(env, club(), sid2, ''), null, '清空 = 不顯示');
assert.equal(courtOf(sid2), null);
await assert.rejects(m.setSessionCourt(env, club(), sid2, 'x'.repeat(21)), isUserError(/第幾場地最多 20 個字/));
await assert.rejects(m.setSessionCourt(env, club(), 'nope', '1'), isUserError(/找不到這個場次/));

// 報名規則：開放天數 30 → 未來場次都進入報名中
await m.updateSettings(env, club(), { regOpenDaysBefore: 30, regOpenTime: '00:00', casualFee: 250, cancelDeadlineMinutesBefore: 60 });
assert.ok(q(`SELECT status FROM sessions WHERE schedule_id=?`, sc.id).every((r: any) => r.status === 'open'));
assert.equal(club().cancel_deadline_minutes_before, 60);
// 球團規則／備註：多行文字，前後空白去掉；清空 = 不顯示；沒帶的欄位不動
await m.updateSettings(env, club(), { rules: '\n1. 臨打費現場收\n2. 程度 4–8 級\n' });
assert.equal(club().rules, '1. 臨打費現場收\n2. 程度 4–8 級');
await m.updateSettings(env, club(), { casualFee: 250 });
assert.equal(club().rules, '1. 臨打費現場收\n2. 程度 4–8 級');
await assert.rejects(m.updateSettings(env, club(), { rules: 'x'.repeat(1001) }), isUserError(/球團規則最多 1000 個字/));
await m.updateSettings(env, club(), { rules: '  ' });
assert.equal(club().rules, null);
await assert.rejects(m.updateSettings(env, club(), { regOpenTime: '25:00' }), isUserError(/HH:mm/));

// 臨時加場與代報名
const d = new Date(Date.now() + 10 * 86400e3).toISOString().slice(0, 10);
const extra = await m.createExtraSession(env, club(), { date: d, startTime: '09:00', endTime: '11:00', venue: '別館', courtNo: 'A、B 場', courts: 2, capacity: 8 });
assert.equal(extra.season_id, null);
assert.equal(extra.court_no, 'A、B 場');
assert.deepEqual(await m.adminRegister(env, club(), extra.id, 'U5', '朋友A'), { status: 'confirmed', position: 0 });

// 管理員取消季打 → 改為請假並遞補
const before = reg(sid, 'U2');
ch = await m.adminCancelRegistration(env, club(), sid, before.id);
assert.equal(q(`SELECT status FROM registrations WHERE id=?`, before.id)[0].status, 'leave');
assert.deepEqual(ch.promoted.map((x: any) => x.p.user_id), ['U3']);

// 點名收費
const r3 = reg(sid, 'U3');
await m.setAttendance(env, club(), sid, r3.id, { feePaid: true }, 'U1');
const after = q(`SELECT * FROM registrations WHERE id=?`, r3.id)[0];
assert.equal(after.fee_amount, 250);
assert.equal(after.attended, 1);
await assert.rejects(m.setAttendance(env, club(), sid, reg(sid, 'U1').id, { feePaid: true }, 'U1'), isUserError(/季費/));
const att = await m.attendanceList(env, club(), sid);
assert.equal(att.rows[0].kind, 'season', '季打排前面');

// 臨打費分男女：女生另外設定；報名時選女生的用女生臨打費，沒選或選男生的用一般臨打費
await m.updateSettings(env, club(), { casualFeeFemale: 200 });
assert.equal(club().casual_fee_female, 200);
assert.equal(club().casual_fee, 250, '沒帶的欄位不動');
await assert.rejects(m.updateSettings(env, club(), { casualFeeFemale: -1 }), isUserError(/女生臨打費/));
assert.throws(() => m.gender('X'), isUserError(/性別/));
// 性別只記在這一筆報名上：戊自己（女）、朋友A（前面報的，沒選）、朋友B（女）、朋友C（男）、丁自己（沒選）
await m.adminRegister(env, club(), extra.id, 'U5', undefined, { gender: 'F', level: 6 });
await m.adminRegister(env, club(), extra.id, 'U5', '朋友B', { gender: 'F' });
await m.adminRegister(env, club(), extra.id, 'U5', '朋友C', { gender: 'M', level: 12 });
await m.adminRegister(env, club(), extra.id, 'U4');
const xreg = (uid: string, guest: string | null) =>
  q(`SELECT * FROM registrations WHERE session_id=? AND user_id=? AND guest_name IS ?`, extra.id, uid, guest)[0];
assert.equal(xreg('U5', null).gender, 'F');
assert.equal(xreg('U5', '朋友B').gender, 'F');
assert.equal(xreg('U5', '朋友A').gender, null);
assert.equal(xreg('U4', null).gender, null);
const xatt = await m.attendanceList(env, club(), extra.id);
const xrow = (name: RegExp) => xatt.rows.find((r: any) => name.test(r.name));
assert.equal(xrow(/^戊$/).defaultFee, 200);
assert.equal(xrow(/朋友A/).defaultFee, 250, '朋友沒選就收一般臨打費，不沿用報名人選的');
assert.equal(xrow(/朋友B/).defaultFee, 200);
assert.equal(xrow(/朋友C/).defaultFee, 250);
assert.equal(xrow(/^丁$/).defaultFee, 250);
// 程度：報名時可填 1–18 級，不填也可以；點名名單帶得出來
assert.deepEqual([xrow(/^戊$/).level, xrow(/朋友B/).level, xrow(/朋友C/).level, xrow(/^丁$/).level], [6, null, 12, null]);
assert.deepEqual([m.level(''), m.level(null), m.level('18'), m.level(1)], [null, null, 18, 1]);
for (const bad of [0, 19, 6.5, 'abc']) assert.throws(() => m.level(bad), isUserError(/程度需為 1–18 的整數/));
// 每次報名各自選：戊報另一場時沒選，不沿用上一場的
await svc.register(env, club(), S(), 'U5');
assert.equal(reg(sid, 'U5').gender, null);
// 成員資料、點名名單都不帶性別
assert.ok(!('gender' in (await m.listMembers(env, club()))[0]));
assert.ok(!('gender' in xrow(/^戊$/)));
// 勾已收：金額沒填就帶入對應的臨打費；已經填的金額不動
for (const [uid, guest, want] of [['U5', null, 200], ['U5', '朋友A', 250], ['U5', '朋友B', 200], ['U5', '朋友C', 250]] as const) {
  await m.setAttendance(env, club(), extra.id, xreg(uid, guest).id, { feePaid: true }, 'U1');
  assert.equal(xreg(uid, guest).fee_amount, want, `${guest ?? '戊'} 的臨打費`);
}
await m.setAttendance(env, club(), extra.id, xreg('U4', null).id, { feeAmount: 123 }, 'U1');
await m.setAttendance(env, club(), extra.id, xreg('U4', null).id, { feePaid: true }, 'U1');
assert.equal(xreg('U4', null).fee_amount, 123);
// 女生臨打費清空 → 回到同一個價錢
await m.updateSettings(env, club(), { casualFeeFemale: '' });
assert.equal(club().casual_fee_female, null);
assert.equal((await m.attendanceList(env, club(), extra.id)).rows.find((r: any) => /朋友B/.test(r.name)).defaultFee, 250);

// 停用時段：有臨打報名的場次保留，其餘刪除
const res = await m.setScheduleActive(env, club(), sc.id, false);
assert.equal(res.kept, 1);
assert.equal(res.removed, sessions.length - 1);

// 角色
await assert.rejects(m.setRole(env, club(), 'admin', 'U2', 'admin'), isUserError(/擁有者/));
await m.setRole(env, club(), 'owner', 'U2', 'admin');
await m.transferOwner(env, club(), 'U1', 'owner', 'U2');
assert.deepEqual(q(`SELECT user_id, role FROM club_members WHERE user_id IN ('U1','U2') ORDER BY user_id`).map((r: any) => r.role), ['admin', 'owner']);

// ---------- 不在 LINE 上的季打成員（例如教練） ----------
// 新時段：上限 4，季打 3 人（甲、乙、丁）＋臨打丙 = 滿
const sc2 = await m.createSchedule(env, club(), { weekday: 5, startTime: '19:00', endTime: '21:00', venue: '體育館', courts: 1, capacity: 4 });
const s2 = () => q(`SELECT * FROM sessions WHERE schedule_id=? ORDER BY start_at`, sc2.id)[0];
const sid3 = s2().id;
await svc.register(env, club(), s2(), 'U3');
assert.deepEqual([reg(sid3, 'U3').status, q(`SELECT COUNT(*) n FROM registrations WHERE session_id=? AND status='confirmed'`, sid3)[0].n], ['confirmed', 4]);

await assert.rejects(m.addExternalSeasonMember(env, club(), se.id, '  '), isUserError(/請填寫名字/));
await assert.rejects(m.addExternalSeasonMember(env, club(), 'nope', '王教練'), isUserError(/找不到這個季期/));
assert.equal(q(`SELECT COUNT(*) n FROM users WHERE line_user_id LIKE 'ext%'`)[0].n, 0, '失敗時不會留下建到一半的人');
const coach = await m.addExternalSeasonMember(env, club(), se.id, ' 王教練 ');
assert.ok(coach.userId.startsWith('ext_'));
assert.equal(coach.name, '王教練');
assert.equal(q(`SELECT display_name FROM users WHERE line_user_id=?`, coach.userId)[0].display_name, '王教練');
assert.equal(q(`SELECT role FROM club_members WHERE club_id='c1' AND user_id=?`, coach.userId)[0].role, 'member');
// 不收季費；LINE 上的成員照常
const exemptOf = (uid: string) => q(`SELECT fee_exempt FROM season_members WHERE season_id=? AND user_id=?`, se.id, uid)[0].fee_exempt;
assert.deepEqual([exemptOf(coach.userId), exemptOf('U1')], [1, 0]);
await assert.rejects(m.setSeasonFeePaid(env, club(), se.id, coach.userId, true), isUserError(/不收季費/));
const seView = (await m.listSeasons(env, club()))[0].members;
assert.deepEqual(seView.filter((x: any) => x.feeExempt || x.external).map((x: any) => [x.name, x.feeExempt, x.external]), [['王教練', true, true]]);
assert.equal(seView.find((x: any) => x.userId === 'U1').feeExempt, false);
// 佔一個季打名額：滿的那場，最後報名的臨打（丙）退回候補
assert.deepEqual([reg(sid3, coach.userId).kind, reg(sid3, coach.userId).status], ['season', 'confirmed']);
assert.deepEqual(coach.changes.demoted.filter((x: any) => x.session.id === sid3).map((x: any) => x.p.user_id), ['U3']);
assert.equal(reg(sid3, 'U3').status, 'waitlist');
const names3 = async () => (await svc.roster(DB, 'c1', sid3)).confirmed.map((e: any) => `${e.name}:${e.kind}`);
assert.ok((await names3()).includes('王教練:season'), '出現在名單上');
// 同名再加一次：沿用同一個人，不會多一個
assert.equal((await m.addExternalSeasonMember(env, club(), se.id, '王教練')).userId, coach.userId);
assert.equal(q(`SELECT COUNT(*) n FROM users WHERE line_user_id LIKE 'ext%'`)[0].n, 1);
// 成員名單：標成非 LINE，不能當管理員或擁有者
const mv = await m.listMembers(env, club());
assert.deepEqual(mv.filter((x: any) => x.external).map((x: any) => x.displayName), ['王教練']);
await assert.rejects(m.setRole(env, club(), 'owner', coach.userId, 'admin'), isUserError(/不在 LINE 上的人不能設為管理員/));
await assert.rejects(m.transferOwner(env, club(), 'U2', 'owner', coach.userId), isUserError(/不能轉移給不在 LINE 上的人/));

// 他沒辦法自己操作：管理員代請假（丙遞補）、代銷假（已滿 → 候補第一位）
const coachReg = reg(sid3, coach.userId);
ch = await m.adminCancelRegistration(env, club(), sid3, coachReg.id);
assert.deepEqual(ch.promoted.map((x: any) => x.p.user_id), ['U3']);
assert.deepEqual(await m.adminUnleave(env, club(), sid3, coachReg.id), { status: 'waitlist', position: 1 });
await assert.rejects(m.adminUnleave(env, club(), sid3, coachReg.id), isUserError(/沒有請假/));
await assert.rejects(m.adminUnleave(env, club(), sid3, reg(sid3, 'U3').id), isUserError(/沒有請假/));
// 丙取消 → 教練遞補。通知沒辦法 @ 他，改用名字（一般文字訊息）；LINE 成員照常 @
const promoted = await svc.cancel(env, club(), s2(), 'U3', undefined, true);
assert.equal(promoted.user_id, coach.userId);
const notice = await notify.promotedMessage(env, club(), s2(), promoted);
assert.equal(notice.type, 'text');
assert.match(notice.text, /^王教練 已從候補遞補為正取（/);
const lineNotice = await notify.promotedMessage(env, club(), s2(), { id: 'x', user_id: 'U3', guest_name: '小明' });
assert.equal(lineNotice.type, 'textV2');
assert.match(lineNotice.text, /^\{u0\} 你的朋友 小明 已從候補遞補為正取（/);
assert.equal(lineNotice.substitution.u0.mentionee.userId, 'U3');
assert.match((await notify.promotedMessage(env, club(), s2(), { id: 'x', user_id: coach.userId, guest_name: '小明' })).text, /^王教練 的朋友 小明 已從候補遞補為正取（/);
// 有空位時代銷假 → 直接正取
await m.adminCancelRegistration(env, club(), sid3, coachReg.id);
assert.deepEqual(await m.adminUnleave(env, club(), sid3, coachReg.id), { status: 'confirmed', position: 0 });

// 移除：只能移除非 LINE 的人；還在沒結束的季期裡要先移出季打
await assert.rejects(m.removeExternalMember(env, club(), 'U3'), isUserError(/只能移除不在 LINE 上的人/));
await assert.rejects(m.removeExternalMember(env, club(), coach.userId), isUserError(/還在「本季」的季打名單裡/));
await m.adminRegister(env, club(), extra.id, coach.userId); // 另外以臨打身分報了臨時場
await m.removeSeasonMember(env, club(), se.id, coach.userId);
assert.equal(reg(sid3, coach.userId), undefined, '移出季打：未開打場次的名額取消');
await m.removeExternalMember(env, club(), coach.userId);
assert.equal(q(`SELECT COUNT(*) n FROM club_members WHERE user_id=?`, coach.userId)[0].n, 0);
assert.equal(q(`SELECT status FROM registrations WHERE session_id=? AND user_id=?`, extra.id, coach.userId)[0].status, 'cancelled', '尚未開打的報名一併取消');
assert.equal(q(`SELECT display_name FROM users WHERE line_user_id=?`, coach.userId)[0].display_name, '王教練', '使用者紀錄保留，過去的名單仍顯示得出名字');
assert.ok(!(await m.listMembers(env, club())).some((x: any) => x.external));
await assert.rejects(m.removeExternalMember(env, club(), coach.userId), isUserError(/找不到這位成員/));

// ---------- 刪除球團 ----------
// 另一個球團 c2（有自己的時段、季期、場次、報名、記帳、非 LINE 成員），用來確認刪 c1 不會動到別人
q(`INSERT INTO clubs (id, line_group_id, name, casual_fee, created_at) VALUES ('c2','G2','隔壁團',100,?)`, now);
const club2 = () => q(`SELECT * FROM clubs WHERE id='c2'`)[0];
q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c2','U1','owner',?),('c2','U3','member',?)`, now, now);
const sch2 = await m.createSchedule(env, club2(), { weekday: 2, startTime: '20:00', endTime: '22:00', venue: '隔壁館', courts: 1, capacity: 6 });
const se2 = await m.createSeason(env, club2(), { name: '隔壁季', startDate: `${futureYear}-01-01`, endDate: `${futureYear + 1}-12-31`, fee: 1000 });
await m.addSeasonMembers(env, club2(), se2.id, ['U1']);
const coach2 = await m.addExternalSeasonMember(env, club2(), se2.id, '隔壁教練');
const s2a = q(`SELECT * FROM sessions WHERE schedule_id=? ORDER BY start_at`, sch2.id)[0];
await m.adminRegister(env, club2(), s2a.id, 'U3');
const ledger = await import(SRC + '/src/ledger.ts');
await ledger.addLedgerEntry(env, club2(), { category: 'venue', amount: 500, date: d }, 'U1');
await ledger.addLedgerEntry(env, club(), { category: 'shuttle', amount: 800, date: d }, 'U2');
// c1 再加一位非 LINE 成員，刪球團時要跟著清掉
const coach1 = await m.addExternalSeasonMember(env, club(), se.id, '一團教練');
// 兩個球團各有一次抽籤紀錄（成員的勾選＋外面名單）
const drawsMod = await import(SRC + '/src/draws.ts');
for (const [c, uid] of [[club(), 'U2'], [club2(), 'U3']] as const) {
  const dr = await drawsMod.createDraw(env, c, { name: '場地抽籤' }, 'U1');
  await drawsMod.markDraw(env, c, dr.id, { userId: uid, field: 'won', value: true });
  await drawsMod.addOutsideEntries(env, c, dr.id, { names: '外面的人' });
}
const TABLES = ['club_members', 'schedules', 'seasons', 'season_members', 'sessions', 'registrations', 'ledger_entries', 'draws', 'draw_entries'];
const rowsOf = (clubId: string) => Object.fromEntries(TABLES.map((t) => [t, q(
  t === 'season_members' ? `SELECT COUNT(*) n FROM season_members WHERE season_id IN (SELECT id FROM seasons WHERE club_id=?)`
  : t === 'registrations' ? `SELECT COUNT(*) n FROM registrations WHERE session_id IN (SELECT id FROM sessions WHERE club_id=?)`
  : t === 'draw_entries' ? `SELECT COUNT(*) n FROM draw_entries WHERE draw_id IN (SELECT id FROM draws WHERE club_id=?)`
  : `SELECT COUNT(*) n FROM ${t} WHERE club_id=?`, clubId)[0].n]));
const before1 = rowsOf('c1');
const before2 = rowsOf('c2');
assert.ok(Object.values(before1).every((n: any) => n > 0) && Object.values(before2).every((n: any) => n > 0), '兩個球團每張表都有資料');
const auditsBefore = q(`SELECT COUNT(*) n FROM audit_logs`)[0].n;

// 只有擁有者、而且要打對球團名稱
await assert.rejects(m.deleteClub(env, club(), 'admin', '測試'), isUserError(/只有擁有者可以刪除球團/));
await assert.rejects(m.deleteClub(env, club(), 'owner', '測試團'), isUserError(/球團名稱不一樣，沒有刪除/));
await assert.rejects(m.deleteClub(env, club(), 'owner', undefined), isUserError(/球團名稱不一樣，沒有刪除/));
assert.deepEqual(rowsOf('c1'), before1, '沒通過確認就什麼都不刪');

const removed = await m.deleteClub(env, club(), 'owner', ' 測試 ');
assert.deepEqual({ ...removed }, { members: before1.club_members, schedules: before1.schedules, seasons: before1.seasons, sessions: before1.sessions, registrations: before1.registrations, ledgerEntries: before1.ledger_entries, draws: before1.draws });
assert.equal(q(`SELECT COUNT(*) n FROM clubs WHERE id='c1'`)[0].n, 0);
assert.ok(Object.values(rowsOf('c1')).every((n: any) => n === 0), 'c1 的資料全部刪掉');
assert.deepEqual(rowsOf('c2'), before2, '別的球團原封不動');
assert.equal(q(`SELECT COUNT(*) n FROM clubs WHERE id='c2'`)[0].n, 1);
// 使用者：LINE 上的人保留；c1 手動建立的非 LINE 成員清掉，c2 還在用的留著
const userIds = q(`SELECT line_user_id FROM users`).map((r: any) => r.line_user_id);
assert.ok(['U1', 'U2', 'U3', 'U4', 'U5'].every((u) => userIds.includes(u)));
assert.ok(!userIds.includes(coach1.userId) && !userIds.includes(coach.userId), 'c1 的非 LINE 成員清掉了');
assert.ok(userIds.includes(coach2.userId));
assert.equal(q(`SELECT COUNT(*) n FROM audit_logs`)[0].n, auditsBefore, '稽核紀錄保留');
// 外鍵都還完整
assert.deepEqual(q(`PRAGMA foreign_key_check`), []);
console.log('ALL MANAGE TESTS PASSED');
