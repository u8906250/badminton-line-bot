// 意見回饋：成員寫給這套系統的開發者的話。先存進 feedback，再由排程用 Resend 寄到開發者的信箱。
// 只寄給開發者：球團的擁有者、管理員都看不到別人寫的（使用者 2026-10-13 要求），所以沒有讀取用的 API。
// 分成「存」和「寄」兩步：寄信的服務出問題、或金鑰還沒設定時，留言不會不見，之後補寄。

import type { Club, Env, Role } from './types';
import { UserError } from './types';
import { getClub } from './db';
import { str } from './manage';
import { formatLocal, iso } from './time';

/** 同一個人 24 小時內最多送幾則（免得信箱被灌爆）。 */
const DAILY_LIMIT = 5;
/** 寄不出去最多試幾次（每 5 分鐘一次）；之後留在資料庫裡，不再重試。 */
const MAX_ATTEMPTS = 5;
/** 排程每次最多寄幾封。 */
const BATCH = 5;
/** 沒有自己的網域時，Resend 只讓這個寄件人寄到「註冊 Resend 的那個信箱」，剛好就是開發者自己。 */
const DEFAULT_FROM = '羽球報名系統 <onboarding@resend.dev>';
const ROLE_LABEL: Record<string, string> = { owner: '擁有者', admin: '管理員', member: '成員' };

interface Feedback {
  id: string;
  club_id: string;
  club_name: string;
  user_id: string;
  user_name: string;
  role: string;
  message: string;
  created_at: string;
  attempts: number;
}

/** wrangler.toml 有填收件信箱才開放（報名頁才會出現「意見回饋」）。 */
export const feedbackEnabled = (env: Env): boolean => !!env.FEEDBACK_TO;

export async function submitFeedback(env: Env, club: Club, userId: string, role: Role, message: unknown, now = Date.now()): Promise<void> {
  if (!feedbackEnabled(env)) throw new UserError('意見回饋沒有開放');
  const text = str(message, 1000, '內容')!;
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback WHERE user_id = ?1 AND created_at > ?2')
    .bind(userId, iso(now - 86_400_000))
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= DAILY_LIMIT) throw new UserError('今天已經送出好幾則了，請明天再寫');
  const who = await env.DB.prepare(
    `SELECT COALESCE(m.nickname, u.display_name) AS name FROM users u
     LEFT JOIN club_members m ON m.club_id = ?1 AND m.user_id = u.line_user_id WHERE u.line_user_id = ?2`,
  )
    .bind(club.id, userId)
    .first<{ name: string }>();
  // 球團和留言人的名字存當時的：之後改名、退群、刪除球團，信裡還是寫得出是誰
  await env.DB.prepare(
    `INSERT INTO feedback (id, club_id, club_name, user_id, user_name, role, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), club.id, club.name, userId, who?.name ?? '未知成員', role, text, iso(now))
    .run();
}

async function sendEmail(env: Env, f: Feedback): Promise<void> {
  const tz = (await getClub(env.DB, f.club_id))?.timezone ?? 'Asia/Taipei';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      // 重試時同一則用同一個 key，Resend 那邊已經收過就不會再寄一次
      'Idempotency-Key': `feedback-${f.id}`,
    },
    body: JSON.stringify({
      from: env.FEEDBACK_FROM || DEFAULT_FROM,
      to: [env.FEEDBACK_TO],
      subject: `【意見回饋】${f.club_name}｜${f.user_name}`,
      // 只寄純文字：留言內容不會被當成 HTML
      text: [
        `球團：${f.club_name}`,
        `來自：${f.user_name}（${ROLE_LABEL[f.role] ?? f.role}）`,
        `時間：${formatLocal(Date.parse(f.created_at), tz)}`,
        '',
        f.message,
      ].join('\n'),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/**
 * 把還沒寄出的意見回饋寄給開發者（排程呼叫）。先把次數加一再寄，同一則不會被兩輪排程同時處理。
 * 收件信箱或 RESEND_API_KEY 還沒設定時什麼都不做，留言留著，設定好之後的下一輪會補寄。
 */
export async function deliverFeedback(env: Env, now = Date.now()): Promise<void> {
  if (!feedbackEnabled(env) || !env.RESEND_API_KEY) return;
  const { results } = await env.DB.prepare(
    `UPDATE feedback SET attempts = attempts + 1
     WHERE id IN (SELECT id FROM feedback WHERE emailed_at IS NULL AND attempts < ?1 ORDER BY created_at LIMIT ?2)
     RETURNING *`,
  )
    .bind(MAX_ATTEMPTS, BATCH)
    .all<Feedback>();
  for (const f of results.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    try {
      await sendEmail(env, f);
      await env.DB.prepare('UPDATE feedback SET emailed_at = ?, last_error = NULL WHERE id = ?').bind(iso(now), f.id).run();
    } catch (e) {
      console.error('feedback email failed', f.id, e);
      await env.DB.prepare('UPDATE feedback SET last_error = ? WHERE id = ?').bind(String(e).slice(0, 300), f.id).run();
    }
  }
}
