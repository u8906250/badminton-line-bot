// 抽籤紀錄（例如場地抽籤）：管理員建立一次抽籤，勾選球團成員誰已經抽籤、誰抽中，也可以手動加入不在球團裡的人。
// 只處理資料與規則，不碰 HTTP，方便測試；路由在 admin.ts。

import type { Club, Env } from './types';
import { UserError } from './types';
import { str } from './manage';
import { iso } from './time';

export interface DrawSummary {
  id: string;
  name: string;
  note: string | null;
  createdAt: string;
  /** 已抽籤的人數（成員＋外面名單）；抽中的一定算在內 */
  drawn: number;
  won: number;
}

export interface DrawRow {
  /** 成員是 userId；外面名單是那一筆的 id */
  key: string;
  userId: string | null;
  entryId: string | null;
  name: string;
  /** member = 現在的球團成員；left = 有紀錄但已經不在球團；outside = 手動加入的外面名單 */
  kind: 'member' | 'left' | 'outside';
  drawn: boolean;
  won: boolean;
}

export interface DrawView {
  draw: DrawSummary;
  rows: DrawRow[];
}

const memberEntryId = (drawId: string, userId: string) => `${drawId}_m_${userId}`;

async function getDraw(env: Env, club: Club, drawId: string): Promise<{ id: string; name: string; note: string | null; created_at: string }> {
  const d = await env.DB.prepare('SELECT id, name, note, created_at FROM draws WHERE id = ? AND club_id = ?')
    .bind(drawId, club.id)
    .first<{ id: string; name: string; note: string | null; created_at: string }>();
  if (!d) throw new UserError('找不到這次抽籤');
  return d;
}

export async function createDraw(env: Env, club: Club, input: Record<string, unknown>, actorId: string, now = Date.now()): Promise<DrawSummary> {
  const name = str(input.name, 30, '名稱')!;
  const note = str(input.note, 200, '備註', false);
  const id = `d_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare('INSERT INTO draws (id, club_id, name, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, club.id, name, note, actorId, iso(now))
    .run();
  return { id, name, note, createdAt: iso(now), drawn: 0, won: 0 };
}

export async function updateDraw(env: Env, club: Club, drawId: string, input: Record<string, unknown>): Promise<void> {
  const d = await getDraw(env, club, drawId);
  const name = 'name' in input ? str(input.name, 30, '名稱')! : d.name;
  const note = 'note' in input ? str(input.note, 200, '備註', false) : d.note;
  await env.DB.prepare('UPDATE draws SET name = ?, note = ? WHERE id = ?').bind(name, note, d.id).run();
}

/** 刪除整次抽籤和裡面的紀錄。回傳名稱與筆數，寫進稽核紀錄用。 */
export async function deleteDraw(env: Env, club: Club, drawId: string): Promise<{ name: string; entries: number }> {
  const d = await getDraw(env, club, drawId);
  const [cnt] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?').bind(d.id),
    env.DB.prepare('DELETE FROM draw_entries WHERE draw_id = ?').bind(d.id),
    env.DB.prepare('DELETE FROM draws WHERE id = ?').bind(d.id),
  ]);
  return { name: d.name, entries: (cnt.results[0] as { n: number }).n };
}

/** 這個球團的抽籤，新的在前，附上已抽籤與抽中的人數。 */
export async function listDraws(env: Env, club: Club): Promise<DrawSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.name, d.note, d.created_at,
            COALESCE(SUM(e.drawn), 0) AS drawn, COALESCE(SUM(e.won), 0) AS won
     FROM draws d LEFT JOIN draw_entries e ON e.draw_id = d.id
     WHERE d.club_id = ? GROUP BY d.id ORDER BY d.created_at DESC, d.rowid DESC`,
  )
    .bind(club.id)
    .all<{ id: string; name: string; note: string | null; created_at: string; drawn: number; won: number }>();
  return results.map((r) => ({ id: r.id, name: r.name, note: r.note, createdAt: r.created_at, drawn: r.drawn, won: r.won }));
}

/**
 * 一次抽籤的完整名單：所有球團成員（沒勾過的也列出來），已經不在球團但有紀錄的人，以及外面名單。
 * 成員依名字排序；外面名單依加入的先後。
 */
