export interface Env {
  DB: D1Database;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LOGIN_CHANNEL_ID: string;
  LIFF_ID: string;
  LIFF_ORIGIN: string;
  /** 'on' 才會在開放報名時對群組發通知；沒設 = 鎖住（wrangler.toml 的 [vars]） */
  OPEN_NOTICE?: string;
  /** 意見回饋的收件信箱（wrangler.toml 的 [vars]）；沒填 = 不開放意見回饋 */
  FEEDBACK_TO?: string;
  /** 意見回饋的寄件人；沒填用 Resend 的測試寄件人（只能寄到註冊 Resend 的信箱） */
  FEEDBACK_FROM?: string;
  /** Resend 的 API key（wrangler secret）；沒設定時意見回饋先存著，設定後補寄 */
  RESEND_API_KEY?: string;
}

/**
 * 開放報名通知有沒有開放使用。目前鎖住（使用者 2026-10-12 要求）：對群組推播一次會以群組人數扣每月額度，
 * 改由管理員在群組輸入「名單」或「選單」（reply 不計費）。鎖住時排程不發、設定頁不出現開關。
 */
export const openNoticeEnabled = (env: Env): boolean => env.OPEN_NOTICE === 'on';

export type Role = 'owner' | 'admin' | 'member';
export type SessionStatus = 'scheduled' | 'open' | 'closed' | 'cancelled' | 'done';
export type RegStatus = 'confirmed' | 'waitlist' | 'leave' | 'cancelled';
export type RegKind = 'season' | 'casual';
export type Gender = 'M' | 'F';

/** 不在 LINE 上的人（例如教練）由管理員手動建立，id 以這個開頭；LINE 的 userId 一律是 U 開頭。 */
export const EXTERNAL_PREFIX = 'ext_';
export const isExternal = (userId: string): boolean => userId.startsWith(EXTERNAL_PREFIX);

export interface Club {
  id: string;
  line_group_id: string;
  name: string;
  timezone: string;
  casual_fee: number;
  reg_open_days_before: number;
  reg_open_time: string;
  reg_close_minutes_before: number;
  cancel_deadline_minutes_before: number | null;
  notify_on_open: number;
  notify_day_before: number;
  created_at: string;
  casual_fee_female: number | null;
  /** 球團規則／備註，顯示在報名頁 */
  rules: string | null;
  /** 1 = 季打成員可以看帳本（唯讀）；0 = 只有管理員看得到 */
  ledger_visible: number;
}

export interface Schedule {
  id: string;
  club_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  venue: string | null;
  courts: number;
  capacity: number;
  active: number;
  /** 第幾場地（自由文字） */
  court_no: string | null;
}

export interface Season {
  id: string;
  club_id: string;
  name: string;
  start_date: string;
  end_date: string;
  fee: number;
}

export interface Session {
  id: string;
  club_id: string;
  schedule_id: string | null;
  season_id: string | null;
  start_at: string;
  end_at: string;
  venue: string | null;
  courts: number;
  capacity: number;
  reg_open_at: string;
  reg_close_at: string;
  status: SessionStatus;
  cancel_reason: string | null;
  court_no: string | null;
  /** 開放報名通知處理過的時間；null = 還沒處理 */
  open_notified_at: string | null;
}

export interface Registration {
  id: string;
  session_id: string;
  user_id: string;
  guest_name: string | null;
  kind: RegKind;
  status: RegStatus;
  queued_at: string;
  attended: number | null;
  fee_amount: number | null;
  fee_paid: number;
  fee_recorded_by: string | null;
  updated_at: string;
  /** 臨打報名時選的（自己或朋友），只用來決定臨打費；null = 沒選 */
  gender: Gender | null;
  /** 臨打報名時填的程度（18 級羽球分級表的 1–18）；null = 沒填 */
  level: number | null;
}

export type LedgerCategory = 'venue' | 'shuttle' | 'other_expense' | 'other_income';

export interface LedgerEntry {
  id: string;
  club_id: string;
  category: LedgerCategory;
  amount: number;
  occurred_on: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

/** 使用者看得懂、可以直接顯示的錯誤（例如「這場還沒開放」）。 */
export class UserError extends Error {}

export const isAdmin = (role: Role | null): boolean => role === 'owner' || role === 'admin';
