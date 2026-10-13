import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { runCron } = await import(SRC + '/src/cron.ts');
const { canAffordOpenNotice } = await import(SRC + '/src/notify.ts');
const m = await import(SRC + '/src/manage.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
// 這個功能在正式環境是鎖住的（沒設 OPEN_NOTICE）；這裡先打開測發送規則，鎖住的情況在最後面
const env: any = { DB, LIFF_ID: 'liff-1', LINE_CHANNEL_ACCESS_TOKEN: 'x', OPEN_NOTICE: 'on' };

// 假的 LINE：額度、群組人數可以調，推播記下來
const line = { limit: 200 as number | null, used: 0, groupSize: 20, countFails: false, pushFails: false, calls: 0 };
const pushes: { to: string; text: string }[] = [];
globalThis.fetch = (async (url: any, init: any = {}) => {
  const path = String(url).replace('https://api.line.me', '');
  line.calls++;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === '/v2/bot/message/quota') return json(line.limit === null ? { type: 'none' } : { type: 'limited', value: line.limit });
  if (path === '/v2/bot/message/quota/consumption') return json({ totalUsage: line.used });
  if (/^\/v2\/bot\/group\/[^/]+\/members\/count$/.test(path)) return line.countFails ? json({ message: 'nope' }, 403) : json({ count: line.groupSize });
  if (path === '/v2/bot/message/push') {
    if (line.pushFails) return json({ message: 'You have reached your monthly limit.' }, 429);
    const body = JSON.parse(init.body);
    pushes.push({ to: body.to, text: body.messages.map((x: any) => x.text).join('\n---\n') });
    line.used += line.groupSize;
    return json({});
  }
  throw new Error('unexpected request: ' + path);
}) as any;

