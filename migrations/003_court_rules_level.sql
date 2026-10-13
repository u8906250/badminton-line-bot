-- 第幾場地、球團規則、臨打報名的程度（2026-10-11）。既有資料庫執行一次；全新安裝用 schema.sql，不需要執行。
--   npx wrangler d1 execute badminton --remote --file=migrations/003_court_rules_level.sql
ALTER TABLE clubs ADD COLUMN rules TEXT;
ALTER TABLE schedules ADD COLUMN court_no TEXT;
ALTER TABLE sessions ADD COLUMN court_no TEXT;
ALTER TABLE registrations ADD COLUMN level INTEGER CHECK (level BETWEEN 1 AND 18);
