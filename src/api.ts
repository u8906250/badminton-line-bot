// LIFF 頁面呼叫的 REST API。每個請求都要帶 LIFF ID token。

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { Gender, Session } from './types';
import { UserError, isAdmin } from './types';
import { getGroupMemberProfile, verifyIdToken } from './line';
import { ensureMember, getClubAndRole, getSession, upsertUser } from './db';
import * as svc from './service';
import { pushPromoted } from './notify';
import { registerAdminRoutes } from './admin';
import { gender, level } from './manage';
import { canViewLedger, ledgerView } from './ledger';
import { feedbackEnabled, submitFeedback } from './feedback';
import { type AppEnv, handler } from './http';


export const api = new Hono<AppEnv>();

/** 放行 LIFF_ORIGIN 本身，以及 Pages 每次部署產生的 https://<代碼>.<LIFF_ORIGIN 主機> 網址。 */
export function allowedOrigin(origin: string, liffOrigin: string): string | null {
  const base = liffOrigin.replace(/\/+$/, '');
  if (!base.startsWith('https://')) return null;
  if (origin === base) return origin;
  return origin.startsWith('https://') && origin.endsWith(`.${base.slice('https://'.length)}`) ? origin : null;
}

api.use('*', (c, next) =>
  cors({
    origin: (origin) => allowedOrigin(origin, c.env.LIFF_ORIGIN),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  })(c, next),
);

// 診斷用（不用登入、不回傳任何資料）：這個請求在哪個機房執行、查一次資料庫來回要多久。
// 覺得畫面變慢時，分別對 workers.dev 和 pages.dev 的 /api/ping 量一次，就看得出是不是又繞到遠的機房去了。
api.get('/ping', async (c) => {
  const dbMs: number[] = [];
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    await c.env.DB.prepare('SELECT 1').first();
    dbMs.push(Date.now() - t);
  }
  return c.json({ ok: true, colo: (c.req.raw as Request & { cf?: { colo?: string } }).cf?.colo ?? null, dbMs });
});

// 同一個 isolate 內暫存驗證過的 token，避免每個請求都打 LINE 驗證 API
const tokenCache = new Map<string, { sub: string; exp: number }>();

api.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return c.json({ error: '未登入' }, 401);
  const cached = tokenCache.get(token);
  let sub: string;
  if (cached && cached.exp > Date.now()) {
    sub = cached.sub;
  } else {
    const p = await verifyIdToken(c.env, token);
    if (!p) return c.json({ error: '登入已過期，請關閉後重新開啟頁面' }, 401);
    sub = p.sub;
    if (p.name) await upsertUser(c.env.DB, { id: p.sub, displayName: p.name, pictureUrl: p.picture });
    if (tokenCache.size > 500) tokenCache.clear();
    tokenCache.set(token, { sub, exp: Date.now() + 5 * 60_000 });
  }
  c.set('userId', sub);
  await next();
});

api.use('/clubs/:clubId/*', async (c, next) => {
  const { club, role: known } = await getClubAndRole(c.env.DB, c.req.param('clubId') ?? '', c.get('userId'));
  if (!club) return c.json({ error: '找不到這個球團' }, 404);
  let role = known;
  if (!role) {
    // 還沒在群組傳過訊息的人：向 LINE 確認他確實在這個球團的群組裡，是的話直接加成成員（不在群組裡的人拿到連結也進不來）
    const profile = await getGroupMemberProfile(c.env, club.line_group_id, c.get('userId'));
    if (!profile) return c.json({ error: '你不在這個球團的 LINE 群組裡，請先加入群組再打開報名頁' }, 403);
    await upsertUser(c.env.DB, { id: c.get('userId'), displayName: profile.displayName, pictureUrl: profile.pictureUrl });
    await ensureMember(c.env.DB, club.id, c.get('userId'));
    role = 'member';
  }
  c.set('club', club);
  c.set('role', role);
  await next();
});

async function loadSession(c: Context<AppEnv>): Promise<Session> {
  const s = await getSession(c.env.DB, c.get('club').id, c.req.param('sid') ?? '');
  if (!s) throw new UserError('找不到這個場次');
  return s;
}