const NOW = Date.now();
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
q('INSERT INTO users VALUES (?,?,NULL,?)', 'U1', '甲', at(0));
for (const c of ['c1', 'c2']) q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES (?,?,?,?)`, c, `G-${c}`, c, at(0));
const club = (id = 'c1') => q(`SELECT * FROM clubs WHERE id=?`, id)[0];
let n = 0;
/** 開放時間在 openMin 分鐘後（負的 = 已經過了）、兩天後開打的場次。 */
const session = (openMin: number, o: { club?: string; capacity?: number; court?: string | null; startMin?: number } = {}) => {
  const id = `s${++n}`;
  const start = (o.startMin ?? 2880) + n; // 讓每場的開打時間不同，排序固定
  q(`INSERT INTO sessions (id, club_id, start_at, end_at, venue, court_no, courts, capacity, reg_open_at, reg_close_at, status) VALUES (?,?,?,?,'體育館',?,2,?,?,?,'scheduled')`,
    id, o.club ?? 'c1', at(start), at(start + 120), o.court ?? null, o.capacity ?? 15, at(openMin), at(start));
  return id;
};
const notified = (id: string) => q(`SELECT open_notified_at FROM sessions WHERE id=?`, id)[0].open_notified_at;
const logs = () => q(`SELECT detail FROM audit_logs WHERE action='notify.open' ORDER BY id`).map((r: any) => JSON.parse(r.detail));

// 沒開啟通知：開放了也不發，場次也不會被標記
const a = session(-1);
await runCron(env, NOW);
assert.equal(q(`SELECT status FROM sessions WHERE id=?`, a)[0].status, 'open');
assert.deepEqual([pushes.length, notified(a), logs().length], [0, null, 0]);

// 開啟（設定頁的開關）→ 下一輪排程補發剛開放的那一場；再跑不會重發
await m.updateSettings(env, club(), { notifyOnOpen: true });
assert.equal(club().notify_on_open, 1);
await m.updateSettings(env, club(), { casualFee: 250 });
assert.equal(club().notify_on_open, 1, '沒帶的欄位不動');
q(`UPDATE sessions SET court_no='第 3、4 場' WHERE id=?`, a);
q(`INSERT INTO registrations (id, session_id, user_id, kind, status, queued_at, updated_at) VALUES ('r1',?,'U1','season','confirmed',?,?)`, a, at(0), at(0));
await runCron(env, NOW);
assert.equal(pushes.length, 1);
assert.equal(pushes[0].to, 'G-c1');
console.log(pushes[0].text);
const lines = pushes[0].text.split('\n');
assert.match(lines[0], /^【開放報名】\d+\/\d+（.）\d\d:\d\d$/);
assert.equal(lines[1], '體育館 第 3、4 場・還有 14 個名額');
assert.equal(lines[2], '在群組輸入「+1」，或開報名頁報名：https://liff.line.me/liff-1?club=c1');
assert.ok(notified(a));
assert.deepEqual(logs().map((d: any) => [d.sessions, d.sent, d.used, d.limit, d.groupSize]), [[[a], true, 0, 200, 20]]);
await runCron(env, NOW + 5 * 60_000);
assert.equal(pushes.length, 1, '同一場只通知一次');

// 還沒到開放時間的不發；到了才發。同時開放的兩場合併成一則，額滿的寫可排候補
const b = session(3, { capacity: 1 });
const c = session(3);
q(`INSERT INTO registrations (id, session_id, user_id, kind, status, queued_at, updated_at) VALUES ('r2',?,'U1','season','confirmed',?,?)`, b, at(0), at(0));
await runCron(env, NOW);
assert.equal(pushes.length, 1);
await runCron(env, NOW + 5 * 60_000);
assert.equal(pushes.length, 2);
console.log(pushes[1].text);
assert.deepEqual(pushes[1].text.split('\n').filter((x) => !x.startsWith('【')), ['體育館・目前額滿，可排候補', '體育館・還有 15 個名額', '開報名頁報名：https://liff.line.me/liff-1?club=c1']);
assert.equal(pushes[1].text.split('\n').filter((x) => x.startsWith('【開放報名】')).length, 2);

// 開放很久的（例如排程停了一陣子、或開關是後來才開的）不補發
const stale = session(-45);
await runCron(env, NOW);
assert.deepEqual([pushes.length, notified(stale)], [2, null]);

// 額度：發完還要夠再推播一次才發（留給遞補通知）。不夠就略過、記錄，之後也不補發
assert.equal(canAffordOpenNotice({ unlimited: false, limit: 200, used: 160, groupSize: 20 }), true);
assert.equal(canAffordOpenNotice({ unlimited: false, limit: 200, used: 161, groupSize: 20 }), false);
assert.equal(canAffordOpenNotice({ unlimited: true, limit: null, used: 9999, groupSize: 20 }), true);
assert.equal(canAffordOpenNotice({ unlimited: false, limit: 200, used: 190, groupSize: null }), true, '查不到人數就照發，額度真的不夠 LINE 會拒絕');
line.used = 170;
const d = session(-1);
await runCron(env, NOW);
assert.equal(pushes.length, 2);
assert.ok(notified(d));
assert.deepEqual([logs().at(-1).sent, logs().at(-1).reason, logs().at(-1).used], [false, 'quota', 170]);
line.used = 0;
await runCron(env, NOW + 5 * 60_000);
assert.equal(pushes.length, 2, '略過的不會在額度恢復後補發');

// 沒有上限的方案、查不到群組人數：照發
line.limit = null; line.used = 5000; line.countFails = true;
session(-1);
await runCron(env, NOW);
assert.equal(pushes.length, 3);
assert.deepEqual([logs().at(-1).sent, logs().at(-1).unlimited, logs().at(-1).groupSize], [true, true, null]);

// LINE 拒絕（例如額度真的用完）：記錄失敗，不重試，排程其他工作照常
line.limit = 200; line.used = 0; line.countFails = false; line.pushFails = true;
const f = session(-1);
await runCron(env, NOW);
assert.equal(pushes.length, 3);
assert.deepEqual([logs().at(-1).sent, logs().at(-1).reason, !!notified(f)], [false, 'error', true]);
assert.match(logs().at(-1).error, /429/);
line.pushFails = false;

// 各球團各自的群組、各自的開關
const other = session(-1, { club: 'c2' });
await runCron(env, NOW);
assert.deepEqual([pushes.length, notified(other)], [3, null]);
q(`UPDATE clubs SET notify_on_open = 1 WHERE id='c2'`);
await runCron(env, NOW);
assert.equal(pushes.at(-1)!.to, 'G-c2');
assert.match(pushes.at(-1)!.text, /club=c2$/);

// 不是最近一場（前面還有別場沒打）：不提示「+1」，免得報到別場
q(`UPDATE clubs SET notify_on_open = 0 WHERE id='c2'`);
session(-1, { startMin: 10_000 });
await runCron(env, NOW);
assert.ok(pushes.at(-1)!.text.endsWith('\n開報名頁報名：https://liff.line.me/liff-1?club=c1'));

// 關掉之後就不發
await m.updateSettings(env, club(), { notifyOnOpen: false });
session(-1);
const before = pushes.length;
await runCron(env, NOW);
assert.equal(pushes.length, before);

// 功能鎖住（沒設 OPEN_NOTICE）：球團的開關開著也不發，不標記場次、不查額度、不寫紀錄；排程其他工作照常
const locked: any = { ...env, OPEN_NOTICE: undefined };
q(`UPDATE clubs SET notify_on_open = 1 WHERE id='c1'`);
const g = session(-1);
const quiet = [pushes.length, line.calls, logs().length];
await runCron(locked, NOW);
assert.deepEqual([pushes.length, line.calls, logs().length], quiet);
assert.deepEqual({ ...q(`SELECT status, open_notified_at FROM sessions WHERE id=?`, g)[0] }, { status: 'open', open_notified_at: null });
// 鎖住時設定改不了開關（開、關都不理），其他欄位照存
await m.updateSettings(locked, club(), { notifyOnOpen: false, casualFee: 300 });
assert.deepEqual([club().notify_on_open, club().casual_fee], [1, 300]);
q(`UPDATE clubs SET notify_on_open = 0 WHERE id='c1'`);
await m.updateSettings(locked, club(), { notifyOnOpen: true });
assert.equal(club().notify_on_open, 0);
// 擋住的只有這個鎖：解開、球團也開啟之後，剛開放的那一場照常補發
await m.updateSettings(env, club(), { notifyOnOpen: true });
await runCron(env, NOW);
assert.equal(pushes.length, quiet[0] + 1);
assert.ok(notified(g));
console.log('ALL NOTIFY TESTS PASSED');
