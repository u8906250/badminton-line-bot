// 排程的容量相關行為：每輪只補幾個球團的場次、已建好的場次不重算、狀態每輪對所有球團推進。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { runCron, generateSessions, clubsForRun, CLUBS_PER_RUN, RUN_EVERY_MS } = await import(SRC + '/src/cron.ts');
const T = await import(SRC + '/src/time.ts');
const L = await import(SRC + '/src/ledger.ts');

// ---- 排程間隔要和 wrangler.toml 一致（輪到哪幾個球團是用「第幾輪」算的）----
const cron = readFileSync(SRC + '/wrangler.toml', 'utf8').match(/^crons\s*=\s*\["\*\/(\d+) \* \* \* \*"\]/m);
assert.ok(cron, 'wrangler.toml 的 crons 應該是每 N 分鐘一次的寫法');
assert.equal(Number(cron![1]) * 60_000, RUN_EVERY_MS, '改了排程間隔，src/cron.ts 的 RUN_EVERY_MS 要一起改');
assert.equal(CLUBS_PER_RUN, 5);

// ---- 時區換算：格式器重用之後，不同時區、日光節約時間都還是對的 ----
assert.equal(T.zonedToUtc('2026-10-14', '20:00', 'Asia/Taipei'), Date.parse('2026-10-14T12:00:00Z'));
assert.equal(T.zonedToUtc('2026-07-01', '20:00', 'America/New_York'), Date.parse('2026-07-02T00:00:00Z')); // 夏令 UTC-4
assert.equal(T.zonedToUtc('2026-12-01', '20:00', 'America/New_York'), Date.parse('2026-12-02T01:00:00Z')); // 冬令 UTC-5
assert.equal(T.zonedToUtc('2026-10-14', '20:00', 'Asia/Taipei'), Date.parse('2026-10-14T12:00:00Z'), '換過別的時區再換回來');
assert.equal(T.localDate(Date.parse('2026-10-14T16:30:00Z'), 'Asia/Taipei'), '2026-10-15');
assert.equal(T.localDate(Date.parse('2026-10-14T16:30:00Z'), 'America/New_York'), '2026-10-14');
assert.equal(T.formatLocal(Date.parse('2026-10-14T12:00:00Z'), 'Asia/Taipei'), '10/14（三）20:00');
assert.equal(T.formatLocal(Date.parse('2026-10-14T12:00:00Z'), 'Asia/Tokyo'), '10/14（三）21:00');

const NOW = Math.floor(Date.parse('2026-10-14T04:00:00.000Z') / RUN_EVERY_MS) * RUN_EVERY_MS; // 台北 10/14（三）12:00
const run = (k: number) => NOW + k * RUN_EVERY_MS + 1500; // 第 k 輪（排程實際執行會比整點晚一點）
const DAY = 86_400_000;
const isoAt = (ts: number) => new Date(ts).toISOString();

