import type { Context } from 'hono';
import type { Club, Env, Role } from './types';
import { UserError } from './types';

export type AppEnv = { Bindings: Env; Variables: { userId: string; club: Club; role: Role } };

/** 統一處理錯誤：UserError 回 400 並附訊息，其他錯誤回 500。 */
export function handler(fn: (c: Context<AppEnv>) => Promise<unknown>) {
  return async (c: Context<AppEnv>) => {
    try {
      return c.json((await fn(c)) ?? { ok: true });
    } catch (e) {
      if (e instanceof UserError) return c.json({ error: e.message }, 400);
      console.error('api error', c.req.path, e);
      return c.json({ error: '系統發生錯誤，請稍後再試' }, 500);
    }
  };
}

/** 讀 JSON body；格式錯誤或空 body 回傳空物件。 */
export async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}
