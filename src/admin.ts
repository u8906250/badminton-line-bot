// 管理員 API：/api/clubs/:clubId/admin/*。規則都在 manage.ts；記帳在 ledger.ts。

import type { Context, Hono } from 'hono';
import { isAdmin, openNoticeEnabled } from './types';
import { audit } from './db';
import { type AppEnv, body, handler } from './http';
import * as m from './manage';
import * as ledger from './ledger';
import * as draws from './draws';
import { cancelSession, roster } from './service';
import { pushBudget } from './line';
import { pushChanges, pushText, sessionLabel } from './notify';

const P = '/clubs/:clubId/admin';

export function registerAdminRoutes(api: Hono<AppEnv>): void {
  // 必須在 api.ts 的球團中介層之後註冊，c.get('club') 與 c.get('role') 才有值
  api.use(`${P}/*`, async (c, next) => {
    if (!isAdmin(c.get('role'))) return c.json({ error: '只有管理員可以使用' }, 403);
    await next();
  });

  const log = (c: Context<AppEnv>, action: string, detail?: unknown) =>
    audit(c.env.DB, c.get('club').id, c.get('userId'), action, detail);

  const notifyChanges = (c: Context<AppEnv>, changes: m.Changes) => {
    if (changes.promoted.length || changes.demoted.length) {
      c.executionCtx.waitUntil(pushChanges(c.env, c.get('club'), changes));
    }
    return { promoted: changes.promoted.length, demoted: changes.demoted.length };
  };

  const param = (c: Context<AppEnv>, k: string) => c.req.param(k) ?? '';

  // ---- 球團設定 ----
  api.get(
    `${P}/settings`,
    handler(async (c) => {
      const club = c.get('club');
      return {
        name: club.name,
        timezone: club.timezone,
        casualFee: club.casual_fee,
        casualFeeFemale: club.casual_fee_female,
        rules: club.rules,
        ledgerVisible: !!club.ledger_visible,
        notifyOnOpen: !!club.notify_on_open,
        // false = 開放報名通知鎖住，設定頁改顯示「請管理員在群組輸入名單或選單」
        openNotice: openNoticeEnabled(c.env),
        regOpenDaysBefore: club.reg_open_days_before,
        regOpenTime: club.reg_open_time,
        regCloseMinutesBefore: club.reg_close_minutes_before,
        cancelDeadlineMinutesBefore: club.cancel_deadline_minutes_before,
      };
    }),
  );
  api.post(
    `${P}/settings`,
    handler(async (c) => {
      const input = await body(c);
      await m.updateSettings(c.env, c.get('club'), input);
      await log(c, 'club.settings', input);
    }),
  );

  // 刪除整個球團（擁有者限定，規則在 manage.deleteClub）。稽核紀錄不跟著刪，所以刪完還寫得進去
  api.post(
    `${P}/delete-club`,
    handler(async (c) => {
      const club = c.get('club');
      const { confirmName } = await body(c);
      const removed = await m.deleteClub(c.env, club, c.get('role'), confirmName);
      await log(c, 'club.delete', { name: club.name, removed });
    }),
  );

  // 本月推播額度與群組人數，給設定頁判斷開放報名通知發不發得起（通知鎖住時設定頁不會來查）
  api.get(`${P}/push-budget`, handler(async (c) => pushBudget(c.env, c.get('club').line_group_id)));

  // ---- 成員與角色 ----
  api.get(`${P}/members`, handler(async (c) => ({ members: await m.listMembers(c.env, c.get('club')) })));
  api.post(
    `${P}/members/:uid/nickname`,
    handler(async (c) => {
      const { nickname } = await body(c);
      await m.setNickname(c.env, c.get('club'), param(c, 'uid'), nickname);
      await log(c, 'member.nickname', { userId: param(c, 'uid'), nickname });
    }),
  );
  api.post(
    `${P}/members/:uid/remove`,
    handler(async (c) => {
      const changes = await m.removeExternalMember(c.env, c.get('club'), param(c, 'uid'));
      await log(c, 'member.removeExternal', { userId: param(c, 'uid') });
      return notifyChanges(c, changes);
    }),
  );
  api.post(
    `${P}/members/:uid/role`,
    handler(async (c) => {
      const { role } = await body(c);
      await m.setRole(c.env, c.get('club'), c.get('role'), param(c, 'uid'), role);
      await log(c, 'member.role', { userId: param(c, 'uid'), role });
    }),
  );
  api.post(
    `${P}/owner`,
    handler(async (c) => {
      const { userId } = await body(c);
      await m.transferOwner(c.env, c.get('club'), c.get('userId'), c.get('role'), String(userId ?? ''));
      await log(c, 'club.transferOwner', { to: userId });
    }),
  );

  // ---- 每週時段 ----
  api.get(`${P}/schedules`, handler(async (c) => ({ schedules: await m.listSchedules(c.env, c.get('club')) })));
  api.post(
    `${P}/schedules`,
    handler(async (c) => {
      const input = await body(c);
      const sc = await m.createSchedule(c.env, c.get('club'), input);
      await log(c, 'schedule.create', sc);
      return { schedule: sc };
    }),
  );
  api.post(
    `${P}/schedules/:id`,
    handler(async (c) => {
      const input = await body(c);
      const changes = await m.updateSchedule(c.env, c.get('club'), param(c, 'id'), input);
      await log(c, 'schedule.update', { id: param(c, 'id'), ...input });
      return notifyChanges(c, changes);
    }),
  );
  api.post(
    `${P}/schedules/:id/active`,
    handler(async (c) => {
      const { active } = await body(c);
      const r = await m.setScheduleActive(c.env, c.get('club'), param(c, 'id'), !!active);
      await log(c, active ? 'schedule.activate' : 'schedule.deactivate', { id: param(c, 'id'), ...r });
      return r;
    }),
  );

  // ---- 季期與季打名單 ----
  api.get(`${P}/seasons`, handler(async (c) => ({ seasons: await m.listSeasons(c.env, c.get('club')) })));
  api.post(
    `${P}/seasons`,
    handler(async (c) => {
      const input = await body(c);
      const se = await m.createSeason(c.env, c.get('club'), input);
      await log(c, 'season.create', se);
      return { season: se };
    }),
  );
  api.post(
    `${P}/seasons/:id`,
    handler(async (c) => {
      const input = await body(c);
      await m.updateSeason(c.env, c.get('club'), param(c, 'id'), input);
      await log(c, 'season.update', { id: param(c, 'id'), ...input });
    }),
  );
  api.post(
    `${P}/seasons/:id/members`,
    handler(async (c) => {
      const { userIds } = await body(c);
      const ids = Array.isArray(userIds) ? userIds.filter((x): x is string => typeof x === 'string') : [];
      const changes = await m.addSeasonMembers(c.env, c.get('club'), param(c, 'id'), ids);
      await log(c, 'season.addMembers', { id: param(c, 'id'), userIds: ids });
      return notifyChanges(c, changes);
    }),
  );
  api.post(
    `${P}/seasons/:id/externals`,
    handler(async (c) => {
      const { name } = await body(c);
      const r = await m.addExternalSeasonMember(c.env, c.get('club'), param(c, 'id'), name);
      await log(c, 'season.addExternal', { id: param(c, 'id'), userId: r.userId, name: r.name });
      return notifyChanges(c, r.changes);
    }),
  );
  api.post(
    `${P}/seasons/:id/members/:uid/remove`,
    handler(async (c) => {
      const changes = await m.removeSeasonMember(c.env, c.get('club'), param(c, 'id'), param(c, 'uid'));
      await log(c, 'season.removeMember', { id: param(c, 'id'), userId: param(c, 'uid') });
      return notifyChanges(c, changes);
    }),
  );
  api.post(
    `${P}/seasons/:id/members/:uid/fee`,
    handler(async (c) => {
      const { paid } = await body(c);
      await m.setSeasonFeePaid(c.env, c.get('club'), param(c, 'id'), param(c, 'uid'), !!paid);
      await log(c, 'season.fee', { id: param(c, 'id'), userId: param(c, 'uid'), paid: !!paid });
    }),
  );

  // ---- 抽籤紀錄（規則在 draws.ts）----
  api.get(`${P}/draws`, handler(async (c) => ({ draws: await draws.listDraws(c.env, c.get('club')) })));
  api.get(`${P}/draws/:id`, handler(async (c) => draws.drawView(c.env, c.get('club'), param(c, 'id'))));
  api.post(
    `${P}/draws`,
    handler(async (c) => {
      const d = await draws.createDraw(c.env, c.get('club'), await body(c), c.get('userId'));
      await log(c, 'draw.create', { id: d.id, name: d.name, note: d.note });
      return { draw: d };
    }),
  );
  api.post(
    `${P}/draws/:id`,
    handler(async (c) => {
      const input = await body(c);
      await draws.updateDraw(c.env, c.get('club'), param(c, 'id'), input);
      await log(c, 'draw.update', { id: param(c, 'id'), name: input.name, note: input.note });
    }),
  );
  api.post(
    `${P}/draws/:id/delete`,
    handler(async (c) => {
      const removed = await draws.deleteDraw(c.env, c.get('club'), param(c, 'id'));
      await log(c, 'draw.delete', { id: param(c, 'id'), ...removed });
    }),
  );
  api.post(
    `${P}/draws/:id/mark`,
    handler(async (c) => {
      const input = await body(c);
      const r = await draws.markDraw(c.env, c.get('club'), param(c, 'id'), input);
      await log(c, 'draw.mark', { id: param(c, 'id'), userId: input.userId, entryId: input.entryId, field: input.field, value: !!input.value });
      return r;
    }),
  );
  api.post(
    `${P}/draws/:id/outside`,
    handler(async (c) => {
      const r = await draws.addOutsideEntries(c.env, c.get('club'), param(c, 'id'), await body(c));
      await log(c, 'draw.addOutside', { id: param(c, 'id'), names: r.added });
      return r;
    }),
  );
  api.post(
    `${P}/draws/:id/outside/:eid/remove`,
    handler(async (c) => {
      const name = await draws.removeOutsideEntry(c.env, c.get('club'), param(c, 'id'), param(c, 'eid'));
      await log(c, 'draw.removeOutside', { id: param(c, 'id'), entryId: param(c, 'eid'), name });
    }),
  );

  // ---- 場次管理 ----
  api.get(`${P}/sessions`, handler(async (c) => ({ sessions: await m.listAdminSessions(c.env, c.get('club')) })));
  api.post(
    `${P}/sessions`,
    handler(async (c) => {
      const input = await body(c);
      const s = await m.createExtraSession(c.env, c.get('club'), input);
      await log(c, 'session.createExtra', s);
      return { session: s };
    }),
  );
  api.get(
    `${P}/sessions/:sid`,
    handler(async (c) => {
      const s = await m.getSessionOrThrow(c.env, c.get('club'), param(c, 'sid'));
      return { session: s, roster: await roster(c.env.DB, c.get('club').id, s.id) };
    }),
  );
  api.post(
    `${P}/sessions/:sid/capacity`,
    handler(async (c) => {
      const { capacity } = await body(c);
      const changes = await m.setSessionCapacity(c.env, c.get('club'), param(c, 'sid'), capacity);
      await log(c, 'session.capacity', { id: param(c, 'sid'), capacity });
      return notifyChanges(c, changes);
    }),
  );
  api.post(
    `${P}/sessions/:sid/court`,
    handler(async (c) => {
      const { courtNo } = await body(c);
      const saved = await m.setSessionCourt(c.env, c.get('club'), param(c, 'sid'), courtNo);
      await log(c, 'session.court', { id: param(c, 'sid'), courtNo: saved });
    }),
  );
  api.post(
    `${P}/sessions/:sid/cancel`,
    handler(async (c) => {
      const club = c.get('club');
      const input = await body(c);
      const reason = m.str(input.reason, 40, '原因', false) ?? undefined;
      const s = await m.getSessionOrThrow(c.env, club, param(c, 'sid'));
      await cancelSession(c.env, s, reason);
      await log(c, 'session.cancel', { id: s.id, reason });
      if (input.notify !== false) {
        c.executionCtx.waitUntil(pushText(c.env, club, `${sessionLabel(club, s)} 這場取消了${reason ? `（${reason}）` : ''}`));
      }
    }),
  );
  api.post(
    `${P}/sessions/:sid/register`,
    handler(async (c) => {
      const input = await body(c);
      const guest = m.str(input.guestName, 20, '朋友名字', false) ?? undefined;
      const fields = { gender: m.gender(input.gender), level: m.level(input.level) };
      const r = await m.adminRegister(c.env, c.get('club'), param(c, 'sid'), String(input.userId ?? ''), guest, fields);
      await log(c, 'registration.adminCreate', { sessionId: param(c, 'sid'), userId: input.userId, guest, ...fields, ...r });
      return r;
    }),
  );
  api.post(
    `${P}/sessions/:sid/registrations/:rid/cancel`,
    handler(async (c) => {
      const changes = await m.adminCancelRegistration(c.env, c.get('club'), param(c, 'sid'), param(c, 'rid'));
      await log(c, 'registration.adminCancel', { sessionId: param(c, 'sid'), registrationId: param(c, 'rid') });
      return notifyChanges(c, changes);
    }),
  );

  api.post(
    `${P}/sessions/:sid/registrations/:rid/unleave`,
    handler(async (c) => {
      const r = await m.adminUnleave(c.env, c.get('club'), param(c, 'sid'), param(c, 'rid'));
      await log(c, 'registration.adminUnleave', { sessionId: param(c, 'sid'), registrationId: param(c, 'rid'), ...r });
      return r;
    }),
  );

  // ---- 點名與收費 ----
  api.get(
    `${P}/sessions/:sid/attendance`,
    handler(async (c) => {
      const r = await m.attendanceList(c.env, c.get('club'), param(c, 'sid'));
      return { ...r, casualFee: c.get('club').casual_fee, casualFeeFemale: c.get('club').casual_fee_female };
    }),
  );
  api.post(
    `${P}/sessions/:sid/attendance/:rid`,
    handler(async (c) => {
      const input = await body(c);
      await m.setAttendance(c.env, c.get('club'), param(c, 'sid'), param(c, 'rid'), input, c.get('userId'));
      await log(c, 'attendance.set', { sessionId: param(c, 'sid'), registrationId: param(c, 'rid'), ...input });
    }),
  );

  // ---- 記帳（新增、刪除；讀取是 api.ts 的 GET /clubs/:clubId/ledger，季打成員也能看）----
  api.post(
    `${P}/ledger`,
    handler(async (c) => {
      const entry = await ledger.addLedgerEntry(c.env, c.get('club'), await body(c), c.get('userId'));
      await log(c, 'ledger.create', entry);
      return { entry };
    }),
  );
  api.post(
    `${P}/ledger/:id/delete`,
    handler(async (c) => {
      const removed = await ledger.deleteLedgerEntry(c.env, c.get('club'), param(c, 'id'));
      await log(c, 'ledger.delete', removed);
    }),
  );
}
