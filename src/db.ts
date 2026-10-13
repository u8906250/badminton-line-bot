import type { Club, Role, Session } from './types';
import { nowIso } from './time';

export function getClubByGroup(db: D1Database, groupId: string): Promise<Club | null> {
  return db.prepare('SELECT * FROM clubs WHERE line_group_id = ?').bind(groupId).first<Club>();
}

export function getClub(db: D1Database, id: string): Promise<Club | null> {
  return db.prepare('SELECT * FROM clubs WHERE id = ?').bind(id).first<Club>();
}

export async function getRole(db: D1Database, clubId: string, userId: string): Promise<Role | null> {
  const r = await db
    .prepare('SELECT role FROM club_members WHERE club_id = ? AND user_id = ?')
    .bind(clubId, userId)
    .first<{ role: Role }>();
  return r?.role ?? null;
}

export function getUser(db: D1Database, id: string) {
  return db
    .prepare('SELECT line_user_id, display_name, updated_at FROM users WHERE line_user_id = ?')
    .bind(id)
    .first<{ line_user_id: string; display_name: string; updated_at: string }>();
}

export async function upsertUser(
  db: D1Database,
  u: { id: string; displayName: string; pictureUrl?: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (line_user_id, display_name, picture_url, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(line_user_id) DO UPDATE SET
         display_name = excluded.display_name,
         picture_url = excluded.picture_url,
         updated_at = excluded.updated_at`,
    )
    .bind(u.id, u.displayName, u.pictureUrl ?? null, nowIso())
    .run();
}

export async function ensureMember(db: D1Database, clubId: string, userId: string): Promise<void> {
  await db
    .prepare(`INSERT OR IGNORE INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`)
    .bind(clubId, userId, nowIso())
    .run();
}

/** 尚未開打、未取消的場次，依時間排序。 */
export async function upcomingSessions(db: D1Database, clubId: string, limit = 20): Promise<Session[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM sessions WHERE club_id = ? AND start_at > ? AND status NOT IN ('cancelled', 'done')
       ORDER BY start_at LIMIT ?`,
    )
    .bind(clubId, nowIso(), limit)
    .all<Session>();
  return results;
}

export function getSession(db: D1Database, clubId: string, sessionId: string): Promise<Session | null> {
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND club_id = ?').bind(sessionId, clubId).first<Session>();
}

export async function audit(
  db: D1Database,
  clubId: string,
  actorId: string,
  action: string,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare('INSERT INTO audit_logs (club_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(clubId, actorId, action, detail === undefined ? null : JSON.stringify(detail), nowIso())
    .run();
}
