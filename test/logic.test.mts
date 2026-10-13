import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const svc = await import(SRC + '/src/service.ts');
const { runCron, advanceStatuses } = await import(SRC + '/src/cron.ts');
const { parseCommand } = await import(SRC + '/src/commands.ts');
const { zonedToUtc, formatLocal } = await import(SRC + '/src/time.ts');
const { UserError } = await import(SRC + '/src/types.ts');

// --- 以 node:sqlite 模擬 D1 介面 ---
const raw = new DatabaseSync(':memory:');
raw.exec('PRAGMA foreign_keys = ON');
raw.exec(readFileSync(SRC + '/schema.sql', 'utf8'));
function stmt(sql: string, vals: unknown[] = []): any {
  const exec = () => raw.prepare(sql).all(...(vals as any[]));
  return {
    bind: (...v: unknown[]) => stmt(sql, v),
    first: async () => exec()[0] ?? null,
    all: async () => ({ results: exec(), success: true }),
    run: async () => { exec(); return { results: [], success: true }; },
    _exec: exec,
  };
}
const DB: any = {
  prepare: (sql: string) => stmt(sql),
  batch: async (list: any[]) => {
    raw.exec('BEGIN');
    try { const out = list.map((s) => ({ results: s._exec(), success: true })); raw.exec('COMMIT'); return out; }
    catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
};
const env: any = { DB };
const q = (sql: string, ...v: any[]) => raw.prepare(sql).all(...v) as any[];

// --- 時間 ---
assert.equal(new Date(zonedToUtc('2026-10-14', '20:00', 'Asia/Taipei')).toISOString(), '2026-10-14T12:00:00.000Z');
assert.equal(formatLocal(Date.parse('2026-10-14T12:00:00Z'), 'Asia/Taipei'), '10/14（三）20:00');

// --- 指令解析 ---
const join = (o: object) => ({ type: 'join', weekday: undefined, guest: undefined, gender: undefined, level: undefined, ...o });
assert.deepEqual(parseCommand('+1'), join({}));
assert.deepEqual(parseCommand('＋1 小明'), join({ guest: '小明' }));
assert.deepEqual(parseCommand('+1 週三 小明'), join({ weekday: 3, guest: '小明' }));
// 最後面的詞是男／女時當成性別：自己（+1 女）或朋友（+1 小美 女）都可以加
assert.deepEqual(parseCommand('+1 小美 女'), join({ guest: '小美', gender: 'F' }));
assert.deepEqual(parseCommand('＋１　週三　小美　女生'), join({ weekday: 3, guest: '小美', gender: 'F' }));
assert.deepEqual(parseCommand('+1 阿明 男'), join({ guest: '阿明', gender: 'M' }));
assert.deepEqual(parseCommand('+1 女'), join({ gender: 'F' }));
assert.deepEqual(parseCommand('+1 週三 男生'), join({ weekday: 3, gender: 'M' }));
assert.deepEqual(parseCommand('-1 小美 女'), { type: 'cancel', weekday: undefined, guest: '小美' });
// 程度：6級、L6、Lv6 這類寫法，和性別的順序不拘；光一個數字仍當成名字
assert.deepEqual(parseCommand('+1 6級'), join({ level: 6 }));
assert.deepEqual(parseCommand('+1 女 ６級'), join({ gender: 'F', level: 6 }));
assert.deepEqual(parseCommand('+1 小美 L10 女'), join({ guest: '小美', gender: 'F', level: 10 }));
assert.deepEqual(parseCommand('+1 週三 阿明 lv.4'), join({ weekday: 3, guest: '阿明', level: 4 }));
assert.deepEqual(parseCommand('+1 Level8級'), join({ level: 8 }));
assert.deepEqual(parseCommand('+1 6'), join({ guest: '6' }));
assert.deepEqual(parseCommand('+1 99級'), join({ level: 99 }), '超出範圍的在報名時才擋');
assert.deepEqual(parseCommand('-1 小美 女 6級'), { type: 'cancel', weekday: undefined, guest: '小美' });
assert.deepEqual(parseCommand('－1'), { type: 'cancel', weekday: undefined, guest: undefined });
assert.deepEqual(parseCommand('請假 星期日'), { type: 'leave', weekday: 0 });
assert.deepEqual(parseCommand('/綁定 週三 羽球團'), { type: 'bind', arg: '週三 羽球團' });
assert.equal(parseCommand('今天好熱'), null);

// --- 資料準備：上限 3 人、季打 2 人 ---
const now = new Date().toISOString();
for (const [id, n] of [['U1','季打甲'],['U2','季打乙'],['U3','臨打丙'],['U4','臨打丁'],['U5','臨打戊']])
  q('INSERT INTO users VALUES (?,?,NULL,?)', id, n, now);
q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES ('c1','G1','測試球團',?)`, now);
for (const u of ['U1','U2','U3','U4','U5']) q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c1',?,'member',?)`, u, now);
q(`INSERT INTO schedules (id, club_id, weekday, start_time, end_time, venue, court_no, courts, capacity) VALUES ('wed','c1',3,'20:00','22:00','體育館','第 3 場',1,3)`);
q(`INSERT INTO seasons VALUES ('s1','c1','Q4','2026-10-01','2026-12-31',3000)`);
q(`INSERT INTO season_members (season_id, user_id) VALUES ('s1','U1'),('s1','U2')`);

