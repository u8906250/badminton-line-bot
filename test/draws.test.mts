// 抽籤紀錄：建立、勾選已抽籤／抽中、外面名單、刪除，以及刪除球團時一併清掉。
import assert from 'node:assert/strict';
import { createTestDb } from './d1.mts';
const SRC = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const D = await import(SRC + '/src/draws.ts');
const m = await import(SRC + '/src/manage.ts');
const { UserError } = await import(SRC + '/src/types.ts');

const { DB, q } = createTestDb(SRC + '/schema.sql');
const env: any = { DB, LIFF_ID: 'x', LINE_CHANNEL_ACCESS_TOKEN: 'x' };
const NOW = Date.parse('2026-10-16T04:00:00.000Z');
const t = new Date(NOW).toISOString();
for (const [id, n] of [['U1', '甲'], ['U2', '乙'], ['U3', '丙'], ['U9', '別團的人'], ['ext_coach', '教練']]) q('INSERT INTO users VALUES (?,?,NULL,?)', id, n, t);
for (const c of ['c1', 'c2']) q(`INSERT INTO clubs (id, line_group_id, name, created_at) VALUES (?,?,?,?)`, c, `G-${c}`, `球團${c}`, t);
for (const [u, role] of [['U1', 'owner'], ['U2', 'member'], ['U3', 'member'], ['ext_coach', 'member']]) q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c1',?,?,?)`, u, role, t);
q(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES ('c2','U9','owner',?)`, t);
q(`UPDATE club_members SET nickname='小乙' WHERE club_id='c1' AND user_id='U2'`);
const club = (id = 'c1') => q(`SELECT * FROM clubs WHERE id=?`, id)[0];
const userError = (re: RegExp) => (e: unknown) => e instanceof UserError && re.test((e as Error).message);
const plain = (x: any) => JSON.parse(JSON.stringify(x));
const view = async (id: string) => plain(await D.drawView(env, club(), id));
const states = async (id: string) => (await view(id)).rows.map((r: any) => `${r.name}:${r.kind}:${r.drawn ? '抽' : '-'}${r.won ? '中' : '-'}`);

// ---- 建立 ----
await assert.rejects(D.createDraw(env, club(), { name: '  ' }, 'U1', NOW), userError(/請填寫名稱/));
await assert.rejects(D.createDraw(env, club(), { name: '字'.repeat(31) }, 'U1', NOW), userError(/名稱最多 30 個字/));
const a = await D.createDraw(env, club(), { name: ' 11 月場地抽籤 ', note: '某某國小 週三' }, 'U1', NOW);
assert.deepEqual({ ...a, id: '' }, { id: '', name: '11 月場地抽籤', note: '某某國小 週三', createdAt: t, drawn: 0, won: 0 });
const b = await D.createDraw(env, club(), { name: '12 月場地抽籤' }, 'U1', NOW + 1000);
const other = await D.createDraw(env, club('c2'), { name: '別團的抽籤' }, 'U9', NOW);

// 一開始：所有成員都列出來（含不在 LINE 上的教練），依名字排序，都還沒勾
assert.deepEqual(await states(a.id), ['丙:member:--', '小乙:member:--', '教練:member:--', '甲:member:--']);
assert.equal(q(`SELECT COUNT(*) n FROM draw_entries`)[0].n, 0, '沒勾過的成員不會先寫一筆');

// ---- 勾選 ----
assert.deepEqual(await D.markDraw(env, club(), a.id, { userId: 'U1', field: 'drawn', value: true }, NOW), { drawn: true, won: false });
// 勾抽中 → 一併算已抽籤
assert.deepEqual(await D.markDraw(env, club(), a.id, { userId: 'U2', field: 'won', value: true }, NOW), { drawn: true, won: true });
assert.deepEqual(await D.markDraw(env, club(), a.id, { userId: 'ext_coach', field: 'won', value: true }, NOW), { drawn: true, won: true });
assert.deepEqual(await states(a.id), ['丙:member:--', '小乙:member:抽中', '教練:member:抽中', '甲:member:抽-']);
// 取消抽中：還是算已抽籤；取消已抽籤：抽中一併取消
assert.deepEqual(await D.markDraw(env, club(), a.id, { userId: 'U2', field: 'won', value: false }, NOW), { drawn: true, won: false });
assert.deepEqual(await D.markDraw(env, club(), a.id, { userId: 'ext_coach', field: 'drawn', value: false }, NOW), { drawn: false, won: false });
// 重複勾同一個人不會多一筆
await D.markDraw(env, club(), a.id, { userId: 'U1', field: 'drawn', value: true }, NOW);
assert.equal(q(`SELECT COUNT(*) n FROM draw_entries WHERE draw_id=? AND user_id='U1'`, a.id)[0].n, 1);
// 兩次抽籤各自獨立
assert.deepEqual(await states(b.id), ['丙:member:--', '小乙:member:--', '教練:member:--', '甲:member:--']);
// 不能勾別團的人、不能動別團的抽籤、欄位要對
await assert.rejects(D.markDraw(env, club(), a.id, { userId: 'U9', field: 'drawn', value: true }, NOW), userError(/只能勾選球團成員/));
await assert.rejects(D.markDraw(env, club(), other.id, { userId: 'U1', field: 'drawn', value: true }, NOW), userError(/找不到這次抽籤/));
await assert.rejects(D.markDraw(env, club(), a.id, { userId: 'U1', field: 'paid', value: true }, NOW), userError(/要勾選的項目不對/));
await assert.rejects(D.markDraw(env, club(), a.id, { field: 'drawn', value: true }, NOW), userError(/請指定要勾選的人/));
await assert.rejects(D.markDraw(env, club(), a.id, { entryId: 'nope', field: 'drawn', value: true }, NOW), userError(/找不到這個人的紀錄/));

// ---- 外面名單 ----
assert.deepEqual(D.parseNames(' 王小明\n陳小華，林大同、王小明 ;  '), ['王小明', '陳小華', '林大同']);
assert.throws(() => D.parseNames('字'.repeat(21)), userError(/名字最多 20 個字/));
await assert.rejects(D.addOutsideEntries(env, club(), a.id, { names: ' \n ' }, NOW), userError(/請輸入名字/));
let r = await D.addOutsideEntries(env, club(), a.id, { names: '王小明\n陳小華' }, NOW);
assert.deepEqual(plain(r), { added: ['王小明', '陳小華'], skipped: [] });
// 同名的略過；加入時直接勾已抽籤
r = await D.addOutsideEntries(env, club(), a.id, { names: '陳小華、林大同', drawn: true }, NOW + 5);
assert.deepEqual(plain(r), { added: ['林大同'], skipped: ['陳小華'] });
let v = await view(a.id);
assert.deepEqual(await states(a.id), ['丙:member:--', '小乙:member:抽-', '教練:member:--', '甲:member:抽-', '王小明:outside:--', '陳小華:outside:--', '林大同:outside:抽-']);
// 外面名單用那一筆的 id 勾選
const xm = v.rows.find((x: any) => x.name === '王小明');
assert.equal(xm.userId, null);
assert.deepEqual(await D.markDraw(env, club(), a.id, { entryId: xm.entryId, field: 'won', value: true }, NOW), { drawn: true, won: true });
// 統計：已抽籤 4（甲、小乙、王小明、林大同）、抽中 1
v = await view(a.id);
assert.deepEqual([v.draw.drawn, v.draw.won], [4, 1]);
assert.deepEqual(plain(await D.listDraws(env, club())).map((d: any) => [d.name, d.drawn, d.won]), [['12 月場地抽籤', 0, 0], ['11 月場地抽籤', 4, 1]], '新的在前');
// 移除外面名單；成員的紀錄不能用這個刪
assert.equal(await D.removeOutsideEntry(env, club(), a.id, xm.entryId), '王小明');
const memberEntry = q(`SELECT id FROM draw_entries WHERE draw_id=? AND user_id='U1'`, a.id)[0].id;
await assert.rejects(D.removeOutsideEntry(env, club(), a.id, memberEntry), userError(/找不到這個人/));
assert.deepEqual((await view(a.id)).draw.won, 0);

// ---- 成員離開球團：紀錄留著，標成已不在球團，還是可以改 ----
q(`DELETE FROM club_members WHERE club_id='c1' AND user_id='U2'`);
v = await view(a.id);
assert.deepEqual(await states(a.id), ['丙:member:--', '教練:member:--', '甲:member:抽-', '乙:left:抽-', '陳小華:outside:--', '林大同:outside:抽-']);
const left = v.rows.find((x: any) => x.kind === 'left');
assert.equal(left.name, '乙', '不在球團後用 LINE 名稱');
assert.deepEqual(await D.markDraw(env, club(), a.id, { entryId: left.entryId, field: 'won', value: true }, NOW), { drawn: true, won: true });
q(`INSERT INTO club_members (club_id, user_id, role, nickname, joined_at) VALUES ('c1','U2','member','小乙',?)`, t);
assert.deepEqual(await states(a.id), ['丙:member:--', '小乙:member:抽中', '教練:member:--', '甲:member:抽-', '陳小華:outside:--', '林大同:outside:抽-'], '回來之後接回原本的紀錄');

// ---- 修改、刪除 ----
await D.updateDraw(env, club(), a.id, { name: '11 月抽籤', note: '' });
v = await view(a.id);
assert.deepEqual([v.draw.name, v.draw.note], ['11 月抽籤', null]);
await D.updateDraw(env, club(), a.id, { note: '改備註' });
assert.deepEqual([(await view(a.id)).draw.name, (await view(a.id)).draw.note], ['11 月抽籤', '改備註'], '沒帶的欄位不動');
await assert.rejects(D.updateDraw(env, club(), other.id, { name: 'x' }), userError(/找不到這次抽籤/));
await assert.rejects(D.deleteDraw(env, club(), other.id), userError(/找不到這次抽籤/));
assert.deepEqual(plain(await D.deleteDraw(env, club(), a.id)), { name: '11 月抽籤', entries: 5 });
await assert.rejects(D.drawView(env, club(), a.id), userError(/找不到這次抽籤/));
assert.equal(q(`SELECT COUNT(*) n FROM draw_entries WHERE draw_id=?`, a.id)[0].n, 0);

// ---- 刪除球團：抽籤紀錄一併刪掉，別的球團不受影響 ----
await D.markDraw(env, club(), b.id, { userId: 'U3', field: 'drawn', value: true }, NOW);
await D.addOutsideEntries(env, club(), b.id, { names: '外人' }, NOW);
await D.markDraw(env, club('c2'), other.id, { userId: 'U9', field: 'drawn', value: true }, NOW);
const removed = await m.deleteClub(env, club(), 'owner', '球團c1');
assert.equal(removed.draws, 1);
assert.deepEqual([q(`SELECT COUNT(*) n FROM draws WHERE club_id='c1'`)[0].n, q(`SELECT COUNT(*) n FROM draw_entries WHERE draw_id=?`, b.id)[0].n], [0, 0]);
assert.equal(q(`SELECT COUNT(*) n FROM draw_entries WHERE draw_id=?`, other.id)[0].n, 1);
assert.equal(q(`SELECT COUNT(*) n FROM users WHERE line_user_id='ext_coach'`)[0].n, 0, '非 LINE 成員照樣清掉');

console.log('ALL DRAW TESTS PASSED');