export async function drawView(env: Env, club: Club, drawId: string): Promise<DrawView> {
  const d = await getDraw(env, club, drawId);
  const [members, entries] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.user_id, COALESCE(m.nickname, u.display_name) AS name FROM club_members m
       JOIN users u ON u.line_user_id = m.user_id WHERE m.club_id = ? ORDER BY name`,
    ).bind(club.id),
    env.DB.prepare(
      `SELECT e.id, e.user_id, COALESCE(e.name, cm.nickname, u.display_name) AS name, e.drawn, e.won, cm.user_id AS still_member
       FROM draw_entries e
       LEFT JOIN users u ON u.line_user_id = e.user_id
       LEFT JOIN club_members cm ON cm.club_id = ?2 AND cm.user_id = e.user_id
       WHERE e.draw_id = ?1 ORDER BY e.created_at, e.rowid`,
    ).bind(d.id, club.id),
  ]);
  type E = { id: string; user_id: string | null; name: string; drawn: number; won: number; still_member: string | null };
  const list = entries.results as E[];
  const byUser = new Map(list.filter((e) => e.user_id).map((e) => [e.user_id!, e]));
  const rows: DrawRow[] = (members.results as { user_id: string; name: string }[]).map((m) => {
    const e = byUser.get(m.user_id);
    return { key: m.user_id, userId: m.user_id, entryId: e?.id ?? null, name: m.name, kind: 'member', drawn: !!e?.drawn, won: !!e?.won };
  });
  for (const e of list) {
    if (e.user_id && e.still_member) continue;
    rows.push({
      key: e.user_id ?? e.id,
      userId: e.user_id,
      entryId: e.id,
      name: e.name ?? '未知',
      kind: e.user_id ? 'left' : 'outside',
      drawn: !!e.drawn,
      won: !!e.won,
    });
  }
  const drawn = rows.filter((r) => r.drawn).length;
  const won = rows.filter((r) => r.won).length;
  return { draw: { id: d.id, name: d.name, note: d.note, createdAt: d.created_at, drawn, won }, rows };
}

/**
 * 勾選或取消「已抽籤」「抽中」。target 是成員的 userId，或外面名單那一筆的 entryId。
 * 勾抽中會一併勾已抽籤；取消已抽籤會一併取消抽中。回傳更新後的狀態。
 */
export async function markDraw(
  env: Env,
  club: Club,
  drawId: string,
  input: Record<string, unknown>,
  now = Date.now(),
): Promise<{ drawn: boolean; won: boolean }> {
  const d = await getDraw(env, club, drawId);
  const field = input.field;
  if (field !== 'drawn' && field !== 'won') throw new UserError('要勾選的項目不對');
  const value = !!input.value;
  const t = iso(now);

  let entryId: string;
  if (typeof input.userId === 'string' && input.userId) {
    const userId = input.userId;
    entryId = memberEntryId(d.id, userId);
    const existing = await env.DB.prepare('SELECT 1 AS ok FROM draw_entries WHERE id = ?').bind(entryId).first();
    if (!existing) {
      const m = await env.DB.prepare('SELECT 1 AS ok FROM club_members WHERE club_id = ? AND user_id = ?').bind(club.id, userId).first();
      if (!m) throw new UserError('只能勾選球團成員；不在球團裡的人請用「加入外面名單」');
      await env.DB.prepare(
        `INSERT OR IGNORE INTO draw_entries (id, draw_id, user_id, name, drawn, won, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)`,
      )
        .bind(entryId, d.id, userId, t, t)
        .run();
    }
  } else if (typeof input.entryId === 'string' && input.entryId) {
    entryId = input.entryId;
  } else {
    throw new UserError('請指定要勾選的人');
  }

  const set =
    field === 'won'
      ? value
        ? 'won = 1, drawn = 1'
        : 'won = 0'
      : value
        ? 'drawn = 1'
        : 'drawn = 0, won = 0';
  const r = await env.DB.prepare(`UPDATE draw_entries SET ${set}, updated_at = ? WHERE id = ? AND draw_id = ? RETURNING drawn, won`)
    .bind(t, entryId, d.id)
    .first<{ drawn: number; won: number }>();
  if (!r) throw new UserError('找不到這個人的紀錄');
  return { drawn: !!r.drawn, won: !!r.won };
}

/** 外面名單一次可以貼好幾個名字：一行一個，或用逗號、頓號隔開。 */
export function parseNames(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  const names = v
    .split(/[\n,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) if (n.length > 20) throw new UserError(`名字最多 20 個字：${n.slice(0, 20)}…`);
  if (names.length > 100) throw new UserError('一次最多加入 100 個名字');
  return [...new Set(names)];
}

/**
 * 手動加入不在球團裡的人（外面名單）。這次抽籤已經有同名的外面名單就略過。
 * drawn = true 時加入的人直接勾已抽籤。回傳加入與略過的名字。
 */
export async function addOutsideEntries(
  env: Env,
  club: Club,
  drawId: string,
  input: Record<string, unknown>,
  now = Date.now(),
): Promise<{ added: string[]; skipped: string[] }> {
  const d = await getDraw(env, club, drawId);
  const names = parseNames(input.names);
  if (!names.length) throw new UserError('請輸入名字');
  const { results } = await env.DB.prepare('SELECT name FROM draw_entries WHERE draw_id = ? AND user_id IS NULL').bind(d.id).all<{ name: string }>();
  const have = new Set(results.map((r) => r.name));
  const added = names.filter((n) => !have.has(n));
  const skipped = names.filter((n) => have.has(n));
  const drawn = input.drawn ? 1 : 0;
  // 同一批的建立時間依序 +1 ms，讓清單保持輸入的順序
  if (added.length) {
    await env.DB.batch(
      added.map((n, i) =>
        env.DB.prepare(
          `INSERT INTO draw_entries (id, draw_id, user_id, name, drawn, won, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, 0, ?, ?)`,
        ).bind(`${d.id}_x_${crypto.randomUUID().slice(0, 8)}`, d.id, n, drawn, iso(now + i), iso(now + i)),
      ),
    );
  }
  return { added, skipped };
}

/** 移除外面名單的一筆（成員的紀錄用取消勾選，不用刪）。回傳名字，寫進稽核紀錄用。 */
export async function removeOutsideEntry(env: Env, club: Club, drawId: string, entryId: string): Promise<string> {
  const d = await getDraw(env, club, drawId);
  const r = await env.DB.prepare('DELETE FROM draw_entries WHERE id = ? AND draw_id = ? AND user_id IS NULL RETURNING name')
    .bind(entryId, d.id)
    .first<{ name: string }>();
  if (!r) throw new UserError('找不到這個人');
  return r.name;
}