/** 報名／取消時 body 帶的朋友名字（沒帶就是自己），以及報名時選的臨打費（性別）與程度。 */
async function regFromBody(c: Context<AppEnv>): Promise<{ guest?: string; gender: Gender | null; level: number | null }> {
  const body = (await c.req.json().catch(() => ({}))) as { guestName?: unknown; gender?: unknown; level?: unknown };
  const g = typeof body.guestName === 'string' ? body.guestName.trim().slice(0, 20) : '';
  return { guest: g || undefined, gender: gender(body.gender), level: level(body.level) };
}

function sessionDto(s: Session) {
  return {
    id: s.id,
    startAt: s.start_at,
    endAt: s.end_at,
    venue: s.venue,
    courtNo: s.court_no,
    capacity: s.capacity,
    status: s.status,
    regOpenAt: s.reg_open_at,
    regCloseAt: s.reg_close_at,
    cancelReason: s.cancel_reason,
  };
}

api.get(
  '/clubs/:clubId/me',
  handler(async (c) => {
    const club = c.get('club');
    const role = c.get('role');
    return {
      userId: c.get('userId'),
      role,
      isAdmin: isAdmin(role),
      canViewLedger: await canViewLedger(c.env, club, c.get('userId'), role),
      feedback: feedbackEnabled(c.env),
      club: {
        id: club.id,
        name: club.name,
        timezone: club.timezone,
        casualFee: club.casual_fee,
        casualFeeFemale: club.casual_fee_female,
        rules: club.rules,
      },
    };
  }),
);

// 意見回饋：寫給開發者，存起來由排程寄信（規則在 feedback.ts）。只收不給看：沒有讀取的路由
api.post(
  '/clubs/:clubId/feedback',
  handler(async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { message?: unknown };
    await submitFeedback(c.env, c.get('club'), c.get('userId'), c.get('role'), body.message);
  }),
);

api.get(
  '/clubs/:clubId/sessions',
  handler(async (c) => {
    const list = await svc.sessionsOverview(c.env.DB, c.get('club').id, c.get('userId'));
    return {
      sessions: list.map((o) => ({ ...sessionDto(o.session), confirmed: o.confirmed, waitlist: o.waitlist, mine: o.mine, roster: o.roster })),
    };
  }),
);

api.get(
  '/clubs/:clubId/sessions/:sid',
  handler(async (c) => {
    const s = await loadSession(c);
    return { session: sessionDto(s), roster: await svc.roster(c.env.DB, c.get('club').id, s.id) };
  }),
);

api.post(
  '/clubs/:clubId/sessions/:sid/register',
  handler(async (c) => {
    const s = await loadSession(c);
    const { guest, ...fields } = await regFromBody(c);
    return svc.register(c.env, c.get('club'), s, c.get('userId'), guest, fields);
  }),
);

api.post(
  '/clubs/:clubId/sessions/:sid/cancel',
  handler(async (c) => {
    const club = c.get('club');
    const s = await loadSession(c);
    const promoted = await svc.cancel(c.env, club, s, c.get('userId'), (await regFromBody(c)).guest, isAdmin(c.get('role')));
    if (promoted) c.executionCtx.waitUntil(pushPromoted(c.env, club, s, promoted));
    return { ok: true };
  }),
);

api.post(
  '/clubs/:clubId/sessions/:sid/leave',
  handler(async (c) => {
    const club = c.get('club');
    const s = await loadSession(c);
    const promoted = await svc.leave(c.env, s, c.get('userId'));
    if (promoted) c.executionCtx.waitUntil(pushPromoted(c.env, club, s, promoted));
    return { ok: true };
  }),
);

api.post(
  '/clubs/:clubId/sessions/:sid/unleave',
  handler(async (c) => svc.unleave(c.env, await loadSession(c), c.get('userId'))),
);

// 帳本（唯讀）：管理員與季打成員都能看。新增、刪除在管理員 API
api.get(
  '/clubs/:clubId/ledger',
  async (c, next) => {
    if (!(await canViewLedger(c.env, c.get('club'), c.get('userId'), c.get('role')))) {
      return c.json({ error: c.get('club').ledger_visible ? '帳本只開放給季打成員和管理員' : '帳本目前只有管理員看得到' }, 403);
    }
    await next();
  },
  handler(async (c) => ledgerView(c.env, c.get('club'), c.req.query())),
);

registerAdminRoutes(api);
