import type { Club, Env, Session } from './types';
import { isExternal, openNoticeEnabled } from './types';
import type { Promoted, Roster } from './service';
import { type LineMessage, type MentionPart, type PushBudget, mentionText, push, pushBudget, text } from './line';
import { audit, getClub, upcomingSessions } from './db';
import { formatLocal, iso } from './time';

export const liffUrl = (env: Env, club: Club): string => `https://liff.line.me/${env.LIFF_ID}?club=${club.id}`;

export const sessionLabel = (club: Club, s: Session): string => formatLocal(Date.parse(s.start_at), club.timezone);

/** 通知的開頭：@報名人（代朋友報的再加上朋友名字）。不在 LINE 上的人沒辦法 @，改用名字。 */
async function addressee(env: Env, club: Club, p: Promoted): Promise<MentionPart[]> {
  if (!isExternal(p.user_id)) return [{ userId: p.user_id }, p.guest_name ? ` 你的朋友 ${p.guest_name} ` : ' '];
  const r = await env.DB.prepare(
    `SELECT COALESCE(m.nickname, u.display_name) AS name FROM users u
     LEFT JOIN club_members m ON m.club_id = ? AND m.user_id = u.line_user_id WHERE u.line_user_id = ?`,
  )
    .bind(club.id, p.user_id)
    .first<{ name: string }>();
  const name = r?.name ?? '非 LINE 成員';
  return [p.guest_name ? `${name} 的朋友 ${p.guest_name} ` : `${name} `];
}

export async function promotedMessage(env: Env, club: Club, s: Session, p: Promoted): Promise<LineMessage> {
  return mentionText([...(await addressee(env, club, p)), `已從候補遞補為正取（${sessionLabel(club, s)}）`]);
}

/** 不是由群組指令觸發的遞補（LIFF、退群），沒有 reply token，只能用 push。失敗不影響報名結果。 */
export async function pushPromoted(env: Env, club: Club, s: Session, p: Promoted): Promise<void> {
  try {
    await push(env, club.line_group_id, [await promotedMessage(env, club, s, p)]);
  } catch (e) {
    console.error('push promotion notice failed', e);
  }
}

/** 管理員操作造成的名單變動（遞補、退回候補），合併成一則推播。 */
export async function pushChanges(
  env: Env,
  club: Club,
  changes: { promoted: { session: Session; p: Promoted }[]; demoted: { session: Session; p: Promoted }[] },
): Promise<void> {
  const parts: MentionPart[] = [];
  const line = async (session: Session, p: Promoted, what: string) => {
    if (parts.length) parts.push('\n');
    parts.push(...(await addressee(env, club, p)), `${what}（${sessionLabel(club, session)}）`);
  };
  try {
    for (const { session, p } of changes.promoted.slice(0, 20)) await line(session, p, '已從候補遞補為正取');
    for (const { session, p } of changes.demoted.slice(0, 20)) await line(session, p, '因名額調整改為候補');
    if (!parts.length) return;
    await push(env, club.line_group_id, [mentionText(parts)]);
  } catch (e) {
    console.error('push changes failed', e);
  }
}

export async function pushText(env: Env, club: Club, message: string): Promise<void> {
  try {
    await push(env, club.line_group_id, [{ type: 'text', text: message }]);
  } catch (e) {
    console.error('push text failed', e);
  }
}

export function rosterFlex(env: Env, club: Club, s: Session, r: Roster): LineMessage {
  const title = `${club.name}｜${sessionLabel(club, s)}`;
  const names = (list: Roster['confirmed'], markCasual: boolean) =>
    list.length
      ? list.map((e, i) => `${i + 1}. ${e.name}${markCasual && e.kind === 'casual' ? '（臨）' : ''}${e.level ? ` ${e.level}級` : ''}`).join('\n')
      : '（無）';
  const section = (label: string, count: number, body: string) => ({
    type: 'box',
    layout: 'vertical',
    spacing: 'xs',
    contents: [
      { type: 'text', text: `${label}（${count}）`, weight: 'bold', size: 'sm', color: '#555555' },
      { type: 'text', text: body, size: 'sm', wrap: true },
    ],
  });

  const contents: unknown[] = [
    { type: 'text', text: title, weight: 'bold', wrap: true },
    {
      type: 'text',
      text: [[s.venue, s.court_no].filter(Boolean).join(' '), `正取 ${r.confirmed.length}/${s.capacity}`].filter(Boolean).join('・'),
      size: 'xs',
      color: '#888888',
      wrap: true,
    },
    { type: 'separator', margin: 'md' },
    section('正取', r.confirmed.length, names(r.confirmed, true)),
    section('候補', r.waitlist.length, names(r.waitlist, false)),
  ];
  if (r.leave.length) contents.push(section('請假', r.leave.length, names(r.leave, false)));

  return {
    type: 'flex',
    altText: `${title} 名單`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '開啟報名頁', uri: liffUrl(env, club) } },
        ],
      },
    },
  };
}

