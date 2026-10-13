import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const F = await import(SRC + '/src/feedback.ts');
const { runCron } = await import(SRC + '/src/cron.ts');
const m = await import(SRC + '/src/manage.ts');
const { UserError } = await import(SRC + '/src/types.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
const off: any = { DB, LIFF_ID: 'liff-1', LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const noKey: any = { ...off, FEEDBACK_TO: 'owner@example.com' };
const env: any = { ...noKey, RESEND_API_KEY: 're_test' };

// 假的 Resend：記下每一次嘗試，可以切成失敗
const mail = { status: 200, tried: [] as any[], down: false };
globalThis.fetch = (async (url: any, init: any = {}) => {
  if (String(url) !== 'https://api.resend.com/emails') throw new Error('unexpected request: ' + url);
  if (mail.down) throw new TypeError('fetch failed');
  mail.tried.push({ headers: init.headers, ...JSON.parse(init.body) });
  return mail.status === 200 ? new Response(JSON.stringify({ id: 'e1' })) : new Response(JSON.stringify({ message: 'nope' }), { status: mail.status });
}) as any;

const NOW = Date.parse('2026-10-13T13:05:00.000Z'); // 台北 10/13（二）21:05
const at = (min: number) => NOW + min * 60_000;
for (const [id, n] of [['U1', '甲'], ['U2', '乙'], ['U3', '丙']]) q('INSERT INTO users VALUES (?,?,NULL,?)', id, n, new Date(NOW).toISOString());
q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES ('c1','G1','快樂羽球團',?)`, new Date(NOW).toISOString());
q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c1','U1','owner',?),('c1','U2','member',?),('c1','U3','member',?)`, ...Array(3).fill(new Date(NOW).toISOString()));
q(`UPDATE club_members SET nickname='小乙' WHERE user_id='U2'`);
const club = () => q(`SELECT * FROM clubs WHERE id='c1'`)[0];
const rows = () => q(`SELECT * FROM feedback ORDER BY created_at, rowid`);
const submit = (uid: string, role: string, msg: unknown, now = NOW, e = env) => F.submitFeedback(e, club(), uid, role, msg, now);
const userError = (re: RegExp) => (e: unknown) => e instanceof UserError && re.test((e as Error).message);

// 沒填收件信箱 = 沒有開放
assert.deepEqual([F.feedbackEnabled(off), F.feedbackEnabled(noKey), F.feedbackEnabled(env)], [false, true, true]);
await assert.rejects(submit('U2', 'member', '哈囉', NOW, off), userError(/意見回饋沒有開放/));

// 內容檢查
for (const bad of ['', '   \n ', undefined, 123, null]) await assert.rejects(submit('U2', 'member', bad), userError(/請填寫內容/));
await assert.rejects(submit('U2', 'member', '字'.repeat(1001)), userError(/內容最多 1000 個字/));
assert.equal(rows().length, 0);

// 送出：只存起來，不在這時候寄；名字用球團裡的暱稱，沒有暱稱用 LINE 名稱
await submit('U2', 'member', '  希望可以看到上一場的名單\n謝謝 <b>!</b>  ');
assert.equal(mail.tried.length, 0);
const [first] = rows();
assert.deepEqual(
  [first.club_id, first.club_name, first.user_id, first.user_name, first.role, first.message, first.attempts, first.emailed_at, first.last_error],
  ['c1', '快樂羽球團', 'U2', '小乙', 'member', '希望可以看到上一場的名單\n謝謝 <b>!</b>', 0, null, null],
);

// 排程寄出：寄到設定的信箱，純文字，同一則固定的 Idempotency-Key；寄過不會再寄
await runCron(env, at(3));
assert.equal(mail.tried.length, 1);
const sent = mail.tried[0];
console.log(`主旨：${sent.subject}\n${sent.text}`);
assert.deepEqual(sent.to, ['owner@example.com']);
assert.equal(sent.from, '羽球報名系統 <onboarding@resend.dev>');
assert.equal(sent.subject, '【意見回饋】快樂羽球團｜小乙');
assert.equal(sent.text, '球團：快樂羽球團\n來自：小乙（成員）\n時間：10/13（二）21:05\n\n希望可以看到上一場的名單\n謝謝 <b>!</b>');
assert.equal(sent.html, undefined, '不寄 HTML，留言內容不會被當成標籤');
assert.deepEqual([sent.headers.Authorization, sent.headers['Idempotency-Key']], ['Bearer re_test', `feedback-${first.id}`]);
assert.deepEqual([rows()[0].attempts, rows()[0].emailed_at, rows()[0].last_error], [1, new Date(at(3)).toISOString(), null]);
await runCron(env, at(8));
assert.equal(mail.tried.length, 1);

// 金鑰還沒設定：照收、先存著，排程不動它；設定好之後的下一輪補寄
await submit('U1', 'owner', '測試', at(10), noKey);
await runCron(noKey, at(13));
assert.deepEqual([mail.tried.length, rows()[1].attempts, rows()[1].emailed_at], [1, 0, null]);
await runCron(env, at(18));
assert.equal(mail.tried.length, 2);
assert.match(mail.tried[1].text, /^球團：快樂羽球團\n來自：甲（擁有者）\n時間：10\/13（二）21:15\n\n測試$/);
assert.ok(rows()[1].emailed_at);
// 自訂寄件人（之後有自己的網域時）
await submit('U1', 'owner', '換寄件人', at(19));
await runCron({ ...env, FEEDBACK_FROM: '回饋 <feedback@example.com>' }, at(20));
assert.equal(mail.tried.at(-1).from, '回饋 <feedback@example.com>');

// 寄信服務回錯誤：記下原因，之後每輪重試，最多 5 次；重試用同一個 Idempotency-Key
mail.status = 429;
await submit('U3', 'member', '會寄失敗的', at(21));
const failing = rows().at(-1).id;
const before = mail.tried.length;
for (let i = 1; i <= 7; i++) await runCron(env, at(21 + i * 5));
const tries = mail.tried.slice(before);
assert.equal(tries.length, 5, '試 5 次就不再試');
assert.ok(tries.every((t) => t.headers['Idempotency-Key'] === `feedback-${failing}`));
let r = q(`SELECT * FROM feedback WHERE id=?`, failing)[0];
assert.deepEqual([r.attempts, r.emailed_at], [5, null]);
assert.match(r.last_error, /Resend 429.*nope/);
mail.status = 200;
await runCron(env, at(70));
assert.equal(mail.tried.length, before + 5, '放棄的不會再寄，留在資料庫裡');

// 連不上寄信服務：排程不會因此中斷，下一輪再試
await submit('U3', 'member', '斷線時寫的', at(71));
mail.down = true;
await runCron(env, at(72));
r = rows().at(-1);
assert.deepEqual([r.attempts, r.emailed_at], [1, null]);
assert.match(r.last_error, /fetch failed/);
mail.down = false;
await runCron(env, at(77));
r = rows().at(-1);
assert.deepEqual([r.attempts, !!r.emailed_at, r.last_error], [2, true, null]);

// 一個人 24 小時內最多 5 則；別人不受影響；過了 24 小時又可以送
const DAY2 = at(3 * 1440);
for (let i = 0; i < 5; i++) await submit('U2', 'member', `第 ${i + 1} 則`, DAY2 + i * 1000);
await assert.rejects(submit('U2', 'member', '第 6 則', DAY2 + 6000), userError(/今天已經送出好幾則了，請明天再寫/));
await submit('U3', 'member', '別人照常', DAY2 + 6000);
await submit('U2', 'member', '隔天', DAY2 + 86_400_000 + 5000);

// 一輪最多寄 5 封，先寫的先寄，剩下的下一輪
const n0 = mail.tried.length;
await runCron(env, DAY2 + 86_400_000 + 60_000);
assert.deepEqual(mail.tried.slice(n0).map((t) => t.text.split('\n').at(-1)), ['第 1 則', '第 2 則', '第 3 則', '第 4 則', '第 5 則']);
await runCron(env, DAY2 + 86_400_000 + 360_000);
assert.deepEqual(mail.tried.slice(n0 + 5).map((t) => t.text.split('\n').at(-1)), ['別人照常', '隔天']);
assert.equal(q(`SELECT COUNT(*) n FROM feedback WHERE emailed_at IS NULL AND attempts < 5`)[0].n, 0);

// 只寄給開發者：後端沒有讀取意見回饋的函式（管理員也看不到別人寫的）
assert.deepEqual(Object.keys(F).sort(), ['deliverFeedback', 'feedbackEnabled', 'submitFeedback']);

// 球團改名、刪除之後：之前的留言還在，還沒寄的照樣寄得出去（名字是當時存的）
const LATER = DAY2 + 5 * 86_400_000;
await submit('U2', 'member', '刪除前寫的', LATER);
await m.updateSettings(env, club(), { name: '新名字' });
await m.deleteClub(env, club(), 'owner', '新名字');
assert.equal(q(`SELECT COUNT(*) n FROM clubs WHERE id='c1'`)[0].n, 0);
const total = rows().length;
await runCron(env, LATER + 60_000);
assert.equal(rows().length, total, '刪除球團不會刪掉意見回饋');
assert.match(mail.tried.at(-1).text, /^球團：快樂羽球團\n來自：小乙（成員）\n時間：\d+\/\d+（.）\d\d:\d\d\n\n刪除前寫的$/);
assert.ok(rows().at(-1).emailed_at);

console.log('ALL FEEDBACK TESTS PASSED');
