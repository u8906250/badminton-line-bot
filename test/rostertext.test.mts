// 文字名單（rosterText）：照球團在群組貼的格式產生。
import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const R = await import(SRC + '/src/rostertext.ts');
const { UserError } = await import(SRC + '/src/types.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
const env: any = { DB, LIFF_ID: 'x', LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const t = '2026-10-01T00:00:00.000Z';
q(`INSERT INTO clubs (id, line_group_id, name, rules, created_at) VALUES ('c1','G1','快樂羽球團',?,?)`, '👉若臨時無法出席，請務必提前至少四小時請假，拜託拜託喔~\n', t);
const club = () => q(`SELECT * FROM clubs WHERE id='c1'`)[0];
q(`INSERT INTO seasons (id, club_id, name, start_date, end_date, fee) VALUES ('q4','c1','115年第四季','2026-10-01','2026-12-31',3000)`);
const SEASON = ['甲一', '乙二', 'Amy', 'Ben', 'Carl', '丙三', '丁四', 'Dave', 'Eric', '阿戊', 'Fred', '小己'];
const users: [string, string][] = SEASON.map((n, i) => [`U${i + 1}`, n]);
users.push(['ext_coach', '教練'], ['U20', '庚七'], ['U21', '路人'], ['U22', '小明']);
for (const [id, n] of users) {
  q('INSERT INTO users VALUES (?,?,NULL,?)', id, `LINE的${n}`, t);
  q(`INSERT INTO club_members (club_id, user_id, role, nickname, joined_at) VALUES ('c1',?,?,?,?)`, id, id === 'U4' ? 'owner' : 'member', n, t);
}
// 這一季從 10/1 開始，每週日 18:00–20:00（台北），10/25 是第 4 個週日。資料庫裡只有其中幾場（系統季中才開始用），標題照樣是（4）
const sess = (id: string, date: string, status = 'scheduled', season: string | null = 'q4', o: { start?: string; end?: string; court?: string | null; venue?: string | null; capacity?: number } = {}) =>
  q(`INSERT INTO sessions (id, club_id, season_id, start_at, end_at, venue, court_no, courts, capacity, reg_open_at, reg_close_at, status) VALUES (?,?,?,?,?,?,?,2,?,?,?,?)`,
    id, 'c1', season, `${date}T${o.start ?? '10:00'}:00.000Z`, `${date}T${o.end ?? '12:00'}:00.000Z`, o.venue === undefined ? '某某國小' : o.venue, o.court === undefined ? '第 2 & 4 號球場' : o.court, o.capacity ?? 16, `${date}T00:00:00.000Z`, `${date}T10:00:00.000Z`, status);
sess('w2', '2026-10-11', 'cancelled');
sess('w4', '2026-10-25', 'open');
sess('w5', '2026-11-01');
let n = 0;
const reg = (sid: string, user: string, kind: string, status: string, o: { guest?: string; queued?: number } = {}) =>
  q(`INSERT INTO registrations (id, session_id, user_id, guest_name, kind, status, queued_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    `r${++n}`, sid, user, o.guest ?? null, kind, status, new Date(Date.parse(t) + (o.queued ?? 0) * 1000).toISOString(), t);
// 季打佔位（同一時間寫入），丁四、Dave 請假；教練（不在 LINE 上）也是季打
for (const [id] of users.slice(0, 13)) reg('w4', id, 'season', id === 'U7' || id === 'U8' ? 'leave' : 'confirmed');
reg('w4', 'U20', 'casual', 'confirmed', { queued: 100 });
reg('w4', 'U20', 'casual', 'confirmed', { guest: '小美', queued: 101 });
reg('w4', 'U21', 'casual', 'cancelled', { queued: 102 });
reg('w4', 'U22', 'casual', 'waitlist', { queued: 103 });

const text = await R.rosterText(env, club(), 'w4');
console.log(text);
assert.equal(text, [
  '115年第四季（4）',
  '',
  '日期：10月25日（日）',
  '時間：晚上6:00至8:00',
  '地點：某某國小 第 2 & 4 號球場',
  '人數：16人',
  '',
  '📌 注意',
  '',
  '👉若臨時無法出席，請務必提前至少四小時請假，拜託拜託喔~',
  '',
  '1. 甲一', '2. 乙二', '3. Amy', '4. Ben', '5. Carl', '6. 丙三',
  '7. Eric', '8. 阿戊', '9. Fred', '10. 小己', '11. 教練', '12. 庚七0打', '13. 小美（庚七友）0打',
  '',
  '候補：',
  '1. 小明0打',
  '',
  '請假：丁四、Dave',
  '—',
].join('\n'));

// 下一場是第 5 場；還沒有人報名
let out = await R.rosterText(env, club(), 'w5');
assert.match(out, /^115年第四季（5）\n/);
assert.match(out, /\n（還沒有人）\n—$/);
assert.ok(!out.includes('候補：') && !out.includes('請假：'));
// 只有請假、沒有候補：請假那行照樣在最下面
q(`INSERT INTO registrations (id, session_id, user_id, kind, status, queued_at, updated_at) VALUES ('rl','w5','U1','season','leave',?,?)`, t, t);
assert.match(await R.rosterText(env, club(), 'w5'), /\n（還沒有人）\n\n請假：甲一\n—$/);

// 沒有季期（臨時加場）用球團名稱；沒填規則就沒有「注意」那段；沒有場地就不寫地點
q(`UPDATE clubs SET rules = NULL`);
sess('extra', '2026-11-05', 'open', null, { start: '09:30', end: '11:00', venue: null, court: null, capacity: 12 });
out = await R.rosterText(env, club(), 'extra');
assert.deepEqual(out.split('\n').slice(0, 6), ['快樂羽球團', '', '日期：11月5日（四）', '時間：下午5:30至晚上7:00', '人數：12人', '']);
assert.ok(!out.includes('注意') && !out.includes('地點'));
// 已取消的場次寫出來
q(`UPDATE sessions SET cancel_reason='颱風' WHERE id='w2'`);
assert.match(await R.rosterText(env, club(), 'w2'), /人數：16人\n（這場已取消：颱風）\n/);
// 別的球團的場次拿不到
q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES ('c2','G2','別團',?)`, t);
await assert.rejects(R.rosterText(env, q(`SELECT * FROM clubs WHERE id='c2'`)[0], 'w4'), (e: unknown) => e instanceof UserError);

// 第幾週：用日期算，含開始日；開始日前是 0
assert.deepEqual([['2026-10-01', '2026-10-04'], ['2026-10-01', '2026-10-25'], ['2026-10-01', '2026-11-01'], ['2026-10-01', '2026-10-01'], ['2026-10-01', '2026-10-07'], ['2026-10-01', '2026-10-08'], ['2026-10-01', '2026-09-30'], ['2026-12-28', '2027-01-03']]
  .map(([a, b]) => R.weekOfSeason(a, b)), [1, 4, 5, 1, 1, 2, 0, 1]);

// 時段的說法
const tz = 'Asia/Taipei';
const at = (h: number, m = 0) => Date.parse(`2026-10-25T${String(h - 8 + (h < 8 ? 24 : 0)).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - (h < 8 ? 86_400_000 : 0);
assert.equal(R.timeRangeText(at(18), at(20), tz), '晚上6:00至8:00');
assert.equal(R.timeRangeText(at(17), at(19), tz), '下午5:00至晚上7:00');
assert.equal(R.timeRangeText(at(9, 30), at(12), tz), '上午9:30至中午12:00');
assert.equal(R.timeRangeText(at(12, 15), at(14), tz), '中午12:15至下午2:00');
assert.equal(R.timeRangeText(at(21), at(23, 45), tz), '晚上9:00至11:45');
assert.equal(R.timeRangeText(at(22), at(1), tz), '晚上10:00至凌晨1:00');
assert.equal(R.dateText(Date.parse('2026-10-25T16:30:00Z'), tz), '10月26日（一）', '依球團時區換日');

console.log('ALL ROSTER TEXT TESTS PASSED');