function setup(n: number) {
  const { DB, q } = createTestDb(SRC + '/schema.sql');
  const env: any = { DB, LIFF_ID: 'x', LINE_CHANNEL_ACCESS_TOKEN: 'x' };
  q('INSERT INTO users VALUES (?,?,NULL,?)', 'U1', '甲', isoAt(NOW));
  q('INSERT INTO users VALUES (?,?,NULL,?)', 'U2', '乙', isoAt(NOW));
  const ids = Array.from({ length: n }, (_, i) => `c${String(i).padStart(2, '0')}`);
  for (const id of ids) {
    q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES (?,?,?,?)`, id, `G-${id}`, id, isoAt(NOW));
    // 每週六 20:00–22:00；開打前 3 天中午開放
    q(`INSERT INTO schedules (id, club_id, weekday, start_time, end_time, venue, courts, capacity) VALUES (?,?,6,'20:00','22:00','體育館',2,15)`, `${id}-sat`, id);
  }
  const picked = async (k: number) => (await clubsForRun(DB, run(k)).all()).results.map((c: any) => c.id) as string[];
  const withSessions = () => q(`SELECT DISTINCT club_id FROM sessions ORDER BY club_id`).map((r: any) => r.club_id) as string[];
  return { DB, q, env, ids, picked, withSessions };
}

// ---- 球團數不超過 CLUBS_PER_RUN：每輪都是全部 ----
for (const n of [1, 3, 5]) {
  const { ids, picked, env, withSessions } = setup(n);
  for (const k of [0, 1, 2, 7, 1000]) assert.deepEqual(await picked(k), ids, `${n} 團第 ${k} 輪`);
  await runCron(env, run(0));
  assert.deepEqual(withSessions(), ids);
}
// 沒有球團：不出錯
await runCron(setup(0).env, run(0));

// ---- 球團比較多：每輪剛好 CLUBS_PER_RUN 個、繞一圈、每個球團都在 ceil(n ÷ 5) 輪內輪到 ----
for (const n of [6, 7, 10, 12, 23, 50]) {
  const { ids, picked } = setup(n);
  const base = Math.floor(NOW / RUN_EVERY_MS);
  const within = Math.ceil(n / CLUBS_PER_RUN);
  const lastSeen = new Map<string, number>();
  for (let k = 0; k < 3 * n; k++) {
    const got = await picked(k);
    assert.equal(got.length, CLUBS_PER_RUN, `${n} 團第 ${k} 輪`);
    assert.equal(new Set(got).size, CLUBS_PER_RUN);
    // 從 (第幾輪 × 5) 的位置往後取 5 個，到底繞回開頭
    const start = ((base + k) * CLUBS_PER_RUN) % n;
    assert.deepEqual([...got].sort(), Array.from({ length: CLUBS_PER_RUN }, (_, i) => ids[(start + i) % n]).sort());
    for (const id of got) lastSeen.set(id, k);
    if (k >= within - 1) for (const id of ids) assert.ok(k - (lastSeen.get(id) ?? -Infinity) < within, `${n} 團：${id} 超過 ${within} 輪沒輪到（第 ${k} 輪）`);
  }
}

// ---- 12 個球團實際跑排程 ----
const { q, env, ids, picked, withSessions } = setup(12);
const sessionsOf = (club: string) => q(`SELECT * FROM sessions WHERE club_id=? ORDER BY start_at`, club);
// 第一輪只有輪到的 5 個球團有場次；3 輪之內全部都有
await runCron(env, run(0));
assert.deepEqual(withSessions(), (await picked(0)).sort());
await runCron(env, run(1));
await runCron(env, run(2));
assert.deepEqual(withSessions(), ids);
// 每個球團未來 4 週的週六各一場（10/17、10/24、10/31、11/7），時間與開放時間正確
for (const id of ids) {
  const list = sessionsOf(id);
  assert.deepEqual(list.map((s: any) => s.id), ['10-17', '10-24', '10-31', '11-07'].map((d) => `${id}-sat_2026-${d}`), id);
  assert.deepEqual([list[0].start_at, list[0].end_at, list[0].reg_open_at, list[0].reg_close_at, list[0].status],
    ['2026-10-17T12:00:00.000Z', '2026-10-17T14:00:00.000Z', '2026-10-14T04:00:00.000Z', '2026-10-17T12:00:00.000Z', 'open'], id);
}
// 沒輪到補場次的球團，狀態照樣每輪推進：把 c11 的一場改成 5 分鐘後開放，下一輪就會變成報名中
const turnOf = async (club: string, from: number) => { for (let k = from; ; k++) if ((await picked(k)).includes(club)) return k; };
let k = 3;
while ((await picked(k)).includes('c11') || (await picked(k + 1)).includes('c11')) k++;
q(`UPDATE sessions SET status='scheduled', reg_open_at=? WHERE id='c11-sat_2026-10-24'`, isoAt(run(k) + 60_000));
await runCron(env, run(k));
assert.equal(q(`SELECT status FROM sessions WHERE id='c11-sat_2026-10-24'`)[0].status, 'scheduled');
await runCron(env, run(k + 1));
assert.equal(q(`SELECT status FROM sessions WHERE id='c11-sat_2026-10-24'`)[0].status, 'open', '沒輪到補場次的那一輪也會推進狀態');

// 重跑很多輪：不會多出場次，也不會把單場改過的內容蓋回去
q(`UPDATE sessions SET capacity=12, court_no='第 5 場', venue='別的地方' WHERE id='c03-sat_2026-10-24'`);
const snapshot = () => JSON.stringify(q(`SELECT * FROM sessions ORDER BY id`));
const before = snapshot();
for (let i = 0; i < 12; i++) await runCron(env, run(k + 2 + i));
assert.equal(snapshot(), before);
assert.equal(q(`SELECT COUNT(*) n FROM sessions`)[0].n, 48);
k += 14;

// 季期晚於場次建立（直接寫進資料庫，沒有經過管理頁面）：輪到時補上 season_id 與季打佔位；沒輪到的不動
for (const c of ['c02', 'c09']) {
  q(`INSERT INTO seasons (id, club_id, name, start_date, end_date, fee) VALUES (?,?,'第四季','2026-10-01','2026-10-31',3000)`, `${c}-q4`, c);
  q(`INSERT INTO season_members (season_id, user_id) VALUES (?, 'U1')`, `${c}-q4`);
}
const seasonState = (c: string) => sessionsOf(c).map((s: any) => [s.season_id, q(`SELECT user_id, kind, status FROM registrations WHERE session_id=? ORDER BY user_id`, s.id).map((r: any) => `${r.user_id}:${r.kind}:${r.status}`).join(',')]);
for (const c of ['c02', 'c09']) {
  const t = await turnOf(c, k);
  for (let i = k; i < t; i++) await runCron(env, run(i));
  if (t > k) assert.deepEqual(seasonState(c).map((x: any) => x[0]), [null, null, null, null], `${c} 還沒輪到`);
  await runCron(env, run(t));
  // 季期到 10/31：前三場屬於這一季，11/7 那場不是
  assert.deepEqual(seasonState(c), [[`${c}-q4`, 'U1:season:confirmed'], [`${c}-q4`, 'U1:season:confirmed'], [`${c}-q4`, 'U1:season:confirmed'], [null, '']], c);
  k = t + 1;
}
// 之後用 SQL 加進季打名單的人（seed.sql 的做法）：輪到時出現在已建好的場次；請假的那筆不會被改回正取
q(`UPDATE registrations SET status='leave' WHERE id='c02-sat_2026-10-17_s_U1'`);
q(`INSERT INTO season_members (season_id, user_id) VALUES ('c02-q4', 'U2')`);
const t2 = await turnOf('c02', k);
for (let i = k; i <= t2; i++) await runCron(env, run(i));
assert.deepEqual(seasonState('c02').map((x: any) => x[1]), ['U1:season:leave,U2:season:confirmed', 'U1:season:confirmed,U2:season:confirmed', 'U1:season:confirmed,U2:season:confirmed', '']);
// 已取消的場次不會被補上季打佔位
q(`UPDATE sessions SET status='cancelled' WHERE id='c09-sat_2026-10-24'`);
q(`INSERT INTO season_members (season_id, user_id) VALUES ('c09-q4', 'U2')`);
const t3 = await turnOf('c09', t2 + 1);
for (let i = t2 + 1; i <= t3; i++) await runCron(env, run(i));
assert.deepEqual(seasonState('c09').map((x: any) => x[1]), ['U1:season:confirmed,U2:season:confirmed', 'U1:season:confirmed', 'U1:season:confirmed,U2:season:confirmed', '']);

// 管理員改時段、建季期時是指定球團立刻補（不用等輪到）：帶 onlyClubId 只處理那一個
q(`INSERT INTO schedules (id, club_id, weekday, start_time, end_time, venue, courts, capacity) VALUES ('c07-wed','c07',3,'19:00','21:00','體育館',2,15)`);
const others = q(`SELECT COUNT(*) n FROM sessions WHERE club_id <> 'c07'`)[0].n;
await generateSessions(env, run(t3 + 1), 'c07');
assert.deepEqual(q(`SELECT id FROM sessions WHERE schedule_id='c07-wed' ORDER BY start_at`).map((r: any) => r.id), ['10-14', '10-21', '10-28', '11-04', '11-11'].map((d) => `c07-wed_2026-${d}`));
assert.equal(q(`SELECT COUNT(*) n FROM sessions WHERE club_id <> 'c07'`)[0].n, others);

// 時間往後推：過了的場次結束、每週補上新的一場（最慢 ceil(12 ÷ 5) = 3 輪內）
const week = Math.round((7 * DAY) / RUN_EVERY_MS);
for (let i = 0; i < 3; i++) await runCron(env, run(week + i));
for (const id of ids) {
  const list = sessionsOf(id).filter((s: any) => s.schedule_id === `${id}-sat`);
  assert.deepEqual(list.map((s: any) => [s.id.slice(-5), s.status]), [['10-17', 'done'], ['10-24', id === 'c09' ? 'cancelled' : 'open'], ['10-31', 'scheduled'], ['11-07', 'scheduled'], ['11-14', 'scheduled']], id);
}

// ---- 帳本權限的查詢改寫後，別的球團的季打名單再多也不影響結果 ----
const clubRow = (id: string) => q(`SELECT * FROM clubs WHERE id=?`, id)[0];
assert.equal(await L.canViewLedger(env, clubRow('c02'), 'U2', 'member', run(0)), true);
assert.equal(await L.canViewLedger(env, clubRow('c09'), 'U2', 'member', run(0)), true);
assert.equal(await L.canViewLedger(env, clubRow('c03'), 'U2', 'member', run(0)), false, '別的球團的季打不算');
q(`DELETE FROM season_members WHERE season_id='c09-q4' AND user_id='U2'`);
assert.equal(await L.canViewLedger(env, clubRow('c09'), 'U2', 'member', run(0)), false);

console.log('ALL CRON TESTS PASSED');
