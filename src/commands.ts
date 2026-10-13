// LINE webhook 事件與群組指令。

import type { Club, Env, Gender, Session } from './types';
import { UserError, isAdmin } from './types';
import { type LineMessage, getGroupMemberProfile, reply, text } from './line';
import { audit, ensureMember, getClubByGroup, getRole, getUser, upcomingSessions, upsertUser } from './db';
import * as svc from './service';
import { liffUrl, promotedMessage, pushPromoted, rosterFlex, sessionLabel } from './notify';
import { level as checkLevel } from './manage';
import { localWeekday, nowIso, zhWeekday } from './time';

export type Command =
  | { type: 'bind'; arg?: string }
  | { type: 'join'; weekday?: number; guest?: string; gender?: Gender; level?: number }
  | { type: 'cancel'; weekday?: number; guest?: string }
  | { type: 'leave' | 'unleave' | 'roster'; weekday?: number }
  | { type: 'menu' }
  | { type: 'cancelSession'; arg?: string };

const DAY = /^(?:週|周|星期)([一二三四五六日天])$/;
const GENDER: Record<string, Gender | undefined> = { 男: 'M', 男生: 'M', 女: 'F', 女生: 'F' };
// 程度：「6級」「L6」「Lv6」「level 6」這類寫法；範圍在報名時才檢查，寫錯會回覆提示
const LEVEL = /^(?:(?:level|lv|l)\.?(\d{1,2})級?|(\d{1,2})級)$/i;

/** 解析群組訊息；不是指令就回傳 null（機器人不回應一般聊天）。 */
export function parseCommand(raw: string): Command | null {
  // NFKC 把全形英數符號轉成半形：＋１→+1、／綁定→/綁定、全形空白→空白
  const t = raw.normalize('NFKC').trim().replace(/[—–]/g, '-');
  const [head, ...rest] = t.split(/\s+/);
  let weekday: number | undefined;
  const args: string[] = [];
  for (const r of rest) {
    const m = r.match(DAY);
    if (m && weekday === undefined) weekday = '日一二三四五六'.indexOf(m[1] === '天' ? '日' : m[1]);
    else args.push(r);
  }
  // 最後面的詞是男／女或程度時，當成報名欄位而不是名字：「+1 女 6級」是自己，「+1 小美 女 6級」是朋友
  let gender: Gender | undefined;
  let level: number | undefined;
  while (args.length) {
    const last = args[args.length - 1];
    const lv = last.match(LEVEL);
    if (gender === undefined && GENDER[last]) gender = GENDER[last];
    else if (level === undefined && lv) level = Number(lv[1] ?? lv[2]);
    else break;
    args.pop();
  }
  const arg = args.join(' ').slice(0, 20) || undefined;
  switch (head) {
    case '+1':
      return { type: 'join', weekday, guest: arg, gender, level };
    case '-1':
    case '取消':
      return { type: 'cancel', weekday, guest: arg };
    case '請假':
      return { type: 'leave', weekday };
    case '銷假':
      return { type: 'unleave', weekday };
    case '名單':
      return { type: 'roster', weekday };
    case '選單':
      return { type: 'menu' };
    case '/綁定':
      return { type: 'bind', arg: rest.join(' ').trim() || undefined };
    case '/取消場次':
      return { type: 'cancelSession', arg: rest.join(' ').trim() || undefined };
    default:
      return null;
  }
}

const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

/** 確保使用者存在並是球團成員；顯示名稱超過一天才重新抓。 */
async function touchUser(env: Env, groupId: string, userId: string): Promise<string> {
  const user = await getUser(env.DB, userId);
  if (user && Date.now() - Date.parse(user.updated_at) < PROFILE_TTL_MS) return user.display_name;
  const profile = await getGroupMemberProfile(env, groupId, userId);
  const displayName = profile?.displayName ?? user?.display_name ?? '未知成員';
  await upsertUser(env.DB, { id: userId, displayName, pictureUrl: profile?.pictureUrl });
  return displayName;
}

async function targetSession(env: Env, club: Club, weekday?: number): Promise<Session> {
  const sessions = await upcomingSessions(env.DB, club.id);
  const s =
    weekday === undefined
      ? sessions[0]
      : sessions.find((x) => localWeekday(Date.parse(x.start_at), club.timezone) === weekday);
  if (!s) {
    throw new UserError(weekday === undefined ? '目前沒有排定的場次' : `近期沒有週${zhWeekday(weekday)}的場次`);
  }
  return s;
}

function queueText(r: svc.QueueResult): string {
  return r.status === 'confirmed' ? '正取' : `候補第 ${r.position} 位`;
}

