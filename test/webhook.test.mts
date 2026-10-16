// 群組的 webhook 事件：哪些情況會把人記成球團成員。
import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { handleEvent } = await import(SRC + '/src/commands.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
const env: any = { DB, LIFF_ID: 'liff-1', LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const t = new Date().toISOString();
q(`INSERT INTO users VALUES ('U0','團長',NULL,?)`, t);
q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES ('c1','G1','快樂羽球團',?)`, t);
q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c1','U0','owner',?)`, t);

const replies: any[] = [];
globalThis.fetch = (async (url: any, init: any = {}) => {
  const u = String(url);
  const m = u.match(/\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/);
  if (m) return new Response(JSON.stringify({ displayName: `名字${m[2]}` }));
  if (u.endsWith('/v2/bot/message/reply')) { replies.push(JSON.parse(init.body)); return new Response('{}'); }
  throw new Error('unexpected request: ' + u);
}) as any;

const members = (club = 'c1') => q(`SELECT m.user_id, u.display_name, m.role FROM club_members m JOIN users u ON u.line_user_id = m.user_id WHERE m.club_id=? ORDER BY m.user_id`, club).map((r: any) => `${r.user_id}:${r.display_name}:${r.role}`);
const msg = (userId: string, message: any, groupId = 'G1') => handleEvent(env, { type: 'message', replyToken: 'r', source: { type: 'group', groupId, userId }, message });

// 文字聊天（原本就會記）
await msg('U1', { type: 'text', text: '今天好熱' });
// 只傳圖片、貼圖、影片、檔案也會記
await msg('U2', { type: 'image' });
await msg('U3', { type: 'sticker' });
await msg('U4', { type: 'video' });
await msg('U5', { type: 'file' });
assert.deepEqual(members(), ['U0:團長:owner', 'U1:名字U1:member', 'U2:名字U2:member', 'U3:名字U3:member', 'U4:名字U4:member', 'U5:名字U5:member']);
assert.equal(replies.length, 0, '一般聊天和圖片都不回應');
// 同一個人再傳一次不會重複，也不會改掉角色
await msg('U0', { type: 'image' });
await msg('U2', { type: 'sticker' });
assert.equal(members().length, 6);
assert.equal(members()[0], 'U0:團長:owner');

// 有人加入群組：不用講話就記成成員（一次加入好幾個人也行）
await handleEvent(env, { type: 'memberJoined', source: { type: 'group', groupId: 'G1' }, joined: { members: [{ type: 'user', userId: 'U6' }, { type: 'user', userId: 'U7' }] } } as any);
assert.deepEqual(members().slice(-2), ['U6:名字U6:member', 'U7:名字U7:member']);

// 還沒綁定的群組：什麼都不記
await msg('U8', { type: 'image' }, 'G-unbound');
await handleEvent(env, { type: 'memberJoined', source: { type: 'group', groupId: 'G-unbound' }, joined: { members: [{ type: 'user', userId: 'U9' }] } } as any);
assert.equal(q(`SELECT COUNT(*) n FROM users WHERE line_user_id IN ('U8','U9')`)[0].n, 0);
assert.equal(q(`SELECT COUNT(*) n FROM club_members`)[0].n, 8);

// 指令照常回覆
await msg('U2', { type: 'text', text: '選單' });
assert.equal(replies.length, 1);
assert.match(replies[0].messages[0].text, /快樂羽球團/);

console.log('ALL WEBHOOK TESTS PASSED');

// ---- 打開報名頁就自動加入：LINE 確認在群組裡才加 ----
{
  const worker = (await import(SRC + '/src/index.ts')).default;
  const env2: any = { ...env, LIFF_ORIGIN: 'https://p.example', LOGIN_CHANNEL_ID: 'x' };
  const inGroup = new Set(['U20']);
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = String(url);
    if (u.includes('/oauth2/v2.1/verify')) return new Response(JSON.stringify({ sub: new URLSearchParams(init.body).get('id_token')!.replace('tok-', '') }));
    const m = u.match(/\/v2\/bot\/group\/([^/]+)\/member\/([^/]+)$/);
    if (m) return m[1] === 'G1' && inGroup.has(m[2]) ? new Response(JSON.stringify({ displayName: `群組裡的${m[2]}` })) : new Response('{"message":"Not found"}', { status: 404 });
    throw new Error('unexpected request: ' + u);
  }) as any;
  const open = async (user: string, path = '/me') => {
    const res = await worker.fetch(new Request(`https://p.example/api/clubs/c1${path}`, { headers: { Authorization: `Bearer tok-${user}` } }), env2, { waitUntil() {}, passThroughOnException() {} } as any);
    return { status: res.status, body: await res.json() };
  };
  // 在群組裡、從沒講過話的人：打開就加入成員，用 LINE 群組裡的名字
  let r = await open('U20');
  assert.deepEqual([r.status, r.body.role, r.body.isAdmin], [200, 'member', false]);
  assert.ok(members().includes('U20:群組裡的U20:member'));
  r = await open('U20', '/sessions');
  assert.equal(r.status, 200);
  // 不在群組裡的人：進不來，也不會被記下
  r = await open('U21');
  assert.deepEqual([r.status, r.body.error], [403, '你不在這個球團的 LINE 群組裡，請先加入群組再打開報名頁']);
  assert.ok(!members().some((x: string) => x.startsWith('U21:')));
  // 已經是成員的人不用再問 LINE（擁有者照常）
  inGroup.clear();
  r = await open('U0');
  assert.deepEqual([r.status, r.body.role], [200, 'owner']);
  r = await open('U20');
  assert.equal(r.status, 200, '加入後就是成員，不再查 LINE');
  console.log('ALL AUTO-JOIN TESTS PASSED');
}
