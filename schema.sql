-- 羽球臨打季打管理系統：D1 (SQLite) schema
-- 時間欄位（*_at）一律存 UTC ISO 8601；日期與時刻（date / time）為球團時區的當地值。
-- 這份檔案只會建立還不存在的資料表；既有資料庫要加欄位時，執行 migrations/ 裡對應的檔案（各一次）。

CREATE TABLE IF NOT EXISTS clubs (
  id TEXT PRIMARY KEY,
  line_group_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',
  casual_fee INTEGER NOT NULL DEFAULT 0,             -- 臨打費（報名時沒選女生的都收這個）
  reg_open_days_before INTEGER NOT NULL DEFAULT 3,
  reg_open_time TEXT NOT NULL DEFAULT '12:00',        -- 球團時區
  reg_close_minutes_before INTEGER NOT NULL DEFAULT 0,
  cancel_deadline_minutes_before INTEGER,             -- NULL = 不限制
  notify_on_open INTEGER NOT NULL DEFAULT 0,
  notify_day_before INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  casual_fee_female INTEGER,                         -- 報名時選女生的臨打費；NULL = 和 casual_fee 相同
  rules TEXT,                                        -- 球團規則／備註，顯示在報名頁；NULL = 沒填
  ledger_visible INTEGER NOT NULL DEFAULT 1          -- 1 = 季打成員可以看帳本（唯讀）；0 = 只有管理員看得到
);

-- 不在 LINE 上的人（例如教練）由管理員手動建立，line_user_id 以 'ext_' 開頭；LINE 的 userId 一律是 U 開頭。
CREATE TABLE IF NOT EXISTS users (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  picture_url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS club_members (
  club_id TEXT NOT NULL REFERENCES clubs(id),
  user_id TEXT NOT NULL REFERENCES users(line_user_id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  nickname TEXT,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (club_id, user_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = 週日
  start_time TEXT NOT NULL,                                  -- 'HH:mm'
  end_time TEXT NOT NULL,
  venue TEXT,
  courts INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  court_no TEXT                                      -- 第幾場地（自由文字，例如「第 3、4 場」）；NULL = 沒填
);
-- 排程與管理頁面都是「查某個球團的時段／季期」，沒有索引會每次掃過所有球團的資料
CREATE INDEX IF NOT EXISTS idx_schedules_club ON schedules(club_id);

CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,                          -- 'YYYY-MM-DD'，含當天
  end_date TEXT NOT NULL,                            -- 'YYYY-MM-DD'，含當天
  fee INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seasons_club ON seasons(club_id);

CREATE TABLE IF NOT EXISTS season_members (
  season_id TEXT NOT NULL REFERENCES seasons(id),
  user_id TEXT NOT NULL REFERENCES users(line_user_id),
  fee_paid INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  note TEXT,
  fee_exempt INTEGER NOT NULL DEFAULT 0,              -- 1 = 不收季費（例如教練），記帳的已繳、未繳都不算他
  PRIMARY KEY (season_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  schedule_id TEXT REFERENCES schedules(id),         -- NULL = 臨時加場
  season_id TEXT REFERENCES seasons(id),             -- NULL = 無季打佔位
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  venue TEXT,
  courts INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  reg_open_at TEXT NOT NULL,
  reg_close_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','open','closed','cancelled','done')),
  cancel_reason TEXT,
  court_no TEXT,                                     -- 這一場在第幾場地：產生場次時由時段帶入，可單場修改
  open_notified_at TEXT                              -- 開放報名通知處理過的時間（發了或因額度略過都會記）；NULL = 還沒處理
);
CREATE INDEX IF NOT EXISTS idx_sessions_club_time ON sessions(club_id, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_schedule ON sessions(schedule_id, start_at);
-- 排程每 5 分鐘推進狀態時只找還沒結束的場次；沒有這個索引會把歷年所有場次都掃一遍
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(line_user_id), -- 報名人
  guest_name TEXT,                                   -- 代朋友報名時填
  kind TEXT NOT NULL CHECK (kind IN ('season','casual')),
  status TEXT NOT NULL CHECK (status IN ('confirmed','waitlist','leave','cancelled')),
  queued_at TEXT NOT NULL,                           -- 候補排序依據
  attended INTEGER,                                  -- NULL = 尚未點名
  fee_amount INTEGER,
  fee_paid INTEGER NOT NULL DEFAULT 0,
  fee_recorded_by TEXT,
  updated_at TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('M','F')),           -- 臨打報名時選的（自己或朋友），只用來決定臨打費；NULL = 沒選
  level INTEGER CHECK (level BETWEEN 1 AND 18)       -- 臨打報名時填的程度（18 級羽球分級表）；NULL = 沒填
);
CREATE INDEX IF NOT EXISTS idx_reg_queue ON registrations(session_id, status, queued_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_self ON registrations(session_id, user_id)
  WHERE guest_name IS NULL AND status <> 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS uq_reg_guest ON registrations(session_id, user_id, guest_name)
  WHERE guest_name IS NOT NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,                                       -- JSON
  created_at TEXT NOT NULL
);

-- 記帳：手動登記的收支（場地費、羽球費等）。
-- 季打費、臨打費的收入直接從 season_members、registrations 的繳費紀錄彙總，不重複記在這裡。
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  category TEXT NOT NULL CHECK (category IN ('venue','shuttle','other_expense','other_income')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  occurred_on TEXT NOT NULL,                         -- 'YYYY-MM-DD'，球團時區
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_club_date ON ledger_entries(club_id, occurred_on);

-- 意見回饋：成員在報名頁寫給系統維護者的話，由排程寄到 FEEDBACK_TO 信箱（src/feedback.ts）。
-- 這是寫給維護者的，不是球團的資料：和 audit_logs 一樣沒有外鍵，刪除球團時保留；球團與留言人的名字存當時的。
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL,
  club_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,               -- 寄了幾次；寄不出去最多試 5 次
  emailed_at TEXT,                                   -- 寄出的時間；NULL = 還沒寄出
  last_error TEXT                                    -- 最近一次寄送失敗的原因
);
-- 排程每 5 分鐘找一次還沒寄出的，只索引那幾筆
CREATE INDEX IF NOT EXISTS idx_feedback_unsent ON feedback (created_at) WHERE emailed_at IS NULL;

-- 抽籤紀錄（例如場地抽籤）：管理員建立一次抽籤，勾選哪些人已經抽籤、誰抽中（src/draws.ts）。
CREATE TABLE IF NOT EXISTS draws (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES clubs(id),
  name TEXT NOT NULL,
  note TEXT,                                         -- 備註，例如抽哪個場館、哪個時段；NULL = 沒填
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draws_club ON draws(club_id, created_at);

-- 一次抽籤裡每個人的紀錄。球團成員只有勾過才會有一筆（id = <drawId>_m_<userId>）；
-- 不在球團裡的人由管理員手動加入（user_id 為 NULL，名字記在 name）。
CREATE TABLE IF NOT EXISTS draw_entries (
  id TEXT PRIMARY KEY,
  draw_id TEXT NOT NULL REFERENCES draws(id),
  user_id TEXT REFERENCES users(line_user_id),       -- 球團成員；NULL = 手動加入的外面名單
  name TEXT,                                         -- 外面名單的名字；成員的名字一律用當下的暱稱／LINE 名稱
  drawn INTEGER NOT NULL DEFAULT 0,                  -- 已抽籤
  won INTEGER NOT NULL DEFAULT 0,                    -- 抽中（抽中一定算已抽籤）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draw_entries_draw ON draw_entries(draw_id);
