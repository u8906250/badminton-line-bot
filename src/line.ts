import type { Env } from './types';

const API = 'https://api.line.me';

export type LineMessage = Record<string, unknown>;

/** 驗證 webhook 的 x-line-signature（HMAC-SHA256 + base64）。 */
export async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function call(env: Env, path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
  const res = await fetch(API + path, {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`LINE API ${path} ${res.status}: ${await res.text()}`);
  return res;
}

/** 回覆訊息：不計入推播額度，reply token 只能用一次、約一分鐘內有效。 */
export async function reply(env: Env, replyToken: string, messages: LineMessage[]): Promise<void> {
  await call(env, '/v2/bot/message/reply', {
    method: 'POST',
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
}

/** 主動推播：計入推播額度，對群組推播一次以群組人數計算。 */
export async function push(env: Env, to: string, messages: LineMessage[]): Promise<void> {
  await call(env, '/v2/bot/message/push', {
    method: 'POST',
    body: JSON.stringify({ to, messages: messages.slice(0, 5) }),
  });
}

export interface PushBudget {
  /** 方案沒有每月上限 */
  unlimited: boolean;
  /** 本月上限；沒有上限或查不到為 null */
  limit: number | null;
  /** 本月已用；查不到為 null */
  used: number | null;
  /** 群組人數 = 對群組推播一次會用掉的則數；查不到為 null */
  groupSize: number | null;
}

/** 查本月推播額度與群組人數。查不到的項目回 null，不丟錯。 */
export async function pushBudget(env: Env, groupId: string): Promise<PushBudget> {
  const get = async <T>(path: string): Promise<T | null> => {
    try {
      return (await (await call(env, path)).json()) as T;
    } catch (e) {
      console.warn('LINE lookup failed', path, e);
      return null;
    }
  };
  const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const [quota, usage, members] = await Promise.all([
    get<{ type?: string; value?: unknown }>('/v2/bot/message/quota'),
    get<{ totalUsage?: unknown }>('/v2/bot/message/quota/consumption'),
    get<{ count?: unknown }>(`/v2/bot/group/${groupId}/members/count`),
  ]);
  return {
    unlimited: quota?.type === 'none',
    limit: quota?.type === 'limited' ? num(quota.value) : null,
    used: num(usage?.totalUsage),
    groupSize: num(members?.count),
  };
}

export async function getGroupMemberProfile(
  env: Env,
  groupId: string,
  userId: string,
): Promise<{ displayName: string; pictureUrl?: string } | null> {
  try {
    const res = await call(env, `/v2/bot/group/${groupId}/member/${userId}`);
    return (await res.json()) as { displayName: string; pictureUrl?: string };
  } catch (e) {
    console.warn('getGroupMemberProfile failed', e);
    return null;
  }
}

/** 驗證 LIFF 的 ID token，回傳 userId（sub）與基本資料；失敗回傳 null。 */
export async function verifyIdToken(
  env: Env,
  idToken: string,
): Promise<{ sub: string; name?: string; picture?: string } | null> {
  const res = await fetch(`${API}/oauth2/v2.1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: env.LOGIN_CHANNEL_ID }),
  });
  if (!res.ok) return null;
  return (await res.json()) as { sub: string; name?: string; picture?: string };
}

export const text = (t: string): LineMessage => ({ type: 'text', text: t.slice(0, 5000) });

export type MentionPart = string | { userId: string };

/** 帶 @提及的文字訊息（textV2）。字串中的大括號會自動跳脫。沒有任何 @ 時就是一般文字訊息。 */
export function mentionText(parts: MentionPart[]): LineMessage {
  if (parts.every((p) => typeof p === 'string')) return text(parts.join(''));
  let out = '';
  const substitution: Record<string, unknown> = {};
  let i = 0;
  for (const p of parts) {
    if (typeof p === 'string') {
      out += p.replace(/\{/g, '{{').replace(/\}/g, '}}');
    } else {
      const key = `u${i++}`;
      out += `{${key}}`;
      substitution[key] = { type: 'mention', mentionee: { type: 'user', userId: p.userId } };
    }
  }
  return { type: 'textV2', text: out, substitution };
}
