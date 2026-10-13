-- 第一階段還沒有管理頁面，球團設定、每週時段和季打名單先用這份 SQL 建立。
-- 使用前：
--   1. 機器人已加入群組，並在群組輸入「/綁定 球團名稱」
--   2. 查出球團 id：
--        npx wrangler d1 execute badminton --remote --command "SELECT id, name FROM clubs"
--   3. 季打成員每人都要先在群組講過一次話（例如輸入「選單」），系統才有他們的 LINE 帳號
--   4. 把下面的 <CLUB_ID> 換成查到的 id，名稱、時間、人數依實際狀況修改
-- 執行：
--   npx wrangler d1 execute badminton --remote --file=seed.sql

-- 球團設定：臨打費、開打前 3 天中午 12:00 開放、開打時截止、取消不限時
UPDATE clubs SET
  casual_fee = 200,
  reg_open_days_before = 3,
  reg_open_time = '12:00',
  reg_close_minutes_before = 0,
  cancel_deadline_minutes_before = NULL
WHERE id = '<CLUB_ID>';

-- 每週時段：週三 20:00–22:00，2 面場地，上限 15 人（weekday：0 = 週日 … 6 = 週六）
INSERT INTO schedules (id, club_id, weekday, start_time, end_time, venue, courts, capacity)
VALUES ('wed-night', '<CLUB_ID>', 3, '20:00', '22:00', '某某國小體育館', 2, 15);

-- 季期：日期含頭尾
INSERT INTO seasons (id, club_id, name, start_date, end_date, fee)
VALUES ('2026q4', '<CLUB_ID>', '2026 第四季', '2026-10-01', '2026-12-31', 3000);

-- 季打名單：依 LINE 顯示名稱加入（名稱要和群組裡的一模一樣）
INSERT OR IGNORE INTO season_members (season_id, user_id)
SELECT '2026q4', line_user_id FROM users
WHERE display_name IN ('成員A', '成員B', '成員C');

-- 檢查有哪些人沒對到（列出已加入的季打成員）
SELECT u.display_name FROM season_members sm
JOIN users u ON u.line_user_id = sm.user_id
WHERE sm.season_id = '2026q4';