// ---------- 開放報名通知 ----------

/** 場次開放後多久內還會補發通知（排程每 5 分鐘跑一次，留一點漏跑的餘裕）；更久以前開放的不再通知。 */
const OPEN_NOTICE_WINDOW_MS = 30 * 60_000;

/**
 * 額度夠不夠發開放報名通知：發完還要夠再對群組推播一次，把額度留給遞補通知。
 * 方案沒有上限、或額度查不到時照發（額度真的不夠，LINE 會拒絕這一則，不會多扣）。
 */
export function canAffordOpenNotice(b: PushBudget): boolean {
  if (b.limit === null || b.used === null || b.groupSize === null) return true;
  return b.limit - b.used >= b.groupSize * 2;
}

async function openNoticeText(env: Env, club: Club, sessions: Session[]): Promise<string> {
  const lines: string[] = [];
  for (const s of sessions) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE session_id = ? AND status = 'confirmed'`)
      .bind(s.id)
      .first<{ n: number }>();
    const left = Math.max(0, s.capacity - (c?.n ?? 0));
    const where = [s.venue, s.court_no].filter(Boolean).join(' ');
    lines.push(`【開放報名】${sessionLabel(club, s)}`, [where, left ? `還有 ${left} 個名額` : '目前額滿，可排候補'].filter(Boolean).join('・'));
  }
  // 「+1」報的是最近一場；開放的剛好就是最近一場時才提示，免得報錯場
  const [next] = await upcomingSessions(env.DB, club.id, 1);
  const quick = sessions.length === 1 && next?.id === sessions[0].id ? '在群組輸入「+1」，或' : '';
  lines.push(`${quick}開報名頁報名：${liffUrl(env, club)}`);
  return lines.join('\n');
}

/**
 * 剛開放報名的場次在群組發通知（球團在「設定」開啟才發）。同一個球團同時開放的場次合併成一則。
 * 每一場只處理一次：先標記再發，發送失敗或額度不夠都不會重試，結果寫進 audit_logs（notify.open）。
 * 功能鎖住時（openNoticeEnabled）什麼都不做：不標記場次、不查額度，球團原本的開關也不看。
 */
export async function announceOpened(env: Env, now: number): Promise<void> {
  if (!openNoticeEnabled(env)) return;
  const { results } = await env.DB.prepare(
    `UPDATE sessions SET open_notified_at = ?1
     WHERE status = 'open' AND open_notified_at IS NULL AND reg_open_at <= ?1 AND reg_open_at >= ?2
       AND club_id IN (SELECT id FROM clubs WHERE notify_on_open = 1)
     RETURNING *`,
  )
    .bind(iso(now), iso(now - OPEN_NOTICE_WINDOW_MS))
    .all<Session>();

  const byClub = new Map<string, Session[]>();
  for (const s of results) byClub.set(s.club_id, [...(byClub.get(s.club_id) ?? []), s]);
  for (const [clubId, list] of byClub) {
    const sessions = list.sort((a, b) => a.start_at.localeCompare(b.start_at));
    const record = (detail: object) => audit(env.DB, clubId, 'system', 'notify.open', { sessions: sessions.map((s) => s.id), ...detail });
    try {
      const club = await getClub(env.DB, clubId);
      if (!club) continue;
      const budget = await pushBudget(env, club.line_group_id);
      if (!canAffordOpenNotice(budget)) {
        console.log('open notice skipped: quota', clubId, budget);
        await record({ sent: false, reason: 'quota', ...budget });
        continue;
      }
      await push(env, club.line_group_id, [text(await openNoticeText(env, club, sessions))]);
      await record({ sent: true, ...budget });
    } catch (e) {
      console.error('open notice failed', clubId, e);
      await record({ sent: false, reason: 'error', error: String(e).slice(0, 200) });
    }
  }
}