await runCron(env);
await runCron(env); // 重跑不應重複
const sessions = q(`SELECT * FROM sessions ORDER BY start_at`);
console.log('場次', sessions.map((s) => `${s.id} ${s.status} open=${s.reg_open_at}`));
assert.ok(sessions.length >= 4);
assert.ok(sessions.every((s) => s.court_no === '第 3 場'), '第幾場地由時段帶入');
const sid = sessions[0].id;
assert.equal(q(`SELECT COUNT(*) n FROM registrations WHERE session_id=?`, sid)[0].n, 2);

const club = q(`SELECT * FROM clubs WHERE id='c1'`)[0];
const getS = () => q(`SELECT * FROM sessions WHERE id=?`, sid)[0];

// 尚未開放（最近一場在開打前 3 天內跑測試時已經自動開放，先固定成尚未開放，結果才不會跟著時鐘變）
q(`UPDATE sessions SET status='scheduled' WHERE id=?`, sid);
await assert.rejects(svc.register(env, club, getS(), 'U3'), (e: any) => e instanceof UserError && /還沒開放/.test(e.message));
q(`UPDATE sessions SET status='open' WHERE id=?`, sid);

assert.deepEqual(await svc.register(env, club, getS(), 'U3'), { status: 'confirmed', position: 0 });
assert.deepEqual(await svc.register(env, club, getS(), 'U4', undefined, { level: 7 }), { status: 'waitlist', position: 1 });
assert.deepEqual(await svc.register(env, club, getS(), 'U3', '小明', { gender: 'M', level: 4 }), { status: 'waitlist', position: 2 });
assert.deepEqual(q(`SELECT gender, level FROM registrations WHERE session_id=? AND guest_name='小明'`, sid).map((x) => ({ ...x })), [{ gender: 'M', level: 4 }]);
await assert.rejects(svc.register(env, club, getS(), 'U3'), /已經報名了（正取）/);
await assert.rejects(svc.register(env, club, getS(), 'U1'), /季打成員/);

// 季打請假 → 候補第一位（U4）遞補
const p1 = await svc.leave(env, getS(), 'U1');
assert.equal(p1?.user_id, 'U4');
// 銷假 → 已滿，排候補第一位（在小明前面）
assert.deepEqual(await svc.unleave(env, getS(), 'U1'), { status: 'waitlist', position: 1 });
// 臨打取消 → 銷假的季打遞補
const p2 = await svc.cancel(env, club, getS(), 'U3', undefined, false);
assert.equal(p2?.user_id, 'U1');
assert.equal(p2?.guest_name, null);
// 取消代報的朋友（候補中），沒有人遞補
assert.equal(await svc.cancel(env, club, getS(), 'U3', '小明', false), null);
// 取消後可重新報名（部分唯一索引不擋已取消的那筆）
assert.deepEqual(await svc.register(env, club, getS(), 'U3'), { status: 'waitlist', position: 1 });

const r = await svc.roster(DB, 'c1', sid);
console.log('正取', r.confirmed.map((e: any) => e.name), '候補', r.waitlist.map((e: any) => e.name), '請假', r.leave.map((e: any) => e.name));
assert.deepEqual(r.confirmed.map((e: any) => e.name), ['季打乙', '季打甲', '臨打丁']);
assert.deepEqual(r.waitlist.map((e: any) => e.name), ['臨打丙']);
// 程度只在有填的臨打那筆上：丁報名時填 7 級；丙取消後重報沒填；季打沒有
assert.deepEqual(r.confirmed.map((e: any) => e.level), [null, null, 7]);
assert.deepEqual(r.waitlist.map((e: any) => e.level), [null]);

// 取消期限
const tight = { ...club, cancel_deadline_minutes_before: 60 * 24 * 365 };
await assert.rejects(svc.cancel(env, tight, getS(), 'U3', undefined, false), /取消期限/);
assert.equal(await svc.cancel(env, tight, getS(), 'U3', undefined, true), null); // 管理員可以

// 退群：U4 的正取釋出（此時沒有候補）
const released = await svc.releaseLeftMember(env, 'c1', 'U4');
assert.equal(released.length, 0);
assert.equal(q(`SELECT status FROM registrations WHERE session_id=? AND user_id='U4'`, sid)[0].status, 'cancelled');

// 狀態推進：遠在未來的時間點，全部 done
await advanceStatuses(env, Date.parse('2027-06-01T00:00:00Z'));
assert.equal(q(`SELECT COUNT(*) n FROM sessions WHERE status<>'done'`)[0].n, 0);
console.log('ALL TESTS PASSED');