async function runCommand(
  env: Env,
  club: Club | null,
  groupId: string,
  userId: string,
  cmd: Command,
): Promise<LineMessage[]> {
  if (cmd.type === 'bind') {
    if (club) throw new UserError(`這個群組已經綁定「${club.name}」`);
    if (!cmd.arg) throw new UserError('請輸入球團名稱，例如「/綁定 週三羽球團」');
    const id = crypto.randomUUID();
    const now = nowIso();
    await touchUser(env, groupId, userId);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO clubs (id, line_group_id, name, created_at) VALUES (?, ?, ?, ?)').bind(id, groupId, cmd.arg, now),
      env.DB.prepare(`INSERT INTO club_members (club_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)`).bind(id, userId, now),
    ]);
    await audit(env.DB, id, userId, 'club.bind', { name: cmd.arg });
    const created = { id } as Club;
    return [text(`已建立球團「${cmd.arg}」，你是擁有者。\n請大家在群組輸入一次「選單」，再打開報名頁的「管理」分頁設定時段與季打名單。\n報名頁：${liffUrl(env, created)}`)];
  }

  if (!club) throw new UserError('這個群組還沒綁定球團，請先輸入「/綁定 球團名稱」');
  const name = await touchUser(env, groupId, userId);
  await ensureMember(env.DB, club.id, userId);

  switch (cmd.type) {
    case 'menu':
      return [text(`「${club.name}」報名頁：${liffUrl(env, club)}`)];

    case 'roster': {
      const s = await targetSession(env, club, cmd.weekday);
      return [rosterFlex(env, club, s, await svc.roster(env.DB, club.id, s.id))];
    }

    case 'join': {
      const s = await targetSession(env, club, cmd.weekday);
      const r = await svc.register(env, club, s, userId, cmd.guest, { gender: cmd.gender, level: checkLevel(cmd.level) });
      const who = cmd.guest ? `${cmd.guest}（${name} 的朋友）` : name;
      return [text(`${who} 報名成功：${queueText(r)}\n${sessionLabel(club, s)}`)];
    }

    case 'cancel': {
      const s = await targetSession(env, club, cmd.weekday);
      const promoted = await svc.cancel(env, club, s, userId, cmd.guest, isAdmin(await getRole(env.DB, club.id, userId)));
      const msgs: LineMessage[] = [text(`${cmd.guest ?? name} 已取消 ${sessionLabel(club, s)}`)];
      if (promoted) msgs.push(await promotedMessage(env, club, s, promoted));
      return msgs;
    }

    case 'leave': {
      const s = await targetSession(env, club, cmd.weekday);
      const promoted = await svc.leave(env, s, userId);
      const msgs: LineMessage[] = [text(`${name} 已請假 ${sessionLabel(club, s)}`)];
      if (promoted) msgs.push(await promotedMessage(env, club, s, promoted));
      return msgs;
    }

    case 'unleave': {
      const s = await targetSession(env, club, cmd.weekday);
      const r = await svc.unleave(env, s, userId);
      return [text(`${name} 已銷假：${queueText(r)}\n${sessionLabel(club, s)}`)];
    }

    case 'cancelSession': {
      if (!isAdmin(await getRole(env.DB, club.id, userId))) throw new UserError('只有管理員可以取消場次');
      const s = await targetSession(env, club);
      await svc.cancelSession(env, s, cmd.arg);
      await audit(env.DB, club.id, userId, 'session.cancel', { sessionId: s.id, reason: cmd.arg });
      return [text(`${sessionLabel(club, s)} 這場取消了${cmd.arg ? `（${cmd.arg}）` : ''}`)];
    }
  }
}

// LINE webhook 事件只取用到的欄位
interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type: string; groupId?: string; userId?: string };
  message?: { type: string; text?: string };
  left?: { members: { userId: string }[] };
}

export async function handleEvent(env: Env, ev: LineEvent): Promise<void> {
  // 每個事件記一行，用 wrangler tail 就看得到收到了什麼
  console.log('event', ev.type, ev.source?.type ?? '-', ev.message?.type === 'text' ? JSON.stringify(ev.message.text?.slice(0, 30)) : '');

  const groupId = ev.source?.type === 'group' ? ev.source.groupId : undefined;
  if (!groupId) {
    // 一對一或多人聊天室：提示到群組使用，避免看起來像沒反應
    if (ev.type === 'message' && ev.replyToken) {
      await reply(env, ev.replyToken, [text('請把我加入羽球群組，然後在群組裡輸入指令（例如「/綁定 球團名稱」）。')]);
    }
    return;
  }

  if (ev.type === 'join' && ev.replyToken) {
    const club = await getClubByGroup(env.DB, groupId);
    await reply(env, ev.replyToken, [
      text(club ? `回來了！這個群組綁定的是「${club.name}」。` : '大家好！請管理員輸入「/綁定 球團名稱」開始使用。'),
    ]);
    return;
  }

  if (ev.type === 'memberLeft' && ev.left) {
    const club = await getClubByGroup(env.DB, groupId);
    if (!club) return;
    for (const m of ev.left.members) {
      for (const { session, promoted } of await svc.releaseLeftMember(env, club.id, m.userId)) {
        await pushPromoted(env, club, session, promoted);
      }
    }
    return;
  }

  if (ev.type !== 'message' || ev.message?.type !== 'text' || !ev.message.text) return;
  const userId = ev.source?.userId;
  if (!userId) return;

  const cmd = parseCommand(ev.message.text);
  const club = await getClubByGroup(env.DB, groupId);
  if (!cmd) {
    // 一般聊天：只記錄成員，不回應
    if (club) {
      await touchUser(env, groupId, userId);
      await ensureMember(env.DB, club.id, userId);
    }
    return;
  }

  const replyToken = ev.replyToken;
  if (!replyToken) return;
  try {
    const messages = await runCommand(env, club, groupId, userId, cmd);
    if (messages.length) await reply(env, replyToken, messages);
  } catch (e) {
    if (e instanceof UserError) {
      await reply(env, replyToken, [text(e.message)]);
    } else {
      console.error('command failed', cmd, e);
      await reply(env, replyToken, [text('系統發生錯誤，請稍後再試')]);
    }
  }
}
